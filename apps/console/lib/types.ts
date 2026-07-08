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
}

export type FlowStatus = "draft" | "confirmed";
export type FlowSource = "recorded" | "manual" | "llm";

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
}
