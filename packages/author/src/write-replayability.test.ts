/**
 * Unit tests for the write-replayability guard — the precondition check that
 * refuses to compile a captured "update" run into a flow that can never
 * replay. The canonical failure it must catch: a user asks to "draft an
 * email" in Gmail, and the authoring pipeline harvests dozens of cross-origin
 * XHRs (clients6.google.com, peoplestack-pa.clients6.google.com,
 * taskassist-pa.clients6.google.com, …) carrying single-use credentials
 * (SAPISIDHASH/XSRF/server-token) that die the instant the recording session
 * ends. Those requests dodge MUTATION_NOISE_RE (opaque paths, camelCase RPCs
 * like `refreshCreds` that skip the `\b` word boundary) and used to freeze
 * into a confidently-wrong, unrunnable flow. FAIL LOUD instead
 * (docs/RELIABILITY.md): refuse and point at the DOM/keyboard tier.
 *
 * The proven-working case that must keep working: pulse.clinikk.com's LOP
 * write — a single same-origin POST whose bearer auth is re-read fresh from
 * localStorage at runtime (templated `{{user_token}}`, not a frozen literal).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSectorProfile } from "@portico/flow-spec";
import { compileAgentRun, writeReplayability, UnreplayableWriteError, type CapturedRequest } from "./index.js";

// ---------------------------------------------------------------------------
// writeReplayability — the pure classifier
// ---------------------------------------------------------------------------

test("writeReplayability: a same-origin write with a templated auth header is reliable", () => {
  const result = writeReplayability(
    [
      {
        method: "PUT",
        url: "https://pulse.clinikk.com/api/proxy/v3/family/109862/members/125884/lop",
        pathname: "/api/proxy/v3/family/109862/members/125884/lop",
        resourceType: "fetch",
        postData: JSON.stringify({ lop: "english" }),
        headers: { authorization: "Bearer {{user_token}}", "content-type": "application/json" },
      },
    ],
    "pulse.clinikk.com",
  );
  assert.equal(result.reliable.length, 1);
  assert.equal(result.unreplayable.length, 0);
  assert.deepEqual(result.distinctForeignHosts, []);
});

test("writeReplayability: a Gmail-shaped storm of 3 foreign hosts with frozen SAPISIDHASH/xsrf literals is entirely unreplayable", () => {
  const result = writeReplayability(
    [
      {
        method: "POST",
        url: "https://clients6.google.com/idv/1/populate?alt=json",
        pathname: "/idv/1/populate",
        resourceType: "fetch",
        postData: "{}",
        headers: { authorization: "SAPISIDHASH 1700000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      },
      {
        method: "POST",
        url: "https://peoplestack-pa.clients6.google.com/api/refreshCreds",
        pathname: "/api/refreshCreds",
        resourceType: "fetch",
        postData: "{}",
        headers: { authorization: "SAPISID1PHASH 1700000000_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "x-framework-xsrf-token": "ax9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4" },
      },
      {
        method: "POST",
        url: "https://taskassist-pa.clients6.google.com/batch?rt=b",
        pathname: "/batch",
        resourceType: "fetch",
        postData: "{}",
        headers: { authorization: "SAPISID3PHASH 1700000000_cccccccccccccccccccccccccccccccccccccccc", "x-server-token": "st_8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c" },
      },
    ],
    "mail.google.com",
  );
  assert.equal(result.unreplayable.length, 3);
  assert.equal(result.reliable.length, 0);
  assert.ok(result.distinctForeignHosts.length >= 2, `expected 2+ foreign hosts, got ${result.distinctForeignHosts.length}`);
  assert.deepEqual(result.distinctForeignHosts, ["clients6.google.com", "peoplestack-pa.clients6.google.com", "taskassist-pa.clients6.google.com"].sort());
  assert.ok(result.unreplayable.every((u) => u.reason === "cross_origin"), "a foreign host is decisive on its own, regardless of its also-frozen credential");
});

test("writeReplayability: frozen vs runtime-resolved — literal SAPISIDHASH is frozen_credential, the same shape templated as {{token}} is not", () => {
  const result = writeReplayability(
    [
      {
        method: "POST",
        url: "https://app.example.com/api/save",
        pathname: "/api/save",
        resourceType: "fetch",
        headers: { authorization: "SAPISIDHASH 1700000000_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      },
      {
        method: "POST",
        url: "https://app.example.com/api/save-other",
        pathname: "/api/save-other",
        resourceType: "fetch",
        headers: { authorization: "Bearer {{auth_token}}" },
      },
    ],
    "app.example.com", // same origin as BOTH requests — isolates the credential check from cross_origin
  );
  assert.equal(result.unreplayable.length, 1);
  assert.equal(result.reliable.length, 1);
  assert.equal(result.unreplayable[0]?.reason, "frozen_credential");
  assert.equal(result.unreplayable[0]?.req.pathname, "/api/save"); // the literal one, not the templated one
  assert.equal(result.reliable[0]?.pathname, "/api/save-other");
});

test("writeReplayability: a gsessionid querystring param counts as frozen_credential even with no matching headers", () => {
  const result = writeReplayability(
    [
      {
        method: "POST",
        url: "https://mail.google.com/mail/mt/sync/i/s?gsessionid=abc123XYZ",
        pathname: "/mail/mt/sync/i/s",
        resourceType: "fetch",
      },
    ],
    "mail.google.com", // same origin — proves this isn't just piggybacking on cross_origin
  );
  assert.equal(result.unreplayable.length, 1);
  assert.equal(result.unreplayable[0]?.reason, "frozen_credential");
  assert.equal(result.reliable.length, 0);
});

// ---------------------------------------------------------------------------
// compileAgentRun integration — the guard fires on the whole authoring run
// ---------------------------------------------------------------------------

test("compileAgentRun throws UnreplayableWriteError on a Gmail-like credential storm (communications sector)", () => {
  const goal = "draft an email to ops@example.com in Gmail";
  const requests: CapturedRequest[] = [
    {
      method: "POST",
      url: "https://clients6.google.com/idv/1/populate?alt=json",
      pathname: "/idv/1/populate",
      resourceType: "fetch",
      postData: JSON.stringify({ to: "ops@example.com" }),
      headers: { authorization: "SAPISIDHASH 1700000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "content-type": "application/json" },
    },
    {
      method: "POST",
      url: "https://peoplestack-pa.clients6.google.com/api/refreshCreds", // camelCase — dodges MUTATION_NOISE_RE's /refresh\b
      pathname: "/api/refreshCreds",
      resourceType: "fetch",
      postData: "{}",
      headers: { authorization: "SAPISID1PHASH 1700000000_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "x-framework-xsrf-token": "ax9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4" },
    },
    {
      method: "POST",
      url: "https://taskassist-pa.clients6.google.com/batch?rt=b",
      pathname: "/batch",
      resourceType: "fetch",
      postData: "{}",
      headers: { authorization: "SAPISID3PHASH 1700000000_cccccccccccccccccccccccccccccccccccccccc", "x-server-token": "st_8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c" },
    },
  ];
  const profile = resolveSectorProfile("communications"); // real Gmail authoring config — authPattern "cookie-session"
  let threw: unknown;
  try {
    compileAgentRun(
      goal,
      "https://mail.google.com/mail/u/0/#inbox",
      [],
      "gmail-draft",
      requests,
      new Map(),
      {}, // localStorage: empty — Gmail's SAPISIDHASH is derived from a cookie via JS, never mirrored to localStorage
      [{ name: "recipient", value: "ops@example.com", description: "recipient" }],
      "update",
      profile,
    );
  } catch (e) {
    threw = e;
  }
  assert.ok(threw instanceof UnreplayableWriteError, `expected UnreplayableWriteError, got ${threw}`);
  const err = threw as UnreplayableWriteError;
  assert.match(err.message, /draft an email to ops@example\.com in Gmail/);
  assert.match(err.message, /clients6\.google\.com/);
  assert.match(err.message, /single-use tokens/i);
  assert.match(err.message, /gmail-web/); // points at the DOM/keyboard-tier connector
  assert.equal(err.foreignHosts.length, 3);
  assert.equal(err.unreplayableCount, 3);
});

test("compileAgentRun does NOT throw on a pulse-like single same-origin templated-auth write", () => {
  const goal = "search phone 9717352594 and set the customer's LOP to English";
  const requests: CapturedRequest[] = [
    { method: "GET", url: "https://pulse.clinikk.com/api/proxy/v3/customers?phoneNumber=9717352594", pathname: "/api/proxy/v3/customers", resourceType: "fetch" },
    {
      method: "PUT",
      url: "https://pulse.clinikk.com/api/proxy/v3/family/109862/members/125884/lop",
      pathname: "/api/proxy/v3/family/109862/members/125884/lop",
      resourceType: "fetch",
      postData: JSON.stringify({ lop: "english" }),
      headers: { authorization: "Bearer JWT_TOKEN_VALUE", "content-type": "application/json" },
    },
  ];
  const bodies = new Map([["/api/proxy/v3/customers", JSON.stringify({ id: 125884, family: { id: 109862 } })]]);
  const ls = { userToken: "JWT_TOKEN_VALUE" };

  let flow: ReturnType<typeof compileAgentRun> | undefined;
  assert.doesNotThrow(() => {
    flow = compileAgentRun(goal, "https://pulse.clinikk.com/customer-lens", [], "lop-minimal", requests, bodies, ls, [], "update");
  });
  const write = flow!.steps.find((s) => (s as unknown as { api?: { method?: string } }).api?.method === "PUT") as unknown as {
    api: { headers: Record<string, string> };
  };
  // Genuinely reliable, not just "didn't happen to throw" — the auth header was
  // resolved to a fresh runtime read, exactly the shape the guard must pass.
  assert.equal(write.api.headers.authorization, "Bearer {{user_token}}");
});

test("compileAgentRun does not fail the whole run over a single foreign call alongside a real same-origin write", () => {
  // Only ONE foreign host, and a genuinely reliable same-origin write exists
  // alongside it — the decision rule needs distinctForeignHosts >= 2 OR
  // nothing else reliable, so this is left compiled (for human review), not
  // hard-refused.
  const goal = "update order 55512 and notify the partner integration";
  const requests: CapturedRequest[] = [
    { method: "PUT", url: "https://ops.example.com/api/orders/55512", pathname: "/api/orders/55512", resourceType: "fetch", postData: JSON.stringify({ status: "synced" }) },
    {
      method: "POST",
      url: "https://partner-sync.example-partner.com/api/notify",
      pathname: "/api/notify",
      resourceType: "fetch",
      postData: JSON.stringify({ orderId: "55512" }),
      headers: { authorization: "SAPISIDHASH 1700000000_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
    },
  ];
  let flow: ReturnType<typeof compileAgentRun> | undefined;
  assert.doesNotThrow(() => {
    flow = compileAgentRun(goal, "https://ops.example.com/orders/55512", [], "order-sync", requests, new Map(), {}, [], "update");
  });
  const writes = flow!.steps.filter((s) => {
    const api = (s as unknown as { api?: { method?: string } }).api;
    return api && !["GET", "HEAD"].includes((api.method ?? "GET").toUpperCase());
  });
  assert.equal(writes.length, 2); // both mutations still compiled — the guard is whole-run, not a per-request filter
});

test("the guard is a no-op for a read/search goal even when the captured requests look like a credential storm", () => {
  const goal = "find the sync status for order 55512";
  const requests: CapturedRequest[] = [
    { method: "PUT", url: "https://ops.example.com/api/orders/55512", pathname: "/api/orders/55512", resourceType: "fetch", postData: JSON.stringify({ status: "synced" }) },
    {
      method: "POST",
      url: "https://partner-sync.example-partner.com/api/notify",
      pathname: "/api/notify",
      resourceType: "fetch",
      headers: { authorization: "SAPISIDHASH 1700000000_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead" },
    },
  ];
  let flow: ReturnType<typeof compileAgentRun> | undefined;
  assert.doesNotThrow(() => {
    // intent "search" — the classify loop's `if (intent !== "update") continue;`
    // means `mutations` (and so the guard's input) stays empty no matter what
    // the requests look like.
    flow = compileAgentRun(goal, "https://ops.example.com/orders/55512", [], "order-status", requests, new Map(), {}, [], "search");
  });
  const hasWrite = flow!.steps.some((s) => {
    const api = (s as unknown as { api?: { method?: string } }).api;
    return api && !["GET", "HEAD"].includes((api.method ?? "GET").toUpperCase());
  });
  assert.equal(hasWrite, false);
});
