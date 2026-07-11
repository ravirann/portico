/**
 * Unit tests for the flow-spec → in-house compiler (ADR-0004) and its pure helpers.
 * No browser / no model — these assert the deterministic, keyless contract.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SECTOR_PROFILES } from "@portico/flow-spec";
import type { Flow, Target } from "@portico/flow-spec";
import {
  compileFlow,
  effectiveTimeouts,
  isMutatingAct,
  locatorRoot,
  parseCondition,
  resolveActLocator,
  withHardTimeout,
  type StepRuntime,
} from "./compiler.js";
import { envelopeForExtraction, jsonSchemaToZod, validateAgainst } from "./json-schema.js";
import { healModelConfigured } from "./model.js";
import { resolveProfile } from "./auth-profile.js";
import { PorticoStepError } from "./errors.js";

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

test("compileFlow builds an instrumented step plan carrying credentials + profile", () => {
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
  const { plan, profileName, credentialNames } = compileFlow(flow, target, { profileName: "urmc-mychart" });
  assert.equal(profileName, "urmc-mychart");
  assert.deepEqual([...credentialNames].sort(), ["password", "username"]);
  assert.equal(plan.length, 4);
  assert.deepEqual(plan.map((s) => s.type), ["navigate", "act", "act", "extract"]);
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
  const fakeLocator: Record<string, unknown> = {
    waitFor: async () => {},
    click: async () => {},
    scrollIntoViewIfNeeded: async () => {},
  };
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

test("resolveProfile normalizes the profile id and points at .portico/profiles", () => {
  const p = resolveProfile("URMC MyChart!", { cwd: "/tmp/repo" });
  assert.equal(p.name, "urmc-mychart");
  assert.equal(p.path, "/tmp/repo/.portico/profiles/urmc-mychart.json");
  assert.equal(p.userDataDir, "/tmp/repo/.portico/profiles/urmc-mychart.userdata");
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
    const loc: Record<string, unknown> = {
      waitFor: async () => {},
      click: async () => onClick?.(),
      scrollIntoViewIfNeeded: async () => {},
      or: () => loc,
      first: () => loc,
    };
    return loc;
  };
  const page = {
    // The stale cached selector fails at the visibility gate, exactly like a
    // real Playwright locator whose element no longer exists.
    locator: (sel: string) => ({
      scrollIntoViewIfNeeded: async () => {},
      waitFor: async () => { throw new Error(`stale: ${sel}`); },
      click: async () => { throw new Error(`stale: ${sel}`); },
    }),
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
      scrollIntoViewIfNeeded: async () => {},
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

test("a read step before any navigation fails legibly instead of a storage SecurityError", async () => {
  const flow = {
    key: "read-first",
    version: 1,
    description: "",
    steps: [
      {
        type: "read",
        label: "Read userToken from the page",
        read: { expression: "localStorage.getItem('userToken')", as: "user_token" },
      },
    ],
  } as unknown as Flow;
  const { plan } = compileFlow(flow, target);
  // A page that never navigated — Playwright reports about:blank (opaque origin,
  // where evaluating a storage read would throw the cryptic SecurityError).
  const rt = { rawPage: { url: () => "about:blank" }, output: {} } as unknown as StepRuntime;
  await assert.rejects(plan[0]!.run(rt), /before any navigation/);
});

// ---------------------------------------------------------------------------
// isMutatingAct — the dry-run mutation-keyword scan
// ---------------------------------------------------------------------------

test("isMutatingAct: matches a keyword in the label, case-insensitively", () => {
  assert.equal(isMutatingAct({ type: "act", label: "Submit Login" } as Flow["steps"][number], ["submit"]), true);
  assert.equal(isMutatingAct({ type: "act", label: "SUBMIT login" } as Flow["steps"][number], ["Submit"]), true);
});

test("isMutatingAct: matches in the locator's semantic name", () => {
  const step = { type: "act", locator: { semantic: { name: "Delete account", intent: "x" } } } as Flow["steps"][number];
  assert.equal(isMutatingAct(step, ["delete"]), true);
});

test("isMutatingAct: matches in the value", () => {
  assert.equal(isMutatingAct({ type: "act", value: "confirm" } as Flow["steps"][number], ["confirm"]), true);
});

test("isMutatingAct: no keyword present anywhere returns false", () => {
  const step = { type: "act", label: "Open the claims tab" } as Flow["steps"][number];
  assert.equal(isMutatingAct(step, ["delete", "book", "pay", "transfer"]), false);
});

test("isMutatingAct: an empty keyword list never matches", () => {
  assert.equal(isMutatingAct({ type: "act", label: "Delete everything" } as Flow["steps"][number], []), false);
});

// ---------------------------------------------------------------------------
// parseCondition — the assert/guard/human condition grammar
// ---------------------------------------------------------------------------

test("parseCondition: page_loaded has no arg", () => {
  assert.deepEqual(parseCondition("page_loaded"), { kind: "page_loaded" });
});

test("parseCondition: recognized <kind>:<arg> forms", () => {
  assert.deepEqual(parseCondition("url_contains:/dashboard"), { kind: "url_contains", arg: "/dashboard" });
  assert.deepEqual(parseCondition("text_visible:Welcome back"), { kind: "text_visible", arg: "Welcome back" });
  assert.deepEqual(parseCondition("selector_visible:.nav[data-x]"), { kind: "selector_visible", arg: ".nav[data-x]" });
  assert.deepEqual(parseCondition("output_present:slots_raw"), { kind: "output_present", arg: "slots_raw" });
});

test("parseCondition: splits on the FIRST colon only, so a ':'-bearing arg survives intact", () => {
  assert.deepEqual(parseCondition("url_contains:https://x.com/path"), {
    kind: "url_contains",
    arg: "https://x.com/path",
  });
});

test("parseCondition: unrecognized kind or no colon at all → unknown", () => {
  assert.deepEqual(parseCondition("dashboard_visible"), { kind: "unknown", raw: "dashboard_visible" });
  assert.deepEqual(parseCondition("two_factor_challenge_present"), {
    kind: "unknown",
    raw: "two_factor_challenge_present",
  });
  assert.deepEqual(parseCondition("bogus_kind:arg"), { kind: "unknown", raw: "bogus_kind:arg" });
  assert.deepEqual(parseCondition("page_loaded:extra"), { kind: "unknown", raw: "page_loaded:extra" });
});

// ---------------------------------------------------------------------------
// Conditions registry wired into assert/guard/human
// ---------------------------------------------------------------------------

test("assert: an unsupported condition throws PorticoStepError('unsupported', …) listing the supported forms", async () => {
  const flow: Flow = {
    key: "a1",
    version: 1,
    steps: [{ type: "assert", label: "check", condition: "dashboard_visible" }],
  };
  const { plan } = compileFlow(flow, target);
  const rt = { output: {} } as unknown as StepRuntime;
  await assert.rejects(
    () => plan[0]!.run(rt),
    (err: unknown) => {
      assert.ok(err instanceof PorticoStepError);
      assert.equal(err.kind, "unsupported");
      assert.match(err.message, /page_loaded/);
      return true;
    },
  );
});

test("assert: url_contains passes/fails based on the page's current URL", async () => {
  const flow: Flow = {
    key: "a2",
    version: 1,
    steps: [{ type: "assert", label: "on dashboard", condition: "url_contains:/dashboard" }],
  };
  const { plan } = compileFlow(flow, target);
  const rtOn = { rawPage: { url: () => "https://x/app/dashboard" }, output: {} } as unknown as StepRuntime;
  const r = await plan[0]!.run(rtOn);
  assert.equal(r.status, "ok");

  const rtOff = { rawPage: { url: () => "https://x/login" }, output: {} } as unknown as StepRuntime;
  await assert.rejects(() => plan[0]!.run(rtOff), /assertion failed/);
});

test("assert: output_present checks rt.output for a set, non-empty-string value", async () => {
  const flow: Flow = {
    key: "a3",
    version: 1,
    steps: [{ type: "assert", label: "has slots", condition: "output_present:slots_raw" }],
  };
  const { plan } = compileFlow(flow, target);
  await assert.rejects(() => plan[0]!.run({ output: {} } as unknown as StepRuntime), /assertion failed/);
  await assert.rejects(() => plan[0]!.run({ output: { slots_raw: "" } } as unknown as StepRuntime), /assertion failed/);
  const r = await plan[0]!.run({ output: { slots_raw: { a: 1 } } } as unknown as StepRuntime);
  assert.equal(r.status, "ok");
});

test("guard step with no condition keeps the original unconditional-ok behavior", async () => {
  const flow: Flow = { key: "g1", version: 1, steps: [{ type: "guard", label: "policy" }] };
  const { plan } = compileFlow(flow, target);
  const r = await plan[0]!.run({} as unknown as StepRuntime);
  assert.equal(r.status, "ok");
  assert.match(r.detail ?? "", /policy asserted at compile time/);
});

test("guard step: an unsupported condition ALSO throws PorticoStepError('unsupported', …), same as assert", async () => {
  const flow: Flow = {
    key: "g2b",
    version: 1,
    steps: [{ type: "guard", label: "check", condition: "some_bogus_condition" }],
  };
  const { plan } = compileFlow(flow, target);
  await assert.rejects(
    () => plan[0]!.run({ output: {} } as unknown as StepRuntime),
    (err: unknown) => {
      assert.ok(err instanceof PorticoStepError);
      assert.equal(err.kind, "unsupported");
      return true;
    },
  );
});

test("guard step with a condition evaluates it and fails loud (plain Error) when false", async () => {
  const flow: Flow = {
    key: "g2",
    version: 1,
    steps: [{ type: "guard", label: "must be ready", condition: "output_present:ready" }],
  };
  const { plan } = compileFlow(flow, target);
  await assert.rejects(() => plan[0]!.run({ output: {} } as unknown as StepRuntime), /guard failed/);
  const r = await plan[0]!.run({ output: { ready: true } } as unknown as StepRuntime);
  assert.equal(r.status, "ok");
});

test("human step with no condition always pauses (original unconditional behavior)", async () => {
  const flow: Flow = { key: "h1", version: 1, steps: [{ type: "human", label: "log in" }] };
  const { plan } = compileFlow(flow, target);
  const r = await plan[0]!.run({} as unknown as StepRuntime);
  assert.equal(r.status, "paused");
});

test("human step: an UNKNOWN condition still pauses (lenient) and notes it in the detail", async () => {
  const flow: Flow = {
    key: "h2",
    version: 1,
    steps: [{ type: "human", label: "2fa", condition: "two_factor_challenge_present" }],
  };
  const { plan } = compileFlow(flow, target);
  const r = await plan[0]!.run({} as unknown as StepRuntime);
  assert.equal(r.status, "paused");
  assert.match(r.detail ?? "", /not a recognized form/);
});

test("human step: a RECOGNIZED false condition skips the pause", async () => {
  const flow: Flow = {
    key: "h3",
    version: 1,
    steps: [{ type: "human", label: "review", condition: "output_present:needs_review" }],
  };
  const { plan } = compileFlow(flow, target);
  const r = await plan[0]!.run({ output: {} } as unknown as StepRuntime);
  assert.equal(r.status, "ok");
  assert.match(r.detail ?? "", /no human input needed/);
});

test("human step: a RECOGNIZED true condition pauses", async () => {
  const flow: Flow = {
    key: "h4",
    version: 1,
    steps: [{ type: "human", label: "review", condition: "output_present:needs_review" }],
  };
  const { plan } = compileFlow(flow, target);
  const r = await plan[0]!.run({ output: { needs_review: true } } as unknown as StepRuntime);
  assert.equal(r.status, "paused");
});

// ---------------------------------------------------------------------------
// effectiveTimeouts — profile default selection
// ---------------------------------------------------------------------------

test("effectiveTimeouts: step overrides win over the profile default", () => {
  const step = { type: "act", timeoutMs: 999, retry: { max: 9, backoffMs: 42 } } as Flow["steps"][number];
  assert.deepEqual(effectiveTimeouts(SECTOR_PROFILES.generic, step, "act"), { timeoutMs: 999, retryMax: 9, backoffMs: 42 });
});

test("effectiveTimeouts: falls back to the profile default when the step declares none", () => {
  const step = { type: "navigate" } as Flow["steps"][number];
  const profile = SECTOR_PROFILES.healthcare;
  assert.deepEqual(effectiveTimeouts(profile, step, "navigate"), {
    timeoutMs: profile.timing.navTimeoutMs,
    retryMax: profile.retry.navigateMax,
    backoffMs: profile.retry.backoffMs,
  });
});

test("effectiveTimeouts: a partial step override (backoffMs only) still falls back for max/timeout", () => {
  const step = { type: "extract", retry: { backoffMs: 1 } } as Flow["steps"][number];
  const profile = SECTOR_PROFILES.generic;
  assert.deepEqual(effectiveTimeouts(profile, step, "extract"), {
    timeoutMs: profile.timing.extractTimeoutMs,
    retryMax: profile.retry.extractMax,
    backoffMs: 1,
  });
});

test("effectiveTimeouts: the generic profile reproduces today's hardcoded per-phase constants", () => {
  const step = {} as Flow["steps"][number];
  const g = SECTOR_PROFILES.generic;
  assert.deepEqual(effectiveTimeouts(g, step, "act"), { timeoutMs: 15000, retryMax: 1, backoffMs: 500 });
  assert.deepEqual(effectiveTimeouts(g, step, "extract"), { timeoutMs: 10000, retryMax: 2, backoffMs: 500 });
  assert.deepEqual(effectiveTimeouts(g, step, "navigate"), { timeoutMs: 60000, retryMax: 1, backoffMs: 500 });
});

// ---------------------------------------------------------------------------
// locatorRoot — frame-scoped locator resolution
// ---------------------------------------------------------------------------

test("locatorRoot: no locator.frame → returns the page itself", () => {
  const page = stubLocatorPage();
  const root = locatorRoot(page as unknown as Parameters<typeof locatorRoot>[0], { semantic: { intent: "x" } });
  assert.equal(root, page);
});

test("locatorRoot: an empty frame array also returns the page unchanged", () => {
  const page = stubLocatorPage();
  const root = locatorRoot(page as unknown as Parameters<typeof locatorRoot>[0], { frame: [], semantic: { intent: "x" } });
  assert.equal(root, page);
});

test("locatorRoot: chains frameLocator() outermost→innermost for locator.frame", () => {
  const calls: string[] = [];
  const makeFrame = (label: string): { label: string; frameLocator: (sel: string) => unknown } => ({
    label,
    frameLocator: (sel: string) => {
      calls.push(`${label} -> frameLocator(${sel})`);
      return makeFrame(`${label}/${sel}`);
    },
  });
  const page = makeFrame("page");
  const root = locatorRoot(page as unknown as Parameters<typeof locatorRoot>[0], {
    frame: ["iframe.outer", "iframe.inner"],
    semantic: { intent: "x" },
  }) as unknown as { label: string };
  assert.deepEqual(calls, ["page -> frameLocator(iframe.outer)", "page/iframe.outer -> frameLocator(iframe.inner)"]);
  assert.equal(root.label, "page/iframe.outer/iframe.inner");
});

// ---------------------------------------------------------------------------
// resolveActLocator: cssCacheTrusted (untrusted-CSS sectors skip the cached candidate)
// ---------------------------------------------------------------------------

test("resolveActLocator: cssCacheTrusted defaults to true (cached candidate present, first)", () => {
  const r = resolveActLocator(locatorRt(), {
    type: "act",
    locator: { cached: "#claims-tab", semantic: { role: "button", name: "Claims", intent: "Claims tab" } },
  });
  assert.equal(chainOf(r.candidates[0]), "css:#claims-tab");
});

test("resolveActLocator: cssCacheTrusted:false skips the cached candidate, semantic ladder only", () => {
  const r = resolveActLocator(
    locatorRt(),
    { type: "act", locator: { cached: "#claims-tab", semantic: { role: "button", name: "Claims", intent: "Claims tab" } } },
    { cssCacheTrusted: false },
  );
  assert.ok(!r.candidates.some((c) => chainOf(c).startsWith("css:")));
  assert.equal(chainOf(r.candidates[0]), "role:button:Claims");
});

// ---------------------------------------------------------------------------
// withHardTimeout — the shared timeout-race mechanism behind api/read/self-heal
// ---------------------------------------------------------------------------

test("withHardTimeout: resolves normally when the promise settles before the ceiling", async () => {
  const result = await withHardTimeout(Promise.resolve("ok"), 1000, "test op");
  assert.equal(result, "ok");
});

test("withHardTimeout: rejects with a classified PorticoStepError('timeout', …) when the ceiling fires first", async () => {
  await assert.rejects(
    () => withHardTimeout(new Promise(() => {}), 20, "slow op"),
    (err: unknown) => {
      assert.ok(err instanceof PorticoStepError);
      assert.equal(err.kind, "timeout");
      assert.match(err.message, /slow op exceeded 20ms/);
      return true;
    },
  );
});

test("withHardTimeout: propagates the promise's own rejection when it loses the race", async () => {
  await assert.rejects(() => withHardTimeout(Promise.reject(new Error("real failure")), 1000, "op"), /real failure/);
});

// ---------------------------------------------------------------------------
// Dry-run act gate (isMutatingAct wired into runAct)
// ---------------------------------------------------------------------------

test("runAct: a mutating act is skipped (never touches the page) outside live mode, and recorded on the runtime", async () => {
  const flow: Flow = {
    key: "dryrun-act",
    version: 1,
    steps: [{ type: "act", label: "Delete the record", locator: { semantic: { role: "button", name: "Delete", intent: "delete" } } }],
  };
  const { plan } = compileFlow(flow, target);
  let touched = false;
  const page = {
    getByRole: () => { touched = true; return {}; },
    getByLabel: () => { touched = true; return {}; },
    getByText: () => { touched = true; return {}; },
  };
  const rt = {
    page,
    rawPage: page,
    heal: null,
    output: {},
    input: {},
    secrets: {},
    target,
    mode: "dry_run",
    skippedMutations: [] as string[],
    template: (s: string) => s,
  } as unknown as StepRuntime;
  const r = await plan[0]!.run(rt);
  assert.equal(r.status, "ok");
  assert.equal(touched, false); // never even resolved a locator
  assert.equal((rt as unknown as { skippedMutations: string[] }).skippedMutations.length, 1);
  assert.match((rt as unknown as { skippedMutations: string[] }).skippedMutations[0]!, /skipped mutating act in dry_run: Delete the record/);
  assert.match(r.detail ?? "", /skipped mutating act in dry_run/);
});

test("runAct: mode 'live' does NOT skip a mutating act", async () => {
  const flow: Flow = {
    key: "live-act",
    version: 1,
    steps: [{ type: "act", label: "Delete the record", locator: { semantic: { role: "button", name: "Delete", intent: "delete" } } }],
  };
  const { plan } = compileFlow(flow, target);
  const clicked: string[] = [];
  const loc: Record<string, unknown> = {
    waitFor: async () => {},
    click: async () => clicked.push("clicked"),
    scrollIntoViewIfNeeded: async () => {},
  };
  loc.or = () => loc;
  loc.first = () => loc;
  const page = { getByRole: () => loc, getByLabel: () => loc, getByText: () => loc };
  const rt = {
    page,
    rawPage: page,
    heal: null,
    output: {},
    input: {},
    secrets: {},
    target,
    mode: "live",
    skippedMutations: [] as string[],
    template: (s: string) => s,
  } as unknown as StepRuntime;
  const r = await plan[0]!.run(rt);
  assert.equal(r.status, "ok");
  assert.deepEqual(clicked, ["clicked"]);
  assert.equal((rt as unknown as { skippedMutations: string[] }).skippedMutations.length, 0);
});

test("compileFlow threads a non-generic sector profile into act retries end to end", async () => {
  const flow: Flow = {
    key: "profile-thread",
    version: 1,
    steps: [
      {
        type: "act",
        label: "flaky",
        retry: { backoffMs: 1 }, // keep the test fast; retryMax still comes from the profile
        // cached + intent-only semantic → resolveActLocator resolves exactly
        // ONE candidate (buildSemanticCandidates yields none without a
        // role/name), so the attempt count directly reflects the retry
        // policy — no locator-candidate-ladder multiplication to account for.
        locator: { cached: "#send-btn", semantic: { intent: "send button" } },
      },
    ],
  };
  const { plan } = compileFlow(flow, target, {}, SECTOR_PROFILES.commerce);
  let attempts = 0;
  const loc: Record<string, unknown> = {
    waitFor: async () => {},
    click: async () => {
      attempts++;
      throw new Error("always fails");
    },
    scrollIntoViewIfNeeded: async () => {},
  };
  const page = { locator: () => loc };
  const rt = {
    page,
    rawPage: page,
    heal: null,
    output: {},
    input: {},
    secrets: {},
    target,
    mode: "live",
    skippedMutations: [] as string[],
    template: (s: string) => s,
  } as unknown as StepRuntime;
  await assert.rejects(() => plan[0]!.run(rt), /always fails/);
  // commerce.retry.actMax = 2 → 1 initial attempt + 2 retries = 3 from the
  // candidate ladder's own retry loop (settled()), PLUS 1 more: since
  // ADR-0004, recover.ts's attemptWithRecovery runs by DEFAULT after settled()
  // fails (deterministic overlay dismissal — finds nothing here, this page
  // stub exposes no dismiss affordances — then one re-attempt of the action),
  // even with no heal model configured (`heal: null` above). That re-attempt
  // is call #4; it also fails "always fails", so the run still rejects with
  // that same message (recover.ts wraps it, preserving the substring).
  assert.equal(attempts, 4);
});

// ---------------------------------------------------------------------------
// Extract fail-loud: the silent page.title() fallback is gone
// ---------------------------------------------------------------------------

test("extract: no cached locator and no heal model fails loud (not the old silent page.title() fallback)", async () => {
  const flow: Flow = {
    key: "ex-fail-loud",
    version: 1,
    steps: [{ type: "extract", label: "mystery", extract: { key: "page_title", schema: { type: "string" } } }],
  };
  const { plan } = compileFlow(flow, target);
  let titleCalled = false;
  const page = {
    title: async () => {
      titleCalled = true;
      return "Should Not Be Used";
    },
  };
  const rt = {
    page,
    rawPage: page,
    heal: null,
    output: {},
    unvalidated: new Set<string>(),
    template: (s: string) => s,
  } as unknown as StepRuntime;
  await assert.rejects(
    () => plan[0]!.run(rt),
    (err: unknown) => {
      assert.ok(err instanceof PorticoStepError);
      assert.equal(err.kind, "not_found");
      assert.match(err.message, /page_title/);
      return true;
    },
  );
  assert.equal(titleCalled, false); // never fell back to reading the page title
});

// ---------------------------------------------------------------------------
// intercept.schema
// ---------------------------------------------------------------------------

test("intercept: schema validates the captured JSON; failure keeps the raw value and marks it unvalidated", async () => {
  const flow: Flow = {
    key: "icept-schema",
    version: 1,
    steps: [
      {
        type: "intercept",
        label: "grab",
        intercept: {
          url_contains: "/api/slots",
          as: "slots",
          schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        },
      },
    ],
  };
  const { plan } = compileFlow(flow, target);
  let handler: ((resp: unknown) => Promise<void>) | undefined;
  const out: Record<string, unknown> = {};
  const unvalidated = new Set<string>();
  const rt = {
    output: out,
    unvalidated,
    rawPage: { on: (evt: string, h: (resp: unknown) => Promise<void>) => { if (evt === "response") handler = h; } },
  } as unknown as StepRuntime;
  await plan[0]!.run(rt);

  const resp = (url: string, body: unknown) => ({ url: () => url, ok: () => true, json: async () => body });
  await handler!(resp("https://x/api/slots", { ok: true }));
  assert.deepEqual(out.slots, { ok: true });
  assert.equal(unvalidated.has("slots"), false);

  await handler!(resp("https://x/api/slots", { nope: 1 }));
  assert.deepEqual(out.slots, { nope: 1 }); // raw value kept, never dropped
  assert.equal(unvalidated.has("slots"), true);
});

test("intercept: no schema stores the raw JSON and never touches rt.unvalidated", async () => {
  const flow: Flow = {
    key: "icept-noschema",
    version: 1,
    steps: [{ type: "intercept", label: "grab", intercept: { url_contains: "/api/x", as: "raw" } }],
  };
  const { plan } = compileFlow(flow, target);
  let handler: ((resp: unknown) => Promise<void>) | undefined;
  const out: Record<string, unknown> = {};
  const rt = {
    output: out,
    rawPage: { on: (evt: string, h: (resp: unknown) => Promise<void>) => { if (evt === "response") handler = h; } },
  } as unknown as StepRuntime; // deliberately no `unvalidated` field — must not be touched
  await plan[0]!.run(rt);
  const resp = (url: string, body: unknown) => ({ url: () => url, ok: () => true, json: async () => body });
  await handler!(resp("https://x/api/x", { a: 1 }));
  assert.deepEqual(out.raw, { a: 1 });
});

// ---------------------------------------------------------------------------
// runWait: required intercepts fail loud + classified on timeout
// ---------------------------------------------------------------------------

test("wait: a required intercept that never fires throws PorticoStepError('timeout', …) naming the pattern", async () => {
  const flow: Flow = {
    key: "wait-required",
    version: 1,
    steps: [
      { type: "intercept", label: "grab", intercept: { url_contains: "/api/GetSlots", as: "slots_raw", required: true } },
      { type: "wait", wait: { for: "slots_raw", timeout_ms: 80 } },
    ],
  };
  const { plan } = compileFlow(flow, target);
  const waitStep = plan.find((s) => s.type === "wait")!;
  await assert.rejects(
    () => waitStep.run({ output: {} } as unknown as StepRuntime),
    (err: unknown) => {
      assert.ok(err instanceof PorticoStepError);
      assert.equal(err.kind, "timeout");
      assert.match(err.message, /required intercept "slots_raw"/);
      assert.match(err.message, /url_contains "\/api\/GetSlots"/);
      return true;
    },
  );
});

test("wait: a non-required key that never fires keeps the original plain-Error message", async () => {
  const flow: Flow = {
    key: "wait-optional",
    version: 1,
    steps: [{ type: "wait", wait: { for: "opportunistic", timeout_ms: 80 } }],
  };
  const { plan } = compileFlow(flow, target);
  await assert.rejects(
    () => plan[0]!.run({ output: {} } as unknown as StepRuntime),
    (err: unknown) => {
      assert.ok(!(err instanceof PorticoStepError));
      assert.match((err as Error).message, /not populated/);
      return true;
    },
  );
});

test("wait: waiting on a NON-required key stays a plain Error even when a DIFFERENT intercept in the flow is required", async () => {
  const flow: Flow = {
    key: "wait-mixed",
    version: 1,
    steps: [
      { type: "intercept", intercept: { url_contains: "/critical", as: "critical_data", required: true } },
      { type: "intercept", intercept: { url_contains: "/extra", as: "extra_data" } },
      { type: "wait", wait: { for: "extra_data", timeout_ms: 80 } },
    ],
  };
  const { plan } = compileFlow(flow, target);
  const waitStep = plan.find((s) => s.type === "wait")!;
  await assert.rejects(
    () => waitStep.run({ output: {} } as unknown as StepRuntime),
    (err: unknown) => {
      assert.ok(!(err instanceof PorticoStepError));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Gmail-class act primitives: method press/type/click/fill + locator.frame
// ---------------------------------------------------------------------------

test("act method 'press' with a locator resolves it and calls loc.press(value)", async () => {
  const flow: Flow = {
    key: "press-locator",
    version: 1,
    steps: [
      {
        type: "act",
        label: "send",
        method: "press",
        value: "Control+Enter",
        locator: { semantic: { role: "textbox", name: "Compose body", intent: "compose body" } },
      },
    ],
  };
  const { plan } = compileFlow(flow, target);
  const pressed: string[] = [];
  const loc: Record<string, unknown> = {
    waitFor: async () => {},
    press: async (key: string) => pressed.push(key),
    scrollIntoViewIfNeeded: async () => {},
  };
  loc.or = () => loc;
  loc.first = () => loc;
  const page = { getByRole: () => loc, getByLabel: () => loc, getByText: () => loc };
  const rt = {
    page,
    rawPage: page,
    heal: null,
    output: {},
    input: {},
    secrets: {},
    target,
    mode: "live", // these tests exercise method dispatch mechanics, not the dry-run gate
    skippedMutations: [] as string[],
    template: (s: string) => s,
  } as unknown as StepRuntime;
  const r = await plan[0]!.run(rt);
  assert.equal(r.status, "ok");
  assert.deepEqual(pressed, ["Control+Enter"]);
});

test("act method 'press' with NO locator presses the keyboard chord directly on the page", async () => {
  const flow: Flow = {
    key: "press-keyboard",
    version: 1,
    steps: [{ type: "act", label: "close", method: "press", value: "Escape" }],
  };
  const { plan } = compileFlow(flow, target);
  const pressed: string[] = [];
  const page = { keyboard: { press: async (k: string) => pressed.push(k) } };
  const rt = {
    page,
    rawPage: page,
    heal: null,
    output: {},
    input: {},
    secrets: {},
    target,
    mode: "live", // these tests exercise method dispatch mechanics, not the dry-run gate
    skippedMutations: [] as string[],
    template: (s: string) => s,
  } as unknown as StepRuntime;
  const r = await plan[0]!.run(rt);
  assert.equal(r.status, "ok");
  assert.deepEqual(pressed, ["Escape"]);
});

test("act method 'type' clicks then pressSequentially's the value (real key events)", async () => {
  const flow: Flow = {
    key: "type-method",
    version: 1,
    steps: [
      {
        type: "act",
        label: "compose",
        method: "type",
        value: "hello",
        locator: { semantic: { role: "textbox", name: "Body", intent: "body" } },
      },
    ],
  };
  const { plan } = compileFlow(flow, target);
  const calls: string[] = [];
  const loc: Record<string, unknown> = {
    waitFor: async () => {},
    click: async () => calls.push("click"),
    pressSequentially: async (text: string) => calls.push(`type:${text}`),
    scrollIntoViewIfNeeded: async () => {},
  };
  loc.or = () => loc;
  loc.first = () => loc;
  const page = { getByRole: () => loc, getByLabel: () => loc, getByText: () => loc };
  const rt = {
    page,
    rawPage: page,
    heal: null,
    output: {},
    input: {},
    secrets: {},
    target,
    mode: "live", // these tests exercise method dispatch mechanics, not the dry-run gate
    skippedMutations: [] as string[],
    template: (s: string) => s,
  } as unknown as StepRuntime;
  const r = await plan[0]!.run(rt);
  assert.equal(r.status, "ok");
  assert.deepEqual(calls, ["click", "type:hello"]);
});

test("act method 'click' forces a click even when a value is present (no fill)", async () => {
  const flow: Flow = {
    key: "click-method",
    version: 1,
    steps: [
      {
        type: "act",
        label: "checkbox",
        method: "click",
        value: "irrelevant",
        locator: { semantic: { role: "checkbox", name: "Agree", intent: "agree" } },
      },
    ],
  };
  const { plan } = compileFlow(flow, target);
  const calls: string[] = [];
  const loc: Record<string, unknown> = {
    waitFor: async () => {},
    click: async () => calls.push("click"),
    fill: async () => calls.push("fill"),
    scrollIntoViewIfNeeded: async () => {},
  };
  loc.or = () => loc;
  loc.first = () => loc;
  const page = { getByRole: () => loc, getByLabel: () => loc, getByText: () => loc };
  const rt = {
    page,
    rawPage: page,
    heal: null,
    output: {},
    input: {},
    secrets: {},
    target,
    mode: "live", // these tests exercise method dispatch mechanics, not the dry-run gate
    skippedMutations: [] as string[],
    template: (s: string) => s,
  } as unknown as StepRuntime;
  const r = await plan[0]!.run(rt);
  assert.equal(r.status, "ok");
  assert.deepEqual(calls, ["click"]);
});

