import type { RunView } from "./types.js";

/** In-memory run store, seeded with representative runs so the console is alive
 *  on first load. Live runs (POST /api/runs) are prepended. Resets on restart —
 *  the durable Postgres-backed store is a control-plane follow-up. */

const iso = (minsAgo: number) => new Date(Date.UTC(2026, 6, 8, 14, 30) - minsAgo * 60000).toISOString();

const seed: RunView[] = [
  {
    id: "run_9f2a71",
    connector: "example-portal",
    flow: "portal-schedule",
    engine: "libretto",
    tier: "dom",
    status: "completed",
    mode: "dry_run",
    startedAt: iso(4),
    durationMs: 5840,
    output: { available_options: 3, reached_selection_screen: true, booked: false },
    steps: [
      { index: 0, type: "subflow", label: "portal-login (trusted session)", status: "ok", durationMs: 610 },
      { index: 1, type: "act", label: "Open scheduling", status: "ok", durationMs: 940 },
      { index: 2, type: "act", label: "Select reason", status: "ok", durationMs: 720 },
      { index: 3, type: "extract", label: "Read available options", status: "ok", detail: "3 options extracted", durationMs: 1180 },
      { index: 4, type: "assert", label: "Reached the selection screen", status: "ok", durationMs: 210 },
    ],
  },
  {
    id: "run_8c04de",
    connector: "example-portal",
    flow: "portal-schedule",
    engine: "libretto",
    tier: "dom",
    status: "completed",
    mode: "dry_run",
    startedAt: iso(22),
    durationMs: 7020,
    output: { available_options: 5, reached_selection_screen: true, booked: false },
    steps: [
      { index: 0, type: "subflow", label: "portal-login (trusted session)", status: "ok", durationMs: 640 },
      { index: 1, type: "act", label: "Open scheduling", status: "healed", detail: "locator changed — self-healed by meaning, cached", durationMs: 1980 },
      { index: 2, type: "act", label: "Select reason", status: "ok", durationMs: 700 },
      { index: 3, type: "extract", label: "Read available options", status: "ok", detail: "5 options extracted", durationMs: 1210 },
      { index: 4, type: "assert", label: "Reached the selection screen", status: "ok", durationMs: 190 },
    ],
  },
  {
    id: "run_7b18aa",
    connector: "eligibility",
    flow: "eligibility-check",
    engine: "libretto",
    tier: "api",
    status: "completed",
    mode: "dry_run",
    startedAt: iso(48),
    durationMs: 420,
    output: { eligible: true, plan: "PPO", copay: "$25" },
    steps: [
      { index: 0, type: "navigate", label: "Direct API — member lookup", status: "ok", detail: "captured JSON endpoint", durationMs: 180 },
      { index: 1, type: "extract", label: "Read eligibility", status: "ok", durationMs: 130 },
    ],
  },
  {
    id: "run_6a55c1",
    connector: "example-portal",
    flow: "portal-schedule",
    engine: "libretto",
    tier: "dom",
    status: "failed",
    mode: "dry_run",
    startedAt: iso(95),
    durationMs: 4310,
    failure: { stepIndex: 1, reason: "scheduling entry redesigned into a multi-step wizard — flow change, re-record this step" },
    steps: [
      { index: 0, type: "subflow", label: "portal-login (trusted session)", status: "ok", durationMs: 590 },
      { index: 1, type: "act", label: "Open scheduling", status: "failed", detail: "fail-safe: could not infer intent after a semantic change", durationMs: 3720 },
    ],
  },
];

let runs: RunView[] = [...seed];

export function listRuns(): RunView[] {
  return runs;
}
export function getRun(id: string): RunView | undefined {
  return runs.find((r) => r.id === id);
}
export function addRun(run: RunView): void {
  runs = [run, ...runs];
}
