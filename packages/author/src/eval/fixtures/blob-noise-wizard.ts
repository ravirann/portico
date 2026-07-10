/**
 * FIXTURE B — blob + noise capture (the live authoring bug, reproduced).
 *
 * Same generic scheduling wizard as `clean-wizard.ts`, but this time each real
 * control's DOM click hook fired TWICE:
 *   - once on the exact node — a clean, short accessible name and a deep xpath,
 *   - once mis-resolved to a page-level container — `/html[1]` (page root) or
 *     the `<main>` landmark (`id="main"`), whose captured text is a long
 *     concatenation of unrelated sibling text.
 * The agent's own resolved xpath EQUALS the clean node's xpath in every case,
 * never the blob's. One wholly untouched notification click (the agent never
 * intended it at all) is mixed in too.
 *
 * A correct reconciliation must:
 *   - land on the four clean names only (never a blob's text),
 *   - never cache a step's identity to the generic `main` container id,
 *   - drop all five noise clicks (4 blobs + 1 untouched notification).
 *
 * The last step ("Continue") deliberately omits `playwrightArguments` on its
 * agent action, so it correlates via label-only matching (medium confidence)
 * instead of exact xpath — exercising that path without giving the noise a
 * chance to steal it (the blob's label is far past the 72-char match ceiling).
 */
import type { ClickEvent } from "@portico/flow-spec";
import type { CaptureFixture } from "../score.js";

// The page-level <main> landmark: depth 5. Every real control sits 4-5 levels
// further down — well outside the reconciler's "close-ancestor" window (which
// only bridges a FEW levels) — so this container can only ever bind via an
// EXACT xpath match, never as a fuzzy ancestor. It must lose to the clean node.
const MAIN = "/html[1]/body[1]/div[4]/div[1]/main[1]";

const XP = {
  schedule: `${MAIN}/section[1]/div[1]/div[1]/button[1]`,
  primaryCare: `${MAIN}/section[2]/ul[1]/li[1]/div[1]/button[1]`,
  newPatient: `${MAIN}/section[2]/ul[1]/li[2]/div[1]/button[1]`,
  continue_: `${MAIN}/footer[1]/div[1]/div[1]/button[1]`,
};

const BASE_URL = "https://portal.example-clinic.test";

const rawClicks: ClickEvent[] = [
  // Blob mis-capture for "Schedule an Appointment": a shallow page-root hit
  // whose text concatenates the whole nav bar.
  {
    text: "Skip to main content Home Visits Appointments Billing Schedule an Appointment Notifications 2 new",
    url: `${BASE_URL}/home`,
    xpath: "xpath=/html[1]",
  },
  // The clean node — the agent's xpath equals this exactly.
  { tag: "BUTTON", role: "button", text: "Schedule an Appointment", url: `${BASE_URL}/home`, xpath: `xpath=${XP.schedule}` },
  // Wholly untouched notification the agent never intended — pure noise, not
  // paired with any control.
  {
    tag: "BUTTON",
    role: "button",
    text: "You have 2 new lab results ready to view",
    url: `${BASE_URL}/home`,
    xpath: `xpath=${MAIN}/aside[1]/div[1]/button[1]`,
  },
  // Blob mis-capture for "Primary Care": the <main> container itself,
  // id="main", text concatenated from several sibling controls.
  {
    id: "main",
    text: "Back Choose a reason Primary Care Includes adult pediatric and geriatric care New Patient Adult Visit Continue",
    url: `${BASE_URL}/scheduling`,
    xpath: `xpath=${MAIN}`,
  },
  {
    tag: "BUTTON",
    role: "button",
    text: "Primary Care Includes adult, pediatric, and geriatric care",
    url: `${BASE_URL}/scheduling`,
    xpath: `xpath=${XP.primaryCare}`,
  },
  // Blob mis-capture for "New Patient Adult Visit": shallow page-root again.
  {
    text: "Skip to main content Choose a reason Primary Care New Patient Adult Visit 18 and over Continue Back",
    url: `${BASE_URL}/scheduling`,
    xpath: "xpath=/html[1]",
  },
  {
    tag: "BUTTON",
    role: "button",
    text: "New Patient Adult Visit (18 and over) - Primary Care",
    url: `${BASE_URL}/scheduling`,
    xpath: `xpath=${XP.newPatient}`,
  },
  // Blob mis-capture for "Continue": the <main> container again.
  {
    id: "main",
    text: "Back Primary Care New Patient Adult Visit 18 and over Primary Care Continue Confirm your selections",
    url: `${BASE_URL}/scheduling/locations`,
    xpath: `xpath=${MAIN}`,
  },
  { tag: "BUTTON", role: "button", text: "Continue", url: `${BASE_URL}/scheduling/locations`, xpath: `xpath=${XP.continue_}` },
];

/** A raw `AgentResult.actions` entry as Stagehand emits it in hybrid/dom mode.
 *  `xpath` omitted ⇒ no `playwrightArguments` (the agent didn't resolve a
 *  selector for this action — label-only correlation). */
function act(action: string, xpath?: string, description?: string) {
  return {
    type: "act",
    reasoning: "working toward the scheduling goal",
    action,
    ...(xpath ? { playwrightArguments: { selector: `xpath=${xpath}`, description: description ?? action, method: "click" } } : {}),
  };
}

const agentActions: unknown[] = [
  act("click Schedule an Appointment", XP.schedule, "Schedule an Appointment"),
  act("click Primary Care", XP.primaryCare, "Primary Care button, includes adult, pediatric, and geriatric care"),
  act("click New Patient Adult Visit", XP.newPatient, "Button for scheduling a New Patient Adult Visit (18 and over) - Primary"),
  act("click Continue"), // no resolved xpath — must still land on the clean node via label match
];

export const blobNoiseWizardFixture: CaptureFixture = {
  name: "blob-noise-wizard",
  description: "Reproduces the live bug: each control double-fires (clean node + container/root blob) plus one untouched notification click.",
  rawClicks,
  agentActions,
  expectedNames: [
    "Schedule an Appointment",
    "Primary Care Includes adult, pediatric, and geriatric care",
    "New Patient Adult Visit (18 and over) - Primary Care",
    "Continue",
  ],
};
