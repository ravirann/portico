/**
 * @portico/flow-spec — sector profiles: named bundles of reliability
 * defaults (readiness gates, timeouts, retries, locator policy, mutation
 * guards, authoring hints) keyed by industry/app-class.
 *
 * Today the engine hardcodes one style of app's timing/locator/guard
 * behavior (see `generic` below, which reproduces those exact numbers). A
 * `Target` (or, as an authoring-time fallback, a `Flow`) can stamp a
 * `SectorKey` so the engine and author packages pick reliability defaults
 * suited to that industry instead.
 *
 * Zero imports, zero runtime dependencies — pure data + pure functions —
 * so this module stays trivially consumable from the engine, the author
 * package, and any future CLI/UI.
 */

export type SectorKey =
  | "healthcare"
  | "communications"
  | "finance"
  | "government"
  | "commerce"
  | "saas_ops"
  | "generic";

/** A named bundle of reliability defaults for one industry/app-class. */
export interface SectorProfile {
  key: SectorKey;
  name: string; // human label
  description: string; // one line: what apps this covers
  appShape: string; // one line: typical DOM/runtime characteristics
  readiness: {
    navigateQuietMs: number; // MutationObserver quiet window after navigate
    navigateTimeoutMs: number; // hard ceiling for the quiet gate after navigate
    actQuietMs: number; // quiet window after a click-type act
    actTimeoutMs: number; // hard ceiling for the quiet gate after act
  };
  timing: {
    stepTimeoutMs: number; // default hard ceiling for act steps
    navTimeoutMs: number; // default navigation timeout
    extractTimeoutMs: number; // default extract wait
    apiTimeoutMs: number; // default api-tier request ceiling
    readTimeoutMs: number; // default page-evaluate ceiling
    actionDelayMs: number; // pacing pause between steps (0 = none)
  };
  retry: {
    navigateMax: number;
    actMax: number;
    extractMax: number;
    apiIdempotentMax: number; // retries for GET/HEAD/OPTIONS api steps ONLY; mutations are never auto-retried
    backoffMs: number;
  };
  locator: {
    cssCacheTrusted: boolean; // false → engine skips locator.cached (obfuscated/rotating class names)
    preferKeyboard: boolean; // authoring hint: app is keyboard-first
  };
  guards: {
    dryRunDefaultForWrites: boolean; // authoring stamps guard.dry_run_only on write-intent flows
    mutationKeywords: string[]; // act labels matching any keyword are SKIPPED when run mode is dry_run
    forbiddenInValidation: string[]; // act labels matching are blocked whenever mode !== "live"
  };
  authoring: {
    noisePatterns: string[]; // regex sources ADDED to the author's base network-noise filters
    authPattern: "localStorage" | "cookie-session" | "either"; // how the app carries auth; gates localStorage header-chaining discovery
    vocabulary: string; // domain vocabulary block injected into the authoring rewriter prompt ("" = none)
  };
  compliance: {
    redactStrict: boolean; // artifacts/traces get strict PII redaction posture
    notes: string; // one-line compliance posture note
  };
}

export const SECTOR_PROFILES: Record<SectorKey, SectorProfile> = {
  generic: {
    key: "generic",
    name: "Generic",
    description: "Fallback profile reproducing the engine's historical defaults.",
    appShape: "Conventional single-frame web app with stable DOM ids/roles.",
    // No-regression contract: these readiness/timing/retry numbers must equal
    // the engine's current hardcoded defaults (navigate quiet 500ms, ceiling
    // 8s; act quiet 300ms, ceiling 3s; act step timeout 15s; navigate 60s;
    // extract 10s; act/navigate retry max 1; extract retry max 2; backoff
    // 500ms) so a Target/Flow with no sector set behaves exactly as today.
    readiness: { navigateQuietMs: 500, navigateTimeoutMs: 8000, actQuietMs: 300, actTimeoutMs: 3000 },
    timing: {
      stepTimeoutMs: 15000,
      navTimeoutMs: 60000,
      extractTimeoutMs: 10000,
      apiTimeoutMs: 30000,
      readTimeoutMs: 15000,
      actionDelayMs: 0,
    },
    retry: { navigateMax: 1, actMax: 1, extractMax: 2, apiIdempotentMax: 1, backoffMs: 500 },
    locator: { cssCacheTrusted: true, preferKeyboard: false },
    guards: {
      dryRunDefaultForWrites: false,
      mutationKeywords: ["delete", "remove", "pay", "purchase", "send", "submit", "book", "confirm", "transfer"],
      forbiddenInValidation: [],
    },
    authoring: { noisePatterns: [], authPattern: "either", vocabulary: "" },
    compliance: { redactStrict: false, notes: "No sector-specific posture; secrets are always redacted." },
  },

  healthcare: {
    key: "healthcare",
    name: "Healthcare",
    description: "EHR, payer and clinical scheduling portals (Epic/MyChart, Availity-class).",
    appShape: "Slow server backends, cookie-session auth, good ARIA (ADA), aggressive session expiry.",
    readiness: { navigateQuietMs: 700, navigateTimeoutMs: 15000, actQuietMs: 400, actTimeoutMs: 6000 },
    timing: {
      stepTimeoutMs: 20000,
      navTimeoutMs: 90000,
      extractTimeoutMs: 15000,
      apiTimeoutMs: 45000,
      readTimeoutMs: 15000,
      actionDelayMs: 250,
    },
    retry: { navigateMax: 2, actMax: 1, extractMax: 2, apiIdempotentMax: 2, backoffMs: 1000 },
    locator: { cssCacheTrusted: true, preferKeyboard: false },
    guards: {
      dryRunDefaultForWrites: true,
      mutationKeywords: ["book", "schedule", "submit", "sign", "order", "prescribe", "pay", "cancel appointment"],
      forbiddenInValidation: ["book appointment", "confirm appointment", "submit claim", "e-sign"],
    },
    authoring: {
      noisePatterns: [],
      authPattern: "cookie-session",
      vocabulary:
        "Healthcare portal terms: patient/member, MRN, encounter, visit, claim, prior authorization, eligibility, provider, appointment slot. Treat all patient-identifying values as parameters, never literals.",
    },
    compliance: {
      redactStrict: true,
      notes: "PHI: strict redaction; BAA-covered model routes only; never relay SMS 2FA.",
    },
  },

  communications: {
    key: "communications",
    name: "Communications",
    description: "Email, chat and calendar web clients (Gmail, Outlook Web, Slack).",
    appShape:
      "Extremely dynamic virtualized DOM, obfuscated CSS classes, keyboard-first affordances, contenteditable compose surfaces, iframes.",
    // Mutation-heavy UIs need a longer quiet window to settle.
    readiness: { navigateQuietMs: 800, navigateTimeoutMs: 12000, actQuietMs: 500, actTimeoutMs: 5000 },
    timing: {
      stepTimeoutMs: 20000,
      navTimeoutMs: 60000,
      extractTimeoutMs: 12000,
      apiTimeoutMs: 30000,
      readTimeoutMs: 15000,
      actionDelayMs: 150,
    },
    // Virtual-list re-renders detach elements mid-action; one extra act retry absorbs that.
    retry: { navigateMax: 2, actMax: 2, extractMax: 2, apiIdempotentMax: 1, backoffMs: 700 },
    locator: {
      // Class names are build-artifacts that rot between deploys; role/name only.
      cssCacheTrusted: false,
      preferKeyboard: true,
    },
    guards: {
      dryRunDefaultForWrites: true,
      mutationKeywords: ["send", "reply", "forward", "delete", "archive", "report spam", "unsubscribe", "discard"],
      forbiddenInValidation: ["send", "reply all", "forward"],
    },
    authoring: {
      noisePatterns: ["logImpressions", "cloudsearch", "hangouts", "chat/v", "notifications/v", "play\\.google"],
      authPattern: "cookie-session",
      vocabulary:
        "Mailbox terms: thread, message, label, folder, draft, compose, recipient, subject, snippet, archive. Prefer keyboard shortcuts where the app documents them. Never send: compose flows stop at a saved draft.",
    },
    compliance: {
      redactStrict: true,
      notes: "Message bodies are personal data: strict redaction of extracted content.",
    },
  },

  finance: {
    key: "finance",
    name: "Finance",
    description: "Banking, insurance and brokerage portals.",
    appShape: "Session-expiry aggressive, anti-automation sensitive, payment widgets in iframes, mandatory 2FA.",
    readiness: { navigateQuietMs: 700, navigateTimeoutMs: 15000, actQuietMs: 400, actTimeoutMs: 6000 },
    // Deliberate pacing — bursty input trips bot heuristics.
    timing: {
      stepTimeoutMs: 25000,
      navTimeoutMs: 90000,
      extractTimeoutMs: 15000,
      apiTimeoutMs: 45000,
      readTimeoutMs: 15000,
      actionDelayMs: 400,
    },
    // Minimal retries — duplicate submission risk outweighs transient recovery.
    retry: { navigateMax: 1, actMax: 1, extractMax: 2, apiIdempotentMax: 1, backoffMs: 1500 },
    locator: { cssCacheTrusted: true, preferKeyboard: false },
    guards: {
      dryRunDefaultForWrites: true,
      mutationKeywords: ["transfer", "pay", "send money", "wire", "trade", "buy", "sell", "authorize", "approve"],
      forbiddenInValidation: ["transfer", "payment", "wire", "trade"],
    },
    authoring: {
      noisePatterns: [],
      authPattern: "cookie-session",
      vocabulary:
        "Financial portal terms: account, statement, transaction, transfer, payee, beneficiary, settlement. Card/account numbers are secrets — parameterize and redact; never persist full PANs.",
    },
    compliance: {
      redactStrict: true,
      notes: "Never store card/account numbers in artifacts; idempotency check before any money movement.",
    },
  },

  government: {
    key: "government",
    name: "Government",
    description: "Civic, tax, permits and case-management portals.",
    appShape:
      "Legacy server-rendered MPAs, framesets, queue/wait interstitials, meta-refresh, CAPTCHAs, business-hours availability.",
    // Interstitial queue pages settle slowly.
    readiness: { navigateQuietMs: 900, navigateTimeoutMs: 20000, actQuietMs: 500, actTimeoutMs: 8000 },
    timing: {
      stepTimeoutMs: 30000,
      navTimeoutMs: 120000,
      extractTimeoutMs: 20000,
      apiTimeoutMs: 60000,
      readTimeoutMs: 20000,
      actionDelayMs: 500,
    },
    retry: { navigateMax: 2, actMax: 1, extractMax: 2, apiIdempotentMax: 2, backoffMs: 2000 },
    locator: { cssCacheTrusted: true, preferKeyboard: false },
    guards: {
      dryRunDefaultForWrites: true,
      mutationKeywords: ["submit", "file", "pay", "apply", "certify"],
      forbiddenInValidation: ["submit application", "pay fee", "certify"],
    },
    authoring: {
      noisePatterns: [],
      authPattern: "cookie-session",
      vocabulary:
        "Civic portal terms: application, case number, docket, permit, filing, fee, status. Expect CAPTCHAs and human handoff; flows must tolerate very slow responses.",
    },
    compliance: {
      redactStrict: true,
      notes: "Public-sector rate limits: keep pacing conservative; respect posted business hours.",
    },
  },

  commerce: {
    key: "commerce",
    name: "Commerce",
    description: "E-commerce and logistics back-offices (Shopify-admin-class, seller/courier portals).",
    appShape: "Modern SPA with JSON APIs, virtualized tables, bulk-action UIs.",
    readiness: { navigateQuietMs: 500, navigateTimeoutMs: 10000, actQuietMs: 300, actTimeoutMs: 4000 },
    timing: {
      stepTimeoutMs: 15000,
      navTimeoutMs: 60000,
      extractTimeoutMs: 10000,
      apiTimeoutMs: 30000,
      readTimeoutMs: 15000,
      actionDelayMs: 100,
    },
    retry: { navigateMax: 2, actMax: 2, extractMax: 2, apiIdempotentMax: 2, backoffMs: 500 },
    locator: { cssCacheTrusted: true, preferKeyboard: false },
    guards: {
      dryRunDefaultForWrites: true,
      mutationKeywords: ["refund", "charge", "fulfill", "cancel order", "delete", "void"],
      forbiddenInValidation: ["refund", "charge", "void"],
    },
    authoring: {
      noisePatterns: [],
      authPattern: "either",
      vocabulary:
        "Commerce terms: order, SKU, fulfillment, inventory, shipment, refund, listing. Prefer API-tier harvest (intercept) over DOM scraping for tabular data.",
    },
    compliance: { redactStrict: false, notes: "Customer PII in orders: redact contact fields in artifacts." },
  },

  saas_ops: {
    key: "saas_ops",
    name: "SaaS Ops",
    description: "Internal CRM/support/ops tools (Zendesk-class, custom ops consoles).",
    appShape: "SPA with localStorage bearer auth and JSON APIs; third-party integration beacons in traffic.",
    readiness: { navigateQuietMs: 500, navigateTimeoutMs: 8000, actQuietMs: 300, actTimeoutMs: 3000 },
    timing: {
      stepTimeoutMs: 15000,
      navTimeoutMs: 60000,
      extractTimeoutMs: 10000,
      apiTimeoutMs: 30000,
      readTimeoutMs: 15000,
      actionDelayMs: 0,
    },
    retry: { navigateMax: 1, actMax: 1, extractMax: 2, apiIdempotentMax: 1, backoffMs: 500 },
    locator: { cssCacheTrusted: true, preferKeyboard: false },
    guards: {
      dryRunDefaultForWrites: true,
      mutationKeywords: ["update", "save", "delete", "assign", "close ticket", "merge"],
      forbiddenInValidation: [],
    },
    authoring: {
      // Integration beacons observed in real ops tools; previously hardcoded in packages/author.
      noisePatterns: ["kaleyra", "zoko", "whatsapp", "freshdesk", "n8n"],
      authPattern: "localStorage",
      vocabulary:
        "Ops tool terms: ticket, customer, assignee, queue, status, note, tag. IDs chained from lookup responses are step outputs, not inputs.",
    },
    compliance: { redactStrict: true, notes: "Customer PII throughout: strict redaction." },
  },
};

/** Resolve a sector key (possibly undefined/unknown) to a profile; falls back to generic. */
export function resolveSectorProfile(key?: string | null): SectorProfile {
  if (key && Object.prototype.hasOwnProperty.call(SECTOR_PROFILES, key)) {
    return SECTOR_PROFILES[key as SectorKey];
  }
  return SECTOR_PROFILES.generic;
}

/** All sector keys, for CLIs/UIs. */
export function listSectors(): SectorKey[] {
  return Object.keys(SECTOR_PROFILES) as SectorKey[];
}
