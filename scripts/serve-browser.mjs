// Long-lived, logged-in browser that flow runs attach to over CDP — so you log
// in ONCE and every `run --cdp ...` reuses the SAME session. No re-login per run.
//
//   node scripts/serve-browser.mjs \
//     --base-url https://mychart.urmc.rochester.edu --profile mychart-urmc [--port 9222]
//
// Log into MyChart in the window it opens, then LEAVE IT RUNNING. In another
// terminal, run flows with:  --cdp http://localhost:9222
// Press Ctrl-C here when you're done to close the browser.
import { createRequire } from "module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(resolve("packages/engine") + "/");
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const arg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const baseUrl = arg("--base-url", "");
const profileArg = arg("--profile", "default");
const port = Number(arg("--port", "9222"));
const profileName = profileArg.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default";
const userDataDir = resolve(".libretto/profiles", `${profileName}.userdata`);

mkdirSync(userDataDir, { recursive: true });
// Expose CDP so runs can attach. Persistent profile keeps the login on disk too.
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [`--remote-debugging-port=${port}`],
});
const page = context.pages()[0] ?? (await context.newPage());
if (baseUrl) await page.goto(baseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

console.log(`\n● browser ready — CDP endpoint: http://localhost:${port}`);
console.log(`  profile: .libretto/profiles/${profileName}.userdata`);
console.log("\n  1) Log into the portal in this window.");
console.log("  2) Leave it open.");
console.log("  3) In another terminal, run flows with:  --cdp http://localhost:" + port);
console.log("\n  (Ctrl-C here to close the browser.)\n");

const shutdown = async () => {
  await context.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Stay alive until Ctrl-C, keeping the session warm.
await new Promise(() => {});
