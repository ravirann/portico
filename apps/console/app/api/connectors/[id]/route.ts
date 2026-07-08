import { NextResponse } from "next/server";
import { runCli } from "@/lib/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Delete a DB-backed connector. Returns { id, deleted: true } on success.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ok, json } = await runCli(["delete-connector", id, "--json"]);
  return NextResponse.json(json ?? { error: "No response from CLI" }, { status: ok ? 200 : 400 });
}
