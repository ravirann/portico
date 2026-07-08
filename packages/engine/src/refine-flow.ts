/**
 * LLM refine pass — author-tier only.
 *
 * `compileRecording` produces a deterministic draft flow: correct structure,
 * but its `act` locator names are whatever the raw click label happened to be
 * (often a whole tile's text, e.g. "Primary Care  Includes adult,
 * pediatric,…"), and a human demonstration is full of exploration noise (a
 * panel opened and closed, a detail viewed and dismissed, back-navigation at
 * the end). This module runs a model over the draft to do exactly two things:
 *
 *   1. RENAME — trim each act's accessible name to the shortest stable phrase
 *      that still identifies the element (never touching `intent`).
 *   2. DROP — remove act steps that are demonstration noise, not part of the
 *      flow's goal. Hard-validated: ONLY `act` steps can be dropped, steps are
 *      never added or reordered, and non-act indices in a drop list are ignored.
 *
 * This is strictly an AUTHOR-TIME convenience: it is never on the replay hot
 * path (see docs/ARCHITECTURE.md §4 — a promoted deterministic replay makes
 * zero model calls). Accordingly it must degrade gracefully: with no model
 * configured, or if the model call fails for any reason, `refineFlow` returns
 * the draft unchanged. The pipeline must never break because refinement did.
 */

import type { Flow, Step } from "@portico/flow-spec";
import type { Recording } from "./compile-recording.js";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";

/** A model-proposed cleanup: for the act step at `index`, use this accessible name. */
export interface NameRefinement {
  index: number;
  name: string;
}

/**
 * PURE: apply name refinements to a flow's act steps (by step index),
 * returning a NEW flow. Only touches steps whose `type === "act"` and which
 * have `locator.semantic`; sets `locator.semantic.name` to the refined name
 * while leaving `intent` (the full label) intact. Refinements pointing at an
 * out-of-range index or a non-act step are ignored. Never mutates the input.
 */
export function applyNameRefinements(flow: Flow, refinements: NameRefinement[]): Flow {
  const byIndex = new Map<number, string>();
  for (const r of refinements) {
    if (r.index >= 0 && r.index < flow.steps.length) byIndex.set(r.index, r.name);
  }

  const steps: Step[] = flow.steps.map((step, index) => {
    const name = byIndex.get(index);
    if (name === undefined) return step;
    if (step.type !== "act" || !step.locator?.semantic) return step;

    return {
      ...step,
      locator: {
        ...step.locator,
        semantic: {
          ...step.locator.semantic,
          name,
        },
      },
    };
  });

  return { ...flow, steps };
}

/** The model's full proposal: renames plus act-step drops. */
export interface FlowRefinements {
  renames: NameRefinement[];
  /** Indices (into flow.steps) of act steps to remove as demonstration noise. */
  drops: number[];
}

/**
 * PURE: apply renames + drops, returning a NEW flow. Drop validation is the
 * safety contract: only `act` steps may be dropped — a proposed drop of a
 * navigate/intercept/wait/extract/select step is silently ignored, as is any
 * out-of-range index. Renames are applied first (they key on original
 * indices), then the surviving steps keep their original relative order.
 */
export function applyRefinements(flow: Flow, refinements: FlowRefinements): Flow {
  const renamed = applyNameRefinements(flow, refinements.renames);
  const droppable = new Set(
    refinements.drops.filter((i) => i >= 0 && i < renamed.steps.length && renamed.steps[i]!.type === "act"),
  );
  if (droppable.size === 0) return renamed;
  return { ...renamed, steps: renamed.steps.filter((_, i) => !droppable.has(i)) };
}

/** One act step's context, as fed to the model for refinement. */
interface ActStepContext {
  index: number;
  currentName?: string;
  intent: string;
}

function collectActSteps(flow: Flow): ActStepContext[] {
  const contexts: ActStepContext[] = [];
  flow.steps.forEach((step, index) => {
    if (step.type !== "act" || !step.locator?.semantic) return;
    contexts.push({
      index,
      currentName: step.locator.semantic.name,
      intent: step.locator.semantic.intent,
    });
  });
  return contexts;
}

/** Recorded click labels, for extra context on what the visible text really was. */
function collectClickLabels(recording: Recording): string[] {
  return recording.clicks
    .map((click) => (click.ariaLabel ?? click.text ?? "").trim())
    .filter((label) => label.length > 0);
}

function buildPrompt(flow: Flow, actSteps: ActStepContext[], clickLabels: string[], goal?: string): string {
  const allStepLines = flow.steps
    .map((s, i) => `- index ${i}: type=${s.type}${s.label ? ` label=${JSON.stringify(s.label)}` : ""}`)
    .join("\n");
  const stepLines = actSteps
    .map((s) => `- index ${s.index}: current name = ${JSON.stringify(s.currentName ?? "")}, intent = ${JSON.stringify(s.intent)}`)
    .join("\n");
  const labelLines = clickLabels.map((l) => `- ${JSON.stringify(l)}`).join("\n");

  return [
    "You are cleaning up a browser-automation flow compiled from a HUMAN",
    "demonstration. Human demonstrations contain exploration noise; the compiled",
    "flow must contain only the steps that serve the goal.",
    "",
    goal ? `The flow's goal: ${goal}` : "The flow's goal: reach the data page and harvest its data (see the flow description).",
    flow.description ? `Flow description: ${flow.description}` : "",
    "",
    "Full step list (for context — only 'act' steps may be renamed or dropped):",
    allStepLines,
    "",
    "Act steps (clicks). Each has an `intent` (the full, possibly noisy label",
    "captured at recording time) and a `current name` (used to find the element",
    "by its accessible name at replay time):",
    stepLines,
    "",
    "Recorded click labels (for context on visible text):",
    labelLines,
    "",
    "Return two things:",
    "",
    "1. `refinements` — for each act step whose name you can improve, the",
    "   SHORTEST human-meaningful name that still uniquely identifies the",
    "   element. It must be a substring of the visible label (the intent, or a",
    "   recorded click label). NEVER include volatile text in a name: dates",
    "   ('6 JULY 2026'), counts ('2 docs'), statuses that change over time —",
    "   these break every future replay. Do not invent text. Omit steps whose",
    "   current name is already good.",
    "",
    "2. `drops` — indices of act steps that are demonstration NOISE relative to",
    "   the goal. Typical noise: a toggle/panel opened and then closed with",
    "   nothing selected in between; a dropdown clicked twice (open+close); a",
    "   detail dialog opened and then dismissed without extracting anything",
    "   ('View Details' followed by 'Close'); trailing back-navigation after the",
    "   goal was reached ('All Claims', 'Back'). When unsure, KEEP the step —",
    "   a kept noise step is churn, a dropped real step breaks the flow.",
    "",
    "Never add, reorder, or merge steps, and never add booking/confirm actions.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

const refinementSchema = z.object({
  refinements: z.array(
    z.object({
      index: z.number(),
      name: z.string(),
    }),
  ),
  drops: z.array(z.number()).describe("Indices of act steps that are demonstration noise"),
});

/**
 * Refine a draft flow using a model: rename coarse act names and drop
 * exploration-noise act steps (validated — see applyRefinements). Returns a
 * cleaned COPY. If `model` is undefined OR the model call throws, returns the
 * draft unchanged (deterministic fallback — refine must never break the
 * pipeline). `opts.goal` (the author's one-line statement of what the flow is
 * for) sharpens noise detection considerably — pass it when available.
 */
export async function refineFlow(
  flow: Flow,
  recording: Recording,
  model?: LanguageModel,
  opts: { goal?: string } = {},
): Promise<Flow> {
  if (!model) return flow;

  const actSteps = collectActSteps(flow);
  if (actSteps.length === 0) return flow;

  try {
    const prompt = buildPrompt(flow, actSteps, collectClickLabels(recording), opts.goal);
    const result = await generateObject({
      model,
      schema: refinementSchema,
      prompt,
    });
    return applyRefinements(flow, {
      renames: result.object.refinements,
      drops: result.object.drops ?? [],
    });
  } catch {
    return flow;
  }
}
