import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { pickLiveSession } from "@/lib/sessions";
import { getAuthorJob } from "@/lib/store";
import { listSectors } from "@portico/flow-spec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPO_ROOT = resolve(process.cwd(), "../..");
const AUTHOR_SCRIPT = resolve(REPO_ROOT, "packages/author/author-cli.mjs");

interface AuthorBody {
  goal?: string;
  startUrl?: string;
  connector?: string;
  key?: string;
  /** Industry/app-class to author for — see @portico/flow-spec's SectorProfile. Optional; validated against listSectors(). */
  sector?: string;
}

/**
 * Start agent-authoring ASYNCHRONOUSLY: spawn the (long-running) author process
 * DETACHED and return a `jobId` immediately. The process writes progress and the
 * final draft/error to the `author_jobs` row (via --job), which the console
 * polls — so the user can leave the page and come back to an in-progress or
 * finished run. GET ?jobId=… returns the current job state.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as AuthorBody;
  const goal = body.goal?.trim();
  const startUrl = body.startUrl?.trim();
  if (!goal || !startUrl) {
    return NextResponse.json({ error: "A goal and a start URL are required." }, { status: 400 });
  }
  const sector = body.sector?.trim();
  const validSectors: string[] = listSectors();
  if (sector && !validSectors.includes(sector)) {
    return NextResponse.json({ error: `Unknown sector "${sector}" — valid keys: ${validSectors.join(", ")}` }, { status: 400 });
  }

  const picked = await pickLiveSession(body.connector);
  if ("error" in picked) {
    return NextResponse.json({ error: picked.error }, { status: 400 });
  }

  const jobId = `ajob_${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
  const args = ["--import", "tsx", AUTHOR_SCRIPT, "--goal", goal, "--start-url", startUrl, "--cdp", picked.cdpEndpoint, "--job", jobId];
  if (body.key?.trim()) args.push("--key", body.key.trim());
  if (body.connector) args.push("--connector", body.connector);
  if (sector) args.push("--sector", sector);

  // Detached + unref'd so it outlives this request: the user can navigate away
  // and the run keeps going, reporting into the author_jobs row.
  const child = spawn("node", args, { cwd: REPO_ROOT, env: process.env, detached: true, stdio: "ignore" });
  child.unref();

  return NextResponse.json({ jobId, key: body.key?.trim() || undefined }, { status: 202 });
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("jobId");
  if (!id) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  const job = getAuthorJob(id);
  // The row appears a beat after the process starts — report "running" until then
  // so the client shows progress instead of an error. `missing: true` lets the
  // client distinguish "just starting" (clears within a poll or two) from a
  // STALE saved id whose row never existed (client gives up after a few tries).
  if (!job) return NextResponse.json({ id, status: "running", progress: "Starting…", missing: true });
  return NextResponse.json(job);
}
