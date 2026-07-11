/**
 * Structured step errors.
 *
 * Every failure the compiler/runner produces today is a plain `Error` with a
 * human message — fine for a trace's `detail` field, useless for a CALLER
 * trying to decide "should I retry this run, or is it going to fail the same
 * way forever?" `PorticoStepError` lets a throw site name what KIND of
 * failure this is; `classifyError` recovers a kind (and its resumability)
 * from ANY thrown value, including the plain Errors Playwright/Node
 * themselves raise, so the runner can make that call uniformly regardless of
 * where the error came from.
 */

export type StepErrorKind =
  | "timeout"
  | "not_found"
  | "ambiguous"
  | "navigation"
  | "network"
  | "validation"
  | "guard"
  | "aborted"
  | "egress_blocked"
  | "unsupported"
  | "unknown";

/** A step failure that already knows its own kind — thrown by call sites
 *  that can name the failure precisely (a timeout ceiling, a refused guard,
 *  an unsupported condition, …) instead of leaving it to string-sniffing. */
export class PorticoStepError extends Error {
  readonly kind: StepErrorKind;
  constructor(kind: StepErrorKind, message: string) {
    super(message);
    this.name = "PorticoStepError";
    this.kind = kind;
  }
}

/**
 * Whether a run that failed with each error kind is worth resuming
 * (`resumeFrom`) — i.e. the underlying condition is plausibly transient
 * (a slow page, a flaky network blip, an element that hadn't rendered yet)
 * rather than something that will fail identically every time until a human
 * or the flow's author fixes it (a refused guard, a bad condition string, an
 * explicit abort, a validation failure, a blocked-egress policy hit, a
 * strict-mode ambiguity that needs a narrower locator). Exported as a
 * standalone constant so the table itself is unit-testable.
 */
export const RESUMABLE_BY_KIND: Record<StepErrorKind, boolean> = {
  timeout: true,
  not_found: true,
  navigation: true,
  network: true,
  unknown: true,
  ambiguous: false,
  guard: false,
  validation: false,
  unsupported: false,
  egress_blocked: false,
  aborted: false,
};

const NETWORK_RE = /net::|ERR_NAME|ERR_CONNECTION|ECONNRE|ENOTFOUND|fetch failed/i;
const AMBIGUOUS_RE = /strict mode violation/i;

/**
 * Classify an arbitrary thrown value into a {@link StepErrorKind} plus
 * whether a run failing with it is resumable. `PorticoStepError` instances
 * carry their own kind (an explicit, precise signal from the throw site);
 * everything else — Playwright's own `TimeoutError`, raw network failures,
 * Playwright strict-mode violations, or anything unrecognized — is
 * pattern-matched off `.name`/`.message`, since third-party errors aren't
 * typed for this.
 */
export function classifyError(err: unknown): { kind: StepErrorKind; resumable: boolean } {
  let kind: StepErrorKind;
  if (err instanceof PorticoStepError) {
    kind = err.kind;
  } else if (err instanceof Error && err.name === "TimeoutError") {
    kind = "timeout";
  } else {
    const message = err instanceof Error ? err.message : String(err);
    if (NETWORK_RE.test(message)) kind = "network";
    else if (AMBIGUOUS_RE.test(message)) kind = "ambiguous";
    else kind = "unknown";
  }
  return { kind, resumable: RESUMABLE_BY_KIND[kind] };
}
