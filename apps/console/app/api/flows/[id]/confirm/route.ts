import { NextResponse } from "next/server";
import { runCli } from "@/lib/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Confirm the latest validated draft for live execution. Succeeds with
// { confirmed: true }; if the latest validation didn't pass the CLI exits
// non-zero with { confirmed: false, error } which the client shows inline.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ok, json } = await runCli(["confirm", id, "--json"]);
  return NextResponse.json(json ?? { confirmed: false, error: "No response from CLI" }, {
    status: ok ? 200 : 400,
  });
}
