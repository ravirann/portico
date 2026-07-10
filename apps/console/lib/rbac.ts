/**
 * Pure RBAC decision logic for the console — no Next.js imports, so this
 * loads and runs fine under `node --import tsx --test` without a Next
 * runtime (see rbac.test.ts). `middleware.ts` is a thin, Next-aware adapter
 * over `parseTokens` + `extractToken` + `decide` + `resolveIdentity` for env
 * static tokens, PLUS a `portico_session` cookie check (lib/session.ts) for
 * DB-backed members — this module has no idea sessions/members exist at
 * all. Middleware bridges a verified session's {role, name} into `decide()`
 * by building a one-entry, request-scoped `RbacConfig` around it (see
 * middleware.ts) — from this module's point of view that's indistinguishable
 * from a normal env-token match, which is deliberate: it means everything
 * below (role ranking, the admin-only surface, 401 vs 403 vs redirect) is
 * shared by both auth sources without this file knowing which one it is.
 *
 * Design (user-facing version lives in docs/DEPLOY.md, "Members & access
 * control"):
 *  - `enabled` here reflects ONLY PORTICO_RBAC_TOKENS (non-empty string) —
 *    deliberately independent of whether any individual entry in it turns
 *    out to be valid, so a typo'd token can never silently reopen the
 *    console. Middleware ORs this with a second, DB-backed signal ("does
 *    any member row exist?") before calling `decide()` — see
 *    middleware.ts's `dbMembersEnabled` — so this module's `enabled` is
 *    necessarily a partial view of whether enforcement is actually on.
 *    When neither is true, every request is allowed (today's fully-open
 *    default for a fresh, unconfigured console).
 *  - Roles rank viewer < operator < admin. viewer covers every GET/HEAD —
 *    all pages, all read APIs. operator adds mutations except the
 *    admin-only surface below. admin can do everything.
 *  - Admin-only: any method on /api/config (the Settings page's backing
 *    route — there is no literal /api/settings path in this app; see
 *    isSettingsApiRoute), any mutation (non-GET/HEAD) under /api/connectors*,
 *    DELETE /api/flows/[id] (the flow-delete route), the /members page (see
 *    isMembersPage), and the mutating /api/members* routes (see
 *    isMembersApiRoute) — add/disable/enable a member.
 *  - Always allowed, no token needed, `enabled` or not: /login, the session
 *    login/logout/status API routes, and the one-time bootstrap route (see
 *    isAlwaysAllowedPath) — a signed-out visitor has nothing else to
 *    authenticate a request to any of those WITH.
 *  - Named tokens: each entry is `role:token` (name defaults to the role
 *    string, e.g. plain "admin") or `role:name:token` (explicit display
 *    name, e.g. "operator:ravi:tok123"). Both shapes coexist in the same
 *    PORTICO_RBAC_TOKENS list. `resolveIdentity` turns a presented token
 *    into the {role, name} pair middleware forwards to the app.
 *  - Page vs API on denial: an API request that fails RBAC gets a 401
 *    (no/unrecognized token) or 403 (recognized but insufficient role) JSON
 *    response. A page navigation with no/unrecognized token redirects to
 *    /login (nothing to authenticate against yet). A page navigation with a
 *    *valid* token but insufficient role (currently: non-admin on /members)
 *    redirects to / instead — the user is already signed in, so bouncing
 *    them to /login would just have them re-present the same token and land
 *    right back here; there's no dedicated 403 page.
 */

export type Role = "viewer" | "operator" | "admin";

export interface RbacConfig {
  /** True iff PORTICO_RBAC_TOKENS was a non-empty string. Independent of
   *  whether `tokens` ended up empty after filtering bad entries — an
   *  all-invalid token list is still "on" (and thus locked down), not
   *  silently treated as "off". */
  enabled: boolean;
  /** token -> role, valid entries only. */
  tokens: Map<string, Role>;
  /** token -> display name, valid entries only, 1:1 with `tokens`. Kept as
   *  a separate map (rather than widening `tokens`'s value type) so the
   *  pre-existing `Map<string, Role>` shape — and every test asserting
   *  against it directly — stays intact. Always populated: an entry with no
   *  explicit name (the plain `role:token` form) gets the role string as
   *  its name. */
  names: Map<string, string>;
}

/** A presented token resolved to who it belongs to. Returned by
 *  `resolveIdentity`; forwarded by middleware.ts as the `x-portico-role` /
 *  `x-portico-user` request headers, which components/shell.tsx's signed-in
 *  block reads (via app/layout.tsx). */
export interface Identity {
  role: Role;
  name: string;
}

export interface DecideResult {
  allow: boolean;
  /** Set when `allow` is false and the request path is under /api/. */
  status?: 401 | 403;
  /** Set when `allow` is false and the request is a page navigation. */
  redirect?: string;
}

const ROLES: readonly Role[] = ["viewer", "operator", "admin"];
const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };
const MIN_TOKEN_LENGTH = 8;

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * Parse `PORTICO_RBAC_TOKENS` — comma-separated entries, each either
 * `role:token` (e.g. `admin:tok_a1`) or `role:name:token` (e.g.
 * `operator:ravi:tok_o1`) to also give that entry a display name. A role
 * may repeat for multiple tokens. Malformed entries (no colon), unknown
 * roles, and tokens shorter than 8 characters are dropped with a warning to
 * stderr; the rest of the list still loads.
 */
export function parseTokens(env: string | undefined | null): RbacConfig {
  const raw = (env ?? "").trim();
  if (!raw) return { enabled: false, tokens: new Map(), names: new Map() };

  const tokens = new Map<string, Role>();
  const names = new Map<string, string>();
  for (const rawEntry of raw.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    // Two shapes share this list: "role:token" (name defaults to the role)
    // and "role:name:token" (explicit display name). Both are split on ":"
    // — 2 parts is the legacy shape, 3+ parts takes the first part as the
    // role, the LAST part as the token, and joins whatever's in between
    // back together as the name (so a name containing a stray ":" still
    // parses instead of silently truncating).
    const parts = entry.split(":").map((p) => p.trim());
    if (parts.length < 2) {
      console.warn(`[portico-rbac] ignoring malformed PORTICO_RBAC_TOKENS entry (expected "role:token" or "role:name:token"): "${entry}"`);
      continue;
    }

    const role = parts[0];
    const token = parts[parts.length - 1];
    const name = parts.length === 2 ? role : parts.slice(1, -1).join(":").trim() || role;

    if (!isRole(role)) {
      console.warn(`[portico-rbac] ignoring PORTICO_RBAC_TOKENS entry with unknown role "${role}" (expected viewer, operator, or admin)`);
      continue;
    }
    if (token.length < MIN_TOKEN_LENGTH) {
      console.warn(`[portico-rbac] ignoring ${role} token in PORTICO_RBAC_TOKENS: shorter than ${MIN_TOKEN_LENGTH} characters`);
      continue;
    }

    tokens.set(token, role);
    names.set(token, name);
  }

  return { enabled: true, tokens, names };
}

/**
 * Pull the presented token out of a request: `Authorization: Bearer <tok>`
 * takes priority, falling back to the `portico_token` cookie value.
 */
export function extractToken(input: { authorization?: string | null; cookie?: string | null }): string | null {
  const auth = input.authorization?.trim();
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (match) {
      const bearer = match[1].trim();
      if (bearer) return bearer;
    }
  }
  const cookie = input.cookie?.trim();
  return cookie || null;
}

/**
 * Resolve a presented token (already pulled out by `extractToken`) to the
 * {role, name} identity it belongs to, or null if the token is missing or
 * doesn't match any configured entry. Used by middleware.ts to build the
 * x-portico-role / x-portico-user identity-passthrough headers.
 */
export function resolveIdentity(token: string | null, config: RbacConfig): Identity | null {
  if (!token) return null;
  const role = config.tokens.get(token);
  if (!role) return null;
  return { role, name: config.names.get(token) ?? role };
}

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.replace(/\/+$/, "") || "/";
  return path;
}

/** Reachable with no token, RBAC on or off: the login page itself, the
 *  session login/logout/status API routes (a signed-out visitor has nothing
 *  else to authenticate a request to them WITH), the one-time bootstrap
 *  route (guards itself — see app/api/members/bootstrap/route.ts), and
 *  framework/static assets a page (including /login) needs to render. */
function isAlwaysAllowedPath(path: string): boolean {
  return (
    path === "/login" ||
    path === "/api/auth/login" ||
    path === "/api/auth/logout" ||
    // Middleware's own probe for "should enforcement be on" (DB members
    // exist?) — see middleware.ts dbMembersEnabled. Reports only a boolean,
    // never member details, so leaving it reachable pre-login is safe (see
    // app/api/auth/status/route.ts) and is in fact the whole point: it has
    // to answer BEFORE we know whether to require a login at all.
    path === "/api/auth/status" ||
    // Creates the FIRST admin member — by definition there is no admin yet
    // to gate this behind. The route is its own guard: it re-checks the
    // member count itself before minting anything (see
    // app/api/members/bootstrap/route.ts) rather than relying on middleware
    // to only reach here when count===0.
    path === "/api/members/bootstrap" ||
    path.startsWith("/_next/") ||
    path === "/favicon.ico" ||
    path.startsWith("/brand/") // public/brand/* — logo & favicon files the Shell renders on every page
  );
}

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/**
 * No literal /api/settings route exists in this app — /api/config is what
 * app/settings/page.tsx posts to (global LLM provider/model/API key), so
 * it's treated as the settings-equivalent route. Admin-only on every
 * method, not just writes, since it's the one route that speaks to
 * secret configuration.
 */
function isSettingsApiRoute(path: string): boolean {
  return path === "/api/config" || path.startsWith("/api/config/");
}

function isConnectorsApiRoute(path: string): boolean {
  return path === "/api/connectors" || path.startsWith("/api/connectors/");
}

/**
 * DELETE /api/flows/[id] — apps/console/app/api/flows/[id]/route.ts. There
 * is no separate .../delete path; the DELETE method on the flow-by-id
 * route IS the delete action (deletes one version, or every version of
 * its key when the body carries allVersions: true).
 */
function isFlowDeleteRoute(path: string, method: string): boolean {
  return method === "DELETE" && /^\/api\/flows\/[^/]+$/.test(path);
}

/**
 * app/members/page.tsx — DB-backed member management (add/disable/enable;
 * see components/members-manager.tsx). Admin-only on every method, same
 * reasoning as the settings route: it's the one page that can mint a new
 * bearer token or lock out an existing member.
 */
function isMembersPage(path: string): boolean {
  return path === "/members" || path.startsWith("/members/");
}

/**
 * The mutating members API — app/api/members/route.ts (add),
 * app/api/members/[id]/disable|enable/route.ts. Admin-only on every method,
 * same reasoning as isMembersPage. Deliberately EXCLUDES
 * /api/members/bootstrap (see isAlwaysAllowedPath above) — that route exists
 * precisely for when there is no admin yet, so it can't require one; it
 * guards itself instead.
 */
function isMembersApiRoute(path: string): boolean {
  return (path === "/api/members" || path.startsWith("/api/members/")) && !path.startsWith("/api/members/bootstrap");
}

/** Minimum role required to perform `method` on `path`. Exported for
 *  direct unit testing of the admin-only classification. */
export function requiredRole(path: string, rawMethod: string): Role {
  const method = rawMethod.toUpperCase();
  const isRead = method === "GET" || method === "HEAD";

  if (isSettingsApiRoute(path)) return "admin";
  if (isFlowDeleteRoute(path, method)) return "admin";
  if (isConnectorsApiRoute(path) && !isRead) return "admin";
  if (isMembersPage(path)) return "admin";
  if (isMembersApiRoute(path)) return "admin";
  return isRead ? "viewer" : "operator";
}

/**
 * The single RBAC decision point. `path` should be a pathname (origin and
 * query string irrelevant); `token` is whatever `extractToken` resolved
 * (or null). Off mode (`config.enabled === false`) and always-allowed
 * paths (`/login`, `_next/*`, favicon, `/brand/*`) short-circuit to
 * `allow: true` before any token is even looked at.
 */
export function decide(input: { path: string; method: string; token: string | null; config: RbacConfig }): DecideResult {
  const path = normalizePath(input.path);

  if (isAlwaysAllowedPath(path)) return { allow: true };
  if (!input.config.enabled) return { allow: true };

  const api = isApiPath(path);
  const role = input.token ? input.config.tokens.get(input.token) : undefined;

  if (!role) {
    // No token, or a token that doesn't match any configured entry — same
    // treatment either way: nothing to authenticate against.
    return api ? { allow: false, status: 401 } : { allow: false, redirect: "/login" };
  }

  const required = requiredRole(path, input.method);
  if (ROLE_RANK[role] < ROLE_RANK[required]) {
    if (api) return { allow: false, status: 403 };
    // A valid, recognized token — just not one with enough rank for this
    // page (currently only /members). Redirecting to /login would be a
    // dead end (they'd re-present the same token and bounce right back);
    // send them home instead. See the module doc comment.
    return { allow: false, redirect: "/" };
  }

  return { allow: true };
}
