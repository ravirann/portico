/**
 * Unit tests for compileRecording — the deterministic recording → flow-draft
 * compiler. Uses a realistic synthetic MyChart-like demonstration: a login,
 * a specialty tile, a visit-reason tile, a location tile, a "Continue"
 * click, and a final slot-time pick that must never be replayed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRecording, type Recording } from "./compile-recording.js";
import type { Step } from "./index.js";

const recording: Recording = {
  baseUrl: "https://mychart.example.org/MyChart/SignIn",
  clicks: [
    { tag: "INPUT", text: "Login" },
    { tag: "INPUT", name: "submit" },
    { tag: "BUTTON", text: "Primary Care  Includes adult, pediatric, and geriatric care" },
    { tag: "BUTTON", text: "New Patient Adult Visit (18 and over) - Primary Care" },
    { role: "button", text: "Southview Internal Medicine 995 Senator Keating Blvd" },
    { tag: "INPUT", id: "scheduling-continue" },
    { tag: "A", text: "11:00 AM EDT on Thursday October 8" },
  ],
  network: [
    {
      method: "GET",
      url: "https://mychart.example.org/assets/logo.png",
      resourceType: "image",
      status: 200,
      contentType: "image/png",
      responseBodyBytes: 5000,
    },
    {
      method: "POST",
      url: "https://analytics.example.com/collect",
      resourceType: "xhr",
      status: 200,
      contentType: "application/json",
      responseBodyPreview: '{"ok":true}',
      responseBodyBytes: 20,
    },
    {
      method: "POST",
      url: "https://mychart.example.org/MyChart/Scheduling/GetSlots",
      resourceType: "xhr",
      status: 200,
      contentType: "application/json",
      responseBodyPreview:
        '{"Solutions":[{"Slots":[{"DisplayDateTimeUtc":"2026-10-08T12:00:00Z","TimeString":"8:00 AM"}]}]}',
      responseBodyBytes: 200,
    },
  ],
};

test("compiles a full recording into intercept/navigate/act…/wait/select", () => {
  const flow = compileRecording(recording, { key: "mychart-slots" });

  assert.equal(flow.key, "mychart-slots");
  assert.equal(flow.version, 1);
  // Intercept FIRST: the listener must exist before the page load that can
  // fire the data request, or the capture races the navigation and loses.
  assert.equal(
    flow.steps.map((s) => s.type).join(","),
    ["intercept", "navigate", "act", "act", "act", "act", "wait", "select"].join(","),
  );
});

test("navigate step opens the recording's baseUrl (after the intercept registration)", () => {
  const flow = compileRecording(recording);
  const nav = flow.steps.find((s) => s.type === "navigate")!;
  assert.equal(nav.url, recording.baseUrl);
  assert.ok(
    flow.steps.findIndex((s) => s.type === "intercept") < flow.steps.findIndex((s) => s.type === "navigate"),
    "intercept must be registered before navigate",
  );
});

test("intercept targets the GetSlots endpoint and stores it as data_raw", () => {
  const flow = compileRecording(recording);
  const intercept = flow.steps.find((s) => s.type === "intercept")!;
  assert.ok(intercept.intercept);
  assert.ok(intercept.intercept!.url_contains.includes("GetSlots"));
  assert.equal(intercept.intercept!.as, "data_raw");
});

test("login inputs and the final slot-time click are filtered out of the acts", () => {
  const flow = compileRecording(recording);
  const acts = flow.steps.filter((s) => s.type === "act");
  assert.equal(acts.length, 4);
});

test("first act keeps the FULL label as name (whitespace-collapsed), with the raw label as intent", () => {
  const flow = compileRecording(recording);
  const acts = flow.steps.filter((s) => s.type === "act");
  const first = acts[0]!;
  // The name must never be truncated to a leading phrase — a shortened name
  // (e.g. "Prasanna" for "Prasanna Kumar D E") makes replay match the wrong row.
  assert.equal(first.locator!.semantic.name, "Primary Care Includes adult, pediatric, and geriatric care");
  assert.equal(
    first.locator!.semantic.intent,
    "Primary Care  Includes adult, pediatric, and geriatric care",
  );
});

test("a multi-word label is preserved in full, capped at ~80 chars", () => {
  const longTail = "x".repeat(100);
  const rec: Recording = {
    baseUrl: "https://x/",
    clicks: [
      { tag: "DIV", text: "Prasanna\n   Kumar  D E" }, // whitespace-mangled row label
      { tag: "BUTTON", text: `Details ${longTail}` },
    ],
    network: [],
  };
  const flow = compileRecording(rec);
  const acts = flow.steps.filter((s) => s.type === "act");
  assert.equal(acts[0]!.locator!.semantic.name, "Prasanna Kumar D E"); // full name, collapsed
  assert.ok(acts[1]!.locator!.semantic.name!.length <= 80);
  assert.ok(acts[1]!.locator!.semantic.name!.startsWith("Details x"));
});

test("visit-reason act name starts with the full reason phrase", () => {
  const flow = compileRecording(recording);
  const acts = flow.steps.filter((s) => s.type === "act");
  const reason = acts[1]!;
  assert.ok(reason.locator!.semantic.name!.startsWith("New Patient Adult Visit"));
});

test("select step picks the earliest slot from the harvested response", () => {
  const flow = compileRecording(recording);
  const select = flow.steps.find((s) => s.type === "select")!;
  assert.ok(select.select);
  assert.equal(select.select!.policy, "earliest");
  assert.equal(select.select!.from, "data_raw.Solutions.0.Slots");
  assert.equal(select.select!.by, "DisplayDateTimeUtc");
  assert.equal(select.select!.as, "chosen");
});

test("guard forbids booking on the compiled flow", () => {
  const flow = compileRecording(recording);
  assert.equal(flow.guard?.no_booking, true);
  assert.equal(flow.guard?.dry_run_only, true);
  assert.ok(flow.guard?.forbidden_actions?.includes("book"));
});

test("clicks made on an auth/login page are filtered by URL, regardless of label", () => {
  const rec: Recording = {
    baseUrl: "https://mychart.example.org/MyChart/Scheduling",
    clicks: [
      { tag: "INPUT", text: "MyChart Username or", url: "https://mychart.example.org/MyChart/Authentication/Login" },
      { tag: "BUTTON", text: "Sign in", url: "https://mychart.example.org/MyChart/Authentication/Login" },
      { tag: "BUTTON", text: "Primary Care", url: "https://mychart.example.org/MyChart/Scheduling" },
    ],
    network: [],
  };
  const flow = compileRecording(rec);
  const acts = flow.steps.filter((s) => s.type === "act");
  assert.equal(acts.length, 1); // only the post-login "Primary Care" click survives
  assert.equal(acts[0]!.locator!.semantic!.name, "Primary Care");
});

test("an id-only control becomes a cached #id selector, not an unmatchable text locator", () => {
  const rec: Recording = {
    baseUrl: "https://x/scheduling",
    clicks: [{ tag: "INPUT", id: "scheduling-continue" }],
    network: [],
  };
  const flow = compileRecording(rec);
  const act = flow.steps.find((s) => s.type === "act")!;
  assert.equal(act.locator!.cached, "#scheduling-continue");
  assert.equal(act.locator!.semantic.intent, "scheduling-continue");
});

test("a recording with no JSON data endpoint compiles to navigate + acts only", () => {
  const noJson: Recording = {
    baseUrl: "https://portal.example.org/home",
    clicks: [
      { tag: "INPUT", text: "Login" },
      { tag: "BUTTON", text: "Primary Care" },
      { tag: "A", text: "Book now" },
    ],
    network: [
      {
        method: "GET",
        url: "https://portal.example.org/assets/logo.png",
        resourceType: "image",
        status: 200,
        contentType: "image/png",
        responseBodyBytes: 3000,
      },
    ],
  };

  const flow = compileRecording(noJson);
  const types = flow.steps.map((s: Step) => s.type);

  assert.deepEqual(types, ["navigate", "act"]);
});

// ---------------------------------------------------------------------------
// Claims-lookup regression: the broken pulse.clinikk.com artifact
// ---------------------------------------------------------------------------

const claimsRecording: Recording = {
  baseUrl: "https://pulse.example.com",
  clicks: [
    { tag: "BUTTON", role: "button", text: "Claims" },
    { tag: "DIV", text: "Prasanna  Kumar D E" }, // role-less row, double-space label
    { tag: "BUTTON", text: "Details" },
    { tag: "BUTTON", role: "button", text: "8183054609" },
  ],
  network: [
    {
      method: "GET",
      url: "https://pulse.example.com/api/proxy/v1/claims",
      resourceType: "xhr",
      status: 200,
      contentType: "application/json",
      responseBodyPreview: '{"claims":[{"id":"C-1","member":"Prasanna Kumar D E"}]}',
      responseBodyBytes: 400,
    },
  ],
};

test("claims recording compiles to intercept/navigate/act×4/wait with the claims endpoint", () => {
  const flow = compileRecording(claimsRecording, { key: "claims-read" });
  assert.deepEqual(
    flow.steps.map((s) => s.type),
    ["intercept", "navigate", "act", "act", "act", "act", "wait"],
  );
  const intercept = flow.steps.find((s) => s.type === "intercept")!;
  assert.equal(intercept.intercept!.url_contains, "/api/proxy/v1/claims");
  assert.equal(intercept.intercept!.as, "data_raw");
});

test("a role-less row click keeps its FULL name (not the first word)", () => {
  const flow = compileRecording(claimsRecording);
  const acts = flow.steps.filter((s) => s.type === "act");
  const row = acts[1]!;
  assert.equal(row.locator!.semantic.name, "Prasanna Kumar D E");
  assert.equal(row.locator!.semantic.intent, "Prasanna  Kumar D E");
  assert.equal(row.locator!.semantic.role, undefined);
});

// ---------------------------------------------------------------------------
// Exploration-noise collapse + volatile-text truncation
// ---------------------------------------------------------------------------

test("no-op toggle pairs collapse away, including pairs revealed by an inner collapse", () => {
  // The real pulse.clinikk.com noise pattern: filter panel opened, a dropdown
  // opened+closed with nothing selected, panel closed again — then the real work.
  const noisy: Recording = {
    baseUrl: "https://pulse.example.com/claims",
    clicks: [
      { tag: "BUTTON", role: "button", text: "Toggle filters" },
      { tag: "DIV", text: "All Types  Cashless OPD Reimbursement Hospital Reimbursement" },
      { tag: "DIV", text: "All Types  Cashless OPD Reimbursement Hospital Reimbursement" },
      { tag: "BUTTON", role: "button", text: "Toggle filters" },
      { tag: "BUTTON", role: "button", text: "IN_PROGRESS" },
      { tag: "DIV", text: "Prasanna Kumar D E" },
      { tag: "BUTTON", role: "button", text: "Workflow" },
    ],
    network: [],
  };
  const flow = compileRecording(noisy);
  const actNames = flow.steps.filter((s) => s.type === "act").map((s) => s.locator!.semantic.name);
  assert.deepEqual(actNames, ["IN_PROGRESS", "Prasanna Kumar D E", "Workflow"]);
});

test("repeated clicks on non-toggle elements are kept (pagination is intentional)", () => {
  const paging: Recording = {
    baseUrl: "https://portal.example.org",
    clicks: [
      { tag: "BUTTON", role: "button", text: "Next page" },
      { tag: "BUTTON", role: "button", text: "Next page" },
    ],
    network: [],
  };
  const flow = compileRecording(paging);
  assert.equal(flow.steps.filter((s) => s.type === "act").length, 2);
});

test("volatile dates and counts are truncated out of semantic names", () => {
  const rec: Recording = {
    baseUrl: "https://pulse.example.com/claims",
    clicks: [
      { tag: "BUTTON", role: "button", text: "Claim Documents Submitted  6 JULY 2026  2 docs  DOCUMENTS VERIFIED" },
      { tag: "BUTTON", role: "button", text: "Under Review 7 JULY 2026 gracy • 1 AI doc review MARK REVIEWED" },
    ],
    network: [],
  };
  const flow = compileRecording(rec);
  const [a, b] = flow.steps.filter((s) => s.type === "act");
  assert.equal(a!.locator!.semantic.name, "Claim Documents Submitted");
  assert.equal(b!.locator!.semantic.name, "Under Review");
  // Intent keeps the full recorded label for traceability.
  assert.ok(a!.locator!.semantic.intent.includes("6 JULY 2026"));
});

test("a label that IS a date stays intact (calendar cells must not truncate to nothing)", () => {
  const rec: Recording = {
    baseUrl: "https://portal.example.org",
    clicks: [{ tag: "BUTTON", role: "button", text: "6 JULY 2026" }],
    network: [],
  };
  const flow = compileRecording(rec);
  const act = flow.steps.find((s) => s.type === "act")!;
  assert.equal(act.locator!.semantic.name, "6 JULY 2026");
});

test("instance-specific literals get a param_hint; UI vocabulary does not", () => {
  const flow = compileRecording(claimsRecording);
  const acts = flow.steps.filter((s) => s.type === "act");
  const hints = acts.map((a) => a.locator!.semantic.param_hint);
  assert.equal(hints[0], undefined); // "Claims" — nav vocabulary
  assert.equal(hints[1], "prasanna_kumar_d_e"); // person name → suggested input
  assert.equal(hints[2], undefined); // "Details" — nav vocabulary
  assert.equal(hints[3], "phone_number"); // 10-digit literal
});

test("param_hint slugs are template-safe (underscores, [\\w] only)", () => {
  const flow = compileRecording(claimsRecording);
  const acts = flow.steps.filter((s) => s.type === "act");
  for (const hint of acts.map((a) => a.locator!.semantic.param_hint)) {
    if (hint) assert.match(hint, /^[a-z0-9_]+$/); // must survive the {{[\w.]+}} template grammar
  }
});

test("email-shaped and long-numeric literals are flagged; capitalized nav phrases are not", () => {
  const rec: Recording = {
    baseUrl: "https://x/",
    clicks: [
      { tag: "BUTTON", text: "someone@example.com" },
      { tag: "BUTTON", text: "123456789012345678" }, // 18 digits — reference, not phone
      { tag: "BUTTON", text: "New Patient" }, // all stoplist words → not flagged
      { tag: "BUTTON", text: "Search Claims" }, // all stoplist words → not flagged
    ],
    network: [],
  };
  const flow = compileRecording(rec);
  const acts = flow.steps.filter((s) => s.type === "act");
  assert.equal(acts[0]!.locator!.semantic.param_hint, "email");
  assert.equal(acts[1]!.locator!.semantic.param_hint, "reference_number");
  assert.equal(acts[2]!.locator!.semantic.param_hint, undefined);
  assert.equal(acts[3]!.locator!.semantic.param_hint, undefined);
});

// ---------------------------------------------------------------------------
// Tiered locator synthesis: structural hooks (testid / stable id) + semantics
// ---------------------------------------------------------------------------

test("a click with data-testid emits a DUAL locator: cached testid + full semantic", () => {
  const rec: Recording = {
    baseUrl: "https://x/",
    clicks: [{ tag: "BUTTON", text: "Claims", testid: "claims-tab" }],
    network: [],
  };
  const act = compileRecording(rec).steps.find((s) => s.type === "act")!;
  assert.equal(act.locator!.cached, "[data-testid='claims-tab']");
  assert.equal(act.locator!.semantic.role, "button");
  assert.equal(act.locator!.semantic.name, "Claims"); // semantic kept for self-heal
});

test("a stable human-named id becomes a cached #id alongside the semantic locator", () => {
  const rec: Recording = {
    baseUrl: "https://x/",
    clicks: [{ tag: "BUTTON", text: "Details", id: "claims-details" }],
    network: [],
  };
  const act = compileRecording(rec).steps.find((s) => s.type === "act")!;
  assert.equal(act.locator!.cached, "#claims-details");
  assert.equal(act.locator!.semantic.name, "Details");
});

test("auto-generated ids are never cached (framework prefixes, digit runs, hex chunks)", () => {
  const rec: Recording = {
    baseUrl: "https://x/",
    clicks: [
      { tag: "BUTTON", text: "Details", id: "radix-:r3:" },
      { tag: "BUTTON", text: "Details", id: "btn-84f2a9c1" },
      { tag: "BUTTON", text: "Details", id: "tab-20260708" },
    ],
    network: [],
  };
  for (const act of compileRecording(rec).steps.filter((s) => s.type === "act")) {
    assert.equal(act.locator!.cached, undefined);
    assert.equal(act.locator!.semantic.name, "Details"); // semantic path instead
  }
});

test("instance-specific label + SHARED structural hook → parameterizable semantic wins, hook dropped", () => {
  // data-testid="patient-row" is on EVERY row — caching it would deterministically
  // click the wrong patient. The (parameterizable) text is the discriminator.
  const rec: Recording = {
    baseUrl: "https://x/",
    clicks: [{ tag: "DIV", text: "Prasanna Kumar D E", testid: "patient-row" }],
    network: [],
  };
  const act = compileRecording(rec).steps.find((s) => s.type === "act")!;
  assert.equal(act.locator!.cached, undefined);
  assert.equal(act.locator!.semantic.name, "Prasanna Kumar D E");
  assert.equal(act.locator!.semantic.param_hint, "prasanna_kumar_d_e");
});

test("a label-less control still prefers testid over id for its cached selector", () => {
  const rec: Recording = {
    baseUrl: "https://x/",
    clicks: [{ tag: "INPUT", testid: "continue-btn", id: "radix-:r9:" }],
    network: [],
  };
  const act = compileRecording(rec).steps.find((s) => s.type === "act")!;
  assert.equal(act.locator!.cached, "[data-testid='continue-btn']");
});

test("stable UI buttons never get a param_hint, even proper-noun-shaped ones (pulse.clinikk regression)", () => {
  // The exact labels from the failing pulse.clinikk.com recording: every one of
  // these became a required run input before the fix. Buttons are actions.
  const rec: Recording = {
    baseUrl: "https://pulse.clinikk.com/claims",
    clicks: [
      { tag: "BUTTON", text: "APPLY FILTERS" },
      { tag: "BUTTON", text: "Under Review 7 JULY 2026 gracy • 1 AI doc review MARK REVIEWED" },
      { tag: "A", role: "tab", text: "All Claims" },
      { tag: "BUTTON", text: "Workflow" },
      { tag: "BUTTON", text: "View Details" },
      { tag: "SPAN", text: "Hardik Gowda V" }, // role-less cell → a real value, still flagged
      { tag: "BUTTON", text: "8183054609" }, // phone rendered as a button → shape wins, still flagged
    ],
    network: [],
  };
  const acts = compileRecording(rec).steps.filter((s) => s.type === "act");
  const hintByName = Object.fromEntries(acts.map((a) => [a.locator!.semantic.name, a.locator!.semantic.param_hint]));
  assert.equal(hintByName["APPLY FILTERS"], undefined);
  assert.equal(hintByName["Under Review"], undefined); // volatile date also truncated out of the name
  assert.equal(hintByName["All Claims"], undefined);
  assert.equal(hintByName["Workflow"], undefined);
  assert.equal(hintByName["View Details"], undefined);
  assert.equal(hintByName["Hardik Gowda V"], "hardik_gowda_v"); // role-less → real value
  assert.equal(hintByName["8183054609"], "phone_number"); // shape-based, survives on a button
});
