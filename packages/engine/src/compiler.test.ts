/**
 * Unit tests for the flow-spec → Libretto compiler and its pure helpers.
 * No browser / no model — these assert the deterministic, keyless contract.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Flow, Target } from "@portico/flow-spec";
import { compileFlow, resolveActLocator, type StepRuntime } from "./compiler.js";
import { envelopeForExtraction, jsonSchemaToZod, validateAgainst } from "./json-schema.js";
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

test("intercept captures the latest matching JSON response the page makes", async () => {
  const flow: Flow = {
    key: "icept",
    version: 1,
    steps: [{ type: "intercept", label: "grab slots", intercept: { url_contains: "/Scheduling/GetSlots", as: "slots_raw" } }],
  };
  const { plan } = compileFlow(flow, target);
  assert.equal(plan[0]!.type, "intercept");

  let handler: ((resp: unknown) => Promise<void>) | undefined;
  const out: Record<string, any> = {};
  const rt = {
    output: out,
    rawPage: { on: (evt: string, h: (resp: unknown) => Promise<void>) => { if (evt === "response") handler = h; } },
  } as unknown as Parameters<(typeof plan)[0]["run"]>[0];

  await plan[0]!.run(rt);
  assert.equal(typeof handler, "function");

  const resp = (url: string, body: unknown) => ({ url: () => url, ok: () => true, json: async () => body });
  await handler!(resp("https://x/other", { nope: 1 }));
  assert.equal(out.slots_raw, undefined); // non-matching URL ignored
  await handler!(resp("https://mychart/MyChart/Scheduling/GetSlots", { Solutions: [{ Slots: [{ TimeString: "1:30 PM" }] }] }));
  assert.deepEqual(out.slots_raw, { Solutions: [{ Slots: [{ TimeString: "1:30 PM" }] }] });
});

test("act templates the locator's accessible name from inputs (not a literal {{...}})", async () => {
  const flow: Flow = {
    key: "a",
    version: 1,
    inputs: { specialty: "string" },
    steps: [{ type: "act", label: "pick", locator: { semantic: { role: "button", name: "{{specialty}}", intent: "the specialty tile" } } }],
  };
  const { plan } = compileFlow(flow, target);
  let seenName: string | undefined;
  const fakeLocator: Record<string, unknown> = { waitFor: async () => {}, click: async () => {} };
  fakeLocator.or = () => fakeLocator;
  fakeLocator.first = () => fakeLocator;
  const page = {
    getByRole: (_role: string, opts: { name: string }) => { seenName = opts.name; return fakeLocator; },
    getByLabel: () => fakeLocator,
    getByText: () => fakeLocator,
  };
  const rt = {
    page,
    rawPage: page,
    heal: null,
    output: {},
    input: { specialty: "Primary Care" },
    secrets: {},
    target,
    template: (s: string) => s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => (({ specialty: "Primary Care" }) as Record<string, string>)[k] ?? ""),
  } as unknown as Parameters<(typeof plan)[0]["run"]>[0];
  await plan[0]!.run(rt);
  assert.equal(seenName, "Primary Care"); // templated, not "{{specialty}}"
});

test("wait blocks until an output key is populated by the interceptor", async () => {
  const flow: Flow = { key: "w", version: 1, steps: [{ type: "wait", label: "w", wait: { for: "slots_raw", timeout_ms: 3000 } }] };
  const { plan } = compileFlow(flow, target);
  assert.equal(plan[0]!.type, "wait");
  const out: Record<string, unknown> = {};
  const rt = { output: out } as unknown as Parameters<(typeof plan)[0]["run"]>[0];
  setTimeout(() => { out.slots_raw = { ok: 1 }; }, 250); // interceptor fills it shortly after
  const r = await plan[0]!.run(rt);
  assert.equal(r.status, "ok");
});

test("wait fails loud if the value never arrives", async () => {
  const flow = { key: "w2", version: 1, steps: [{ type: "wait", wait: { for: "missing", timeout_ms: 300 } }] } as unknown as Flow;
  const { plan } = compileFlow(flow, target);
  const rt = { output: {} } as unknown as Parameters<(typeof plan)[0]["run"]>[0];
  await assert.rejects(() => plan[0]!.run(rt), /not populated/);
});

test("resolveProfile normalizes the profile id and points at .libretto/profiles", () => {
  const p = resolveProfile("URMC MyChart!", { cwd: "/tmp/repo" });
  assert.equal(p.name, "urmc-mychart");
  assert.equal(p.path, "/tmp/repo/.libretto/profiles/urmc-mychart.json");
  assert.equal(p.userDataDir, "/tmp/repo/.libretto/profiles/urmc-mychart.userdata");
  assert.equal(p.loadPath, undefined); // does not exist
  assert.equal(p.refresh, true);
});

// ---------------------------------------------------------------------------
// resolveActLocator — the act-target fallback chain
// ---------------------------------------------------------------------------

/** Stub page whose locators record the chain of calls that built them. */
function stubLocatorPage() {
  const make = (chain: string): Record<string, unknown> => ({
    chain,
    or: (other: { chain: string }) => make(`${chain}.or(${other.chain})`),
    first: () => make(`${chain}.first()`),
  });
  return {
    getByRole: (role: string, opts?: { name?: string }) => make(`role:${role}:${opts?.name ?? ""}`),
    getByLabel: (text: string) => make(`label:${text}`),
    getByText: (text: string) => make(`text:${text}`),
    locator: (sel: string) => make(`css:${sel}`),
  };
}

function locatorRt(inputs: Record<string, string> = {}) {
  return {
    page: stubLocatorPage(),
    template: (s: string) => s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => inputs[k] ?? ""),
  } as unknown as StepRuntime;
}

const chainOf = (loc: unknown) => (loc as { chain: string }).chain;

test("resolveActLocator: role+name is the FIRST (strict) candidate, then resilient fallbacks", () => {
  const r = resolveActLocator(locatorRt(), {
    type: "act",
    locator: { semantic: { role: "button", name: "8183054609", intent: "the claim number" } },
  });
  // 1st candidate is the exact strict role+name — unchanged behavior, so flows
  // that already match keep matching it.
  assert.equal(chainOf(r.candidates[0]), "role:button:8183054609");
  // A later candidate is the role-AGNOSTIC cascade (button OR link OR …), which
  // is what rescues a link captured as a button.
  assert.ok(r.candidates.some((c) => chainOf(c).includes(".or(role:link:8183054609")));
  // And a text fallback exists as the last resort.
  assert.ok(r.candidates.some((c) => chainOf(c).startsWith("label:8183054609.or(text:8183054609")));
});

test("resolveActLocator: a role-less name resolves to a robust first-match text locator", () => {
  const r = resolveActLocator(locatorRt(), {
    type: "act",
    locator: { semantic: { name: "Prasanna Kumar D E", intent: "Prasanna Kumar D E" } },
  });
  // No role captured → the ONLY candidate is the label/text first-match locator.
  assert.equal(r.candidates.length, 1);
  assert.equal(chainOf(r.candidates[0]), "label:Prasanna Kumar D E.or(text:Prasanna Kumar D E).first()");
});

test("resolveActLocator: a role-less templated name is rendered before matching", () => {
  const r = resolveActLocator(locatorRt({ patient: "Prasanna Kumar D E" }), {
    type: "act",
    locator: { semantic: { name: "{{patient}}", intent: "the patient row" } },
  });
  assert.equal(chainOf(r.candidates[0]), "label:Prasanna Kumar D E.or(text:Prasanna Kumar D E).first()");
});

test("resolveActLocator: cached is the first candidate, the semantic descriptor follows as fallback", () => {
  const r = resolveActLocator(locatorRt(), {
    type: "act",
    locator: { cached: "[data-testid='claims-tab']", semantic: { role: "button", name: "Claims", intent: "Claims tab" } },
  });
  assert.equal(chainOf(r.candidates[0]), "css:[data-testid='claims-tab']");
  assert.equal(chainOf(r.candidates[1]), "role:button:Claims"); // strict semantic next
});

test("resolveActLocator: cached with intent-only semantic has just the cached candidate", () => {
  const r = resolveActLocator(locatorRt(), {
    type: "act",
    locator: { cached: "#scheduling-continue", semantic: { intent: "scheduling-continue" } },
  });
  assert.equal(r.candidates.length, 1);
  assert.equal(chainOf(r.candidates[0]), "css:#scheduling-continue");
});

test("resolveActLocator: no cached, no role, no name → fails loud", () => {
  assert.throws(
    () => resolveActLocator(locatorRt(), { type: "act", label: "mystery", locator: { semantic: { intent: "?" } } }),
    /no cached selector and no usable semantic/,
  );
});

test("act self-heals from a stale cached selector to the semantic descriptor (no model)", async () => {
  const flow: Flow = {
    key: "heal-free",
    version: 1,
    steps: [
      {
        type: "act",
        label: "open claims",
        locator: { cached: "#gone-stale", semantic: { role: "button", name: "Claims", intent: "the Claims tab" } },
      },
    ],
  };
  const { plan } = compileFlow(flow, target);
  const clicked: string[] = [];
  const chain = (onClick?: () => void): Record<string, unknown> => {
    const loc: Record<string, unknown> = { waitFor: async () => {}, click: async () => onClick?.(), or: () => loc, first: () => loc };
    return loc;
  };
  const page = {
    // The stale cached selector fails at the visibility gate, exactly like a
    // real Playwright locator whose element no longer exists.
    locator: (sel: string) => ({ waitFor: async () => { throw new Error(`stale: ${sel}`); }, click: async () => { throw new Error(`stale: ${sel}`); } }),
    getByRole: (_role: string, opts: { name: string }) => chain(() => clicked.push(opts.name)),
    getByLabel: () => chain(),
    getByText: () => chain(),
  };
  const rt = {
    page,
    rawPage: page,
    heal: null, // deterministic hot path — the fallback must not need a model
    output: {},
    input: {},
    secrets: {},
    target,
    template: (s: string) => s,
  } as unknown as Parameters<(typeof plan)[0]["run"]>[0];
  const r = await plan[0]!.run(rt);
  assert.equal(r.status, "ok");
  assert.deepEqual(clicked, ["Claims"]); // cached failed → semantic clicked
});

// ---------------------------------------------------------------------------
// Extract-schema envelope: scalar roots must be object-wrapped for the model
// ---------------------------------------------------------------------------

test("envelopeForExtraction wraps a scalar-root schema and unwraps the model result", () => {
  const { schema, unwrap } = envelopeForExtraction({ type: "string" });
  // OpenAI structured outputs require the ROOT schema to be type "object".
  assert.deepEqual(schema, {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  });
  assert.equal(unwrap({ value: "Example Domain" }), "Example Domain"); // flow output stays a plain string
  assert.equal(unwrap("already-plain"), "already-plain"); // tolerant of an unenveloped result
});

test("envelopeForExtraction wraps array roots too, and passes object roots through untouched", () => {
  const arr = envelopeForExtraction({ type: "array", items: { type: "string" } });
  assert.equal((arr.schema as { type?: string }).type, "object");
  assert.deepEqual(arr.unwrap({ value: ["a", "b"] }), ["a", "b"]);

  const objSchema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
  const obj = envelopeForExtraction(objSchema);
  assert.equal(obj.schema, objSchema); // identical reference — no rewrap
  const result = { title: "x" };
  assert.equal(obj.unwrap(result), result); // identity unwrap
});

test("the unwrapped scalar validates against the ORIGINAL declared schema", () => {
  const declared = { type: "string" };
  const { unwrap } = envelopeForExtraction(declared);
  const check = validateAgainst(declared, unwrap({ value: "Example Domain" }));
  assert.equal(check.ok, true);
  assert.equal(check.value, "Example Domain");
});

// ---------------------------------------------------------------------------
// Reliability: intercept hoisting, extraction waits, retry policy
// ---------------------------------------------------------------------------

test("compileFlow hoists intercept registration ahead of navigate in the plan", () => {
  const flow: Flow = {
    key: "hoist",
    version: 1,
    steps: [
      { type: "navigate", url: "{{base_url}}/claims" },
      { type: "intercept", label: "cap", intercept: { url_contains: "/api/claims", as: "data_raw" } },
      { type: "wait", wait: { for: "data_raw", timeout_ms: 1000 } },
    ],
  };
  const { plan } = compileFlow(flow, target);
  // The listener must exist before the page load fires the data request —
  // otherwise the SPA's on-mount fetch races (and often beats) registration.
  assert.deepEqual(plan.map((s) => s.type), ["intercept", "navigate", "wait"]);
  // Original flow indices are preserved for tracing back to the YAML.
  assert.deepEqual(plan.map((s) => s.index), [1, 0, 2]);
});

test("extract waits for the element and retries an empty read until text arrives", async () => {
  const flow: Flow = {
    key: "ex",
    version: 1,
    steps: [
      {
        type: "extract",
        label: "phone",
        locator: { cached: "#phone", semantic: { intent: "the phone number" } },
        extract: { key: "phone", schema: { type: "string" } },
        retry: { max: 1, backoffMs: 1 },
        timeoutMs: 100,
      },
    ],
  };
  const { plan } = compileFlow(flow, target);
  let reads = 0;
  const page = {
    locator: (_sel: string) => ({
      first: () => ({ waitFor: async () => {} }),
      // First read races the render and sees empty text; the retry sees data.
      allInnerTexts: async () => (++reads === 1 ? [""] : ["+91 81830 54609"]),
    }),
  };
  const output: Record<string, unknown> = {};
  const rt = {
    page,
    rawPage: page,
    heal: null,
    output,
    input: {},
    secrets: {},
    target,
    unvalidated: new Set<string>(),
    template: (s: string) => s,
  } as unknown as Parameters<(typeof plan)[0]["run"]>[0];
  const r = await plan[0]!.run(rt);
  assert.equal(r.status, "ok");
  assert.equal(output.phone, "+91 81830 54609");
  assert.equal(reads, 2);
});

test("extract fails LOUD when the element never yields text (never a silent empty ok)", async () => {
  const flow: Flow = {
    key: "ex2",
    version: 1,
    steps: [
      {
        type: "extract",
        label: "phone",
        locator: { cached: "#phone", semantic: { intent: "the phone number" } },
        extract: { key: "phone", schema: { type: "string" } },
        retry: { max: 1, backoffMs: 1 },
        timeoutMs: 50,
      },
    ],
  };
  const { plan } = compileFlow(flow, target);
  const page = {
    locator: (_sel: string) => ({
      first: () => ({ waitFor: async () => {} }),
      allInnerTexts: async () => [],
    }),
  };
  const output: Record<string, unknown> = {};
  const rt = {
    page,
    rawPage: page,
    heal: null,
    output,
    input: {},
    secrets: {},
    target,
    unvalidated: new Set<string>(),
    template: (s: string) => s,
  } as unknown as Parameters<(typeof plan)[0]["run"]>[0];
  await assert.rejects(() => plan[0]!.run(rt), /refusing to store an empty extraction/);
  assert.equal(output.phone, undefined);
});

test("act honors the step's retry policy: transient failure, then success", async () => {
  const flow: Flow = {
    key: "retry",
    version: 1,
    steps: [
      {
        type: "act",
        label: "open workflow tab",
        retry: { max: 2, backoffMs: 1 },
        locator: { semantic: { role: "button", name: "Workflow", intent: "the Workflow tab" } },
      },
    ],
  };
  const { plan } = compileFlow(flow, target);
  let attempts = 0;
  const mkLoc = (): Record<string, unknown> => {
    const loc: Record<string, unknown> = {
      waitFor: async () => {},
      click: async () => {
        attempts++;
        if (attempts < 2) throw new Error("element detached mid-click");
      },
      or: () => loc,
      first: () => loc,
    };
    return loc;
  };
  const page = { getByRole: () => mkLoc(), getByLabel: () => mkLoc(), getByText: () => mkLoc() };
  const rt = {
    page,
    rawPage: page,
    heal: null,
    output: {},
    input: {},
    secrets: {},
    target,
    template: (s: string) => s,
  } as unknown as Parameters<(typeof plan)[0]["run"]>[0];
  const r = await plan[0]!.run(rt);
  assert.equal(r.status, "ok");
  assert.equal(attempts, 2);
});

test("a templated locator name that renders empty fails loud naming the missing input", () => {
  const rt = {
    page: {
      getByRole: () => ({}),
      getByLabel: () => ({ or: () => ({ first: () => ({}) }) }),
      getByText: () => ({}),
    },
    template: (s: string) => s.replace(/\{\{\s*[\w.]+\s*\}\}/g, ""), // input not provided
  } as unknown as StepRuntime;
  const step = {
    type: "act",
    label: "Open the claim row",
    locator: { semantic: { role: "button", name: "{{customer_name}}", intent: "the claim row" } },
  } as Parameters<typeof resolveActLocator>[1];
  assert.throws(() => resolveActLocator(rt, step), /did not provide input "customer_name"/);
});
