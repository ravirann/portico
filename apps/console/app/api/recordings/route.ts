import { NextResponse } from "next/server";
import { runCli } from "@/lib/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List recordings, optionally scoped to one browser session via ?session=<id>.
 * The record wizard uses this on mount to detect an in-progress capture on the
 * selected session and resume it (otherwise navigating away from the wizard
 * would orphan the recorder forever).
 */
export async function GET(req: Request) {
  const session = new URL(req.url).searchParams.get("session")?.trim();
  const args = ["list-recordings"];
  if (session) args.push("--session", session);
  args.push("--json");

  const { ok, json } = await runCli(args);
  if (!ok) return NextResponse.json(json ?? { error: "No response from CLI" }, { status: 400 });
  return NextResponse.json({ recordings: Array.isArray(json) ? json : [] });
}
