import { NextResponse } from "next/server";
import { runCli } from "@/lib/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface StartBody {
  tenant?: string;
  profile?: string;
  baseUrl?: string;
  port?: string | number;
}

/**
 * Launch a local browser session on THIS machine. Returns { id, pid,
 * cdpEndpoint } on success. This opens a real browser window on the host — the
 * console is self-hosted, so the session runs where the console runs.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as StartBody;
  const args = ["session-start"];
  if (body.tenant?.toString().trim()) args.push("--tenant", body.tenant.toString().trim());
  if (body.profile?.toString().trim()) args.push("--profile", body.profile.toString().trim());
  if (body.baseUrl?.toString().trim()) args.push("--base-url", body.baseUrl.toString().trim());
  if (body.port?.toString().trim()) args.push("--port", body.port.toString().trim());
  args.push("--json");

  const { ok, json } = await runCli(args);
  return NextResponse.json(json ?? { error: "No response from CLI" }, { status: ok ? 200 : 400 });
}
