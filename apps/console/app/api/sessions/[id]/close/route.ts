import { NextResponse } from "next/server";
import { runCli } from "@/lib/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Close a live browser session. Returns { id, closed: true } on success.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ok, json } = await runCli(["close-session", id, "--json"]);
  return NextResponse.json(json ?? { error: "No response from CLI" }, { status: ok ? 200 : 400 });
}
