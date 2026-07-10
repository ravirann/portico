/**
 * Pure-logic tests for the console's opt-in RBAC (apps/console/lib/rbac.ts).
 * No Next.js runtime involved — run directly:
 *   node --import tsx --test apps/console/lib/rbac.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, extractToken, parseTokens, requiredRole, resolveIdentity, type RbacConfig } from "./rbac.js";

const OFF: RbacConfig = parseTokens(undefined);
const ON: RbacConfig = parseTokens("admin:tok_admin_1,operator:tok_operator_1,viewer:tok_viewer_1,viewer:tok_viewer_2");

test("off-mode (env unset) allows everything, any method, no token", () => {
  for (const method of ["GET", "POST", "DELETE"]) {
    for (const path of ["/", "/settings", "/api/config", "/api/connectors", "/api/flows/abc"]) {
      const result = decide({ path, method, token: null, config: OFF });
      assert.equal(result.allow, true, `${method} ${path} should be allowed off`);
    }
  }
});

test("off-mode also treats an empty string the same as unset", () => {
  const config = parseTokens("");
  assert.equal(config.enabled, false);
  const result = decide({ path: "/api/config", method: "POST", token: null, config });
  assert.equal(result.allow, true);
});

test("parseTokens loads role:token pairs and allows repeating a role", () => {
  assert.equal(ON.enabled, true);
  assert.equal(ON.tokens.get("tok_admin_1"), "admin");
  assert.equal(ON.tokens.get("tok_operator_1"), "operator");
  assert.equal(ON.tokens.get("tok_viewer_1"), "viewer");
  assert.equal(ON.tokens.get("tok_viewer_2"), "viewer");
});

test("parseTokens ignores tokens shorter than 8 chars, keeps the rest of the list", () => {
  const config = parseTokens("admin:short,viewer:tok_ok_12345");
  assert.equal(config.enabled, true);
  assert.equal(config.tokens.has("short"), false);
  assert.equal(config.tokens.get("tok_ok_12345"), "viewer");
  assert.equal(config.tokens.size, 1);
});

test("parseTokens ignores malformed entries and unknown roles, keeps valid ones", () => {
  const config = parseTokens("nocolonhere,superadmin:tok_1234567,viewer:tok_v_1234567");
  assert.equal(config.tokens.size, 1);
  assert.equal(config.tokens.get("tok_v_1234567"), "viewer");
});

test("parseTokens supports role:name:token, and 2-part entries default their name to the role", () => {
  const config = parseTokens("admin:boss:tok_admin_12345,viewer:tok_viewer_12345");
  assert.equal(config.tokens.get("tok_admin_12345"), "admin");
  assert.equal(config.names.get("tok_admin_12345"), "boss");
  assert.equal(config.tokens.get("tok_viewer_12345"), "viewer");
  assert.equal(config.names.get("tok_viewer_12345"), "viewer", "2-part entry defaults its name to the role string");
});

test("parseTokens still drops role:name:token entries whose token is under 8 chars", () => {
  const config = parseTokens("admin:boss:short,viewer:ok:tok_viewer_12345");
  assert.equal(config.tokens.has("short"), false);
  assert.equal(config.tokens.size, 1);
  assert.equal(config.tokens.get("tok_viewer_12345"), "viewer");
  assert.equal(config.names.get("tok_viewer_12345"), "ok");
});

test("resolveIdentity returns {role, name} for a valid token, and null for anything else", () => {
  const config = parseTokens("admin:boss:tok_admin_12345,viewer:tok_viewer_12345");
  assert.deepEqual(resolveIdentity("tok_admin_12345", config), { role: "admin", name: "boss" });
  assert.deepEqual(resolveIdentity("tok_viewer_12345", config), { role: "viewer", name: "viewer" });
  assert.equal(resolveIdentity("not-a-real-token", config), null);
  assert.equal(resolveIdentity(null, config), null);
});

test("viewer can GET pages and read APIs, but is blocked on any mutation", () => {
  const viewerToken = "tok_viewer_1";
  assert.equal(decide({ path: "/", method: "GET", token: viewerToken, config: ON }).allow, true);
  assert.equal(decide({ path: "/settings", method: "GET", token: viewerToken, config: ON }).allow, true);
  assert.equal(decide({ path: "/api/runs", method: "GET", token: viewerToken, config: ON }).allow, true);
  assert.equal(decide({ path: "/api/connectors/list", method: "GET", token: viewerToken, config: ON }).allow, true);

  const blockedPost = decide({ path: "/api/flows", method: "POST", token: viewerToken, config: ON });
  assert.equal(blockedPost.allow, false);
  assert.equal(blockedPost.status, 403);
});

test("operator can run/validate flows and start runs, but is blocked on settings and connector mutations", () => {
  const operatorToken = "tok_operator_1";
  assert.equal(decide({ path: "/api/runs", method: "POST", token: operatorToken, config: ON }).allow, true);
  assert.equal(decide({ path: "/api/flows/abc123/validate", method: "POST", token: operatorToken, config: ON }).allow, true);
  assert.equal(decide({ path: "/api/flows/abc123/confirm", method: "POST", token: operatorToken, config: ON }).allow, true);
  assert.equal(decide({ path: "/api/sessions/start", method: "POST", token: operatorToken, config: ON }).allow, true);

  const settingsAttempt = decide({ path: "/api/config", method: "POST", token: operatorToken, config: ON });
  assert.equal(settingsAttempt.allow, false);
  assert.equal(settingsAttempt.status, 403);

  const connectorCreate = decide({ path: "/api/connectors", method: "POST", token: operatorToken, config: ON });
  assert.equal(connectorCreate.allow, false);
  assert.equal(connectorCreate.status, 403);

  const flowDelete = decide({ path: "/api/flows/abc123", method: "DELETE", token: operatorToken, config: ON });
  assert.equal(flowDelete.allow, false, "flow delete is admin-only, not operator");
  assert.equal(flowDelete.status, 403);

  // Reads under /api/connectors* stay open to operator (only mutations are gated).
  assert.equal(decide({ path: "/api/connectors/list", method: "GET", token: operatorToken, config: ON }).allow, true);
});

test("admin can do everything, including settings, connector mutations, and flow delete", () => {
  const adminToken = "tok_admin_1";
  assert.equal(decide({ path: "/api/config", method: "POST", token: adminToken, config: ON }).allow, true);
  assert.equal(decide({ path: "/api/connectors", method: "POST", token: adminToken, config: ON }).allow, true);
  assert.equal(decide({ path: "/api/connectors/my-connector", method: "DELETE", token: adminToken, config: ON }).allow, true);
  assert.equal(decide({ path: "/api/flows/abc123", method: "DELETE", token: adminToken, config: ON }).allow, true);
  assert.equal(decide({ path: "/api/runs", method: "POST", token: adminToken, config: ON }).allow, true);
  assert.equal(decide({ path: "/", method: "GET", token: adminToken, config: ON }).allow, true);
});

test("requiredRole classifies the admin-only surface precisely", () => {
  assert.equal(requiredRole("/api/config", "POST"), "admin");
  assert.equal(requiredRole("/api/config", "GET"), "admin"); // all methods, not just writes
  assert.equal(requiredRole("/api/connectors", "POST"), "admin");
  assert.equal(requiredRole("/api/connectors/list", "GET"), "viewer"); // reads stay open
  assert.equal(requiredRole("/api/connectors/variables", "POST"), "admin");
  assert.equal(requiredRole("/api/connectors/variables", "GET"), "viewer");
  assert.equal(requiredRole("/api/flows/abc123", "DELETE"), "admin");
  assert.equal(requiredRole("/api/flows/abc123", "GET"), "viewer");
  assert.equal(requiredRole("/api/flows/abc123/validate", "POST"), "operator");
  assert.equal(requiredRole("/api/flows", "POST"), "operator");
});

test("requiredRole classifies /members as admin-only, any method", () => {
  assert.equal(requiredRole("/members", "GET"), "admin");
  assert.equal(requiredRole("/members/", "GET"), "admin");
  assert.equal(requiredRole("/members", "POST"), "admin");
});

test("/members: viewer/operator are redirected home (not /login); admin gets through", () => {
  const viewerResult = decide({ path: "/members", method: "GET", token: "tok_viewer_1", config: ON });
  assert.equal(viewerResult.allow, false);
  assert.equal(viewerResult.redirect, "/", "insufficient role on a page redirects home, not to /login");
  assert.equal(viewerResult.status, undefined);

  const operatorResult = decide({ path: "/members", method: "GET", token: "tok_operator_1", config: ON });
  assert.equal(operatorResult.allow, false);
  assert.equal(operatorResult.redirect, "/");

  assert.equal(decide({ path: "/members", method: "GET", token: "tok_admin_1", config: ON }).allow, true);
});

test("/members with no valid token still redirects to /login (unauthenticated, not merely under-ranked)", () => {
  const result = decide({ path: "/members", method: "GET", token: null, config: ON });
  assert.equal(result.allow, false);
  assert.equal(result.redirect, "/login");
});

test("/login and /_next are always allowed, on or off, with no token", () => {
  for (const config of [OFF, ON]) {
    assert.equal(decide({ path: "/login", method: "GET", token: null, config }).allow, true);
    assert.equal(decide({ path: "/_next/static/chunks/main.js", method: "GET", token: null, config }).allow, true);
    assert.equal(decide({ path: "/favicon.ico", method: "GET", token: null, config }).allow, true);
  }
});

test("unauthenticated: API routes get a 401, page navigations redirect to /login", () => {
  const apiResult = decide({ path: "/api/runs", method: "GET", token: null, config: ON });
  assert.equal(apiResult.allow, false);
  assert.equal(apiResult.status, 401);
  assert.equal(apiResult.redirect, undefined);

  const pageResult = decide({ path: "/settings", method: "GET", token: null, config: ON });
  assert.equal(pageResult.allow, false);
  assert.equal(pageResult.redirect, "/login");
  assert.equal(pageResult.status, undefined);
});

test("an unrecognized (garbage) token behaves like no token at all", () => {
  const result = decide({ path: "/api/runs", method: "GET", token: "not-a-real-token", config: ON });
  assert.equal(result.allow, false);
  assert.equal(result.status, 401);
});

test("extractToken prefers the Authorization bearer header over the cookie", () => {
  assert.equal(extractToken({ authorization: "Bearer abc123", cookie: "def456" }), "abc123");
  assert.equal(extractToken({ authorization: null, cookie: "def456" }), "def456");
  assert.equal(extractToken({ authorization: "Bearer   abc123  ", cookie: null }), "abc123");
  assert.equal(extractToken({ authorization: null, cookie: null }), null);
  assert.equal(extractToken({ authorization: "Basic xyz", cookie: "def456" }), "def456"); // non-Bearer scheme falls back to cookie
});

// --- DB-backed members: new always-allowed routes + admin-only /api/members ---
// (middleware.ts resolves a portico_session cookie to a {role, name} and
// bridges it into decide() as an ephemeral single-entry RbacConfig — from
// this module's point of view that's just another token match, so no new
// decide()-level test is needed for the session path itself; session.ts and
// the live E2E cover that. What's new HERE is the path classification below.)

test("/api/auth/login, /api/auth/logout, and /api/auth/status are always allowed, on or off, with no token", () => {
  for (const config of [OFF, ON]) {
    for (const path of ["/api/auth/login", "/api/auth/logout", "/api/auth/status"]) {
      const result = decide({ path, method: "POST", token: null, config });
      assert.equal(result.allow, true, `${path} should always be allowed`);
    }
  }
});

test("/api/members/bootstrap is always allowed, on or off, with no token (the route re-checks count===0 itself)", () => {
  for (const config of [OFF, ON]) {
    const result = decide({ path: "/api/members/bootstrap", method: "POST", token: null, config });
    assert.equal(result.allow, true);
  }
});

test("requiredRole classifies /api/members (add) and /api/members/[id]/disable|enable as admin-only, any method", () => {
  assert.equal(requiredRole("/api/members", "POST"), "admin");
  assert.equal(requiredRole("/api/members", "GET"), "admin"); // all methods, not just writes
  assert.equal(requiredRole("/api/members/mem_abc123/disable", "POST"), "admin");
  assert.equal(requiredRole("/api/members/mem_abc123/enable", "POST"), "admin");
});

test("requiredRole does NOT classify /api/members/bootstrap as admin-only (it's always-allowed instead, never reaches requiredRole in practice)", () => {
  assert.equal(requiredRole("/api/members/bootstrap", "POST"), "operator", "excluded from isMembersApiRoute on purpose — see isAlwaysAllowedPath");
});

test("viewer/operator get 403 from the mutating /api/members API; admin gets through", () => {
  const viewerAttempt = decide({ path: "/api/members", method: "POST", token: "tok_viewer_1", config: ON });
  assert.equal(viewerAttempt.allow, false);
  assert.equal(viewerAttempt.status, 403);

  const operatorAttempt = decide({ path: "/api/members/mem_1/disable", method: "POST", token: "tok_operator_1", config: ON });
  assert.equal(operatorAttempt.allow, false);
  assert.equal(operatorAttempt.status, 403);

  assert.equal(decide({ path: "/api/members", method: "POST", token: "tok_admin_1", config: ON }).allow, true);
  assert.equal(decide({ path: "/api/members/mem_1/enable", method: "POST", token: "tok_admin_1", config: ON }).allow, true);
});

test("an unauthenticated request to the mutating /api/members API gets 401, not a redirect (it's an API path)", () => {
  const result = decide({ path: "/api/members", method: "POST", token: null, config: ON });
  assert.equal(result.allow, false);
  assert.equal(result.status, 401);
});
