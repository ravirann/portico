import { NextResponse } from "next/server";
import { runCli } from "@/lib/actions";
import { readFlow } from "@/lib/store";
import { pickLiveSession } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Validate a draft against a live browser session. The session is picked
// connector-aware (the flow's connector first, then unscoped, then any active)
// and each candidate's CDP endpoint is probed — a stale "active" row would
// otherwise doom the validation before it starts. If none answers we return a
// clear error the UI shows instead of spawning a doomed validation.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const flow = readFlow(id);
  if (!flow) {
    return NextResponse.json({ error: `No flow with id "${id}".` }, { status: 404 });
  }

  const picked = await pickLiveSession(flow.connector);
  if ("error" in picked) {
    return NextResponse.json({ error: picked.error }, { status: 400 });
  }

  const { ok, json } = await runCli(["validate", id, "--cdp", picked.cdpEndpoint, "--json"]);
  const body = json ?? { error: "No response from CLI" };
  return NextResponse.json({ ...body, sessionId: picked.session.id }, { status: ok ? 200 : 400 });
}
