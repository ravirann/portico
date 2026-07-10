/**
 * Pure RBAC decision logic for the console — no Next.js imports, so this
 * loads and runs fine under `node --import tsx --test` without a Next
 * runtime (see rbac.test.ts). `middleware.ts` is a thin, Next-aware adapter
 * over `parseTokens` + `extractToken` + `decide`.
 *
 * Design (user-facing version lives in docs/DEPLOY.md, "RBAC (optional)"):
 *  - Off by default. RBAC only turns on when PORTICO_RBAC_TOKENS is a
 *    non-empty string — deliberately independent of whether any individual
 *    entry in it turns out to be valid, so a typo'd token can never
 *    silently reopen the console. When off, every request is allowed,
 *    identical to today's behavior.
 *  - Roles rank viewer < operator < admin. viewer covers every GET/HEAD —
 *    all pages, all read APIs. operator adds mutations except the
 *    admin-only surface below. admin can do everything.
 *  - Admin-only: any method on /api/config (the Settings page's backing
 *    route — there is no literal /api/settings path in this app; see
 *    isSettingsApiRoute), any mutation (non-GET/HEAD) under /api/connectors*,
 *    and DELETE /api/flows/[id] (the flow-delete route).
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
 * Parse `PORTICO_RBAC_TOKENS` — comma-separated `role:token` pairs, e.g.
 * `admin:tok_a1,operator:tok_o1,viewer:tok_v1`. A role may repeat for
 * multiple tokens. Malformed entries (no colon), unknown roles, and tokens
 * shorter than 8 characters are dropped with a warning to stderr; the rest
 * of the list still loads.
 */
export function parseTokens(env: string | undefined | null): RbacConfig {
  const raw = (env ?? "").trim();
  if (!raw) return { enabled: false, tokens: new Map() };

  const tokens = new Map<string, Role>();
  for (const rawEntry of raw.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    const sep = entry.indexOf(":");
    if (sep === -1) {
      console.warn(`[portico-rbac] ignoring malformed PORTICO_RBAC_TOKENS entry (expected "role:token"): "${entry}"`);
      continue;
    }

    const role = entry.slice(0, sep).trim();
    const token = entry.slice(sep + 1).trim();

    if (!isRole(role)) {
      console.warn(`[portico-rbac] ignoring PORTICO_RBAC_TOKENS entry with unknown role "${role}" (expected viewer, operator, or admin)`);
      continue;
    }
    if (token.length < MIN_TOKEN_LENGTH) {
      console.warn(`[portico-rbac] ignoring ${role} token in PORTICO_RBAC_TOKENS: shorter than ${MIN_TOKEN_LENGTH} characters`);
      continue;
    }

    tokens.set(token, role);
  }

  return { enabled: true, tokens };
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

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.replace(/\/+$/, "") || "/";
  return path;
}

/** Reachable with no token, RBAC on or off: the login page itself, and
 *  framework/static assets a page (including /login) needs to render. */
function isAlwaysAllowedPath(path: string): boolean {
  return (
    path === "/login" ||
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

/** Minimum role required to perform `method` on `path`. Exported for
 *  direct unit testing of the admin-only classification. */
export function requiredRole(path: string, rawMethod: string): Role {
  const method = rawMethod.toUpperCase();
  const isRead = method === "GET" || method === "HEAD";

  if (isSettingsApiRoute(path)) return "admin";
  if (isFlowDeleteRoute(path, method)) return "admin";
  if (isConnectorsApiRoute(path) && !isRead) return "admin";
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
    return api ? { allow: false, status: 401 } : { allow: false, redirect: "/login" };
  }

  const required = requiredRole(path, input.method);
  if (ROLE_RANK[role] < ROLE_RANK[required]) {
    return api ? { allow: false, status: 403 } : { allow: false, redirect: "/login" };
  }

  return { allow: true };
}
