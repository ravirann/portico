import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { RunView, FlowView, SessionView, ConnectorRecord, ConfigEntry, AuthorJobView } from "./types.js";

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
    // list-runs carries every run's full step array and grows past 1 MB, which
    // silently TRUNCATED stdout at spawnSync's default maxBuffer → the JSON parse
    // failed → the page rendered an empty list. Give it generous headroom.
    maxBuffer: 128 * 1024 * 1024,
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

/** DB-backed connectors, read via the CLI (editable from the console). Distinct
 *  from the read-only filesystem "seed" connectors in lib/connectors.ts. */
export function readConnectors(): ConnectorRecord[] {
  const r = query(["list-connectors", "--json"]);
  return Array.isArray(r) ? (r as ConnectorRecord[]) : [];
}

export function readConnector(idOrKey: string): ConnectorRecord | undefined {
  const r = query(["get-connector", idOrKey, "--json"]);
  return r ? (r as ConnectorRecord) : undefined;
}

/** An async authoring job's current state (progress/result), for polling. */
export function getAuthorJob(id: string): AuthorJobView | null {
  const r = query(["author-job-get", id]);
  return r && typeof r === "object" ? (r as AuthorJobView) : null;
}

/** Scoped config entries (LLM settings + variables). Optionally filtered by
 *  scope (e.g. "global" or a connector key) and category. */
export function readConfig(opts: { scope?: string; category?: "llm" | "variable" } = {}): ConfigEntry[] {
  const args = ["config-get"];
  if (opts.scope) args.push("--scope", opts.scope);
  if (opts.category) args.push("--category", opts.category);
  args.push("--json");
  const r = query(args);
  return Array.isArray(r) ? (r as ConfigEntry[]) : [];
}
