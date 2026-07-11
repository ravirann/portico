# Connector: gmail-web

> **REFERENCE CONNECTOR.** Locators are a representative selection from Gmail's
> stable ARIA surface (role + accessible name), hand-authored rather than
> captured from a record-by-demonstration session.
>
> **`gmail-compose-draft` is LIVE-VALIDATED** (2026-07-11, mail.google.com on
> Chrome 149): driven end-to-end through the engine, every step `ok`, the draft
> autosaved and Gmail's "Draft saved" confirmation asserted — recipient/subject/
> body all landed, nothing sent. Two corrections came out of that run and are
> folded in: Gmail **autosaves** (the old `Ctrl+S` step was removed — it opens
> the browser's Save-page dialog), and the body read-back now uses a
> **deterministic cached locator** (no extract model needed). One engine gotcha
> worth knowing: CDP-attach opens a fresh page, so a compose flow must `navigate`
> to Gmail (the `gmail-login` subflow does) — running the bare compose steps
> against an already-open tab won't find the page.
>
> `gmail-search-extract` is still representative — `portico validate` it against
> a real account before you `portico confirm`. See "Live validation" below.

## What this demonstrates

`gmail-web` is a worked example of the **communications** sector profile
(`docs/SECTORS.md`) — an email/chat/calendar web client, a different app
shape from `example-portal`'s server-rendered, form-based posture:

- **Role/name-only locators.** Gmail's CSS classes are build artifacts that
  rotate between deploys (`cssCacheTrusted: false`), so every locator here is
  `{ role, name }` — never a class or generated id.
- **Keyboard-first interaction.** `preferKeyboard: true` for this sector.
  Flows reach for `method: press` / `method: type` (real keyboard events)
  ahead of raw clicks — see the `/` search shortcut in
  `gmail-search-extract.flow.yaml` and the contenteditable compose body in
  `gmail-compose-draft.flow.yaml`.
- **Longer DOM-quiet windows.** Gmail's thread list is virtualized and
  mutates constantly; this sector's larger `actQuietMs`/`actTimeoutMs` and
  its extra act retry (`docs/SECTORS.md#communications`) give a re-render
  more room to settle before the runner acts or extracts.
- **A dry-run guard on anything that could send.** `gmail-compose-draft` sets
  `guard.dry_run_only: true` and `forbidden_actions: ["send"]`; no flow here
  ever locates or clicks a Send button.

## Setup

Google sign-in is **deliberately a human step** — `flows/gmail-login.flow.yaml`
never touches the email/password/OTP fields. Automated credential entry trips
Google's bot detection and violates its Terms of Service. Authenticate once
into a persistent auth profile and every later run reuses that session:

```bash
node --import tsx apps/cli/src/index.ts run \
  connectors/gmail-web/flows/gmail-login.flow.yaml \
  --headed --profile my-gmail --live
```

A browser window opens to `mail.google.com`; sign in (including 2FA) by hand,
then the flow's `assert url_contains:mail.google.com` confirms you landed
signed in. `--profile my-gmail` persists that session to disk — later runs
that pass the same `--profile` skip straight past the human step.

## Why DOM-tier extraction, not a network intercept

`example-portal/flows/portal-availability.flow.yaml` intercepts a clean JSON
endpoint (`GetSlots`) and never touches the DOM — the API tier
(`docs/ARCHITECTURE.md` §3). Gmail doesn't offer that option here: its
sync/search traffic runs over batched, proprietary protocols, not a stable
per-action JSON response you can key an `intercept.url_contains` on. So the
API tier doesn't apply to this connector, and `gmail-search-extract` reads
the rendered thread rows off the DOM instead — the correct, and only, tier
for this app shape.

## Reliability notes

- **Virtualized thread list.** Gmail only mounts the rows currently on
  screen; `gmail-search-extract`'s extract step returns whatever's rendered
  at that instant, not the full result count. Harvesting the rest of a long
  list by scrolling the container is future work (`docs/ROADMAP.md` Phase 6).
- **Keyboard shortcuts depend on a per-account Gmail setting.** Gmail's `/`
  (search) and `c` (compose) shortcuts only fire with "Keyboard shortcuts: ON"
  (Settings → General) — off by default for some accounts. `gmail-search-extract`
  reaches for `/` with the search box's locator as the deterministic fallback
  (see its comments); `gmail-compose-draft` sidesteps the question and clicks
  Compose directly — it's a single always-visible button either way.

## Files in this pack

- `target.yaml` — the target (`sector: communications`, egress boundary, auth).
- `flows/gmail-login.flow.yaml` — human Google sign-in; persists via `--profile`.
- `flows/gmail-search-extract.flow.yaml` — search the mailbox and extract visible thread rows. Read-only.
- `flows/gmail-compose-draft.flow.yaml` — compose and autosave a draft. Never sends (`guard.dry_run_only`, `forbidden_actions: ["send"]`).

## Live validation

```bash
node --import tsx apps/cli/src/index.ts run \
  connectors/gmail-web/flows/gmail-search-extract.flow.yaml \
  --profile my-gmail --input query="from:billing" --live
```

Every locator here is representative, not captured — expect to open the
trace, fix any that missed, and re-run before you `portico confirm` a flow
from this pack.
