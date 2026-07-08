import { NextResponse } from "next/server";
import { runCli } from "@/lib/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface StopBody {
  intercept?: string;
}

/**
 * Stop a capture and compile it into a draft flow. Signals the detached recorder
 * to finalize, waits for it to exit, then the CLI compiles recording.json into a
 * `recorded` draft and returns its { draftId }. `intercept` optionally hints the
 * data endpoint to intercept (e.g. "GetSlots").
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as StopBody;

  const args = ["record-stop", id];
  if (body.intercept?.trim()) args.push("--intercept", body.intercept.trim());
  args.push("--json");

  const { ok, json } = await runCli(args);
  return NextResponse.json(json ?? { error: "No response from CLI" }, { status: ok ? 200 : 400 });
}
