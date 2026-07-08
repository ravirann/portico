import { NextResponse } from "next/server";
import { runCli } from "@/lib/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ConfigSet {
  scope: string;
  category: "llm" | "variable";
  key: string;
  value: string;
  secret?: boolean;
}

/**
 * Apply a batch of scoped config entries via config-set. Used by the global LLM
 * settings form. Entries with a blank value are skipped so the "leave blank to
 * keep existing secret" UX never clobbers a stored key with an empty string.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { entries?: ConfigSet[] };
  const entries = Array.isArray(body.entries) ? body.entries : [];

  for (const e of entries) {
    if (!e?.scope || !e?.category || !e?.key) {
      return NextResponse.json({ error: "Each entry needs scope, category and key." }, { status: 400 });
    }
    if (!e.value?.trim()) continue; // blank = keep existing
    const args = ["config-set", "--scope", e.scope, "--category", e.category, "--key", e.key, "--value", e.value];
    if (e.secret) args.push("--secret");
    args.push("--json");
    const r = await runCli(args);
    if (!r.ok) {
      return NextResponse.json(r.json ?? { error: `Failed to set ${e.scope}/${e.key}` }, { status: 400 });
    }
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
