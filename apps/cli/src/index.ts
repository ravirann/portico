#!/usr/bin/env -S node --import tsx
/**
 * portico — minimal CLI to run a flow through the engine.
 *
 *   portico run <flow.yaml> [--base-url URL] [--instance <instance.yaml>]
 *                            [--headless] [--input key=value]...
 *
 * For the live test: point --instance at connectors/example-portal/
 * instances/urmc.local.yaml and set PORTICO_SECRET_EXAMPLE_* env vars (see @portico/vault).
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parse as parseYaml } from "yaml";
import { getEngine } from "@portico/engine";
import type { Flow, Target } from "@portico/flow-spec";
import { EnvSecretProvider, resolveSecrets } from "@portico/vault";

function parseArgs(argv: string[]) {
  const [cmd, flowPath, ...rest] = argv;
  const opts: { baseUrl?: string; instance?: string; headless: boolean; json: boolean; inputs: Record<string, string> } = {
    headless: false,
    json: false,
    inputs: {},
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--headless") opts.headless = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--base-url") opts.baseUrl = rest[++i];
    else if (a === "--instance") opts.instance = rest[++i];
    else if (a === "--input") {
      const [k, ...v] = (rest[++i] ?? "").split("=");
      if (k) opts.inputs[k] = v.join("=");
    }
  }
  return { cmd, flowPath, opts };
}

async function main() {
  const { cmd, flowPath, opts } = parseArgs(process.argv.slice(2));
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
  const log = (...a: unknown[]) => { if (!opts.json) console.log(...a); };
  log(`▶ running flow "${flow.key}" via ${engine.name} (headless=${opts.headless})`);

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
    mode: "dry_run",
    onHuman,
    onStep: (t) => log(`  [${t.index}] ${t.type}${t.label ? ` — ${t.label}` : ""}: ${t.status}${t.detail ? ` (${t.detail})` : ""}`),
  });

  if (opts.json) {
    // Machine-readable run record (consumed by the console's run API).
    process.stdout.write(JSON.stringify({
      flow: flow.key,
      engine: engine.name,
      status: result.status,
      durationMs: Date.now() - startedAt,
      output: result.output,
      failure: result.failure,
      steps: result.traces.map((t) => ({
        index: t.index, type: t.type, label: t.label,
        status: t.status, detail: t.detail,
        durationMs: Math.max(0, t.endedAt - t.startedAt),
      })),
    }));
    process.exit(0);
  }

  log(`\n${result.status.toUpperCase()}`);
  if (Object.keys(result.output).length) log("output:", JSON.stringify(result.output, null, 2));
  if (result.failure) log("failure:", result.failure);
  process.exit(result.status === "completed" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
