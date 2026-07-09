import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveTier } from "./tier.js";

// A run that reaches its data purely by navigating to the authenticated page
// and passively capturing the JSON the SPA fetches — no DOM interaction.
test("pure navigate + intercept harvest → api", () => {
  const traces = [
    { type: "intercept", status: "ok" as const },
    { type: "navigate", status: "ok" as const },
    { type: "wait", status: "ok" as const },
    { type: "select", status: "ok" as const },
  ];
  assert.equal(deriveTier(traces), "api");
});

// The URMC scheduling wizard: the run clicks through the DOM to reach the slot
// screen, then intercepts GetSlots. It DID drive the DOM → dom, not api.
test("acts alongside intercept → dom (DOM interaction dominates api)", () => {
  const traces = [
    { type: "navigate", status: "ok" as const },
    { type: "act", status: "ok" as const },
    { type: "act", status: "ok" as const },
    { type: "intercept", status: "ok" as const },
    { type: "wait", status: "ok" as const },
  ];
  assert.equal(deriveTier(traces), "dom");
});

test("a self-heal at run time → agent (dominates everything)", () => {
  const traces = [
    { type: "navigate", status: "ok" as const },
    { type: "act", status: "healed" as const },
    { type: "intercept", status: "ok" as const },
  ];
  assert.equal(deriveTier(traces), "agent");
});

test("healedFrom set (even if status not 'healed') → agent", () => {
  const traces = [
    { type: "act", status: "ok" as const, healedFrom: "button:has-text('Schedule')" },
  ];
  assert.equal(deriveTier(traces), "agent");
});

test("skipped steps don't count toward a tier", () => {
  const traces = [
    { type: "act", status: "skipped" as const }, // didn't run — ignore
    { type: "intercept", status: "ok" as const },
    { type: "wait", status: "ok" as const },
  ];
  assert.equal(deriveTier(traces), "api");
});

test("empty / unclassifiable traces fall back to dom", () => {
  assert.equal(deriveTier([]), "dom");
  assert.equal(deriveTier([{ type: "guard", status: "ok" as const }]), "dom");
});

test("a login subflow counts as DOM even without explicit acts", () => {
  const traces = [
    { type: "subflow", status: "ok" as const },
    { type: "intercept", status: "ok" as const },
  ];
  assert.equal(deriveTier(traces), "dom");
});
