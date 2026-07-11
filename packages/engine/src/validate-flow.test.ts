import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateValidation, expectedOutputKeys, requiredOutputKeys, missingFlowInputs, sampleInputsFromFlow } from "./validate-flow.js";
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

test("requiredOutputKeys keeps select/extract + the WAITED intercept, drops opportunistic ones", () => {
  assert.deepEqual(requiredOutputKeys(flow).sort(), ["chosen", "slots_raw"]);
});

test("requiredOutputKeys: required:true survives the waited-on narrowing (added, not replacing it)", () => {
  const withRequired: Flow = {
    key: "req-intercept-narrowed",
    version: 1,
    steps: [
      { type: "navigate", url: "https://x" },
      { type: "intercept", intercept: { url_contains: "/critical", as: "critical_data", required: true } },
      { type: "intercept", intercept: { url_contains: "/wizard-step", as: "wizard_data" } },
      { type: "wait", wait: { for: "wizard_data" } }, // narrows the waited-on set to wizard_data only
    ],
  };
  // wizard_data is required because it's waited on; critical_data is
  // required because it's explicitly marked required:true — despite NOT
  // being the waited-on key, so it must NOT be narrowed away.
  assert.deepEqual(requiredOutputKeys(withRequired).sort(), ["critical_data", "wizard_data"]);
});

test("requiredOutputKeys: required:true with no wait at all is still required (on top of the all-intercepts fallback)", () => {
  const withRequired: Flow = {
    key: "req-intercept-nowait",
    version: 1,
    steps: [
      { type: "navigate", url: "https://x" },
      { type: "intercept", intercept: { url_contains: "/critical", as: "critical_data", required: true } },
      { type: "intercept", intercept: { url_contains: "/optional", as: "optional_data" } },
    ],
  };
  assert.deepEqual(requiredOutputKeys(withRequired).sort(), ["critical_data", "optional_data"]);
});

test("evaluateValidation: a required:true intercept that never fired fails validation even though nothing waits on it", () => {
  const withRequired: Flow = {
    key: "req-intercept-eval",
    version: 1,
    steps: [
      { type: "navigate", url: "https://x" },
      { type: "intercept", intercept: { url_contains: "/critical", as: "critical_data", required: true } },
      { type: "intercept", intercept: { url_contains: "/wizard-step", as: "wizard_data" } },
      { type: "wait", wait: { for: "wizard_data" } },
    ],
  };
  const r = evaluateValidation(withRequired, { status: "completed", output: { wizard_data: { a: 1 } } }); // critical_data missing
  assert.equal(r.passed, false);
  assert.ok(r.reasons.some((x) => x.includes("critical_data")));
});

test("opportunistic (non-waited) wizard intercepts do NOT gate validation — the URMC scheduling case", () => {
  // Three intercepts captured while the agent clicked through the scheduler, but
  // the deterministic flow only navigates + waits on the primary. GetSpecialtyData
  // and Menu fire only on interactions the flow does not replay, so their being
  // empty on a dry-run must not fail validation.
  const wizard: Flow = {
    key: "urmc-consult-scheduling",
    version: 1,
    steps: [
      { type: "intercept", intercept: { url_contains: "/Scheduling/GetSchedulingWorkflowData", as: "data_raw" } },
      { type: "intercept", intercept: { url_contains: "/Scheduling/GetSpecialtyData", as: "data_1" } },
      { type: "intercept", intercept: { url_contains: "/Menu", as: "data_2" } },
      { type: "navigate", url: "https://mychart.urmc.rochester.edu/MyChart/Scheduling" },
      { type: "wait", wait: { for: "data_raw" } },
    ],
  };
  const r = evaluateValidation(wizard, { status: "completed", output: { data_raw: { Workflow: 1 }, data_1: {}, data_2: undefined } });
  assert.equal(r.passed, true);
  assert.deepEqual(r.reasons, []);
});

test("a harvest with NO wait still requires every intercept (no signal to narrow)", () => {
  const noWait: Flow = {
    key: "k",
    version: 1,
    steps: [
      { type: "intercept", intercept: { url_contains: "/a", as: "a" } },
      { type: "intercept", intercept: { url_contains: "/b", as: "b" } },
      { type: "navigate", url: "https://x" },
    ],
  };
  const r = evaluateValidation(noWait, { status: "completed", output: { a: { x: 1 }, b: {} } });
  assert.equal(r.passed, false);
  assert.ok(r.reasons.some((x) => x.includes("b")));
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

test("missingFlowInputs catches inputs referenced only in an api step's body/headers/url", () => {
  const flow: Flow = {
    key: "w", version: 1,
    inputs: { phone_number: "string", lop: "string", auth_token: "string" },
    steps: [
      { type: "navigate", url: "https://x/lens?phoneNumber={{phone_number}}" },
      {
        type: "read",
        api: {
          url: "https://x/api/family/{{customer.family.id}}/members/{{customer.id}}/lop",
          method: "PUT",
          headers: { Authorization: "Bearer {{auth_token}}" },
          body: { lop: "{{lop}}" },
        },
      } as unknown as Flow["steps"][number],
    ],
  };
  // lop + auth_token are only in the api block; all three must be detected.
  assert.deepEqual(missingFlowInputs(flow, {}).sort(), ["auth_token", "lop", "phone_number"]);
  // With values provided, none are missing.
  assert.deepEqual(missingFlowInputs(flow, { phone_number: "9717352594", lop: "hindi", auth_token: "t" }), []);
  // An empty lop is still caught (would otherwise send an empty write).
  assert.deepEqual(missingFlowInputs(flow, { phone_number: "9717352594", lop: "  ", auth_token: "t" }), ["lop"]);
});
