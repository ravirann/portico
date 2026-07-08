/**
 * Unit tests for pickByPolicy — the pure slot-selection policy used to turn
 * a `slot_preference` input into one concrete appointment slot.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { pickByPolicy } from "./pick-slot.js";

const slots = [
  { DisplayDateTimeUtc: "2026-09-10T14:00:00Z", TimeString: "10:00 AM" }, // 0
  { DisplayDateTimeUtc: "2026-09-04T17:30:00Z", TimeString: "1:30 PM" }, // 1 - earliest
  { DisplayDateTimeUtc: "2026-09-20T09:00:00Z", TimeString: "5:00 AM" }, // 2 - latest
];

test("non-array input returns null", () => {
  assert.equal(pickByPolicy(null as unknown as Array<Record<string, unknown>>, "first"), null);
  assert.equal(pickByPolicy(undefined as unknown as Array<Record<string, unknown>>, "first"), null);
});

test("empty array returns null", () => {
  assert.equal(pickByPolicy([], "first"), null);
  assert.equal(pickByPolicy([], "earliest", { by: "DisplayDateTimeUtc" }), null);
});

test('"first" returns index 0 regardless of by/compare', () => {
  const result = pickByPolicy(slots, "first");
  assert.deepEqual(result, { index: 0, item: slots[0] });
});

test('"index:2" returns the item at that original index', () => {
  const result = pickByPolicy(slots, "index:2");
  assert.deepEqual(result, { index: 2, item: slots[2] });
});

test('"index:9" out of range returns null', () => {
  assert.equal(pickByPolicy(slots, "index:9"), null);
});

test('"earliest" over an unsorted list returns the min by original index', () => {
  const result = pickByPolicy(slots, "earliest", { by: "DisplayDateTimeUtc" });
  assert.deepEqual(result, { index: 1, item: slots[1] });
});

test('"latest" over an unsorted list returns the max by original index', () => {
  const result = pickByPolicy(slots, "latest", { by: "DisplayDateTimeUtc" });
  assert.deepEqual(result, { index: 2, item: slots[2] });
});

test("tie on earliest resolves to the lowest original index", () => {
  const tied = [
    { DisplayDateTimeUtc: "2026-09-10T14:00:00Z" }, // 0
    { DisplayDateTimeUtc: "2026-09-05T00:00:00Z" }, // 1 - tied earliest
    { DisplayDateTimeUtc: "2026-09-05T00:00:00Z" }, // 2 - tied earliest, later index
  ];
  const result = pickByPolicy(tied, "earliest", { by: "DisplayDateTimeUtc" });
  assert.deepEqual(result, { index: 1, item: tied[1] });
});

test("tie on latest resolves to the lowest original index", () => {
  const tied = [
    { DisplayDateTimeUtc: "2026-09-20T00:00:00Z" }, // 0 - tied latest
    { DisplayDateTimeUtc: "2026-09-05T00:00:00Z" }, // 1
    { DisplayDateTimeUtc: "2026-09-20T00:00:00Z" }, // 2 - tied latest, later index
  ];
  const result = pickByPolicy(tied, "latest", { by: "DisplayDateTimeUtc" });
  assert.deepEqual(result, { index: 0, item: tied[0] });
});

test('"on-or-after" picks the earliest qualifying slot among a Sept/Oct/Nov mix', () => {
  const mixed = [
    { DisplayDateTimeUtc: "2026-09-15T00:00:00Z" }, // 0 - too early
    { DisplayDateTimeUtc: "2026-11-01T00:00:00Z" }, // 1 - qualifies, later
    { DisplayDateTimeUtc: "2026-10-05T00:00:00Z" }, // 2 - qualifies, earliest of qualifiers
    { DisplayDateTimeUtc: "2026-09-30T23:00:00Z" }, // 3 - too early
  ];
  const result = pickByPolicy(mixed, "on-or-after:2026-10-01", { by: "DisplayDateTimeUtc" });
  assert.deepEqual(result, { index: 2, item: mixed[2] });
});

test('"on-or-after" returns null when nothing qualifies', () => {
  const allEarly = [
    { DisplayDateTimeUtc: "2026-09-01T00:00:00Z" },
    { DisplayDateTimeUtc: "2026-09-15T00:00:00Z" },
  ];
  const result = pickByPolicy(allEarly, "on-or-after:2026-10-01", { by: "DisplayDateTimeUtc" });
  assert.equal(result, null);
});

test('"on-or-after" with an invalid threshold returns null', () => {
  const result = pickByPolicy(slots, "on-or-after:not-a-date" as unknown as "on-or-after:2026-10-01", {
    by: "DisplayDateTimeUtc",
  });
  assert.equal(result, null);
});

test("items missing the `by` field are skipped for earliest, not crashed on", () => {
  const withGaps = [
    { DisplayDateTimeUtc: "2026-09-10T00:00:00Z" }, // 0
    { TimeString: "no date on this one" }, // 1 - missing by field
    { DisplayDateTimeUtc: "2026-09-01T00:00:00Z" }, // 2 - earliest
  ];
  const result = pickByPolicy(withGaps, "earliest", { by: "DisplayDateTimeUtc" });
  assert.deepEqual(result, { index: 2, item: withGaps[2] });
});

test("earliest with no orderable items (all missing/unparseable) returns null", () => {
  const noneOrderable = [{ TimeString: "x" }, { DisplayDateTimeUtc: "not-a-date" }];
  const result = pickByPolicy(noneOrderable, "earliest", { by: "DisplayDateTimeUtc" });
  assert.equal(result, null);
});

test("earliest without `by` option returns null", () => {
  assert.equal(pickByPolicy(slots, "earliest"), null);
});

test('compare:"number" orders numerically', () => {
  const numeric = [
    { priority: 30 }, // 0
    { priority: 10 }, // 1 - lowest
    { priority: 20 }, // 2
  ];
  const result = pickByPolicy(numeric, "earliest", { by: "priority", compare: "number" });
  assert.deepEqual(result, { index: 1, item: numeric[1] });
});

test('compare:"string" orders lexicographically', () => {
  const lexical = [
    { room: "C-Wing" }, // 0
    { room: "A-Wing" }, // 1 - lowest lexically
    { room: "B-Wing" }, // 2
  ];
  const result = pickByPolicy(lexical, "earliest", { by: "room", compare: "string" });
  assert.deepEqual(result, { index: 1, item: lexical[1] });
});

test("unrecognized policy string returns null", () => {
  const result = pickByPolicy(slots, "whenever-works" as unknown as "first");
  assert.equal(result, null);
});

test("does not mutate the input array", () => {
  const original = [
    { DisplayDateTimeUtc: "2026-09-10T14:00:00Z" },
    { DisplayDateTimeUtc: "2026-09-04T17:30:00Z" },
  ];
  const snapshot = JSON.parse(JSON.stringify(original));
  pickByPolicy(original, "latest", { by: "DisplayDateTimeUtc" });
  assert.deepEqual(original, snapshot);
});
