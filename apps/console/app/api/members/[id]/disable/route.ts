import { NextResponse } from "next/server";
import { setMemberDisabled } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Disable a member (admin-only via middleware). Blocks their NEXT login;
 *  an already-minted session stays valid until its exp (revocation lag ≤
 *  session TTL — see lib/session.ts). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = setMemberDisabled(id, true);
  return ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: `No member with id ${id}.` }, { status: 404 });
}
