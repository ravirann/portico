import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sign out: expire the session cookie. (The legacy client-set portico_token
 *  cookie is cleared client-side by the sign-out button — it isn't httpOnly,
 *  so the browser can remove it directly.) */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
