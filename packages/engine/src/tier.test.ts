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

test("a model-assisted self-heal at run time → agent (dominates everything)", () => {
  const traces = [
    { type: "navigate", status: "ok" as const },
    { type: "act", status: "healed" as const, healedBy: "model" as const },
    { type: "intercept", status: "ok" as const },
  ];
  assert.equal(deriveTier(traces), "agent");
});

// ADR-0004: recovery is deterministic-first and runs with no heal model
// configured, so "healed" alone means an overlay was dismissed / a retry
// cleared a transient — no model call. The step classifies by its own type.
test("a deterministic self-heal does NOT escalate → dom (the act's own tier)", () => {
  const traces = [
    { type: "navigate", status: "ok" as const },
    { type: "act", status: "healed" as const, healedBy: "deterministic" as const },
    { type: "intercept", status: "ok" as const },
  ];
  assert.equal(deriveTier(traces), "dom");
});

// A healed trace from before healedBy existed carries no flag — without
// positive evidence of a model call it must not claim the agent tier.
test("a healed trace without healedBy (pre-flag) → dom, not agent", () => {
  const traces = [
    { type: "act", status: "healed" as const },
  ];
  assert.equal(deriveTier(traces), "dom");
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
