/**
 * Unit tests for the PURE compile half of agent-authoring: turning an agent's
 * run (final URL + captured JSON responses) into a deterministic flow. No
 * Stagehand, no browser, no model — this is the part that must stay correct so
 * the frozen flow replays reliably. Fixtures are the real pulse.clinikk.com
 * endpoints observed during the live author run.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { compileAgentRun, idFreeMatch, idsInUrl, type AuthorResult } from "./index.js";

const FINAL_URL = "https://pulse.clinikk.com/claims/workspace?claimId=4305";

// What the observer captured while the agent was on claim 4305's detail page:
// per-claim data endpoints plus a pile of boot/infra noise.
const responses = [
  { url: "https://pulse.clinikk.com/api/proxy/v1/users/me/permissions", pathname: "/api/proxy/v1/users/me/permissions", bytes: 1374, contentType: "application/json" },
  { url: "https://pulse.clinikk.com/flags/", pathname: "/flags/", bytes: 125, contentType: "application/json" },
  { url: "https://pulse.clinikk.com/api/auth/userinfo", pathname: "/api/auth/userinfo", bytes: 3146, contentType: "application/json" },
  { url: "https://pulse.clinikk.com/api/proxy/v1/clinics", pathname: "/api/proxy/v1/clinics", bytes: 135408, contentType: "application/json" },
  { url: "https://pulse.clinikk.com/api/support/tickets", pathname: "/api/support/tickets", bytes: 3615, contentType: "application/json" },
  { url: "https://pulse.clinikk.com/api/proxy/v1/claims/4305/ai-review-history?step_name=x", pathname: "/api/proxy/v1/claims/4305/ai-review-history", bytes: 3301, contentType: "application/json" },
  { url: "https://pulse.clinikk.com/api/proxy/v1/claims/4305/notes?page=1", pathname: "/api/proxy/v1/claims/4305/notes", bytes: 371, contentType: "application/json" },
  { url: "https://pulse.clinikk.com/api/proxy/v1/claims?claimId=4305", pathname: "/api/proxy/v1/claims", bytes: 23605, contentType: "application/json" },
];

test("idsInUrl extracts numeric query-param values", () => {
  assert.deepEqual(idsInUrl(FINAL_URL), ["4305"]);
  assert.deepEqual(idsInUrl("https://x/claims/workspace?claimId=4305&tab=2&q=abc"), ["4305", "2"]);
  assert.deepEqual(idsInUrl("https://x/claims"), []);
});

test("idFreeMatch yields a substring that still occurs in the live URL", () => {
  // The whole point: the match must fire at replay regardless of the id.
  assert.equal(idFreeMatch("/api/proxy/v1/claims/4305/ai-review-history"), "/ai-review-history");
  assert.equal(idFreeMatch("/api/proxy/v1/claims/4305/notes"), "/notes");
  assert.equal(idFreeMatch("/api/proxy/v1/claims/4305"), "/api/proxy/v1/claims");
  assert.equal(idFreeMatch("/api/proxy/v1/claims"), "/api/proxy/v1/claims"); // no id → whole path
  // And each result is genuinely a substring of the original path.
  for (const p of ["/api/proxy/v1/claims/4305/ai-review-history", "/api/proxy/v1/claims/4305/notes"]) {
    assert.ok(p.includes(idFreeMatch(p)), `${idFreeMatch(p)} must occur in ${p}`);
  }
});

test("compileAgentRun parameterizes the id and picks data endpoints over boot noise", () => {
  const flow = compileAgentRun("open claim detail", FINAL_URL, responses, "claim-detail");

  // The navigate URL is parameterized by the claim id, and the id became an input.
  const nav = flow.steps.find((s) => s.type === "navigate")!;
  assert.equal(nav.url, "https://pulse.clinikk.com/claims/workspace?claimId={{claim_id}}");
  assert.ok(flow.inputs && "claim_id" in flow.inputs);

  // Intercepts are the per-claim DATA endpoints (id-correlated), NOT boot noise
  // (permissions/flags/userinfo/clinics/tickets) even though clinics was largest.
  const matches = flow.steps.filter((s) => s.type === "intercept").map((s) => s.intercept!.url_contains);
  assert.ok(matches.includes("/ai-review-history"), `expected ai-review-history, got ${matches.join(",")}`);
  assert.ok(matches.includes("/notes"));
  for (const noise of ["permissions", "flags", "userinfo", "clinics", "tickets"]) {
    assert.ok(!matches.some((m) => m.includes(noise)), `boot noise "${noise}" must be excluded`);
  }

  // A wait gates on the primary harvest, and booking guards are always applied.
  const wait = flow.steps.find((s) => s.type === "wait");
  assert.equal(wait?.wait?.for, "data_raw");
  assert.equal(flow.guard?.no_booking, true);
});

test("compileAgentRun falls back to size ranking when no id is in the final URL", () => {
  // A list page with no id param → no id-correlation; the biggest DATA endpoint
  // wins, and genuine infra/telemetry (not domain entities) is excluded.
  const localResponses = [
    { url: "https://x/api/analytics/collect", pathname: "/api/analytics/collect", bytes: 999999, contentType: "application/json" }, // telemetry — biggest but excluded
    { url: "https://x/api/orders", pathname: "/api/orders", bytes: 5000, contentType: "application/json" },
    { url: "https://x/api/lookups", pathname: "/api/lookups", bytes: 800, contentType: "application/json" },
  ];
  const flow = compileAgentRun("open list", "https://x/orders", localResponses, "orders-list");
  const first = flow.steps.find((s) => s.type === "intercept")!;
  assert.equal(first.intercept!.url_contains, "/api/orders"); // biggest non-telemetry data endpoint
  assert.equal(flow.inputs, undefined); // nothing to parameterize
});

// Type-only guard: keep the public AuthorResult shape stable for callers.
const _typecheck: (r: AuthorResult) => string = (r) => r.evidence.finalUrl;
void _typecheck;

// ---------------------------------------------------------------------------
// Write flow: chain ids from the lookup into the mutation, parameterize the value
// (real pulse.clinikk.com customer-lens shapes)
// ---------------------------------------------------------------------------

test("compileAgentRun freezes a search+update into a deep-link harvest + chained api write", () => {
  const goal = "search phone 9717352594 and update the customer's LOP to English";
  const requests = [
    { method: "GET", url: "https://pulse.clinikk.com/api/proxy/v3/customers?phoneNumber=9717352594", pathname: "/api/proxy/v3/customers", resourceType: "fetch" },
    { method: "PUT", url: "https://pulse.clinikk.com/api/proxy/v3/family/109862/members/125884/lop", pathname: "/api/proxy/v3/family/109862/members/125884/lop", resourceType: "fetch", postData: JSON.stringify({ lop: "english" }) },
  ];
  // The customer lookup response the page returned (id + family.id live here).
  const bodies = new Map<string, string>([
    ["/api/proxy/v3/customers", JSON.stringify({ id: 125884, first_name: "Ravi", lop: "english", family: { id: 109862 } })],
  ]);

  const flow = compileAgentRun(goal, "https://pulse.clinikk.com/customer-lens", [], "customer-lop", requests, bodies);
  const types = flow.steps.map((s) => s.type);
  assert.deepEqual(types, ["intercept", "navigate", "wait", "read"]);

  // Deep-link search parameterizes the phone.
  const nav = flow.steps.find((s) => s.type === "navigate")!;
  assert.equal(nav.url, "https://pulse.clinikk.com/customer-lens?phoneNumber={{phone_number}}");

  // The write chains the ids off the lookup and parameterizes the value.
  const write = flow.steps[3] as unknown as { api: { url: string; method: string; body: Record<string, string> } };
  assert.equal(write.api.method, "PUT");
  assert.equal(write.api.url, "https://pulse.clinikk.com/api/proxy/v3/family/{{customer.family.id}}/members/{{customer.id}}/lop");
  assert.deepEqual(write.api.body, { lop: "{{lop}}" });

  // Inputs: the phone and the language value; ids are chained, not inputs.
  assert.ok(flow.inputs && "phone_number" in flow.inputs && "lop" in flow.inputs);
  assert.ok(!("customer_id" in (flow.inputs ?? {})));
  // A captured mutation keeps the flow dry-run-only until a human confirms.
  assert.equal(flow.guard?.dry_run_only, true);
});

test("compileAgentRun emits auth-header read steps discovered from localStorage, text response", () => {
  const goal = "search phone 9717352594 and set the customer's LOP to English";
  const requests = [
    { method: "GET", url: "https://pulse.clinikk.com/api/proxy/v3/customers?phoneNumber=9717352594", pathname: "/api/proxy/v3/customers", resourceType: "fetch" },
    {
      method: "PUT",
      url: "https://pulse.clinikk.com/api/proxy/v3/family/109862/members/125884/lop",
      pathname: "/api/proxy/v3/family/109862/members/125884/lop",
      resourceType: "fetch",
      postData: JSON.stringify({ lop: "english" }),
      headers: { authorization: "Bearer JWT_TOKEN_VALUE", "content-type": "application/json", "x-clinic-id": "42", "x-app-env": "production" },
    },
  ];
  const bodies = new Map([["/api/proxy/v3/customers", JSON.stringify({ id: 125884, family: { id: 109862 } })]]);
  const ls = { userToken: "JWT_TOKEN_VALUE", selectedClinicId: "42", appEnv: "production" };

  const flow = compileAgentRun(goal, "https://pulse.clinikk.com/customer-lens", [], "lop", requests, bodies, ls);
  // read steps for the auth/tenant values, discovered by value-matching localStorage.
  const reads = flow.steps.filter((s) => s.type === "read" && (s as { read?: unknown }).read) as Array<{ read: { expression: string; as: string } }>;
  const readKeys = reads.map((r) => r.read.as).sort();
  assert.deepEqual(readKeys, ["app_env", "selected_clinic_id", "user_token"]);

  const write = flow.steps.find((s) => (s as { api?: { method?: string } }).api?.method === "PUT") as unknown as { api: { headers: Record<string, string>; responseType: string } };
  assert.equal(write.api.responseType, "text"); // 204/empty tolerated
  assert.equal(write.api.headers.authorization, "Bearer {{user_token}}");
  assert.equal(write.api.headers["x-clinic-id"], "{{selected_clinic_id}}");
  assert.equal(write.api.headers["x-app-env"], "{{app_env}}");
  assert.equal(write.api.headers["content-type"], "application/json");
});

test("a mutation-only flow (no lookups) opens the app before its localStorage reads", () => {
  // Gmail-shaped capture: the app does everything via POST, so no GET lookup
  // carries the goal value. Without a deep-link navigate the flow used to OPEN
  // with a localStorage read — executed on about:blank (opaque origin), which
  // throws "SecurityError: Failed to read the 'localStorage' property" at step 1.
  const requests = [
    {
      method: "POST",
      url: "https://mail.example.com/api/messages/send",
      pathname: "/api/messages/send",
      resourceType: "fetch",
      postData: JSON.stringify({ to: "billing@acme.com", subject: "Invoice" }),
      headers: { authorization: "Bearer JWT_TOKEN_VALUE", "content-type": "application/json" },
    },
  ];
  const flow = compileAgentRun(
    "send the invoice email to billing@acme.com",
    "https://mail.example.com/u/0/inbox",
    [],
    "send-invoice",
    requests,
    new Map(),
    { userToken: "JWT_TOKEN_VALUE" },
    [{ name: "to", value: "billing@acme.com", description: "recipient" }],
    "update",
  );
  // navigate FIRST (establishes the app origin — not the per-run inbox path),
  // then the auth-header read, then the frozen write.
  assert.equal(flow.steps[0]!.type, "navigate");
  assert.equal(flow.steps[0]!.url, "https://mail.example.com");
  const readIdx = flow.steps.findIndex((s) => Boolean((s as { read?: unknown }).read));
  const writeIdx = flow.steps.findIndex(
    (s) => (s as unknown as { api?: { method?: string } }).api?.method === "POST",
  );
  const types = flow.steps.map((s) => s.type).join(",");
  assert.ok(readIdx > 0, `expected an auth read after the navigate, got [${types}]`);
  assert.ok(writeIdx > readIdx, `expected navigate → read → write, got [${types}]`);
});

test("a search/read goal never emits a mutation (intent gate blocks session/heartbeat POSTs)", () => {
  const requests = [
    { method: "GET", url: "https://x/api/customers?phone=9717352594", pathname: "/api/customers", resourceType: "fetch" },
    { method: "POST", url: "https://x/api/support/session", pathname: "/api/support/session", resourceType: "fetch", postData: "{}" },
    { method: "POST", url: "https://x/api/orders", pathname: "/api/orders", resourceType: "fetch", postData: JSON.stringify({ x: 1 }) },
  ];
  // intent="search" → no write steps at all, even though POSTs were captured.
  const flow = compileAgentRun("find customer 9717352594", "https://x/customers", [], "s", requests, new Map(), {}, [{ name: "phone", value: "9717352594", description: "" }], "search");
  const hasWrite = flow.steps.some((s) => {
    const api = (s as unknown as { api?: { method?: string } }).api;
    return api && !["GET", "HEAD"].includes((api.method ?? "GET").toUpperCase());
  });
  assert.equal(hasWrite, false);
  // intent="update" → the real mutation (orders) is emitted, the session POST is filtered as noise.
  const upd = compileAgentRun("update order for 9717352594", "https://x/customers", [], "u", requests, new Map(), {}, [{ name: "phone", value: "9717352594", description: "" }], "update");
  const writes = upd.steps.filter((s) => {
    const api = (s as unknown as { api?: { method?: string } }).api;
    return api && !["GET", "HEAD"].includes((api.method ?? "GET").toUpperCase());
  }) as unknown as Array<{ api: { url: string } }>;
  assert.equal(writes.length, 1);
  assert.ok(writes[0]!.api.url.includes("/api/orders"));
});
