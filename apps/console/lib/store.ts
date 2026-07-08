import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { RunView, FlowView, SessionView } from "./types.js";

/** Durable run store, read via the CLI (which owns native SQLite) so nothing
 *  native enters the Next bundle. Runs are persisted by the CLI on every run,
 *  so they survive restarts. Shows real runs only — no seeded/fake data. */

const REPO_ROOT = resolve(process.cwd(), "../..");
const CLI = resolve(REPO_ROOT, "apps/cli/src/index.ts");

function query(args: string[]): unknown {
  const r = spawnSync("node", ["--import", "tsx", CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 15000,
  });
  const out = (r.stdout ?? "").trim();
  if (!out) return null;
  const last = out.split("\n").filter(Boolean).pop();
  try {
    return last ? JSON.parse(last) : null;
  } catch {
    return null;
  }
}

export function listRuns(): RunView[] {
  const r = query(["list-runs"]);
  return Array.isArray(r) ? (r as RunView[]) : [];
}

export function getRun(id: string): RunView | undefined {
  const r = query(["get-run", id]);
  return r ? (r as RunView) : undefined;
}

/** Flow drafts/versions, read via the CLI (newest first), each with its latest
 *  validation result attached (or null when never validated). */
export function readFlows(): FlowView[] {
  const r = query(["list-flows"]);
  return Array.isArray(r) ? (r as FlowView[]) : [];
}

export function readFlow(id: string): FlowView | undefined {
  const r = query(["get-flow", id]);
  return r ? (r as FlowView) : undefined;
}

/** Live and closed browser sessions, read via the CLI (newest activity first). */
export function readSessions(): SessionView[] {
  const r = query(["list-sessions", "--json"]);
  return Array.isArray(r) ? (r as SessionView[]) : [];
}
