/**
 * Unit tests for session-manager — the pure/orchestration helpers that track
 * long-lived CDP browser sessions against a store.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  endSession,
  keepAliveSession,
  listSessions,
  registerSession,
  sessionHealth,
  type SessionStore,
  type TrackedSession,
} from "./session-manager.js";

/** Simple in-memory fake of the store's browser-session surface. */
function makeFakeStore(): SessionStore & { sessions: Map<string, TrackedSession> } {
  const sessions = new Map<string, TrackedSession>();
  return {
    sessions,
    createBrowserSession(s) {
      sessions.set(s.id, {
        id: s.id,
        tenant: s.tenant,
        profile: s.profile,
        cdpEndpoint: s.cdpEndpoint,
        status: "active",
        startedAt: s.startedAt,
        lastActiveAt: s.startedAt,
      });
    },
    touchBrowserSession(id, at) {
      const session = sessions.get(id);
      if (session) session.lastActiveAt = at;
    },
    closeBrowserSession(id, at) {
      const session = sessions.get(id);
      if (session) {
        session.status = "closed";
        session.lastActiveAt = at;
      }
    },
    getBrowserSession(id) {
      return sessions.get(id);
    },
    listBrowserSessions(tenant) {
      const all = [...sessions.values()];
      const filtered = tenant != null ? all.filter((s) => s.tenant === tenant) : all;
      return filtered
        .slice()
        .sort((a, b) => {
          if (a.status !== b.status) return a.status === "active" ? -1 : 1;
          return Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt);
        });
    },
  };
}

const T0 = Date.parse("2026-01-01T00:00:00Z");

function session(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    id: "sess_1",
    tenant: "default",
    status: "active",
    startedAt: new Date(T0).toISOString(),
    lastActiveAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

test("sessionHealth: fresh activity is active", () => {
  const s = session({ lastActiveAt: new Date(T0).toISOString() });
  assert.equal(sessionHealth(s, T0), "active");
  // Just under the idle threshold (5 min) is still active.
  assert.equal(sessionHealth(s, T0 + 5 * 60_000 - 1), "active");
});

test("sessionHealth: at/after idle threshold but under stale threshold is idle", () => {
  const s = session({ lastActiveAt: new Date(T0).toISOString() });
  assert.equal(sessionHealth(s, T0 + 5 * 60_000), "idle");
  assert.equal(sessionHealth(s, T0 + 20 * 60_000 - 1), "idle");
});

test("sessionHealth: at/after stale threshold is stale", () => {
  const s = session({ lastActiveAt: new Date(T0).toISOString() });
  assert.equal(sessionHealth(s, T0 + 20 * 60_000), "stale");
  assert.equal(sessionHealth(s, T0 + 60 * 60_000), "stale");
});

test("sessionHealth: closed session is always stale, regardless of elapsed time", () => {
  const s = session({ status: "closed", lastActiveAt: new Date(T0).toISOString() });
  assert.equal(sessionHealth(s, T0), "stale");
  assert.equal(sessionHealth(s, T0 + 1), "stale");
});

test("sessionHealth: custom thresholds are respected", () => {
  const s = session({ lastActiveAt: new Date(T0).toISOString() });
  assert.equal(sessionHealth(s, T0 + 1_000, 500, 2_000), "idle");
  assert.equal(sessionHealth(s, T0 + 3_000, 500, 2_000), "stale");
});

test("registerSession then getBrowserSession round-trips", () => {
  const store = makeFakeStore();
  const id = registerSession(store, {
    id: "sess_abc",
    tenant: "acme",
    profile: "mychart",
    cdpEndpoint: "http://localhost:9222",
    at: new Date(T0).toISOString(),
  });
  assert.equal(id, "sess_abc");
  const stored = store.getBrowserSession("sess_abc");
  assert.ok(stored);
  assert.equal(stored?.tenant, "acme");
  assert.equal(stored?.profile, "mychart");
  assert.equal(stored?.cdpEndpoint, "http://localhost:9222");
  assert.equal(stored?.status, "active");
  assert.equal(stored?.startedAt, new Date(T0).toISOString());
  assert.equal(stored?.lastActiveAt, new Date(T0).toISOString());
});

test("keepAliveSession updates lastActiveAt and health goes active again", () => {
  const store = makeFakeStore();
  registerSession(store, { id: "sess_1", tenant: "default", at: new Date(T0).toISOString() });

  const laterMs = T0 + 30 * 60_000; // well past stale threshold since registration
  let stored = store.getBrowserSession("sess_1")!;
  assert.equal(sessionHealth(stored, laterMs), "stale");

  keepAliveSession(store, "sess_1", new Date(laterMs).toISOString());
  stored = store.getBrowserSession("sess_1")!;
  assert.equal(stored.lastActiveAt, new Date(laterMs).toISOString());
  assert.equal(sessionHealth(stored, laterMs), "active");
});

test("endSession marks the session closed, and health becomes stale", () => {
  const store = makeFakeStore();
  registerSession(store, { id: "sess_1", tenant: "default", at: new Date(T0).toISOString() });

  endSession(store, "sess_1", new Date(T0 + 1_000).toISOString());
  const stored = store.getBrowserSession("sess_1")!;
  assert.equal(stored.status, "closed");
  assert.equal(sessionHealth(stored, T0 + 1_000), "stale");
});

test("listSessions returns health-decorated sessions, active first", () => {
  const store = makeFakeStore();
  // sess_stale: registered long ago, never touched again -> stale by nowMs.
  registerSession(store, { id: "sess_stale", tenant: "default", at: new Date(T0).toISOString() });
  // sess_idle: touched partway through the idle window.
  registerSession(store, {
    id: "sess_idle",
    tenant: "default",
    at: new Date(T0 + 10 * 60_000).toISOString(),
  });
  // sess_active: touched just before "now".
  registerSession(store, {
    id: "sess_active",
    tenant: "default",
    at: new Date(T0 + 24 * 60_000).toISOString(),
  });

  const nowMs = T0 + 25 * 60_000;
  const decorated = listSessions(store, nowMs, "default");

  assert.equal(decorated.length, 3);
  const healthById = Object.fromEntries(decorated.map((s) => [s.id, s.health]));
  assert.equal(healthById.sess_stale, "stale");
  assert.equal(healthById.sess_idle, "idle");
  assert.equal(healthById.sess_active, "active");

  // Active-first ordering.
  assert.equal(decorated[0].id, "sess_active");
  assert.equal(decorated[0].health, "active");
  // The remaining two (idle, stale) follow, in some order after the active one.
  assert.deepEqual(
    new Set(decorated.slice(1).map((s) => s.id)),
    new Set(["sess_idle", "sess_stale"]),
  );
});

test("listSessions filters by tenant", () => {
  const store = makeFakeStore();
  registerSession(store, { id: "sess_a", tenant: "acme", at: new Date(T0).toISOString() });
  registerSession(store, { id: "sess_b", tenant: "other", at: new Date(T0).toISOString() });

  const decorated = listSessions(store, T0, "acme");
  assert.equal(decorated.length, 1);
  assert.equal(decorated[0].id, "sess_a");
});
