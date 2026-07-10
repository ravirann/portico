/**
 * Authoring-quality eval suite: scores two-source reconciliation over saved
 * capture fixtures so a locator/reconciliation regression fails CI instead of
 * relying on a human eyeballing a run. See ./README.md to run standalone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreFixture } from "./score.js";
import { cleanWizardFixture, blobNoiseWizardFixture, ALL_FIXTURES } from "./fixtures/index.js";

test("clean-wizard: perfect reconciliation, zero loss", () => {
  const report = scoreFixture(cleanWizardFixture);
  assert.equal(report.usedAgentStream, true);
  assert.equal(report.stepCount, 4);
  assert.deepEqual(report.stepNames, cleanWizardFixture.expectedNames);
  assert.equal(report.cleanNameRate, 1, `expected 1, got ${report.cleanNameRate} (${report.stepNames.join(" | ")})`);
  assert.equal(report.containerIdCacheCount, 0);
  assert.equal(report.noiseDropped, 0);
  assert.equal(report.blobLeakCount, 0);
  assert.deepEqual(report.confidence, { high: 4, medium: 0, low: 0 });
});

test("blob-noise-wizard: clean names win over blobs, container id never cached, all noise dropped", () => {
  const report = scoreFixture(blobNoiseWizardFixture);
  assert.equal(report.usedAgentStream, true);
  assert.equal(report.stepCount, 4);
  // The whole point of the eval: reconciliation binds to the clean node's
  // real accessible name, never the page-level blob's concatenated text.
  assert.deepEqual(report.stepNames, blobNoiseWizardFixture.expectedNames);
  assert.equal(report.cleanNameRate, 1, `expected 1, got ${report.cleanNameRate} (${report.stepNames.join(" | ")})`);
  // Regression guard: never freeze a step's identity to the generic <main>
  // container (the id="main" blobs must lose to the clean nodes).
  assert.equal(report.containerIdCacheCount, 0);
  // No 72+-char blob text survived into a reconciled step.
  assert.equal(report.blobLeakCount, 0);
  // All 5 noise clicks (4 blobs + 1 untouched notification) were dropped.
  assert.equal(report.noiseDropped, 5);
  // 3 exact-xpath (high) matches + 1 label-only (medium) match for "Continue".
  assert.deepEqual(report.confidence, { high: 3, medium: 1, low: 0 });
});

test("no fixture leaks a container/notification blob's text into a reconciled step", () => {
  for (const fixture of ALL_FIXTURES) {
    const report = scoreFixture(fixture);
    for (const name of report.stepNames) {
      assert.ok(
        !/notifications|lab results|confirm your selections|skip to main content/i.test(name),
        `blob/noise text leaked into "${fixture.name}": "${name}"`,
      );
    }
  }
});

test("every fixture clears the authoring-quality bar (regression thresholds)", () => {
  for (const fixture of ALL_FIXTURES) {
    const report = scoreFixture(fixture);
    assert.equal(report.cleanNameRate, 1, `${fixture.name}: cleanNameRate must be 1`);
    assert.equal(report.containerIdCacheCount, 0, `${fixture.name}: containerIdCacheCount must be 0`);
    assert.equal(report.blobLeakCount, 0, `${fixture.name}: blobLeakCount must be 0`);
    assert.equal(report.usedAgentStream, true, `${fixture.name}: expected the agent stream to correlate`);
  }
});
