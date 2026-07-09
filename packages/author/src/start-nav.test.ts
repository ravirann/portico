/**
 * Unit tests for the start-navigation decision. The bug this guards against:
 * authoring force-navigated an already-logged-in tab to the bare portal root,
 * and Epic MyChart cleared its session cookies on that root hit — silently
 * logging the user out before the agent ran. Verified live via an instrumented
 * trace. The rule: don't navigate when the tab is already on the target origin.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldNavigateToStart } from "./index.js";

const START = "https://mychart.urmc.rochester.edu";

test("does NOT navigate when already on the target origin (authenticated page)", () => {
  // The exact failing case: parked on /MyChart/Home, start URL is the bare root.
  assert.equal(shouldNavigateToStart("https://mychart.urmc.rochester.edu/MyChart/Home?", START), false);
});

test("does NOT navigate for a same-origin deep path either", () => {
  assert.equal(
    shouldNavigateToStart("https://mychart.urmc.rochester.edu/MyChart/Messaging", `${START}/MyChart/scheduling`),
    false,
  );
});

test("navigates from a blank / new tab", () => {
  assert.equal(shouldNavigateToStart("about:blank", START), true);
  assert.equal(shouldNavigateToStart("", START), true);
  assert.equal(shouldNavigateToStart(undefined, START), true);
  assert.equal(shouldNavigateToStart("chrome://newtab/", START), true);
});

test("navigates when the tab is on a different origin", () => {
  assert.equal(shouldNavigateToStart("https://www.google.com/", START), true);
  assert.equal(shouldNavigateToStart("https://pulse.clinikk.com/claims", START), true);
});

test("distinguishes origin by scheme/host/port, not just host substring", () => {
  assert.equal(shouldNavigateToStart("http://mychart.urmc.rochester.edu/", START), true); // http ≠ https
  assert.equal(shouldNavigateToStart("https://evil-mychart.urmc.rochester.edu.attacker.com/", START), true);
});

test("falls back to navigating on an unparseable start URL", () => {
  assert.equal(shouldNavigateToStart("https://mychart.urmc.rochester.edu/MyChart/Home", "not a url"), true);
});
