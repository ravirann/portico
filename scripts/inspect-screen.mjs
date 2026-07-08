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
//  - Portal sessions are short-lived. If the browser opens on a login page, just
//    log in + navigate; on capture we write the FRESH session back to the profile
//    so the next engine run starts already logged in.
import { createRequire } from "module";
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const require = createRequire(resolve("packages/engine") + "/");
const { launchBrowser } = require("libretto");

const args = process.argv.slice(2);
const arg = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const baseUrl = arg("--base-url") ?? "";
const profileArg = arg("--profile");
const profileName = profileArg ? profileArg.toLowerCase().replace(/[^a-z0-9]+/g, "-") : undefined;
const storageStatePath = profileName ? resolve(".libretto/profiles", `${profileName}.json`) : undefined;
const hasProfile = Boolean(storageStatePath && existsSync(storageStatePath));

const session = await launchBrowser({
  sessionName: `inspect-${Date.now()}`,
  headless: false,
  viewport: { width: 1440, height: 900 },
  ...(hasProfile ? { storageStatePath } : {}),
});
const page = session.page;
console.log(hasProfile ? `↻ loaded profile ${profileName} (session may have expired — log in if prompted)` : "· no saved profile — log in when the page opens");
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

// Persist the (now fresh) session back to the profile so the next run is logged
// in. This is the whole point of logging in during capture.
if (storageStatePath) {
  try {
    mkdirSync(dirname(storageStatePath), { recursive: true });
    const state = await session.context.storageState();
    writeFileSync(storageStatePath, JSON.stringify(state, null, 2));
    console.log(`\n✔ saved refreshed session → .libretto/profiles/${profileName}.json`);
  } catch (e) {
    console.log(`\n✗ could not save session: ${e instanceof Error ? e.message : e}`);
  }
}

await session.close();
process.exit(0);
