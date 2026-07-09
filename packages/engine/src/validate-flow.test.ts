import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateValidation, expectedOutputKeys, missingFlowInputs, sampleInputsFromFlow } from "./validate-flow.js";
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

// ---------------------------------------------------------------------------
// missingFlowInputs — the pre-launch input gate
// ---------------------------------------------------------------------------

test("missingFlowInputs flags referenced-but-unprovided (and blank) declared inputs", () => {
  const flow: Flow = {
    key: "read-claims",
    version: 4,
    inputs: { claim_status: "string", customer_name: "string", unused_note: "string" },
    steps: [
      { type: "navigate", url: "https://pulse.example.com/claims" },
      { type: "act", label: "filter", locator: { semantic: { role: "button", name: "{{claim_status}}", intent: "status chip" } } },
      { type: "act", label: "row", locator: { semantic: { name: "{{customer_name}}", intent: "claim row" } } },
    ],
  };
  // Nothing provided → both referenced inputs are missing; the unreferenced one is not.
  assert.deepEqual(missingFlowInputs(flow, {}), ["claim_status", "customer_name"]);
  // Blank counts as missing (the console form submits empty strings).
  assert.deepEqual(missingFlowInputs(flow, { claim_status: "IN_PROGRESS", customer_name: "  " }), ["customer_name"]);
  // Fully provided → clean.
  assert.deepEqual(missingFlowInputs(flow, { claim_status: "IN_PROGRESS", customer_name: "Prasanna Kumar D E" }), []);
});

test("missingFlowInputs ignores output refs, secrets, and flows with no declared inputs", () => {
  const flow: Flow = {
    key: "f",
    version: 1,
    steps: [
      { type: "act", label: "x", value: "{{secrets.password}}", locator: { semantic: { name: "{{location_resolved}}", intent: "i" } } },
    ],
  };
  assert.deepEqual(missingFlowInputs(flow, {}), []); // no inputs declared at all
  const declared: Flow = { ...flow, inputs: { location: "string" } };
  // "location" is declared but never referenced; the {{location_resolved}} ref is a prior-step output.
  assert.deepEqual(missingFlowInputs(declared, {}), []);
});

test("sampleInputsFromFlow lifts examples from hints and tolerates bare values", () => {
  const flow: Flow = {
    key: "f", version: 1,
    inputs: { phone_number: "string — e.g. 9717352594", lop: "hindi", note: "string" },
    steps: [],
  };
  const s = sampleInputsFromFlow(flow);
  assert.equal(s.phone_number, "9717352594"); // lifted from "e.g."
  assert.equal(s.lop, "hindi");               // bare value used directly
  assert.equal(s.note, "string");             // hint with no example → the hint (harmless)
});
