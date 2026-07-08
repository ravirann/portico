/**
 * Unit tests for compileRecording — the deterministic recording → flow-draft
 * compiler. Uses a realistic synthetic MyChart-like demonstration: a login,
 * a specialty tile, a visit-reason tile, a location tile, a "Continue"
 * click, and a final slot-time pick that must never be replayed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRecording, type Recording } from "./compile-recording.js";
import type { Step } from "@portico/flow-spec";

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

test("compiles a full recording into navigate/intercept/act…/wait/select", () => {
  const flow = compileRecording(recording, { key: "mychart-slots" });

  assert.equal(flow.key, "mychart-slots");
  assert.equal(flow.version, 1);
  assert.equal(
    flow.steps.map((s) => s.type).join(","),
    ["navigate", "intercept", "act", "act", "act", "act", "wait", "select"].join(","),
  );
});

test("navigate step opens the recording's baseUrl", () => {
  const flow = compileRecording(recording);
  const nav = flow.steps[0]!;
  assert.equal(nav.type, "navigate");
  assert.equal(nav.url, recording.baseUrl);
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

test("first act is trimmed to its leading phrase, with the full label preserved as intent", () => {
  const flow = compileRecording(recording);
  const acts = flow.steps.filter((s) => s.type === "act");
  const first = acts[0]!;
  assert.equal(first.locator!.semantic.name, "Primary Care");
  assert.equal(
    first.locator!.semantic.intent,
    "Primary Care  Includes adult, pediatric, and geriatric care",
  );
});

test("visit-reason act name starts with the full reason phrase, cut before ' - Primary Care'", () => {
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
