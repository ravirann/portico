import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { pickLiveSession } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPO_ROOT = resolve(process.cwd(), "../..");
const AUTHOR_SCRIPT = resolve(REPO_ROOT, "packages/author/author-cli.mjs");

/**
 * Spawn the standalone author script (which carries the heavy Stagehand deps),
 * capturing the single JSON line it prints on stdout. Kept separate from
 * lib/actions runCli because it targets a different entry and needs a long
 * timeout (the agent drives a real portal).
 */
function runAuthor(args: string[], timeoutMs = 300000): Promise<{ ok: boolean; json: Record<string, unknown> | null }> {
  return new Promise((res) => {
    const child = spawn("node", ["--import", "tsx", AUTHOR_SCRIPT, ...args], { cwd: REPO_ROOT, env: process.env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill();
      res({ ok: false, json: { error: "Authoring timed out" } });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
      let json: Record<string, unknown> | null = null;
      try {
        json = line.startsWith("{") ? JSON.parse(line) : null;
      } catch {
        json = null;
      }
      res({ ok: code === 0 && !(json && "error" in json), json });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      res({ ok: false, json: { error: e.message } });
    });
  });
}

interface AuthorBody {
  goal?: string;
  startUrl?: string;
  connector?: string;
  key?: string;
}

/**
 * Agent-author a draft flow: an LLM agent drives `goal` on the connector's live
 * CDP session once, and the run is frozen into a deterministic draft (CLI
 * `author` → @portico/author). Returns { draftId, key, version, ... } on
 * success. Long-running (the agent drives a real portal) — up to 5 minutes.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as AuthorBody;
  const goal = body.goal?.trim();
  const startUrl = body.startUrl?.trim();
  if (!goal || !startUrl) {
    return NextResponse.json({ error: "A goal and a start URL are required." }, { status: 400 });
  }

  const picked = await pickLiveSession(body.connector);
  if ("error" in picked) {
    return NextResponse.json({ error: picked.error }, { status: 400 });
  }

  const args = ["--goal", goal, "--start-url", startUrl, "--cdp", picked.cdpEndpoint];
  if (body.key?.trim()) args.push("--key", body.key.trim());
  if (body.connector) args.push("--connector", body.connector);

  const { ok, json } = await runAuthor(args);
  return NextResponse.json(json ?? { error: "No response from the author process" }, { status: ok ? 200 : 400 });
}
