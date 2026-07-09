Portico x Libretto — field notes

Context: we built a healthcare-portal automation platform on Libretto. The hard
target was Epic/MyChart scheduling (2FA, anti-forgery tokens, single-use nonces,
aggressive logout). A fresh workflow now runs author -> validate -> deterministic
replay end-to-end against the live portal. A few notes on what worked, what was
missing, how we implemented it, and our platform strategy. The mental model
genuinely shaped our design — thank you.


WHAT WORKED WELL

- workflow() + auth-profile + human-in-the-loop pause: exactly the right shape for
  login and 2FA — pause for the human, persist, resume.

- pageRequest: the right API-tier primitive. In-page authenticated fetch that
  reuses cookies and TLS, with form/JSON bodies — worked first try. It is the
  workhorse of our fast path.

- Deterministic replay with a model only at authoring and recovery: this matched
  how we reason about latency, cost, and PHI exposure. The "convert to network
  requests" guide framed our whole architecture.


WHAT WAS MISSING (friction, and what would help)

- Network capture is CLI-only. The network.jsonl capture lives in the CLI daemon,
  not the library. We run Libretto in-process, so we reimplemented
  page.on('response') capture ourselves. A captureNetwork(page) / instrumentation
  hook exposed from the library would save every in-process embedder that work.

- Auth persistence assumes cookies survive. Storage-state profiles work when auth
  lives in cookies, but not for portals with server-side session binding plus
  sessionStorage (MyChart). We moved to a persistent browser context plus
  CDP-attach to keep the session alive. A first-class "persistent profile / attach
  to a running browser" story would help — launchBrowser already accepts
  cdpEndpoint, so a documented pattern may be enough.

- Passive interception should be the primary strategy for protected portals. Our
  biggest lesson: against single-use nonces, replaying a captured request fails
  because the page consumes the nonce on load. Passively harvesting the response
  the page already makes is far more robust. The guide lists interception as an
  option; for anti-replay portals it is really the answer, and a one-line callout
  about single-use nonces would save people days.

- Self-heal is silently a no-op without a model. attemptWithRecovery being
  model-gated is correct, but it is easy to believe you have self-heal when you do
  not. A capability warning at run start would help.

- Minor: page.accessibility is gone in Playwright 1.6x — we migrated to
  locator.ariaSnapshot(). Worth a note wherever examples reference it.


HOW WE IMPLEMENTED IT

- Libretto is our deterministic execution engine, run in-process behind a thin
  adapter.

- Authoring: an agent (Stagehand) drives the live, authenticated session once
  toward a plain-language goal. We capture two independent streams during that run
  — the agent's own action stream (its intent plus the element it resolved) and a
  DOM click hook (the element's real accessible name and role) — and reconcile them
  by exact xpath identity. The agent's resolved xpath matches the DOM capture
  exactly, so we recover the element's real name, then compile a frozen Libretto
  flow: intercept -> navigate -> the clicks -> wait on the harvested data.

- Why two sources: neither alone was enough. Raw DOM clicks froze noise and
  mis-identified containers; the agent's own descriptions were not the real on-page
  names. The exact-xpath join is what made it reliable.

- One integration note that may resonate: our authoring agent pins ai@5 and our
  Libretto path uses ai@6, so we keep them in separate packages with no shared
  imports.


OUR STRATEGY — THE STITCHED PLATFORM

- Author once, replay forever. A one-time, model-assisted authoring run is frozen
  into a deterministic flow. Every run after that is browser-speed with zero model
  calls on the hot path.

- Three tiers, cheapest-safe wins: API (pageRequest and passive interception) ->
  DOM (cached locators, role + name cascade) -> agent (heal only, off the hot
  path).

- Self-host first: everything runs in the operator's own infrastructure, so
  credentials and PHI never leave it.

- In short: Libretto is the execution core, Stagehand is only the one-time author,
  and a reconciliation layer stitches the two into a single deterministic artifact.


Net: the primitives are solid and the mental model is right. Our two real gaps —
in-process network capture, and session persistence for aggressively-protected
portals — we worked around cleanly. Thank you for the tool and the thinking behind
it.

(Happy to share the architecture diagram — one image — it is in our repo at
docs/architecture.svg.)
