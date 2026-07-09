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
import { createServer } from "node:net";

const require = createRequire(resolve("packages/engine") + "/");
const { chromium } = require("playwright");

/**
 * Ask the OS for a currently-free localhost TCP port. Used when no explicit
 * --port is given so each session gets its OWN CDP endpoint — hardcoding one
 * port (the old default 9222) made every connector's browser collide on the
 * same endpoint, so the session→browser binding drifted and authoring could
 * attach to the wrong (or wrong-portal) window. There's a tiny window between
 * closing this probe and Chromium binding the port; on a single host that's
 * acceptable, and a busy port simply fails the launch loudly rather than
 * silently mis-binding.
 */
function findFreePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

const args = process.argv.slice(2);
const arg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const baseUrl = arg("--base-url", "");
const profileArg = arg("--profile", "default");
// Honor an explicit --port (back-compat); otherwise allocate a free one so
// multiple sessions never fight over a single hardcoded port.
const portArg = arg("--port", "");
const port = portArg ? Number(portArg) : await findFreePort();
const tenant = arg("--tenant", "default");
const connector = arg("--connector", "");
const profileName = profileArg.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default";
const userDataDir = resolve(".libretto/profiles", `${profileName}.userdata`);

// Track this browser as a long-lived session so it shows up in the store
// (visible in the console, kept alive via a keep-alive touch, and closable).
// @portico/store's "exports" point at its TS source, which plain node (no
// tsx loader here) can't execute directly, so resolve straight to its built
// dist rather than through the bare "@portico/store" specifier — run
// `pnpm build` (or `pnpm --filter @portico/store build`) at least once
// before using this script if session tracking is missing.
let store = null;
try {
  const { Store } = require(resolve("packages/store/dist/index.js"));
  store = new Store();
} catch (err) {
  console.warn(
    `⚠ session tracking disabled (@portico/store build not found — run "pnpm build"): ${err.message}`,
  );
}
const sessionId = "sess_" + Math.random().toString(16).slice(2, 10) + Date.now().toString(16);

mkdirSync(userDataDir, { recursive: true });
// Expose CDP so runs can attach. Persistent profile keeps the login on disk too.
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [`--remote-debugging-port=${port}`],
});
const page = context.pages()[0] ?? (await context.newPage());
if (baseUrl) await page.goto(baseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

// Use 127.0.0.1, NOT "localhost": Chrome's --remote-debugging-port binds IPv4
// only, but "localhost" can resolve to ::1 (IPv6) first — where an unrelated
// listener (e.g. Docker's *:port) may answer, so a probe hits the wrong service.
const cdpEndpoint = `http://127.0.0.1:${port}`;
if (store) {
  store.createBrowserSession({
    id: sessionId,
    tenant,
    profile: profileName,
    cdpEndpoint,
    startedAt: new Date().toISOString(),
    connector: connector || undefined,
  });
}

console.log(`\n● browser ready — CDP endpoint: ${cdpEndpoint}`);
console.log(`  profile: .libretto/profiles/${profileName}.userdata`);
if (store) console.log(`  session:  ${sessionId} (tenant: ${tenant})`);
console.log("\n  1) Log into the portal in this window.");
console.log("  2) Leave it open.");
console.log("  3) In another terminal, run flows with:  --cdp http://127.0.0.1:" + port);
console.log("\n  (Ctrl-C here to close the browser.)\n");

// Keep the tracked session (and the portal's own session) from idling out:
// bump last-active in the store and make a credentialed same-origin request.
// NEVER page.reload() here — runs attach to this same tab over CDP, and a
// keep-alive reload landing mid-run blows away whatever the run (or a human)
// was doing. A fetch refreshes the server-side session TTL without navigating,
// so the DOM, SPA state, and any in-flight run are untouched.
const keepAliveTimer = setInterval(async () => {
  try {
    if (store) store.touchBrowserSession(sessionId, new Date().toISOString());
    await page.evaluate("fetch(location.href, { credentials: 'include' }).catch(() => {})");
  } catch {
    // Best-effort — a failed nudge/touch shouldn't take the server down.
  }
}, 60_000);

const shutdown = async () => {
  clearInterval(keepAliveTimer);
  if (store) {
    try {
      store.closeBrowserSession(sessionId, new Date().toISOString());
    } catch {
      // Best-effort close — don't block shutdown on it.
    }
    store.close();
  }
  await context.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Stay alive until Ctrl-C, keeping the session warm.
await new Promise(() => {});
