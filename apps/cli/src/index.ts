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

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parse as parseYaml } from "yaml";
import { getEngine } from "@portico/engine";
import type { RunMode } from "@portico/engine";
import type { Flow, Target } from "@portico/flow-spec";
import { EnvSecretProvider, resolveSecrets } from "@portico/vault";
import { Store } from "@portico/store";

interface CliOpts {
  baseUrl?: string;
  instance?: string;
  headless: boolean;
  json: boolean;
  live: boolean;
  profile?: string;
  inputs: Record<string, string>;
}

function parseArgs(argv: string[]) {
  const [cmd, flowPath, ...rest] = argv;
  // Default headless: the engine drives a real browser and most runs are
  // unattended. --headed opts into a visible window (for manual login/HITL).
  const opts: CliOpts = { headless: true, json: false, live: false, inputs: {} };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--headless") opts.headless = true;
    else if (a === "--headed") opts.headless = false;
    else if (a === "--live") opts.live = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--base-url") opts.baseUrl = rest[++i];
    else if (a === "--instance") opts.instance = rest[++i];
    else if (a === "--profile") opts.profile = rest[++i];
    else if (a === "--input") {
      const [k, ...v] = (rest[++i] ?? "").split("=");
      if (k) opts.inputs[k] = v.join("=");
    }
  }
  return { cmd, flowPath, opts };
}

async function main() {
  const { cmd, flowPath, opts } = parseArgs(process.argv.slice(2));

  // Read commands — query the durable store as JSON (the console spawns these
  // so native SQLite stays in a plain Node process, out of the Next bundle).
  if (cmd === "list-runs") {
    const store = new Store();
    process.stdout.write(JSON.stringify(store.listRuns(50)));
    store.close();
    process.exit(0);
  }
  if (cmd === "get-run") {
    const store = new Store();
    const run = flowPath ? store.getRun(flowPath) : undefined;
    store.close();
    process.stdout.write(JSON.stringify(run ?? null));
    process.exit(0);
  }

  if (cmd !== "run" || !flowPath) {
    console.error("usage: portico run <flow.yaml> [--base-url URL] [--instance file] [--headless] [--input k=v]");
    process.exit(2);
  }

  const flow = parseYaml(readFileSync(flowPath, "utf8")) as Flow;
  const instance = opts.instance ? (parseYaml(readFileSync(opts.instance, "utf8")) as Record<string, any>) : {};

  const baseUrl: string = opts.baseUrl ?? instance.base_url ?? "";
  const host = instance.host ?? (baseUrl ? new URL(baseUrl).host : "");
  const target: Target = {
    key: flow.key,
    name: flow.key,
    base_url: baseUrl,
    allowed_domains: host ? [host] : [],
    auth: instance.auth ?? "",
  };

  const secretRefs: Record<string, string> = instance.secrets ?? {};
  const secrets = Object.keys(secretRefs).length
    ? await resolveSecrets(new EnvSecretProvider(), secretRefs)
    : {};

  const engine = getEngine("libretto");
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
    onHuman,
    onStep: (t) => log(`  [${t.index}] ${t.type}${t.label ? ` — ${t.label}` : ""}: ${t.status}${t.detail ? ` (${t.detail})` : ""}`),
  });

  const runId = "run_" + Math.random().toString(16).slice(2, 8);
  const durationMs = Date.now() - startedAt;
  const steps = result.traces.map((t) => ({
    index: t.index, type: t.type, label: t.label,
    status: t.status, detail: t.detail,
    healedFrom: t.healedFrom, healedTo: t.healedTo, screenshotRef: t.screenshotRef,
    durationMs: Math.max(0, t.endedAt - t.startedAt),
  }));

  // Persist the run + append-only audit to the durable store. Best-effort:
  // a persistence failure must not fail the run itself.
  try {
    const store = new Store();
    store.createRun({
      id: runId, connector: instance.instance ?? "cli", flow: flow.key, engine: engine.name,
      tier: "dom", status: result.status, mode,
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

  if (opts.json) {
    // Machine-readable run record (consumed by the console's run API).
    process.stdout.write(JSON.stringify({
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
    }));
    process.exit(0);
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
