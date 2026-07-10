import { NextResponse, type NextRequest } from "next/server";
import { decide, extractToken, parseTokens } from "@/lib/rbac";

// Parsed once at module scope (cold start), not per request — see
// lib/rbac.ts for the parsing/decision rules and docs/DEPLOY.md for the
// user-facing "RBAC (optional)" writeup.
const RBAC = parseTokens(process.env.PORTICO_RBAC_TOKENS);

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

  if (result.allow) return NextResponse.next();

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

export const config = {
  // Skip Next's own static asset machinery — everything else (all pages and
  // all /api routes, including /login) goes through `middleware`, which
  // then applies its own always-allowed check for /login, /_next/*,
  // favicon.ico, and /brand/* (see lib/rbac.ts isAlwaysAllowedPath).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
