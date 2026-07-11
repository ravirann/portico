/**
 * Engine runner.
 *
 * Default = **programmatic / in-process**: `launchBrowser` → a page → drive the
 * compiled plan step-by-step, with tracing, per-step screenshots, HITL, model-
 * gated recovery, and auth-profile load/refresh. This is the path the CLI + console
 * use; it needs no model and no network to Libretto Cloud, so the smoke flow stays
 * green keyless.
 *
 * Opt-in (`PORTICO_LIBRETTO_RUNNER=cli`) = **subprocess**: emit the generated
 * `workflow()` module and run it with `npx libretto run`, for when you want
 * Libretto's own auth-profile/pause/resume machinery end-to-end.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRecoveryPage, launchBrowser } from "libretto";
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";
import { redact } from "@portico/vault";
import { resolveSectorProfile } from "@portico/flow-spec";
import type { Flow, Target } from "@portico/flow-spec";
import type { EngineRunOptions, EngineRunResult, StepTrace } from "./types.js";
import { compileFlow, emitWorkflowModule, waitForDomQuiet, type StepRuntime } from "./compiler.js";
import { missingFlowInputs } from "./validate-flow.js";
import { resolveHealModel } from "./model.js";
import { resolveProfile } from "./auth-profile.js";
import { createRecorder } from "./recording.js";
import { classifyError, PorticoStepError } from "./errors.js";

const now = () => Date.now();

export function runnerMode(env: NodeJS.ProcessEnv = process.env): "programmatic" | "cli" {
  return env.PORTICO_LIBRETTO_RUNNER === "cli" ? "cli" : "programmatic";
}

export async function runFlow(opts: EngineRunOptions): Promise<EngineRunResult> {
  if (runnerMode() === "cli") return runViaCli(opts);
  return runProgrammatic(opts);
}

/**
 * Exact match or dot-suffix match: "sub.example.com" is allowed by
 * "example.com", but "evilexample.com" is not (no accidental prefix match).
 * Case-insensitive (hostnames are). Pure — exported for unit tests.
 */
export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((raw) => {
    const domain = raw.toLowerCase();
    return domain.length > 0 && (h === domain || h.endsWith(`.${domain}`));
  });
}

export interface EgressCheckInput {
  method: string;
  host: string;
  isMainFrameNavigation: boolean;
}

/**
 * Decide whether to block a request under the egress boundary:
 *   (a) a main-frame navigation to a non-allowed host, or
 *   (b) a non-GET/HEAD/OPTIONS (mutating) request to a non-allowed host.
 * GET subresources (CDNs, fonts, analytics beacons) always pass — the
 * boundary stops actions and navigations, not third-party rendering. Pure —
 * exported for unit tests (no Playwright Route/Request object needed).
 */
export function shouldBlockEgress(input: EgressCheckInput, allowedDomains: string[]): boolean {
  if (hostAllowed(input.host, allowedDomains)) return false;
  if (input.isMainFrameNavigation) return true;
  return !["GET", "HEAD", "OPTIONS"].includes(input.method.toUpperCase());
}

/**
 * Race `promise` against `signal` firing. On abort, rejects with
 * `PorticoStepError("aborted")` WITHOUT cancelling the underlying operation
 * (Playwright ops aren't cancellable mid-flight) — the step fails fast while
 * the page op finishes in the background; the run's `finally` teardown closes
 * the browser shortly after, cutting it off. Always removes its own abort
 * listener (on either branch), so one call per step never leaks listeners
 * onto a long-lived signal. Exported for unit tests.
 */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new PorticoStepError("aborted", "run was aborted"));
  return new Promise<T>((res, rej) => {
    const onAbort = () => rej(new PorticoStepError("aborted", "run was aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    promise.then(
      (v) => {
        cleanup();
        res(v);
      },
      (e) => {
        cleanup();
        rej(e);
      },
    );
  });
}

async function runProgrammatic(opts: EngineRunOptions): Promise<EngineRunResult> {
  const { flow, target } = opts;
  // Sector profile: caller-supplied override, else the flow's own stamped
  // sector, else `generic` (bit-identical to the engine's historical
  // hardcoded defaults) — see @portico/flow-spec sectors.ts.
  const sectorProfile = resolveSectorProfile(opts.sector ?? flow.sector);

  // Fail FAST on missing inputs — before any browser launches. A templated
  // locator name that renders to "" either throws a cryptic locator error
  // steps later or silently matches the wrong element; neither is acceptable.
  const missing = missingFlowInputs(flow, opts.inputs);
  if (missing.length > 0) {
    const reason =
      `run is missing required input(s): ${missing.join(", ")} — ` +
      `pass ${missing.map((m) => `--input ${m}=…`).join(" ")} (or fill them in the console's Run form)`;
    return {
      status: "failed",
      output: {},
      traces: [
        {
          index: 0,
          type: "inputs",
          label: "Validate run inputs",
          status: "failed",
          detail: reason,
          startedAt: now(),
          endedAt: now(),
          errorKind: "validation",
        },
      ],
      failure: { stepIndex: 0, reason, resumable: false, kind: "validation" },
    };
  }

  // A flow guarded dry_run_only refuses to run live at all — same "before any
  // browser launches" spirit as the missing-inputs gate above.
  if (flow.guard?.dry_run_only && opts.mode === "live") {
    const reason = "flow is guarded dry_run_only; refusing live mode";
    return {
      status: "failed",
      output: {},
      traces: [
        {
          index: 0,
          type: "guard",
          label: "Guard: dry_run_only",
          status: "failed",
          detail: reason,
          startedAt: now(),
          endedAt: now(),
          errorKind: "guard",
        },
      ],
      failure: { stepIndex: 0, reason, resumable: false, kind: "guard" },
    };
  }

  const secretValues = Object.values(opts.auth.secrets);
  const scrub = (s: string) => redact(s, secretValues);

  const heal = await resolveHealModel();
  const profile = opts.profileId ? resolveProfile(opts.profileId, { refresh: true }) : undefined;

  // Prefer a persisted auth profile; fall back to a string sessionState if given.
  const storageStatePath =
    profile?.loadPath ??
    (typeof opts.auth.sessionState === "string" ? opts.auth.sessionState : undefined);

  const runId = `${target.key}-${now()}`;
  const repoRoot = process.cwd();
  const artifactsDir = opts.artifactsDir ?? resolve(repoRoot, "data", "artifacts");

  // Auth persistence: a named --profile launches a PERSISTENT on-disk browser
  // profile (userDataDir) so login survives across runs — and is SHARED with the
  // record/inspect scripts, so one login serves them all. Storage-state snapshots
  // (cookies + localStorage only) can't restore portals like Epic/MyChart that
  // also keep sessionStorage / bind the session server-side. Profile-less runs
  // use an ephemeral Libretto session (storage-state path still honored).
  const cdpEndpoint = opts.cdpEndpoint ?? process.env.PORTICO_CDP_ENDPOINT;
  let context: BrowserContext;
  let rawPage: Page;
  let closeSession: () => Promise<void>;
  if (cdpEndpoint) {
    // Attach to an already-running, already-logged-in browser (scripts/serve-browser.mjs).
    // Open OUR OWN page in its context — which carries the auth cookies, so it's
    // authenticated — instead of hijacking the user's visible tab. Driving
    // pages()[0] fails with "Target page … has been closed" the moment the human
    // (or a prior run/author) navigates or closes that tab, and replaying a
    // multi-step SOP in the user's face is disruptive and race-prone. Close only
    // our page at the end; NEVER close the browser — it's the user's long-lived one.
    const browser = await chromium.connectOverCDP(cdpEndpoint);
    context = browser.contexts()[0] ?? (await browser.newContext());
    rawPage = await context.newPage();
    await rawPage.bringToFront().catch(() => {});
    closeSession = async () => {
      await rawPage.close().catch(() => {});
    };
  } else if (profile) {
    mkdirSync(profile.userDataDir, { recursive: true });
    context = await chromium.launchPersistentContext(profile.userDataDir, {
      headless: opts.headless ?? true,
      viewport: { width: 1440, height: 900 },
    });
    rawPage = context.pages()[0] ?? (await context.newPage());
    closeSession = () => context.close();
  } else {
    const session = await launchBrowser({
      sessionName: runId,
      headless: opts.headless ?? true,
      viewport: { width: 1440, height: 900 },
      storageStatePath,
    });
    context = session.context;
    rawPage = session.page;
    closeSession = () => session.close();
  }
  const page: Page = heal ? createRecoveryPage(rawPage, { recoveryAction: heal.recoveryAction }) : rawPage;

  const recorder = createRecorder(rawPage, {
    runId,
    artifactsDir,
    repoRoot,
    redactText: scrub,
    enabled: opts.record ?? true,
  });
  await recorder.start();

  const { plan, profileName } = compileFlow(flow, target, { heal, profileName: profile?.name }, sectorProfile);
  const traces: StepTrace[] = [];
  // Seed prior output (paired with resumeFrom) so a resumed run's templated
  // {{output.x}} references resolve to what an earlier attempt already
  // produced, instead of "".
  const output: Record<string, unknown> = seedOutput(opts.resumeOutput);
  const unvalidated = new Set<string>();

  const rt: StepRuntime = {
    page,
    rawPage,
    session: runId,
    input: opts.inputs,
    output,
    unvalidated,
    target,
    secrets: opts.auth.secrets,
    heal,
    profileLoaded: Boolean(profile?.loadPath),
    mode: opts.mode,
    skippedMutations: [],
    template: (s: string) => renderTemplate(s, opts, output),
  };

  // Egress boundary: abort any request outside opts.allowedDomains before it
  // leaves the browser — a main-frame navigation, or any mutating (non-GET)
  // request. GET subresources always pass (CDNs/fonts/analytics render
  // fine); the boundary stops ACTIONS and NAVIGATIONS, not rendering.
  // Opt-out via PORTICO_EGRESS_ENFORCE=0 for local/dev setups (e.g. a proxy).
  const allowedDomains = opts.allowedDomains ?? [];
  const egressEnabled = allowedDomains.length > 0 && process.env.PORTICO_EGRESS_ENFORCE !== "0";
  const blockedRequests: string[] = [];
  if (egressEnabled) {
    await context.route("**/*", async (route, request) => {
      let host = "";
      try {
        host = new URL(request.url()).hostname;
      } catch {
        /* malformed/opaque URL (e.g. data:) — empty host never matches an allow-list entry */
      }
      let isMainFrameNavigation = false;
      try {
        isMainFrameNavigation = request.isNavigationRequest() && request.frame().parentFrame() === null;
      } catch {
        /* service-worker requests have no frame() — never a main-frame navigation */
      }
      if (shouldBlockEgress({ method: request.method(), host, isMainFrameNavigation }, allowedDomains)) {
        blockedRequests.push(`${request.method()} ${host}`);
        await route.abort("blockedbyclient");
      } else {
        await route.continue();
      }
    });
  }

  /** Non-empty-only extras shared by every RunResult this function returns. */
  const resultExtras = (): Partial<Pick<EngineRunResult, "skippedMutations" | "blockedRequests">> => {
    const extra: Partial<Pick<EngineRunResult, "skippedMutations" | "blockedRequests">> = {};
    if (rt.skippedMutations.length > 0) extra.skippedMutations = [...rt.skippedMutations];
    if (blockedRequests.length > 0) extra.blockedRequests = [...blockedRequests];
    return extra;
  };

  try {
    const start = opts.resumeFrom ?? 0;

    // startUrl parity with the canonical workflow() path (which opens
    // target.base_url before the handler runs): a fresh page sits on
    // about:blank — an OPAQUE origin where storage reads and in-page fetch
    // throw SecurityError. If the (resumed) plan touches the page before its
    // first `navigate` — e.g. an authored write flow that opens with
    // localStorage auth reads — establish the app origin first.
    const NON_PAGE_STEPS = new Set(["intercept", "guard", "human", "resolve", "select", "wait"]);
    const firstPageStep = plan.slice(start).find((s) => !NON_PAGE_STEPS.has(s.type));
    // Prefer the target's base_url; when the run has none (e.g. a CLI run whose
    // connector row lacks one), fall back to the origin the flow's own step URLs
    // point at — localStorage and cookies are origin-scoped, so opening the
    // origin root is enough for the reads/api calls that follow.
    const startNavUrl = target.base_url || inferStartOrigin(flow.steps) || "";
    if (firstPageStep && firstPageStep.type !== "navigate" && startNavUrl) {
      try {
        await rawPage.goto(startNavUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await waitForDomQuiet(rawPage, { quietMs: 500, timeoutMs: 8000 });
      } catch (err) {
        const startedAt = now();
        const reason = scrub(
          `start navigation to ${startNavUrl} failed before step ${firstPageStep.index} could run: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        const trace: StepTrace = {
          index: firstPageStep.index,
          type: firstPageStep.type,
          label: firstPageStep.label,
          status: "failed",
          detail: reason,
          startedAt,
          endedAt: now(),
          errorKind: "navigation",
        };
        traces.push(trace);
        opts.onStep?.(trace);
        const rrwebRef = await recorder.finalize("failed");
        return {
          status: "failed",
          output,
          traces,
          rrwebRef,
          failure: { stepIndex: firstPageStep.index, reason, resumable: true, kind: "navigation" },
          unvalidatedOutputKeys: [...unvalidated],
          authProfile: profileName,
          ...resultExtras(),
        };
      }
    }

    for (let i = start; i < plan.length; i++) {
      const step = plan[i]!;
      // Traces/screenshots key on the step's ORIGINAL flow index — the compiler
      // may reorder the plan (intercepts are hoisted ahead of navigation), and
      // the console maps traces back to the authored YAML by index.
      const stepIndex = step.index;
      const startedAt = now();

      const emit = (status: StepTrace["status"], detail?: string, extra?: Partial<StepTrace>): StepTrace => {
        const trace: StepTrace = {
          index: stepIndex,
          type: step.type,
          label: step.label,
          status,
          detail: detail ? scrub(detail) : undefined,
          startedAt,
          endedAt: now(),
          ...extra,
        };
        traces.push(trace);
        opts.onStep?.(trace);
        return trace;
      };

      // Sector pacing: a deliberate pause between steps for bot-heuristic-
      // sensitive portals (finance/government). Never after the LAST step —
      // nothing follows it, so waiting only makes the run slower to no benefit.
      const pace = async () => {
        if (i < plan.length - 1 && sectorProfile.timing.actionDelayMs > 0) {
          await new Promise((r) => setTimeout(r, sectorProfile.timing.actionDelayMs));
        }
      };

      try {
        // Checked INSIDE the try (not before it) so an abort that lands
        // between steps is caught by the same handler below and returns a
        // clean `status: "failed"` result — not an unhandled rejection.
        if (opts.signal?.aborted) throw new PorticoStepError("aborted", "run was aborted");

        if (step.type === "human") {
          // Attached (CDP) browser is already logged in → the login gate is
          // moot; skip it so CDP runs are fully unattended.
          if (cdpEndpoint) {
            const shot = await recorder.screenshot(stepIndex);
            emit("ok", "skipped — attached browser already authenticated (CDP)", { screenshotRef: shot });
            await pace();
            continue;
          }
          // Interactive HITL: if the caller can service the step (headed
          // login/2FA), await it and continue instead of pausing the run.
          if (opts.onHuman) {
            await opts.onHuman({ index: stepIndex, label: step.label });
            const shot = await recorder.screenshot(stepIndex);
            emit("ok", "human step completed interactively", { screenshotRef: shot });
            await pace();
            continue;
          }
        }

        const outcome = await raceAbort(step.run(rt), opts.signal);
        const shot = await recorder.screenshot(stepIndex);

        if (outcome.status === "paused") {
          emit("paused", outcome.detail ?? `HITL required at step ${stepIndex} (${step.label ?? step.type})`, {
            screenshotRef: shot,
          });
          const rrwebRef = await recorder.finalize("paused");
          return {
            status: "paused",
            output,
            traces,
            rrwebRef,
            failure: { stepIndex: stepIndex, reason: `human step: ${step.label ?? step.type}`, resumable: true },
            sessionState: await context.storageState(),
            unvalidatedOutputKeys: [...unvalidated],
            authProfile: profileName,
            ...resultExtras(),
          };
        }

        emit(outcome.status === "healed" ? "healed" : "ok", outcome.detail, {
          screenshotRef: shot,
          healedFrom: outcome.healedFrom,
          healedTo: outcome.healedTo,
        });
        await pace();
      } catch (err) {
        const { kind, resumable } = classifyError(err);
        const reason = scrub(err instanceof Error ? err.message : String(err));
        const shot = await recorder.screenshot(stepIndex);
        emit("failed", reason, { screenshotRef: shot, errorKind: kind });
        const rrwebRef = await recorder.finalize("failed");
        return {
          status: "failed",
          output,
          traces,
          rrwebRef,
          failure: { stepIndex: stepIndex, reason, resumable, kind },
          unvalidatedOutputKeys: [...unvalidated],
          authProfile: profileName,
          ...resultExtras(),
        };
      }
    }

    // Persistent contexts flush the profile to disk on close — no manual refresh.
    const rrwebRef = await recorder.finalize("completed");
    return {
      status: "completed",
      output,
      traces,
      rrwebRef,
      sessionState: await context.storageState(),
      unvalidatedOutputKeys: [...unvalidated],
      authProfile: profileName,
      ...resultExtras(),
    };
  } finally {
    // CRITICAL: unroute before closing — contexts can be shared CDP
    // attachments that outlive this run, and a leaked route handler would
    // silently intercept (and mis-block) every other tab/run sharing it.
    if (egressEnabled) await context.unroute("**/*").catch(() => {});
    await closeSession();
  }
}

/**
 * Best-effort start origin for a flow that never navigates before touching the
 * page: the origin of the first absolute http(s) URL any of its steps declares
 * (an api block or a navigate/deep-link url). Origins carrying an unrendered
 * template ({{host}}) are skipped — they can't be opened literally. Exported
 * for unit tests.
 */
export function inferStartOrigin(steps: Flow["steps"]): string | undefined {
  for (const s of steps) {
    const api = (s as unknown as { api?: { url?: string } }).api;
    for (const raw of [api?.url, (s as { url?: string }).url]) {
      if (typeof raw !== "string" || !/^https?:\/\//i.test(raw)) continue;
      try {
        const origin = new URL(raw).origin;
        if (!origin.includes("{")) return origin;
      } catch {
        /* malformed — keep scanning */
      }
    }
  }
  return undefined;
}

/**
 * Seed a fresh output object from a prior (paused) run's output — the
 * `resumeFrom` + `resumeOutput` pairing: without this, a resumed run's
 * templated `{{output.x}}` references (see renderTemplate) resolve to "" for
 * everything an earlier attempt already produced, since `output` starts
 * empty. Always returns a NEW object (never the caller's own reference).
 * Exported for unit tests — the seam of runProgrammatic's output-init that
 * doesn't need a browser to exercise.
 */
export function seedOutput(resumeOutput?: Record<string, unknown>): Record<string, unknown> {
  return { ...(resumeOutput ?? {}) };
}

/**
 * Substitute {{input}}, {{secrets.x}}, {{base_url}}, and dotted paths into prior
 * step OUTPUT (e.g. {{customer.family.id}}) for the programmatic runner. Output
 * support is what lets a write step chain off a lookup — resolve inputs first,
 * then walk the dotted path through `output` (mirrors the compiler's resolver).
 * Exported for unit tests.
 */
export function renderTemplate(input: string, opts: EngineRunOptions, output: Record<string, unknown> = {}): string {
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    if (key === "base_url") return opts.target.base_url;
    if (key.startsWith("secrets.")) return opts.auth.secrets[key.slice(8)] ?? "";
    const [head, ...rest] = key.split(".");
    let base: unknown = head! in opts.inputs ? opts.inputs[head!] : output[head!];
    for (const seg of rest) {
      if (base == null || typeof base !== "object") return "";
      base = (base as Record<string, unknown>)[seg];
    }
    return base == null ? "" : String(base);
  });
}

// ---------------------------------------------------------------------------
// Subprocess runner (opt-in): emit a workflow module and `npx libretto run` it.
// ---------------------------------------------------------------------------

async function runViaCli(opts: EngineRunOptions): Promise<EngineRunResult> {
  const dir = mkdtempSync(join(tmpdir(), "portico-wf-"));
  const modulePath = join(dir, `${opts.flow.key}.workflow.ts`);
  writeFileSync(modulePath, emitWorkflowModule(opts.flow, opts.target, opts.profileId), "utf8");

  const args = ["libretto", "run", modulePath, opts.headless === false ? "--headed" : "--headless"];
  if (opts.profileId) args.push("--session", opts.profileId);

  const startedAt = now();
  const { code, stdout, stderr } = await spawnCollect("npx", args, opts.signal);
  const traces: StepTrace[] = [
    {
      index: 0,
      type: "subprocess",
      label: `npx ${args.join(" ")}`,
      status: code === 0 ? "ok" : "failed",
      detail: (code === 0 ? stdout : stderr).trim().slice(-2000) || undefined,
      startedAt,
      endedAt: now(),
    },
  ];
  if (code === 0) return { status: "completed", output: parseTailJson(stdout), traces };
  return {
    status: "failed",
    output: {},
    traces,
    failure: { stepIndex: 0, reason: stderr.trim().slice(-500) || `libretto run exited ${code}`, resumable: false },
  };
}

function parseTailJson(out: string): Record<string, unknown> {
  const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
  if (!line.startsWith("{")) return {};
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function spawnCollect(
  cmd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { env: process.env, signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", rej);
    child.on("close", (code) => res({ code, stdout, stderr }));
  });
}
