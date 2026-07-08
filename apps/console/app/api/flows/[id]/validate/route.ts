import { NextResponse } from "next/server";
import { runCli } from "@/lib/actions";
import { readSessions } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Validate a draft against a live browser session. We pick the first ACTIVE
// session's CDP endpoint; if none exists (or it has no endpoint) we return a
// clear error the UI shows instead of spawning a doomed validation.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const session = readSessions().find((s) => s.status === "active" && s.cdpEndpoint);
  if (!session?.cdpEndpoint) {
    return NextResponse.json(
      { error: "Start a browser session first — no active session with a CDP endpoint." },
      { status: 400 },
    );
  }

  const { ok, json } = await runCli(["validate", id, "--cdp", session.cdpEndpoint, "--json"]);
  return NextResponse.json(json ?? { error: "No response from CLI" }, { status: ok ? 200 : 400 });
}
