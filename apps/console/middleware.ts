import { NextResponse, type NextRequest } from "next/server";
import { decide, extractToken, parseTokens, resolveIdentity } from "@/lib/rbac";

// Parsed once at module scope (cold start), not per request — see
// lib/rbac.ts for the parsing/decision rules and docs/DEPLOY.md for the
// user-facing "RBAC (optional)" writeup.
const RBAC = parseTokens(process.env.PORTICO_RBAC_TOKENS);

// Identity passthrough headers — read by app/layout.tsx (via next/headers)
// and handed to components/shell.tsx's signed-in block as props. Named here
// so the "set vs delete" logic below only has to say each name once.
const ROLE_HEADER = "x-portico-role";
const USER_HEADER = "x-portico-user";

export function middleware(req: NextRequest) {
  const token = extractToken({
    authorization: req.headers.get("authorization"),
    cookie: req.cookies.get("portico_token")?.value ?? null,
  });

  const result = decide({
    path: req.nextUrl.pathname,
    method: req.method,
    token,
    config: RBAC,
  });

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
        : "Unauthorized: a valid Portico RBAC token is required (Authorization: Bearer <token> or portico_token cookie).";
    return NextResponse.json({ error }, { status });
  }

  // Identity passthrough. These two headers are ALWAYS rewritten here — set
  // to the real resolved identity when RBAC is on and the presented token
  // resolves to one, deleted otherwise (RBAC off, or an always-allowed path
  // reached with no resolvable token, e.g. an anonymous hit on /login) — so
  // a client can never inject its own x-portico-role/x-portico-user and
  // spoof a role in the rendered UI.
  const identity = RBAC.enabled ? resolveIdentity(token, RBAC) : null;
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
  // then applies its own always-allowed check for /login, /_next/*,
  // favicon.ico, and /brand/* (see lib/rbac.ts isAlwaysAllowedPath).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
