/**
 * Unit tests for the LLM refine pass: the pure name-refinement transform,
 * plus refineFlow's deterministic fallback when no model is configured.
 * No real model is invoked here — refineFlow is only exercised with
 * `model: undefined`, which must short-circuit before any model call.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyNameRefinements, applyRefinements, refineFlow } from "./refine-flow.js";
import type { Flow } from "@portico/flow-spec";
import type { Recording } from "./compile-recording.js";

function draftFlow(): Flow {
  return {
    key: "recorded-flow",
    version: 1,
    description: "Auto-compiled from a recorded demonstration.",
    guard: { no_booking: true, dry_run_only: true },
    steps: [
      { type: "navigate", label: "Open the page", url: "https://example.com" },
      {
        type: "act",
        label: 'Click "Primary Care  Includes adult, pediatric,"',
        locator: {
          semantic: {
            role: "button",
            name: "Primary Care  Includes adult, pediatric,",
            intent: "Primary Care  Includes adult, pediatric,",
          },
        },
      },
      {
        type: "act",
        label: 'Click "Next"',
        locator: { semantic: { role: "button", name: "Next", intent: "Next" } },
      },
      { type: "wait", label: "Wait for data", wait: { for: "data_raw", timeout_ms: 20000 } },
    ],
  };
}

test("applyNameRefinements sets the name on the targeted act step, preserves intent, and does not mutate the input", () => {
  const flow = draftFlow();
  const originalStep1 = flow.steps[1];
  const originalName = originalStep1?.locator?.semantic.name;

  const refined = applyNameRefinements(flow, [{ index: 1, name: "Primary Care" }]);

  assert.notEqual(refined, flow);
  const refinedStep1 = refined.steps[1];
  assert.equal(refinedStep1?.locator?.semantic.name, "Primary Care");
  assert.equal(refinedStep1?.locator?.semantic.intent, "Primary Care  Includes adult, pediatric,");

  // Input untouched.
  assert.equal(flow.steps[1]?.locator?.semantic.name, originalName);
  assert.equal(flow.steps[1]?.locator?.semantic.name, "Primary Care  Includes adult, pediatric,");
});

test("applyNameRefinements ignores out-of-range index and non-act steps", () => {
  const flow = draftFlow();

  // index 0 is a navigate step (no-op) and index 99 is out of range (no-op).
  const refined = applyNameRefinements(flow, [
    { index: 0, name: "should not apply" },
    { index: 99, name: "also should not apply" },
  ]);

  assert.deepEqual(refined.steps[0], flow.steps[0]);
  assert.equal(refined.steps.length, flow.steps.length);
  // Nothing else changed either.
  assert.deepEqual(refined.steps[1], flow.steps[1]);
  assert.deepEqual(refined.steps[2], flow.steps[2]);
  assert.deepEqual(refined.steps[3], flow.steps[3]);
});

test("applyNameRefinements with an empty array returns an equivalent flow (names unchanged)", () => {
  const flow = draftFlow();
  const refined = applyNameRefinements(flow, []);
  assert.deepEqual(refined, flow);
  assert.notEqual(refined, flow); // still a new object, per the "never mutates" contract
});

test("applyRefinements drops act steps by index, never anything else", () => {
  const flow = draftFlow();
  const refined = applyRefinements(flow, {
    renames: [{ index: 1, name: "Primary Care" }],
    // 0 = navigate, 3 = wait — both must be ignored; 2 = act "Next" — dropped;
    // 99 = out of range — ignored.
    drops: [0, 2, 3, 99],
  });

  assert.deepEqual(refined.steps.map((s) => s.type), ["navigate", "act", "wait"]);
  assert.equal(refined.steps[1]?.locator?.semantic.name, "Primary Care"); // rename applied before the drop
  assert.equal(flow.steps.length, 4); // input untouched
});

test("applyRefinements with no valid drops degrades to a pure rename", () => {
  const flow = draftFlow();
  const refined = applyRefinements(flow, { renames: [], drops: [0, 3] }); // both non-act
  assert.deepEqual(refined.steps, flow.steps);
});

test("refineFlow with no model configured resolves to the same flow content (deterministic fallback)", async () => {
  const flow = draftFlow();
  const recording: Recording = {
    baseUrl: "https://example.com",
    clicks: [{ ariaLabel: "Primary Care  Includes adult, pediatric,", tag: "DIV" }, { text: "Next", tag: "BUTTON" }],
    network: [],
  };

  const result = await refineFlow(flow, recording, undefined);

  assert.deepEqual(result.steps, flow.steps);
  assert.deepEqual(result, flow);
});
