import { NextResponse } from "next/server";
import { setMemberDisabled } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Re-enable a disabled member (admin-only via middleware). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = setMemberDisabled(id, false);
  return ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: `No member with id ${id}.` }, { status: 404 });
}
