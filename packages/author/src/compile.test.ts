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
  // A list page with no id param → no id-correlation; the biggest data endpoint
  // wins, and boot noise is still excluded.
  const flow = compileAgentRun("open list", "https://pulse.clinikk.com/claims", responses, "claims-list");
  const first = flow.steps.find((s) => s.type === "intercept")!;
  // /clinics is boot noise (excluded); the biggest remaining data endpoint is /claims.
  assert.equal(first.intercept!.url_contains, "/api/proxy/v1/claims");
  assert.equal(flow.inputs, undefined); // nothing to parameterize
});

// Type-only guard: keep the public AuthorResult shape stable for callers.
const _typecheck: (r: AuthorResult) => string = (r) => r.evidence.finalUrl;
void _typecheck;
