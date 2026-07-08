import { NextResponse } from "next/server";
import { runCli } from "@/lib/actions";
import { readFlow } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read one flow version (with its latest validation attached by the CLI).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const flow = readFlow(id);
  if (!flow) return NextResponse.json({ error: "Unknown flow." }, { status: 404 });
  return NextResponse.json(flow);
}

// Delete one flow version — or every version of its key when the body carries
// { allVersions: true }. The CLI cascades validations and appends the audit event.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { allVersions?: boolean };
  const args = ["delete-flow", id, ...(body.allVersions ? ["--all-versions"] : []), "--json"];
  const { ok, json } = await runCli(args);
  return NextResponse.json(json ?? { error: "No response from CLI" }, { status: ok ? 200 : 400 });
}
