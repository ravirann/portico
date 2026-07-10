/**
 * FIXTURE A — clean / ideal capture.
 *
 * The DOM hook fired exactly once per real control, one-to-one with the
 * agent's four deliberate clicks through a generic multi-step scheduling
 * wizard, with exact-xpath correlation and no container blobs or untouched
 * noise at all. This is the baseline a correct reconciliation must reproduce
 * with zero loss — the eval's control group alongside `blob-noise-wizard.ts`.
 */
import type { ClickEvent } from "@portico/flow-spec";
import type { CaptureFixture } from "../score.js";

const XP = {
  schedule: "/html[1]/body[1]/div[3]/div[1]/main[1]/section[1]/div[1]/button[1]",
  primaryCare: "/html[1]/body[1]/div[3]/div[1]/main[1]/section[2]/ul[1]/li[1]/div[1]/button[1]",
  newPatient: "/html[1]/body[1]/div[3]/div[1]/main[1]/section[2]/ul[1]/li[2]/div[1]/button[1]",
  continue_: "/html[1]/body[1]/div[3]/div[1]/main[1]/footer[1]/div[1]/button[1]",
};

const BASE_URL = "https://portal.example-clinic.test";

const rawClicks: ClickEvent[] = [
  { tag: "BUTTON", role: "button", text: "Schedule an Appointment", url: `${BASE_URL}/home`, xpath: `xpath=${XP.schedule}` },
  {
    tag: "BUTTON",
    role: "button",
    text: "Primary Care Includes adult, pediatric, and geriatric care",
    url: `${BASE_URL}/scheduling`,
    xpath: `xpath=${XP.primaryCare}`,
  },
  {
    tag: "BUTTON",
    role: "button",
    text: "New Patient Adult Visit (18 and over) - Primary Care",
    url: `${BASE_URL}/scheduling`,
    xpath: `xpath=${XP.newPatient}`,
  },
  { tag: "BUTTON", role: "button", text: "Continue", url: `${BASE_URL}/scheduling/locations`, xpath: `xpath=${XP.continue_}` },
];

/** A raw `AgentResult.actions` entry as Stagehand emits it in hybrid/dom mode. */
function act(action: string, xpath: string, description: string) {
  return {
    type: "act",
    reasoning: "working toward the scheduling goal",
    action,
    playwrightArguments: { selector: `xpath=${xpath}`, description, method: "click" },
  };
}

const agentActions: unknown[] = [
  act("click Schedule an Appointment", XP.schedule, "Schedule an Appointment"),
  act("click Primary Care", XP.primaryCare, "Primary Care appointment category"),
  act("click New Patient Adult Visit", XP.newPatient, "Button for New Patient Adult Visit (18 and over) - Primary Care"),
  act("click Continue", XP.continue_, "Continue button at the bottom of the locations step"),
];

export const cleanWizardFixture: CaptureFixture = {
  name: "clean-wizard",
  description: "Ideal capture: one hook click per real control, exact-xpath agent correlation, no noise.",
  rawClicks,
  agentActions,
  expectedNames: [
    "Schedule an Appointment",
    "Primary Care Includes adult, pediatric, and geriatric care",
    "New Patient Adult Visit (18 and over) - Primary Care",
    "Continue",
  ],
};
