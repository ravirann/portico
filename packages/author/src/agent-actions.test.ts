/**
 * Two-source reconciliation: proves the agent's own action stream, joined to the
 * DOM click-hook stream, produces the RIGHT replay steps — dropping the noise the
 * agent never touched, filling identity gaps, and degrading safely when the agent
 * stream is thin or uncorrelated (no regression vs. the DOM-hook-only path).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClickEvent } from "@portico/flow-spec";
import { compileRecording } from "@portico/flow-spec";
import { extractAgentActions, reconcileClicks, conciseLabel } from "./agent-actions.js";
import { replayableClicks, stopAtEphemeralSlot } from "./index.js";

// A raw `AgentResult.actions` entry as Stagehand emits it in hybrid/dom mode.
function act(action: string, xpath?: string, description?: string, method = "click") {
  return {
    type: "act",
    reasoning: "working toward the goal",
    action,
    ...(xpath ? { playwrightArguments: { selector: `xpath=${xpath}`, description: description ?? action, method } } : {}),
  };
}

test("extractAgentActions distills act entries: intent, xpath (prefix stripped), method", () => {
  const raw = [
    { type: "ariaTree", pageUrl: "u" }, // not an interaction → ignored
    act("click the Schedule an Appointment button", "/html[1]/body[1]/button[1]", "Schedule an Appointment"),
    { type: "screenshot", result: "screenshotTaken" }, // ignored
    { type: "act", reasoning: "r", action: "type the reason", playwrightArguments: { selector: "xpath=/html[1]/input[1]", method: "fill", arguments: ["headache"] } },
    { type: "done", taskComplete: true }, // ignored
  ];
  const got = extractAgentActions(raw);
  assert.equal(got.length, 2);
  assert.equal(got[0]!.kind, "click");
  assert.equal(got[0]!.xpath, "/html[1]/body[1]/button[1]"); // "xpath=" stripped
  assert.equal(got[0]!.label, "Schedule an Appointment"); // description preferred over instruction
  assert.equal(got[1]!.kind, "fill");
  assert.equal(got[1]!.value, "headache");
});

test("extractAgentActions tolerates a missing/loose action array", () => {
  assert.deepEqual(extractAgentActions(undefined), []);
  assert.deepEqual(extractAgentActions([null, 3, "x", {}]), []);
});

test("reconcile drops dashboard/notification noise the agent never clicked (the real URMC bug)", () => {
  // Hook captured 5 clicks; 3 are noise (a phone-verify card, a security banner,
  // a container blob) the agent never intended. The agent stream has the 3 real
  // interactions. The reconciled flow must contain ONLY those 3.
  const clicks: ClickEvent[] = [
    { text: "Your mobile phone number has been changed to 585-503-9535. We need to verify tha", url: "u", xpath: "xpath=/html[1]/body[1]/div[9]" },
    { text: "Schedule an Appointment", role: "button", url: "u", xpath: "xpath=/html[1]/body[1]/button[1]" },
    { text: "MyChart Security Reminder: Protect Your Health Information Protecting your perso", url: "u", xpath: "xpath=/html[1]/body[1]/div[12]" },
    { text: "Primary Care Includes adult, pediatric, and geriatric care", role: "button", url: "u", xpath: "xpath=/html[1]/body[1]/button[2]" },
    { text: "New Patient Adult Visit (18 and over) - Primary Care", role: "button", url: "u", xpath: "xpath=/html[1]/body[1]/button[3]" },
  ];
  const agentActs = extractAgentActions([
    act("click Schedule an Appointment", "/html[1]/body[1]/button[1]"),
    act("click Primary Care", "/html[1]/body[1]/button[2]"),
    act("click New Patient Adult Visit", "/html[1]/body[1]/button[3]"),
  ]);
  const r = reconcileClicks(clicks, agentActs);
  assert.equal(r.usedAgentStream, true);
  assert.deepEqual(
    r.steps.map((s) => (s.ariaLabel ?? s.text)),
    ["Schedule an Appointment", "Primary Care Includes adult, pediatric, and geriatric care", "New Patient Adult Visit (18 and over) - Primary Care"],
  );
  assert.ok(r.meta.every((m) => m.source === "both" && m.confidence === "high")); // xpath-strong matches
  assert.equal(r.droppedNoise, 2); // 5 hook clicks - 3 matched
});

test("reconcile matches by label when xpaths differ (agent targeted a child node)", () => {
  const clicks: ClickEvent[] = [
    { text: "Schedule an Appointment", role: "button", url: "u", xpath: "xpath=/html[1]/body[1]/button[1]" },
    { text: "Primary Care", role: "button", url: "u", xpath: "xpath=/html[1]/body[1]/button[2]" },
  ];
  // Agent xpaths point at inner <span>s; label overlap still aligns them.
  const agentActs = extractAgentActions([
    act("click the Schedule an Appointment option", "/html[1]/body[1]/button[1]/span[1]"),
    act("choose Primary Care", "/html[1]/body[1]/button[2]/span[1]"),
  ]);
  const r = reconcileClicks(clicks, agentActs);
  assert.equal(r.usedAgentStream, true);
  assert.equal(r.steps.length, 2);
  // xpath ancestor match is "strong"; child→parent prefix counts as identity.
  assert.equal(r.meta[0]!.confidence, "high");
});

test("a noise blob that a short agent label sits inside does NOT steal the match (B3)", () => {
  // No xpath on the agent act (label-only matching). A noise container whose text
  // is a token-superset of "Schedule an Appointment" precedes the real button. The
  // reconcile must bind to the real button, not the noise div — else it drops the
  // real control and freezes the wrong element's identity.
  const clicks: ClickEvent[] = [
    { text: "Schedule your appointment reminders and settings here now", url: "u", xpath: "xpath=/html[1]/body[1]/div[9]" }, // noise superset
    { text: "Schedule an Appointment", role: "button", url: "u", xpath: "xpath=/html[1]/body[1]/button[1]" }, // real
    { text: "Primary Care", role: "button", url: "u", xpath: "xpath=/html[1]/body[1]/button[2]" },
  ];
  const agentActs = extractAgentActions([
    { type: "act", action: "click Schedule an Appointment" }, // no playwrightArguments → label-only
    { type: "act", action: "click Primary Care" },
  ]);
  const r = reconcileClicks(clicks, agentActs);
  assert.equal(r.usedAgentStream, true);
  assert.equal(r.steps[0]!.text, "Schedule an Appointment"); // the real button, not the noise div
  assert.ok(!r.steps.some((s) => (s.text ?? "").includes("reminders")), "noise blob leaked into steps");
});

test("an agent click the hook missed becomes a heal-only step (no cached identity)", () => {
  const clicks: ClickEvent[] = [
    { text: "Schedule an Appointment", role: "button", url: "u", xpath: "xpath=/html[1]/body[1]/button[1]" },
    { text: "Primary Care", role: "button", url: "u", xpath: "xpath=/html[1]/body[1]/button[2]" },
  ];
  const agentActs = extractAgentActions([
    act("click Schedule an Appointment", "/html[1]/body[1]/button[1]"),
    act("press New Patient Adult Visit", "/html[1]/body[1]/button[9]", "New Patient Adult Visit"), // hook has no such click
    act("choose Primary Care", "/html[1]/body[1]/button[2]"),
  ]);
  const r = reconcileClicks(clicks, agentActs);
  const synth = r.meta.find((m) => m.source === "agent-only");
  assert.ok(synth, "expected an agent-only step");
  assert.equal(synth!.confidence, "low");
  // The synth step has no testid/id → compiler emits it semantic-only (engine heals it).
  const step = r.steps.find((s) => (s.text ?? "").includes("New Patient Adult Visit"))!;
  assert.equal(step.id ?? null, null);
  assert.equal(step.testid ?? null, null);
});

test("fills a container-blob hook label from the agent's concise intent", () => {
  const clicks: ClickEvent[] = [
    // Hook mis-captured a wrapping container: label is an 80-char blob (unusable).
    { text: "Back Primary Care Schedule with a New Provider New Patient Adult Visit (18 and o", role: "button", url: "u", xpath: "xpath=/html[1]/body[1]/div[3]" },
    { text: "Confirm details", role: "button", url: "u", xpath: "xpath=/html[1]/body[1]/button[7]" },
  ];
  const agentActs = extractAgentActions([
    act("click the New Patient Adult Visit option", "/html[1]/body[1]/div[3]", "New Patient Adult Visit"),
    act("click Confirm details", "/html[1]/body[1]/button[7]"),
  ]);
  const r = reconcileClicks(clicks, agentActs);
  assert.equal(r.usedAgentStream, true);
  // The blob was replaced by the agent's concise element description.
  assert.equal(r.steps[0]!.text, "New Patient Adult Visit");
  assert.equal(r.steps[0]!.ariaLabel, null);
});

test("falls back to the DOM-hook path when the agent stream is thin (<2 clicks)", () => {
  const clicks: ClickEvent[] = [
    { text: "Schedule an Appointment", role: "button", url: "u" },
    { text: "Primary Care", role: "button", url: "u" },
  ];
  const r = reconcileClicks(clicks, extractAgentActions([act("click Schedule", "/html[1]/button[1]")]));
  assert.equal(r.usedAgentStream, false);
  assert.equal(r.steps, clicks); // unchanged reference — pure passthrough
});

test("falls back when a populated hook stream doesn't correlate at all", () => {
  const clicks: ClickEvent[] = [
    { text: "Completely Unrelated Alpha", role: "button", url: "u", xpath: "xpath=/a[1]" },
    { text: "Completely Unrelated Beta", role: "button", url: "u", xpath: "xpath=/b[1]" },
  ];
  const agentActs = extractAgentActions([
    act("click Zeta control", "/z[1]"),
    act("click Omega control", "/o[1]"),
  ]);
  const r = reconcileClicks(clicks, agentActs);
  assert.equal(r.usedAgentStream, false); // matched === 0 with non-empty hooks → defer
});

test("conciseLabel strips leading verbs/articles and trailing control-nouns", () => {
  assert.equal(conciseLabel("click the New Patient Adult Visit option"), "New Patient Adult Visit");
  assert.equal(conciseLabel("Select Primary Care button"), "Primary Care");
  assert.equal(conciseLabel("Schedule an Appointment"), "Schedule an Appointment");
});

test("conciseLabel peels LLM description scaffolding into a matchable label (the real URMC failures)", () => {
  // These are the exact agent descriptions that compiled into unmatchable names.
  // After cleaning, each must be a substring of the element's real visible text.
  assert.equal(
    conciseLabel("Primary Care button, includes adult, pediatric, and geriatric care"),
    "Primary Care includes adult, pediatric, and geriatric care",
  );
  assert.equal(
    conciseLabel("Button for scheduling a New Patient Adult Visit (18 and over) - Primary"),
    "New Patient Adult Visit (18 and over) - Primary",
  );
  assert.equal(
    conciseLabel("button: Southview Internal Medicine 995 Senator Keating Blvd, Ste 200 Cl"),
    "Southview Internal Medicine 995 Senator Keating Blvd, Ste 200 Cl",
  );
  assert.equal(conciseLabel("Continue button at the bottom of the locations step"), "Continue");
});

test("END-TO-END: noisy hooks + agent stream → the compiled flow follows the SOP and stops at the slot screen", () => {
  // Exactly what authorFlow composes: reconcile → replayableClicks → stopAtEphemeralSlot
  // → compileRecording. The hook captured noise + an ephemeral date; the agent
  // stream is the 3 real steps then the date. The YAML must contain ONLY the 3
  // real act steps (+ intercept/navigate/wait), never the noise or the date.
  const clicks: ClickEvent[] = [
    { text: "Your mobile phone number has been changed to 585-503-9535. We need to verify tha", url: "u", xpath: "xpath=/html[1]/body[1]/div[9]" },
    { text: "Schedule an Appointment", role: "button", url: "u", xpath: "xpath=/html[1]/body[1]/button[1]" },
    { text: "MyChart Security Reminder: Protect Your Health Information Protecting your perso", url: "u", xpath: "xpath=/html[1]/body[1]/div[12]" },
    { text: "Primary Care Includes adult, pediatric, and geriatric care", role: "button", url: "u", xpath: "xpath=/html[1]/body[1]/button[2]" },
    { text: "New Patient Adult Visit (18 and over) - Primary Care", role: "button", url: "u", xpath: "xpath=/html[1]/body[1]/button[3]" },
    { text: "Monday", role: "button", url: "u", xpath: "xpath=/html[1]/body[1]/button[4]" }, // ephemeral
    { text: "Next", role: "button", url: "u", xpath: "xpath=/html[1]/body[1]/button[5]" },
  ];
  const agentActs = extractAgentActions([
    { type: "act", action: "click Schedule an Appointment", playwrightArguments: { selector: "xpath=/html[1]/body[1]/button[1]", description: "Schedule an Appointment", method: "click" } },
    { type: "act", action: "click Primary Care", playwrightArguments: { selector: "xpath=/html[1]/body[1]/button[2]", description: "Primary Care", method: "click" } },
    { type: "act", action: "click New Patient Adult Visit", playwrightArguments: { selector: "xpath=/html[1]/body[1]/button[3]", description: "New Patient Adult Visit", method: "click" } },
    { type: "act", action: "click Monday", playwrightArguments: { selector: "xpath=/html[1]/body[1]/button[4]", description: "Monday", method: "click" } },
    { type: "act", action: "click Next", playwrightArguments: { selector: "xpath=/html[1]/body[1]/button[5]", description: "Next", method: "click" } },
  ]);

  const reconcile = reconcileClicks(clicks, agentActs);
  assert.equal(reconcile.usedAgentStream, true);
  const { clicks: replay, truncated } = stopAtEphemeralSlot(replayableClicks(reconcile.steps));
  assert.equal(truncated, true); // stopped at "Monday"

  const flow = compileRecording(
    {
      baseUrl: "https://mychart.urmc.rochester.edu/MyChart/Home",
      clicks: replay,
      network: [
        { method: "GET", url: "https://mychart.urmc.rochester.edu/MyChart/Scheduling/GetOpenSlots", resourceType: "fetch", status: 200, contentType: "application/json", responseBodyPreview: '{"Slots":[{"DisplayDateTimeUtc":"2026-08-01T14:00:00Z"}]}', responseBodyBytes: 900 },
      ],
    },
    { key: "schedule-consult", emitSelect: false },
  );

  const acts = flow.steps.filter((s) => s.type === "act").map((s) => s.label ?? "");
  assert.deepEqual(acts, [
    'Click "Schedule an Appointment"',
    'Click "Primary Care Includes adult, pediatric, and geriatric care"',
    'Click "New Patient Adult Visit (18 and over) - Primary Care"',
  ]);
  // No noise, no ephemeral date survived into the flow.
  const all = JSON.stringify(flow.steps);
  assert.ok(!all.includes("mobile phone number"), "phone-verify noise leaked");
  assert.ok(!all.includes("Security Reminder"), "security banner noise leaked");
  assert.ok(!/\bMonday\b/.test(all), "ephemeral date leaked");
  assert.ok(!/"Next"/.test(all), "post-date Next leaked");
  // Still harvests the slot data.
  assert.ok(flow.steps.some((s) => s.type === "intercept"));
  assert.ok(flow.steps.some((s) => s.type === "wait"));
});
