/**
 * Unit tests for resolveIntent — the fuzzy-matching safety layer that
 * decides whether a task-supplied intent string can be confidently mapped
 * onto a portal's canonical candidate strings.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveIntent } from "./resolve-intent.js";

test("exact unique match resolves with original casing", () => {
  const result = resolveIntent("Southview Internal Medicine", [
    "Southview Internal Medicine",
    "Brighton Family Medicine",
  ]);
  assert.deepEqual(result, {
    status: "resolved",
    value: "Southview Internal Medicine",
    matchedBy: "exact",
  });
});

test("contains match: single relevant candidate among unrelated ones", () => {
  // "Internal Medicine" is not a prefix of the candidate (so the startsWith
  // tier yields nothing) but does appear inside it, so the contains tier
  // is the first tier to produce a match.
  const result = resolveIntent("Internal Medicine", [
    "Southview Internal Medicine",
    "Brighton Family Medicine",
  ]);
  assert.deepEqual(result, {
    status: "resolved",
    value: "Southview Internal Medicine",
    matchedBy: "contains",
  });
});

test("contains match: multiple relevant candidates is ambiguous", () => {
  const result = resolveIntent("Southview", [
    "Southview Internal Medicine",
    "Southview Pediatrics",
  ]);
  assert.deepEqual(result, {
    status: "ambiguous",
    matches: ["Southview Internal Medicine", "Southview Pediatrics"],
  });
});

test("case- and whitespace-insensitive exact match", () => {
  const result = resolveIntent("  primary   CARE ", ["Primary Care"]);
  assert.deepEqual(result, {
    status: "resolved",
    value: "Primary Care",
    matchedBy: "exact",
  });
});

test("startsWith tier wins over a looser contains-only candidate", () => {
  const result = resolveIntent("New Patient", [
    "New Patient Adult Visit",
    "Established New Patient Follow-up",
  ]);
  assert.deepEqual(result, {
    status: "resolved",
    value: "New Patient Adult Visit",
    matchedBy: "startsWith",
  });
});

test("exact tier wins even when input is also a substring of another candidate", () => {
  const result = resolveIntent("Southview Internal Medicine", [
    "Southview Internal Medicine",
    "Southview Internal Medicine East",
  ]);
  assert.deepEqual(result, {
    status: "resolved",
    value: "Southview Internal Medicine",
    matchedBy: "exact",
  });
});

test("no matching candidate returns none", () => {
  const result = resolveIntent("Cardiology", [
    "Southview Internal Medicine",
    "Brighton Family Medicine",
  ]);
  assert.deepEqual(result, { status: "none" });
});

test("empty input and empty candidates both return none", () => {
  assert.deepEqual(resolveIntent("", ["Southview Internal Medicine"]), { status: "none" });
  assert.deepEqual(resolveIntent("   ", ["Southview Internal Medicine"]), { status: "none" });
  assert.deepEqual(resolveIntent("Southview", []), { status: "none" });
});

test("duplicate candidates equal after normalization collapse to one resolved match", () => {
  const result = resolveIntent("cardiology", ["Cardiology", "cardiology"]);
  assert.deepEqual(result, {
    status: "resolved",
    value: "Cardiology",
    matchedBy: "exact",
  });
});
