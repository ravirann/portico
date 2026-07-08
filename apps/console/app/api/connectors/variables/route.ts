import { NextResponse } from "next/server";
import { runCli } from "@/lib/actions";
import { readConfig } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Build the namespaced config scope for a connector's variables. Variables are
 *  scoped per connector AND environment so the same name never collides across
 *  connectors or between dev/prod. See the naming hint in the editor. */
function scopeFor(connector: string, env: string): string {
  const c = connector.trim();
  const e = (env || "default").trim() || "default";
  return `${c}:${e}`;
}

/**
 * GET /api/connectors/variables?connector=<key>&env=<env>
 * Returns the variables stored for the `<key>:<env>` scope. Secret entries come
 * back from the CLI with an empty `value` (masked); `configured:true` tells the
 * client the secret is set so it can show "configured ✓" without ever exposing it.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const connector = searchParams.get("connector")?.trim();
  const env = searchParams.get("env")?.trim() || "default";
  if (!connector) {
    return NextResponse.json({ error: "connector is required" }, { status: 400 });
  }
  const entries = readConfig({ scope: scopeFor(connector, env), category: "variable" });
  const variables = entries.map((e) => ({
    key: e.key,
    value: e.secret ? "" : e.value,
    secret: e.secret,
    configured: e.secret, // a stored secret is configured but its value is masked
  }));
  return NextResponse.json({ variables }, { status: 200 });
}

interface VarUpsert {
  key: string;
  value: string;
  secret?: boolean;
}
interface SaveVarsBody {
  connector?: string;
  env?: string;
  upserts?: VarUpsert[];
  deletes?: string[];
}

/**
 * POST /api/connectors/variables
 * Applies a batch of variable changes for one `<connector>:<env>` scope:
 *  - upserts run `config-set` (with `--secret` when the row is secret). A blank
 *    value is skipped so "leave blank to keep the existing secret" never clobbers
 *    a stored key with an empty string.
 *  - deletes run `config-delete` for each removed variable name.
 * Fails loud on the first CLI error so the client never reports a partial save.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as SaveVarsBody;
  const connector = body.connector?.trim();
  if (!connector) {
    return NextResponse.json({ error: "connector is required" }, { status: 400 });
  }
  const scope = scopeFor(connector, body.env ?? "default");

  for (const v of body.upserts ?? []) {
    const vk = v.key?.trim();
    if (!vk) continue;
    if (!v.value?.trim()) continue; // blank = keep existing (never clobber a secret)
    const args = ["config-set", "--scope", scope, "--category", "variable", "--key", vk, "--value", v.value];
    if (v.secret) args.push("--secret");
    args.push("--json");
    const r = await runCli(args);
    if (!r.ok) {
      return NextResponse.json(r.json ?? { error: `Failed to save variable "${vk}"` }, { status: 400 });
    }
  }

  for (const key of body.deletes ?? []) {
    const dk = key?.trim();
    if (!dk) continue;
    const r = await runCli(["config-delete", "--scope", scope, "--category", "variable", "--key", dk, "--json"]);
    if (!r.ok) {
      return NextResponse.json(r.json ?? { error: `Failed to delete variable "${dk}"` }, { status: 400 });
    }
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
