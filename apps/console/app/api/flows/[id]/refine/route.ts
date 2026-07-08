import { NextResponse } from "next/server";
import { runCli } from "@/lib/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Create a new LLM-refined draft version of the flow. Returns the new version's
// { id, key, version, source, steps } on success, or { error } (e.g. no model
// configured) which the client surfaces inline. An optional { goal } in the
// body (the author's one-line statement of what the flow is for) sharpens the
// refiner's noise-vs-real-step judgement.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { goal?: string };
  const args = ["refine", id];
  if (body.goal?.trim()) args.push("--goal", body.goal.trim());
  args.push("--json");
  const { ok, json } = await runCli(args);
  return NextResponse.json(json ?? { error: "No response from CLI" }, { status: ok ? 200 : 400 });
}
