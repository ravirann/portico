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
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getEngine, compileRecording, evaluateValidation, refineFlow, resolveHealModel, listSessions } from "@portico/engine";
import type { RunMode, Recording } from "@portico/engine";
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
  cdp?: string;
  key?: string;
  intercept?: string;
  out?: string;
  connector?: string;
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
    else if (a === "--cdp") opts.cdp = rest[++i];
    else if (a === "--key") opts.key = rest[++i];
    else if (a === "--intercept") opts.intercept = rest[++i];
    else if (a === "--out") opts.out = rest[++i];
    else if (a === "--connector") opts.connector = rest[++i];
    else if (a === "--input") {
      const [k, ...v] = (rest[++i] ?? "").split("=");
      if (k) opts.inputs[k] = v.join("=");
    }
  }
  return { cmd, flowPath, opts };
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
  if (cmd === "list-flows") {
    const store = new Store();
    const flows = store.listFlows(100).map((f) => ({ ...f, validation: store.latestValidation(f.id) ?? null }));
    store.close();
    process.stdout.write(JSON.stringify(flows));
    process.exit(0);
  }
  if (cmd === "get-flow") {
    const store = new Store();
    const flow = flowPath ? store.getFlow(flowPath) : undefined;
    const out = flow ? { ...flow, validation: store.latestValidation(flow.id) ?? null } : null;
    store.close();
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }
  if (cmd === "list-sessions") {
    const store = new Store();
    const sessions = listSessions(store, Date.now());
    store.close();
    process.stdout.write(JSON.stringify(sessions));
    process.exit(0);
  }
  if (cmd === "close-session") {
    if (!flowPath) { console.error("usage: portico close-session <id>"); process.exit(2); }
    const store = new Store();
    store.closeBrowserSession(flowPath, new Date().toISOString());
    store.close();
    if (opts.json) process.stdout.write(JSON.stringify({ id: flowPath, closed: true }));
    else console.log(`✔ closed session ${flowPath}`);
    process.exit(0);
  }
  // LLM refine pass — clean a draft's coarse act names into a new (llm) draft.
  if (cmd === "refine") {
    const store = new Store();
    const rec = flowPath ? store.getFlow(flowPath) : undefined;
    if (!rec) { store.close(); console.error(`no flow with id "${flowPath ?? ""}"`); process.exit(2); }
    const draft = parseYaml(rec.yaml) as Flow;
    const heal = await resolveHealModel();
    if (!heal) {
      store.close();
      const msg = "no model configured — set PORTICO_HEAL_PROVIDER + PORTICO_HEAL_API_KEY to refine";
      if (opts.json) process.stdout.write(JSON.stringify({ error: msg }));
      else console.error(`✗ ${msg}`);
      process.exit(1);
    }
    const emptyRec: Recording = { baseUrl: "", clicks: [], network: [] };
    const refined = await refineFlow(draft, emptyRec, heal.languageModel);
    const version = (store.listFlowVersions(rec.key)[0]?.version ?? 0) + 1;
    const id = `flow_${rec.key}_v${version}_${Math.random().toString(16).slice(2, 8)}`;
    store.saveFlow({
      id, key: rec.key, version, yaml: stringifyYaml(refined), status: "draft", source: "llm",
      connector: rec.connector, createdAt: new Date().toISOString(),
    });
    store.close();
    if (opts.json) process.stdout.write(JSON.stringify({ id, key: rec.key, version, source: "llm", steps: refined.steps.length }));
    else console.log(`✔ refined "${rec.key}" → new draft v${version} (id=${id}, ${refined.steps.length} steps)`);
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
      if (opts.json) process.stdout.write(JSON.stringify({ flowId: rec.id, confirmed: false, error: msg }));
      else console.error(`✗ ${msg}`);
      process.exit(1);
    }
    store.confirmFlow(rec.id);
    store.close();
    if (opts.json) process.stdout.write(JSON.stringify({ flowId: rec.id, key: rec.key, version: rec.version, confirmed: true }));
    else console.log(`✔ confirmed "${rec.key}" v${rec.version} — validated and live-eligible.`);
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
    const yamlStr = stringifyYaml(flow);

    const store = new Store();
    const version = (store.listFlowVersions(key)[0]?.version ?? 0) + 1;
    const id = `flow_${key}_v${version}_${Math.random().toString(16).slice(2, 8)}`;
    store.saveFlow({
      id, key, version, yaml: yamlStr, status: "draft", source: "recorded",
      connector: opts.connector, createdAt: new Date().toISOString(),
    });
    store.close();

    const outPath = opts.out ?? `connectors/${opts.connector ?? "generated"}/flows/${key}.draft.flow.yaml`;
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, yamlStr);

    if (opts.json) {
      process.stdout.write(JSON.stringify({ id, key, version, status: "draft", steps: flow.steps.length, out: outPath }));
    } else {
      console.log(`✔ compiled recording → draft flow "${key}" v${version} (${flow.steps.length} steps)`);
      console.log(`  persisted draft id=${id}`);
      console.log(`  wrote ${outPath}\n`);
      console.log(yamlStr);
      console.log("Review it, then validate + confirm before it goes live.");
    }
    process.exit(0);
  }

  if ((cmd !== "run" && cmd !== "validate") || !flowPath) {
    console.error("usage: portico <run <flow.yaml> | validate <flow-id> | confirm <flow-id> | compile <recording.json> | list-flows | get-flow <id> | list-runs | get-run <id>>");
    process.exit(2);
  }

  // `validate <flow-id>` runs a STORED draft (loaded from the store); `run
  // <flow.yaml>` runs a flow file. Both share the execution pipeline below.
  let flowId: string | undefined;
  let flow: Flow;
  if (cmd === "validate") {
    const s0 = new Store();
    const rec = s0.getFlow(flowPath);
    s0.close();
    if (!rec) { console.error(`no flow with id "${flowPath}"`); process.exit(2); }
    flowId = rec.id;
    flow = parseYaml(rec.yaml) as Flow;
  } else {
    flow = parseYaml(readFileSync(flowPath, "utf8")) as Flow;
  }
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
    cdpEndpoint: opts.cdp,
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
    if (opts.json) {
      process.stdout.write(JSON.stringify({ flowId, passed: verdict.passed, reasons: verdict.reasons, runId }));
    } else {
      console.log(`\n${verdict.passed ? "✔ VALIDATION PASSED" : "✗ VALIDATION FAILED"}`);
      for (const r of verdict.reasons) console.log(`  - ${r}`);
      if (verdict.passed) console.log(`  → confirm it:  node --import tsx apps/cli/src/index.ts confirm ${flowId}`);
    }
    process.exit(verdict.passed ? 0 : 1);
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
