/**
 * Unit tests for the runner's pure helpers. The runner itself needs a live
 * browser; what's tested here is the start-navigation origin inference that
 * lets read/api-first flows run when the target has no base_url, plus the
 * egress-boundary decision functions, abort racing, and the fast fail-before-
 * any-browser-launches gates (missing inputs / dry_run_only guard).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Flow, Target } from "@portico/flow-spec";
import {
  hostAllowed,
  inferStartOrigin,
  raceAbort,
  renderTemplate,
  runFlow,
  seedOutput,
  shouldBlockEgress,
} from "./runner.js";
import { PorticoStepError } from "./errors.js";
import type { EngineRunOptions } from "./types.js";

const steps = (arr: unknown[]) => arr as Flow["steps"];

test("inferStartOrigin: read-first flow (Gmail shape) yields the first api step's origin", () => {
  const s = steps([
    { type: "read", read: { expression: "localStorage.getItem('x')", as: "x" } },
    {
      type: "read",
      label: "Update result (POST)",
      api: { url: "https://mail.google.com/sync/u/0/i/s?hl=en", method: "POST" },
    },
    { type: "read", api: { url: "https://ogads-pa.clients6.google.com/$rpc/x", method: "POST" } },
  ]);
  assert.equal(inferStartOrigin(s), "https://mail.google.com");
});

test("inferStartOrigin: navigate urls count too, and templated origins are skipped", () => {
  const s = steps([
    { type: "navigate", url: "{{n}}/MyChart/Scheduling" }, // relative template — no origin
    { type: "navigate", url: "https://{{host}}/portal" }, // templated origin — unusable
    { type: "navigate", url: "https://portal.example.com/login?next=1" },
  ]);
  assert.equal(inferStartOrigin(s), "https://portal.example.com");
});

test("inferStartOrigin: no absolute concrete URL anywhere → undefined", () => {
  const s = steps([
    { type: "read", read: { expression: "1+1", as: "x" } },
    { type: "navigate", url: "{{base_url}}/home" },
  ]);
  assert.equal(inferStartOrigin(s), undefined);
});

// ---------------------------------------------------------------------------
// hostAllowed — exact / subdomain / deny
// ---------------------------------------------------------------------------

test("hostAllowed: exact match", () => {
  assert.equal(hostAllowed("example.com", ["example.com"]), true);
});

test("hostAllowed: subdomain (dot-suffix) match", () => {
  assert.equal(hostAllowed("mychart.epic.com", ["epic.com"]), true);
  assert.equal(hostAllowed("a.b.example.com", ["example.com"]), true);
});

test("hostAllowed: denies a merely-prefixed host (not a real subdomain)", () => {
  assert.equal(hostAllowed("evilexample.com", ["example.com"]), false);
  assert.equal(hostAllowed("example.com.evil.net", ["example.com"]), false);
});

test("hostAllowed: denies an unrelated host", () => {
  assert.equal(hostAllowed("other.com", ["example.com"]), false);
});

test("hostAllowed: case-insensitive on both sides", () => {
  assert.equal(hostAllowed("Example.COM", ["example.com"]), true);
  assert.equal(hostAllowed("example.com", ["EXAMPLE.COM"]), true);
});

test("hostAllowed: an empty allow-list denies everything", () => {
  assert.equal(hostAllowed("example.com", []), false);
});

test("hostAllowed: matches ANY entry in a multi-domain allow-list", () => {
  assert.equal(hostAllowed("api.epic.com", ["example.com", "epic.com"]), true);
  assert.equal(hostAllowed("api.unrelated.com", ["example.com", "epic.com"]), false);
});

// ---------------------------------------------------------------------------
// shouldBlockEgress — the route handler's pure decision function
// ---------------------------------------------------------------------------

test("shouldBlockEgress: an allowed host is never blocked, regardless of method or frame", () => {
  assert.equal(shouldBlockEgress({ method: "GET", host: "example.com", isMainFrameNavigation: true }, ["example.com"]), false);
  assert.equal(shouldBlockEgress({ method: "POST", host: "example.com", isMainFrameNavigation: false }, ["example.com"]), false);
});

test("shouldBlockEgress: a main-frame navigation to a non-allowed host is blocked", () => {
  assert.equal(shouldBlockEgress({ method: "GET", host: "evil.com", isMainFrameNavigation: true }, ["example.com"]), true);
});

test("shouldBlockEgress: GET subresources to a non-allowed host PASS (CDNs/fonts/analytics render fine)", () => {
  assert.equal(shouldBlockEgress({ method: "GET", host: "cdn.assets.com", isMainFrameNavigation: false }, ["example.com"]), false);
  assert.equal(shouldBlockEgress({ method: "HEAD", host: "fonts.assets.com", isMainFrameNavigation: false }, ["example.com"]), false);
  assert.equal(shouldBlockEgress({ method: "OPTIONS", host: "cdn.assets.com", isMainFrameNavigation: false }, ["example.com"]), false);
});

test("shouldBlockEgress: a MUTATING (non-GET) subresource request to a non-allowed host is blocked", () => {
  assert.equal(shouldBlockEgress({ method: "POST", host: "evil.com", isMainFrameNavigation: false }, ["example.com"]), true);
  assert.equal(shouldBlockEgress({ method: "put", host: "evil.com", isMainFrameNavigation: false }, ["example.com"]), true); // method casing
  assert.equal(shouldBlockEgress({ method: "DELETE", host: "evil.com", isMainFrameNavigation: false }, ["example.com"]), true);
});

test("shouldBlockEgress: the boundary stops actions/navigations, not GET rendering — the empty-host (malformed URL) case still passes on GET", () => {
  assert.equal(shouldBlockEgress({ method: "GET", host: "", isMainFrameNavigation: false }, ["example.com"]), false);
});

// ---------------------------------------------------------------------------
// raceAbort
// ---------------------------------------------------------------------------

test("raceAbort: passes through untouched when no signal is given", async () => {
  const result = await raceAbort(Promise.resolve("ok"));
  assert.equal(result, "ok");
});

test("raceAbort: rejects immediately with PorticoStepError('aborted') if already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => raceAbort(new Promise(() => {}), controller.signal),
    (err: unknown) => {
      assert.ok(err instanceof PorticoStepError);
      assert.equal(err.kind, "aborted");
      return true;
    },
  );
});

test("raceAbort: rejects when the signal fires mid-flight, before the promise settles", async () => {
  const controller = new AbortController();
  const never = new Promise(() => {});
  const raced = raceAbort(never, controller.signal);
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(
    () => raced,
    (err: unknown) => {
      assert.ok(err instanceof PorticoStepError);
      assert.equal(err.kind, "aborted");
      return true;
    },
  );
});

test("raceAbort: resolves normally when the promise settles before any abort", async () => {
  const controller = new AbortController();
  const result = await raceAbort(Promise.resolve("done"), controller.signal);
  assert.equal(result, "done");
});

test("raceAbort: a later abort on an already-settled race is a harmless no-op", async () => {
  const controller = new AbortController();
  await raceAbort(Promise.resolve("done"), controller.signal);
  assert.doesNotThrow(() => controller.abort());
});

test("raceAbort: propagates the promise's own rejection when it loses the race to a signal that never fires", async () => {
  const controller = new AbortController();
  await assert.rejects(() => raceAbort(Promise.reject(new Error("real failure")), controller.signal), /real failure/);
});

// ---------------------------------------------------------------------------
// seedOutput + renderTemplate — the resumeOutput seam (runProgrammatic itself
// needs a browser; these are the pure pieces that make resume correct)
// ---------------------------------------------------------------------------

test("seedOutput: copies resumeOutput into a FRESH object (never the caller's own reference)", () => {
  const prior = { customer_id: "abc", slots_raw: { a: 1 } };
  const seeded = seedOutput(prior);
  assert.deepEqual(seeded, prior);
  assert.notEqual(seeded, prior);
});

test("seedOutput: undefined resumeOutput seeds an empty object", () => {
  assert.deepEqual(seedOutput(undefined), {});
});

test("seedOutput + renderTemplate: a resumed run's {{output.x}} dotted-path reference resolves from resumeOutput", () => {
  const opts = {
    target: { key: "t", name: "t", base_url: "https://x", allowed_domains: [], auth: "none" },
    inputs: {},
    auth: { secrets: {} },
  } as unknown as EngineRunOptions;
  const output = seedOutput({ customer: { family: { id: "F123" } } });
  assert.equal(renderTemplate("{{customer.family.id}}", opts, output), "F123");
});

// ---------------------------------------------------------------------------
// runFlow: gates that fire BEFORE any browser launches (fast, no-browser-needed)
// ---------------------------------------------------------------------------

const baseTarget: Target = { key: "t", name: "t", base_url: "https://example.com", allowed_domains: [], auth: "none" };

test("runFlow: missing required inputs fails before any browser launches, kind 'validation'", async () => {
  const flow: Flow = {
    key: "needs-input",
    version: 1,
    inputs: { patient_id: "string" },
    steps: [{ type: "act", label: "search", locator: { semantic: { name: "{{patient_id}}", intent: "row" } } }],
  };
  const result = await runFlow({ flow, target: baseTarget, inputs: {}, auth: { secrets: {} }, mode: "dry_run" });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, "validation");
  assert.equal(result.failure?.resumable, false);
  assert.equal(result.traces[0]?.errorKind, "validation");
});

test("runFlow: a dry_run_only-guarded flow refuses live mode before any browser launches", async () => {
  const flow: Flow = {
    key: "guarded",
    version: 1,
    guard: { dry_run_only: true },
    steps: [{ type: "navigate", url: "https://example.com" }],
  };
  const result = await runFlow({ flow, target: baseTarget, inputs: {}, auth: { secrets: {} }, mode: "live" });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, "guard");
  assert.equal(result.failure?.resumable, false);
  assert.match(result.failure?.reason ?? "", /dry_run_only/);
  assert.equal(result.traces[0]?.errorKind, "guard");
});
