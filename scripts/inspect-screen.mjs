// Capture the real element labels of a live portal screen, to author flow steps.
// Opens the portal (logged in via a saved --profile), lets you navigate to the
// target screen, then dumps interactive elements (role · name) so we can author
// precise semantic steps. Standalone (plain Node) so it never touches the CLI's
// module graph.
//
//   node scripts/inspect-screen.mjs --base-url https://mychart.urmc.rochester.edu --profile mychart-urmc
import { createRequire } from "module";
import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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

const session = await launchBrowser({
  sessionName: `inspect-${Date.now()}`,
  headless: false,
  viewport: { width: 1440, height: 900 },
  ...(storageStatePath && existsSync(storageStatePath) ? { storageStatePath } : {}),
});
const page = session.page;
if (baseUrl) await page.goto(baseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question("\n⏸  Navigate to the screen you want to automate, then press Enter to capture… ");
rl.close();

const snap = await page.accessibility.snapshot({ interestingOnly: true });
const wanted = new Set(["button", "link", "textbox", "combobox", "checkbox", "radio", "menuitem", "tab", "option", "heading"]);
const rows = [];
const walk = (n) => {
  if (!n) return;
  if (n.role && wanted.has(n.role) && n.name) rows.push(`  ${n.role} · ${String(n.name).slice(0, 90)}`);
  (n.children || []).forEach(walk);
};
walk(snap);

console.log(`\nURL: ${page.url()}`);
console.log(`Interactive elements (${rows.length}):`);
console.log(rows.join("\n"));
await session.close();
process.exit(0);
