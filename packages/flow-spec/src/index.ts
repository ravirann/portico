/**
 * @portico/flow-spec — the declarative contract for a Portico automation.
 *
 * A Flow is a versioned, typed step graph authored once (by demonstration) and
 * replayed deterministically. It is engine-agnostic: the engine adapter
 * (Libretto today) interprets it. See docs/ARCHITECTURE.md §7.
 */

export type StepType =
  | "navigate"
  | "act" // AI-resolvable at author time, cached locator at run time
  | "extract" // schema-validated structured data
  | "assert" // must be true or the run fails
  | "guard" // policy invariant (e.g. no_booking) enforced by the engine
  | "download"
  | "upload"
  | "human" // HITL: pause, notify, resume (2FA / CAPTCHA / ambiguity)
  | "subflow"; // reuse another flow (e.g. portal-login)

/** A cached deterministic locator plus the semantic descriptor used to heal it. */
export interface Locator {
  /** Fast path: the concrete selector captured at authoring time. */
  cached?: string;
  /** Heal path: what the element *is*, so AI can re-find it by meaning. */
  semantic: {
    role?: string;
    name?: string; // accessible name / visible text
    near?: string; // nearby anchoring text
    intent: string; // authoring intent, e.g. "the Schedule an appointment button"
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
  /** For extract: the output key + JSON-schema of the shape to return. */
  extract?: { key: string; schema: Record<string, unknown> };
  /** For subflow: the referenced flow key (e.g. "portal-login"). */
  use?: string;
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
}

export const FLOW_SPEC_VERSION = 1 as const;
