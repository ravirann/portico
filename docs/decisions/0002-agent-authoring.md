# ADR-0002 — Agent authoring via demonstration + two-source reconciliation

**Status:** Accepted.
**Date:** 2026-07.

## Context

A deterministic flow ([ADR-0001](0001-execution-engine.md)) has to come from
somewhere. Hand-writing selectors for hostile legacy portals (Epic/MyChart) is
brittle and slow. We want to author a flow **once, by demonstration**, against a
live authenticated session, and freeze it into a deterministic Libretto flow with
no model on the hot path.

The naïve approach — drive the portal with an agent and compile the flow from raw
DOM click events — failed: it froze noise (dashboard cards, notification blobs),
mis-identified container elements, and (when it fell back to the agent's own
natural-language element *descriptions*) produced locator names that never matched
the real page text.

## Decision

Author with an **agent** ([Stagehand](https://github.com/browserbase/stagehand) v3)
and compile the run via **two-source reconciliation** (`packages/author`):

1. Capture **two independent streams** during the authoring run — the agent's own
   action stream (`result.actions`: intent + the element it resolved, as an
   xpath) and a **DOM click hook** (the element's real accessible name/role + its
   xpath, captured at click time).
2. **Reconcile on exact xpath identity.** The agent's resolved xpath is
   character-for-character identical to the clean DOM-hook capture for the same
   control, so we recover the element's *real* accessible name — not the agent's
   paraphrase, and not a page-container blob. Preference order: exact xpath →
   close actionable-ancestor (deep path, ≤3 levels, never a page container) →
   clean-label overlap.
3. **Compile** the reconciled steps to a frozen `intercept → navigate → act… →
   wait` flow via `compileRecording` (in `@portico/flow-spec`).
4. **Fall back** to the DOM-hook-only path when the agent stream is thin (<2
   interactions) or fails to correlate — a strict no-regression contract. Kill
   switch: `PORTICO_AUTHOR_NO_RECONCILE=1`.

Reconcile **post-hoc from `result.actions`**, not via Stagehand's live
`onEvidence` callback: our model resolves the agent to hybrid/dom mode (never
CUA), so `result.actions` already carries the resolved xpath per action, and both
streams are captured at click-time — so post-hoc gets the same correctness
without `experimental:true` (which would risk the navigation that already works).

`@portico/author` is **isolated from `@portico/engine`**: Stagehand pins `ai@5`,
the engine uses `ai@6`; they share no import surface.

## Consequences

- Flows are authored end-to-end from a plain-language goal against a live session,
  then run deterministically. Validated live against Epic/MyChart: author →
  validate → deterministic replay, all steps resolved, data harvested, no booking.
- The locator name is the DOM's real accessible name, so the engine's
  `getByRole`/`getByText` cascade resolves it deterministically (no model needed);
  the agent's description is used only as a last-resort intent for self-heal.
- Every authoring run dumps its full capture (`data/author-evidence-latest.json`,
  gitignored) for diagnosis.
- Compliance: authoring sends live DOM to a model; for real PHI the model must be
  a BAA-covered route with DOM values redacted first. Fine for staging/synthetic.
