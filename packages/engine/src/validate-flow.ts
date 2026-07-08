/**
 * Validation gate for the self-serve authoring pipeline.
 *
 * A draft flow (recorded or LLM-compiled) must PROVE it works before a non-tech
 * user confirms it. `evaluateValidation` is the pure decision: given a flow and
 * the result of a dry-run, did it (a) complete, and (b) actually produce the
 * data it's supposed to? It's deterministic and I/O-free so the gate itself is
 * fully unit-tested — the live run happens in the CLI, the judgment happens here.
 */

import type { Flow } from "@portico/flow-spec";

export interface RunResultLike {
  status: string; // "completed" | "failed" | "paused" | …
  output?: Record<string, unknown>;
  failure?: { reason?: string } | null;
}

export interface ValidationResult {
  passed: boolean;
  reasons: string[]; // empty when passed; human-readable failures otherwise
}

/**
 * The output keys a flow is expected to populate — its *data products*: what an
 * intercept harvests, what a select picks, what an extract pulls. Resolve/read
 * intermediates are deliberately excluded (they're plumbing, not the result).
 */
export function expectedOutputKeys(flow: Flow): string[] {
  const keys = new Set<string>();
  for (const step of flow.steps) {
    if (step.type === "intercept" && step.intercept?.as) keys.add(step.intercept.as);
    if (step.type === "select" && step.select?.as) keys.add(step.select.as);
    if (step.type === "extract" && step.extract?.key) keys.add(step.extract.key);
  }
  return [...keys];
}

/** True when a value counts as "empty" (missing, "", [], or {}). */
function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length === 0;
  return false;
}

/**
 * Decide whether a dry-run of `flow` is green. Passes only when the run
 * completed AND every expected data output is present and non-empty. Any other
 * state (failed/paused, or a missing/empty output) fails with a specific reason.
 */
export function evaluateValidation(flow: Flow, result: RunResultLike): ValidationResult {
  const reasons: string[] = [];

  if (result.status !== "completed") {
    const why = result.failure?.reason ? ` — ${result.failure.reason}` : "";
    reasons.push(`run did not complete (status: ${result.status}${why})`);
  }

  const output = result.output ?? {};
  const expected = expectedOutputKeys(flow);
  if (expected.length === 0) {
    reasons.push("flow declares no data outputs (nothing to validate) — add an intercept/select/extract");
  }
  for (const key of expected) {
    if (isEmpty(output[key])) reasons.push(`expected output "${key}" is missing or empty`);
  }

  return { passed: reasons.length === 0, reasons };
}
