import { NextResponse } from "next/server";
import { runCli } from "@/lib/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Create a new LLM-refined draft version of the flow. Returns the new version's
// { id, key, version, source, steps } on success, or { error } (e.g. no model
// configured) which the client surfaces inline.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ok, json } = await runCli(["refine", id, "--json"]);
  return NextResponse.json(json ?? { error: "No response from CLI" }, { status: ok ? 200 : 400 });
}
