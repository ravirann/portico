# ADR-0001 — Execution engine

**Status:** Accepted.
**Date:** 2026-07.

## Context

Portico needs a browser-automation engine that provides deterministic replay
with **no LLM on the hot path** (see [ARCHITECTURE §4](../ARCHITECTURE.md)),
network capture for a direct-API tier, self-heal on drift, robustness on
hardened portals (shadow DOM, iframes), and — importantly — the ability to run
**in-process** so it embeds cleanly in a multi-tenant TypeScript control plane.

## Decision

Adopt **[Libretto](https://github.com/saffron-health/libretto)** (MIT) as the
execution engine, implemented behind the `EngineAdapter` interface
(`packages/engine`). Validation confirmed Libretto exposes its runtime
programmatically and in-process (`launchBrowser` → a Playwright page,
`attemptWithRecovery` for self-heal that only calls a model *on failure*,
`extractFromPage`, `librettoAuthenticate`, session-state), and the no-AI-on-hot-path
principle holds by construction.

The engine sits behind an adapter interface so the choice is **reversible and
swappable per-connector** without touching the platform layer; a stub fallback
adapter (`packages/engine/src/adapters/fallback.ts`) documents that seam.

## Consequences

- Portico's platform layer (control plane, vault, multi-tenancy, audit,
  connectors, self-host) is built engine-agnostically.
- Before running against regulated data, confirm telemetry is disabled and the
  full loop runs self-hosted.
