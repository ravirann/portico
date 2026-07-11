#!/usr/bin/env -S node --import tsx
/**
 * portico — minimal CLI to run a flow through the engine.
 *
 *   portico run <flow.yaml> [--base-url URL] [--instance <instance.yaml>]
 *                            [--headless | --headed] [--live] [--profile NAME]
 *                            [--input key=value]...
 *
 * --headless / --headed  forward the browser mode to the engine (default headless).
 * --live                 run in live mode (default dry_run).
 * --profile NAME         Libretto auth profile id — persists login across runs.
 *
 * For the live test: point --instance at connectors/example-portal/
 * instances/urmc.local.yaml and set PORTICO_SECRET_EXAMPLE_* env vars (see @portico/vault).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getEngine, compileRecording, evaluateValidation, refineFlow, resolveHealModel, listSessions, sampleInputsFromFlow, deriveTier } from "@portico/engine";
import type { RunMode, Recording } from "@portico/engine";
import type { Flow, Target } from "@portico/flow-spec";
import { listSectors } from "@portico/flow-spec";
import { defaultSecretProvider, resolveSecrets } from "@portico/vault";
import { Store, hashMemberToken, queueRetryDecision } from "@portico/store";
import type { MemberRole, RunQueueRecord } from "@portico/store";

// Repo root, resolved from this file's own location (not process.cwd()) so a
// `worker` spawning a grandchild `run` process gets a stable cwd regardless of
// where `portico worker` itself was invoked from. apps/cli/src -> apps/cli ->
// apps -> repo root is 3 levels up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.ts");

interface CliOpts {
  baseUrl?: string;
  instance?: string;
  headless: boolean;
  json: boolean;
  live: boolean;
  profile?: string;
  cdp?: string;
  key?: string;
  intercept?: string;
  out?: string;
  connector?: string;
  inputs: Record<string, string>;
  scope?: string;
  category?: string;
  secret: boolean;
  allVersions: boolean;
  csv: boolean;
  value?: string;
  pid?: number;
  name?: string;
  framework?: string;
  auth?: string;
  tenant?: string;
  port?: number;
  limit?: number;
  yamlFile?: string;
  session?: string;
  goal?: string;
  startUrl?: string;
  status?: string;
  concurrency?: number;
  once: boolean;
  role?: string;
  maxAttempts?: number;
  sector?: string;
  allowedDomains?: string;
  resumeFrom?: number;
  resumeOutputFile?: string;
}

function parseArgs(argv: string[]) {
  // First arg is the command. The positional (`flowPath`: a flow file/id, recording
  // path, session id, …) is the FIRST NON-FLAG arg after it — so all-flag commands
  // (save-connector, config-set, save-flow) parse correctly instead of eating the
  // first flag as the positional.
  const [cmd, ...rest] = argv;
  let flowPath: string | undefined;
  // Default headless: the engine drives a real browser and most runs are
  // unattended. --headed opts into a visible window (for manual login/HITL).
  const opts: CliOpts = { headless: true, json: false, live: false, secret: false, allVersions: false, csv: false, once: false, inputs: {} };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--headless") opts.headless = true;
    else if (a === "--headed") opts.headless = false;
    else if (a === "--live") opts.live = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--secret") opts.secret = true;
    else if (a === "--all-versions") opts.allVersions = true;
    else if (a === "--csv") opts.csv = true;
    else if (a === "--base-url") opts.baseUrl = rest[++i];
    else if (a === "--instance") opts.instance = rest[++i];
    else if (a === "--profile") opts.profile = rest[++i];
    else if (a === "--cdp") opts.cdp = rest[++i];
    else if (a === "--key") opts.key = rest[++i];
    else if (a === "--intercept") opts.intercept = rest[++i];
    else if (a === "--out") opts.out = rest[++i];
    else if (a === "--connector") opts.connector = rest[++i];
    else if (a === "--scope") opts.scope = rest[++i];
    else if (a === "--category") opts.category = rest[++i];
    else if (a === "--value") opts.value = rest[++i];
    else if (a === "--pid") opts.pid = Number(rest[++i]);
    else if (a === "--name") opts.name = rest[++i];
    else if (a === "--framework") opts.framework = rest[++i];
    else if (a === "--auth") opts.auth = rest[++i];
    else if (a === "--tenant") opts.tenant = rest[++i];
    else if (a === "--port") opts.port = Number(rest[++i]);
    else if (a === "--limit") opts.limit = Number(rest[++i]);
    else if (a === "--yaml-file") opts.yamlFile = rest[++i];
    else if (a === "--session") opts.session = rest[++i];
    else if (a === "--goal") opts.goal = rest[++i];
    else if (a === "--start-url") opts.startUrl = rest[++i];
    else if (a === "--status") opts.status = rest[++i];
    else if (a === "--concurrency") opts.concurrency = Number(rest[++i]);
    else if (a === "--once") opts.once = true;
    else if (a === "--role") opts.role = rest[++i];
    else if (a === "--max-attempts") opts.maxAttempts = Number(rest[++i]);
    else if (a === "--sector") opts.sector = rest[++i];
    else if (a === "--allowed-domains") opts.allowedDomains = rest[++i];
    else if (a === "--resume-from") opts.resumeFrom = Number(rest[++i]);
    else if (a === "--resume-output") opts.resumeOutputFile = rest[++i];
    else if (a === "--input") {
      const [k, ...v] = (rest[++i] ?? "").split("=");
      if (k) opts.inputs[k] = v.join("=");
    } else if (!a.startsWith("--") && flowPath === undefined) {
      flowPath = a; // first positional (flow file/id, recording path, session id)
    }
  }
  return { cmd, flowPath, opts };
}

/** Write a JSON payload to stdout and exit only after the pipe has flushed.
 *  process.exit() right after write() truncates payloads bigger than the pipe
 *  buffer (list-runs with embedded outputs is ~1MB) — the console then fails
 *  to parse and silently renders empty lists. Call sites MUST `return emit(x)`
 *  so main() falls through to nothing while the flush callback fires the exit. */
function emit(value: unknown, code = 0): void {
  process.stdout.write(JSON.stringify(value), () => process.exit(code));
}

/**
 * A currently-free localhost TCP port. Each browser session gets its own CDP
 * endpoint this way, instead of every session colliding on a hardcoded 9222 —
 * that collision let `pickLiveSession` attach authoring/runs to the wrong (or
 * wrong-portal) browser. The picked port is passed down to serve-browser so the
 * CLI's session row and the launcher agree on the endpoint.
 */
function findFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

/** Normalize a profile name to the on-disk userDataDir key, matching
 *  serve-browser.mjs exactly, so store rows and the launcher agree. */
function normalizeProfile(p: string | undefined): string {
  return (p ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

/** True when a CDP endpoint answers its version probe (the browser is alive). */
async function isCdpLive(endpoint: string): Promise<boolean> {
  try {
    const r = await fetch(endpoint.replace(/\/+$/, "") + "/json/version", { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  // Load a repo-root .env (credentials/secrets) if present; env vars set
  // directly still work. Node 20.6+/24 ships process.loadEnvFile.
  try {
    (process as unknown as { loadEnvFile?: () => void }).loadEnvFile?.();
  } catch {
    /* no .env file — rely on process.env */
  }

  const { cmd, flowPath, opts } = parseArgs(process.argv.slice(2));

  // Read commands — query the durable store as JSON (the console spawns these
  // so native SQLite stays in a plain Node process, out of the Next bundle).
  if (cmd === "list-runs") {
    const store = new Store();
    const runs = store.listRuns(50);
    store.close();
    return emit(runs);
  }
  if (cmd === "get-run") {
    const store = new Store();
    const run = flowPath ? store.getRun(flowPath) : undefined;
    store.close();
    return emit(run ?? null);
  }
  if (cmd === "list-flows") {
    const store = new Store();
    const flows = store.listFlows(100).map((f) => ({ ...f, validation: store.latestValidation(f.id) ?? null }));
    store.close();
    return emit(flows);
  }
  if (cmd === "get-flow") {
    const store = new Store();
    const flow = flowPath ? store.getFlow(flowPath) : undefined;
    const out = flow ? { ...flow, validation: store.latestValidation(flow.id) ?? null } : null;
    store.close();
    return emit(out);
  }
  // Async authoring job status — polled by the console so authoring survives a
  // page reload (the author-cli process writes progress/result to the row).
  if (cmd === "author-job-get") {
    if (!flowPath) { console.error("usage: portico author-job-get <jobId>"); process.exit(2); }
    const store = new Store();
    const job = store.getAuthorJob(flowPath);
    // Bundle the progress timeline so one poll gets both the status and the log.
    const out = job ? { ...job, events: store.listAuthorJobEvents(flowPath) } : null;
    store.close();
    return emit(out);
  }
  if (cmd === "author-jobs") {
    const store = new Store();
    const jobs = store.listAuthorJobs(opts.connector, 20);
    store.close();
    return emit(jobs);
  }
  // Delete a flow version (default) or every version of its key (--all-versions).
  // Validations cascade in the store; the removal is recorded in the audit log.
  if (cmd === "delete-flow") {
    if (!flowPath) { console.error("usage: portico delete-flow <flowId> [--all-versions]"); process.exit(2); }
    const store = new Store();
    const rec = store.getFlow(flowPath);
    if (!rec) {
      store.close();
      const msg = `no flow with id "${flowPath}"`;
      if (opts.json) return emit({ error: msg }, 2);
      console.error(`✗ ${msg}`);
      process.exit(2);
    }
    if (opts.allVersions) {
      const versions = store.deleteFlowKey(rec.key);
      store.appendAudit({
        ts: new Date().toISOString(), actor: "cli", action: "flow.deleted",
        target: rec.key, detail: { versions },
      });
      store.close();
      if (opts.json) return emit({ key: rec.key, versions, deleted: true });
      console.log(`✔ deleted "${rec.key}" — all ${versions} version(s)`);
    } else {
      store.deleteFlow(rec.id);
      store.appendAudit({
        ts: new Date().toISOString(), actor: "cli", action: "flow.deleted",
        target: rec.key, detail: { id: rec.id },
      });
      store.close();
      if (opts.json) return emit({ id: rec.id, key: rec.key, version: rec.version, deleted: true });
      console.log(`✔ deleted "${rec.key}" v${rec.version} (id=${rec.id})`);
    }
    process.exit(0);
  }
  if (cmd === "list-sessions") {
    const store = new Store();
    const sessions = listSessions(store, Date.now());
    store.close();
    return emit(sessions);
  }
  if (cmd === "close-session") {
    if (!flowPath) { console.error("usage: portico close-session <id>"); process.exit(2); }
    const store = new Store();
    store.closeBrowserSession(flowPath, new Date().toISOString());
    store.close();
    if (opts.json) return emit({ id: flowPath, closed: true });
    console.log(`✔ closed session ${flowPath}`);
    process.exit(0);
  }

  // ---- audit (read-only export for operators; audit_events stays append-only) --

  if (cmd === "list-audit") {
    const store = new Store();
    const limit = opts.limit ?? 100;
    const rows = store.listAudit({ limit });
    store.close();

    if (opts.json) return emit(rows);

    if (opts.csv) {
      const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const lines = ["id,ts,actor,action,runId,target,detail"];
      for (const r of rows) {
        lines.push(
          [
            String(r.id),
            r.ts,
            r.actor,
            r.action,
            r.runId ?? "",
            r.target ?? "",
            r.detail ? JSON.stringify(r.detail) : "",
          ]
            .map(esc)
            .join(","),
        );
      }
      console.log(lines.join("\n"));
      process.exit(0);
    }

    // Compact table (default, human-facing).
    if (rows.length === 0) {
      console.log("(no audit events)");
    } else {
      console.log(
        `${"TS".padEnd(24)}  ${"ACTOR".padEnd(10)}  ${"ACTION".padEnd(22)}  ${"RUN".padEnd(12)}  ${"TARGET".padEnd(28)}  DETAIL`,
      );
      for (const r of rows) {
        const detail = r.detail ? JSON.stringify(r.detail) : "";
        console.log(
          `${r.ts.padEnd(24)}  ${r.actor.padEnd(10)}  ${r.action.padEnd(22)}  ${(r.runId ?? "-").padEnd(12)}  ${(r.target ?? "-").slice(0, 28).padEnd(28)}  ${detail.slice(0, 40)}`,
        );
      }
    }
    process.exit(0);
  }

  // ---- run queue (bounded worker concurrency) ----------------------------
  // A durable SQLite-backed queue so `worker` can process flow runs with a
  // bounded number of concurrent children, without a separate broker.
  // `enqueue` stores whatever `run` itself accepts as its positional arg (a
  // flow YAML path) verbatim in `flowId`, so the worker can replay it as-is.

  if (cmd === "enqueue") {
    if (!flowPath) { console.error("usage: portico enqueue <flowId> [--input key=value]... [--max-attempts N] [--json]"); process.exit(2); }
    const store = new Store();
    const id = `q_${Math.random().toString(16).slice(2, 10)}`;
    const inputs = Object.keys(opts.inputs).length ? opts.inputs : undefined;
    const maxAttempts = opts.maxAttempts ?? 2;
    store.enqueueRun({ id, flowId: flowPath, inputs, maxAttempts });
    store.appendAudit({
      ts: new Date().toISOString(), actor: "worker", action: "queue.enqueued",
      target: flowPath, detail: { id, maxAttempts },
    });
    store.close();
    const out = { id, flowId: flowPath, status: "queued" as const, maxAttempts };
    if (opts.json) return emit(out);
    console.log(`✔ enqueued "${flowPath}" as ${id} (status: queued, max-attempts: ${maxAttempts})`);
    process.exit(0);
  }

  if (cmd === "queue") {
    const store = new Store();
    const status = opts.status as "queued" | "running" | "completed" | "failed" | "paused" | undefined;
    const limit = opts.limit ?? 50;
    const rows = store.listQueue({ status, limit });
    store.close();

    if (opts.json) return emit(rows);

    if (rows.length === 0) {
      console.log("(queue empty)");
    } else {
      console.log(
        `${"ID".padEnd(12)}  ${"FLOW".padEnd(24)}  ${"STATUS".padEnd(10)}  ${"ATTEMPTS".padEnd(9)}  ${"NOT_BEFORE".padEnd(24)}  ${"KIND".padEnd(12)}  ${"RUN".padEnd(12)}  ${"ENQUEUED".padEnd(24)}  ERROR`,
      );
      for (const r of rows) {
        const attempts = `${r.attempts}/${r.maxAttempts}`;
        const notBefore = r.notBefore ? new Date(r.notBefore).toISOString() : "-";
        console.log(
          `${r.id.padEnd(12)}  ${r.flowId.slice(0, 24).padEnd(24)}  ${r.status.padEnd(10)}  ${attempts.padEnd(9)}  ${notBefore.padEnd(24)}  ${(r.lastErrorKind ?? "-").padEnd(12)}  ${(r.runId ?? "-").padEnd(12)}  ${r.enqueuedAt.padEnd(24)}  ${(r.error ?? "").slice(0, 40)}`,
        );
      }
    }
    process.exit(0);
  }

  if (cmd === "worker") {
    const concurrency = Math.min(8, Math.max(1, opts.concurrency ?? 2));
    const workerName = `worker_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;
    const store = new Store();
    const log = (...a: unknown[]) => { if (!opts.json) console.log(...a); };
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    // The shape `run --json` prints on stdout (see the `opts.json` branch at
    // the bottom of main()) — `id` there IS the run id (createRun's row id),
    // NOT the queue row id. `status`/`failure.kind` are what drive the retry
    // decision below.
    interface ParsedRunJson {
      id?: string;
      status?: string;
      error?: string;
      failure?: { stepIndex?: number; reason?: string; resumable?: boolean; kind?: string };
    }

    // Best-effort human-readable failure reason, truncated so it fits comfortably
    // in the queue row's TEXT column.
    function describeFailure(parsed: ParsedRunJson | null, stderr: string, code: number | null): string {
      const reason = parsed?.failure?.reason ?? parsed?.error;
      const msg = reason || stderr.trim() || (parsed?.status ? `child reported status "${parsed.status}"` : `child exited with code ${code}`);
      return msg.slice(0, 1000);
    }

    // Spawn `run <flowId> --headless --json` for one claimed row, mirroring the
    // console's runCli spawn pattern (node --import tsx <CLI> ...), parse the
    // child's EngineRunResult JSON off stdout (not just its exit code — a
    // paused HITL run and a real failure both may exit non-zero-ish/ambiguous
    // ways, and only the JSON says which), and record the row's real outcome.
    // Defensive about stdout: a flow run can leak plain log lines ahead of the
    // final JSON payload, so scan backward for the LAST line that parses as
    // JSON rather than trusting the very last line blindly.
    function runQueuedFlow(row: RunQueueRecord): Promise<"completed" | "paused" | "retry" | "failed"> {
      return new Promise((resolveChild) => {
        const args = ["--import", "tsx", CLI_ENTRY, "run", row.flowId, "--headless", "--json"];
        for (const [k, v] of Object.entries(row.inputs ?? {})) args.push("--input", `${k}=${v}`);
        const child = spawn("node", args, { cwd: REPO_ROOT, env: process.env });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));

        let settled = false;
        const finishOnce = (code: number | null, spawnError?: Error) => {
          if (settled) return;
          settled = true;

          let parsed: ParsedRunJson | null = null;
          if (!spawnError) {
            const lines = out.trim().split("\n").filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i--) {
              const line = lines[i]!.trim();
              if (!(line.startsWith("{") || line.startsWith("["))) continue;
              try { parsed = JSON.parse(line); break; } catch { /* keep scanning backward */ }
            }
          }

          // Fallback: stdout wasn't parseable JSON (spawn error, crash, or an
          // unrecognized status) — the exit code alone can't tell us WHY, so
          // record an unknown-kind failure rather than guessing at a retry.
          const status = parsed?.status;
          if (!parsed || (status !== "completed" && status !== "failed" && status !== "paused")) {
            const runId = parsed?.id;
            const error = spawnError ? spawnError.message.slice(0, 1000) : describeFailure(parsed, err, code);
            store.finishQueued(row.id, { status: "failed", runId, error, errorKind: "unknown" });
            store.appendAudit({
              ts: new Date().toISOString(), actor: "worker", action: "queue.failed",
              target: row.flowId, runId, detail: { id: row.id, worker: workerName, error, errorKind: "unknown" },
            });
            log(`✗ ${row.id} (${row.flowId}) → failed: ${error}`);
            resolveChild("failed");
            return;
          }

          const runId = parsed.id;
          const errorKind = parsed.failure?.kind;
          const decision = queueRetryDecision({
            status: status as "completed" | "failed" | "paused",
            errorKind,
            attempts: row.attempts,
            maxAttempts: row.maxAttempts,
          });

          if (decision.action === "finish_completed") {
            store.finishQueued(row.id, { status: "completed", runId });
            store.appendAudit({
              ts: new Date().toISOString(), actor: "worker", action: "queue.completed",
              target: row.flowId, runId, detail: { id: row.id, worker: workerName },
            });
            log(`✔ ${row.id} (${row.flowId}) → completed${runId ? ` (run ${runId})` : ""}`);
            resolveChild("completed");
          } else if (decision.action === "finish_paused") {
            // A HITL pause is NOT a failure — recorded as its own status.
            store.finishQueued(row.id, { status: "paused", runId, errorKind });
            store.appendAudit({
              ts: new Date().toISOString(), actor: "worker", action: "queue.paused",
              target: row.flowId, runId, detail: { id: row.id, worker: workerName },
            });
            log(`⏸ ${row.id} (${row.flowId}) → paused${runId ? ` (run ${runId})` : ""} — needs human input`);
            resolveChild("paused");
          } else if (decision.action === "retry") {
            const error = describeFailure(parsed, err, code);
            store.requeueWithBackoff(row.id, { errorKind: errorKind ?? "unknown", backoffMs: decision.backoffMs ?? 0 });
            store.appendAudit({
              ts: new Date().toISOString(), actor: "worker", action: "queue.retrying",
              target: row.flowId, runId,
              detail: { id: row.id, worker: workerName, error, errorKind, backoffMs: decision.backoffMs, attempt: row.attempts + 1 },
            });
            log(`↻ ${row.id} (${row.flowId}) → retrying in ${Math.round((decision.backoffMs ?? 0) / 1000)}s (attempt ${row.attempts + 1}/${row.maxAttempts}, ${errorKind}): ${error}`);
            resolveChild("retry");
          } else {
            const error = describeFailure(parsed, err, code);
            store.finishQueued(row.id, { status: "failed", runId, error, errorKind });
            store.appendAudit({
              ts: new Date().toISOString(), actor: "worker", action: "queue.failed",
              target: row.flowId, runId, detail: { id: row.id, worker: workerName, error, errorKind },
            });
            log(`✗ ${row.id} (${row.flowId}) → failed: ${error}`);
            resolveChild("failed");
          }
        };

        child.on("close", (code) => finishOnce(code));
        child.on("error", (e) => finishOnce(null, e instanceof Error ? e : new Error(String(e))));
      });
    }

    let claimed = 0, completed = 0, paused = 0, retried = 0, failed = 0;
    const active = new Map<string, Promise<void>>();

    for (;;) {
      // Claim only when a slot is free — never more concurrent children than `concurrency`.
      while (active.size < concurrency) {
        const row = store.claimNextQueued(workerName);
        if (!row) break;
        claimed++;
        log(`▶ claimed ${row.id} (${row.flowId}) [attempt ${row.attempts + 1}/${row.maxAttempts}]`);
        const p = runQueuedFlow(row).then((outcome) => {
          if (outcome === "completed") completed++;
          else if (outcome === "paused") paused++;
          else if (outcome === "retry") retried++;
          else failed++;
          active.delete(row.id);
        });
        active.set(row.id, p);
      }

      if (opts.once) {
        // Testable mode: drain until nothing is queued and nothing is running.
        // A row requeued with backoff isn't due yet, so it won't re-claim
        // within this same drain — that's expected (see `queueRetryDecision`).
        if (active.size === 0) break;
        await Promise.race(active.values());
        continue;
      }
      await sleep(2000);
    }

    store.close();
    const summary = { claimed, completed, paused, retried, failed };
    if (opts.json) return emit(summary);
    console.log(`worker done — claimed ${claimed}, completed ${completed}, paused ${paused}, retried ${retried}, failed ${failed}`);
    process.exit(0);
  }

  // ---- connectors (self-serve connector registry) ------------------------

  if (cmd === "list-connectors") {
    const store = new Store();
    const connectors = store.listConnectors();
    store.close();
    return emit(connectors);
  }
  if (cmd === "get-connector") {
    if (!flowPath) { console.error("usage: portico get-connector <idOrKey>"); process.exit(2); }
    const store = new Store();
    const connector = store.getConnector(flowPath);
    store.close();
    return emit(connector ?? null);
  }
  if (cmd === "save-connector") {
    if (!opts.key || !opts.name) {
      console.error("usage: portico save-connector --key <key> --name <name> [--framework F] [--base-url URL] [--auth AUTH] [--sector KEY]");
      process.exit(2);
    }
    const store = new Store();
    const existing = store.getConnector(opts.key);
    const now = new Date().toISOString();
    const id = existing?.id ?? `conn_${Math.random().toString(16).slice(2, 10)}`;
    const record = {
      id,
      key: opts.key,
      name: opts.name,
      framework: opts.framework ?? existing?.framework,
      baseUrl: opts.baseUrl ?? existing?.baseUrl,
      auth: opts.auth ?? existing?.auth,
      sector: opts.sector ?? existing?.sector,
      variables: existing?.variables,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    store.saveConnector(record);
    store.close();
    return emit(record);
  }
  if (cmd === "delete-connector") {
    if (!flowPath) { console.error("usage: portico delete-connector <id>"); process.exit(2); }
    const store = new Store();
    store.deleteConnector(flowPath);
    store.close();
    return emit({ id: flowPath, deleted: true });
  }

  // ---- app config (LLM settings + connector variables) -------------------

  if (cmd === "config-get") {
    const store = new Store();
    const scope = opts.scope ?? "global";
    const category = opts.category as "llm" | "variable" | undefined;
    // Never hand decrypted secret values to the console — mask them, keep the
    // flag so the UI can show "configured ✓". Runtime readers use getConfigValue.
    const entries = store.getConfig(scope, category).map((e) => (e.secret ? { ...e, value: "" } : e));
    store.close();
    return emit(entries);
  }
  if (cmd === "config-set") {
    if (!opts.scope || !opts.category || !opts.key || opts.value === undefined) {
      console.error("usage: portico config-set --scope <scope> --category <llm|variable> --key <key> --value <value> [--secret]");
      process.exit(2);
    }
    const store = new Store();
    store.setConfig({
      scope: opts.scope,
      category: opts.category as "llm" | "variable",
      key: opts.key,
      value: opts.value,
      secret: opts.secret,
    });
    store.close();
    return emit({ ok: true });
  }
  if (cmd === "config-delete") {
    if (!opts.scope || !opts.category || !opts.key) {
      console.error("usage: portico config-delete --scope <scope> --category <llm|variable> --key <key>");
      process.exit(2);
    }
    const store = new Store();
    store.deleteConfig(opts.scope, opts.category as "llm" | "variable", opts.key);
    store.close();
    if (opts.json) return emit({ ok: true });
    console.log(`✔ deleted ${opts.scope}/${opts.category}/${opts.key}`);
    process.exit(0);
  }

  // ---- browser session lifecycle (start/kill a long-lived CDP browser) ---

  if (cmd === "session-start") {
    const tenant = opts.tenant ?? "default";
    // The profile keys the on-disk userDataDir. Default it to the connector so
    // each connector gets its OWN persistent profile — logins persist per
    // connector and connectors never share a cookie jar (isolation).
    const profile = normalizeProfile(opts.profile ?? opts.connector);

    // Chromium allows only ONE browser per userDataDir; launching a second on
    // the same profile makes the two fight over the singleton lock, which
    // corrupts the session and silently logs the user out. So if a LIVE browser
    // already exists for this profile, REUSE it instead of launching a duplicate.
    {
      const store = new Store();
      const dupes = store
        .listBrowserSessions(tenant)
        .filter((s) => s.status === "active" && s.cdpEndpoint && normalizeProfile(s.profile) === profile);
      for (const s of dupes) {
        if (await isCdpLive(s.cdpEndpoint!)) {
          store.close();
          return emit({ id: s.id, cdpEndpoint: s.cdpEndpoint, connector: s.connector, reused: true });
        }
      }
      store.close();
    }

    // Allocate a free port unless one was explicitly requested, and pass it
    // down so serve-browser binds the SAME port the session row records.
    const port = opts.port ?? (await findFreePort());
    const scriptArgs = ["--port", String(port), "--tenant", tenant, "--profile", profile];
    if (opts.baseUrl) scriptArgs.push("--base-url", opts.baseUrl);
    if (opts.connector) scriptArgs.push("--connector", opts.connector);

    const child = spawn(process.execPath, ["scripts/serve-browser.mjs", ...scriptArgs], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // Track the session ourselves so it's visible even before serve-browser's
    // own registration lands (that script records a SEPARATE session row under
    // its own generated id once its browser is up — a harmless double-entry,
    // not a conflict, since ids never collide).
    const id = "sess_" + Date.now().toString(16) + Math.random().toString(16).slice(2, 8);
    // 127.0.0.1, not "localhost": Chrome binds the debug port on IPv4 only, and
    // "localhost" may resolve to ::1 (IPv6) first where another service can answer.
    const cdpEndpoint = `http://127.0.0.1:${port}`;
    const store = new Store();
    store.createBrowserSession({
      id,
      tenant,
      profile,
      cdpEndpoint,
      startedAt: new Date().toISOString(),
      pid: child.pid,
      connector: opts.connector,
    });
    store.close();
    return emit({ id, pid: child.pid, cdpEndpoint, connector: opts.connector });
  }
  if (cmd === "session-kill") {
    if (!flowPath) { console.error("usage: portico session-kill <id>"); process.exit(2); }
    const store = new Store();
    const session = store.getBrowserSession(flowPath);
    if (session?.pid) {
      try {
        process.kill(session.pid);
      } catch {
        /* process may already be gone — proceed to mark the session closed */
      }
    }
    store.closeBrowserSession(flowPath, new Date().toISOString());
    store.close();
    return emit({ id: flowPath, killed: true });
  }

  // ---- record-by-demonstration -----------------------------------------
  // record-start attaches a detached recorder to an ACTIVE CDP session; the
  // user demonstrates in that already-logged-in browser; record-stop kills the
  // recorder, then compiles the capture into a draft flow (source "recorded").

  if (cmd === "list-recordings") {
    const store = new Store();
    const recs = store.listRecordings(opts.session);
    store.close();
    return emit(recs);
  }

  if (cmd === "get-recording") {
    if (!flowPath) { console.error("usage: portico get-recording <recordingId>"); process.exit(2); }
    const store = new Store();
    const rec = store.getRecording(flowPath);
    store.close();
    if (!rec) {
      return emit({ error: `no recording with id "${flowPath}"` }, 2);
    }
    // Live capture stats straight from the recorder's incrementally-flushed
    // recording.json: `attached` flips true once the recorder has written its
    // first flush, and the counts grow as the user demonstrates. The console
    // polls this for feedback while a capture is running.
    let attached = false;
    let liveClicks = 0;
    let liveRequests = 0;
    try {
      const live = JSON.parse(readFileSync(rec.path, "utf8")) as Recording;
      attached = true;
      liveClicks = live.clicks?.length ?? 0;
      liveRequests = live.network?.length ?? 0;
    } catch {
      /* recorder hasn't attached/flushed yet — report attached: false */
    }
    return emit({ ...rec, attached, liveClicks, liveRequests });
  }

  if (cmd === "record-start") {
    if (!opts.session) {
      console.error("usage: portico record-start --session <sessionId> [--key KEY] [--connector C] [--base-url URL]");
      process.exit(2);
    }
    const store = new Store();
    const session = store.getBrowserSession(opts.session);
    if (!session || session.status !== "active" || !session.cdpEndpoint) {
      store.close();
      const msg = `session "${opts.session}" is not an active CDP session — start one first`;
      if (opts.json) return emit({ error: msg }, 1);
      console.error(`✗ ${msg}`);
      process.exit(1);
    }
    // The session row can outlive its browser (user closed the window, machine
    // rebooted). Probe the CDP endpoint BEFORE spawning a recorder that would
    // otherwise attach to nothing and record forever with zero feedback.
    try {
      await fetch(session.cdpEndpoint + "/json/version", { signal: AbortSignal.timeout(2500) });
    } catch {
      store.closeBrowserSession(opts.session, new Date().toISOString());
      store.close();
      const msg = "session browser is unreachable — it may have been closed. Start a new session and try again.";
      if (opts.json) return emit({ error: msg }, 1);
      console.error(`✗ ${msg}`);
      process.exit(1);
    }
    // One recorder per session: a second one would fight over the same click
    // buffer and orphan the first recording's row.
    const inProgress = store.listRecordings(opts.session).find((r) => r.status === "recording");
    if (inProgress) {
      store.close();
      const msg = "a recording is already in progress on this session";
      if (opts.json) return emit({ error: msg, recordingId: inProgress.id }, 1);
      console.error(`✗ ${msg} (${inProgress.id})`);
      process.exit(1);
    }
    const recId = "rec_" + Date.now().toString(16) + Math.random().toString(16).slice(2, 6);
    const flowKey = opts.key ?? "recorded-flow";
    const path = `.libretto/recordings/${recId}/recording.json`;
    const scriptArgs = ["scripts/record-attach.mjs", "--cdp", session.cdpEndpoint, "--name", recId];
    if (opts.baseUrl) scriptArgs.push("--base-url", opts.baseUrl);

    const child = spawn(process.execPath, scriptArgs, { detached: true, stdio: "ignore" });
    child.unref();

    store.createRecording({
      id: recId,
      sessionId: opts.session,
      connector: opts.connector,
      flowKey,
      baseUrl: opts.baseUrl,
      path,
      pid: child.pid,
      startedAt: new Date().toISOString(),
    });
    store.close();
    if (opts.json) return emit({ recordingId: recId, sessionId: opts.session, pid: child.pid, status: "recording" });
    console.log(`● recording ${recId} — demonstrate in the session's browser, then: record-stop ${recId}`);
    process.exit(0);
  }

  if (cmd === "record-stop") {
    if (!flowPath) { console.error("usage: portico record-stop <recordingId> [--intercept KEYWORD]"); process.exit(2); }
    const store = new Store();
    const rec = store.getRecording(flowPath);
    if (!rec) { store.close(); console.error(`no recording with id "${flowPath}"`); process.exit(2); }

    // Signal the detached recorder to finalize, then wait for it to exit so its
    // last flush of recording.json has landed before we read it.
    if (rec.pid) {
      try { process.kill(rec.pid, "SIGTERM"); } catch { /* already gone */ }
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        try { process.kill(rec.pid, 0); } catch { break; } // throws once the pid is gone
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    let recording: Recording;
    try {
      recording = JSON.parse(readFileSync(rec.path, "utf8")) as Recording;
    } catch (e) {
      const msg = `no capture written (${e instanceof Error ? e.message : e}) — did the recorder attach?`;
      store.updateRecording(rec.id, { status: "error", error: msg, pid: null });
      store.close();
      if (opts.json) return emit({ recordingId: rec.id, error: msg }, 1);
      console.error(`✗ ${msg}`);
      process.exit(1);
    }

    const flow = compileRecording(recording, { key: rec.flowKey, interceptKeyword: opts.intercept });
    const version = (store.listFlowVersions(rec.flowKey)[0]?.version ?? 0) + 1;
    // Keep the YAML body's `version` in sync with the assigned draft version
    // (compileRecording always emits version: 1).
    flow.version = version;
    const yamlStr = stringifyYaml(flow);
    const draftId = `flow_${rec.flowKey}_v${version}_${Math.random().toString(16).slice(2, 8)}`;
    store.saveFlow({
      id: draftId, key: rec.flowKey, version, yaml: yamlStr, status: "draft", source: "recorded",
      connector: rec.connector, createdAt: new Date().toISOString(),
    });
    const clicks = recording.clicks?.length ?? 0;
    const requests = recording.network?.length ?? 0;
    store.updateRecording(rec.id, { status: "compiled", draftFlowId: draftId, clicks, requests, pid: null });
    store.close();

    if (opts.json) return emit({ recordingId: rec.id, draftId, key: rec.flowKey, version, steps: flow.steps.length, clicks, requests });
    console.log(`✔ compiled recording ${rec.id} → draft "${rec.flowKey}" v${version} (${flow.steps.length} steps, ${clicks} clicks, ${requests} requests)`);
    process.exit(0);
  }

  // NB: agent-authoring (Stagehand) lives in a standalone script,
  // packages/author/author-cli.mjs, spawned directly by the console's
  // /api/flows/author route — NOT wired here. That keeps Stagehand's heavy
  // module graph (ai@5, browser drivers) out of this CLI, which the console
  // spawns constantly for list-sessions/list-flows/etc.

  // LLM refine pass — clean a draft's coarse act names into a new (llm) draft.
  if (cmd === "refine") {
    const store = new Store();
    const rec = flowPath ? store.getFlow(flowPath) : undefined;
    if (!rec) { store.close(); console.error(`no flow with id "${flowPath ?? ""}"`); process.exit(2); }
    const draft = parseYaml(rec.yaml) as Flow;
    // UI-set LLM config activates refine: per-connector overrides global, both
    // over env. resolveHealModel reads PORTICO_HEAL_* — so map config → env first.
    const pick = (k: string) => store.getConfigValue(rec.connector ?? "", "llm", k) || store.getConfigValue("global", "llm", k);
    const cfgProvider = pick("provider"), cfgModel = pick("model"), cfgKey = pick("api_key");
    if (cfgProvider) process.env.PORTICO_HEAL_PROVIDER = cfgProvider;
    if (cfgModel) process.env.PORTICO_HEAL_MODEL = cfgModel;
    if (cfgKey) process.env.PORTICO_HEAL_API_KEY = cfgKey;
    const heal = await resolveHealModel();
    if (!heal) {
      store.close();
      const msg = "no model configured — set PORTICO_HEAL_PROVIDER + PORTICO_HEAL_API_KEY to refine";
      if (opts.json) return emit({ error: msg }, 1);
      console.error(`✗ ${msg}`);
      process.exit(1);
    }
    const emptyRec: Recording = { baseUrl: "", clicks: [], network: [] };
    const refined = await refineFlow(draft, emptyRec, heal.languageModel, { goal: opts.goal });
    const version = (store.listFlowVersions(rec.key)[0]?.version ?? 0) + 1;
    // Keep the YAML body's `version` in sync with the assigned draft version
    // (refineFlow carries over the source draft's stale version).
    refined.version = version;
    const id = `flow_${rec.key}_v${version}_${Math.random().toString(16).slice(2, 8)}`;
    store.saveFlow({
      id, key: rec.key, version, yaml: stringifyYaml(refined), status: "draft", source: "llm",
      connector: rec.connector, createdAt: new Date().toISOString(),
    });
    store.close();
    if (opts.json) return emit({ id, key: rec.key, version, source: "llm", steps: refined.steps.length });
    console.log(`✔ refined "${rec.key}" → new draft v${version} (id=${id}, ${refined.steps.length} steps)`);
    process.exit(0);
  }

  // Save an edited flow YAML as a new draft version (console YAML editor).
  if (cmd === "save-flow") {
    if (!opts.key || !opts.yamlFile) {
      console.error("usage: portico save-flow --key <key> --yaml-file <path> [--connector C]");
      process.exit(2);
    }
    let parsed: Flow;
    try {
      const yamlText = readFileSync(opts.yamlFile, "utf8");
      parsed = parseYaml(yamlText) as Flow;
      if (!parsed || typeof parsed.key !== "string" || !Array.isArray(parsed.steps)) {
        throw new Error("a flow needs a string `key` and a `steps` array");
      }
    } catch (e) {
      const msg = `yaml invalid: ${e instanceof Error ? e.message : e}`;
      if (opts.json) return emit({ error: msg }, 1);
      console.error(`✗ ${msg}`);
      process.exit(1);
    }
    const store = new Store();
    const version = (store.listFlowVersions(opts.key)[0]?.version ?? 0) + 1;
    // Keep the YAML body's `version` in sync with the assigned draft version —
    // otherwise a v2 row's YAML still claims the version it was copied from.
    parsed.version = version;
    const id = `flow_${opts.key}_v${version}_${Math.random().toString(16).slice(2, 8)}`;
    store.saveFlow({
      id, key: opts.key, version, yaml: stringifyYaml(parsed), status: "draft", source: "manual",
      connector: opts.connector, createdAt: new Date().toISOString(),
    });
    store.close();
    if (opts.json) return emit({ id, key: opts.key, version });
    console.log(`✔ saved "${opts.key}" v${version} (id=${id})`);
    process.exit(0);
  }

  // Promote a draft to confirmed — only if its latest validation passed.
  if (cmd === "confirm") {
    const store = new Store();
    const rec = flowPath ? store.getFlow(flowPath) : undefined;
    if (!rec) { store.close(); console.error(`no flow with id "${flowPath ?? ""}"`); process.exit(2); }
    const v = store.latestValidation(rec.id);
    if (!v || !v.passed) {
      store.close();
      const msg = `cannot confirm "${rec.key}" v${rec.version} — ${v ? "last validation FAILED" : "not validated yet"}. Run:  validate ${rec.id}`;
      if (opts.json) return emit({ flowId: rec.id, confirmed: false, error: msg }, 1);
      console.error(`✗ ${msg}`);
      process.exit(1);
    }
    store.confirmFlow(rec.id);
    store.close();
    if (opts.json) return emit({ flowId: rec.id, key: rec.key, version: rec.version, confirmed: true });
    console.log(`✔ confirmed "${rec.key}" v${rec.version} — validated and live-eligible.`);
    process.exit(0);
  }

  // Compile a recorded demonstration into a DRAFT flow (record-by-demonstration).
  // Deterministic baseline (an LLM refine pass layers on later). Persists the
  // draft to the store and writes the YAML for review before it's confirmed.
  if (cmd === "compile") {
    if (!flowPath) {
      console.error("usage: portico compile <recording.json> [--key NAME] [--intercept KEYWORD] [--connector NAME] [--out FILE]");
      process.exit(2);
    }
    const rec = JSON.parse(readFileSync(flowPath, "utf8")) as Recording;
    const key = opts.key ?? "recorded-flow";
    const flow = compileRecording(rec, { key, interceptKeyword: opts.intercept });

    const store = new Store();
    const version = (store.listFlowVersions(key)[0]?.version ?? 0) + 1;
    // Keep the YAML body's `version` in sync with the assigned draft version
    // (compileRecording always emits version: 1).
    flow.version = version;
    const yamlStr = stringifyYaml(flow);
    const id = `flow_${key}_v${version}_${Math.random().toString(16).slice(2, 8)}`;
    store.saveFlow({
      id, key, version, yaml: yamlStr, status: "draft", source: "recorded",
      connector: opts.connector, createdAt: new Date().toISOString(),
    });
    store.close();

    const outPath = opts.out ?? `connectors/${opts.connector ?? "generated"}/flows/${key}.draft.flow.yaml`;
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, yamlStr);

    if (opts.json) return emit({ id, key, version, status: "draft", steps: flow.steps.length, out: outPath });
    console.log(`✔ compiled recording → draft flow "${key}" v${version} (${flow.steps.length} steps)`);
    console.log(`  persisted draft id=${id}`);
    console.log(`  wrote ${outPath}\n`);
    console.log(yamlStr);
    console.log("Review it, then validate + confirm before it goes live.");
    process.exit(0);
  }

  // ---- members (durable auth principals) ---------------------------------
  // Bearer-token auth for the console/API. Raw tokens are generated
  // in-process and printed exactly once (member-add); only their sha256 hash
  // is ever persisted (members.token_hash) — see hashMemberToken in
  // @portico/store. auth-check reads the raw token from an env var, NEVER
  // from argv, since argv is visible to every other process on the host
  // (e.g. `ps`).

  if (cmd === "member-add") {
    const role = opts.role as MemberRole | undefined;
    if (!opts.name || !role) {
      console.error("usage: portico member-add --name <name> --role <viewer|operator|admin> [--json]");
      process.exit(2);
    }
    if (role !== "viewer" && role !== "operator" && role !== "admin") {
      const msg = `invalid role "${role}" — must be one of: viewer, operator, admin`;
      if (opts.json) return emit({ error: msg }, 2);
      console.error(`✗ ${msg}`);
      process.exit(2);
    }
    // pk_ prefix marks this as a Portico key at a glance (e.g. in leaked-secret
    // scanners); 24 random bytes (base64url) gives ~192 bits of entropy.
    const token = "pk_" + randomBytes(24).toString("base64url");
    const id = `mem_${Math.random().toString(16).slice(2, 10)}`;
    const store = new Store();
    try {
      store.createMember({ id, name: opts.name, role, tokenHash: hashMemberToken(token) });
    } catch (e) {
      store.close();
      const msg = e instanceof Error ? e.message : String(e);
      if (opts.json) return emit({ error: msg }, 1);
      console.error(`✗ ${msg}`);
      process.exit(1);
    }
    // No token in the audit trail — only the hash ever touches the store, and
    // the audit event doesn't even get that much.
    store.appendAudit({
      ts: new Date().toISOString(), actor: "cli", action: "member.added",
      target: id, detail: { name: opts.name, role },
    });
    store.close();
    // This is the ONLY time the raw token is ever emitted — it is not
    // recoverable afterward (only its hash is stored).
    const out = { id, name: opts.name, role, token };
    if (opts.json) return emit(out);
    console.log(`✔ added member "${opts.name}" (${role}) — id=${id}`);
    console.log(`  token: ${token}`);
    console.log("  (save this now — it will not be shown again)");
    process.exit(0);
  }

  if (cmd === "member-list") {
    const store = new Store();
    const members = store.listMembers();
    store.close();
    if (opts.json) return emit(members);
    if (members.length === 0) {
      console.log("(no members)");
    } else {
      console.log(`${"ID".padEnd(14)}  ${"NAME".padEnd(20)}  ${"ROLE".padEnd(10)}  ${"STATUS".padEnd(10)}  ${"CREATED".padEnd(24)}  LAST LOGIN`);
      for (const m of members) {
        console.log(
          `${m.id.padEnd(14)}  ${m.name.slice(0, 20).padEnd(20)}  ${m.role.padEnd(10)}  ${(m.disabled ? "disabled" : "active").padEnd(10)}  ${m.createdAt.padEnd(24)}  ${m.lastLoginAt ?? "-"}`,
        );
      }
    }
    process.exit(0);
  }

  if (cmd === "member-disable" || cmd === "member-enable") {
    if (!flowPath) { console.error(`usage: portico ${cmd} <id>`); process.exit(2); }
    const disabled = cmd === "member-disable";
    const store = new Store();
    const existing = store.listMembers().find((m) => m.id === flowPath);
    if (!existing) {
      store.close();
      const msg = `no member with id "${flowPath}"`;
      if (opts.json) return emit({ error: msg }, 2);
      console.error(`✗ ${msg}`);
      process.exit(2);
    }
    store.setMemberDisabled(flowPath, disabled);
    store.appendAudit({
      ts: new Date().toISOString(), actor: "cli", action: disabled ? "member.disabled" : "member.enabled",
      target: flowPath, detail: { name: existing.name },
    });
    store.close();
    const out = { id: flowPath, name: existing.name, disabled };
    if (opts.json) return emit(out);
    console.log(`✔ ${disabled ? "disabled" : "enabled"} member "${existing.name}" (${flowPath})`);
    process.exit(0);
  }

  // Reads the raw token from PORTICO_AUTH_CHECK_TOKEN — NOT argv, which leaks
  // into `ps`/process-list output on shared hosts. Always exits 0 (the
  // {ok:false} body IS the "not authenticated" signal, not a process failure)
  // so callers only need to parse stdout, never the exit code.
  if (cmd === "auth-check") {
    const token = process.env.PORTICO_AUTH_CHECK_TOKEN;
    if (!token) return emit({ ok: false });
    const store = new Store();
    const member = store.findMemberByTokenHash(hashMemberToken(token));
    if (!member || member.disabled) {
      store.close();
      return emit({ ok: false });
    }
    store.touchMemberLogin(member.id);
    store.close();
    return emit({ ok: true, member: { id: member.id, name: member.name, role: member.role } });
  }

  if ((cmd !== "run" && cmd !== "validate") || !flowPath) {
    console.error(
      "usage: portico <run <flow.yaml> [--sector KEY] [--allowed-domains a,b] [--resume-from N] [--resume-output file.json] | " +
        "validate <flow-id> | confirm <flow-id> | compile <recording.json> | " +
        "list-flows | get-flow <id> | delete-flow <flowId> [--all-versions] | list-runs | get-run <id> | list-sessions | close-session <id> | " +
        "list-connectors | get-connector <idOrKey> | save-connector [--sector KEY] | delete-connector <id> | " +
        "config-get | config-set | session-start | session-kill <id> | " +
        "record-start --session <id> | record-stop <recId> | get-recording <recId> | list-recordings | " +
        "enqueue <flowId> [--input k=v]... [--max-attempts N] | queue [--status S] [--limit N] | worker [--concurrency N] [--once] | " +
        "member-add --name <n> --role <viewer|operator|admin> | member-list | member-disable <id> | member-enable <id> | auth-check>",
    );
    process.exit(2);
  }

  // `validate <flow-id>` runs a STORED draft (loaded from the store); `run
  // <flow.yaml>` runs a flow file. Both share the execution pipeline below.
  let flowId: string | undefined;
  let flow: Flow;
  // The connector KEY this run belongs to (for scoping the console). validate
  // inherits it from the stored draft; run takes --connector or the flow's own.
  let connectorKey: string | undefined;
  if (cmd === "validate") {
    const s0 = new Store();
    const rec = s0.getFlow(flowPath);
    s0.close();
    if (!rec) { console.error(`no flow with id "${flowPath}"`); process.exit(2); }
    flowId = rec.id;
    flow = parseYaml(rec.yaml) as Flow;
    connectorKey = rec.connector ?? opts.connector;
    // Validation is a real dry-run: fill any unprovided inputs from the flow's
    // declared examples so it EXERCISES the flow instead of failing on missing
    // inputs. An explicit --input still wins.
    opts.inputs = { ...sampleInputsFromFlow(flow), ...opts.inputs };
  } else {
    flow = parseYaml(readFileSync(flowPath, "utf8")) as Flow;
    connectorKey = opts.connector ?? (flow as unknown as { connector?: string }).connector;
  }
  const instance = opts.instance ? (parseYaml(readFileSync(opts.instance, "utf8")) as Record<string, any>) : {};
  const instanceName = (instance.instance as string | undefined) ?? undefined;

  let baseUrl: string = opts.baseUrl ?? instance.base_url ?? "";
  // No explicit --base-url / instance: fall back to the connector's stored one
  // (console-created connectors keep it in the DB — the console passes
  // --connector when it spawns runs). The runner needs a base URL to establish
  // the app origin before flows that OPEN with localStorage reads / api calls,
  // otherwise those steps execute on about:blank and storage access is denied.
  // The same lookup seeds the sector default below, so a stored flow's run
  // inherits its connector's reliability profile without an explicit --sector.
  let connectorSector: string | undefined;
  if (connectorKey && (!baseUrl || !opts.sector)) {
    try {
      const s = new Store();
      const c = s.getConnector(connectorKey);
      if (!baseUrl) baseUrl = c?.baseUrl ?? "";
      connectorSector = c?.sector;
      s.close();
    } catch {
      /* store unavailable — the runner can still infer an origin from the flow */
    }
  }
  const host = instance.host ?? (baseUrl ? new URL(baseUrl).host : "");
  const target: Target = {
    key: flow.key,
    name: flow.key,
    base_url: baseUrl,
    allowed_domains: host ? [host] : [],
    auth: instance.auth ?? "",
  };

  // Sector + egress allow-list: an explicit flag always wins; otherwise fall
  // back to the connector's stored sector / the target's derived
  // allowed_domains, so a stored flow inherits the right SectorProfile and
  // egress boundary without every caller passing them explicitly.
  const sectorKeys = listSectors() as string[];
  if (opts.sector && !sectorKeys.includes(opts.sector)) {
    const msg = `invalid --sector "${opts.sector}" — must be one of: ${sectorKeys.join(", ")}`;
    if (opts.json) return emit({ error: msg }, 2);
    console.error(`✗ ${msg}`);
    process.exit(2);
  }
  const sector: string | undefined = opts.sector ?? connectorSector;
  const allowedDomains: string[] | undefined = opts.allowedDomains
    ? opts.allowedDomains.split(",").map((d) => d.trim()).filter(Boolean)
    : target.allowed_domains.length
      ? target.allowed_domains
      : undefined;

  let resumeOutputValue: Record<string, unknown> | undefined;
  if (opts.resumeOutputFile) {
    try {
      resumeOutputValue = JSON.parse(readFileSync(opts.resumeOutputFile, "utf8")) as Record<string, unknown>;
    } catch (e) {
      const msg = `--resume-output file invalid: ${e instanceof Error ? e.message : e}`;
      if (opts.json) return emit({ error: msg }, 1);
      console.error(`✗ ${msg}`);
      process.exit(1);
    }
  }

  const secretRefs: Record<string, string> = instance.secrets ?? {};
  const secrets = Object.keys(secretRefs).length
    ? await resolveSecrets(defaultSecretProvider(), secretRefs)
    : {};

  // Activate self-heal / AI-extract from the DB LLM config (Settings) when set —
  // so a UI-configured model works on runs without editing .env. Per-connector
  // (flow.connector / instance) overrides global; both map into PORTICO_HEAL_*
  // which resolveHealModel reads inside the engine.
  try {
    const cfgStore = new Store();
    const scope = connectorKey ?? instanceName ?? "";
    const pick = (k: string) => cfgStore.getConfigValue(scope, "llm", k) || cfgStore.getConfigValue("global", "llm", k);
    const hp = pick("provider"), hm = pick("model"), hk = pick("api_key");
    cfgStore.close();
    if (hp) process.env.PORTICO_HEAL_PROVIDER = hp;
    if (hm) process.env.PORTICO_HEAL_MODEL = hm;
    if (hk) process.env.PORTICO_HEAL_API_KEY = hk;
  } catch { /* config read is best-effort */ }

  const engine = getEngine("portico");
  const mode: RunMode = opts.live ? "live" : "dry_run";
  const log = (...a: unknown[]) => { if (!opts.json) console.log(...a); };
  log(`▶ running flow "${flow.key}" via ${engine.name} (headless=${opts.headless}, mode=${mode}${opts.profile ? `, profile=${opts.profile}` : ""})`);

  // Headed runs get an interactive HITL handler: pause for the human to log in
  // (and complete 2FA) in the browser window, then press Enter to continue.
  const onHuman = opts.headless || opts.json
    ? undefined
    : async (step: { index: number; label?: string }) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        await rl.question(`\n⏸  ${step.label ?? "Human step"} — complete it in the browser, then press Enter… `);
        rl.close();
      };

  const startedAt = Date.now();
  const result = await engine.run({
    target,
    flow,
    inputs: opts.inputs,
    auth: { secrets },
    mode,
    headless: opts.headless,
    profileId: opts.profile,
    cdpEndpoint: opts.cdp,
    onHuman,
    onStep: (t) => log(`  [${t.index}] ${t.type}${t.label ? ` — ${t.label}` : ""}: ${t.status}${t.detail ? ` (${t.detail})` : ""}`),
    sector,
    allowedDomains,
    resumeFrom: opts.resumeFrom,
    resumeOutput: resumeOutputValue,
  });

  const runId = "run_" + Math.random().toString(16).slice(2, 8);
  const durationMs = Date.now() - startedAt;
  const steps = result.traces.map((t) => ({
    index: t.index, type: t.type, label: t.label,
    status: t.status, detail: t.detail,
    healedFrom: t.healedFrom, healedTo: t.healedTo, screenshotRef: t.screenshotRef,
    errorKind: t.errorKind,
    durationMs: Math.max(0, t.endedAt - t.startedAt),
  }));

  // Persist the run + append-only audit to the durable store. Best-effort:
  // a persistence failure must not fail the run itself.
  try {
    const store = new Store();
    store.createRun({
      id: runId, connector: connectorKey ?? instanceName ?? "cli", instance: instanceName,
      flow: flow.key, engine: engine.name,
      tier: deriveTier(result.traces), status: result.status, mode,
      startedAt: new Date(startedAt).toISOString(), durationMs,
      steps, output: result.output, failure: result.failure, rrwebRef: result.rrwebRef,
    });
    store.appendAudit({
      ts: new Date().toISOString(), actor: "cli", action: `run.${result.status}`,
      runId, target: target.base_url, detail: { flow: flow.key, mode, engine: engine.name },
    });
    store.close();
  } catch (e) {
    if (!opts.json) console.error("[store] persist failed:", e instanceof Error ? e.message : e);
  }

  // `validate`: judge the run against the flow's expected outputs and record the
  // verdict — a passing validation is what gates `confirm`.
  if (cmd === "validate") {
    const verdict = evaluateValidation(flow, { status: result.status, output: result.output, failure: result.failure });
    try {
      const store = new Store();
      store.recordValidation({
        id: "val_" + Math.random().toString(16).slice(2, 8),
        flowId: flowId!, passed: verdict.passed, reasons: verdict.reasons, runId,
        createdAt: new Date().toISOString(),
      });
      store.close();
    } catch { /* best-effort */ }
    if (opts.json) return emit({ flowId, passed: verdict.passed, reasons: verdict.reasons, runId }, verdict.passed ? 0 : 1);
    console.log(`\n${verdict.passed ? "✔ VALIDATION PASSED" : "✗ VALIDATION FAILED"}`);
    for (const r of verdict.reasons) console.log(`  - ${r}`);
    if (verdict.passed) console.log(`  → confirm it:  node --import tsx apps/cli/src/index.ts confirm ${flowId}`);
    process.exit(verdict.passed ? 0 : 1);
  }

  if (opts.json) {
    // Machine-readable run record (consumed by the console's run API).
    return emit({
      id: runId,
      flow: flow.key,
      engine: engine.name,
      status: result.status,
      durationMs,
      output: result.output,
      unvalidatedOutputKeys: result.unvalidatedOutputKeys,
      rrwebRef: result.rrwebRef,
      authProfile: result.authProfile,
      failure: result.failure,
      steps,
    });
  }

  log(`\n${result.status.toUpperCase()}`);
  if (Object.keys(result.output).length) log("output:", JSON.stringify(result.output, null, 2));
  if (result.unvalidatedOutputKeys?.length) log("unvalidated (no model):", result.unvalidatedOutputKeys.join(", "));
  if (result.rrwebRef) log("recording:", result.rrwebRef);
  if (result.failure) log("failure:", result.failure);
  process.exit(result.status === "completed" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
