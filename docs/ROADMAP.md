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

## Phase 3 — Authoring & AI-assisted recovery 🟡

**Done:** self-heal (locator repair, cached) · schema-validated extraction ·
human-in-the-loop review · **agent authoring by demonstration + two-source
reconciliation (exact-xpath join), validated end-to-end against a live portal
([ADR-0002](decisions/0002-agent-authoring.md)).**

**Next (to finish the phase):**
- Eval suite — score authoring + heal quality (clean-name rate, no container-id
  / blob, reconciliation confidence) over saved capture fixtures, run in CI so
  regressions are caught automatically.
- Prompt / model-version tracking — record the model + prompt version on each
  authored flow and heal event, for reproducibility.
- Generalize beyond one portal — a second EHR/insurer fixture in the
  `generalize` suite, to prove the reconciliation is portal-agnostic.

## Phase 4 — Production readiness (OSS, self-host, local-first) ⬜

- **One-command local self-host** — `docker-compose` (console + engine + store),
  a Dockerfile per app, and a deploy guide. No cloud dependency.
- **Secrets** — envelope encryption today (in-process, KMS-free); document a
  local OSS option (age / SOPS) for at-rest key management.
- **Audit** — append-only `audit_events` exists; add export + a console view.
- **RBAC** — roles (viewer / operator / admin) enforced in the console + API.
- **Multi-tenant isolation hardening** — tenant scoping exists in the store;
  Postgres + row-level security as the scale path (SQLite stays the local default).
- **Worker concurrency** — bounded parallel runs across the session pool.
- **Connector pack / plugin system** — package a connector + its flows + auth.

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
