/**
 * Session manager — tracks long-lived, logged-in CDP browsers.
 *
 * `scripts/serve-browser.mjs` launches a persistent Chromium instance that
 * stays open (and logged in) so flow runs can attach to it over CDP instead
 * of re-authenticating on every run. This module is the pure/orchestration
 * layer that TRACKS those browser sessions in the store, so the running
 * portal session is visible in the console, stays warm (via keep-alive
 * touches), and can be closed deliberately rather than only by killing the
 * process.
 *
 * Everything here is dependency-injected against a minimal `SessionStore`
 * structural interface (rather than importing `@portico/store` directly) so
 * it stays unit-testable with a plain in-memory fake.
 */

export type SessionHealth = "active" | "idle" | "stale";

export interface TrackedSession {
  id: string;
  tenant: string;
  profile?: string;
  cdpEndpoint?: string;
  status: "active" | "closed";
  startedAt: string;
  lastActiveAt: string;
}

/** The subset of `Store`'s browser-session methods this module needs. */
export interface SessionStore {
  createBrowserSession(s: {
    id: string;
    tenant: string;
    profile?: string;
    cdpEndpoint?: string;
    startedAt: string;
  }): void;
  touchBrowserSession(id: string, at: string): void;
  closeBrowserSession(id: string, at: string): void;
  getBrowserSession(id: string): TrackedSession | undefined;
  listBrowserSessions(tenant?: string): TrackedSession[];
}

const DEFAULT_IDLE_THRESHOLD_MS = 5 * 60_000; // 5 min
const DEFAULT_STALE_THRESHOLD_MS = 20 * 60_000; // 20 min

/**
 * Classify a session's health from its `lastActiveAt` vs `nowMs`.
 *
 * A closed session is always "stale". Otherwise the elapsed idle time since
 * last activity puts it in one of three buckets: "active" (recently touched),
 * "idle" (quiet for a while but not abandoned), or "stale" (long quiet —
 * likely dead/orphaned and a candidate for cleanup).
 */
export function sessionHealth(
  session: TrackedSession,
  nowMs: number,
  idleThresholdMs: number = DEFAULT_IDLE_THRESHOLD_MS,
  staleThresholdMs: number = DEFAULT_STALE_THRESHOLD_MS,
): SessionHealth {
  if (session.status === "closed") return "stale";
  const idleMs = nowMs - Date.parse(session.lastActiveAt);
  if (idleMs < idleThresholdMs) return "active";
  if (idleMs < staleThresholdMs) return "idle";
  return "stale";
}

/** Register a new tracked session; returns its id. */
export function registerSession(
  store: SessionStore,
  args: { id: string; tenant: string; profile?: string; cdpEndpoint?: string; at: string },
): string {
  store.createBrowserSession({
    id: args.id,
    tenant: args.tenant,
    profile: args.profile,
    cdpEndpoint: args.cdpEndpoint,
    startedAt: args.at,
  });
  return args.id;
}

/** Touch (keep-alive) — updates `lastActiveAt` so the session reads "active". */
export function keepAliveSession(store: SessionStore, id: string, at: string): void {
  store.touchBrowserSession(id, at);
}

/** End a session (mark it closed). */
export function endSession(store: SessionStore, id: string, at: string): void {
  store.closeBrowserSession(id, at);
}

/** Sessions decorated with computed health, active sessions first. */
export function listSessions(
  store: SessionStore,
  nowMs: number,
  tenant?: string,
): Array<TrackedSession & { health: SessionHealth }> {
  const rank: Record<SessionHealth, number> = { active: 0, idle: 1, stale: 2 };
  return store
    .listBrowserSessions(tenant)
    .map((session) => ({ ...session, health: sessionHealth(session, nowMs) }))
    .sort((a, b) => rank[a.health] - rank[b.health]);
}
