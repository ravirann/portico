import { NextResponse } from "next/server";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@/lib/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SaveFlowBody {
  key?: string;
  yaml?: string;
  connector?: string;
}

/**
 * Persist an edited flow YAML. Writes the body to a temp file (the CLI's
 * save-flow reads from --yaml-file, and re-validates the YAML server-side) then
 * returns the new { id, key, version } or the CLI's { error } for invalid YAML.
 * The temp file is always cleaned up.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await params; // route is keyed by flow id, but save-flow keys by flow key
  const body = (await req.json().catch(() => ({}))) as SaveFlowBody;
  const key = body.key?.trim();
  if (!key) return NextResponse.json({ error: "Missing flow key." }, { status: 400 });
  if (typeof body.yaml !== "string" || !body.yaml.trim()) {
    return NextResponse.json({ error: "Missing YAML content." }, { status: 400 });
  }

  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "portico-flow-"));
    const file = join(dir, `${key}.flow.yaml`);
    await writeFile(file, body.yaml, "utf8");

    const args = ["save-flow", "--key", key, "--yaml-file", file];
    if (body.connector?.trim()) args.push("--connector", body.connector.trim());
    args.push("--json");

    const { ok, json } = await runCli(args);
    return NextResponse.json(json ?? { error: "No response from CLI" }, { status: ok ? 200 : 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
