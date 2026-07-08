import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateValidation, expectedOutputKeys } from "./validate-flow.js";
import type { Flow } from "@portico/flow-spec";

const flow: Flow = {
  key: "harvest",
  version: 1,
  steps: [
    { type: "navigate", url: "https://x" },
    { type: "intercept", intercept: { url_contains: "/GetSlots", as: "slots_raw" } },
    { type: "act", locator: { semantic: { role: "button", name: "Primary Care", intent: "tile" } } },
    { type: "wait", wait: { for: "slots_raw" } },
    { type: "select", select: { from: "slots_raw.Solutions.0.Slots", policy: "earliest", by: "DisplayDateTimeUtc", as: "chosen" } },
  ],
};

test("expectedOutputKeys returns the data products (intercept + select), not plumbing", () => {
  assert.deepEqual(expectedOutputKeys(flow).sort(), ["chosen", "slots_raw"]);
});

test("passes when completed and all expected outputs are populated", () => {
  const r = evaluateValidation(flow, {
    status: "completed",
    output: { slots_raw: { Solutions: [{ Slots: [{}] }] }, chosen: { TimeString: "8:00 AM" } },
  });
  assert.equal(r.passed, true);
  assert.deepEqual(r.reasons, []);
});

test("fails when the run did not complete, with the failure reason", () => {
  const r = evaluateValidation(flow, { status: "failed", failure: { reason: "act timed out" }, output: {} });
  assert.equal(r.passed, false);
  assert.match(r.reasons[0]!, /did not complete .*act timed out/);
});

test("fails when an expected output is missing or empty", () => {
  const r = evaluateValidation(flow, { status: "completed", output: { slots_raw: {}, chosen: null } });
  assert.equal(r.passed, false);
  // both slots_raw ({} is empty) and chosen (null) flagged
  assert.ok(r.reasons.some((x) => x.includes("slots_raw")));
  assert.ok(r.reasons.some((x) => x.includes("chosen")));
});

test("empty array output counts as empty", () => {
  const r = evaluateValidation(flow, { status: "completed", output: { slots_raw: [], chosen: { a: 1 } } });
  assert.equal(r.passed, false);
  assert.ok(r.reasons.some((x) => x.includes("slots_raw")));
});

test("a flow with no data outputs cannot be validated green", () => {
  const noData: Flow = { key: "k", version: 1, steps: [{ type: "navigate", url: "https://x" }, { type: "act", locator: { semantic: { intent: "x" } } }] };
  const r = evaluateValidation(noData, { status: "completed", output: {} });
  assert.equal(r.passed, false);
  assert.match(r.reasons[0]!, /no data outputs/);
});
