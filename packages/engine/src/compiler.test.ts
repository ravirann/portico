/**
 * Unit tests for the flow-spec → Libretto compiler and its pure helpers.
 * No browser / no model — these assert the deterministic, keyless contract.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Flow, Target } from "@portico/flow-spec";
import { compileFlow } from "./compiler.js";
import { jsonSchemaToZod, validateAgainst } from "./json-schema.js";
import { healModelConfigured } from "./model.js";
import { resolveProfile } from "./auth-profile.js";

const target: Target = {
  key: "t",
  name: "t",
  base_url: "https://example.com",
  allowed_domains: ["example.com"],
  auth: "portal-login",
};

test("jsonSchemaToZod handles the common subset", () => {
  assert.equal(jsonSchemaToZod({ type: "string" }).safeParse("x").success, true);
  assert.equal(jsonSchemaToZod({ type: "number" }).safeParse(3).success, true);
  assert.equal(jsonSchemaToZod({ type: "number" }).safeParse("x").success, false);
  const obj = jsonSchemaToZod({
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
  });
  assert.equal(obj.safeParse({ a: "hi" }).success, true);
  assert.equal(obj.safeParse({}).success, false);
});

test("validateAgainst never throws and reports failure", () => {
  const ok = validateAgainst({ type: "string" }, "x");
  assert.equal(ok.ok, true);
  const bad = validateAgainst({ type: "number" }, "x");
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
});

test("compileFlow builds a canonical workflow carrying schemas + credentials + profile", () => {
  const flow: Flow = {
    key: "login-and-read",
    version: 1,
    inputs: { reason: "string" },
    steps: [
      { type: "navigate", label: "open", url: "{{base_url}}/login" },
      { type: "act", label: "user", value: "{{secrets.username}}", locator: { cached: "#u", semantic: { intent: "user" } } },
      { type: "act", label: "pass", value: "{{secrets.password}}", locator: { cached: "#p", semantic: { intent: "pass" } } },
      { type: "extract", label: "title", extract: { key: "page_title", schema: { type: "string" } } },
    ],
  };
  const { workflow, plan, credentialNames } = compileFlow(flow, target, { profileName: "urmc-mychart" });
  assert.equal(workflow.name, "login-and-read");
  assert.equal(workflow.authProfileName, "urmc-mychart");
  assert.equal(workflow.authProfileRefresh, true);
  assert.equal(workflow.startUrl, "https://example.com");
  assert.deepEqual([...credentialNames].sort(), ["password", "username"]);
  assert.equal(plan.length, 4);
  // No recovery model configured → no recoveryAction on the deterministic workflow.
  assert.equal(workflow.recoveryAction, undefined);
});

test("compileFlow refuses a no_booking flow that contains a booking action", () => {
  const flow: Flow = {
    key: "danger",
    version: 1,
    guard: { no_booking: true },
    steps: [
      { type: "navigate", url: "{{base_url}}" },
      { type: "act", label: "Book the appointment", locator: { cached: "#book", semantic: { intent: "book" } } },
    ],
  };
  assert.throws(() => compileFlow(flow, target), /no_booking/);
});

test("compileFlow rejects an agent step on the hot path", () => {
  const flow = {
    key: "llm",
    version: 1,
    steps: [{ type: "agent", label: "think" }],
  } as unknown as Flow;
  assert.throws(() => compileFlow(flow, target), /agent step/);
});

test("healModelConfigured is honest about missing config", () => {
  assert.equal(healModelConfigured({}), false);
  assert.equal(healModelConfigured({ PORTICO_HEAL_PROVIDER: "anthropic" }), false); // no key
  assert.equal(
    healModelConfigured({ PORTICO_HEAL_PROVIDER: "anthropic", PORTICO_HEAL_API_KEY: "k" }),
    true,
  );
  assert.equal(healModelConfigured({ PORTICO_HEAL_PROVIDER: "nope", PORTICO_HEAL_API_KEY: "k" }), false);
});

test("compileFlow wires a resolve step: canonicalizes intent, fails loud on ambiguity", async () => {
  const flow: Flow = {
    key: "resolve-loc",
    version: 1,
    inputs: { location: "string" },
    steps: [
      {
        type: "resolve",
        label: "canonicalize location",
        resolve: { input: "{{location}}", candidates: "locations", as: "location_canonical" },
      },
    ],
  };
  const { plan } = compileFlow(flow, target);
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.type, "resolve");

  // Minimal runtime — a resolve step touches only template + output, not the page.
  const mkRt = (inputs: Record<string, unknown>, output: Record<string, unknown>) =>
    ({
      output,
      template: (s: string) => s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => String(inputs[k] ?? "")),
    }) as unknown as Parameters<(typeof plan)[0]["run"]>[0];

  // "Southview" resolves to the single matching clinic → written to output.
  const out1: Record<string, unknown> = { locations: ["Southview Internal Medicine", "Brighton Family Medicine"] };
  await plan[0]!.run(mkRt({ location: "Southview" }, out1));
  assert.equal(out1.location_canonical, "Southview Internal Medicine");

  // "Southview" against two "Southview *" clinics → refuse (throw), never guess.
  const out2: Record<string, unknown> = { locations: ["Southview Internal Medicine", "Southview Pediatrics"] };
  await assert.rejects(() => plan[0]!.run(mkRt({ location: "Southview" }, out2)), /ambiguous/);
});

test("resolve emits an id from object candidates; select picks the earliest slot", async () => {
  const flow: Flow = {
    key: "id-and-slot",
    version: 1,
    inputs: { specialty: "string" },
    steps: [
      {
        type: "resolve",
        label: "specialty → encrypted id",
        resolve: { input: "{{specialty}}", candidates: "specialties", match_on: "Title", value_field: "Value", as: "specialty_id" },
      },
      {
        type: "select",
        label: "earliest available slot",
        select: { from: "slots", policy: "earliest", by: "DisplayDateTimeUtc", compare: "date", as: "chosen" },
      },
    ],
  };
  const { plan } = compileFlow(flow, target);
  assert.deepEqual(plan.map((s) => s.type), ["resolve", "select"]);

  const mkRt = (inputs: Record<string, unknown>, output: Record<string, unknown>) =>
    ({
      output,
      rawPage: {},
      template: (s: string) => s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => String(inputs[k] ?? "")),
    }) as unknown as Parameters<(typeof plan)[0]["run"]>[0];

  const out: Record<string, any> = {
    specialties: [{ Title: "Primary Care", Value: "200" }, { Title: "Cardiology", Value: "17" }],
    slots: [{ DisplayDateTimeUtc: "2026-10-05T14:00:00Z" }, { DisplayDateTimeUtc: "2026-09-04T17:30:00Z" }],
  };
  await plan[0]!.run(mkRt({ specialty: "primary care" }, out));
  assert.equal(out.specialty_id, "200"); // fuzzy name → the encrypted id GetSlots needs
  await plan[1]!.run(mkRt({}, out));
  assert.equal(out.chosen.DisplayDateTimeUtc, "2026-09-04T17:30:00Z"); // the earliest, not first
});

test("resolveProfile normalizes the profile id and points at .libretto/profiles", () => {
  const p = resolveProfile("URMC MyChart!", { cwd: "/tmp/repo" });
  assert.equal(p.name, "urmc-mychart");
  assert.equal(p.path, "/tmp/repo/.libretto/profiles/urmc-mychart.json");
  assert.equal(p.userDataDir, "/tmp/repo/.libretto/profiles/urmc-mychart.userdata");
  assert.equal(p.loadPath, undefined); // does not exist
  assert.equal(p.refresh, true);
});
