/**
 * The engine boundary. Everything Portico's platform layer needs from an
 * execution engine is expressed here; the concrete engine (Libretto today,
 * a fallback) lives behind `EngineAdapter`. See ADR-0001.
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
}

export type RunStatus = "completed" | "failed" | "paused";

export interface EngineRunResult {
  status: RunStatus;
  /** Schema-validated outputs from `extract` steps. */
  output: Record<string, unknown>;
  traces: StepTrace[];
  rrwebRef?: string;
  /** Present when status = failed | paused. `paused` ⇒ HITL/resume needed. */
  failure?: { stepIndex: number; reason: string; resumable: boolean };
  /** Updated trusted session to persist back to the vault, if it changed. */
  sessionState?: unknown;
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
}

export interface EngineCapabilities {
  /** Can capture network → promote a target to the direct-API tier. */
  apiPromotion: boolean;
  /** Self-heals broken locators at run time. */
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
