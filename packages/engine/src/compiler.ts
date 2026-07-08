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
import type { Locator, Page } from "playwright";
import { z } from "zod";
import type { Flow, Step, Target } from "@portico/flow-spec";
import { generateTotp } from "@portico/vault";
import { envelopeForExtraction, jsonSchemaToZod, validateAgainst } from "./json-schema.js";
import { resolveIntent } from "./resolve-intent.js";
import { pickByPolicy, type PickPolicy } from "./pick-slot.js";
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
      template: (s: string) => renderTemplate(s, { inputs, output, secrets: {}, target }),
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
    case "resolve":
      return { index, type: "resolve", label, run: (rt) => runResolve(rt, step) };
    case "read":
      return { index, type: "read", label, run: (rt) => runRead(rt, step) };
    case "select":
      return { index, type: "select", label, run: (rt) => runSelect(rt, step) };
    case "intercept":
      return { index, type: "intercept", label, run: (rt) => runIntercept(rt, step) };
    case "wait":
      return { index, type: "wait", label, run: (rt) => runWait(rt, step) };
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
  const { locator, desc, fallback } = resolveActLocator(rt, step);
  const value = step.value != null ? rt.template(step.value) : undefined;
  const timeout = step.timeoutMs ?? 15000;
  const attempt = (target: Locator, t: number) => async () => {
    if (value !== undefined) await target.fill(value, { timeout: t });
    else await target.click({ timeout: t });
  };
  // Cached-first, semantic self-heal: when the step carries BOTH a cached
  // selector and a semantic descriptor, try the cached one briefly, then
  // re-find the element by meaning. Deterministic — no model call — so it is
  // allowed on the promoted hot path.
  const doIt = fallback
    ? async () => {
        try {
          await attempt(locator, Math.min(timeout, 5000))();
        } catch {
          await attempt(fallback, timeout)();
        }
      }
    : attempt(locator, timeout);

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
    return { status: "healed", detail: "recovered via Libretto popup/overlay recovery", healedFrom: desc, healedTo: desc };
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

  // 2) Author/heal tier: no cached locator but a model is configured → AI extract.
  //    Structured-output providers (OpenAI response_format) reject scalar/array
  //    ROOT schemas, so a non-object schema is wrapped in a {value} envelope for
  //    the model call and unwrapped before the output assignment — the flow's
  //    output key always receives the declared shape (page_title stays a plain
  //    string, never {value: …}).
  if (rt.heal) {
    const envelope = envelopeForExtraction(schema);
    const zschema = jsonSchemaToZod(envelope.schema);
    const raw = await extractFromPage({
      page: rt.rawPage,
      instruction: step.locator?.semantic.intent ?? step.label ?? `extract ${key}`,
      schema: zschema as z.ZodType,
      model: rt.heal.languageModel,
    });
    // Validate the UNWRAPPED value against the ORIGINAL declared schema.
    const value = envelope.unwrap(raw);
    const check = validateAgainst(schema, value);
    rt.output[key] = check.ok ? check.value : value;
    if (!check.ok) rt.unvalidated.add(key);
    return {
      status: "ok",
      detail: check.ok ? "ai-extracted (extractFromPage, validated)" : `ai-extracted (unvalidated: ${check.error})`,
    };
  }

  // 3) Keyless fallback: raw DOM. Marked UNVALIDATED — no structured guarantee.
  const raw = await rt.page.title();
  rt.output[key] = raw;
  rt.unvalidated.add(key);
  return { status: "ok", detail: "raw-DOM fallback (unvalidated — no model)" };
}

/**
 * Canonicalize a fuzzy intent value against the portal's real options.
 * "Southview" → "Southview Internal Medicine". Fails LOUD when ambiguous —
 * refusing to guess is the whole point at scale (never book the wrong clinic).
 * Candidates come from a prior extract (DOM options or an API list); the
 * resolved canonical value is written to `output[as]` for downstream steps.
 */
async function runResolve(rt: StepRuntime, step: Step): Promise<StepOutcome> {
  const spec = step.resolve;
  if (!spec) throw new Error(`resolve step "${step.label ?? "?"}" is missing its resolve config`);

  const input = rt.template(spec.input);
  // Candidates key may be a dotted path into a prior response, e.g.
  // "specialty_data.ReasonsForVisit".
  const raw = lookupPath(spec.candidates, rt.input, rt.output);
  const items = Array.isArray(raw) ? raw : [];

  // The string each candidate is fuzzy-matched against: a plain string as-is,
  // or an object's `match_on` field (falling back to common name fields).
  const display = (c: unknown): string => {
    if (typeof c === "string") return c;
    const o = (c ?? {}) as Record<string, unknown>;
    const v = spec.match_on ? o[spec.match_on] : (o.name ?? o.label ?? o.title ?? o.Title ?? o.value);
    return v == null ? "" : String(v);
  };
  const candidates = items.map(display).filter((s) => s.length > 0);

  const result = resolveIntent(input, candidates);
  if (result.status === "resolved") {
    // Default: write the matched display value. With value_field, write that
    // field of the matched object instead (e.g. the encrypted id GetSlots needs).
    let out: unknown = result.value;
    if (spec.value_field) {
      const match = items.find((c) => typeof c !== "string" && display(c) === result.value) as
        | Record<string, unknown>
        | undefined;
      out = match ? match[spec.value_field] ?? "" : "";
    }
    rt.output[spec.as] = out;
    const shown = spec.value_field ? `${spec.value_field}=${String(out).slice(0, 16)}…` : `"${result.value}"`;
    return { status: "ok", detail: `resolved "${input}" → ${shown} (${result.matchedBy})` };
  }
  if (result.status === "ambiguous") {
    // Ambiguity is a human/decision signal, never a silent pick.
    if (spec.on_ambiguous === "human") {
      return { status: "paused", detail: `"${input}" is ambiguous: ${result.matches.join(" | ")}` };
    }
    throw new Error(
      `resolve: "${input}" is ambiguous — matched ${result.matches.length}: ${result.matches.join(", ")}. Refusing to guess.`,
    );
  }
  throw new Error(
    `resolve: "${input}" matched none of ${candidates.length} option(s)` +
      (candidates.length ? `: ${candidates.slice(0, 8).join(", ")}${candidates.length > 8 ? ", …" : ""}` : "."),
  );
}

/**
 * Read a value out of the live page (a session token, hidden anti-forgery field,
 * or an option list) so downstream API-tier steps can send it. The expression is
 * evaluated in page context — flows are trusted, authored artifacts.
 */
async function runRead(rt: StepRuntime, step: Step): Promise<StepOutcome> {
  const spec = step.read;
  if (!spec) throw new Error(`read step "${step.label ?? "?"}" is missing its read config`);
  const value = await rt.rawPage.evaluate(spec.expression);
  rt.output[spec.as] = value;
  const preview = Array.isArray(value) ? `${value.length} items` : String(value ?? "").slice(0, 24);
  return { status: "ok", detail: `read ${spec.as} (${preview})` };
}

/** Pick ONE item from a prior list by policy (e.g. the earliest available slot). */
async function runSelect(rt: StepRuntime, step: Step): Promise<StepOutcome> {
  const spec = step.select;
  if (!spec) throw new Error(`select step "${step.label ?? "?"}" is missing its select config`);
  const raw = lookupPath(spec.from, rt.input, rt.output); // dotted path allowed
  const items = (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>;
  // policy may be templated (e.g. "{{slot_preference}}"); empty ⇒ earliest.
  const policy = (rt.template(spec.policy).trim() || "earliest") as PickPolicy;
  const picked = pickByPolicy(items, policy, { by: spec.by, compare: spec.compare });
  if (!picked) {
    throw new Error(`select: no item in "${spec.from}" (${items.length}) matched policy "${policy}".`);
  }
  rt.output[spec.as] = picked.item;
  return { status: "ok", detail: `selected [${picked.index}] via ${policy}` };
}

/**
 * Passive interception: register a listener that captures the JSON body of a
 * response the PAGE itself makes (URL contains a marker), storing the latest
 * match in output. Harvests API-tier data (e.g. GetSlots) without replaying the
 * request — the robust path when the endpoint is anti-replay / anti-forgery
 * protected. Register before the action (human selection / clicks) that triggers it.
 */
async function runIntercept(rt: StepRuntime, step: Step): Promise<StepOutcome> {
  const spec = step.intercept;
  if (!spec) throw new Error(`intercept step "${step.label ?? "?"}" is missing its intercept config`);
  let captured = 0;
  rt.rawPage.on("response", async (resp) => {
    try {
      if (!resp.url().includes(spec.url_contains) || !resp.ok()) return;
      rt.output[spec.as] = await resp.json(); // latest matching response wins
      captured++;
      rt.output[`${spec.as}__count`] = captured;
    } catch {
      /* non-JSON body or a torn-down response — ignore, keep listening */
    }
  });
  return { status: "ok", detail: `intercepting responses matching "${spec.url_contains}" → ${spec.as}` };
}

/** Block until an output key is populated (e.g. by an interceptor) or time out. */
async function runWait(rt: StepRuntime, step: Step): Promise<StepOutcome> {
  const spec = step.wait;
  if (!spec) throw new Error(`wait step "${step.label ?? "?"}" is missing its wait config`);
  const timeout = spec.timeout_ms ?? 15000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (rt.output[spec.for] != null) return { status: "ok", detail: `${spec.for} ready in ${Date.now() - start}ms` };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`wait: "${spec.for}" was not populated within ${timeout}ms`);
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
      // Template {{...}} everywhere the caller can inject a resolved value:
      // the url, header values, and string values inside an object/form body
      // (so a form param like {{specialty_id}} resolves, not just a string body).
      const tmpl = (v: unknown): unknown =>
        typeof v === "string"
          ? rt.template(v)
          : Array.isArray(v)
            ? v.map(tmpl)
            : v && typeof v === "object"
              ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, tmpl(val)]))
              : v;
      const config: RequestConfig = {
        url: rt.template(api.url),
        method: api.method ?? "GET",
        headers: api.headers ? (tmpl(api.headers) as Record<string, string>) : undefined,
        body: tmpl(api.body) as RequestConfig["body"],
        bodyType: api.bodyType,
        responseType: api.responseType ?? "json",
      };
      const key = step.extract?.key ?? "api";
      const schema = step.extract?.schema;
      const zschema = schema ? (jsonSchemaToZod(schema) as z.ZodType) : undefined;
      const path = (() => {
        try {
          return new URL(config.url).pathname;
        } catch {
          return config.url;
        }
      })();
      let data: unknown;
      try {
        data = await pageRequest(rt.rawPage, config, zschema ? { schema: zschema } : {});
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // A JSON endpoint that returns HTML almost always means the request was
        // rejected as a non-AJAX / anti-forgery-missing call and redirected to a
        // page — surface that instead of a raw "Unexpected token '<'".
        const gotHtml = /Unexpected token '<'|<!DOCTYPE/i.test(msg);
        throw new Error(
          `api ${config.method} ${path} failed` +
            (gotHtml ? " — endpoint returned HTML, not JSON (auth / anti-forgery: verify the token header + x-requested-with)" : "") +
            `: ${msg.slice(0, 160)}`,
        );
      }
      rt.output[key] = data;
      if (!schema) rt.unvalidated.add(key);
      return { status: "ok", detail: `api ${config.method} ${path}` };
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

  const page = rt.rawPage;
  const onLoginPage = () => /log[\s-]?in|sign[\s-]?in|authenticate/i.test(page.url());

  const result = await librettoAuthenticate(
    { session: rt.session, page },
    {
      // Signed in if a trusted profile was loaded, or we're no longer on a login URL.
      isSignedIn: () => rt.profileLoaded || !onLoginPage(),
      // Best-effort scripted login from vaulted credentials. Resolves fields by
      // accessible label/role (works on standard forms without a capture). Fills
      // an authenticator-app OTP if a totp_seed is provided; SMS 2FA still needs
      // a manual tap (run headed) — after which the session persists to the profile.
      signIn: async (_ctx, creds) => {
        const username = String(creds.username ?? rt.secrets.username ?? "");
        const password = String(creds.password ?? rt.secrets.password ?? "");
        const totpSeed = String(creds.totp_seed ?? rt.secrets.totp_seed ?? "");
        if (!username || !password) {
          throw new Error("scripted login needs username + password — set PORTICO_SECRET_*_USERNAME/PASSWORD (.env)");
        }
        await page.getByLabel(/user|login|email/i).first().fill(username, { timeout: 15000 });
        await page.getByLabel(/password/i).first().fill(password, { timeout: 15000 });
        await page.getByRole("button", { name: /sign ?in|log ?in|continue/i }).first().click({ timeout: 15000 });
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        if (totpSeed) {
          const otp = page.getByLabel(/code|otp|verification|token|passcode/i).first();
          if (await otp.count().catch(() => 0)) {
            await otp.fill(generateTotp(totpSeed), { timeout: 15000 });
            await page.getByRole("button", { name: /verify|submit|continue|sign ?in/i }).first().click({ timeout: 15000 }).catch(() => {});
            await page.waitForLoadState("domcontentloaded").catch(() => {});
          }
        }
      },
      credentials: rt.secrets,
    },
  );
  return { status: "ok", detail: result.usedProfile ? "auth via saved profile" : "scripted login completed" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an `act` target to a Playwright Locator. Prefers a cached CSS/XPath
 * selector (deterministic replay); falls back to the semantic descriptor
 * (accessible role + name, then label, then placeholder/text) so authored flows
 * work on standard forms — e.g. login fields — without a record-by-demo pass.
 *
 * Ambiguity contract: a role+name lookup that resolves to more than one
 * element FAILS LOUD (Playwright strict mode) rather than silently clicking
 * the first — so a value like "Southview" that matches two clinics stops the
 * run instead of booking the wrong one. Canonicalize fuzzy intent with a
 * `resolve` step BEFORE the `act` so the name is unambiguous.
 *
 * The NAME-ONLY branch (no role — e.g. a recorded click on a plain div/td row
 * like a patient card) is deliberately `.first()`: text matching hits every
 * nested container of the text (the row AND its inner span), so strict mode
 * would reject virtually every real role-less target. Playwright returns
 * matches in DOM order, so `.first()` is the outermost matching element.
 * The unnamed role-only branch is also first-match, by definition.
 *
 * Cached + semantic on the same step is NOT either-or: the cached selector is
 * the fast deterministic primary, and the semantic descriptor comes back as
 * `fallback` — runAct retries with it when the cached selector has gone stale
 * (still deterministic; no model involved).
 *
 * Exported for unit tests (see compiler.test.ts); not part of the public API.
 */
export function resolveActLocator(
  rt: StepRuntime,
  step: Step,
): { locator: Locator; desc: string; fallback?: Locator } {
  const s = step.locator?.semantic;
  const desc = s?.intent ?? step.label ?? "element";
  const semantic = s ? buildSemanticLocator(rt, s) : undefined;

  const cached = step.locator?.cached;
  if (cached) {
    return { locator: rt.page.locator(rt.template(cached)), desc: cached, fallback: semantic };
  }
  if (semantic) return { locator: semantic, desc };

  throw new Error(
    `act step "${step.label ?? "?"}" has no cached selector and no usable semantic ` +
      `descriptor (need role and/or name). Intent: "${desc}".`,
  );
}

/** The semantic (heal-path) locator chain; undefined when neither role nor name exists. */
function buildSemanticLocator(rt: StepRuntime, s: NonNullable<Step["locator"]>["semantic"]): Locator | undefined {
  // The accessible name may be an input reference (e.g. "{{specialty}}") — render
  // it before matching, exactly like act values and api params.
  const name = s.name != null ? rt.template(s.name) : undefined;
  if (s.role && name) {
    // Named: strict (no .first()) — ambiguity is a bug, not a coin-flip.
    return rt.page.getByRole(s.role as Parameters<Page["getByRole"]>[0], { name, exact: false });
  }
  if (name) {
    // Named (no role): label first (form fields), else visible text — with
    // `.first()`, because a role-less text match nests (row + inner span) and
    // strict mode would fail loud on elements that are not actually ambiguous.
    const byLabel = rt.page.getByLabel(name, { exact: false });
    return byLabel.or(rt.page.getByText(name, { exact: false })).first();
  }
  if (s.role) return rt.page.getByRole(s.role as Parameters<Page["getByRole"]>[0]).first();
  return undefined;
}

function renderTemplate(
  input: string,
  ctx: {
    inputs: Record<string, unknown>;
    output?: Record<string, unknown>;
    secrets: Record<string, string>;
    target: Target;
  },
): string {
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    if (key === "base_url") return ctx.target.base_url;
    if (key.startsWith("secrets.")) return ctx.secrets[key.slice(8)] ?? "";
    // Resolve dotted paths against inputs first, then step output (so a `resolve`
    // step's `as` key and extracted objects are usable downstream, e.g.
    // "{{location_resolved}}" or "{{selected.time}}").
    const v = lookupPath(key, ctx.inputs, ctx.output ?? {});
    return v == null ? "" : String(v);
  });
}

/** Walk a dotted key ("selected.time") through inputs, falling back to output. */
function lookupPath(key: string, inputs?: Record<string, unknown>, output?: Record<string, unknown>): unknown {
  const inp = inputs ?? {};
  const out = output ?? {};
  const [head, ...rest] = key.split(".");
  let base: unknown = head! in inp ? inp[head!] : out[head!];
  for (const seg of rest) {
    if (base == null || typeof base !== "object") return undefined;
    base = (base as Record<string, unknown>)[seg];
  }
  return base;
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
