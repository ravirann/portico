/**
 * Unit tests for the query-rewriter's PURE normalizer (no network / no model).
 * The live model call in rewriteGoal is exercised via authoring; here we lock
 * the contract that a model response is coerced into a safe, well-formed plan.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePlan, buildSystemPrompt } from "./rewrite.js";

test("normalizePlan snake-cases param names, keeps values, and passes fields through", () => {
  const plan = normalizePlan(
    {
      refinedGoal: "1. Search for the customer. 2. Open profile. 3. Set language. 4. Save.",
      intent: "update",
      entities: ["customer"],
      parameters: [
        { name: "phoneNumber", value: "9717352594", description: "the customer phone" },
        { name: "LOP", value: "english", description: "target language" },
      ],
      expectedOutputs: ["customer record", "updated language"],
    },
    "raw goal",
  );
  assert.equal(plan.intent, "update");
  assert.deepEqual(plan.parameters.map((p) => p.name), ["phone_number", "lop"]);
  assert.equal(plan.parameters[0]!.value, "9717352594");
  assert.deepEqual(plan.entities, ["customer"]);
  assert.equal(plan.rawGoal, "raw goal");
});

test("normalizePlan defaults a bad/empty model response safely", () => {
  const plan = normalizePlan({}, "just do the thing");
  assert.equal(plan.refinedGoal, "just do the thing"); // falls back to the raw goal
  assert.equal(plan.intent, "read"); // safe default
  assert.deepEqual(plan.parameters, []);
});

test("normalizePlan drops malformed parameters and coerces an unknown intent", () => {
  const plan = normalizePlan(
    { intent: "frobnicate" as never, parameters: [{ name: "", value: "x" }, { value: "y" }, { name: "ok_one", value: "z" }] as never },
    "g",
  );
  assert.equal(plan.intent, "read"); // unknown → read
  assert.deepEqual(plan.parameters.map((p) => p.name), ["ok_one"]); // only the valid one survives
});

// ---------------------------------------------------------------------------
// buildSystemPrompt — sector vocabulary injection (pure, no API key/network)
// ---------------------------------------------------------------------------

test("buildSystemPrompt: no vocabulary leaves the base prompt unchanged (no-regression default)", () => {
  const base = buildSystemPrompt();
  assert.equal(buildSystemPrompt(undefined, undefined), base);
  assert.equal(buildSystemPrompt("", "healthcare"), base); // empty vocabulary → no block even with a sector key
  assert.ok(!base.includes("Domain context"));
});

test("buildSystemPrompt appends a clearly delimited domain-vocabulary block when vocabulary is non-empty", () => {
  const base = buildSystemPrompt();
  const withVocab = buildSystemPrompt("Healthcare portal terms: patient, MRN, encounter.", "healthcare");
  assert.ok(withVocab.startsWith(base), "base prompt must be preserved unchanged, block appended after");
  assert.ok(withVocab.includes("Domain context (sector: healthcare):"));
  assert.ok(withVocab.includes("Healthcare portal terms: patient, MRN, encounter."));
});

test("buildSystemPrompt trims vocabulary and labels an unknown sector when sectorKey is omitted", () => {
  const withVocab = buildSystemPrompt("  some domain terms  ");
  assert.ok(withVocab.includes("some domain terms"));
  assert.ok(!withVocab.includes("  some domain terms  ")); // trimmed, not the raw padded string
  assert.ok(withVocab.includes("Domain context (sector: unknown):"));
});
