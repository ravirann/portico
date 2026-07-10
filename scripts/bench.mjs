#!/usr/bin/env node
// bench.mjs — LOCAL per-run latency benchmark for Portico (Phase 5 deliverable).
//
// Runs examples/smoke.flow.yaml N times through the REAL CLI, spawned exactly
// how a human/CI caller would invoke it:
//
//   node --import tsx apps/cli/src/index.ts run <flow.yaml> --base-url <url> --headless --json
//
// ...times each run end-to-end (wall-clock), and reports p50/p95/min/max
// against the SLOs in docs/ARCHITECTURE.md §4 (DOM-tier: p50 < 6s, p95 < 12s;
// API-tier: p50 < 500ms, p95 < 1s). Pure Node — no cloud, no new dependencies.
//
//   node scripts/bench.mjs [--runs N] [--url URL] [--flow PATH] [--headed] [--timeout MS]
//
// Requires chromium (`npx playwright install chromium`) and network access to
// --url (default https://example.com). See docs/BENCHMARKS.md for details on
// what this measures and how to read the output.
//
// A run's WALL time (subprocess spawn -> exit) also includes Node/tsx process
// startup, since the CLI has no long-lived/in-process mode — every invocation
// pays that cold-start cost. ARCHITECTURE.md's SLOs describe a warm,
// already-running engine ("platform overhead per run, excl. engine" is its
// own <200ms budget, separate from engine latency). So alongside WALL we also
// surface the engine's own self-reported ENGINE ms (the run result's
// `durationMs`) so a wall-clock SLO miss can be told apart from a genuine
// engine regression.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.ts");
const DEFAULT_FLOW = resolve(REPO_ROOT, "examples/smoke.flow.yaml");

// SLOs — docs/ARCHITECTURE.md §4, "steady state, warm, pre-authenticated".
const SLO = {
  api: { p50: 500, p95: 1000 },
  dom: { p50: 6000, p95: 12000 },
};

// Failure signatures that mean "this environment isn't ready to run at all"
// (missing browser binary, no network/DNS) as opposed to a one-off flake —
// seeing one of these on run 1 means every subsequent run will fail the same
// way, so we stop early instead of repeating a doomed run N times.
const ENV_FAILURE_RE =
  /executable doesn't exist|playwright install|browsertype\.launch|net::err_|enotfound|eai_again|econnrefused|err_internet_disconnected|err_name_not_resolved|getaddrinfo/i;

function printHelp() {
  console.log(`usage: node scripts/bench.mjs [--runs N] [--url URL] [--flow PATH] [--headed] [--timeout MS]

  --runs N     number of times to run the flow (default 5)
  --url URL    passed as --base-url to the CLI (default https://example.com)
  --flow PATH  flow YAML to run (default examples/smoke.flow.yaml)
  --headed     visible browser window (default headless)
  --timeout MS per-run kill timeout in ms (default 60000)`);
}

function parseArgs(argv) {
  const opts = { runs: 5, url: "https://example.com", flow: DEFAULT_FLOW, headless: true, timeoutMs: 60_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runs") opts.runs = Number(argv[++i]);
    else if (a === "--url") opts.url = argv[++i];
    else if (a === "--flow") opts.flow = resolve(process.cwd(), argv[++i]);
    else if (a === "--headed") opts.headless = false;
    else if (a === "--timeout") opts.timeoutMs = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`✗ unknown argument: ${a}\n`);
      printHelp();
      process.exit(2);
    }
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 1) {
    console.error(`✗ --runs must be a positive integer`);
    process.exit(2);
  }
  return opts;
}

/**
 * Spawn a CLI subcommand and capture stdout/stderr. Never rejects and never
 * throws — a spawn failure, non-zero exit, or timeout all resolve normally so
 * one bad run can't take down the whole bench loop (portal/browser errors are
 * recorded, not fatal).
 */
function runCli(args, { timeoutMs } = {}) {
  return new Promise((res) => {
    let child;
    try {
      child = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY, ...args], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      res({ code: -1, stdout: "", stderr: `spawn failed: ${err instanceof Error ? err.message : err}`, killed: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
        }, timeoutMs)
      : undefined;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      res({ code: -1, stdout, stderr: stderr + `\nspawn error: ${err.message}`, killed });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      res({ code, stdout, stderr, killed });
    });
  });
}

/**
 * The CLI's --json mode only silences the CLI's OWN console.log calls — its
 * dependencies (the "ai" SDK, libretto's [INFO] logs) still write straight to
 * stdout ahead of the real payload. `emit()` (apps/cli/src/index.ts) always
 * writes JSON.stringify(value) — a single line, no pretty-print — as its LAST
 * write before exit, so scan non-empty lines from the end and return the
 * first one that parses as JSON.
 */
function extractJson(stdout) {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // a noise line that happens to start with "{" — keep scanning backwards
    }
  }
  return undefined;
}

function firstLine(s) {
  return (s || "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function fmtMs(ms) {
  return Number.isFinite(ms) ? `${Math.round(ms)}ms` : "n/a";
}

function pad(value, width) {
  const s = String(value);
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

function relPath(p) {
  return p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p;
}

/**
 * One run: spawn `run --json`, time it end-to-end, then look up its derived
 * tier from the store via `get-run` (reuses the engine's own `deriveTier`
 * rather than re-implementing it here). The tier lookup happens AFTER the
 * timer stops, so it never inflates the measured latency.
 */
async function benchOne(index, opts) {
  const runArgs = ["run", opts.flow, "--base-url", opts.url, opts.headless ? "--headless" : "--headed", "--json"];
  const startedAt = performance.now();
  const { code, stdout, stderr, killed } = await runCli(runArgs, { timeoutMs: opts.timeoutMs });
  const wallMs = performance.now() - startedAt;

  const parsed = extractJson(stdout);
  if (!parsed) {
    const reason = killed
      ? `killed after ${opts.timeoutMs}ms timeout`
      : `no JSON on stdout (exit code ${code}) — ${firstLine(stderr) || firstLine(stdout) || "no output at all"}`;
    return { run: index, wallMs, engineMs: NaN, status: "error", tier: "n/a", reason };
  }

  let tier = "n/a";
  const tierRes = await runCli(["get-run", parsed.id ?? ""], { timeoutMs: 10_000 });
  const runRow = extractJson(tierRes.stdout);
  if (runRow?.tier) tier = runRow.tier;

  const status = parsed.status ?? (code === 0 ? "completed" : "failed");
  const reason = parsed.failure ? `step ${parsed.failure.stepIndex}: ${parsed.failure.reason}` : undefined;
  return { run: index, wallMs, engineMs: parsed.durationMs, status, tier, reason };
}

function logRunLine(result, total) {
  const ok = result.status === "completed";
  const line =
    `  [${result.run}/${total}] ${ok ? "ok  " : "FAIL"}  ` +
    `wall=${pad(fmtMs(result.wallMs), 8)} engine=${pad(fmtMs(result.engineMs), 8)} tier=${result.tier}` +
    (ok ? "" : `  — ${result.reason || "unknown error"}`);
  console.log(line);
}

function printReport(results, opts) {
  console.log(`\nRun  | Status    | Tier  | Wall     | Engine`);
  console.log(`-----|-----------|-------|----------|--------`);
  for (const r of results) {
    console.log(`${pad(r.run, 4)} | ${pad(r.status, 9)} | ${pad(r.tier, 5)} | ${pad(fmtMs(r.wallMs), 8)} | ${fmtMs(r.engineMs)}`);
  }

  const ok = results.filter((r) => r.status === "completed" && Number.isFinite(r.wallMs));
  const failedCount = results.length - ok.length;
  const wallSorted = ok.map((r) => r.wallMs).sort((a, b) => a - b);
  const engineSorted = ok
    .map((r) => r.engineMs)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  const wallP50 = percentile(wallSorted, 50);
  const wallP95 = percentile(wallSorted, 95);

  console.log(`\nWall-clock (subprocess spawn → exit; includes Node/tsx startup):`);
  console.log(`  min ${fmtMs(wallSorted[0])}   p50 ${fmtMs(wallP50)}   p95 ${fmtMs(wallP95)}   max ${fmtMs(wallSorted[wallSorted.length - 1])}`);

  if (engineSorted.length) {
    console.log(`\nEngine-reported (run result's durationMs; excludes process startup):`);
    console.log(
      `  min ${fmtMs(engineSorted[0])}   p50 ${fmtMs(percentile(engineSorted, 50))}   p95 ${fmtMs(percentile(engineSorted, 95))}   max ${fmtMs(engineSorted[engineSorted.length - 1])}`,
    );
  }

  const tierCounts = {};
  for (const r of ok) tierCounts[r.tier] = (tierCounts[r.tier] ?? 0) + 1;
  const dominantTier = Object.entries(tierCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const slo = dominantTier ? SLO[dominantTier] : undefined;

  console.log(`\nSLO check — docs/ARCHITECTURE.md §4 (${dominantTier ?? "unknown"}-tier, judged on wall-clock):`);
  if (ok.length === 0) {
    console.log(`  SKIP — no successful runs to judge`);
  } else if (!slo) {
    console.log(`  SKIP — no published SLO for tier "${dominantTier}"`);
  } else {
    const p50Pass = wallP50 < slo.p50;
    const p95Pass = wallP95 < slo.p95;
    console.log(`  p50 < ${slo.p50}ms:  ${fmtMs(wallP50)}  ${p50Pass ? "PASS" : "FAIL"}`);
    console.log(`  p95 < ${slo.p95}ms:  ${fmtMs(wallP95)}  ${p95Pass ? "PASS" : "FAIL"}`);
    console.log(`\n${p50Pass && p95Pass ? "✔ PASS" : "✗ FAIL"} vs ${dominantTier}-tier SLO (${ok.length}/${results.length} runs succeeded)`);
  }

  if (failedCount > 0) {
    console.log(`\nFailures (${failedCount}/${results.length}):`);
    for (const r of results.filter((r) => r.status !== "completed")) {
      console.log(`  run ${r.run}: ${r.reason || "unknown error"}`);
    }
    console.log(`\nIf every run failed, check:`);
    console.log(`  1. chromium is installed:  npx playwright install chromium`);
    console.log(`  2. this machine has network access to ${opts.url}`);
    console.log(`See docs/BENCHMARKS.md.`);
  }

  process.exitCode = ok.length === 0 ? 1 : 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log(`Portico local benchmark`);
  console.log(`  flow:  ${relPath(opts.flow)}`);
  console.log(`  url:   ${opts.url}`);
  console.log(`  mode:  ${opts.headless ? "headless" : "headed"}, ${opts.runs} run(s)\n`);

  const results = [];
  let abortReason;
  for (let i = 1; i <= opts.runs; i++) {
    if (abortReason) {
      results.push({ run: i, wallMs: NaN, engineMs: NaN, status: "skipped", tier: "n/a", reason: "environment issue detected on run 1" });
      continue;
    }

    let result;
    try {
      result = await benchOne(i, opts);
    } catch (err) {
      // Belt-and-suspenders: benchOne/runCli are designed never to throw, but
      // a bug here still must not take down the remaining runs.
      result = { run: i, wallMs: NaN, engineMs: NaN, status: "error", tier: "n/a", reason: err instanceof Error ? err.message : String(err) };
    }
    results.push(result);
    logRunLine(result, opts.runs);

    if (i === 1 && result.status !== "completed" && ENV_FAILURE_RE.test(result.reason || "")) {
      abortReason = result.reason;
      console.log(`\n✗ Environment doesn't look ready — skipping remaining ${opts.runs - 1} run(s).`);
      console.log(`  reason: ${abortReason}`);
      console.log(`  fix:    npx playwright install chromium   (and confirm network access to ${opts.url})`);
      console.log(`  see docs/BENCHMARKS.md for details.`);
    }
  }

  printReport(results, opts);
}

main().catch((err) => {
  console.error("bench.mjs crashed:", err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
