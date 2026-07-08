import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { listRuns } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPO_ROOT = resolve(process.cwd(), "../..");

export async function GET() {
  return NextResponse.json(listRuns());
}

// Trigger a live run. The engine runs in the CLI subprocess (Playwright's native
// deps stay out of the Next bundle); the CLI persists the run to the shared
// store and returns its id, which we relay so the client can open the run.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const flow: string = body.flow ?? "examples/smoke.flow.yaml";
  const baseUrl: string = body.baseUrl ?? "https://example.com";
  try {
    const parsed = JSON.parse(await runCli(flow, baseUrl));
    return NextResponse.json({ id: parsed.id, status: parsed.status });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

function runCli(flow: string, baseUrl: string): Promise<string> {
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
