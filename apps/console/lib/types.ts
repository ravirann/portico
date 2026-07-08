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
}
