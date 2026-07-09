/**
 * Tests for the action-capture decision and that the captured click sequence
 * compiles into an ACTION-REPLAY flow — the fix for "validated but didn't follow
 * the SOP". `meaningfulClickCount` decides when the agent drove a real multi-step
 * wizard (→ replay the clicks) vs. a single navigate+harvest.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRecording, type ClickEvent, type Recording } from "@portico/flow-spec";
import { replayableClicks, isEphemeralSlotLabel, stopAtEphemeralSlot } from "./index.js";

test("isEphemeralSlotLabel flags dates/weekdays/times, not real controls", () => {
  for (const l of ["Monday", "October 12", "8:00 AM", "3:30pm", "3/15", "3/15/2026", "Oct 12", "Monday, October 12, 2026"]) {
    assert.equal(isEphemeralSlotLabel(l), true, `expected ephemeral: ${l}`);
  }
  for (const l of ["Schedule an Appointment", "Primary Care", "New Patient Adult Visit (18 and over) - Primary Care", "Next", "May", "Save"]) {
    assert.equal(isEphemeralSlotLabel(l), false, `expected NOT ephemeral: ${l}`);
  }
});

test("isEphemeralSlotLabel does NOT truncate at names that merely contain a month/weekday", () => {
  // Provider / department / insurer names routinely embed a month or weekday word.
  // These are real controls the SOP must click — not date-picker cells.
  for (const l of ["Dr. April Johnson", "June Health Clinic", "Friday Health Plans", "March Endocrinology", "Dr. August Meyer"]) {
    assert.equal(isEphemeralSlotLabel(l), false, `name wrongly flagged ephemeral: ${l}`);
  }
});

test("stopAtEphemeralSlot truncates the wizard at the first date/time click (the URMC case)", () => {
  const clicks: ClickEvent[] = [
    { text: "Schedule an Appointment", role: "link", url: "u" },
    { text: "Primary Care Includes adult, pediatric, and geriatric care", role: "button", url: "u" },
    { text: "New Patient Adult Visit (18 and over) - Primary Care", role: "button", url: "u" },
    { text: "Monday", name: "Monday", url: "u" }, // ephemeral date → stop here
    { text: "Next", role: "button", url: "u" }, // depends on the date → dropped
  ];
  const { clicks: kept, truncated } = stopAtEphemeralSlot(clicks);
  assert.equal(truncated, true);
  assert.deepEqual(kept.map((c) => c.text), [
    "Schedule an Appointment",
    "Primary Care Includes adult, pediatric, and geriatric care",
    "New Patient Adult Visit (18 and over) - Primary Care",
  ]);
});

test("stopAtEphemeralSlot leaves a date-free sequence intact", () => {
  const clicks: ClickEvent[] = [
    { text: "Search", role: "button", url: "u" },
    { text: "Claim 4305", role: "link", url: "u" },
  ];
  const { clicks: kept, truncated } = stopAtEphemeralSlot(clicks);
  assert.equal(truncated, false);
  assert.equal(kept.length, 2);
});

test("replayableClicks keeps concise controls (incl. Continue), drops login/blank clicks", () => {
  const clicks: ClickEvent[] = [
    { text: "MyChart Username", name: "Login", url: "u" }, // login field → excluded
    { text: "Continue to Scheduling", url: "u" }, // real wizard step → KEPT (not a login token)
    { text: "Schedule an Appointment", role: "button", url: "u" },
    { text: "Primary Care Includes adult, pediatric, and geriatric care", role: "button", url: "u" },
    { text: "", url: "u" }, // no label → excluded
    { text: "New Patient Adult Visit (18 and over) - Primary Care", role: "button", url: "u" },
  ];
  assert.deepEqual(
    replayableClicks(clicks).map((c) => c.text),
    ["Continue to Scheduling", "Schedule an Appointment", "Primary Care Includes adult, pediatric, and geriatric care", "New Patient Adult Visit (18 and over) - Primary Care"],
  );
});

test("replayableClicks drops container / notification blobs (the real URMC noise)", () => {
  // The exact noise from the live run: dashboard cards and container mis-captures,
  // all 75+ chars. They must not survive, or their act steps fail on replay.
  const clicks: ClickEvent[] = [
    { text: "Your mobile phone number has been changed to 585-503-9535. We need to verify tha", url: "u" },
    { text: "MyChart Security Reminder: Protect Your Health Information Protecting your perso", url: "u" },
    { text: "Schedule an Appointment", role: "button", url: "u" },
    { text: "Skip navigation to main content S Schedule an Appointment Tell us why you're com", url: "u" },
    { text: "Back Primary Care Schedule with a New Provider New Patient Adult Visit (18 and o", id: "main", url: "u" },
    { text: "Primary Care Includes adult, pediatric, and geriatric care", role: "button", url: "u" },
  ];
  assert.deepEqual(
    replayableClicks(clicks).map((c) => c.text),
    ["Schedule an Appointment", "Primary Care Includes adult, pediatric, and geriatric care"],
  );
});

test("a single (or zero) interaction does NOT trigger action-replay", () => {
  assert.equal(replayableClicks([]).length, 0);
  assert.equal(replayableClicks([{ text: "Open", role: "button", url: "u" }]).length, 1);
});

test("captured wizard clicks compile into an action-replay flow that replays the SOP", () => {
  // Simulates what authorFlow captures for the URMC scheduling SOP: the click
  // sequence plus the scheduling data response. The compiled flow must contain
  // the `act` steps (the SOP), not just navigate+wait.
  const rec: Recording = {
    baseUrl: "https://mychart.urmc.rochester.edu/MyChart/Home",
    clicks: [
      { tag: "BUTTON", role: "button", text: "Schedule an Appointment", url: "…/Home" },
      { tag: "BUTTON", role: "button", text: "Primary Care", url: "…/Scheduling" },
      { tag: "BUTTON", role: "button", text: "New Patient Adult Visit", url: "…/Scheduling" },
    ],
    network: [
      {
        method: "GET",
        url: "https://mychart.urmc.rochester.edu/MyChart/Scheduling/GetOpenSlots",
        resourceType: "fetch",
        status: 200,
        contentType: "application/json",
        responseBodyPreview: '{"Solutions":[{"Slots":[{"DisplayDateTimeUtc":"2026-08-01T14:00:00Z"}]}]}',
        responseBodyBytes: 900,
      },
    ],
  };
  const flow = compileRecording(rec, { key: "urmc-consult-scheduling" });
  const acts = flow.steps.filter((s) => s.type === "act");
  // The SOP interactions are frozen as act steps (the whole point).
  assert.ok(acts.length >= 2, `expected the wizard clicks as act steps, got ${acts.length}`);
  // And it still starts by navigating to the authenticated entry, not a bare root.
  const nav = flow.steps.find((s) => s.type === "navigate");
  assert.ok(nav && /MyChart\/Home$/.test(nav.url ?? ""));
  // And it harvests + waits on the scheduling data (the end-state product).
  assert.ok(flow.steps.some((s) => s.type === "intercept"));
  assert.ok(flow.steps.some((s) => s.type === "wait"));
});
