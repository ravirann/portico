/**
 * flow-spec → in-house compiler (ADR-0004).
 *
 * Compiles a Portico `Flow` into an instrumented step "plan" — an ordered list
 * of `CompiledStep` closures — that the programmatic runner (runner.ts) drives
 * directly. Through ADR-0001 this also emitted a second artifact, a
 * third-party `workflow()` object, for an alternate CLI/subprocess runner;
 * ADR-0004 retired that runner (see runner.ts's `runnerMode`/
 * `PORTICO_LIBRETTO_RUNNER`) and the artifact along with it, so the plan is
 * now the ONLY product of `compileFlow`.
 *
 * Step mapping:
 *   navigate → page.goto
 *   act      → page.fill/click/press/pressSequentially (recover.ts's
 *              attemptWithRecovery — deterministic overlay dismissal + one
 *              retry on failure, optionally model-assisted)
 *   extract  → cached-locator DOM read (deterministic) | model extraction |
 *              fail loud (no cached locator, no model)
 *   <step>.api → page-request.ts's pageRequest (API-tier / direct-HTTP)
 *   assert/guard → policy assertion (+ optional condition check)
 *   human    → runHuman's own "paused" status (+ lenient condition gate) —
 *              interactive HITL is the runner's `onHuman` callback
 *   subflow (auth) → scripted sign-in + authProfile (see runAuthSubflow)
 *
 * HARD INVARIANT (docs/ARCHITECTURE.md §4): a promoted deterministic replay makes
 * ZERO model calls. Recovery (attemptWithRecovery) only fires *after* a failure
 * (and even then defaults to fully deterministic — see recover.ts), and model
 * extraction only when a step has no cached locator — i.e. the model is the
 * author/heal tier, never the steady-state hot path.
 *
 * Reliability defaults (timeouts, retries, readiness gates, mutation guards,
 * locator trust) come from a `SectorProfile` (@portico/flow-spec) resolved by
 * the caller (see runner.ts) and threaded into `compileFlow`. Omitting a
 * profile uses `generic`, which reproduces the engine's historical hardcoded
 * defaults bit-for-bit — see sectors.ts's no-regression contract.
 */

import type { FrameLocator, Locator, Page } from "playwright";
import { z } from "zod";
import { resolveSectorProfile } from "@portico/flow-spec";
import type { Flow, SectorProfile, Step, Target } from "@portico/flow-spec";
import { generateTotp } from "@portico/vault";
import { envelopeForExtraction, jsonSchemaToZod, validateAgainst } from "./json-schema.js";
import { resolveIntent } from "./resolve-intent.js";
import { pickByPolicy, type PickPolicy } from "./pick-slot.js";
import type { HealModel } from "./model.js";
import { PorticoStepError } from "./errors.js";
import { attemptWithRecovery } from "./recover.js";
import type { HealedBy } from "./types.js";
import { pageRequest, type RequestConfig } from "./page-request.js";

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
  /** Run mode. In "dry_run", MUTATING api steps (PUT/PATCH/POST/DELETE) are
   *  skipped, never executed — a dry-run of a write flow is side-effect-free.
   *  Only "live" performs mutations. Defaults to "dry_run" where unset (safe). */
  mode?: "dry_run" | "live";
  /** Mutating `act` steps skipped outside live mode — see runAct's safety gate.
   *  Always initialized (empty) by the runner/workflow handler; surfaced as
   *  RunResult.skippedMutations when non-empty. */
  skippedMutations: string[];
  template: (s: string) => string;
}

export interface StepOutcome {
  status: "ok" | "healed" | "paused";
  detail?: string;
  healedFrom?: string;
  healedTo?: string;
  /** Set alongside a heal — what the recovery leaned on (StepTrace.healedBy). */
  healedBy?: HealedBy;
}

export interface CompiledStep {
  index: number;
  type: string;
  label?: string;
  run(rt: StepRuntime): Promise<StepOutcome>;
}

const BOOKING = /\b(book|schedule it|confirm appointment|submit appointment|place order|pay now)\b/i;

/**
 * True when `step` LOOKS like a mutating act — its label, locator semantic
 * name, or value contains one of `keywords` as a case-insensitive substring.
 * Same spirit as the `no_booking` structural scan (assertPolicyAtCompileTime)
 * but evaluated per-step at RUN time against a caller-supplied keyword set
 * (sector mutationKeywords ∪ forbiddenInValidation ∪ flow.guard.
 * forbidden_actions — see compileFlow). Deliberately checks the STATIC,
 * authored fields rather than the runtime-templated value: a flow author
 * writing "Submit login" or "Delete the record" is the signal, and a dynamic
 * {{value}} rarely carries a mutation keyword on its own. Pure — exported for
 * unit tests.
 */
export function isMutatingAct(step: Step, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const text = `${step.label ?? ""} ${step.locator?.semantic?.name ?? ""} ${step.value ?? ""}`.toLowerCase();
  return keywords.some((k) => k.length > 0 && text.includes(k.toLowerCase()));
}

export interface CompileResult {
  plan: CompiledStep[];
  profileName?: string;
  credentialNames: string[];
}

/** Compile-time context threaded into every step compiler: the target site,
 *  the resolved sector profile (reliability defaults), the intercept steps
 *  marked `required` (keyed by their output name, for runWait's fail-loud
 *  timeout), and the full mutation-keyword set (sector ∪ flow guard) for the
 *  dry-run act gate. Built once per `compileFlow` call. */
interface CompileContext {
  target: Target;
  profile: SectorProfile;
  requiredIntercepts: Map<string, { url_contains: string }>;
  mutationKeywords: string[];
}

/**
 * Compile a flow to its instrumented step plan — the ONLY product since
 * ADR-0004 retired the third-party `workflow()` artifact this used to also emit.
 *
 * `profile` supplies the sector's reliability defaults (timeouts, retries,
 * readiness gates, locator trust, mutation-keyword guards) — omitting it
 * resolves to the `generic` profile, which reproduces the engine's
 * historical hardcoded defaults bit-for-bit, so existing callers that don't
 * pass one (tests) are unaffected. `opts.heal` is threaded into every
 * compiled step's runtime (see runner.ts's `runProgrammatic`) but never
 * consulted here at compile time — it only matters once a step actually runs.
 */
export function compileFlow(
  flow: Flow,
  target: Target,
  opts: { heal?: HealModel | null; profileName?: string } = {},
  profile: SectorProfile = resolveSectorProfile(undefined),
): CompileResult {
  assertPolicyAtCompileTime(flow);

  const requiredIntercepts = new Map<string, { url_contains: string }>();
  for (const step of flow.steps) {
    if (step.type === "intercept" && step.intercept?.required && step.intercept.as) {
      requiredIntercepts.set(step.intercept.as, { url_contains: step.intercept.url_contains });
    }
  }
  // Mutation keywords a dry-run must refuse to touch: the sector's own
  // guard vocabulary (mutationKeywords ∪ forbiddenInValidation) PLUS
  // whatever this specific flow additionally forbids.
  const mutationKeywords = [
    ...profile.guards.mutationKeywords,
    ...profile.guards.forbiddenInValidation,
    ...(flow.guard?.forbidden_actions ?? []),
  ];
  const ctx: CompileContext = { target, profile, requiredIntercepts, mutationKeywords };

  const compiled = flow.steps.map((step, index) => compileStep(step, index, ctx));
  // Intercept steps are passive listener registrations — hoist them ahead of
  // everything else so a response fired DURING the initial page load (SPAs
  // fetch their data on mount) is never missed because the listener was
  // registered after `navigate` returned. Earlier registration is strictly
  // safer; "latest match wins" semantics are unchanged. Steps keep their
  // original `index` for tracing.
  const plan = [...compiled.filter((s) => s.type === "intercept"), ...compiled.filter((s) => s.type !== "intercept")];
  const credentialNames = deriveCredentialNames(flow);
  return { plan, profileName: opts.profileName, credentialNames };
}

// ---------------------------------------------------------------------------
// Per-step compilation
// ---------------------------------------------------------------------------

function compileStep(step: Step, index: number, ctx: CompileContext): CompiledStep {
  const label = step.label;
  const api = (step as unknown as { api?: ApiStepSpec }).api;

  // API-tier: any step the flow marks with an `api` block runs via pageRequest,
  // regardless of its declared type. Direct-HTTP inside the browser context.
  if (api) return apiStep(step, api, index, ctx.profile);

  switch (step.type) {
    case "navigate":
      return { index, type: "navigate", label, run: (rt) => runNavigate(rt, step, ctx.target, ctx.profile) };
    case "act":
      return { index, type: "act", label, run: (rt) => runAct(rt, step, ctx.profile, ctx.mutationKeywords) };
    case "extract":
      return { index, type: "extract", label, run: (rt) => runExtract(rt, step, ctx.profile) };
    case "assert":
      return { index, type: "assert", label, run: (rt) => runAssert(rt, step) };
    case "guard":
      return { index, type: "guard", label, run: (rt) => runGuard(rt, step) };
    case "human":
      return { index, type: "human", label, run: (rt) => runHuman(rt, step) };
    case "resolve":
      return { index, type: "resolve", label, run: (rt) => runResolve(rt, step) };
    case "read":
      return { index, type: "read", label, run: (rt) => runRead(rt, step, ctx.profile) };
    case "select":
      return { index, type: "select", label, run: (rt) => runSelect(rt, step) };
    case "intercept":
      return { index, type: "intercept", label, run: (rt) => runIntercept(rt, step) };
    case "wait":
      return { index, type: "wait", label, run: (rt) => runWait(rt, step, ctx.requiredIntercepts) };
    case "subflow":
      return { index, type: "subflow", label, run: (rt) => runAuthSubflow(rt, step, ctx.target) };
    case "download":
    case "upload":
      return {
        index,
        type: step.type,
        label,
        run: async () => {
          throw new Error(`step type '${step.type}' not wired yet in the compiler`);
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

/**
 * Wait until the DOM stops mutating for `quietMs` (or `timeout` elapses).
 * This is the SPA readiness gate: `domcontentloaded` fires before client-side
 * data fetching/hydration, and `networkidle` is an anti-pattern (analytics
 * beacons/polling keep the network busy forever). "The DOM went quiet" is a
 * framework-agnostic proxy for "the app finished rendering". Best-effort:
 * a navigation racing the evaluate resolves rather than failing the step.
 */
export async function waitForDomQuiet(
  page: Page,
  opts: { quietMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const quietMs = Math.max(0, opts.quietMs ?? 400);
  const timeoutMs = Math.max(quietMs, opts.timeoutMs ?? 8000);
  // A string expression, not a typed closure: this runs in the BROWSER, and the
  // engine package deliberately compiles without the DOM lib (it's Node code).
  const src = `new Promise((resolve) => {
    const quietMs = ${quietMs};
    const timeoutMs = ${timeoutMs};
    let quietTimer;
    let hardStop;
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(done, quietMs);
    });
    function done() {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(hardStop);
      resolve(undefined);
    }
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    quietTimer = setTimeout(done, quietMs);
    hardStop = setTimeout(done, timeoutMs);
  })`;
  try {
    await page.evaluate(src);
  } catch {
    /* page navigated mid-evaluate — it's changing, the next step's own wait gates it */
  }
}

/**
 * Run `fn` honoring the step's `retry` policy ({max, backoffMs}). `max` is the
 * number of RETRIES after the first attempt (flow-spec semantics); each retry
 * backs off linearly. Retries are deterministic re-executions — no model.
 */
async function withStepRetry<T>(
  step: Step,
  defaults: { max: number; backoffMs: number },
  fn: (attempt: number) => Promise<T>,
): Promise<T> {
  const max = step.retry?.max ?? defaults.max;
  const backoffMs = step.retry?.backoffMs ?? defaults.backoffMs;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt < max) await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

export interface EffectiveStepPolicy {
  timeoutMs: number;
  retryMax: number;
  backoffMs: number;
}

/**
 * Resolve the timeout + retry policy that actually applies to `step` for one
 * phase of its lifecycle: the step's own `timeoutMs`/`retry.max`/
 * `retry.backoffMs` ALWAYS win when set; otherwise the sector profile's
 * default for that phase applies. Centralizes the "step override, else
 * profile default" rule in ONE place so it's independently testable — pure
 * numbers in, pure numbers out, no page/locator needed — instead of
 * re-deriving it inline at every call site. Covers navigate/act/extract; read
 * has no retry concept and api's retry additionally depends on HTTP-method
 * idempotency, so those two resolve their timeout/retry inline instead.
 */
export function effectiveTimeouts(
  profile: SectorProfile,
  step: Step,
  phase: "navigate" | "act" | "extract",
): EffectiveStepPolicy {
  const base: Record<"navigate" | "act" | "extract", EffectiveStepPolicy> = {
    navigate: { timeoutMs: profile.timing.navTimeoutMs, retryMax: profile.retry.navigateMax, backoffMs: profile.retry.backoffMs },
    act: { timeoutMs: profile.timing.stepTimeoutMs, retryMax: profile.retry.actMax, backoffMs: profile.retry.backoffMs },
    extract: { timeoutMs: profile.timing.extractTimeoutMs, retryMax: profile.retry.extractMax, backoffMs: profile.retry.backoffMs },
  };
  const b = base[phase];
  return {
    timeoutMs: step.timeoutMs ?? b.timeoutMs,
    retryMax: step.retry?.max ?? b.retryMax,
    backoffMs: step.retry?.backoffMs ?? b.backoffMs,
  };
}

async function runNavigate(rt: StepRuntime, step: Step, target: Target, profile: SectorProfile): Promise<StepOutcome> {
  const url = rt.template(step.url ?? target.base_url);
  const policy = effectiveTimeouts(profile, step, "navigate");
  await withStepRetry(step, { max: policy.retryMax, backoffMs: policy.backoffMs }, async () => {
    await rt.page.goto(url, { waitUntil: "domcontentloaded", timeout: policy.timeoutMs });
  });
  // SPA readiness: don't hand the next step a half-hydrated page.
  await waitForDomQuiet(rt.rawPage, {
    quietMs: profile.readiness.navigateQuietMs,
    timeoutMs: profile.readiness.navigateTimeoutMs,
  });
  return { status: "ok" };
}

/**
 * Race a promise against a hard deadline. The self-heal recovery path can make
 * unbounded LLM calls (or loop) when an element genuinely can't be found, which
 * turns a step FAILURE into an indefinite HANG — the run never completes and the
 * validation gate never returns a verdict. A hard ceiling converts that into a
 * fast, legible failure ("couldn't act on X in N ms") the caller can surface.
 * Also the shared mechanism behind the api/read step ceilings (see apiStep,
 * runRead) — throws a classified PorticoStepError("timeout", …) so any caller
 * (ours or a hard deadline elsewhere) reports the SAME error kind.
 */
export async function withHardTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new PorticoStepError("timeout", `${what} exceeded ${ms}ms — failing fast instead of hanging`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runAct(
  rt: StepRuntime,
  step: Step,
  profile: SectorProfile,
  mutationKeywords: string[],
): Promise<StepOutcome> {
  // SAFETY GATE: outside live mode, a mutating act — one whose label/locator
  // name/value hits a sector or flow-declared mutation keyword — is never
  // touched (same spirit as the api-tier dry-run skip, for the DOM path).
  // Recorded on the runtime so the caller can see exactly what was skipped.
  if ((rt.mode ?? "dry_run") !== "live" && isMutatingAct(step, mutationKeywords)) {
    const detail = `skipped mutating act in dry_run: ${step.label ?? step.locator?.semantic?.intent ?? step.type}`;
    rt.skippedMutations.push(detail);
    return { status: "ok", detail };
  }

  const templatedValue = step.value != null ? rt.template(step.value) : undefined;
  // Explicit method wins outright; with none, infer from value presence
  // (unchanged default behavior: a value fills, no value clicks).
  const method = step.method ?? (templatedValue !== undefined ? "fill" : "click");
  // click/press can trigger an SPA transition (navigation, tab switch, a
  // Gmail-style send-on-Ctrl+Enter); fill/type are text entry, no transition
  // expected — matches the original "wait for quiet only on click" rule.
  const expectsTransition = method === "click" || method === "press";
  const policy = effectiveTimeouts(profile, step, "act");
  const timeout = policy.timeoutMs;
  const probe = Math.min(timeout, 5000);

  // Try the ordered resilient candidates in turn: the first that becomes visible
  // is acted on. Most-specific first (cached / strict role+name), loosening to a
  // role-agnostic name match and finally text — so a link captured as a button
  // (or a drifted role) still resolves, WITHOUT changing which element an
  // already-working flow picks (its precise candidate matches first). Candidates
  // are re-resolved per retry so a re-render between attempts is picked up fresh.
  const doIt = async () => {
    // A keyboard chord with no target element (e.g. a global "Escape" or a
    // compose-window "Control+Enter" send) goes straight to the keyboard —
    // there is no locator ladder to resolve.
    if (method === "press" && !step.locator) {
      await rt.page.keyboard.press(templatedValue ?? "");
      return;
    }
    const { candidates, desc } = resolveActLocator(rt, step, { cssCacheTrusted: profile.locator.cssCacheTrusted });
    let lastErr: unknown;
    for (let i = 0; i < candidates.length; i++) {
      const loc = candidates[i]!;
      // Earlier (more specific) candidates get a short probe; the last gets the
      // full timeout so a slow-hydrating correct element isn't skipped.
      const t = i === candidates.length - 1 ? timeout : probe;
      // Virtualized lists (Gmail-class) detach/re-render rows outside the
      // viewport — nudge the candidate into view before waiting on it so the
      // visibility gate isn't racing a layout that hasn't happened yet.
      // Best-effort: an element that can't be scrolled just falls through to
      // the (likely failing) visibility wait below, same as before this existed.
      await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      try {
        await loc.waitFor({ state: "visible", timeout: t });
        if (method === "fill") {
          await loc.fill(templatedValue ?? "", { timeout });
        } else if (method === "press") {
          await loc.press(templatedValue ?? "", { timeout });
        } else if (method === "type") {
          // Real key events for contenteditable/rich-text editors, where
          // fill() doesn't fire the input handlers the app listens for.
          await loc.click({ timeout });
          await loc.pressSequentially(templatedValue ?? "", { delay: 20, timeout });
        } else {
          await loc.click({ timeout });
        }
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error(`no locator candidate matched for "${desc}"`);
  };
  const settled = async () => {
    // One retry (not two): the candidate cascade already IS the fallback layer,
    // so a second full sweep mostly just doubles a genuine failure's wall-clock.
    await withStepRetry(step, { max: policy.retryMax, backoffMs: policy.backoffMs }, doIt);
    // Clicks/presses can trigger SPA transitions — give the render a short
    // quiet window so the next step doesn't race it.
    if (expectsTransition) {
      await waitForDomQuiet(rt.rawPage, { quietMs: profile.readiness.actQuietMs, timeoutMs: profile.readiness.actTimeoutMs });
    }
  };

  const desc = step.locator?.semantic?.intent ?? step.label ?? "element";
  // Deterministic hot path: bounded deterministic retries, no model. On
  // failure, recover.ts's attemptWithRecovery runs BY DEFAULT (ADR-0004) —
  // deterministic overlay/popup dismissal + one retry, no model required —
  // and additionally consults the heal model (if configured) for a broader
  // dismissal target when the deterministic step finds nothing. Hard-bounded:
  // without a ceiling an unfindable element makes recovery hang and the
  // whole run never completes.
  try {
    await settled();
    return { status: "ok" };
  } catch (originalErr) {
    const recovered = await withHardTimeout(
      attemptWithRecovery(rt.rawPage, doIt, { languageModel: rt.heal?.languageModel, cause: originalErr }),
      timeout + 15000,
      `self-heal for "${desc}"`,
    );
    const detail = recovered.dismissed
      ? `recovered — ${recovered.dismissed}`
      : "recovered — transient failure cleared on retry";
    return { status: "healed", detail, healedFrom: recovered.dismissed ?? desc, healedTo: desc, healedBy: recovered.healedBy };
  }
}

/**
 * In-house AI extraction (ADR-0004 — replaces the removed dependency's `extractFromPage`).
 * Author/heal tier only (see runExtract branch 2 below) — screenshots the
 * current viewport, captures a length-capped HTML snapshot for context, and
 * asks the configured model to extract structured data matching `schema`.
 * Reproduces only the whole-page path of the original: `runExtract` never
 * passed a CSS-selector-scoped extraction target.
 */
async function extractViaModel<T extends z.ZodType>(opts: {
  page: Page;
  instruction: string;
  schema: T;
  model: HealModel["languageModel"];
}): Promise<z.infer<T>> {
  const screenshot = (await opts.page.screenshot({ type: "png" })).toString("base64");
  let domContent: string | undefined;
  try {
    const html = await opts.page.content();
    domContent = html.length > 50000 ? `${html.slice(0, 50000)}\n... [truncated]` : html;
  } catch {
    domContent = undefined; // best-effort context only — extraction still proceeds off the screenshot
  }
  const prompt =
    `You are analyzing a screenshot from a web page to extract structured data.\n\n` +
    `Instruction: ${opts.instruction}\n\n` +
    (domContent ? `Here is the HTML content for additional context:\n<html>\n${domContent}\n</html>\n\n` : "") +
    `Extract the requested information from the screenshot and return it in the specified format. Be precise and only extract what is visible.`;

  // Dynamic import: the deterministic hot path never loads the AI SDK (same
  // convention as model.ts) — this function only runs when a heal model is
  // already configured and a step has no cached locator.
  const { generateObject } = await import("ai");
  const { object } = await generateObject({
    model: opts.model,
    schema: opts.schema,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image", image: `data:image/png;base64,${screenshot}` },
        ],
      },
    ],
    temperature: 0,
  });
  return object as z.infer<T>;
}

async function runExtract(rt: StepRuntime, step: Step, profile: SectorProfile): Promise<StepOutcome> {
  const key = step.extract?.key ?? "result";
  const schema = step.extract?.schema;
  const cached = step.locator?.cached;

  // 1) Deterministic hot path: a cached locator → plain DOM read, validate, no model.
  if (cached) {
    const policy = effectiveTimeouts(profile, step, "extract");
    const timeout = policy.timeoutMs;
    const value = await withStepRetry(step, { max: policy.retryMax, backoffMs: policy.backoffMs }, async () => {
      // Frame-scoped locators (locator.frame) resolve through the same
      // outermost→innermost FrameLocator chain the act path uses (see
      // locatorRoot). Note: unlike resolveActLocator, this cached path has no
      // semantic ladder to fall back on yet (no buildSemanticCandidates
      // equivalent for reads) — so cssCacheTrusted does NOT gate it; an
      // untrusted-CSS sector still uses the cached selector for extraction
      // because there is no deterministic alternative today.
      const root = locatorRoot(rt.page, step.locator);
      const loc = root.locator(rt.template(cached));
      // Extraction MUST wait for the element: SPAs render data async, and a
      // waitless read returns "" — which then flows downstream as a silently
      // wrong value. Empty results are a hard failure, never an "ok".
      await loc.first().waitFor({ state: "visible", timeout });
      const texts = await loc.allInnerTexts();
      const v: unknown = texts.length <= 1 ? texts[0] ?? "" : texts;
      const empty =
        texts.length === 0 || (typeof v === "string" && v.trim() === "") ||
        (Array.isArray(v) && v.every((t) => String(t).trim() === ""));
      if (empty) {
        throw new Error(
          `extract "${key}": locator ${JSON.stringify(cached)} matched ${texts.length} element(s) but yielded no text — ` +
            "refusing to store an empty extraction",
        );
      }
      return v;
    });
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
    const raw = await extractViaModel({
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
      detail: check.ok ? "ai-extracted (validated)" : `ai-extracted (unvalidated: ${check.error})`,
    };
  }

  // 3) No cached locator and no heal model: refuse to guess. A silent
  //    page.title() fallback used to stand in here — a WRONG value
  //    masquerading as a successful extraction (nothing downstream could tell
  //    "no data" from "the page title, coincidentally"). Fail loud instead,
  //    naming the output key and why.
  throw new PorticoStepError(
    "not_found",
    `extract "${key}" has no cached locator and no heal model is configured — nothing to extract from. ` +
      "Add a locator.cached selector, configure PORTICO_HEAL_* for AI extraction, or remove this step.",
  );
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
async function runRead(rt: StepRuntime, step: Step, profile: SectorProfile): Promise<StepOutcome> {
  const spec = step.read;
  if (!spec) throw new Error(`read step "${step.label ?? "?"}" is missing its read config`);
  // Reads evaluate in page context. On about:blank — nothing has navigated yet —
  // the origin is opaque and storage access throws a cryptic SecurityError
  // ("Access is denied for this document"); name the real problem instead.
  if (rt.rawPage.url() === "about:blank") {
    throw new Error(
      `read "${spec.as}" ran before any navigation — the page is still on about:blank, ` +
        `where storage/DOM access is denied. Add a navigate step before it, or set the ` +
        `target's base_url so the runner opens the app first.`,
    );
  }
  // Universal ceiling: page.evaluate() has no built-in timeout, so a hung
  // expression (or a page that never settles) would otherwise hang the run.
  const timeoutMs = step.timeoutMs ?? profile.timing.readTimeoutMs;
  const value = await withHardTimeout(rt.rawPage.evaluate(spec.expression), timeoutMs, `read "${spec.as}"`);
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
 *
 * `intercept.schema`, when present, validates the captured JSON the same way
 * extract's cached path does: on failure the RAW value is still stored (never
 * dropped) and the key is marked `unvalidated` for the caller to see.
 */
async function runIntercept(rt: StepRuntime, step: Step): Promise<StepOutcome> {
  const spec = step.intercept;
  if (!spec) throw new Error(`intercept step "${step.label ?? "?"}" is missing its intercept config`);
  let captured = 0;
  rt.rawPage.on("response", async (resp) => {
    try {
      if (!resp.url().includes(spec.url_contains) || !resp.ok()) return;
      const body: unknown = await resp.json(); // latest matching response wins
      if (spec.schema) {
        const check = validateAgainst(spec.schema, body);
        rt.output[spec.as] = check.ok ? check.value : body;
        if (!check.ok) rt.unvalidated.add(spec.as);
      } else {
        rt.output[spec.as] = body;
      }
      captured++;
      rt.output[`${spec.as}__count`] = captured;
    } catch {
      /* non-JSON body or a torn-down response — ignore, keep listening */
    }
  });
  return {
    status: "ok",
    detail: `intercepting responses matching "${spec.url_contains}"${spec.schema ? " (schema-validated)" : ""} → ${spec.as}`,
  };
}

/** Block until an output key is populated (e.g. by an interceptor) or time out.
 *  When the awaited key traces back to an `intercept` step marked `required`,
 *  a timeout is a hard, classified failure — the flow's committed product
 *  never showed up, which is never a recoverable-by-retrying-blindly state
 *  without knowing why (see PorticoStepError kind "timeout"). */
async function runWait(
  rt: StepRuntime,
  step: Step,
  requiredIntercepts: Map<string, { url_contains: string }>,
): Promise<StepOutcome> {
  const spec = step.wait;
  if (!spec) throw new Error(`wait step "${step.label ?? "?"}" is missing its wait config`);
  const timeout = spec.timeout_ms ?? 15000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (rt.output[spec.for] != null) return { status: "ok", detail: `${spec.for} ready in ${Date.now() - start}ms` };
    await new Promise((r) => setTimeout(r, 200));
  }
  const required = requiredIntercepts.get(spec.for);
  if (required) {
    throw new PorticoStepError(
      "timeout",
      `required intercept "${spec.for}" (url_contains "${required.url_contains}") never fired within ${timeout}ms`,
    );
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

/** A structural `guard` step: today's ONLY enforcement is compile-time
 *  (assertPolicyAtCompileTime — no_booking/forbidden_actions). An optional
 *  `condition` layers a run-time check on top, using the same registry as
 *  assert; a guard step with no condition keeps the original unconditional
 *  "ok" behavior. */
async function runGuard(rt: StepRuntime, step: Step): Promise<StepOutcome> {
  if (!step.condition) return { status: "ok", detail: "policy asserted at compile time" };
  const ok = await evaluateCondition(rt, step.condition);
  if (!ok) throw new Error(`guard failed: condition '${step.condition}' is false`);
  return { status: "ok", detail: `guard ${step.condition} (policy asserted at compile time)` };
}

/**
 * Human (HITL) gate. With no `condition`, always pauses — the original,
 * unconditional behavior (login/2FA/CAPTCHA steps rarely declare one). With a
 * condition, it's evaluated through the shared registry — but LENIENTLY: an
 * unknown condition (e.g. `two_factor_challenge_present`, which no
 * deterministic check in this registry can answer) is treated as true so the
 * pause still fires — conservative, so an unrecognized 2FA-style gate never
 * silently skips human review. A RECOGNIZED condition that evaluates false
 * skips the pause (nothing to review).
 */
async function runHuman(rt: StepRuntime, step: Step): Promise<StepOutcome> {
  if (!step.condition) return { status: "paused" };
  const parsed = parseCondition(step.condition);
  if (parsed.kind === "unknown") {
    return {
      status: "paused",
      detail: `condition "${parsed.raw}" is not a recognized form — pausing conservatively (lenient)`,
    };
  }
  const ok = await evaluateCondition(rt, step.condition);
  return ok
    ? { status: "paused" }
    : { status: "ok", detail: `condition "${step.condition}" is false — no human input needed` };
}

export type ParsedCondition =
  | { kind: "page_loaded" }
  | { kind: "url_contains" | "text_visible" | "selector_visible" | "output_present"; arg: string }
  | { kind: "unknown"; raw: string };

/**
 * Parse an assert/guard/human `condition` string into a structured form.
 * Grammar: "page_loaded" (no arg) | "<kind>:<arg>" — split on the FIRST colon
 * so an arg that itself contains ":" (a URL fragment, say) survives intact —
 * | anything else → { kind: "unknown", raw }. Pure; exported for unit tests.
 */
export function parseCondition(spec: string): ParsedCondition {
  if (spec === "page_loaded") return { kind: "page_loaded" };
  const i = spec.indexOf(":");
  if (i === -1) return { kind: "unknown", raw: spec };
  const kind = spec.slice(0, i);
  const arg = spec.slice(i + 1);
  if (kind === "url_contains" || kind === "text_visible" || kind === "selector_visible" || kind === "output_present") {
    return { kind, arg };
  }
  return { kind: "unknown", raw: spec };
}

/** True if `loc` becomes visible within `timeoutMs`; false on timeout —
 *  NEVER throws (a condition check is a yes/no question, not a step failure). */
async function visibleWithin(loc: Locator, timeoutMs: number): Promise<boolean> {
  try {
    await loc.waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * Condition registry for assert/guard/human steps. Recognized forms:
 *   page_loaded             — the page has a title (original behavior)
 *   url_contains:<text>     — page.url() includes <text>
 *   text_visible:<text>     — that text is visible within 3s
 *   selector_visible:<css>  — that CSS selector is visible within 3s
 *   output_present:<key>    — rt.output[<key>] is set and a non-empty string
 * Anything else is "unknown" — throws PorticoStepError("unsupported", …)
 * naming the supported forms. It is up to the CALLER whether "unknown" is
 * fatal: assert/guard propagate this throw (fail loud); human steps check
 * `parseCondition` themselves first and never reach this branch for an
 * unknown condition (see runHuman's lenient pause-anyway).
 */
async function evaluateCondition(rt: StepRuntime, condition: string): Promise<boolean> {
  const parsed = parseCondition(condition);
  switch (parsed.kind) {
    case "page_loaded":
      return Boolean(await rt.page.title().catch(() => ""));
    case "url_contains":
      return rt.rawPage.url().includes(parsed.arg);
    case "text_visible":
      return visibleWithin(rt.page.getByText(parsed.arg, { exact: false }).first(), 3000);
    case "selector_visible":
      return visibleWithin(rt.page.locator(parsed.arg).first(), 3000);
    case "output_present":
      return rt.output[parsed.arg] != null && rt.output[parsed.arg] !== "";
    case "unknown":
      throw new PorticoStepError(
        "unsupported",
        `condition "${parsed.raw}" is not a supported form — use "page_loaded", "url_contains:<text>", ` +
          `"text_visible:<text>", "selector_visible:<css>", or "output_present:<output_key>"`,
      );
  }
}

function apiStep(step: Step, api: ApiStepSpec, index: number, profile: SectorProfile): CompiledStep {
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
      const method = (api.method ?? "GET").toUpperCase();
      const path0 = (() => {
        try {
          return new URL(rt.template(api.url)).pathname;
        } catch {
          return api.url;
        }
      })();
      // SAFETY GATE: a mutating request is a real side effect. In dry-run it is
      // SKIPPED entirely (never sent), so validating/rehearsing a write flow
      // changes nothing. Only an explicit live run performs the mutation.
      const isMutation = !["GET", "HEAD", "OPTIONS"].includes(method);
      if (isMutation && (rt.mode ?? "dry_run") !== "live") {
        return { status: "ok", detail: `skipped mutating ${method} ${path0} (dry-run — not sent)` };
      }
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
      const timeoutMs = step.timeoutMs ?? profile.timing.apiTimeoutMs;
      // Idempotent (GET/HEAD/OPTIONS) reads get bounded auto-retry from the
      // sector profile. A NON-idempotent (mutating) call is NEVER
      // auto-retried by default — a silently-retried POST/PUT/PATCH/DELETE
      // risks a double-write the caller never asked for. `step.retry.max` is
      // still honored when the flow author explicitly opts a specific
      // mutating step into retries (an informed, per-step choice).
      const retryDefaults = { max: isMutation ? 0 : profile.retry.apiIdempotentMax, backoffMs: profile.retry.backoffMs };
      let data: unknown;
      try {
        data = await withStepRetry(step, retryDefaults, () =>
          withHardTimeout(
            pageRequest(rt.rawPage, config, zschema ? { schema: zschema } : {}),
            timeoutMs,
            `api ${config.method} ${path}`,
          ),
        );
      } catch (e) {
        // Preserve a classified error (e.g. our own hard-timeout) as-is;
        // only wrap genuine pageRequest failures with the enriched message.
        if (e instanceof PorticoStepError) throw e;
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
 * Auth subflow — bound to the loaded auth profile (ADR-0004: in-house,
 * replaces the removed dependency's scripted-authenticate helper).
 * `isSignedIn` short-circuits when a profile was loaded; the scripted sign-in below only runs when
 * credentials are vaulted, otherwise it throws so the runner falls back to
 * interactive/paused HITL (the "first login manual" rule).
 */
async function runAuthSubflow(rt: StepRuntime, step: Step, target: Target): Promise<StepOutcome> {
  const isLogin = (step.use ?? "").includes("login") || (target.auth ?? "").includes("login");
  if (!isLogin) throw new Error(`subflow '${step.use ?? "?"}' is not an auth subflow and is not wired`);

  const page = rt.rawPage;
  const onLoginPage = () => /log[\s-]?in|sign[\s-]?in|authenticate/i.test(page.url());
  // Signed in if a trusted profile was loaded, or we're no longer on a login URL.
  const isSignedIn = () => rt.profileLoaded || !onLoginPage();

  if (isSignedIn()) return { status: "ok", detail: "auth via saved profile" };

  // Best-effort scripted login from vaulted credentials. Resolves fields by
  // accessible label/role (works on standard forms without a capture). Fills
  // an authenticator-app OTP if a totp_seed is provided; SMS 2FA still needs
  // a manual tap (run headed) — after which the session persists to the profile.
  const username = rt.secrets.username ?? "";
  const password = rt.secrets.password ?? "";
  const totpSeed = rt.secrets.totp_seed ?? "";
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

  if (!isSignedIn()) {
    throw new Error("Sign-in completed, but the session is still not signed in.");
  }
  return { status: "ok", detail: "scripted login completed" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the frame root a locator's candidates should be built against.
 * `locator.frame` is a chain of iframe CSS selectors resolved
 * outermost→innermost via `frameLocator()`; absent (or empty) means the main
 * frame — `page` itself. Both `Page` and `FrameLocator` implement
 * locator()/getByRole()/getByLabel()/getByText(), so callers (resolveActLocator,
 * buildSemanticCandidates, extract's cached path) can treat the result
 * uniformly. Exported for unit tests.
 */
export function locatorRoot(page: Page, locator?: Step["locator"]): Page | FrameLocator {
  let root: Page | FrameLocator = page;
  for (const sel of locator?.frame ?? []) root = root.frameLocator(sel);
  return root;
}

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
 * (still deterministic; no model involved). `opts.cssCacheTrusted` (default
 * true) — false for sectors with obfuscated/rotating build-artifact class
 * names — skips the cached candidate entirely rather than trying-then-
 * falling-back: a stale-but-still-MATCHING selector there is more likely to
 * hit the WRONG recycled element than to simply fail visibly.
 *
 * Exported for unit tests (see compiler.test.ts); not part of the public API.
 */
export function resolveActLocator(
  rt: StepRuntime,
  step: Step,
  opts: { cssCacheTrusted?: boolean } = {},
): { candidates: Locator[]; desc: string } {
  const s = step.locator?.semantic;
  const desc = s?.intent ?? step.label ?? "element";
  const cssCacheTrusted = opts.cssCacheTrusted ?? true;
  const root = locatorRoot(rt.page, step.locator);

  // Ordered, most-specific-first candidate list (a layered fallback — the
  // community-standard cure for brittle single locators). A cached selector is
  // the first candidate; the semantic descriptor contributes the rest.
  const candidates: Locator[] = [];
  const cached = step.locator?.cached;
  if (cached && cssCacheTrusted) candidates.push(root.locator(rt.template(cached)));
  if (s) candidates.push(...buildSemanticCandidates(root, rt, s));

  if (candidates.length === 0) {
    throw new Error(
      `act step "${step.label ?? "?"}" has no cached selector and no usable semantic ` +
        `descriptor (need role and/or name). Intent: "${desc}".`,
    );
  }
  return { candidates, desc };
}

/** Interactive ARIA roles a labelled control might carry. The cascade tries the
 *  captured role first, then these, so a control captured with the WRONG role —
 *  most commonly a link (`<a>`, implicit role "link") recorded as a button —
 *  still resolves instead of matching nothing. */
const INTERACTIVE_ROLES = [
  "button", "link", "menuitem", "menuitemradio", "menuitemcheckbox",
  "tab", "option", "radio", "checkbox", "switch", "treeitem",
] as const;

/** A short, stable leading fragment of a (possibly long) accessible name.
 *  Accessible-name matching is substring-based (the query must be contained in
 *  the element's name), so a long captured label matches more reliably as a
 *  short fragment than verbatim. Trims to ≤30 chars at a word boundary. */
function shortLabel(name: string): string {
  const words = name.trim().split(/\s+/);
  let out = "";
  for (const w of words) {
    if (out && out.length + 1 + w.length > 30) break;
    out = out ? `${out} ${w}` : w;
  }
  return out.replace(/[,;:.–—-]+$/, "").trim() || name;
}

/**
 * Ordered resilient locator candidates for a semantic descriptor. Tried
 * most-specific first, so flows that already work are unaffected (their precise
 * candidate matches first) while a drifted/wrong role or an over-long captured
 * label still resolves via a looser candidate:
 *   1. strict role+name (exact captured role) — the current behavior, unchanged
 *   2. role-AGNOSTIC name match (button|link|menuitem|…) — fixes a link captured
 *      as a button (the real "can't click the tile" cause)
 *   3. role-agnostic on a SHORT name fragment — survives a captured label longer
 *      than the element's actual accessible name
 *   4. label/text fallback — role-blind last resort (and the PRIMARY match for a
 *      role-less name, e.g. a person's row)
 *
 * `root` is the Page or FrameLocator candidates are built against — see
 * locatorRoot (frame-scoped locators resolve inside their iframe chain).
 */
function buildSemanticCandidates(
  root: Page | FrameLocator,
  rt: StepRuntime,
  s: NonNullable<Step["locator"]>["semantic"],
): Locator[] {
  // The accessible name may be an input reference (e.g. "{{specialty}}") — render
  // it before matching, exactly like act values and api params.
  const name = s.name != null ? rt.template(s.name) : undefined;
  // A templated name that rendered EMPTY means the run is missing an input.
  // Fail loud with the input's name — falling through would degrade the locator
  // to "click the first thing on the page": a silent wrong-click.
  if (s.name && /\{\{/.test(s.name) && name !== undefined && name.trim() === "") {
    const refs = [...s.name.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).join(", ");
    throw new Error(
      `locator name "${s.name}" rendered empty — the run did not provide input "${refs}". ` +
        `Pass --input ${refs}=… (or fill it in the console's Run form).`,
    );
  }

  const byRole = (role: string, nm: string) =>
    root.getByRole(role as Parameters<Page["getByRole"]>[0], { name: nm, exact: false });
  const roleAgnostic = (nm: string): Locator => {
    let loc = byRole(INTERACTIVE_ROLES[0], nm);
    for (let i = 1; i < INTERACTIVE_ROLES.length; i++) loc = loc.or(byRole(INTERACTIVE_ROLES[i]!, nm));
    return loc.first();
  };
  const byText = (nm: string): Locator =>
    root.getByLabel(nm, { exact: false }).or(root.getByText(nm, { exact: false })).first();

  const out: Locator[] = [];
  if (name && name.trim()) {
    const short = shortLabel(name);
    if (s.role) {
      out.push(byRole(s.role, name)); // 1. strict role+name (unchanged)
      out.push(roleAgnostic(name)); // 2. role-agnostic, full name
      if (short !== name) out.push(roleAgnostic(short)); // 3. role-agnostic, short fragment
    }
    out.push(byText(name)); // 4. text (primary for a role-less name)
    if (short !== name) out.push(byText(short));
  } else if (s.role) {
    out.push(root.getByRole(s.role as Parameters<Page["getByRole"]>[0]).first());
  }
  return out;
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

