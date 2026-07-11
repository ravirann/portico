/**
 * In-house recovery (ADR-0004 — replaces the removed third-party
 * dependency's `attemptWithRecovery` + `popupRecoveryAction`).
 *
 * `runAct` (compiler.ts) calls `attemptWithRecovery` after its deterministic
 * candidate ladder (cached selector → semantic role/name → text) has already
 * exhausted its own retries. What actually blocks an action at that point is
 * almost always a transient obstruction — a cookie banner, a promo modal, an
 * interstitial — not a genuinely missing element (a missing element is
 * `not_found`/`ambiguous`/`unsupported`, and clicking a "Close" button
 * elsewhere on the page won't fix any of those). So recovery here is:
 *
 *   1. Deterministic overlay/popup dismissal — try a short, ordered list of
 *      common dismissal affordances with a tight per-candidate timeout; click
 *      the first one that's actually visible. No model required.
 *   2. Re-run the original action ONCE.
 *   3. If step 1 found nothing AND a heal model is configured (model.ts), ask
 *      it to pick a dismissal target from a MASKED list of visible
 *      button/link-like candidates (index + role + a truncated, PII-scrubbed
 *      name — never a screenshot or raw HTML) before the retry.
 *
 * No model configured ⇒ step 3 never runs ⇒ recovery is fully deterministic —
 * preserving "LLM never on the hot path" (docs/ARCHITECTURE.md §4) while
 * still recovering from the common case by default. The caller
 * (`runAct`) wraps the whole thing in the SAME `withHardTimeout` ceiling it
 * always has, so an unrecoverable page can't hang a run.
 */

import type { Locator, Page } from "playwright";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { classifyError, PorticoStepError } from "./errors.js";
import type { HealedBy } from "./types.js";

const PER_CANDIDATE_TIMEOUT_MS = 800;

/** Common "close this overlay" accessible names — cookie banners, promo
 *  modals, interstitials. Anchored + case-insensitive so it matches a whole
 *  (trimmed) accessible name, not an unrelated button that merely contains
 *  one of these words. */
const DISMISS_NAME_RE = /^(close|dismiss|got it|no thanks|accept|ok|×|x)$/i;

interface DismissCandidate {
  describe: string;
  locator: (page: Page) => Locator;
}

/** Ordered, most-specific-first — matches the task's affordance list verbatim. */
const DETERMINISTIC_CANDIDATES: DismissCandidate[] = [
  { describe: 'role=button name~/close|dismiss|got it|no thanks|accept|ok|×|x/i', locator: (page) => page.getByRole("button", { name: DISMISS_NAME_RE }) },
  { describe: '[aria-label*="close" i]', locator: (page) => page.locator('[aria-label*="close" i]') },
  { describe: "[data-dismiss]", locator: (page) => page.locator("[data-dismiss]") },
];

/**
 * Try each deterministic candidate in order; click the first one that becomes
 * visible within its own short budget. Never throws — a page that doesn't
 * expose ANY of these affordances (or isn't even a real Playwright Page, as
 * in unit-test stubs) just means "nothing found", not a hard failure.
 */
async function tryDeterministicDismiss(page: Page): Promise<string | undefined> {
  for (const candidate of DETERMINISTIC_CANDIDATES) {
    try {
      const loc = candidate.locator(page).first();
      await loc.waitFor({ state: "visible", timeout: PER_CANDIDATE_TIMEOUT_MS });
      await loc.click({ timeout: PER_CANDIDATE_TIMEOUT_MS });
      return candidate.describe;
    } catch {
      // Not visible/clickable within budget, or the page doesn't support this
      // affordance at all — fall through to the next candidate.
    }
  }
  return undefined;
}

const BROAD_CLICKABLE_SELECTOR = 'button, [role="button"], a, [role="link"]';
const MAX_MODEL_CANDIDATES = 12;
const MAX_SCANNED_ELEMENTS = 40;

interface MaskedCandidate {
  index: number;
  locator: Locator;
  masked: string;
}

/** Scrub a candidate's visible text before it ever leaves the process: cap
 *  length and blank out email- and long-digit-shaped substrings (phone/ID/
 *  account numbers) so a dismissal-target prompt can't leak page contents. */
function maskText(raw: string): string {
  return raw
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .replace(/\d{4,}/g, "[digits]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

/** Collect a masked list of visible, plausibly-clickable elements for the
 *  model to choose from. Best-effort throughout — a page that can't be
 *  queried this way (or a test stub) yields an empty list, not a throw. */
async function collectMaskedCandidates(page: Page): Promise<MaskedCandidate[]> {
  try {
    const loc = page.locator(BROAD_CLICKABLE_SELECTOR);
    const count = Math.min(await loc.count().catch(() => 0), MAX_SCANNED_ELEMENTS);
    const out: MaskedCandidate[] = [];
    for (let i = 0; i < count && out.length < MAX_MODEL_CANDIDATES; i++) {
      const el = loc.nth(i);
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      let name = "";
      try {
        name = (await el.innerText({ timeout: 200 })) || (await el.getAttribute("aria-label")) || "";
      } catch {
        /* best-effort — an empty name just makes this candidate less useful */
      }
      out.push({ index: out.length, locator: el, masked: maskText(name) });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Ask the configured heal model to pick a dismissal target from a MASKED
 * candidate list (never a screenshot, never raw HTML). Best-effort: any
 * failure (no candidates, a bad/absent model response, a stale locator by the
 * time we click) degrades to "nothing picked" rather than throwing — this is
 * an optional enhancement on top of the deterministic step, never a new
 * failure mode.
 */
async function tryModelAssistedDismiss(page: Page, model: LanguageModel): Promise<string | undefined> {
  const candidates = await collectMaskedCandidates(page);
  if (candidates.length === 0) return undefined;

  let picked: number | null = null;
  try {
    const { generateObject } = await import("ai");
    const listing = candidates.map((c) => `${c.index}: "${c.masked}"`).join("\n");
    const { object } = await generateObject({
      model,
      schema: z.object({ index: z.number().int().nullable() }),
      prompt:
        "A UI action just failed — possibly because a popup, modal, cookie banner, or interstitial is blocking " +
        "interaction. Below is a masked list of visible clickable elements on the page, as `index: \"name\"`. " +
        "Reply with the index of the element most likely to DISMISS a blocking overlay (a close/dismiss/accept/" +
        "got-it control). Reply with null if none of them look like a dismissal control.\n\n" +
        listing,
      temperature: 0,
    });
    picked = object.index;
  } catch {
    return undefined;
  }
  if (picked == null) return undefined;
  const chosen = candidates.find((c) => c.index === picked);
  if (!chosen) return undefined;

  try {
    await chosen.locator.click({ timeout: PER_CANDIDATE_TIMEOUT_MS });
    return `model-picked "${chosen.masked}"`;
  } catch {
    return undefined;
  }
}

/** Playwright's own wording for a page/context/browser that's gone — recovery
 *  can't do anything useful there, so don't try (the removed dependency's own
 *  `attemptWithRecovery` had the same short-circuit). */
const CLOSED_PAGE_RE = /Target closed|browser has been closed|context or browser has been closed/i;

export interface RecoverOptions {
  /** Optional heal/extract model (model.ts's `HealModel.languageModel`).
   *  Present ⇒ step 3 (model-assisted dismissal target) is available.
   *  Absent ⇒ recovery is fully deterministic (steps 1–2 only). */
  languageModel?: LanguageModel;
  /**
   * The error that made the caller decide to attempt recovery — `runAct`
   * passes the failure its own deterministic candidate ladder just exhausted.
   * When it's a closed page/context/browser, or the run is being aborted,
   * recovery short-circuits immediately (rethrows `cause` as-is) instead of
   * spending time on dismissal candidates or a retry that can't possibly
   * help either case.
   */
  cause?: unknown;
}

export interface RecoverResult<T> {
  value: T;
  /** Description of what was dismissed, when recovery found something to
   *  click. Undefined when the retry alone succeeded (a transient failure
   *  cleared on its own) with nothing actually dismissed. */
  dismissed?: string;
  /** What the successful recovery leaned on. `"model"` only when the heal
   *  model picked the dismissal target that was clicked before the retry;
   *  a deterministic dismissal — or a bare retry that succeeded after the
   *  model was consulted but picked nothing — is `"deterministic"`. Feeds
   *  StepTrace.healedBy, so tier.ts only counts real model assists as agent. */
  healedBy: HealedBy;
}

/**
 * Try a deterministic overlay/popup dismissal (optionally model-assisted —
 * see module doc), then run `action` ONCE. `action` has already failed once
 * by the time this is called (`runAct`'s candidate ladder + its own retries)
 * — this does NOT re-try it first; it goes straight to dismissal, then the
 * ONE re-attempt. Throws a classified `PorticoStepError` if that re-attempt
 * also fails. Callers that need a hard ceiling should wrap this call in
 * `withHardTimeout` (compiler.ts's `runAct` does).
 */
export async function attemptWithRecovery<T>(
  page: Page,
  action: () => Promise<T>,
  opts: RecoverOptions = {},
): Promise<RecoverResult<T>> {
  if (opts.cause !== undefined) {
    const message = opts.cause instanceof Error ? opts.cause.message : String(opts.cause);
    if (CLOSED_PAGE_RE.test(message)) throw opts.cause;
    // The run is being cancelled — spending more time dismissing overlays
    // would just delay an outcome the caller no longer wants.
    if (classifyError(opts.cause).kind === "aborted") throw opts.cause;
  }

  let healedBy: HealedBy = "deterministic";
  let dismissed = await tryDeterministicDismiss(page);
  if (!dismissed && opts.languageModel) {
    dismissed = await tryModelAssistedDismiss(page, opts.languageModel);
    if (dismissed) healedBy = "model";
  }

  try {
    const value = await action();
    return { value, dismissed, healedBy };
  } catch (retryError) {
    const { kind: retryKind } = classifyError(retryError);
    const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
    const context = dismissed
      ? `dismissed (${dismissed}) but the retry still failed`
      : "found nothing to dismiss and the retry still failed";
    throw new PorticoStepError(retryKind, `recovery attempted — ${context}: ${retryMessage}`);
  }
}
