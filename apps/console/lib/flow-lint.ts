import { parseDocument, isMap, isSeq } from "yaml";
import type { Node } from "yaml";

/** A single lint finding with absolute character offsets into the source, so it
 *  maps cleanly onto a CodeMirror Diagnostic. */
export interface LintIssue {
  from: number;
  to: number;
  message: string;
  severity: "error" | "warning";
}

export interface LintResult {
  issues: LintIssue[];
  /** true when there are no error-severity issues (warnings are allowed). */
  valid: boolean;
  /** Flat list of error-severity messages, for the parent's onValidChange. */
  errors: string[];
}

/** The step types the flow-spec knows how to execute. Anything else is flagged. */
const KNOWN_STEP_TYPES = new Set([
  "navigate",
  "act",
  "extract",
  "assert",
  "guard",
  "human",
  "resolve",
  "read",
  "select",
  "intercept",
  "wait",
  "subflow",
  "download",
  "upload",
]);

/** Required sub-fields per step type — the minimum a step needs to be runnable.
 *  Each entry is a dotted path checked for presence on the parsed step object. */
const REQUIRED_FIELDS: Record<string, string[]> = {
  navigate: ["url"],
  intercept: ["intercept.url_contains", "intercept.as"],
  act: ["locator"],
  select: ["select.from", "select.as"],
};

function hasPath(obj: unknown, path: string): boolean {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur !== undefined && cur !== null && cur !== "";
}

/** Absolute [from,to] offset for a parsed node, falling back to a small span. */
function rangeOf(node: Node | null | undefined, fallbackTo: number): [number, number] {
  const r = node?.range;
  if (r && typeof r[0] === "number") return [r[0], typeof r[1] === "number" ? r[1] : r[0] + 1];
  return [0, fallbackTo];
}

/**
 * Lint a YAML document. Always reports parse errors (with line/col carried by
 * the offsets). When mode==="flow", additionally runs a lightweight flow-spec
 * check: top-level key/version/steps, each step's known type and its required
 * sub-fields. Everything is best-effort — a spec check never throws.
 */
export function lintFlow(value: string, mode: "flow" | "plain"): LintResult {
  const issues: LintIssue[] = [];
  const fallbackTo = Math.max(1, value.length);

  const doc = parseDocument(value, { prettyErrors: true });

  for (const err of doc.errors) {
    const [from, to] = err.pos ?? [0, fallbackTo];
    issues.push({ from, to: Math.max(to, from + 1), message: err.message, severity: "error" });
  }

  // Only run the spec check when the document parsed structurally and we're in
  // flow mode — otherwise the toJS() view is unreliable.
  if (mode === "flow" && doc.errors.length === 0 && value.trim().length > 0) {
    try {
      const flow = doc.toJS() as Record<string, unknown> | null;
      const contents = doc.contents as Node | null;
      const [docFrom, docTo] = rangeOf(contents, fallbackTo);

      if (!flow || typeof flow !== "object" || Array.isArray(flow)) {
        issues.push({ from: 0, to: fallbackTo, message: "Flow must be a YAML mapping with key, version and steps.", severity: "error" });
      } else {
        if (typeof flow.key !== "string" || !flow.key.trim()) {
          issues.push({ from: docFrom, to: docTo, message: 'Missing required top-level "key" (string).', severity: "error" });
        }
        if (typeof flow.version !== "number") {
          issues.push({ from: docFrom, to: docTo, message: 'Missing required top-level "version" (number).', severity: "error" });
        }
        const steps = flow.steps;
        if (!Array.isArray(steps)) {
          issues.push({ from: docFrom, to: docTo, message: 'Missing required top-level "steps" (array).', severity: "error" });
        } else {
          const stepsNode = isMap(contents) ? contents.get("steps", true) : null;
          const stepItems = isSeq(stepsNode) ? stepsNode.items : [];

          steps.forEach((step, i) => {
            const stepNode = (stepItems[i] as Node | undefined) ?? null;
            const [from, to] = rangeOf(stepNode, fallbackTo);
            const label = `step ${i + 1}`;

            if (!step || typeof step !== "object" || Array.isArray(step)) {
              issues.push({ from, to, message: `${label}: each step must be a mapping.`, severity: "error" });
              return;
            }
            const type = (step as Record<string, unknown>).type;
            if (typeof type !== "string" || !type) {
              issues.push({ from, to, message: `${label}: missing required "type".`, severity: "error" });
              return;
            }
            if (!KNOWN_STEP_TYPES.has(type)) {
              issues.push({ from, to, message: `${label}: unknown step type "${type}".`, severity: "error" });
              return;
            }
            for (const path of REQUIRED_FIELDS[type] ?? []) {
              if (!hasPath(step, path)) {
                issues.push({ from, to, message: `${label} (${type}): missing required "${path}".`, severity: "error" });
              }
            }
          });
        }
      }
    } catch (e) {
      issues.push({ from: 0, to: fallbackTo, message: `Flow check failed: ${e instanceof Error ? e.message : String(e)}`, severity: "warning" });
    }
  }

  const errors = issues.filter((i) => i.severity === "error").map((i) => i.message);
  return { issues, valid: errors.length === 0, errors };
}
