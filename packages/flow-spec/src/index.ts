/**
 * @portico/flow-spec — the declarative contract for a Portico automation.
 *
 * A Flow is a versioned, typed step graph authored once (by demonstration) and
 * replayed deterministically. It is engine-agnostic: the engine adapter
 * (Libretto today) interprets it. See docs/ARCHITECTURE.md §7.
 */

import type { SectorKey } from "./sectors.js";

export type StepType =
  | "navigate"
  | "act" // AI-resolvable at author time, cached locator at run time
  | "extract" // schema-validated structured data
  | "assert" // must be true or the run fails
  | "guard" // policy invariant (e.g. no_booking) enforced by the engine
  | "download"
  | "upload"
  | "human" // HITL: pause, notify, resume (2FA / CAPTCHA / ambiguity)
  | "resolve" // canonicalize a fuzzy intent input against real candidates
  | "read" // read a value out of the live page (session token / option list)
  | "select" // pick one item from a prior list by policy (e.g. earliest slot)
  | "intercept" // passively capture a JSON response the page itself makes
  | "wait" // block until an intercepted/output value is populated
  | "subflow"; // reuse another flow (e.g. portal-login)

/** A cached deterministic locator plus the semantic descriptor used to heal it. */
export interface Locator {
  /**
   * Chain of iframe CSS selectors (e.g. `iframe[src*="editor"]`) resolved
   * outermost→innermost via frameLocator before candidate resolution;
   * absent = main frame.
   */
  frame?: string[];
  /** Fast path: the concrete selector captured at authoring time. */
  cached?: string;
  /** Heal path: what the element *is*, so AI can re-find it by meaning. */
  semantic: {
    role?: string;
    name?: string; // accessible name / visible text
    near?: string; // nearby anchoring text
    intent: string; // authoring intent, e.g. "the Schedule an appointment button"
    /**
     * Machine-readable hint that `name` looks like a demonstration-specific
     * literal (a patient name, phone/claim number, email) rather than stable UI
     * vocabulary. The value is a suggested input name (e.g. "prasanna_kumar_d_e")
     * that review tooling can offer to parameterize into `{{<hint>}}`. Purely
     * advisory — replay ignores it and still uses the literal `name`.
     */
    param_hint?: string;
  };
}

export interface Step {
  type: StepType;
  /** Human-readable label shown in traces. */
  label?: string;
  /** Target element for act/extract/assert/download/upload. */
  locator?: Locator;
  /** For navigate: the URL (may contain {{input}} templates). */
  url?: string;
  /** For act/upload: value or input reference (e.g. "{{reason}}"). */
  value?: string;
  /**
   * Explicit act method; when absent the engine infers (value present →
   * fill, else click). `press` = keyboard chord in `value` (e.g.
   * "Control+Enter"), pressed on the located element if a locator is
   * present, else on the page. `type` = click to focus, then type `value`
   * via keyboard events (for contenteditable/rich-text editors where
   * fill() doesn't fire the right events).
   */
  method?: "click" | "fill" | "press" | "type";
  /** For extract: the output key + JSON-schema of the shape to return. */
  extract?: { key: string; schema: Record<string, unknown> };
  /** For subflow: the referenced flow key (e.g. "portal-login"). */
  use?: string;
  /**
   * For resolve: canonicalize a fuzzy intent value against the real options the
   * portal offers, so "Southview" becomes exactly "Southview Internal Medicine"
   * — and refuses (rather than guessing) when the input is ambiguous.
   */
  resolve?: {
    /** Templated intent to resolve, e.g. "{{location}}". */
    input: string;
    /** Output key holding the candidates (string[] or object[]) from a prior step. */
    candidates: string;
    /** For object candidates: the field to fuzzy-match against (e.g. "Title"). */
    match_on?: string;
    /**
     * What to write into `output[as]`: with object candidates, the matched item's
     * `value_field` (e.g. the encrypted "Value"/id); omit to write the matched
     * display value itself.
     */
    value_field?: string;
    /** Output key to write the resolved value (canonical name or id) into. */
    as: string;
    /** What to do when the input matches >1 candidate. Default "fail" (fail loud). */
    on_ambiguous?: "fail" | "human";
  };
  /**
   * For read: evaluate a JS expression in the live page and store the result.
   * Used to lift a session token / hidden field / option list out of the DOM
   * so downstream API-tier steps can send it (e.g. an anti-forgery token).
   */
  read?: { expression: string; as: string };
  /**
   * For select: pick ONE item from a prior list (output[from]) by policy and
   * store it — e.g. the earliest available slot. `by` is the field to order on.
   */
  select?: {
    from: string;
    policy: string; // "first" | "earliest" | "latest" | "index:N" | "on-or-after:<iso>"
    by?: string;
    compare?: "date" | "number" | "string";
    as: string;
  };
  /**
   * For intercept: register a passive listener that captures the JSON body of a
   * response the PAGE itself makes (URL contains `url_contains`), storing the
   * latest match in `output[as]`. Register it before the action that triggers
   * the request. This harvests API-tier data without replaying the request —
   * the robust path for anti-replay/anti-forgery-protected endpoints.
   * `required` marks the capture as load-bearing (validation treats it as a
   * required output; a wait on it that times out is a hard failure).
   * `schema` is an optional JSON-schema gate applied to the captured JSON,
   * like extract.schema.
   */
  intercept?: { url_contains: string; as: string; required?: boolean; schema?: Record<string, unknown> };
  /**
   * For wait: block until `output[for]` is populated (e.g. by an interceptor
   * after a click triggers the request), or fail after `timeout_ms`.
   */
  wait?: { for: string; timeout_ms?: number };
  /** For assert/guard: a named condition the engine knows how to check. */
  condition?: string;
  /** Retry/timeout policy overrides. */
  retry?: { max?: number; backoffMs?: number };
  timeoutMs?: number;
}

export interface FlowGuards {
  /** Structurally forbid any commit/confirm/booking action in this flow. */
  no_booking?: boolean;
  /** Named actions the policy engine must reject. */
  forbidden_actions?: string[];
  /** Only run in dry-run; block live execution. */
  dry_run_only?: boolean;
}

export interface Flow {
  key: string;
  version: number;
  description?: string;
  /** Declared inputs (name → type hint), referenced as {{name}} in steps. */
  inputs?: Record<string, string>;
  guard?: FlowGuards;
  /**
   * Sector profile stamped at authoring time; engine falls back to it when
   * the caller doesn't specify one.
   */
  sector?: SectorKey;
  steps: Step[];
}

/** A target site (a connector's `target.yaml`, minus per-instance overrides). */
export interface Target {
  key: string;
  name: string;
  framework?: string; // e.g. "example-portal" — enables cross-instance heal sharing
  base_url: string;
  allowed_domains: string[]; // hard network-egress boundary at run time
  auth: string; // auth strategy / subflow key, e.g. "portal-login"
  /**
   * Industry/app-class of the target; selects the SectorProfile with
   * reliability defaults; see sectors.ts.
   */
  sector?: SectorKey;
}

export const FLOW_SPEC_VERSION = 1 as const;

// Pure recording→flow compiler (no engine/runtime deps) — lives here so BOTH the
// engine and the isolated author package (which can't import @portico/engine)
// can compile a captured demonstration into a deterministic action-replay flow.
export { compileRecording, collapseTogglePairs } from "./compile-recording.js";
export type { Recording, ClickEvent, NetworkEntry, CompileRecordingOptions } from "./compile-recording.js";

// Sector profiles: named bundles of reliability defaults (readiness gates,
// timeouts, retries, locator policy, mutation guards, authoring hints)
// keyed by industry/app-class. Lives in its own zero-dependency module —
// re-exported here so the engine and author packages can reach it via the
// single @portico/flow-spec entry point.
export { SECTOR_PROFILES, resolveSectorProfile, listSectors } from "./sectors.js";
export type { SectorKey, SectorProfile } from "./sectors.js";
