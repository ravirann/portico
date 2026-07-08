import { spawn } from "node:child_process";
import { resolve } from "node:path";

/** Shared CLI spawn helper for POST route handlers. Mirrors lib/store.ts's
 *  process resolution (node + tsx + the CLI entry, run from the repo root) but
 *  runs async and surfaces the exit code so routes can map success/failure to
 *  HTTP status. The CLI owns native deps (SQLite/Playwright), keeping them out
 *  of the Next bundle; we only parse the JSON line it prints. */

const REPO_ROOT = resolve(process.cwd(), "../..");
const CLI = resolve(REPO_ROOT, "apps/cli/src/index.ts");

export interface CliResult {
  /** true when the CLI exited 0 and did not return an { error } payload. */
  ok: boolean;
  /** Parsed last JSON line of stdout, or null if none was printed. */
  json: Record<string, unknown> | null;
  code: number | null;
  stderr: string;
}

export function runCli(args: string[], timeoutMs = 90000): Promise<CliResult> {
  return new Promise((res) => {
    const child = spawn("node", ["--import", "tsx", CLI, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill();
      res({ ok: false, json: { error: "CLI command timed out" }, code: null, stderr: err.trim() });
    }, timeoutMs);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
      let json: Record<string, unknown> | null = null;
      try {
        json = line.startsWith("{") || line.startsWith("[") ? JSON.parse(line) : null;
      } catch {
        json = null;
      }
      const ok = code === 0 && !(json && "error" in json);
      res({ ok, json, code, stderr: err.trim() });
    };
    child.on("close", finish);
    child.on("error", (e) => {
      clearTimeout(timer);
      res({ ok: false, json: { error: e.message }, code: null, stderr: err.trim() });
    });
  });
}
