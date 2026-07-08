import { NextResponse } from "next/server";
import { runCli } from "@/lib/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live status of a capture: the recording's store row plus counts read from the
 * recorder's incrementally-flushed recording.json — { attached, liveClicks,
 * liveRequests }. The record wizard polls this while the user demonstrates so
 * the UI can show that clicks/requests are actually being captured (and warn
 * when the recorder never attached).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ok, json } = await runCli(["get-recording", id, "--json"]);
  return NextResponse.json(json ?? { error: "No response from CLI" }, { status: ok ? 200 : 404 });
}
