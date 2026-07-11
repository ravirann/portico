/**
 * The engine boundary. Everything Portico's platform layer needs from an
 * execution engine is expressed here; the concrete engine (Portico's own,
 * on Playwright — see adapters/portico.ts — plus a fallback) lives behind
 * `EngineAdapter`. See ADR-0001 and ADR-0004.
 */

import type { Flow, Target } from "@portico/flow-spec";

export type RunMode = "dry_run" | "live";

/** Secrets are resolved at run time and injected here — never persisted. */
export interface AuthContext {
  /** Resolved secret values keyed by reference (password, apiKey, totpSeed, …). */
  secrets: Record<string, string>;
  /** A persisted trusted-device session (cookies + storage) to skip login/2FA. */
  sessionState?: unknown;
}

export type StepStatus = "ok" | "healed" | "failed" | "skipped" | "paused";

export interface StepTrace {
  index: number;
  type: string;
  label?: string;
  status: StepStatus;
  detail?: string;
  /** Set when a locator was self-healed, for the audit/suggestion pipeline. */
  healedFrom?: string;
  healedTo?: string;
  screenshotRef?: string;
  startedAt: number;
  endedAt: number;
  /** Classified failure kind (see errors.ts StepErrorKind) — set on "failed" traces. */
  errorKind?: string;
}

export type RunStatus = "completed" | "failed" | "paused";

export interface EngineRunResult {
  status: RunStatus;
  /** Schema-validated outputs from `extract` steps. */
  output: Record<string, unknown>;
  traces: StepTrace[];
  /** Reference to the captured session recording (rrweb events file or video). */
  rrwebRef?: string;
  /** Present when status = failed | paused. `paused` ⇒ HITL/resume needed. */
  failure?: { stepIndex: number; reason: string; resumable: boolean; kind?: string };
  /** Updated trusted session to persist back to the vault, if it changed. */
  sessionState?: unknown;
  /** Output keys whose extracted/intercepted value did NOT pass its declared
   *  schema — the raw value is still stored (never dropped), just flagged. */
  unvalidatedOutputKeys?: string[];
  /** The auth profile (auth-profile.ts) this run loaded/refreshed, if any. */
  authProfile?: string;
  /** Mutating `act` steps skipped outside live mode (dry-run safety gate). Only set when non-empty. */
  skippedMutations?: string[];
  /** Requests blocked by the egress boundary, as "METHOD host" strings. Only set when non-empty. */
  blockedRequests?: string[];
}

export interface EngineRunOptions {
  target: Target;
  flow: Flow;
  inputs: Record<string, unknown>;
  auth: AuthContext;
  mode: RunMode;
  /** Live step tracing for the console. */
  onStep?: (trace: StepTrace) => void;
  /** Interactive HITL handler (e.g. wait for the human to log in + 2FA). If
   *  provided, a `human` step awaits it and continues; otherwise it pauses. */
  onHuman?: (step: { index: number; label?: string }) => Promise<void>;
  /** Resume a previously paused run from this step index (durable resume). */
  resumeFrom?: number;
  signal?: AbortSignal;
  /** Run the browser headless (true) or headed (false). Defaults to headless. */
  headless?: boolean;
  /**
   * Stable id used to derive the **auth profile** name (auth-profile.ts) so
   * that a one-time login persists to `.portico/profiles/<name>.json` and
   * later runs skip auth. Typically a target/credential id. When absent, no
   * profile is loaded or written (fresh browser every run).
   */
  profileId?: string;
  /**
   * Attach to an ALREADY-RUNNING browser over CDP (e.g. `http://localhost:9222`)
   * instead of launching one. The browser keeps its logged-in session between
   * runs, so you log in ONCE (in that browser) and every run reuses it — no
   * re-login. Started via `scripts/serve-browser.mjs`. Takes precedence over
   * profileId; the attached browser is never closed by the run.
   */
  cdpEndpoint?: string;
  /** Where to write session recordings + per-step screenshots. Defaults to
   *  `<repo>/data/artifacts`. Recording is best-effort and never fails a run. */
  artifactsDir?: string;
  /** Capture rrweb/screenshots. Defaults to true; set false for speed. */
  record?: boolean;
  /** Sector profile key (see @portico/flow-spec SectorKey) selecting
   *  reliability defaults (timeouts, retries, readiness gates, mutation
   *  guards). Falls back to `flow.sector`, then the generic profile. */
  sector?: string;
  /** Hard network-egress boundary: when non-empty (and PORTICO_EGRESS_ENFORCE
   *  !== "0"), a main-frame navigation or any mutating (non-GET/HEAD/OPTIONS)
   *  request to a host outside this list is aborted before it leaves the
   *  browser. GET subresources (CDNs, fonts, analytics) always pass. */
  allowedDomains?: string[];
  /** Seed `output` with prior values before replay — combined with
   *  `resumeFrom`, this lets a resumed run's templated {{output.x}}
   *  references resolve to what an earlier (paused) attempt already produced. */
  resumeOutput?: Record<string, unknown>;
}

export interface EngineCapabilities {
  /** Can execute API-tier steps directly (via page-request.ts's `pageRequest`),
   *  for steps/flows the flow-spec marks API-eligible. */
  apiPromotion: boolean;
  /** Self-heals at run time via the recovery model. HONEST + dynamic: true only
   *  when a heal model is configured (PORTICO_HEAL_* / provider API key). With no
   *  model the deterministic path still runs, but there is no self-heal. */
  selfHeal: boolean;
  /** Runs in-process (vs CLI/subprocess) — decides multi-tenant/latency shape. */
  inProcess: boolean;
}

/** What the authoring session produces from a human demonstration. */
export interface AuthoredFlow {
  flow: Flow;
  /** True if network capture showed a clean API → eligible for the API tier. */
  apiTierEligible: boolean;
  capture?: unknown;
}

export interface EngineAdapter {
  readonly name: string;
  capabilities(): EngineCapabilities;

  /** Deterministic replay of a promoted flow. MUST make zero LLM calls on the
   *  hot path (see docs/ARCHITECTURE.md §4 hard invariant). */
  run(opts: EngineRunOptions): Promise<EngineRunResult>;

  /** Author a flow from a live demonstration (LLM allowed — off the hot path).
   *  Optional: engines that can't author are used replay-only. */
  author?(opts: { target: Target; auth: AuthContext }): Promise<AuthoredFlow>;
}
