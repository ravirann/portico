/**
 * Unit tests for the query-rewriter's PURE normalizer (no network / no model).
 * The live model call in rewriteGoal is exercised via authoring; here we lock
 * the contract that a model response is coerced into a safe, well-formed plan.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePlan } from "./rewrite.js";

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
