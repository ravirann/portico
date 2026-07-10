import { NextResponse } from "next/server";
import { countMembersFast } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Middleware's probe for "should DB-backed enforcement be on" — the edge
 * runtime can't read SQLite, so it fetches this Node-runtime route (and
 * caches the boolean for 10s; countMembersFast caches its own CLI call for
 * 10s too). Reports ONLY a boolean — never member details — which is why
 * it's safe (and necessary) to leave reachable pre-login: it has to answer
 * BEFORE we know whether to require a login at all. Counts disabled members
 * too: disabling every member must not silently reopen the console.
 */
export async function GET() {
  return NextResponse.json({ enabled: countMembersFast() > 0 });
}
