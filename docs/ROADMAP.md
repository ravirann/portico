# Portico Roadmap

Status: ✅ done · 🟡 in progress · ⬜ planned. Self-host / local-first and OSS
throughout; cloud/managed features are a later open-core layer, never a
dependency for running Portico yourself.

## Phase 0 — Foundation ✅

Repo structure · OSS community files · CI/lint/tests · architecture docs +
diagram · branding.

## Phase 1 — Runtime foundation ✅

Flow / run / session model (SQLite store) · Libretto worker loop (in-process) ·
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

## Phase 5 — Ecosystem (OSS) ⬜

- **Public adapter SDK** — the `EngineAdapter` seam documented + packaged, so a
  different engine can be dropped in.
- **Example connector packs & templates** — starter connectors beyond the
  example portal.
- **Local benchmark suite** — measure API / DOM tier latencies against a local
  target, tracked over time.
- Hosted demo environment · community templates (later).

---

Near-term order of work: finish Phase 3 (eval + version tracking), then land the
Phase 4/5 OSS-local foundation (local deploy, adapter SDK, benchmark), then the
heavier Phase 4 items (RBAC, Postgres/RLS path) design-first.
