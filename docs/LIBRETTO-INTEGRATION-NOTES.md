# Portico × Libretto — Field Notes

*How we built a healthcare-portal automation platform on Libretto, what worked,
and where a few library changes would've saved us days. The mental model shaped
our design — thank you.*

![Architecture](./architecture.svg)

**In one line:** a Stagehand agent authors a run once; we freeze it into a
deterministic Libretto flow that replays with **zero model calls on the hot
path**. Hard target: Epic/MyChart scheduling (2FA, anti-forgery, single-use
nonces, aggressive logout). A fresh workflow now runs author → validate →
deterministic replay **end-to-end against the live portal.**

Stack: `libretto@0.6.33` (execution), `@browserbasehq/stagehand@3.6.0`
(authoring), Playwright 1.6x, CDP attach.

## What worked well

- **`workflow()` + auth-profile + HITL `pause`** — right shape for login/2FA.
- **`pageRequest`** — the correct API-tier primitive; in-page authenticated fetch,
  form/JSON bodies, worked first try. Workhorse of our API tier.
- **Deterministic-replay + model-only-at-authoring** — matched our latency, cost,
  and PHI-exposure reasoning exactly. The `convert-to-network-requests` guide
  framed our whole architecture.

## Friction → asks (ranked)

1. **Network capture is CLI-only.** `network.jsonl` lives in the CLI daemon
   (`session-telemetry`), not the library. Running in-process, we reimplemented
   `page.on('response')`. → **Expose `captureNetwork(page)` / an instrumentation
   hook from the library.**
2. **Auth persistence assumes cookies survive.** Storage-state profiles don't
   cover server-side session binding + sessionStorage (MyChart). We moved to a
   **persistent context + CDP-attach**. → **A first-class "persistent profile /
   attach to running browser" story** (`launchBrowser` already takes `cdpEndpoint`
   — a documented pattern may be enough).
3. **Passive interception should be *the* strategy for protected portals.** Against
   single-use nonces, replaying a captured request fails — the page consumes the
   nonce on load. Harvesting the response the page already makes is far more
   robust. → **Elevate interception in the guide, with a single-use-nonce callout.**
4. **Self-heal is silently a no-op without a model.** `attemptWithRecovery` being
   model-gated is correct, but easy to misread. → **A capability warning at run
   start.**
5. **Minor:** `page.accessibility` is gone in Playwright 1.6x → we use
   `locator.ariaSnapshot()`. Worth a note wherever examples reference it.

## Portal-hostility findings (Epic-specific, may be useful guide color)

- **Root-nav clears auth cookies** — never force-navigate a logged-in session to
  `/`; only navigate cross-origin, else start where the human logged in.
- **Multi-tab automation triggers logout** — single-tab discipline; our runner
  opens its own page and closes only that page on teardown.

## The authoring layer we built on top

The naïve "compile a flow from raw DOM clicks" produced brittle locators (frozen
container blobs, ephemeral date cells). Fix: **two-source reconciliation** — join
the agent's action stream (intent + resolved xpath) with a DOM click hook (real
accessible name), keyed on **exact xpath identity**, then compile to a frozen
Libretto flow (`intercept` + `navigate` + `act` + `wait`). See the diagram above.

*(Isolation note that may resonate: our authoring agent pins `ai@5`, our Libretto
path uses `ai@6`; we keep them in separate packages with no shared imports.)*

## Net

Primitives solid, mental model right. Our gaps were **in-process network capture**
and **session persistence for aggressively-protected portals** — both worked
around cleanly. Thank you for the tool and the thinking behind it.
