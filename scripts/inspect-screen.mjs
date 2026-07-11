// Capture the real accessible elements of a live portal screen, to author flow
// steps. Opens the portal (logged in via a saved --profile when the session is
// still valid), lets you navigate to the target screen, then dumps the ARIA
// tree (role + name) so we can author precise semantic steps. Standalone (plain
// Node) so it never touches the CLI's module graph.
//
//   node scripts/inspect-screen.mjs --base-url https://mychart.urmc.rochester.edu --profile mychart-urmc
//
// Notes:
//  - Uses Playwright's locator.ariaSnapshot() (page.accessibility was removed in
//    Playwright 1.6x). The output is YAML: `- button "Schedule an appointment"`.
//  - Launches a PERSISTENT on-disk profile (.portico/profiles/<name>.userdata/),
//    SHARED with record-network.mjs and the CLI runner — so one login serves them
//    all and survives across runs (a storage-state snapshot can't restore MyChart).
import { createRequire } from "module";
import { createInterface } from "node:readline/promises";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(resolve("packages/engine") + "/");
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const arg = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const baseUrl = arg("--base-url") ?? "";
const profileArg = arg("--profile") ?? "default";
const profileName = profileArg.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default";
const userDataDir = resolve(".portico/profiles", `${profileName}.userdata`);

mkdirSync(userDataDir, { recursive: true });
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: { width: 1440, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
console.log(`↻ persistent profile: .portico/profiles/${profileName}.userdata (log in once if prompted — it persists)`);
if (baseUrl) await page.goto(baseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question("\n⏸  Navigate to the screen you want to automate, then press Enter to capture… ");
rl.close();

// ARIA tree of the current screen — role + accessible name for every element,
// which is exactly what our semantic locators (getByRole/getByLabel/getByText)
// resolve against.
const snapshot = await page.locator("body").ariaSnapshot();

console.log(`\nURL: ${page.url()}`);
console.log("─".repeat(72));
console.log(snapshot);
console.log("─".repeat(72));

// Persistent context flushes the profile to disk on close — no manual save.
await context.close();
process.exit(0);
