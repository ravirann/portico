// Standalone agent-authoring entry, spawned by the console's /api/flows/author
// route. Kept separate from apps/cli so Stagehand's heavy module graph is loaded
// ONLY when authoring — never on the CLI's frequent list-sessions/run/etc.
//
//   node --import tsx packages/author/author-cli.mjs \
//     --goal "<text>" --start-url <url> --cdp <endpoint> [--key K] [--connector C]
//
// Drives the goal on the live CDP session, freezes the run into a deterministic
// draft flow, saves it to the store, and prints ONE JSON line to stdout:
//   { draftId, key, version, steps, finalUrl, agentSuccess }
// All human/agent logs go to stderr so stdout stays a clean JSON line.
import { createRequire } from "module";
import { resolve } from "node:path";
import { authorFlow } from "./src/index.ts";

const require = createRequire(resolve("apps/cli") + "/");
const { Store } = require(resolve("packages/store/dist/index.js"));
const { stringify: toYaml } = require("yaml");

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const die = (msg, code = 1) => {
  process.stdout.write(JSON.stringify({ error: msg }));
  process.exit(code);
};

const goal = arg("--goal");
const startUrl = arg("--start-url");
const cdpUrl = arg("--cdp");
const connector = arg("--connector");
const key = arg("--key") || "authored-flow";
if (!goal || !startUrl || !cdpUrl) {
  die("usage: author-cli.mjs --goal <text> --start-url <url> --cdp <endpoint> [--key K] [--connector C]", 2);
}

const store = new Store();
const pick = (k) => store.getConfigValue(connector ?? "", "llm", k) || store.getConfigValue("global", "llm", k);
const provider = pick("provider") || "openai";
const modelName = pick("model") || "gpt-5.5";
const apiKey = process.env.OPENAI_API_KEY || pick("api_key") || "";
// A key that decrypts to non-ASCII means PORTICO_ENCRYPTION_KEY is missing/wrong.
if (!apiKey || [...apiKey].some((c) => c.charCodeAt(0) > 126)) {
  store.close();
  die("LLM api_key is unset or unreadable — set it in Settings and ensure PORTICO_ENCRYPTION_KEY matches how it was saved (or set OPENAI_API_KEY).");
}

let result;
try {
  result = await authorFlow({
    goal,
    startUrl,
    cdpUrl,
    model: `${provider}/${modelName}`,
    apiKey,
    key,
    onLog: (l) => console.error("·", l),
  });
} catch (e) {
  store.close();
  die(`author run failed: ${e instanceof Error ? e.message : e}`);
}

const version = (store.listFlowVersions(key)[0]?.version ?? 0) + 1;
result.flow.version = version;
const draftId = `flow_${key}_v${version}_${Math.random().toString(16).slice(2, 8)}`;
store.saveFlow({
  id: draftId,
  key,
  version,
  yaml: toYaml(result.flow),
  status: "draft",
  source: "authored",
  connector: connector || undefined,
  createdAt: new Date().toISOString(),
});
store.close();

process.stdout.write(
  JSON.stringify({
    draftId,
    key,
    version,
    steps: result.flow.steps.length,
    finalUrl: result.evidence.finalUrl,
    agentSuccess: result.evidence.agentSuccess,
  }),
);
