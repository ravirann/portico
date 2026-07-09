/**
 * Effective execution tier of a run, derived from what its steps ACTUALLY did —
 * not a hardcoded label. The console badge should tell the truth: a flow that
 * harvested data purely from passive network capture is cheaper and more robust
 * than one that drove the DOM, which in turn is cheaper than one that needed a
 * model to self-heal. See adapters/libretto.ts for the tiers themselves.
 */
import type { StepTrace } from "./types.js";

export type Tier = "api" | "dom" | "agent";

/**
 * Step types that touch the live DOM through a locator — either interacting with
 * an element or reading rendered content. Any of these executing means the run
 * leaned on the DOM tier rather than a pure network harvest. `subflow` is here
 * because the flows it reuses (e.g. portal-login) are DOM-driven.
 */
const DOM_INTERACTION = new Set(["act", "extract", "assert", "download", "upload", "read", "subflow"]);

/**
 * Derive the tier a run effectively used from its step traces —
 * most-capable-machinery-wins, `agent` > `dom` > `api`:
 *
 *  - **agent** — a locator self-healed at run time (a model call happened).
 *  - **dom**   — at least one step interacted with or read the live DOM.
 *  - **api**   — data came purely from navigation + passive `intercept`, with
 *                no DOM interaction (the URMC GetSlots harvest pattern). Cheapest.
 *
 * `skipped` steps never executed, so they don't count. When nothing is
 * classifiable (e.g. an empty/immediately-failed trace) we fall back to `dom`,
 * the conservative generic default.
 */
export function deriveTier(
  traces: ReadonlyArray<Pick<StepTrace, "type" | "status" | "healedFrom">>,
): Tier {
  let sawDom = false;
  let sawApi = false;
  for (const t of traces) {
    if (t.status === "skipped") continue;
    // A runtime heal is a model call — the agent tier, and it dominates.
    if (t.status === "healed" || t.healedFrom) return "agent";
    if (DOM_INTERACTION.has(t.type)) sawDom = true;
    else if (t.type === "intercept") sawApi = true;
  }
  if (sawDom) return "dom";
  if (sawApi) return "api";
  return "dom";
}
