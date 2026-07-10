import { NextResponse } from "next/server";
import { addMember, readMembers } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create the FIRST admin. Always-allowed in middleware (by definition there
 * is no admin yet to gate it behind) — so this route is its own guard: it
 * re-checks the live member count (readMembers, NOT the 10s-cached
 * countMembersFast) and refuses once any member exists. A same-instant
 * double-submit could theoretically race the check (TOCTOU) — acceptable on
 * a local single-operator console; the store's UNIQUE token hash keeps the
 * rows themselves consistent.
 */
export async function POST(req: Request) {
  if (readMembers().length > 0) {
    return NextResponse.json({ error: "Members already exist — sign in as an admin to add more." }, { status: 409 });
  }
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const name = (body.name ?? "").trim() || "admin";
  const created = addMember(name, "admin");
  if (!created) return NextResponse.json({ error: "Could not create the first admin — see console logs." }, { status: 500 });
  return NextResponse.json(created);
}
