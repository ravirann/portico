# Benchmarks

A **local** benchmark for Portico's per-run latency — no cloud, no new
dependencies. It runs the smoke flow through the real CLI and checks the
result against the SLOs in [ARCHITECTURE.md §4](ARCHITECTURE.md#4-latency-budget--slo).

## What it measures

`scripts/bench.mjs` runs [`examples/smoke.flow.yaml`](../examples/smoke.flow.yaml)
(a two-step DOM-tier flow: navigate to a page, extract its title) N times
through `apps/cli/src/index.ts run ... --json`, exactly as documented in the
[README](../README.md#prove-it-live-no-credentials-needed). Each run is timed
end-to-end (wall-clock, subprocess spawn → exit) and its tier is read back
from the store (`get-run`, populated by the engine's `deriveTier`). It reports
p50/p95/min/max and a pass/fail against the DOM-tier SLO — **p50 < 6s, p95 <
12s** — since that's the tier the smoke flow runs at.

This is a coarse, single-machine sanity check, not a substitute for the
platform's production latency instrumentation. It's useful for catching a
gross regression (a change that makes every run noticeably slower) between
runs on the same machine.

A run's wall-clock time includes Node/tsx process startup, because the CLI is
invoked fresh each time (it has no long-lived/in-process mode). ARCHITECTURE's
SLOs describe a warm, already-running engine — so the script also reports the
engine's own self-reported time (the run result's `durationMs`, no process
startup included) alongside wall-clock, so a wall-clock SLO miss can be told
apart from an actual engine regression. The SLO pass/fail line itself is
judged on wall-clock, per the task this script was built for — treat it as the
conservative (upper-bound) number.

Also note: the smoke flow's `extract` step has no cached locator yet (it's a
minimal demo flow, not an authored/confirmed one), so it resolves via a live
AI-extraction call each run. That call is a real, variable-latency network
request — the numbers this script reports are a conservative "cold" proxy for
DOM-tier latency, not the cached steady-state number a promoted flow would see.

## How to run

```bash
npx playwright install chromium   # one-time, if not already installed
node scripts/bench.mjs                       # 5 runs against https://example.com
node scripts/bench.mjs --runs 10             # more samples
node scripts/bench.mjs --url https://example.com --headed   # visible browser
```

Flags: `--runs N` (default 5), `--url URL` (default `https://example.com`),
`--flow PATH` (default the smoke flow), `--headed` (default headless),
`--timeout MS` (per-run kill timeout, default 60000). `--help` prints all of
these.

## Reading the output

```
Run  | Status    | Tier  | Wall     | Engine
-----|-----------|-------|----------|--------
   1 | completed | dom   | 5920ms   | 4852ms
   2 | completed | dom   | 5480ms   | 4410ms
   ...

Wall-clock (subprocess spawn → exit; includes Node/tsx startup):
  min ...   p50 ...   p95 ...   max ...

Engine-reported (run result's durationMs; excludes process startup):
  min ...   p50 ...   p95 ...   max ...

SLO check — docs/ARCHITECTURE.md §4 (dom-tier, judged on wall-clock):
  p50 < 6000ms:  ...  PASS/FAIL
  p95 < 12000ms: ...  PASS/FAIL

✔ PASS vs dom-tier SLO (5/5 runs succeeded)
```

- **Status** — `completed` / `failed` / `error` (couldn't get a result at all,
  e.g. a crash) / `skipped` (environment issue already confirmed on run 1).
- **Tier** — `api` / `dom` / `agent`, derived from what the run actually did
  (see `deriveTier` in `packages/engine/src/tier.ts`); `n/a` if it couldn't be
  read back from the store.
- A failing run doesn't stop the bench — it's recorded and the loop
  continues, **except** when run 1 fails with a signature that means the
  environment itself isn't ready (missing browser binary, DNS/network
  failure). In that case the remaining runs are skipped immediately instead of
  repeating a doomed run N times, and the reason + a fix are printed.
- Exit code is non-zero only when **every** run failed.

## Requirements

- Chromium via Playwright: `npx playwright install chromium` (one-time).
- Network access to `--url` (default `https://example.com`).

If either is missing, every run fails and the script says so explicitly
(reason + suggested fix) rather than hanging or crashing.
