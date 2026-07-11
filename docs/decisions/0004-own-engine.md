# ADR-0004: Own the execution engine (retire the Libretto dependency)

- Status: **Accepted** (2026-07-11)
- Supersedes: [ADR-0001](0001-execution-engine.md) **in part** — the
  `EngineAdapter` seam and the "compose, don't reinvent browser automation"
  principle survive; the choice of Libretto as the composed engine does not.

## Context

ADR-0001 adopted Libretto (MIT) to avoid reinventing browser automation. Since
then, every reliability-bearing primitive has been built in Portico's own
compiler/runner: DOM-quiet readiness gates, the semantic locator ladder,
per-step retry/timeout envelopes, extraction validation, mutation/dry-run
gates, egress enforcement, the structured error taxonomy, intent resolution,
and session recording. What ADR-0001's rationale actually protects is
**Playwright** — its locator engine, auto-waiting, and frame model — not the
layer above it.

By mid-2026 the remaining Libretto coupling had narrowed to four imports, and
each had become a liability:

1. **The `workflow()` artifact is a ceiling.** New step primitives required
   for dynamic apps (`method: press/type`, `locator.frame` iframe chains)
   cannot be represented in the emitted Libretto workflow, forcing the opt-in
   CLI runner path to reject them. Roadmap items were being constrained by a
   dependency's serialization format.
2. **`attemptWithRecovery` is a popup-dismisser, not a heal ladder.** The
   architecture's planned recovery tiers (a11y-tree heal and beyond) will be
   built in-house regardless; keeping Libretto's recovery meant maintaining
   two recovery paths, one of which cannot see Portico's error taxonomy.
3. **`.libretto/profiles/` conventions caused a real durability defect** —
   the directory sits outside the Docker data volume, so image rebuilds
   silently dropped every persisted login (see `docs/DEPLOY.md`).
4. **Supply-chain posture.** A pre-1.0 dependency (`libretto@^0.6.x`) with
   model hooks adjacent to the execution path is a poor fit for a product
   sold as self-hosted, BAA-friendly, "LLM never on the hot path". Field
   integration notes (`docs/LIBRETTO-INTEGRATION-NOTES.md`) had already
   flagged friction exactly where reliability lives: network capture and
   auth persistence.

## Decision

Portico owns its execution engine outright, on Playwright:

- **Inline launch/attach plumbing.** `launchBrowser`/`createRecoveryPage`
  are replaced by direct Playwright `chromium.launch` /
  `launchPersistentContext` / CDP attach in `packages/engine`. `playwright`
  becomes a direct dependency of `@portico/engine`.
- **Own recovery module.** `attemptWithRecovery`/`popupRecoveryAction` are
  replaced by an in-house recovery step (`packages/engine/src/recover.ts`):
  deterministic overlay/popup dismissal plus a single re-attempt, triggered
  by the structured error taxonomy, with the same optional model hook and the
  same hard ceiling. No model configured → recovery is deterministic-only,
  preserving the "LLM never on the hot path" invariant. The full a11y-tree
  heal ladder remains a roadmap item and now has a single home.
- **Retire the CLI runner and the `workflow()` artifact.** The programmatic
  runner is the only runner. `PORTICO_LIBRETTO_RUNNER=cli` now fails fast
  with a clear error instead of spawning `npx libretto run`.
- **Profiles move to `.portico/profiles/`.** A read-fallback shim migrates
  existing `.libretto/profiles/` state transparently (copy-forward on first
  use); the Docker volume mapping is corrected to cover the new location.
- **The `EngineAdapter` seam stays.** Libretto is demoted from foundation to
  "an adapter someone could write out-of-tree". Nothing in-tree imports
  `libretto` anymore, and the dependency is removed from `package.json`.

## Consequences

Positive:
- New step primitives are constrained only by Playwright, not by an artifact
  format — press/type/frame land uniformly in the one runner.
- One error taxonomy end-to-end: recovery, retries, traces, the queue worker,
  and the console all see the same `StepErrorKind`.
- Cleaner compliance story for self-hosters: one fewer third-party layer
  touching authenticated sessions; deterministic recovery by default.
- Fixes the persisted-login durability gap as part of the profile move.

Negative / accepted costs:
- Portico now owns browser-launch quirks and recovery improvements that
  Libretto upstream might have delivered for free.
- One-time migration surface: profile directory shim, removal of the
  `PORTICO_LIBRETTO_RUNNER` escape hatch, historical marker on the Libretto
  integration notes.

Evidence bar for the transition: the full monorepo suite plus a
browser-backed smoke suite (`packages/engine/src/smoke.browser.test.ts`)
exercising the real runner — navigation, click/fill/press/type, iframe
chains, contenteditable typing, schema-gated extraction, dry-run mutation
skipping, egress blocking, and recovery — against local fixture pages, with
zero `libretto` imports left in the tree.
