/**
 * flow-spec → Libretto compiler.
 *
 * Compiles a Portico `Flow` into Libretto's **canonical `workflow()` artifact**
 * (ADR-0001) *and* an instrumented step "plan" the in-process runner drives.
 * Both share one interpreter, so the deterministic behaviour is identical whether
 * a run goes through `LibrettoWorkflow.run` (subprocess / `npx libretto run`) or
 * the programmatic runner.
 *
 * Step mapping:
 *   navigate → page.goto            (wrapped by recoveryAction)
 *   act      → page.fill/click      (attemptWithRecovery — model retry on failure)
 *   extract  → cached-locator DOM read (deterministic) | extractFromPage (model) |
 *              raw-DOM fallback (unvalidated)
 *   <step>.api → pageRequest        (API-tier / direct-HTTP)
 *   assert/guard → policy assertion
 *   human    → pause(session) / interactive HITL
 *   subflow (auth) → librettoAuthenticate + authProfile
 *
 * HARD INVARIANT (docs/ARCHITECTURE.md §4): a promoted deterministic replay makes
 * ZERO model calls. Recovery (attemptWithRecovery) only fires *after* a failure,
 * and extractFromPage only when a step has no cached locator — i.e. the model is
 * the author/heal tier, never the steady-state hot path.
 */

import {
  attemptWithRecovery,
  extractFromPage,
  librettoAuthenticate,
  pageRequest,
  pause,
  workflow,
  type LibrettoWorkflow,
  type LibrettoWorkflowContext,
  type RecoveryAction,
  type RequestConfig,
} from "libretto";
import type { Page } from "playwright";
import { z } from "zod";
import type { Flow, Step, Target } from "@portico/flow-spec";
import { jsonSchemaToZod, validateAgainst } from "./json-schema.js";
import type { HealModel } from "./model.js";

/** An API-tier marker a flow can attach to a step (extra flow-spec field). */
interface ApiStepSpec {
  url: string;
  method?: RequestConfig["method"];
  headers?: Record<string, string>;
  body?: Record<string, unknown> | string;
  bodyType?: RequestConfig["bodyType"];
  responseType?: RequestConfig["responseType"];
}

/** Runtime handed to each compiled step. `page` is recovery-wrapped when healing. */
export interface StepRuntime {
  page: Page;
  /** The raw (un-wrapped) page — used for the explicit `attemptWithRecovery` retry. */
  rawPage: Page;
  session: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  unvalidated: Set<string>;
  target: Target;
  secrets: Record<string, string>;
  heal: HealModel | null;
  /** True when an auth profile was loaded (login likely already valid). */
  profileLoaded: boolean;
  template: (s: string) => string;
}

export interface StepOutcome {
  status: "ok" | "healed" | "paused";
  detail?: string;
  healedFrom?: string;
  healedTo?: string;
}

export interface CompiledStep {
  index: number;
  type: string;
  label?: string;
  run(rt: StepRuntime): Promise<StepOutcome>;
}

const BOOKING = /\b(book|schedule it|confirm appointment|submit appointment|place order|pay now)\b/i;

export interface CompileResult {
  workflow: LibrettoWorkflow;
  plan: CompiledStep[];
  profileName?: string;
  credentialNames: string[];
}

/** Compile a flow to the canonical workflow + instrumented plan. */
export function compileFlow(
  flow: Flow,
  target: Target,
  opts: { heal?: HealModel | null; profileName?: string } = {},
): CompileResult {
  assertPolicyAtCompileTime(flow);
  const plan = flow.steps.map((step, index) => compileStep(step, index, target));
  const credentialNames = deriveCredentialNames(flow);
  const wf = buildWorkflow(flow, target, plan, {
    heal: opts.heal ?? null,
    profileName: opts.profileName,
    credentialNames,
  });
  return { workflow: wf, plan, profileName: opts.profileName, credentialNames };
}

/**
 * Build ONLY the canonical Libretto workflow (used by the emitted module / the
 * `npx libretto run` subprocess). Heal model + auth profile come from env.
 */
export function compileToWorkflow(
  flow: Flow,
  target: Target,
  opts: { heal?: HealModel | null; profileName?: string } = {},
): LibrettoWorkflow {
  return compileFlow(flow, target, opts).workflow;
}

function buildWorkflow(
  flow: Flow,
  target: Target,
  plan: CompiledStep[],
  ctx: { heal: HealModel | null; profileName?: string; credentialNames: string[] },
): LibrettoWorkflow {
  const inputShape: Record<string, z.ZodTypeAny> = {};
  for (const name of Object.keys(flow.inputs ?? {})) inputShape[name] = z.unknown().optional();
  const outputShape: Record<string, z.ZodTypeAny> = {};
  for (const s of flow.steps) {
    const key = (s as Step).extract?.key;
    if (key) outputShape[key] = z.unknown().optional();
  }

  const recoveryAction: RecoveryAction | undefined = ctx.heal?.recoveryAction;

  const handler = async (wfCtx: LibrettoWorkflowContext, input: unknown) => {
    const inputs = (input ?? {}) as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    const rt: StepRuntime = {
      page: wfCtx.page,
      rawPage: wfCtx.page,
      session: wfCtx.session,
      input: inputs,
      output,
      unvalidated: new Set(),
      target,
      secrets: {},
      heal: ctx.heal,
      profileLoaded: Boolean(ctx.profileName),
      template: (s: string) => renderTemplate(s, { inputs, secrets: {}, target }),
    };
    for (const step of plan) await step.run(rt);
    return output;
  };

  return workflow(
    flow.key,
    {
      input: z.object(inputShape).passthrough(),
      output: z.object(outputShape).passthrough(),
      credentials: ctx.credentialNames,
      authProfile: ctx.profileName ? { name: ctx.profileName, refresh: true } : undefined,
      startUrl: target.base_url || undefined,
      viewport: { width: 1440, height: 900 },
      recoveryAction,
    },
    handler,
  );
}

// ---------------------------------------------------------------------------
// Per-step compilation
// ---------------------------------------------------------------------------

function compileStep(step: Step, index: number, target: Target): CompiledStep {
  const label = step.label;
  const api = (step as unknown as { api?: ApiStepSpec }).api;

  // API-tier: any step the flow marks with an `api` block runs via pageRequest,
  // regardless of its declared type. Direct-HTTP inside the browser context.
  if (api) return apiStep(step, api, index);

  switch (step.type) {
    case "navigate":
      return { index, type: "navigate", label, run: (rt) => runNavigate(rt, step, target) };
    case "act":
      return { index, type: "act", label, run: (rt) => runAct(rt, step) };
    case "extract":
      return { index, type: "extract", label, run: (rt) => runExtract(rt, step) };
    case "assert":
      return { index, type: "assert", label, run: (rt) => runAssert(rt, step) };
    case "guard":
      return { index, type: "guard", label, run: async () => ({ status: "ok", detail: "policy asserted at compile time" }) };
    case "human":
      return { index, type: "human", label, run: async () => ({ status: "paused" }) };
    case "subflow":
      return { index, type: "subflow", label, run: (rt) => runAuthSubflow(rt, step, target) };
    case "download":
    case "upload":
      return {
        index,
        type: step.type,
        label,
        run: async () => {
          throw new Error(`step type '${step.type}' not wired yet in the Libretto compiler`);
        },
      };
    default:
      return {
        index,
        type: (step as { type: string }).type,
        label,
        run: async () => {
          throw new Error(`unknown step type '${(step as { type: string }).type}'`);
        },
      };
  }
}

async function runNavigate(rt: StepRuntime, step: Step, target: Target): Promise<StepOutcome> {
  const url = rt.template(step.url ?? target.base_url);
  await rt.page.goto(url, { waitUntil: "domcontentloaded", timeout: step.timeoutMs ?? 60000 });
  return { status: "ok" };
}

async function runAct(rt: StepRuntime, step: Step): Promise<StepOutcome> {
  const sel = requireSelector(step);
  const value = step.value != null ? rt.template(step.value) : undefined;
  const timeout = step.timeoutMs ?? 15000;
  const doIt = async () => {
    if (value !== undefined) await rt.page.fill(sel, value, { timeout });
    else await rt.page.click(sel, { timeout });
  };

  // Deterministic hot path: single attempt, no model. If it fails AND a heal
  // model is configured, run `attemptWithRecovery` (popup/overlay recovery +
  // one retry). No model ⇒ the failure propagates (deterministic).
  if (!rt.heal) {
    await doIt();
    return { status: "ok" };
  }
  try {
    await doIt();
    return { status: "ok" };
  } catch {
    await attemptWithRecovery(rt.rawPage, doIt, undefined, rt.heal.languageModel);
    return { status: "healed", detail: "recovered via Libretto popup/overlay recovery", healedFrom: sel, healedTo: sel };
  }
}

async function runExtract(rt: StepRuntime, step: Step): Promise<StepOutcome> {
  const key = step.extract?.key ?? "result";
  const schema = step.extract?.schema;
  const cached = step.locator?.cached;

  // 1) Deterministic hot path: a cached locator → plain DOM read, validate, no model.
  if (cached) {
    const texts = await rt.page.locator(cached).allInnerTexts();
    const value: unknown = texts.length <= 1 ? texts[0] ?? "" : texts;
    const check = validateAgainst(schema, value);
    rt.output[key] = check.ok ? check.value : value;
    if (!check.ok) rt.unvalidated.add(key);
    return { status: "ok", detail: check.ok ? "dom-extracted (validated)" : `dom-extracted (unvalidated: ${check.error})` };
  }

  // 2) Author/heal tier: no cached locator but a model is configured → AI extract,
  //    schema-validated by construction.
  if (rt.heal) {
    const zschema = jsonSchemaToZod(schema);
    const value = await extractFromPage({
      page: rt.rawPage,
      instruction: step.locator?.semantic.intent ?? step.label ?? `extract ${key}`,
      schema: zschema as z.ZodType,
      model: rt.heal.languageModel,
    });
    rt.output[key] = value;
    return { status: "ok", detail: "ai-extracted (extractFromPage, validated)" };
  }

  // 3) Keyless fallback: raw DOM. Marked UNVALIDATED — no structured guarantee.
  const raw = await rt.page.title();
  rt.output[key] = raw;
  rt.unvalidated.add(key);
  return { status: "ok", detail: "raw-DOM fallback (unvalidated — no model)" };
}

async function runAssert(rt: StepRuntime, step: Step): Promise<StepOutcome> {
  const condition = step.condition;
  if (!condition) return { status: "ok" };
  const ok = await evaluateCondition(rt, condition);
  if (!ok) throw new Error(`assertion failed: condition '${condition}' is false`);
  return { status: "ok", detail: `assert ${condition}` };
}

/** Condition registry. Unknown conditions pass (wired per-connector later). */
async function evaluateCondition(rt: StepRuntime, condition: string): Promise<boolean> {
  switch (condition) {
    case "page_loaded":
      return Boolean(await rt.page.title().catch(() => ""));
    default:
      return true;
  }
}

function apiStep(step: Step, api: ApiStepSpec, index: number): CompiledStep {
  return {
    index,
    type: "api",
    label: step.label,
    async run(rt) {
      const config: RequestConfig = {
        url: rt.template(api.url),
        method: api.method ?? "GET",
        headers: api.headers,
        body: typeof api.body === "string" ? rt.template(api.body) : api.body,
        bodyType: api.bodyType,
        responseType: api.responseType ?? "json",
      };
      const key = step.extract?.key ?? "api";
      const schema = step.extract?.schema;
      const zschema = schema ? (jsonSchemaToZod(schema) as z.ZodType) : undefined;
      const data = await pageRequest(rt.rawPage, config, zschema ? { schema: zschema } : {});
      rt.output[key] = data;
      if (!schema) rt.unvalidated.add(key);
      return { status: "ok", detail: `api ${config.method} ${new URL(config.url).pathname}` };
    },
  };
}

/**
 * Auth subflow → Libretto `librettoAuthenticate` bound to the loaded auth profile.
 * `isSignedIn` short-circuits when a profile was loaded; `signIn` drives a scripted
 * login only when credentials + login locators are authored, otherwise it throws so
 * the runner falls back to interactive/paused HITL (the "first login manual" rule).
 */
async function runAuthSubflow(rt: StepRuntime, step: Step, target: Target): Promise<StepOutcome> {
  const isLogin = (step.use ?? "").includes("login") || (target.auth ?? "").includes("login");
  if (!isLogin) throw new Error(`subflow '${step.use ?? "?"}' is not an auth subflow and is not wired`);

  const result = await librettoAuthenticate(
    { session: rt.session, page: rt.rawPage },
    {
      isSignedIn: () => rt.profileLoaded,
      signIn: async () => {
        throw new Error(
          `scripted login for '${step.use ?? target.auth}' is not authored — complete the ` +
            `first login manually (headed) to seed the auth profile`,
        );
      },
      credentials: rt.secrets,
    },
  );
  return { status: "ok", detail: result.usedProfile ? "auth via saved profile" : "auth completed" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireSelector(step: Step): string {
  const sel = step.locator?.cached;
  if (!sel) {
    throw new Error(
      `act step "${step.label ?? "?"}" has no cached locator — record it first ` +
        `(record-by-demo). Semantic intent: "${step.locator?.semantic.intent ?? "?"}".`,
    );
  }
  return sel;
}

function renderTemplate(
  input: string,
  ctx: { inputs: Record<string, unknown>; secrets: Record<string, string>; target: Target },
): string {
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    if (key === "base_url") return ctx.target.base_url;
    if (key.startsWith("secrets.")) return ctx.secrets[key.slice(8)] ?? "";
    const v = ctx.inputs[key];
    return v == null ? "" : String(v);
  });
}

/** Credential names a flow needs — derived from its `{{secrets.x}}` references. */
function deriveCredentialNames(flow: Flow): string[] {
  const names = new Set<string>();
  const scan = (s?: string) => {
    if (!s) return;
    for (const m of s.matchAll(/\{\{\s*secrets\.([\w.]+)\s*\}\}/g)) names.add(m[1]!);
  };
  for (const step of flow.steps) {
    scan(step.value);
    scan(step.url);
  }
  return [...names];
}

/** Structural policy: a `no_booking` flow must not contain a booking action. */
function assertPolicyAtCompileTime(flow: Flow): void {
  const offenders = flow.steps.filter((s) => (s.type as string) === "agent");
  if (offenders.length > 0) {
    throw new Error(
      `Flow '${flow.key}' has ${offenders.length} agent step(s) on the hot path — ` +
        "forbidden for a promoted flow (docs/ARCHITECTURE.md §4).",
    );
  }
  if (flow.guard?.no_booking || flow.guard?.dry_run_only) {
    for (const step of flow.steps) {
      const text = `${step.label ?? ""} ${step.value ?? ""}`;
      if (BOOKING.test(text)) {
        throw new Error(
          `Flow '${flow.key}' is guarded no_booking but step "${step.label ?? step.type}" ` +
            `performs a booking action — refused at compile time.`,
        );
      }
    }
  }
  const forbidden = flow.guard?.forbidden_actions ?? [];
  if (forbidden.length) {
    for (const step of flow.steps) {
      const text = `${step.label ?? ""} ${step.value ?? ""}`.toLowerCase();
      const hit = forbidden.find((f) => text.includes(f.toLowerCase()));
      if (hit) {
        throw new Error(`Flow '${flow.key}' step "${step.label ?? step.type}" hits forbidden action '${hit}'.`);
      }
    }
  }
}

/**
 * Emit a standalone Libretto workflow **module** (the generated `workflow()` file)
 * for the `npx libretto run ./file.ts` subprocess path. It embeds the flow + target
 * and rebuilds the canonical workflow via `compileToWorkflow` (heal model + profile
 * resolved from env inside), so there is a single interpreter.
 */
export function emitWorkflowModule(flow: Flow, target: Target, profileId?: string): string {
  const flowJson = JSON.stringify(flow, null, 2);
  const targetJson = JSON.stringify(target, null, 2);
  const profileArg = profileId ? `, profileName: ${JSON.stringify(profileId)}` : "";
  return `// AUTO-GENERATED by @portico/engine compiler — do not edit by hand.
// Canonical Libretto workflow module: run with \`npx libretto run ./this-file.ts\`.
import { resolveHealModel, compileToWorkflow } from "@portico/engine";

const flow = ${flowJson} as const;
const target = ${targetJson} as const;

const heal = await resolveHealModel();
export default compileToWorkflow(flow as any, target as any, { heal${profileArg} });
`;
}
