export type RunStatus = "completed" | "running" | "failed" | "paused";
export type StepStatus = "ok" | "healed" | "failed" | "paused" | "skipped";
export type Tier = "api" | "dom" | "agent";

export interface StepView {
  index: number;
  type: string;
  label?: string;
  status: StepStatus;
  detail?: string;
  durationMs: number;
  screenshotRef?: string;
}

export interface RunView {
  id: string;
  connector: string;
  flow: string;
  engine: string;
  tier: Tier;
  status: RunStatus;
  mode: "dry_run" | "live";
  startedAt: string; // ISO
  durationMs: number;
  steps: StepView[];
  output?: Record<string, unknown>;
  failure?: { stepIndex: number; reason: string };
  rrwebRef?: string;
  /** Instance (deployment) the run targeted; `connector` is the connector key. */
  instance?: string;
}

export type FlowStatus = "draft" | "confirmed";
export type FlowSource = "recorded" | "manual" | "llm" | "authored";

export interface ValidationView {
  id: string;
  flowId: string;
  passed: boolean;
  reasons: string[];
  runId?: string;
  createdAt: string; // ISO
}

export interface FlowView {
  id: string;
  key: string;
  version: number;
  yaml: string;
  status: FlowStatus;
  source: FlowSource;
  connector?: string;
  createdAt: string; // ISO
  validation: ValidationView | null;
}

/** A DB-backed connector record, owned and edited from the console (as opposed
 *  to the read-only filesystem "seed" connectors under connectors/). */
export interface ConnectorRecord {
  id: string;
  key: string;
  name: string;
  framework?: string;
  baseUrl?: string;
  auth?: string;
  variables: Record<string, string>;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/** A scoped config entry (LLM setting or connector variable). For secret:true
 *  entries the `value` is sensitive and must never be rendered in the UI. */
export interface ConfigEntry {
  id: string;
  scope: string;
  category: "llm" | "variable";
  key: string;
  value: string;
  secret: boolean;
  updatedAt: string; // ISO
}

export type SessionStatus = "active" | "closed";
export type SessionHealth = "active" | "idle" | "stale";

export interface SessionView {
  id: string;
  tenant: string;
  profile?: string;
  cdpEndpoint?: string;
  status: SessionStatus;
  startedAt: string; // ISO
  lastActiveAt: string; // ISO
  health: SessionHealth;
  /** The connector KEY this session is for (scopes it in the console). */
  connector?: string;
}

export type AuthorJobStatus = "running" | "done" | "failed";

/** One line in an authoring job's progress timeline. */
export interface AuthorJobEvent {
  ts: string;
  message: string;
}

/** An async agent-authoring job as the console sees it (polled from the store). */
export interface AuthorJobView {
  id: string;
  connector?: string;
  goal: string;
  startUrl: string;
  flowKey?: string;
  status: AuthorJobStatus;
  draftFlowId?: string;
  progress?: string;
  error?: string;
  startedAt?: string;
  updatedAt?: string;
  /** Progress timeline (bundled by author-job-get). */
  events?: AuthorJobEvent[];
}

/** An append-only audit record, as the console sees it (read via the CLI).
 *  Mirrors packages/store/src/types.ts `StoredAuditEvent` — audit is
 *  write-once, so there is no update/delete path, only appendAudit/listAudit
 *  in the store and readAudit here. */
export interface AuditEventView {
  id: number;
  ts: string; // ISO
  actor: string;
  action: string;
  runId?: string;
  target?: string;
  detail?: Record<string, unknown>;
}
