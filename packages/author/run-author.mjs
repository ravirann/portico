// Manual spike runner: agent authors a deterministic flow from a goal.
//   node --import tsx packages/author/run-author.mjs "<goal>" <startUrl> [cdpUrl]
// Reads the LLM config from the store (provider/model/api_key), attaches to the
// logged-in CDP browser, drives the goal, prints the compiled flow YAML.
import { createRequire } from "module";
import { resolve } from "node:path";
import { authorFlow } from "./src/index.ts";

const require = createRequire(resolve("apps/cli") + "/");
const { Store } = require(resolve("packages/store/dist/index.js"));
const { stringify: toYaml } = require("yaml");

const [goal, startUrl, cdpUrl = "http://localhost:9222"] = process.argv.slice(2);
if (!goal || !startUrl) {
  console.error('usage: run-author.mjs "<goal>" <startUrl> [cdpUrl]');
  process.exit(2);
}

const store = new Store();
const pick = (k) => store.getConfigValue("global", "llm", k);
const provider = pick("provider") || "openai";
const modelName = pick("model") || "gpt-5.5";
let apiKey = pick("api_key");
store.close();

// The stored key is unreadable if it was encrypted with a PORTICO_ENCRYPTION_KEY
// this process doesn't have (base64-decoding ciphertext yields non-ASCII junk).
// Prefer an explicit env key, and fall back to it when the stored one looks corrupt.
const envKey = process.env.PORTICO_AUTHOR_API_KEY || process.env.OPENAI_API_KEY;
const looksCorrupt = !apiKey || [...apiKey].some((c) => c.charCodeAt(0) > 126);
if (looksCorrupt) {
  if (!envKey) {
    console.error(
      "LLM api_key in the store is unreadable (encrypted with a PORTICO_ENCRYPTION_KEY this\n" +
        "process lacks). Provide a key via env instead:\n" +
        '  OPENAI_API_KEY=sk-... node --import tsx packages/author/run-author.mjs "<goal>" <startUrl>',
    );
    process.exit(1);
  }
  apiKey = envKey;
  console.error("· using OPENAI_API_KEY from env (stored key was unreadable)");
} else if (envKey) {
  apiKey = envKey;
}

const result = await authorFlow({
  goal,
  startUrl,
  cdpUrl,
  model: `${provider}/${modelName}`,
  apiKey,
  key: "authored-flow",
  maxSteps: Number(process.env.PORTICO_AUTHOR_MAXSTEPS) || 12,
  onLog: (l) => console.error("·", l),
});

console.error("\n=== agent evidence ===");
console.error("success:", result.evidence.agentSuccess, "| final:", result.evidence.finalUrl);
console.error("data endpoints seen:", result.evidence.dataEndpoints.join(", ") || "(none)");
console.error("\n=== captured write/search requests (method path — body) ===");
for (const r of result.evidence.writeRequests ?? []) {
  console.error(`  ${r.method} ${r.pathname}  —  ${(r.postData ?? "").slice(0, 160)}`);
}
// Dump full evidence for inspection when PORTICO_AUTHOR_DUMP is set.
if (process.env.PORTICO_AUTHOR_DUMP) {
  require("fs").writeFileSync(process.env.PORTICO_AUTHOR_DUMP, JSON.stringify(result.evidence, null, 2));
  console.error(`(evidence dumped to ${process.env.PORTICO_AUTHOR_DUMP})`);
}

console.error("\n=== compiled deterministic flow ===\n");
console.log(toYaml(result.flow));
