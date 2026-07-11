# Reliability & sector-aware execution

Status: **Phase 5 workstream — first wave landed.** This document records the
reliability audit that motivated the phase, the design that came out of it, and
the boundary between what is implemented now and what is planned.

## Why this phase exists

Portico's deterministic-first architecture (API → DOM → heal) was validated
against one style of application: conventional session portals with stable DOM
ids, real ARIA roles, and clean JSON APIs (Epic/MyChart-class, internal ops
consoles). An audit of the engine, authoring pipeline, and orchestration layer
found that both the *failure handling* and the *application model* were
implicitly scoped to that style:

**Silent-failure paths (fixed in this wave)**

- `mode: "dry_run"` only gated API-tier mutations; DOM clicks and fills always
  executed, and `guard.dry_run_only` was parsed but never enforced at runtime —
  "validating" a write flow could mutate production data.
- A deployment with no extract model configured silently stored `page.title()`
  under the real output key with `status: "ok"`.
- `Target.allowed_domains` was documented as a hard egress boundary but never
  read by any code.
- `assert`/`guard` conditions other than `page_loaded` unconditionally passed.
- `api`, `read`, `intercept`, and `wait` steps had no timeout or retry envelope;
  a `read` could hang a run forever, and abort signals were only checked
  between steps.
- Step failures collapsed to a single string; `resumable` was hardcoded `true`;
  the queue worker recorded human-in-the-loop pauses as `failed`.

**Application-model gaps (Gmail-class apps)**

Dynamic web clients — Gmail, Outlook Web, Slack — were structurally
unsupported, not just flaky:

- No iframe traversal: every locator resolved against the main frame only.
- No keyboard primitive: `act` supported `click` and `fill` only; apps whose
  affordances are keyboard-first (`/`, `c`, roving focus) had no representation
  in the flow spec.
- `fill()` does not drive contenteditable/rich-text editors (no key events).
- Virtualized lists were never scrolled into view before locating.
- Cached CSS selectors assume stable class names; Gmail's are build artifacts
  that rot between deploys.
- All timing constants (quiet windows, ceilings, retry counts) were hardcoded
  to values tuned on one portal style.

## Design: sector profiles

Reliability tactics are not universal — they vary by industry (compliance
posture, what counts as a dangerous action) and by app class (how the DOM
behaves, how auth is carried). Instead of scattering per-site conditionals,
Portico now ships a **sector-profile registry**
(`packages/flow-spec/src/sectors.ts`): named bundles of reliability defaults
selected per connector.

| Sector | Covers | Posture highlights |
| --- | --- | --- |
| `healthcare` | EHR/payer/scheduling portals | Slow backends → long ceilings; cookie-session auth; strict PHI redaction; booking/claim keywords guarded |
| `communications` | Gmail/Outlook/Slack-class clients | Longer DOM-quiet windows; CSS cache distrusted; keyboard-first; send/reply/forward guarded in any non-live mode |
| `finance` | Banking/insurance/brokerage | Deliberate pacing (anti-bot); **minimal retries** — duplicate-submission risk outweighs transient recovery; money-movement keywords guarded |
| `government` | Civic/tax/permits portals | Very long ceilings (queue interstitials, meta-refresh); conservative pacing; CAPTCHA → human |
| `commerce` | E-commerce/logistics back-offices | API-tier harvest preferred; refund/charge guarded |
| `saas_ops` | Internal CRM/ops/support tools | localStorage bearer auth; integration-beacon noise patterns (moved out of hardcoded author regexes) |
| `generic` | Everything else | **Bit-identical to the engine's historical defaults** — the no-regression contract, pinned by tests |

Selection: `Target.sector` in a connector's `target.yaml` → `Flow.sector`
(stamped at authoring time) → `generic`. Engine callers can override via
`EngineRunOptions.sector`. Full field reference and per-sector rationale:
[docs/SECTORS.md](SECTORS.md).

A profile drives four consumers:

1. **Engine defaults** — readiness quiet-windows/ceilings, per-step-type
   timeouts, retry counts and backoff, inter-step pacing, and whether cached
   CSS selectors are trusted. Explicit `step.timeoutMs`/`step.retry` always
   win.
2. **Mode-scoped guards** — `mutationKeywords`/`forbiddenInValidation` cause
   matching `act` steps to be *skipped and traced* whenever `mode !== "live"`,
   so validation can traverse a write flow without writing. Flow-level
   `guard.forbidden_actions` remains absolute in every mode.
3. **Authoring** — domain vocabulary injected into the query-rewriter prompt,
   sector noise patterns applied additively to network-capture filtering, and
   auth-discovery gated by `authPattern` (cookie-session apps skip localStorage
   header-chaining, which would bind garbage).
4. **Compliance posture** — strict-redaction flag and per-sector notes.

## Reliability core (engine)

- **Structured error taxonomy** (`packages/engine/src/errors.ts`):
  `timeout | not_found | ambiguous | navigation | network | validation | guard
  | aborted | egress_blocked | unsupported | unknown`, each with a defined
  `resumable` bit. Step traces carry `errorKind`; run failures carry `kind`.
  The queue worker retries only transient kinds (timeout/network) with
  exponential backoff, and records human pauses as `paused`, not `failed`.
- **Universal ceilings** — every step type now has a hard timeout (profile
  default, step override); non-idempotent API steps are **never auto-retried**
  (duplicate-write risk); abort signals interrupt in-flight steps.
- **Safety gates** — `guard.dry_run_only` is enforced at run start (live mode
  refused, kind `guard`); mutating DOM acts are skipped in non-live modes and
  surfaced as `RunResult.skippedMutations`; `Target.allowed_domains` is now
  enforced by route interception (blocks navigations and non-GET requests to
  non-allowed hosts, passes GET subresources so pages still render; blocked
  entries surfaced as `RunResult.blockedRequests`; kill switch
  `PORTICO_EGRESS_ENFORCE=0`).
- **Fail-loud extraction and asserts** — the silent `page.title()` extract
  fallback is a hard `not_found` failure; assert conditions are a real
  registry (`page_loaded`, `url_contains:`, `text_visible:`,
  `selector_visible:`, `output_present:`) and unknown conditions fail with
  `unsupported` instead of silently passing. `human`-step conditions stay
  lenient (unknown → pause) to preserve 2FA flows.
- **Intercept hardening** — `intercept.required` makes a capture load-bearing
  for validation and turns a wait timeout into a hard, named failure;
  `intercept.schema` applies the same Zod gate as `extract`.
- **Resume that preserves data** — `EngineRunOptions.resumeOutput` seeds prior
  step outputs so `resumeFrom` no longer renders downstream templates as empty
  strings.

## Gmail-class primitives

- `step.method: "press"` — keyboard chords (`"Control+Enter"`), on the located
  element or the page.
- `step.method: "type"` — click-to-focus then real key events
  (`pressSequentially`), required by contenteditable editors that ignore
  `fill()`.
- `locator.frame: string[]` — iframe chain resolved via `frameLocator`
  before candidate resolution.
- `scrollIntoViewIfNeeded` before visibility waits — brings virtualized rows
  into the viewport.
- The `communications` profile turns off cached-CSS trust and adds an act
  retry to absorb virtual-list re-renders detaching elements mid-action.

The reference connector [`connectors/gmail-web/`](../connectors/gmail-web/)
demonstrates the posture end-to-end (human-only Google sign-in, keyboard-first
search, draft-only compose guarded by `dry_run_only` + `forbidden_actions:
["send"]`). It is a DRAFT: locators are representative and must be validated
live before `portico confirm`.

## What is deliberately NOT handled yet

Ordered by expected next value:

1. **Live validation of gmail-web** — the connector is authored from Gmail's
   documented ARIA surface, not a live capture. Run `portico validate` against
   a real mailbox and iterate the locators.
2. **Scroll-container harvesting** — `scrollIntoViewIfNeeded` handles a target
   that exists off-screen; iterating a virtualized container to *enumerate*
   rows (scroll-extract-scroll) is a new extract mode.
3. **Keyboard-first authoring** — the recorder captures clicks; it does not
   yet capture keyboard shortcuts as first-class actions, so authored
   communications flows lean on click fallbacks.
4. **Paused-run operations** — notifications (webhook/email) and a console
   review queue for `paused` runs, plus wiring the console "Resume from step"
   button to `resumeFrom`/`resumeOutput`.
5. **Closed shadow DOM, canvas UIs, drag-and-drop** — out of scope for the
   DOM-tier ladder; these escalate to the human step (and eventually a
   computer-use tier per the architecture's L4 slot).
6. **Anti-bot posture beyond pacing** — profiles encode pacing only. CAPTCHA
   remains a human step by design.
7. **Scheduler + durable queue semantics** — the SQLite queue now retries with
   backoff, but there is still no cron, no dead-letter view, and no
   cross-machine worker story (see ADR-0003 for the Postgres path).

## Invariants preserved

- **LLM never on the hot path.** Every mechanism above is deterministic;
  profiles are static data, gates are code.
- **No-regression for existing flows.** Absent a sector, the `generic` profile
  reproduces the historical constants exactly (pinned by
  `packages/flow-spec/src/sectors.test.ts`). The deliberate behavior changes —
  fail-loud extraction, fail-loud unknown asserts, dry-run mutation gate,
  universal ceilings — replace *silent wrong results* with *loud failures*,
  which is the point of the phase.
- **Flows remain frozen artifacts.** Sector profiles change *defaults around*
  a flow, never the flow's authored steps.
