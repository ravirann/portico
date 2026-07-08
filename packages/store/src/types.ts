/**
 * Persistence-layer types. These mirror the platform's in-memory view types
 * (apps/console/lib/types.ts) and the engine boundary (packages/engine/src/
 * types.ts) field-for-field so mapping a `RunView`/`StepView` in and out of the
 * store is lossless and integration stays trivial.
 */

export type RunStatus = "completed" | "running" | "failed" | "paused";
export type StepStatus = "ok" | "healed" | "failed" | "paused" | "skipped";
export type Tier = "api" | "dom" | "agent";
export type RunMode = "dry_run" | "live";

/** Matches apps/console/lib/types.ts `StepView`. */
export interface StepView {
  index: number;
  type: string;
  label?: string;
  status: StepStatus;
  detail?: string;
  durationMs: number;
}

/**
 * Optional self-heal / screenshot columns carried by the engine's `StepTrace`
 * (packages/engine/src/types.ts). `addRunSteps` accepts these on top of
 * `StepView` so a trace can be persisted without loss; they are `undefined`
 * for plain `StepView`s.
 */
export interface StepRecord extends StepView {
  healedFrom?: string;
  healedTo?: string;
  screenshotRef?: string;
}

/** Matches apps/console/lib/types.ts `RunView`. */
export interface RunView {
  id: string;
  connector: string;
  flow: string;
  engine: string;
  tier: Tier;
  status: RunStatus;
  mode: RunMode;
  startedAt: string; // ISO
  durationMs: number;
  steps: StepRecord[];
  output?: Record<string, unknown>;
  failure?: { stepIndex: number; reason: string };
  rrwebRef?: string;
}

/**
 * An append-only audit record. `audit_events` is write-once: the repository
 * exposes only `appendAudit` + `listAudit`; there is intentionally no update
 * or delete path.
 */
export interface AuditEvent {
  /** ISO timestamp; defaults to now on append. */
  ts?: string;
  actor: string;
  action: string;
  runId?: string;
  target?: string;
  detail?: Record<string, unknown>;
}

/** A stored audit record as read back (always carries an id + resolved ts). */
export interface StoredAuditEvent {
  id: number;
  ts: string;
  actor: string;
  action: string;
  runId?: string;
  target?: string;
  detail?: Record<string, unknown>;
}

export interface AuditFilter {
  runId?: string;
  actor?: string;
  action?: string;
  limit?: number;
}

export type FlowStatus = "draft" | "confirmed";
export type FlowSource = "recorded" | "manual" | "llm";

/** A single version of a recorded/authored flow (self-serve portal). */
export interface FlowRecord {
  id: string;
  key: string;
  version: number;
  yaml: string;
  status: FlowStatus;
  source: FlowSource;
  connector?: string;
  createdAt: string;
}

/** A validation attempt on a flow draft (dry-run outcome that gates confirm). */
export interface ValidationRecord {
  id: string;
  flowId: string;
  passed: boolean;
  reasons: string[];
  runId?: string;
  createdAt: string;
}

export type BrowserSessionStatus = "active" | "closed";

/** A tracked CDP-attached browser session (self-serve portal session manager). */
export interface BrowserSessionRecord {
  id: string;
  tenant: string;
  profile?: string;
  cdpEndpoint?: string;
  status: BrowserSessionStatus;
  startedAt: string;
  lastActiveAt: string;
}
