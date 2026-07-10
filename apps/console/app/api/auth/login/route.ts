import { NextResponse } from "next/server";
import { parseTokens, resolveIdentity } from "@/lib/rbac";
import { signSession, sessionSecret, SESSION_COOKIE_NAME, type SessionPayload } from "@/lib/session";
import { authCheck } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTL_HOURS = Number(process.env.PORTICO_SESSION_TTL_HOURS) || 12;

/**
 * Sign in with a bearer token — either an env static token
 * (PORTICO_RBAC_TOKENS, checked first: no subprocess) or a DB member token
 * (verified via the CLI's auth-check; raw token travels in an env var, never
 * argv). On success mints the signed `portico_session` cookie (httpOnly —
 * unlike the legacy client-set portico_token cookie, scripts can't read it
 * out of document.cookie). Always-allowed in middleware: a signed-out
 * visitor has nothing else to authenticate this request WITH.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { token?: string };
  const token = (body.token ?? "").trim();
  if (!token) return NextResponse.json({ error: "A token is required." }, { status: 400 });

  // Resolution order: env static tokens, then DB members.
  const env = parseTokens(process.env.PORTICO_RBAC_TOKENS);
  const envIdentity = env.enabled ? resolveIdentity(token, env) : null;
  let payload: Omit<SessionPayload, "iat" | "exp"> | null = null;
  if (envIdentity) {
    payload = { id: `env:${envIdentity.role}:${envIdentity.name}`, name: envIdentity.name, role: envIdentity.role };
  } else {
    const db = authCheck(token);
    if (db.ok && db.member) payload = { id: db.member.id, name: db.member.name, role: db.member.role };
  }
  if (!payload) return NextResponse.json({ error: "That token didn't match any member or configured static token." }, { status: 401 });

  const secret = sessionSecret(process.env);
  if (!secret) {
    return NextResponse.json(
      { error: "Sign-in sessions aren't configured: set PORTICO_AUTH_SECRET (or PORTICO_ENCRYPTION_KEY) and restart the console." },
      { status: 500 },
    );
  }

  const iat = Math.floor(Date.now() / 1000);
  const cookie = await signSession({ ...payload, iat, exp: iat + TTL_HOURS * 3600 }, secret);
  const res = NextResponse.json({ name: payload.name, role: payload.role });
  res.cookies.set(SESSION_COOKIE_NAME, cookie, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: TTL_HOURS * 3600,
  });
  return res;
}
