/**
 * In-house browser launch (ADR-0004 — replaces the removed third-party
 * dependency's `launchBrowser`).
 *
 * `runner.ts` drives THREE distinct ways to get a `{ context, page }` pair:
 *   1. CDP attach to an already-running, already-logged-in browser
 *      (`scripts/serve-browser.mjs` + `chromium.connectOverCDP`).
 *   2. A PERSISTENT on-disk profile (`chromium.launchPersistentContext`),
 *      for `--profile` runs whose login should survive across runs.
 *   3. An EPHEMERAL session — fresh browser, optional storage-state snapshot,
 *      closed at the end of the run.
 *
 * (1) and (2) were already direct Playwright calls in `runner.ts`. Only (3)
 * went through the removed dependency's `launchBrowser`; `launchEphemeralBrowser`
 * below reproduces its observable behavior (headed/headless, viewport,
 * storage-state restore, the default timeouts it set on the page, and the
 * anti-automation-detection launch flag) on plain `playwright` APIs. Its own
 * session-metadata-file bookkeeping (a debug port + a JSON file under its
 * CLI's state dir, used by its own CLI to list/attach-to sessions) was CLI
 * tooling Portico never drove and is not reproduced here — Portico's own
 * session tracking is `session-manager.ts`.
 *
 * The old `createRecoveryPage` (a Proxy that auto-wrapped every Page/Locator
 * method with popup-recovery-then-retry) has no replacement here: recovery is
 * now explicit — invoked at the ONE call site that needs it (`runAct`'s heal
 * path, via `recover.ts`) — rather than implicitly on every page interaction.
 * See docs/decisions/0004-own-engine.md.
 */

import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";

export interface LaunchedSession {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

export interface LaunchEphemeralOptions {
  /** Defaults to true (headless), matching the runner's own default. */
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Restore a prior Playwright storage-state snapshot (cookies + localStorage). */
  storageStatePath?: string;
}

/**
 * Launch a fresh, ephemeral Chromium browser + context + page — the
 * no-profile, no-CDP branch of `runProgrammatic` (runner.ts), the ONLY
 * branch that used to depend on a third party for this.
 */
export async function launchEphemeralBrowser(
  opts: LaunchEphemeralOptions = {},
): Promise<LaunchedSession> {
  const { headless = true, viewport = { width: 1440, height: 900 }, storageStatePath } = opts;

  const browser = await chromium.launch({
    headless,
    // Makes automated Chromium less trivially fingerprintable by portals that
    // bot-detect on navigator.webdriver / related CDP tells (matches the
    // removed dependency's own launch flag). Its debug-port and
    // window-position flags were CLI-session-inspection conveniences
    // Portico's runner never used — not reproduced.
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport,
    ...(storageStatePath ? { storageState: storageStatePath } : {}),
  });
  const page = await context.newPage();
  // Same page-level default timeouts the removed dependency set on every page
  // it handed back — preserved so call sites that rely on the default
  // (rather than passing an explicit per-call timeout) see identical behavior.
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);

  return {
    context,
    page,
    close: () => browser.close(),
  };
}
