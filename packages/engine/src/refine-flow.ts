/**
 * LLM refine pass — author-tier only.
 *
 * `compileRecording` produces a deterministic draft flow: correct structure,
 * but its `act` locator names are whatever the raw click label happened to
 * be (often a whole tile's text, e.g. "Primary Care  Includes adult,
 * pediatric,…"). This module runs a model over that draft to trim each name
 * down to the shortest human-meaningful phrase that still identifies the
 * element — nothing else. It never changes step structure, never adds or
 * removes steps, and never touches `intent` (the full authoring label stays
 * intact for traceability).
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

function buildPrompt(actSteps: ActStepContext[], clickLabels: string[]): string {
  const stepLines = actSteps
    .map((s) => `- index ${s.index}: current name = ${JSON.stringify(s.currentName ?? "")}, intent = ${JSON.stringify(s.intent)}`)
    .join("\n");
  const labelLines = clickLabels.map((l) => `- ${JSON.stringify(l)}`).join("\n");

  return [
    "You are cleaning up locator names for a browser-automation flow.",
    "Below is a list of 'act' steps (clicks) from a draft flow. Each has an",
    "`intent` (the full, possibly noisy label captured at recording time) and",
    "a `current name` (used to find the element by its accessible name).",
    "",
    "For each step, propose the SHORTEST human-meaningful name that still",
    "uniquely and unambiguously identifies the tile/button — it must be a",
    "substring match of the visible label (the intent, or one of the recorded",
    "click labels below). Do not invent new text, do not change which element",
    "is targeted, and do not merge or drop steps. Only return a refinement for",
    "a step if you can improve on its current name; otherwise omit that index.",
    "",
    "Act steps:",
    stepLines,
    "",
    "Recorded click labels (for context on visible text):",
    labelLines,
    "",
    "Respond with refinements only — never add, remove, or reorder steps, and",
    "never add booking/confirm actions.",
  ].join("\n");
}

const refinementSchema = z.object({
  refinements: z.array(
    z.object({
      index: z.number(),
      name: z.string(),
    }),
  ),
});

/**
 * Refine a draft flow using a model. Returns a cleaned COPY. If `model` is
 * undefined OR the model call throws, returns the draft unchanged
 * (deterministic fallback — refine must never break the pipeline).
 */
export async function refineFlow(flow: Flow, recording: Recording, model?: LanguageModel): Promise<Flow> {
  if (!model) return flow;

  const actSteps = collectActSteps(flow);
  if (actSteps.length === 0) return flow;

  try {
    const prompt = buildPrompt(actSteps, collectClickLabels(recording));
    const result = await generateObject({
      model,
      schema: refinementSchema,
      prompt,
    });
    return applyNameRefinements(flow, result.object.refinements);
  } catch {
    return flow;
  }
}
