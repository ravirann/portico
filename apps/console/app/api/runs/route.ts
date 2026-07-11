import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCli } from "@/lib/actions";
import { listRuns, readFlow, readConnector } from "@/lib/store";
import { pickLiveSession } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPO_ROOT = resolve(process.cwd(), "../..");

export async function GET() {
  return NextResponse.json(listRuns());
}

interface RunBody {
  /** Stored-flow mode: run a CONFIRMED flow from the store in a live session. */
  flowId?: string;
  inputs?: Record<string, string>;
  live?: boolean;
  /** Legacy smoke mode: run a flow FILE in a fresh headless browser. */
  flow?: string;
  baseUrl?: string;
}

// Trigger a live run. The engine runs in the CLI subprocess (Playwright's native
// deps stay out of the Next bundle); the CLI persists the run to the shared
// store and returns its id, which we relay so the client can open the run.
//
// Two modes: { flowId } runs a stored CONFIRMED flow against a live browser
// session (picked connector-aware, endpoint probed); { flow?, baseUrl? } keeps
// the original smoke behavior — a flow file in a fresh headless browser.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as RunBody;

  if (typeof body.flowId === "string" && body.flowId) {
    return runStoredFlow(body.flowId, body.inputs ?? {}, Boolean(body.live));
  }

  const flow: string = body.flow ?? "examples/smoke.flow.yaml";
  const baseUrl: string = body.baseUrl ?? "https://example.com";
  try {
    const parsed = JSON.parse(await runSmokeCli(flow, baseUrl));
    return NextResponse.json({ id: parsed.id, status: parsed.status });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

/**
 * Run a stored flow by id: only CONFIRMED flows qualify (the validate/confirm
 * gate is the whole point of the draft pipeline). The YAML is written to a temp
 * file for the CLI (same idiom as flows/[id]/save) and executed against the
 * picked session's CDP endpoint; dry-run unless the caller asked for live.
 */
async function runStoredFlow(flowId: string, inputs: Record<string, string>, live: boolean) {
  const flow = readFlow(flowId);
  if (!flow) {
    return NextResponse.json({ error: `No flow with id "${flowId}".` }, { status: 404 });
  }
  if (flow.status !== "confirmed") {
    return NextResponse.json(
      { error: "Only confirmed flows can be run — validate and confirm the draft first." },
      { status: 400 },
    );
  }

  const picked = await pickLiveSession(flow.connector);
  if ("error" in picked) {
    return NextResponse.json({ error: picked.error }, { status: 400 });
  }

  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "portico-run-"));
    const file = join(dir, `${flow.key}.flow.yaml`);
    await writeFile(file, flow.yaml, "utf8");

    const args = ["run", file, "--cdp", picked.cdpEndpoint, "--json"];
    if (flow.connector) args.push("--connector", flow.connector);
    // Reliability defaults from the connector record: the CLI would derive
    // these itself from --connector, but passing them explicitly here means
    // the run's SectorProfile + egress boundary are visible right in the
    // spawned command line, not just inferred several layers down.
    const connector = flow.connector ? readConnector(flow.connector) : undefined;
    if (connector?.sector) args.push("--sector", connector.sector);
    if (connector?.baseUrl) {
      try {
        const host = new URL(connector.baseUrl).host;
        if (host) args.push("--allowed-domains", host);
      } catch {
        /* malformed baseUrl — skip the egress hint, the CLI still derives its own */
      }
    }
    if (live) args.push("--live");
    for (const [k, v] of Object.entries(inputs)) args.push("--input", `${k}=${v}`);

    // Runs drive a real portal and can take a while — allow up to 3 minutes.
    const { ok, json } = await runCli(args, 180000);
    const payload = json ?? { error: "No response from CLI" };
    return NextResponse.json({ ...payload, sessionId: picked.session.id }, { status: ok ? 200 : 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runSmokeCli(flow: string, baseUrl: string): Promise<string> {
  return new Promise((res, rej) => {
    const cli = resolve(REPO_ROOT, "apps/cli/src/index.ts");
    const child = spawn(
      "node",
      ["--import", "tsx", cli, "run", flow, "--base-url", baseUrl, "--headless", "--json"],
      { cwd: REPO_ROOT, env: process.env },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => { child.kill(); rej(new Error("run timed out")); }, 90000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const jsonLine = out.trim().split("\n").filter(Boolean).pop() ?? "";
      if (!jsonLine.startsWith("{")) return rej(new Error(err.trim() || `cli exited ${code}`));
      res(jsonLine);
    });
    child.on("error", rej);
  });
}
