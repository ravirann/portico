import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { RunView, FlowView, SessionView, ConnectorRecord, ConfigEntry, AuthorJobView, AuditEventView, MemberView } from "./types.js";

/** Durable run store, read via the CLI (which owns native SQLite) so nothing
 *  native enters the Next bundle. Runs are persisted by the CLI on every run,
 *  so they survive restarts. Shows real runs only — no seeded/fake data. */

const REPO_ROOT = resolve(process.cwd(), "../..");
const CLI = resolve(REPO_ROOT, "apps/cli/src/index.ts");

function query(args: string[], extraEnv?: Record<string, string>): unknown {
  const r = spawnSync("node", ["--import", "tsx", CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 15000,
    // list-runs carries every run's full step array and grows past 1 MB, which
    // silently TRUNCATED stdout at spawnSync's default maxBuffer → the JSON parse
    // failed → the page rendered an empty list. Give it generous headroom.
    maxBuffer: 128 * 1024 * 1024,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
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

/** Recent audit events, read via the CLI (newest first). Audit is append-only
 *  in the store — this is a read-only export for operators; there is no write
 *  path from the console. */
export function readAudit(limit = 100): AuditEventView[] {
  const r = query(["list-audit", "--json", "--limit", String(limit)]);
  return Array.isArray(r) ? (r as AuditEventView[]) : [];
}

// ---- members / auth (DB-backed) ------------------------------------------
// See docs/DEPLOY.md "Members & access control" and apps/cli/src/index.ts's
// member-add/member-list/member-disable/member-enable/auth-check handlers.
// member-list --json never emits a token or token_hash (see MemberView) —
// the raw token exists only in-process at member-add time and is returned
// exactly once, via app/api/members/route.ts, never persisted anywhere.

/** All members (active + disabled), newest first. Used by
 *  app/members/page.tsx's server component to render the real member table —
 *  there is no separate "get one member" read; the page filters client-side
 *  if it ever needs to. */
export function readMembers(): MemberView[] {
  const r = query(["member-list", "--json"]);
  return Array.isArray(r) ? (r as MemberView[]) : [];
}

let memberCountCache: { count: number; at: number } | null = null;
const MEMBER_COUNT_CACHE_MS = 10_000;

/**
 * Cheap "does at least one member row exist" probe for
 * app/api/auth/status/route.ts, which middleware.ts polls (with its OWN
 * separate 10s cache) to decide whether DB-backed enforcement should be on.
 * There's no dedicated count command in the CLI (adding one would mean
 * touching apps/cli, out of scope here) — this shells the same
 * `member-list --json` as `readMembers` and just checks its length, but
 * caches the result at module scope for 10s so a burst of requests (every
 * page load triggers a middleware -> /api/auth/status round trip) doesn't
 * spawn a CLI subprocess per request. Counts disabled members too — the
 * question this answers is "has anyone ever been onboarded", not "is anyone
 * currently able to log in", so disabling every member does NOT reopen the
 * console.
 */
export function countMembersFast(): number {
  const now = Date.now();
  if (memberCountCache && now - memberCountCache.at < MEMBER_COUNT_CACHE_MS) {
    return memberCountCache.count;
  }
  const count = readMembers().length;
  memberCountCache = { count, at: now };
  return count;
}

export interface AuthCheckResult {
  ok: boolean;
  member?: { id: string; name: string; role: MemberView["role"] };
}

/**
 * Verify a raw bearer token against the members table via the CLI's
 * auth-check command, for app/api/auth/login/route.ts. The token is passed
 * through the PORTICO_AUTH_CHECK_TOKEN env var — NEVER argv, which leaks
 * into `ps`/process-list output on shared hosts (see apps/cli/src/index.ts's
 * auth-check handler, which reads that same var and nothing else). Always
 * resolves (auth-check itself always exits 0 — `{ok:false}` IS the "not
 * authenticated" signal, not a process failure); a malformed/empty CLI
 * response is treated as `{ok:false}` rather than thrown.
 */
export function authCheck(token: string): AuthCheckResult {
  const r = query(["auth-check"], { PORTICO_AUTH_CHECK_TOKEN: token });
  return r && typeof r === "object" ? (r as AuthCheckResult) : { ok: false };
}

/** The one moment a raw token exists outside the member's own hands: CLI
 *  member-add generates it, prints it once, and stores only the hash. The
 *  route (app/api/members/route.ts) relays it to the admin's browser once
 *  and it is never queryable again. */
export function addMember(name: string, role: MemberView["role"]): { id: string; name: string; role: MemberView["role"]; token: string } | null {
  const r = query(["member-add", "--name", name, "--role", role, "--json"]);
  if (r && typeof r === "object" && "token" in (r as Record<string, unknown>)) {
    memberCountCache = null; // membership changed — invalidate the fast count
    return r as { id: string; name: string; role: MemberView["role"]; token: string };
  }
  return null;
}

/** Disable/enable a member (CLI member-disable / member-enable). Disabling
 *  blocks their NEXT login; an existing session stays valid until its exp
 *  (see lib/session.ts revocation note). */
export function setMemberDisabled(id: string, disabled: boolean): boolean {
  const r = query([disabled ? "member-disable" : "member-enable", id, "--json"]);
  return Boolean(r && typeof r === "object" && !(r as { error?: string }).error);
}
