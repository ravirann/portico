// Record the CLICK sequence of a live wizard, so we can author precise `act`
// steps (real selectors, not guesses) and automate the navigation. Opens the
// persistent profile, installs a click logger that survives SPA steps and page
// loads, lets you drive the flow, then prints each click's target (role +
// accessible text + a stable locator hint).
//
//   node scripts/record-actions.mjs \
//     --base-url https://mychart.urmc.rochester.edu --profile mychart-urmc
//
// Log in, click through specialty → reason → location until the appointment
// TIMES appear, then press Enter. Paste the printed CLICKS back for authoring.
import { createRequire } from "module";
import { createInterface } from "node:readline/promises";
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
const profileName = profileArg.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default";
const userDataDir = resolve(".portico/profiles", `${profileName}.userdata`);

const clicks = [];

mkdirSync(userDataDir, { recursive: true });
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: { width: 1440, height: 900 },
});

// Node-side sink the page calls on every click. Survives navigations because the
// binding is re-exposed and the init script re-runs on each document.
await context.exposeBinding("__recordClick", (_src, data) => {
  clicks.push(data);
});
await context.addInitScript(() => {
  document.addEventListener(
    "click",
    (e) => {
      const t = e.target;
      const el =
        (t.closest && t.closest("button,a,[role=button],[role=option],[role=radio],[role=tab],[role=menuitem],[role=link],label,li")) || t;
      const txt = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 70);
      try {
        // @ts-ignore — exposed by exposeBinding
        window.__recordClick({
          tag: el.tagName,
          role: el.getAttribute && el.getAttribute("role"),
          ariaLabel: el.getAttribute && el.getAttribute("aria-label"),
          text: txt,
          id: el.id || null,
          name: el.getAttribute && el.getAttribute("name"),
          testid: (el.getAttribute && (el.getAttribute("data-testid") || el.getAttribute("data-test-id"))) || null,
          href: el.getAttribute && el.getAttribute("href"),
        });
      } catch {
        /* binding not ready yet — ignore */
      }
    },
    true,
  );
});

const page = context.pages()[0] ?? (await context.newPage());
console.log(`↻ persistent profile: .portico/profiles/${profileName}.userdata`);
console.log("● recording clicks (role · text) — drive the wizard normally");
if (baseUrl) await page.goto(baseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question("\n⏸  Log in, then click specialty → reason → location until TIMES appear, then press Enter… ");
rl.close();
await context.close();

console.log(`\n✔ recorded ${clicks.length} click(s):\n`);
clicks.forEach((c, i) => {
  const label = c.ariaLabel || c.text || c.id || c.name || "(no text)";
  const how = c.role ? `role=${c.role}` : `<${(c.tag || "").toLowerCase()}>`;
  console.log(`  ${String(i + 1).padStart(2)}. ${how} · "${label}"${c.testid ? `  [testid=${c.testid}]` : ""}`);
});
console.log("\n(paste the above back to author the act steps)");
process.exit(0);
