# Sector profiles

Reference for `packages/flow-spec/src/sectors.ts` — the named bundles of
reliability defaults (readiness gates, timeouts, retries, locator policy,
mutation guards, authoring hints) keyed by industry/app-class. Source of
truth for every number below is `sectors.ts` itself; if this doc and the code
ever disagree, the code wins and this doc is stale.

## Why sectors exist

Portico's engine originally hardcoded one set of reliability numbers —
timeouts, retry counts, DOM-quiet windows, locator-caching policy, mutation
guards — tuned against one style of portal: a conventional, server-rendered
form app with stable DOM ids. That's a fine fit for `example-portal`-shaped
targets, but wrong in both directions elsewhere: too impatient for a
government portal's queue interstitials, too trusting of CSS classes on a
virtualized email client, too forgiving about retrying a financial transfer.
Sector profiles replace the single hardcoded bundle with named, versioned
bundles keyed by industry/app-class, so a connector opts into the posture
that matches its actual target instead of inheriting defaults tuned for a
different kind of app.

## How selection works

A profile is resolved once per run, in priority order:

1. **`Target.sector`** in the connector's `target.yaml` — highest priority,
   since the target is the most specific thing that knows its own app shape.
2. **`Flow.sector`** — an authoring-time fallback, for a flow shared across
   targets or authored before its target declared a sector.
3. **`generic`** — if neither is set.

`resolveSectorProfile(key)` does this lookup and always returns a profile; an
unrecognized or absent key resolves to `generic` rather than throwing. Engine
and author-package callers can still pin a profile explicitly where they need
to (a CLI flag, a test harness), but the target/flow stamp is the default
path. See `Target.sector` / `Flow.sector` in `packages/flow-spec/src/index.ts`.

## Profile reference

| Sector | Typical apps | Readiness (quiet/ceiling ms) | Step / nav timeouts | Retry posture | CSS cache trusted? | Pacing | Notable guards |
|---|---|---|---|---|---|---|---|
| `generic` | Fallback — reproduces the engine's historical defaults | nav 500/8000 · act 300/3000 | step 15000 / nav 60000 | nav 1 · act 1 · extract 2 · api 1 · backoff 500 | Yes | 0ms | writes not dry-run by default; no forbidden-in-validation list |
| `healthcare` | EHR, payer & clinical scheduling portals (Epic/MyChart, Availity-class) | nav 700/15000 · act 400/6000 | step 20000 / nav 90000 | nav 2 · act 1 · extract 2 · api 2 · backoff 1000 | Yes | 250ms | writes default dry-run; forbidden in validation: book/confirm appointment, submit claim, e-sign |
| `communications` | Email, chat & calendar web clients (Gmail, Outlook Web, Slack) | nav 800/12000 · act 500/5000 | step 20000 / nav 60000 | nav 2 · act 2 · extract 2 · api 1 · backoff 700 | No | 150ms | writes default dry-run; forbidden in validation: send, reply all, forward |
| `finance` | Banking, insurance & brokerage portals | nav 700/15000 · act 400/6000 | step 25000 / nav 90000 | nav 1 · act 1 · extract 2 · api 1 · backoff 1500 | Yes | 400ms | writes default dry-run; forbidden in validation: transfer, payment, wire, trade |
| `government` | Civic, tax, permits & case-management portals | nav 900/20000 · act 500/8000 | step 30000 / nav 120000 | nav 2 · act 1 · extract 2 · api 2 · backoff 2000 | Yes | 500ms | writes default dry-run; forbidden in validation: submit application, pay fee, certify |
| `commerce` | E-commerce & logistics back-offices (Shopify-admin-class, seller/courier portals) | nav 500/10000 · act 300/4000 | step 15000 / nav 60000 | nav 2 · act 2 · extract 2 · api 2 · backoff 500 | Yes | 100ms | writes default dry-run; forbidden in validation: refund, charge, void |
| `saas_ops` | Internal CRM/support/ops tools (Zendesk-class, custom ops consoles) | nav 500/8000 · act 300/3000 | step 15000 / nav 60000 | nav 1 · act 1 · extract 2 · api 1 · backoff 500 | Yes | 0ms | writes default dry-run; no forbidden-in-validation list |

Retry posture reads as `nav · act · extract · api (idempotent-only) · backoffMs`.
Readiness reads as `navigate quiet/ceiling · act quiet/ceiling`, both in ms.

### Generic

No sector-specific posture. These numbers are frozen to match the engine's
pre-sector-profile hardcoded defaults exactly, so a `Target`/`Flow` that
doesn't set `sector` behaves exactly as it did before profiles existed. See
"The no-regression contract" below.

### Healthcare

EHR/payer portals (Epic/MyChart, Availity-class) run on slow server backends
with aggressive session expiry, so readiness windows and step timeouts run
longer than generic and navigation gets an extra retry. `dryRunDefaultForWrites`
is on and validation hard-blocks booking/claim/e-sign actions — the clinical
and billing cost of a mistaken write is high, so authoring defaults to caution.

### Communications

Gmail/Outlook Web/Slack-class apps ship obfuscated, rotating CSS classes, so
`cssCacheTrusted: false` forces every locator through role/name resolution
instead of a cached selector. The virtualized DOM re-renders mid-action, so
`actMax` gets one extra retry to absorb elements detaching under an in-flight
click, and `actQuietMs`/`actTimeoutMs` run longer to let a re-render settle.
`preferKeyboard` steers authoring toward the app's own shortcuts. Validation
hard-blocks send/reply-all/forward. See `connectors/gmail-web/` for a worked
example.

### Finance

Banking/brokerage portals are anti-automation sensitive with mandatory 2FA
and aggressive session expiry, so `actionDelayMs` paces input deliberately —
bursty, inhuman input trips bot heuristics. Retries are the most conservative
of any profile (`actMax: 1`, `navigateMax: 1`) because a duplicate submission
(a second transfer, a second trade) is worse than a failed step a human can
retry. Validation hard-blocks transfer/payment/wire/trade.

### Government

Legacy server-rendered portals with queue/wait interstitials, meta-refresh
and CAPTCHAs need the longest ceilings of any profile (30s step, 120s
navigation) because an interstitial queue page can legitimately take that
long to clear. Pacing stays conservative to respect posted rate limits and
business hours. Validation hard-blocks application submission, fee payment
and certification.

### Commerce

Shopify-admin-class back-offices are modern SPAs with JSON APIs and
virtualized tables, so readiness/timeouts sit close to generic and retries
are generous (`actMax: 2`, `apiIdempotentMax: 2`) — transient failures are
cheap to retry against a fast backend. Validation hard-blocks refund/charge/void.

### SaaS Ops

Internal CRM/ops consoles (Zendesk-class) are fast SPAs with localStorage
bearer auth, so this profile tracks generic's timing/retry numbers almost
exactly. The material differences are `authPattern: localStorage` (for
header-chaining discovery) and a noise/vocabulary list tuned to ops-tool
traffic. No forbidden-in-validation list; `dryRunDefaultForWrites` still
guards live runs by default.

## The no-regression contract

`generic` is defined to exactly reproduce the engine's pre-sector-profile
hardcoded numbers (see the comment on `SECTOR_PROFILES.generic` in
`sectors.ts`): 500ms/8s navigate quiet/ceiling, 300ms/3s act quiet/ceiling,
15s step timeout, 60s navigation timeout, 10s extract timeout, 1 navigate/act
retry, 2 extract retries, 500ms backoff, CSS cache trusted, no keyboard
preference. Any `Target` or `Flow` that doesn't set `sector` resolves to
`generic` and therefore behaves exactly as it did before sector profiles
existed — adding this registry changes nothing for a connector that doesn't
opt in.

## Mode-scoped guard semantics

Each profile's `guards` block carries two keyword lists plus a default:

- **`mutationKeywords`** — act labels matching one of these (substring,
  case-insensitive) are **skipped** whenever the run's `mode` is `dry_run`
  (`RunMode` is `"dry_run" | "live"`). This lets a flow traverse a
  write-shaped screen — open the compose window, fill the form — without a
  mutating click ever firing, without every write flow hand-authoring its
  own skip logic.
- **`forbiddenInValidation`** — act labels matching one of these are
  **blocked outright** whenever `mode !== "live"`. `portico validate` runs in
  `dry_run` mode by default, so this is what stops a validation pass from
  ever actually sending an email, booking an appointment, or moving money,
  even though validation deliberately drives the flow as far as it can to
  exercise it.
- **`dryRunDefaultForWrites`** — an authoring-time hint: when true, authoring
  stamps `guard.dry_run_only` onto write-intent flows for this sector by
  default.

These are sector-level, keyword-matched, and advisory to authoring and
validation. They're distinct from a flow's own `guard` block (`FlowGuards` in
`packages/flow-spec/src/index.ts`), which is per-flow and **absolute**:
`guard.forbidden_actions` is checked at compile time, unconditionally,
against every step's label and value — it refuses the flow if it matches,
in any mode. `guard.dry_run_only` keeps a flow out of live execution
entirely. A flow's own guard always wins; the sector's keyword lists are the
net underneath it, not a replacement for it.

## How to add a sector

1. Add a new `SectorProfile` entry to `SECTOR_PROFILES` in
   `packages/flow-spec/src/sectors.ts` — every field is required, so start
   from the sector closest to the new app-class and comment each number that
   differs with why.
2. Add coverage in `packages/flow-spec/src/sectors.test.ts` — at minimum,
   assert the new key resolves via `resolveSectorProfile` and appears in
   `listSectors()`.
3. Document it here: add a row to the table above and a short subsection
   explaining the reasoning behind its numbers, the same way the seven
   sectors above are documented.
4. Point a connector's `target.yaml` at it (`sector: <key>`) and validate
   live — a new profile is only as good as a real target that exercises it.
