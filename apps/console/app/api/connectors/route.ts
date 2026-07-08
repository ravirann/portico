import { NextResponse } from "next/server";
import { runCli } from "@/lib/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SaveConnectorBody {
  key?: string;
  name?: string;
  framework?: string;
  baseUrl?: string;
  auth?: string;
  llm?: { provider?: string; model?: string; apiKey?: string };
}

/**
 * Create/update a DB-backed connector. Saves the connector record plus any
 * per-connector LLM override via scoped config-set calls (scope = the connector
 * key). Connector variables are managed separately, per environment, through
 * /api/connectors/variables (scope = `<key>:<env>`). Runs the calls in sequence
 * and fails loud on the first CLI error so the client never reports a partial
 * save as success.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as SaveConnectorBody;
  const key = body.key?.trim();
  const name = body.name?.trim();
  if (!key || !name) {
    return NextResponse.json({ error: "Both key and name are required." }, { status: 400 });
  }

  const args = ["save-connector", "--key", key, "--name", name];
  if (body.framework?.trim()) args.push("--framework", body.framework.trim());
  if (body.baseUrl?.trim()) args.push("--base-url", body.baseUrl.trim());
  if (body.auth?.trim()) args.push("--auth", body.auth.trim());
  args.push("--json");

  const saved = await runCli(args);
  if (!saved.ok) {
    return NextResponse.json(saved.json ?? { error: saved.stderr || "save-connector failed" }, { status: 400 });
  }

  // Optional per-connector LLM override. Blank api key = keep existing (never overwrite).
  const llm = body.llm;
  if (llm) {
    const entries: Array<[string, string, boolean]> = [];
    if (llm.provider?.trim()) entries.push(["provider", llm.provider.trim(), false]);
    if (llm.model?.trim()) entries.push(["model", llm.model.trim(), false]);
    if (llm.apiKey?.trim()) entries.push(["api_key", llm.apiKey.trim(), true]);
    for (const [k, value, secret] of entries) {
      const cfgArgs = ["config-set", "--scope", key, "--category", "llm", "--key", k, "--value", value];
      if (secret) cfgArgs.push("--secret");
      cfgArgs.push("--json");
      const r = await runCli(cfgArgs);
      if (!r.ok) {
        return NextResponse.json(r.json ?? { error: `Failed to save LLM ${k}` }, { status: 400 });
      }
    }
  }

  return NextResponse.json(saved.json ?? { ok: true }, { status: 200 });
}
