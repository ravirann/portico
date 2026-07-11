# Portico Roadmap

Status: ✅ done · 🟡 in progress · ⬜ planned. Self-host / local-first and OSS
throughout; cloud/managed features are a later open-core layer, never a
dependency for running Portico yourself.

## Phase 0 — Foundation ✅

Repo structure · OSS community files · CI/lint/tests · architecture docs +
diagram · branding.

## Phase 1 — Runtime foundation ✅

Flow / run / session model (SQLite store) · worker loop (in-process) ·
deterministic step runner · run logs, per-step screenshots, artifacts ·
env-based secret injection + redaction (vault) · retry / timeout policies ·
tier derivation (`deriveTier`).

## Phase 2 — Operator console ✅

Flow registry · run timelines with inline per-step screenshots · session
management (launch/attach, connector-scoped) · self-heal / fail-safe
classification · connectors. 🟡 remaining: escalation queue, tenant-aware config.

## Phase 3 — Authoring & AI-assisted recovery ✅

Self-heal (locator repair, cached) · schema-validated extraction ·
human-in-the-loop review · **agent authoring by demonstration + two-source
reconciliation (exact-xpath join), validated end-to-end against a live portal
([ADR-0002](decisions/0002-agent-authoring.md))** · eval suite scoring
authoring quality over capture fixtures (in CI) · model/prompt provenance
recorded on every authored flow (`flows.provenance_json`).

⬜ stretch: a second EHR/insurer fixture in the `generalize` suite.

## Phase 4 — Production readiness (OSS, self-host, local-first) ✅

- ✅ **One-command local self-host** — `deploy/docker-compose.yml` + Dockerfile
  (Playwright base, explicit COPY allowlist) + [docs/DEPLOY.md](DEPLOY.md).
- ✅ **Secrets** — `FileSecretProvider` chained ahead of env
  (`PORTICO_SECRETS_FILE`); age/SOPS at-rest patterns in [docs/SECRETS.md](SECRETS.md).
- ✅ **Audit** — `list-audit --json|--csv` export + read-only `/audit` console view.
- ✅ **RBAC** — opt-in viewer/operator/admin via `PORTICO_RBAC_TOKENS`
  (unset = open local single-user, unchanged); middleware + `/login`.
- ✅ **Multi-tenant scale path** — designed in
  [ADR-0003](decisions/0003-postgres-rls.md) (Proposed): async `Store` seam,
  `PgStore` + per-transaction RLS. SQLite stays the permanent local default;
  implementation deliberately deferred until a hosted multi-tenant tier needs it.
- ✅ **Worker concurrency** — store-backed `run_queue` +
  `enqueue` / `queue` / `worker --concurrency N` (atomic claims, audit events).
- ✅ **Connector pack template** — `connectors/TEMPLATE/` +
  [docs/ADAPTER-SDK.md](ADAPTER-SDK.md).

## Phase 5 — Reliability & sector profiles 🟡 in progress

- **Sector-profile registry** — [`packages/flow-spec/src/sectors.ts`](../packages/flow-spec/src/sectors.ts),
  consumed by both the engine and authoring: readiness gates, timeouts,
  retries, locator-cache trust and mutation guards keyed by industry/app-class
  instead of one hardcoded bundle. Full reference: [docs/SECTORS.md](SECTORS.md).
- **Universal step ceilings and a structured error taxonomy** — every step
  type gets a hard ceiling; failures classify instead of surfacing as opaque
  exceptions.
- **Safety gates** — dry-run mutation gate on API-tier writes, runtime
  enforcement of `guard.dry_run_only`, `allowed_domains` egress enforcement,
  fail-loud extraction and asserts (no silent empty-result passes).
- **Gmail-class primitives** — `press` / `type` step methods, iframe chains
  (`locator.frame`), scroll-into-view, landed in the flow spec together with a
  worked reference connector, [`connectors/gmail-web/`](../connectors/gmail-web/)
  (communications sector, DRAFT — locators need live validation).
- ✅ **Engine ownership** — [ADR-0004](decisions/0004-own-engine.md) retired the
  Libretto dependency; Portico's own `launch`/`recover`/`page-request` modules
  run directly on Playwright behind the same `EngineAdapter` seam, with
  deterministic-first recovery. Evidence bar: the full suite (393/393) plus a
  browser-backed smoke suite (`packages/engine/src/smoke.browser.test.ts`, 8
  live-Chromium scenarios).
- ✅ **Worker reliability** — distinguishes paused (HITL/resume needed) runs
  from failed ones; retries transient failures with backoff instead of
  treating every failure the same.

## Phase 6 — planned ⬜

- Live validation of `connectors/gmail-web/` against a real Gmail account, and
  authoring tooling for keyboard-first flows.
- Scroll-container harvesting, so virtualized lists (Gmail-class UIs) yield
  more than what's currently on screen.
- Notifications + a review queue for paused runs.
- Console resume UI wired to `resumeOutput`.
- Scheduler.
- Postgres/RLS per [ADR-0003](decisions/0003-postgres-rls.md).

## Phase 7 — Ecosystem (OSS) 🟡

- ✅ **Public adapter SDK** — the `EngineAdapter` seam documented + packaged
  ([docs/ADAPTER-SDK.md](ADAPTER-SDK.md)), so a different engine can be
  dropped in.
- ✅ **Example connector packs & templates** — starter connectors beyond the
  example portal (`connectors/gmail-web/`).
- ✅ **Local benchmark suite** — `scripts/bench.mjs` measures API / DOM tier
  latency against a local target and checks it against the SLOs in
  [docs/ARCHITECTURE.md §4](ARCHITECTURE.md#4-latency-budget--slo); see
  [docs/BENCHMARKS.md](BENCHMARKS.md).
- ⬜ Hosted demo environment · community templates (later).

---

Near-term order of work: land Phase 5 end to end (sector profiles consumed
everywhere, safety gates, Gmail-class primitives), then Phase 6 (live Gmail
validation, virtualized-list harvesting, resume UI, scheduler), then the
Postgres/RLS path design-first.
