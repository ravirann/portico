import { NextResponse, type NextRequest } from "next/server";
import { decide, extractToken, parseTokens, resolveIdentity, type Identity, type RbacConfig } from "@/lib/rbac";
import { verifySession, sessionSecret, SESSION_COOKIE_NAME } from "@/lib/session";

// Parsed once at module scope (cold start), not per request — see
// lib/rbac.ts for the parsing/decision rules and docs/DEPLOY.md for the
// user-facing "Members & access control" writeup.
const RBAC = parseTokens(process.env.PORTICO_RBAC_TOKENS);
const SECRET = sessionSecret(process.env);

// Identity passthrough headers — read by app/layout.tsx (via next/headers)
// and handed to components/shell.tsx's signed-in block as props. Named here
// so the "set vs delete" logic below only has to say each name once.
const ROLE_HEADER = "x-portico-role";
const USER_HEADER = "x-portico-user";

// The edge runtime can't read SQLite, so "do DB members exist" (the second
// enforcement signal alongside env tokens) is probed from the Node-runtime
// /api/auth/status route and cached here for 10s. On probe failure, reuse
// the last known value; with no known value fail OPEN (a fresh console must
// never lock its operator out because the probe hiccuped during boot).
let dbEnabledCache: { value: boolean; at: number } | null = null;
const DB_ENABLED_CACHE_MS = 10_000;

async function dbMembersEnabled(origin: string): Promise<boolean> {
  const now = Date.now();
  if (dbEnabledCache && now - dbEnabledCache.at < DB_ENABLED_CACHE_MS) return dbEnabledCache.value;
  try {
    const res = await fetch(`${origin}/api/auth/status`, { signal: AbortSignal.timeout(3000) });
    const data = (await res.json()) as { enabled?: boolean };
    dbEnabledCache = { value: Boolean(data.enabled), at: now };
  } catch {
    console.warn("[portico-rbac] /api/auth/status probe failed — reusing last known enforcement state");
    dbEnabledCache = { value: dbEnabledCache?.value ?? false, at: now };
  }
  return dbEnabledCache.value;
}

/** A one-identity RbacConfig so a session-authenticated request flows
 *  through the exact same decide() rules as an env token (see lib/rbac.ts
 *  module docs — role ranking, admin-only surface, 401/403/redirect all
 *  shared). The sentinel never leaves this process. */
const SESSION_SENTINEL = "__portico_session__";
function sessionConfig(identity: Identity): RbacConfig {
  return {
    enabled: true,
    tokens: new Map([[SESSION_SENTINEL, identity.role]]),
    names: new Map([[SESSION_SENTINEL, identity.name]]),
  };
}

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;

  // 1) Env static tokens (scripts / CI / docker fallback) — checked first,
  //    no subprocess, exactly the pre-session behavior.
  const staticToken = extractToken({
    authorization: req.headers.get("authorization"),
    cookie: req.cookies.get("portico_token")?.value ?? null,
  });
  const envIdentity = RBAC.enabled ? resolveIdentity(staticToken, RBAC) : null;

  // 2) Signed session cookie (DB members and env logins both mint one).
  let sessionIdentity: Identity | null = null;
  if (!envIdentity && SECRET) {
    const cookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (cookie) {
      const payload = await verifySession(cookie, SECRET);
      if (payload) sessionIdentity = { role: payload.role, name: payload.name };
    }
  }

  // 3) Is enforcement on at all? Env tokens configured, or any DB member
  //    exists. The probe self-guards against recursion: /api/auth/status is
  //    always-allowed in decide() and never probed for itself.
  let result;
  const identity = envIdentity ?? sessionIdentity;
  if (envIdentity) {
    result = decide({ path, method: req.method, token: staticToken, config: RBAC });
  } else if (sessionIdentity) {
    result = decide({ path, method: req.method, token: SESSION_SENTINEL, config: sessionConfig(sessionIdentity) });
  } else {
    const dbOn = path === "/api/auth/status" ? false : await dbMembersEnabled(req.nextUrl.origin);
    const enforced = RBAC.enabled || dbOn;
    // Anonymous request: reuse decide() with an enabled-but-empty config so
    // the always-allowed list, 401-vs-redirect split, and path rules stay in
    // one place (lib/rbac.ts) for every auth source.
    const anonConfig: RbacConfig = enforced
      ? { enabled: true, tokens: new Map(), names: new Map() }
      : { enabled: false, tokens: new Map(), names: new Map() };
    result = decide({ path, method: req.method, token: null, config: anonConfig });
  }

  if (!result.allow) {
    if (result.redirect) {
      const url = req.nextUrl.clone();
      url.pathname = result.redirect;
      url.search = "";
      return NextResponse.redirect(url);
    }

    const status = result.status ?? 401;
    const error =
      status === 403
        ? "Forbidden: your role cannot perform this action."
        : "Unauthorized: sign in at /login, or send Authorization: Bearer <token>.";
    return NextResponse.json({ error }, { status });
  }

  // Identity passthrough. These two headers are ALWAYS rewritten here — set
  // to the real resolved identity when one exists, deleted otherwise — so a
  // client can never inject its own x-portico-role/x-portico-user and spoof
  // a role in the rendered UI.
  const headers = new Headers(req.headers);
  headers.delete(ROLE_HEADER);
  headers.delete(USER_HEADER);
  if (identity) {
    headers.set(ROLE_HEADER, identity.role);
    headers.set(USER_HEADER, identity.name);
  }
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Skip Next's own static asset machinery — everything else (all pages and
  // all /api routes, including /login) goes through `middleware`, which
  // then applies its own always-allowed check for /login, the auth routes,
  // /_next/*, favicon.ico, and /brand/* (see lib/rbac.ts isAlwaysAllowedPath).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
