/**
 * Unit tests for sectors.ts — the SectorProfile catalog and its resolver.
 * Pins down the no-regression contract (generic must reproduce the engine's
 * historical hardcoded defaults) and the shape invariants every profile
 * must satisfy.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SECTOR_PROFILES, resolveSectorProfile, listSectors, type SectorKey } from "./sectors.js";

const ALL_KEYS: SectorKey[] = [
  "healthcare",
  "communications",
  "finance",
  "government",
  "commerce",
  "saas_ops",
  "generic",
];

test("every SectorKey is present in SECTOR_PROFILES and profile.key matches its record key", () => {
  for (const key of ALL_KEYS) {
    const profile = SECTOR_PROFILES[key];
    assert.ok(profile, `missing profile for ${key}`);
    assert.equal(profile.key, key);
  }
});

test("resolveSectorProfile falls back to generic for undefined/null/unknown keys", () => {
  assert.equal(resolveSectorProfile(undefined), SECTOR_PROFILES.generic);
  assert.equal(resolveSectorProfile(null), SECTOR_PROFILES.generic);
  assert.equal(resolveSectorProfile("bogus"), SECTOR_PROFILES.generic);
});

test("resolveSectorProfile returns the exact match for a known key", () => {
  assert.equal(resolveSectorProfile("communications"), SECTOR_PROFILES.communications);
});

test("generic profile reproduces the engine's historical hardcoded defaults (no-regression contract)", () => {
  const g = SECTOR_PROFILES.generic;
  assert.equal(g.readiness.navigateQuietMs, 500);
  assert.equal(g.readiness.navigateTimeoutMs, 8000);
  assert.equal(g.readiness.actQuietMs, 300);
  assert.equal(g.readiness.actTimeoutMs, 3000);
  assert.equal(g.timing.stepTimeoutMs, 15000);
  assert.equal(g.timing.navTimeoutMs, 60000);
  assert.equal(g.timing.extractTimeoutMs, 10000);
  assert.equal(g.timing.apiTimeoutMs, 30000);
  assert.equal(g.timing.readTimeoutMs, 15000);
  assert.equal(g.timing.actionDelayMs, 0);
  assert.equal(g.retry.navigateMax, 1);
  assert.equal(g.retry.actMax, 1);
  assert.equal(g.retry.extractMax, 2);
  assert.equal(g.retry.apiIdempotentMax, 1);
  assert.equal(g.retry.backoffMs, 500);
});

test("communications distrusts cached CSS selectors (obfuscated/rotating class names)", () => {
  assert.equal(SECTOR_PROFILES.communications.locator.cssCacheTrusted, false);
});

test("finance retries acts at most once (duplicate submission risk)", () => {
  assert.equal(SECTOR_PROFILES.finance.retry.actMax, 1);
});

test("every profile satisfies basic numeric/non-empty invariants", () => {
  for (const key of ALL_KEYS) {
    const profile = SECTOR_PROFILES[key];
    assert.ok(profile.retry.apiIdempotentMax >= 0, `${key}: apiIdempotentMax must be >= 0`);
    assert.ok(profile.timing.actionDelayMs >= 0, `${key}: actionDelayMs must be >= 0`);
    assert.ok(profile.guards.mutationKeywords.length > 0, `${key}: mutationKeywords must be non-empty`);
  }
});

test("every authoring.noisePatterns entry compiles as a case-insensitive regex", () => {
  for (const key of ALL_KEYS) {
    for (const pattern of SECTOR_PROFILES[key].authoring.noisePatterns) {
      assert.doesNotThrow(() => new RegExp(pattern, "i"), `${key}: noise pattern "${pattern}" failed to compile`);
    }
  }
});

test("listSectors returns all 7 keys, including generic", () => {
  const keys = listSectors();
  assert.equal(keys.length, 7);
  assert.ok(keys.includes("generic"));
  for (const key of ALL_KEYS) {
    assert.ok(keys.includes(key), `listSectors() missing ${key}`);
  }
});
