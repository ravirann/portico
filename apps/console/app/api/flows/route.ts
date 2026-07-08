import { NextResponse } from "next/server";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@/lib/actions";
import { readFlows } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateFlowBody {
  key?: string;
  yaml?: string;
  connector?: string;
}

// Must start AND end alphanumeric; hyphens/underscores allowed inside. Keep in
// sync with the client-side KEY_RE in components/new-flow-editor.tsx.
const KEY_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

/**
 * Create a brand-new flow as version 1 of a fresh draft. Distinct from
 * /api/flows/[id]/save (which adds a version to an *existing* key): here a key
 * collision is a mistake — it would silently version an unrelated flow — so we
 * reject it and point the user at the existing flow instead. The YAML is written
 * to a temp file and persisted through the CLI's save-flow (which re-validates
 * it and owns native SQLite), so the draft lands version-controlled in the DB.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as CreateFlowBody;
  const key = body.key?.trim();
  if (!key) return NextResponse.json({ error: "A flow key is required." }, { status: 400 });
  if (!KEY_RE.test(key)) {
    return NextResponse.json(
      { error: "Key must be lowercase letters, numbers, hyphens or underscores, and start and end with a letter or number (e.g. book-appointment)." },
      { status: 400 },
    );
  }
  if (typeof body.yaml !== "string" || !body.yaml.trim()) {
    return NextResponse.json({ error: "Flow YAML is required." }, { status: 400 });
  }

  // A new flow's key must be unique — otherwise creating it would append a
  // version to a different flow that happens to share the name.
  if (readFlows().some((f) => f.key === key)) {
    return NextResponse.json(
      { error: `A flow named "${key}" already exists. Open it to add a new version instead.` },
      { status: 409 },
    );
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
