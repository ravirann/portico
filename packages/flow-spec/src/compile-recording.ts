/**
 * Recording → flow-draft compiler.
 *
 * This is the deterministic, rule-based half of turning a recorded human
 * demonstration (clicks + the network traffic the page made while they
 * happened) into a runnable Portico `Flow`. An LLM pass refines the draft
 * later (better labels, dropped noise, smarter intercept picks) — but this
 * module has to stand on its own: given the same recording, it must always
 * produce the same flow, with no model call and no network access.
 *
 * The shape it emits is the "harvest" pattern used throughout the engine
 * (see compiler.ts / pick-slot.ts): navigate to the page, register an
 * `intercept` for the JSON endpoint that actually carries the data of
 * interest, replay the clicks that got the page to fire that request, `wait`
 * for the interceptor to populate its output key, then `select` one item
 * from the harvested list by policy. We deliberately never replay a
 * booking/confirm click — the flow this compiler emits is guard-railed with
 * `no_booking` so it can only ever read a portal, never act on it.
 *
 * Pipeline:
 *   1. intercept  — the best-guess "data" endpoint from `rec.network`
 *                    (skipped entirely if no JSON candidate exists). Emitted
 *                    BEFORE navigate: SPAs fire their data request during the
 *                    initial page load, and a listener registered after
 *                    `navigate` returns races (and often loses) that response.
 *   2. navigate   — the recording's `baseUrl`.
 *   3. act…       — one per meaningful click; login/auth clicks, the final
 *                    booking/slot-picking click, and no-op toggle pairs
 *                    (open + close with nothing in between) filtered out.
 *   4. wait       — only if step 1 emitted an intercept.
 *   5. select     — only if step 1 emitted an intercept AND its response
 *                    body looks like it carries slot/time data.
 */

import type { Flow, Step } from "./index.js";

export interface ClickEvent {
  tag?: string;
  role?: string | null;
  ariaLabel?: string | null;
  text?: string;
  id?: string | null;
  name?: string | null;
  testid?: string | null;
  href?: string | null;
  url?: string; // page URL when clicked
  /** Absolute XPath of the clicked element (`xpath=/html[1]/…`). Not compiled
   *  into a step — used only to correlate a DOM click with the agent's own
   *  action stream during authoring (see packages/author agent-actions). */
  xpath?: string | null;
}

export interface NetworkEntry {
  method?: string;
  url: string;
  resourceType?: string;
  status?: number | null;
  contentType?: string | null;
  responseBodyPreview?: string | null;
  responseBodyBytes?: number | null;
}

export interface Recording {
  baseUrl: string;
  clicks: ClickEvent[];
  network: NetworkEntry[];
}

export interface CompileRecordingOptions {
  /** Flow key. Default "recorded-flow". */
  key?: string;
  /** Hint for the data endpoint, e.g. "GetSlots" or "slot". */
  interceptKeyword?: string;
  /**
   * Emit the `select` "pick earliest slot" step when the data looks slot-shaped.
   * Default true (the recorder path). Set FALSE for agent-authored flows: the
   * select's `Solutions.0.Slots` path is specific to one portal's response shape,
   * so guessing it on an arbitrary portal produces a step that fails on data that
   * doesn't share that structure. Authored flows harvest the data and stop.
   */
  emitSelect?: boolean;
}

// ---------------------------------------------------------------------------
// Intercept-candidate selection
// ---------------------------------------------------------------------------

/** Path segments that suggest "this response carries the data we care about". */
const DATA_PATH_RE = /slot|appoint|avail|schedul|result|search/i;

/** A JSON(-ish) response from an XHR/fetch that succeeded. */
function isJsonDataEntry(entry: NetworkEntry): boolean {
  if (entry.status == null || entry.status < 200 || entry.status >= 300) return false;
  const contentType = (entry.contentType ?? "").toLowerCase();
  if (!contentType.includes("json") && !contentType.includes("graphql")) return false;
  const resourceType = (entry.resourceType ?? "").toLowerCase();
  return resourceType === "xhr" || resourceType === "fetch";
}

/** Largest `responseBodyBytes` wins; ties (or all-unknown sizes) fall back to the last entry. */
function pickLargestOrLast(pool: NetworkEntry[]): NetworkEntry {
  let best = pool[0]!;
  let bestBytes = best.responseBodyBytes ?? -1;
  for (let i = 1; i < pool.length; i++) {
    const entry = pool[i]!;
    const bytes = entry.responseBodyBytes ?? -1;
    if (bytes >= bestBytes) {
      best = entry;
      bestBytes = bytes;
    }
  }
  return best;
}

/**
 * Choose the network entry to `intercept`, tiered from most to least specific:
 * an explicit keyword hint, then a path that looks data-shaped, then (as a
 * last resort) simply the biggest JSON response seen. Returns undefined when
 * nothing in the recording looks like a JSON data endpoint at all — the
 * caller then skips intercept/wait/select entirely.
 */
function selectInterceptCandidate(network: NetworkEntry[], keyword?: string): NetworkEntry | undefined {
  const jsonCandidates = network.filter(isJsonDataEntry);
  if (jsonCandidates.length === 0) return undefined;

  const trimmedKeyword = keyword?.trim();
  if (trimmedKeyword) {
    const lower = trimmedKeyword.toLowerCase();
    const matches = jsonCandidates.filter((entry) => entry.url.toLowerCase().includes(lower));
    if (matches.length > 0) return pickLargestOrLast(matches);
  }

  const pathMatches = jsonCandidates.filter((entry) => DATA_PATH_RE.test(pathnameOf(entry.url)));
  if (pathMatches.length > 0) return pickLargestOrLast(pathMatches);

  return pickLargestOrLast(jsonCandidates);
}

/** The URL's pathname, tolerating relative/malformed URLs (falls back to the pre-`?` string). */
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

/** The last non-empty path segment — used only for a human-readable step label. */
function basenameOf(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : pathname;
}

/** Does the harvested response look like it carries slot/appointment-time data? */
function looksLikeSlotData(preview?: string | null): boolean {
  if (!preview) return false;
  return /DisplayDateTimeUtc|TimeString|DateString|StartTime/i.test(preview);
}

// ---------------------------------------------------------------------------
// Click → act filtering and locator synthesis
// ---------------------------------------------------------------------------

/**
 * Whole-field (not substring) match against common login/auth field names.
 * Anchored deliberately: a compound id like "scheduling-continue" must NOT
 * be treated as a login field just because "continue" appears inside it —
 * only an INPUT whose text/name/id IS (once trimmed) one of these tokens is
 * an auth-flow control.
 */
const LOGIN_FIELD_RE = /^(login|submit|sign\s?in|password|username|next|continue|verify|code)$/i;

/**
 * The click happened on an auth/login page — captured via the click's page URL.
 * This is the robust login filter: it drops every click made while signing in
 * (username field, "MyChart Username or", 2FA, etc.) regardless of its label,
 * which the field-name heuristic alone misses.
 */
const AUTH_URL_RE = /\/authentication|\/login|sign-?in|\/oauth|\/idp\//i;

/** Slot/time picks and explicit booking confirmations — never replayed as an act. */
const FINAL_ACTION_RE = /\d{1,2}:\d{2}\s?(AM|PM)|book|reserve|confirm|schedule it/i;

function isLoginField(value?: string | null): boolean {
  if (!value) return false;
  return LOGIN_FIELD_RE.test(value.trim());
}

/** An `<input>` whose text/name/id identifies it as part of a login/auth step. */
function isLoginClick(click: ClickEvent): boolean {
  if ((click.tag ?? "").toUpperCase() !== "INPUT") return false;
  return isLoginField(click.text) || isLoginField(click.name) || isLoginField(click.id);
}

/** Any click made while on an auth/login page (by the recorded page URL). */
function isOnAuthPage(click: ClickEvent): boolean {
  return Boolean(click.url && AUTH_URL_RE.test(click.url));
}

/** The very last click in the recording, if it's a slot/time pick or a booking confirmation. */
function isFinalActionClick(click: ClickEvent): boolean {
  const label = click.ariaLabel ?? click.text ?? "";
  return FINAL_ACTION_RE.test(label);
}

/** A click carries no usable label at all — nothing to build a locator from. */
function hasAnyLabel(click: ClickEvent): boolean {
  return Boolean(
    (click.text ?? "").trim() || (click.ariaLabel ?? "").trim() || (click.id ?? "").trim() || (click.name ?? "").trim(),
  );
}

/**
 * The click's accessible label. Prefers ariaLabel/text (the human-visible
 * label) and only falls back to name/id/testid when neither is present —
 * e.g. an icon-only "Continue" input identified solely by its DOM id.
 */
function labelOf(click: ClickEvent): string {
  const primary = (click.ariaLabel ?? click.text ?? "").trim();
  if (primary) return primary;
  return (click.name ?? click.id ?? click.testid ?? "").toString().trim();
}

/**
 * Volatile content inside a label: dates ("6 JULY 2026", "06/07/2026") and
 * live counts ("2 docs", "3 items"). These change between the demonstration
 * and every future replay, so an accessible-name match containing them is
 * guaranteed to go stale — a row labelled "Documents Submitted 6 JULY 2026"
 * must be matched by "Documents Submitted" alone.
 */
const VOLATILE_TEXT_RE =
  /\b(\d{1,2}\s+(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?\s+\d{4}|(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d+\s+(?:docs?|files?|items?|results?|records?))\b/i;

/**
 * Normalize a label into the act's semantic `name`: collapse all whitespace
 * runs (DOM innerText is full of newlines and double spaces), truncate at the
 * first volatile token (dates/counts — see VOLATILE_TEXT_RE) when a stable
 * multi-word prefix remains, and cap at ~80 chars. Deliberately NOT truncated
 * to a leading phrase otherwise — an earlier heuristic cut at the first
 * double-space/newline, which turned a row label like "Prasanna  Kumar D E"
 * into "Prasanna" and made the replay locator match the wrong (or no) element.
 */
function semanticName(label: string): string {
  let name = label.replace(/\s+/g, " ").trim();
  const volatile = VOLATILE_TEXT_RE.exec(name);
  if (volatile && volatile.index > 0) {
    const prefix = name.slice(0, volatile.index).trim().replace(/[|•·:,–—-]+$/, "").trim();
    // Only truncate when the stable prefix still identifies something — a
    // label that IS a date (e.g. a calendar cell) must stay intact.
    if (prefix.length >= 4) name = prefix;
  }
  if (name.length > 80) name = name.slice(0, 80).trim();
  return name;
}

// ---------------------------------------------------------------------------
// Demonstration-specific literal detection (→ param_hint)
// ---------------------------------------------------------------------------

/**
 * Common UI-navigation vocabulary. A multi-word capitalized name made ONLY of
 * these words (e.g. "New Patient Visit") is normal chrome, not a data value.
 */
const UI_NAV_WORDS = new Set([
  "schedule", "appointment", "visit", "details", "continue", "claims",
  "search", "new", "patient", "view", "open", "back", "next", "submit",
]);

const DIGITS_ONLY_RE = /^\d{5,}$/;
/** Phone-shaped: optional +, then 7–15 digits with common separators. */
const PHONE_RE = /^\+?[\d\s().-]{7,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** How many digits the string contains. */
function digitCount(s: string): number {
  return (s.match(/\d/g) ?? []).length;
}

/**
 * A slug usable as a flow input name. Underscores, not hyphens: the engine's
 * `{{...}}` template grammar only matches `[\w.]+`, so a hyphenated name would
 * silently never substitute.
 */
function slugify(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug.slice(0, 40).replace(/_+$/, "");
}

/**
 * Conservative detector for act names that are values from THIS demonstration
 * (a patient's name, a phone/claim number, an email) rather than stable UI
 * vocabulary — the compiled flow would only ever replay for that one record.
 * Returns a suggested input name (slug) when flagged, undefined otherwise.
 * Tuned for false NEGATIVES: a missed flag is a minor annoyance at review
 * time, a false positive nags the user about a real button.
 *
 * `isAction` (the clicked element is a button/link/tab) disables ONLY the
 * proper-noun heuristic — the branch that misfires on stable controls like
 * "Apply Filters", "All Claims", "Under Review", turning a fixed button into a
 * required run input. Unambiguous value SHAPES (email, phone, long numeric id)
 * are still flagged even on a button, because a button literally labelled
 * "8183054609" really is a per-run value, not chrome.
 */
function paramHintFor(name: string, opts: { isAction?: boolean } = {}): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;

  if (EMAIL_RE.test(trimmed)) return "email";
  if (DIGITS_ONLY_RE.test(trimmed) || (PHONE_RE.test(trimmed) && digitCount(trimmed) >= 7)) {
    // 7–15 digits with phone punctuation reads as a phone number; anything
    // else numeric (long ids, claim numbers) is a generic reference.
    const digits = digitCount(trimmed);
    return digits >= 7 && digits <= 15 ? "phone_number" : "reference_number";
  }

  // Proper-noun heuristic — the aggressive one. Only for NON-action targets: a
  // capitalized multi-word label on a button/link is almost always UI vocabulary
  // ("Apply Filters"), whereas on a role-less row/cell it's often a real name
  // ("Prasanna Kumar D E"). Requires 2+ words, all capitalized, at least one
  // outside the UI-navigation stoplist.
  if (opts.isAction) return undefined;
  const words = trimmed.split(/\s+/);
  if (words.length >= 2 && words.every((w) => /^[A-Z]/.test(w))) {
    const outside = words.some((w) => !UI_NAV_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, "")));
    if (outside) return slugify(trimmed) || undefined;
  }

  return undefined;
}

/**
 * The ARIA role to match on. An explicit `role` attribute wins; otherwise map
 * from the tag. Crucially an `<a>` has the implicit role **link**, NOT button —
 * coercing links to "button" makes `getByRole("button", …)` match nothing, so
 * the act can never find the control (the real cause of a hung replay). Only
 * genuine buttons get "button".
 */
function roleFor(click: ClickEvent): string | undefined {
  const explicit = (click.role ?? "").toLowerCase();
  if (["button", "link", "tab", "menuitem", "option", "radio", "checkbox"].includes(explicit)) return explicit;
  const tag = (click.tag ?? "").toUpperCase();
  if (tag === "BUTTON") return "button";
  if (tag === "A") return "link";
  return undefined;
}

/** A CSS id selector, falling back to `[id='…']` for ids with awkward characters. */
function cssForId(id: string): string {
  return /^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : `[id='${id.replace(/'/g, "\\'")}']`;
}

/**
 * Does this DOM id look human-authored (stable across deploys) rather than
 * auto-generated? Auto-generated ids — framework prefixes (`radix-`, React's
 * `:r…:` useId, `ember…`, `mui-…`), long digit runs, uuid-ish hex chunks —
 * change on every render/deploy, so caching them guarantees a stale selector.
 */
// Generic layout/landmark ids that identify a PAGE REGION, not a specific
// control. A click mis-resolved to one of these (e.g. `#main`) must never be
// frozen as a cached selector — it would match the whole region on replay.
const CONTAINER_IDS = new Set([
  "main", "root", "app", "app-root", "__next", "content", "container", "page",
  "wrapper", "body", "header", "footer", "nav", "sidebar", "layout", "shell",
]);
function isStableId(id: string): boolean {
  if (CONTAINER_IDS.has(id.toLowerCase())) return false;
  if (/^(radix-|:r|ember|mui-)/i.test(id)) return false;
  if (/\d{4,}/.test(id)) return false; // long digit run — counter/timestamp
  if (/[0-9a-f]{8,}/i.test(id)) return false; // uuid-ish hex chunk
  return true;
}

/**
 * The best structural hook the recorder captured for this click, as a cached
 * CSS selector: data-testid first (explicitly authored for automation), then a
 * stable-looking DOM id. Undefined when the element only has auto-generated
 * identity — a semantic locator is more robust than a selector that will rot.
 */
function structuralHook(click: ClickEvent): string | undefined {
  const testid = (click.testid ?? "").trim();
  if (testid) return `[data-testid='${testid.replace(/'/g, "\\'")}']`;
  const id = (click.id ?? "").trim();
  if (id && isStableId(id)) return cssForId(id);
  return undefined;
}

/**
 * Tiered locator synthesis per click:
 *   1. data-testid            → dual locator: cached [data-testid=…] + full semantic.
 *   2. stable-looking DOM id  → dual locator: cached #id + full semantic.
 *   3. no structural hook     → semantic role+name (full label).
 *   4. instance-specific label (param_hint) → semantic ONLY, even when a
 *      testid/id exists: hooks like data-testid="patient-row" are shared by
 *      every row, so the (parameterizable) text is the real discriminator —
 *      a cached hook would deterministically click the wrong row.
 * Execution tries cached first and self-heals to the semantic descriptor
 * (see compiler.ts resolveActLocator).
 */
function actStepFor(click: ClickEvent): Step {
  const visible = (click.ariaLabel ?? click.text ?? "").trim();
  // No visible label, but a DOM identity → target it precisely with a cached
  // CSS selector. A semantic text match would fail here (the identity is not
  // visible on the page) — e.g. an <input id="…-continue">. Auto-generated ids
  // are still used here: with no label there is nothing better to locate by.
  if (!visible && (click.testid || click.id || click.name)) {
    const cached = structuralHook(click) ?? (click.id ? cssForId(click.id) : `[name='${click.name}']`);
    const ref = click.testid ?? click.id ?? click.name ?? "control";
    return { type: "act", label: `Click "${ref}"`, locator: { cached, semantic: { intent: ref } } };
  }
  const label = visible || labelOf(click);
  const name = semanticName(label);
  const role = roleFor(click);
  // Buttons/links/tabs are ACTIONS: their proper-noun-shaped labels ("Apply
  // Filters", "All Claims", "Under Review") must not become required run
  // inputs. Value SHAPES (email/phone/id) are still flagged even on a button.
  // This fixes the failure where every button became a required run input.
  const paramHint = paramHintFor(name, { isAction: Boolean(role) });
  const cached = paramHint ? undefined : structuralHook(click); // tier 4: text discriminates, not the hook
  return {
    type: "act",
    label: `Click "${name}"`,
    locator: {
      ...(cached ? { cached } : {}),
      semantic: {
        ...(role ? { role } : {}),
        name,
        intent: label,
        ...(paramHint ? { param_hint: paramHint } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Compiler entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Exploration-noise collapse
// ---------------------------------------------------------------------------

/**
 * Names that read as UI-state toggles (filter panels, dropdowns, expanders).
 * Only these are eligible for pair-collapse — a repeated click on "Next"
 * (pagination) or "Load more" is intentional repetition, not noise.
 */
const TOGGLEY_NAME_RE = /\b(toggle|filters?|menu|dropdown|expand|collapse|show|hide|options?|types?|sort)\b/i;

/** The click's collapse identity: role + normalized semantic name. */
function clickIdentity(click: ClickEvent): string {
  return `${roleFor(click) ?? ""}|${semanticName(labelOf(click)).toLowerCase()}`;
}

/**
 * Drop no-op toggle pairs: two ADJACENT clicks on the same toggle-like element
 * are an open+close with nothing done in between — pure exploration noise that
 * replays as UI churn (or worse, leaves a panel in the wrong state relative to
 * what a heal expects). Collapsing is state-preserving by definition for a true
 * toggle: open+close ≡ never-opened. Runs to a fixpoint so pairs revealed by an
 * inner collapse ("Toggle filters, All Types, All Types, Toggle filters") also
 * fold away.
 */
export function collapseTogglePairs(clicks: ClickEvent[]): ClickEvent[] {
  let current = clicks;
  for (;;) {
    const next: ClickEvent[] = [];
    let collapsed = false;
    for (let i = 0; i < current.length; i++) {
      const a = current[i]!;
      const b = current[i + 1];
      if (
        b &&
        clickIdentity(a) === clickIdentity(b) &&
        TOGGLEY_NAME_RE.test(semanticName(labelOf(a)))
      ) {
        i++; // skip both halves of the pair
        collapsed = true;
        continue;
      }
      next.push(a);
    }
    if (!collapsed) return next;
    current = next;
  }
}

/**
 * Deterministically compile a recorded demonstration into a harvest-style
 * Portico flow: intercept → navigate → act… → wait → select. Pure — same
 * input always produces the same output, no I/O, no model call. This is the
 * pre-LLM baseline the author-time refinement pass starts from.
 */
export function compileRecording(rec: Recording, opts: CompileRecordingOptions = {}): Flow {
  const steps: Step[] = [];

  // Intercept FIRST: the listener must exist before the page load that fires
  // the data request (the engine also hoists intercepts defensively at run
  // time, but the authored artifact should read in true execution order).
  const chosen = selectInterceptCandidate(rec.network, opts.interceptKeyword);
  if (chosen) {
    const pathname = pathnameOf(chosen.url);
    steps.push({
      type: "intercept",
      label: `Capture ${basenameOf(pathname)} response`,
      intercept: { url_contains: pathname, as: "data_raw" },
    });
  }

  steps.push({ type: "navigate", label: "Open the page", url: rec.baseUrl });

  const lastIndex = rec.clicks.length - 1;
  const meaningful = rec.clicks.filter((click, index) => {
    if (isOnAuthPage(click) || isLoginClick(click)) return false; // login/auth click, not part of the harvest path
    if (index === lastIndex && isFinalActionClick(click)) return false; // never replay the booking/slot click
    if (!hasAnyLabel(click)) return false; // nothing to locate it by
    return true;
  });
  for (const click of collapseTogglePairs(meaningful)) steps.push(actStepFor(click));

  if (chosen) {
    steps.push({ type: "wait", label: "Wait for data", wait: { for: "data_raw", timeout_ms: 20000 } });
    if (opts.emitSelect !== false && looksLikeSlotData(chosen.responseBodyPreview)) {
      steps.push({
        type: "select",
        label: "Pick earliest",
        select: {
          from: "data_raw.Solutions.0.Slots",
          policy: "earliest",
          by: "DisplayDateTimeUtc",
          compare: "date",
          as: "chosen",
        },
      });
    }
  }

  return {
    key: opts.key ?? "recorded-flow",
    version: 1,
    description: "Auto-compiled from a recorded demonstration.",
    guard: {
      no_booking: true,
      forbidden_actions: ["ReserveAppointment", "book", "confirm"],
      dry_run_only: true,
    },
    steps,
  };
}
