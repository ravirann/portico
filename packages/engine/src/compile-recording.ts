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
 *   1. navigate   — the recording's `baseUrl`.
 *   2. intercept  — the best-guess "data" endpoint from `rec.network`
 *                    (skipped entirely if no JSON candidate exists).
 *   3. act…       — one per meaningful click, login/auth and the final
 *                    booking/slot-picking click filtered out.
 *   4. wait       — only if step 2 emitted an intercept.
 *   5. select     — only if step 2 emitted an intercept AND its response
 *                    body looks like it carries slot/time data.
 */

import type { Flow, Step } from "@portico/flow-spec";

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
 * Trim a (possibly long, multi-clause) label down to its leading
 * human-meaningful phrase: cut at the first double-space, " - ", or newline
 * — whichever comes first — then cap at ~40 chars. Turns a tile label like
 * "Primary Care  Includes adult, pediatric…" into "Primary Care".
 */
function shortName(label: string): string {
  const delimiters = [/ {2,}/, / - /, /\n/];
  let cutAt = label.length;
  for (const re of delimiters) {
    const match = re.exec(label);
    if (match && match.index < cutAt) cutAt = match.index;
  }
  let short = label.slice(0, cutAt).trim();
  if (short.length > 40) short = short.slice(0, 40).trim();
  return short;
}

/** "button" when the click's own role says so, or its tag is button-like (BUTTON/A). */
function roleFor(click: ClickEvent): string | undefined {
  const roleIsButton = (click.role ?? "").toLowerCase() === "button";
  const tag = (click.tag ?? "").toUpperCase();
  return roleIsButton || tag === "BUTTON" || tag === "A" ? "button" : undefined;
}

/** A CSS id selector, falling back to `[id='…']` for ids with awkward characters. */
function cssForId(id: string): string {
  return /^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : `[id='${id.replace(/'/g, "\\'")}']`;
}

function actStepFor(click: ClickEvent): Step {
  const visible = (click.ariaLabel ?? click.text ?? "").trim();
  // No visible label, but a DOM id/name → target it precisely with a cached CSS
  // selector. A semantic text match would fail here (the id/name is not visible
  // on the page) — this is the fix for controls like an <input id="…-continue">.
  if (!visible && (click.id || click.name)) {
    const cached = click.id ? cssForId(click.id) : `[name='${click.name}']`;
    const ref = click.id ?? click.name ?? "control";
    return { type: "act", label: `Click "${ref}"`, locator: { cached, semantic: { intent: ref } } };
  }
  const label = visible || labelOf(click);
  const name = shortName(label);
  const role = roleFor(click);
  return {
    type: "act",
    label: `Click "${name}"`,
    locator: { semantic: { ...(role ? { role } : {}), name, intent: label } },
  };
}

// ---------------------------------------------------------------------------
// Compiler entry point
// ---------------------------------------------------------------------------

/**
 * Deterministically compile a recorded demonstration into a harvest-style
 * Portico flow: navigate → intercept → act… → wait → select. Pure — same
 * input always produces the same output, no I/O, no model call. This is the
 * pre-LLM baseline the author-time refinement pass starts from.
 */
export function compileRecording(rec: Recording, opts: CompileRecordingOptions = {}): Flow {
  const steps: Step[] = [];

  steps.push({ type: "navigate", label: "Open the page", url: rec.baseUrl });

  const chosen = selectInterceptCandidate(rec.network, opts.interceptKeyword);
  if (chosen) {
    const pathname = pathnameOf(chosen.url);
    steps.push({
      type: "intercept",
      label: `Capture ${basenameOf(pathname)} response`,
      intercept: { url_contains: pathname, as: "data_raw" },
    });
  }

  const lastIndex = rec.clicks.length - 1;
  rec.clicks.forEach((click, index) => {
    if (isOnAuthPage(click) || isLoginClick(click)) return; // login/auth click, not part of the harvest path
    if (index === lastIndex && isFinalActionClick(click)) return; // never replay the booking/slot click
    if (!hasAnyLabel(click)) return; // nothing to locate it by
    steps.push(actStepFor(click));
  });

  if (chosen) {
    steps.push({ type: "wait", label: "Wait for data", wait: { for: "data_raw", timeout_ms: 20000 } });
    if (looksLikeSlotData(chosen.responseBodyPreview)) {
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
