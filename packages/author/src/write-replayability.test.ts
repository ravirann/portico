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
import { compileAgentRun, writeReplayability, registrableDomain, UnreplayableWriteError, type CapturedRequest } from "./index.js";

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

test("writeReplayability: a Gmail-shaped storm of 3 *.google.com hosts with frozen SAPISIDHASH/xsrf literals is entirely unreplayable", () => {
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
  // These hosts share the registrable domain google.com with mail.google.com, so
  // SITE-level cross-origin does NOT fire — the FROZEN CREDENTIAL is what refuses
  // every one of them (that's the whole discriminator: a naive eTLD+1 switch
  // would wave them through). distinctForeignHosts still lists the exact
  // subdomains, since the caller names them in the error and counts them.
  assert.ok(result.unreplayable.every((u) => u.reason === "frozen_credential"), "same-site *.google.com hosts are caught by their single-use credential, not by cross-origin");
  assert.ok(result.distinctForeignHosts.length >= 2, `expected 2+ distinct foreign subdomains, got ${result.distinctForeignHosts.length}`);
  assert.deepEqual(result.distinctForeignHosts, ["clients6.google.com", "peoplestack-pa.clients6.google.com", "taskassist-pa.clients6.google.com"].sort());
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
// registrableDomain — the eTLD+1 "same site" boundary the guard now keys on
// ---------------------------------------------------------------------------

test("registrableDomain: subdomains collapse to eTLD+1; IPs and short hosts pass through", () => {
  // Same-company split: UI and API share the registrable domain.
  assert.equal(registrableDomain("app.vendor.com"), "vendor.com");
  assert.equal(registrableDomain("api.vendor.com"), "vendor.com");
  // Gmail's foreign API hosts share google.com with mail.google.com — which is
  // exactly why eTLD+1 alone can't tell them apart from a legit split.
  assert.equal(registrableDomain("mail.google.com"), "google.com");
  assert.equal(registrableDomain("peoplestack-pa.clients6.google.com"), "google.com");
  // Multi-label public suffix: co.uk needs three labels to reach the registrable domain.
  assert.equal(registrableDomain("portal.acme.co.uk"), "acme.co.uk");
  assert.equal(registrableDomain("api.acme.co.uk"), "acme.co.uk");
  // Truly different companies do NOT collapse together.
  assert.notEqual(registrableDomain("ops.example.com"), registrableDomain("partner-sync.example-partner.com"));
  // No registrable-domain concept: return as-is.
  assert.equal(registrableDomain("1.2.3.4"), "1.2.3.4");
  assert.equal(registrableDomain("localhost"), "localhost");
  assert.equal(registrableDomain("Vendor.COM."), "vendor.com"); // lowercased, trailing dot stripped
});

// ---------------------------------------------------------------------------
// Same-company UI/API subdomain split — the false-positive the redesign fixes
// ---------------------------------------------------------------------------

test("writeReplayability: a same-company UI/API subdomain split with runtime-resolved auth is reliable (not cross_origin)", () => {
  const result = writeReplayability(
    [
      {
        method: "PUT",
        url: "https://api.vendor.com/v2/records/4821",
        pathname: "/v2/records/4821",
        resourceType: "fetch",
        postData: JSON.stringify({ status: "closed" }),
        headers: { authorization: "Bearer {{user_token}}", "content-type": "application/json" },
      },
    ],
    "app.vendor.com", // the UI host; the API lives on api.vendor.com — same registrable domain
  );
  assert.equal(result.reliable.length, 1);
  assert.equal(result.unreplayable.length, 0);
  assert.deepEqual(result.distinctForeignHosts, []); // a reliable same-company host is never a "foreign storm" host
});

test("writeReplayability: a same-company split under a multi-label suffix (co.uk) is same-site", () => {
  const result = writeReplayability(
    [
      {
        method: "POST",
        url: "https://api.acme.co.uk/v1/tickets",
        pathname: "/v1/tickets",
        resourceType: "fetch",
        headers: { authorization: "Bearer {{token}}" },
      },
    ],
    "portal.acme.co.uk",
  );
  assert.equal(result.reliable.length, 1);
  assert.equal(result.unreplayable.length, 0);
});

test("writeReplayability: a same-site subdomain split does NOT excuse a FROZEN credential", () => {
  // The split passes ONLY when auth is runtime-resolvable. A raw literal token on
  // the sibling subdomain is still refused — by frozen_credential, not cross_origin.
  const result = writeReplayability(
    [
      {
        method: "PUT",
        url: "https://api.vendor.com/v2/records/4821",
        pathname: "/v2/records/4821",
        resourceType: "fetch",
        headers: { authorization: "Bearer raw.literal.jwt.not.templated" },
      },
    ],
    "app.vendor.com",
    "either",
  );
  assert.equal(result.reliable.length, 0);
  assert.equal(result.unreplayable.length, 1);
  assert.equal(result.unreplayable[0]?.reason, "frozen_credential");
});

// ---------------------------------------------------------------------------
// cookie-session reconciliation — NAME-based check suppressed, VALUE never is
// ---------------------------------------------------------------------------

test("writeReplayability: outside cookie-session, a literal Bearer credential header is frozen by NAME", () => {
  const result = writeReplayability(
    [
      {
        method: "POST",
        url: "https://portal.acme.com/api/save",
        pathname: "/api/save",
        resourceType: "fetch",
        headers: { authorization: "Bearer eyJhbGciOiJ.some.literal.jwt" }, // no {{…}} — discovery didn't explain it
      },
    ],
    "portal.acme.com",
    "either",
  );
  assert.equal(result.unreplayable.length, 1);
  assert.equal(result.unreplayable[0]?.reason, "frozen_credential");
});

test("writeReplayability: a cookie-session app exempts a NAME-only credential header but NEVER a SAPISIDHASH value", () => {
  const result = writeReplayability(
    [
      {
        // A literal Bearer on the app's own host: for a cookie-session app the
        // cookie is the real auth, so this header is cookie-redundant — reliable.
        method: "POST",
        url: "https://portal.acme.com/api/save",
        pathname: "/api/save",
        resourceType: "fetch",
        headers: { authorization: "Bearer eyJhbGciOiJ.some.literal.jwt", "content-type": "application/json" },
      },
      {
        // A genuine single-use SAPISIDHASH is unreplayable however the app authenticates.
        method: "POST",
        url: "https://portal.acme.com/api/other",
        pathname: "/api/other",
        resourceType: "fetch",
        headers: { authorization: "SAPISIDHASH 1700000000_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      },
    ],
    "portal.acme.com",
    "cookie-session",
  );
  assert.equal(result.reliable.length, 1);
  assert.equal(result.reliable[0]?.pathname, "/api/save"); // Bearer JWT exempted for cookie-session
  assert.equal(result.unreplayable.length, 1);
  assert.equal(result.unreplayable[0]?.reason, "frozen_credential");
  assert.equal(result.unreplayable[0]?.req.pathname, "/api/other"); // SAPISIDHASH still caught by VALUE
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

test("compileAgentRun compiles a same-company UI/API subdomain split when auth resolves at runtime", () => {
  // The regression this redesign fixes: the UI (app.vendor.com) drives its API
  // on api.vendor.com — a legitimate same-company split. Exact-hostname
  // cross-origin used to classify this single write cross_origin, leaving
  // reliable.length === 0, and the guard wrongly refused it. Now it's same-site
  // (registrable domain vendor.com) and its bearer auth resolves to a runtime
  // {{user_token}} read, so it compiles.
  const goal = "update record 4821 and set its status to closed";
  const requests: CapturedRequest[] = [
    {
      method: "PUT",
      url: "https://api.vendor.com/v2/records/4821",
      pathname: "/v2/records/4821",
      resourceType: "fetch",
      postData: JSON.stringify({ status: "closed" }),
      headers: { authorization: "Bearer LIVE_TOKEN", "content-type": "application/json" },
    },
  ];
  const ls = { userToken: "LIVE_TOKEN" };
  const profile = resolveSectorProfile("saas_ops"); // localStorage auth — discovery can template the bearer

  let flow: ReturnType<typeof compileAgentRun> | undefined;
  assert.doesNotThrow(() => {
    flow = compileAgentRun(
      goal,
      "https://app.vendor.com/records/4821", // appHost is the UI subdomain
      [],
      "vendor-update",
      requests,
      new Map(),
      ls,
      [{ name: "record_id", value: "4821", description: "record id" }],
      "update",
      profile,
    );
  });
  const write = flow!.steps.find((s) => (s as unknown as { api?: { method?: string } }).api?.method === "PUT") as unknown as {
    api: { headers: Record<string, string>; url: string };
  };
  // Reliable for the right reason: the cross-subdomain host was accepted AND its
  // auth was resolved to a fresh runtime read — not merely "didn't throw".
  assert.equal(write.api.headers.authorization, "Bearer {{user_token}}");
  assert.ok(write.api.url.startsWith("https://api.vendor.com/"), `write should still target the API subdomain, got ${write.api.url}`);
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
