/**
 * Unit tests for errors.ts — PorticoStepError, classifyError, and the
 * kind→resumable table.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyError, PorticoStepError, RESUMABLE_BY_KIND, type StepErrorKind } from "./errors.js";

const ALL_KINDS: StepErrorKind[] = [
  "timeout",
  "not_found",
  "ambiguous",
  "navigation",
  "network",
  "validation",
  "guard",
  "aborted",
  "egress_blocked",
  "unsupported",
  "unknown",
];

test("RESUMABLE_BY_KIND covers every StepErrorKind exactly once", () => {
  assert.deepEqual(Object.keys(RESUMABLE_BY_KIND).sort(), [...ALL_KINDS].sort());
});

test("RESUMABLE_BY_KIND: transient/unclassified kinds are resumable", () => {
  assert.equal(RESUMABLE_BY_KIND.timeout, true);
  assert.equal(RESUMABLE_BY_KIND.not_found, true);
  assert.equal(RESUMABLE_BY_KIND.navigation, true);
  assert.equal(RESUMABLE_BY_KIND.network, true);
  assert.equal(RESUMABLE_BY_KIND.unknown, true);
});

test("RESUMABLE_BY_KIND: policy/precision failures are NOT resumable", () => {
  assert.equal(RESUMABLE_BY_KIND.guard, false);
  assert.equal(RESUMABLE_BY_KIND.validation, false);
  assert.equal(RESUMABLE_BY_KIND.unsupported, false);
  assert.equal(RESUMABLE_BY_KIND.egress_blocked, false);
  assert.equal(RESUMABLE_BY_KIND.aborted, false);
  assert.equal(RESUMABLE_BY_KIND.ambiguous, false);
});

test("PorticoStepError carries its kind and reads as a normal Error", () => {
  const err = new PorticoStepError("timeout", "boom");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "PorticoStepError");
  assert.equal(err.kind, "timeout");
  assert.equal(err.message, "boom");
});

test("classifyError: a PorticoStepError reports its own kind + the matching resumability, for every kind", () => {
  for (const kind of ALL_KINDS) {
    const { kind: k, resumable } = classifyError(new PorticoStepError(kind, "x"));
    assert.equal(k, kind);
    assert.equal(resumable, RESUMABLE_BY_KIND[kind]);
  }
});

test("classifyError: a Playwright-style TimeoutError → timeout (resumable)", () => {
  const err = new Error("Timeout 5000ms exceeded");
  err.name = "TimeoutError";
  const { kind, resumable } = classifyError(err);
  assert.equal(kind, "timeout");
  assert.equal(resumable, true);
});

test("classifyError: network-shaped messages → network (resumable)", () => {
  for (const msg of [
    "net::ERR_CONNECTION_REFUSED at https://x",
    "getaddrinfo ENOTFOUND example.com",
    "read ECONNRESET",
    "fetch failed",
    "net::ERR_NAME_NOT_RESOLVED",
  ]) {
    const { kind, resumable } = classifyError(new Error(msg));
    assert.equal(kind, "network", `expected "${msg}" to classify as network, got "${kind}"`);
    assert.equal(resumable, true);
  }
});

test("classifyError: a Playwright strict-mode violation → ambiguous (NOT resumable)", () => {
  const { kind, resumable } = classifyError(new Error("strict mode violation: locator resolved to 2 elements"));
  assert.equal(kind, "ambiguous");
  assert.equal(resumable, false);
});

test("classifyError: an unrecognized Error → unknown (resumable)", () => {
  const { kind, resumable } = classifyError(new Error("something else broke"));
  assert.equal(kind, "unknown");
  assert.equal(resumable, true);
});

test("classifyError: non-Error thrown values are stringified and still classified", () => {
  assert.equal(classifyError("net::ERR_FAILED").kind, "network");
  assert.equal(classifyError({ weird: true }).kind, "unknown");
  assert.equal(classifyError(undefined).kind, "unknown");
  assert.equal(classifyError(null).kind, "unknown");
});

test("classifyError: name-only 'TimeoutError' checks require an actual Error instance (a plain object doesn't count)", () => {
  // Guards against a naive `(err as any).name === "TimeoutError"` check that
  // would misfire on non-Error objects that happen to carry a `.name` field.
  const { kind } = classifyError({ name: "TimeoutError", message: "not really an Error" });
  assert.notEqual(kind, "timeout");
});
