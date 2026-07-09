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
 * Sample input values for a VALIDATION dry-run, derived from each declared
 * input. The declaration is a hint like "string — e.g. 9717352594" (the author
 * pipeline embeds an example); this lifts that example. If a user replaced the
 * hint with a bare value ("9717352594"), that value is used directly. This is
 * what lets Validate actually EXERCISE a flow instead of failing on missing
 * inputs — validation becomes a real dry-run with realistic values.
 */
export function sampleInputsFromFlow(flow: Flow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, decl] of Object.entries(flow.inputs ?? {})) {
    const s = String(decl ?? "").trim();
    const m = /e\.g\.\s*(.+)$/i.exec(s);
    const value = (m?.[1] ?? s).trim();
    if (value) out[name] = value;
  }
  return out;
}

/**
 * Declared flow inputs that the flow's steps actually reference but the run
 * did not provide (missing or blank). Checked BEFORE launching a browser: a
 * templated locator name like "{{customer_name}}" that renders to "" either
 * throws a cryptic "no usable semantic descriptor" five steps in, or — worse —
 * silently degrades a role+name locator to "first button on the page".
 * Declared-but-unreferenced inputs are ignored (harmless); referenced-but-
 * undeclared {{refs}} are ignored too (they may be prior-step outputs).
 */
export function missingFlowInputs(flow: Flow, provided: Record<string, unknown>): string[] {
  const declared = Object.keys(flow.inputs ?? {});
  if (declared.length === 0) return [];

  const referenced = new Set<string>();
  const scan = (s?: string) => {
    if (!s) return;
    for (const m of s.matchAll(/\{\{\s*(\w+)[\w.]*\s*\}\}/g)) referenced.add(m[1]!);
  };
  // Deep-scan any value (api url/body/headers are nested objects) for {{refs}}.
  const scanDeep = (v: unknown): void => {
    if (typeof v === "string") scan(v);
    else if (Array.isArray(v)) v.forEach(scanDeep);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(scanDeep);
  };
  for (const step of flow.steps) {
    scan(step.url);
    scan(step.value);
    scan(step.locator?.semantic?.name);
    scan(step.resolve?.input);
    scan(step.select?.policy);
    // An `api` step's url/headers/body carry inputs too (e.g. a write's {{lop}})
    // — a missing one must fail fast, not send an empty value the API rejects.
    scanDeep((step as unknown as { api?: unknown }).api);
  }

  return declared.filter((name) => {
    if (!referenced.has(name)) return false;
    const v = provided[name];
    return v == null || String(v).trim() === "";
  });
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

/**
 * The output keys a validation dry-run must actually populate.
 *
 * `select`/`extract` outputs are ACTIVELY produced by steps the flow replays, so
 * they're always required. `intercept` outputs are OPPORTUNISTIC harvests — they
 * fire only when the page makes that request. In a navigate+wait harvest flow
 * only the navigation-triggered endpoint reliably fires; extra intercepts the
 * agent captured while clicking through a MULTI-STEP wizard (e.g. selecting a
 * specialty) are triggered by interactions the deterministic flow does not
 * replay, so they must NOT gate validation. Among intercepts, require the one(s)
 * the flow explicitly WAITS for — its committed product. If nothing is waited on
 * (no signal to narrow), fall back to requiring every intercept (strict).
 */
export function requiredOutputKeys(flow: Flow): string[] {
  const required = new Set<string>();
  const intercepts: string[] = [];
  const waited = new Set<string>();
  for (const step of flow.steps) {
    if (step.type === "select" && step.select?.as) required.add(step.select.as);
    if (step.type === "extract" && step.extract?.key) required.add(step.extract.key);
    if (step.type === "intercept" && step.intercept?.as) intercepts.push(step.intercept.as);
    if (step.wait?.for) waited.add(step.wait.for);
  }
  const waitedIntercepts = intercepts.filter((k) => waited.has(k));
  for (const k of waitedIntercepts.length > 0 ? waitedIntercepts : intercepts) required.add(k);
  return [...required];
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
 * completed AND every REQUIRED data output (see requiredOutputKeys — the flow's
 * committed products, not opportunistic wizard-step harvests) is present and
 * non-empty. Any other state (failed/paused, or a missing/empty required
 * output) fails with a specific reason.
 */
export function evaluateValidation(flow: Flow, result: RunResultLike): ValidationResult {
  const reasons: string[] = [];

  if (result.status !== "completed") {
    const why = result.failure?.reason ? ` — ${result.failure.reason}` : "";
    reasons.push(`run did not complete (status: ${result.status}${why})`);
  }

  const output = result.output ?? {};
  if (expectedOutputKeys(flow).length === 0) {
    reasons.push("flow declares no data outputs (nothing to validate) — add an intercept/select/extract");
  }
  for (const key of requiredOutputKeys(flow)) {
    if (isEmpty(output[key])) reasons.push(`expected output "${key}" is missing or empty`);
  }

  return { passed: reasons.length === 0, reasons };
}
