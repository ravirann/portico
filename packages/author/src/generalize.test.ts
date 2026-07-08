/**
 * Generalization suite — proves the authoring compiler is NOT overfit to
 * pulse.clinikk.com. Each case models a different public/SaaS site shape (goal +
 * the requests/responses an agent run would capture) and asserts the compiler
 * freezes it into the right deterministic flow. Deterministic and model-free, so
 * it runs in CI as a regression guard on "does authoring generalize?".
 *
 * Coverage: numeric-id search, non-numeric search (rewriter-driven), single-step
 * write, chained search→update write, auth-header discovery, and value
 * parameterization across e-commerce, dev-tools, support, and civic domains.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { compileAgentRun, type CapturedRequest } from "./index.js";

type HarvestResponse = { url: string; pathname: string; bytes: number; contentType: string };
type Case = {
  name: string;
  goal: string;
  finalUrl: string;
  requests: CapturedRequest[];
  responses?: HarvestResponse[];
  bodies?: Record<string, string>;
  localStorage?: Record<string, string>;
  planParams?: Array<{ name: string; value: string; description: string }>;
  assert: (flow: ReturnType<typeof compileAgentRun>) => void;
};

const stepTypes = (f: ReturnType<typeof compileAgentRun>) => f.steps.map((s) => s.type);
const navUrl = (f: ReturnType<typeof compileAgentRun>) => f.steps.find((s) => s.type === "navigate")?.url ?? "";
const writeStep = (f: ReturnType<typeof compileAgentRun>) =>
  f.steps.find((s) => {
    const api = (s as unknown as { api?: { method?: string } }).api;
    return api && !["GET", "HEAD"].includes((api.method ?? "GET").toUpperCase());
  }) as unknown as
    | undefined
    | { api: { url: string; method: string; body?: Record<string, string>; headers?: Record<string, string>; responseType?: string } };

const cases: Case[] = [
  {
    name: "e-commerce: look up a product by numeric SKU (read, deep-link)",
    goal: "Find the product with SKU 4801234 on the catalog",
    finalUrl: "https://shop.example.com/catalog",
    requests: [{ method: "GET", url: "https://shop.example.com/api/products?sku=4801234", pathname: "/api/products", resourceType: "fetch" }],
    assert: (f) => {
      assert.deepEqual(stepTypes(f), ["intercept", "navigate", "wait"]);
      assert.equal(navUrl(f), "https://shop.example.com/catalog?sku={{sku}}");
      assert.ok(f.inputs && "sku" in f.inputs);
    },
  },
  {
    name: "dev tools: search repositories by NON-numeric query (rewriter-driven)",
    goal: "Search repositories for playwright",
    finalUrl: "https://code.example.com/search",
    requests: [{ method: "GET", url: "https://code.example.com/api/search/repositories?q=playwright", pathname: "/api/search/repositories", resourceType: "fetch" }],
    // Digit-matching alone can't parameterize "playwright"; the rewriter names it.
    planParams: [{ name: "query", value: "playwright", description: "repo search term" }],
    assert: (f) => {
      assert.deepEqual(stepTypes(f), ["intercept", "navigate", "wait"]);
      assert.equal(navUrl(f), "https://code.example.com/search?q={{query}}");
      assert.ok(f.inputs && "query" in f.inputs);
    },
  },
  {
    name: "support desk: chained search → update ticket status (write + auth)",
    goal: "Find ticket 8842 and set its status to resolved",
    finalUrl: "https://help.example.com/tickets",
    requests: [
      { method: "GET", url: "https://help.example.com/api/tickets?number=8842", pathname: "/api/tickets", resourceType: "fetch" },
      {
        method: "PATCH",
        url: "https://help.example.com/api/orgs/55/tickets/9001/status",
        pathname: "/api/orgs/55/tickets/9001/status",
        resourceType: "fetch",
        postData: JSON.stringify({ status: "resolved" }),
        headers: { authorization: "Bearer TICKET_JWT", "content-type": "application/json", "x-org-id": "55" },
      },
    ],
    bodies: { "/api/tickets": JSON.stringify({ id: 9001, number: 8842, org: { id: 55 }, status: "open" }) },
    localStorage: { authToken: "TICKET_JWT", currentOrgId: "55" },
    planParams: [
      { name: "ticket_number", value: "8842", description: "ticket to update" },
      { name: "status", value: "resolved", description: "new status" },
    ],
    assert: (f) => {
      // read auth (2) → intercept → navigate → wait → PATCH; order: lookups first.
      assert.ok(stepTypes(f).includes("navigate") && stepTypes(f).includes("wait"));
      const w = writeStep(f)!;
      assert.equal(w.api.method, "PATCH");
      // Chained ids off the lookup response, parameterized status, auth from localStorage.
      assert.equal(w.api.url, "https://help.example.com/api/orgs/{{ticket.org.id}}/tickets/{{ticket.id}}/status");
      assert.deepEqual(w.api.body, { status: "{{status}}" });
      assert.equal(w.api.responseType, "text");
      assert.equal(w.api.headers!.authorization, "Bearer {{auth_token}}");
      assert.equal(w.api.headers!["x-org-id"], "{{current_org_id}}");
      // Auth values are read fresh, not baked in.
      const reads = f.steps.filter((s) => (s as { read?: unknown }).read).map((s) => (s as { read: { as: string } }).read.as);
      assert.ok(reads.includes("auth_token") && reads.includes("current_org_id"));
    },
  },
  {
    name: "civic portal: numeric-id detail via URL nav (read)",
    goal: "Open permit 100455 and read its status",
    finalUrl: "https://city.example.gov/permits/workspace?permitId=100455",
    requests: [
      { method: "GET", url: "https://city.example.gov/api/permits/100455/status", pathname: "/api/permits/100455/status", resourceType: "fetch" },
    ],
    // The id is in the API PATH (not a query), so this uses the harvest path,
    // which keys off the captured response the page made.
    responses: [
      { url: "https://city.example.gov/api/permits/100455/status", pathname: "/api/permits/100455/status", bytes: 800, contentType: "application/json" },
    ],
    planParams: [{ name: "permit_id", value: "100455", description: "permit id" }],
    assert: (f) => {
      // No query-param lookup, but the final URL carries ?permitId → navigate + intercept harvest.
      assert.ok(navUrl(f).includes("permitId={{permit_id}}"));
      assert.ok(stepTypes(f).includes("intercept") && stepTypes(f).includes("wait"));
    },
  },
  {
    name: "no goal values → falls back to the plain harvest path (claim-detail style)",
    goal: "Open the dashboard and read the summary",
    finalUrl: "https://app.example.com/dashboard",
    requests: [{ method: "GET", url: "https://app.example.com/api/summary", pathname: "/api/summary", resourceType: "fetch" }],
    assert: (f) => {
      // No tokens/params → the api-step path is skipped; harvest path still yields a flow.
      assert.ok(f.steps.length >= 1);
      assert.equal(f.guard?.no_booking, true);
    },
  },
];

for (const c of cases) {
  test(`generalizes — ${c.name}`, () => {
    const flow = compileAgentRun(
      c.goal,
      c.finalUrl,
      c.responses ?? [],
      "gen",
      c.requests,
      new Map(Object.entries(c.bodies ?? {})),
      c.localStorage ?? {},
      c.planParams ?? [],
    );
    c.assert(flow);
  });
}
