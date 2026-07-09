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
  /** The instance (deployment) this run targeted, e.g. "urmc". `connector` is
   *  the connector KEY; `instance` is the specific deployment within it. */
  instance?: string;
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
export type FlowSource = "recorded" | "manual" | "llm" | "authored";

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
  pid?: number;
  /** The connector KEY this session is for (scopes it in the console). */
  connector?: string;
}

/** A configured connector (self-serve portal connector registry). */
export interface ConnectorRecord {
  id: string;
  key: string;
  name: string;
  framework?: string;
  baseUrl?: string;
  auth?: string;
  variables: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export type RecordingStatus = "recording" | "stopped" | "compiled" | "error";

/** A record-by-demonstration capture session: a detached recorder attached to a
 *  browser session over CDP, writing a recording.json the compiler turns into a
 *  draft flow. `draftFlowId` is set once the capture is compiled. */
export interface RecordingRecord {
  id: string;
  sessionId: string;
  connector?: string;
  flowKey: string;
  baseUrl?: string;
  status: RecordingStatus;
  path: string;
  pid?: number;
  draftFlowId?: string;
  clicks?: number;
  requests?: number;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

export type AuthorJobStatus = "running" | "done" | "failed";

/** One line in an authoring job's progress timeline. */
export interface AuthorJobEvent {
  ts: string;
  message: string;
}

/** An async agent-authoring job — the author process runs detached and reports
 *  progress/result here so the console can poll and survive a page reload. */
export interface AuthorJobRecord {
  id: string;
  connector?: string;
  goal: string;
  startUrl: string;
  flowKey?: string;
  status: AuthorJobStatus;
  draftFlowId?: string;
  progress?: string;
  error?: string;
  pid?: number;
  startedAt: string;
  updatedAt: string;
}

/** Scope-namespaced app configuration (LLM settings, connector variables). */
export interface ConfigEntry {
  id: string;
  scope: string;
  category: "llm" | "variable";
  key: string;
  value: string;
  secret: boolean;
  updatedAt: string;
}
