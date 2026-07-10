# ADR-0003 — Multi-tenant scale path: Postgres + row-level security

**Status:** Proposed.
**Date:** 2026-07.

## Context

The default (and only implemented) deployment is single-node, self-hosted,
SQLite via `better-sqlite3` — the right choice for the self-host-first
principle (ARCHITECTURE.md §2.3): one operator, one process, zero external
services, one-command deploy. `packages/store/src/schema.ts` says as much at
the top: "Designed to be Postgres-upgradable: no SQLite-only column types are
used beyond `INTEGER PRIMARY KEY`" (schema.ts:6-7) — the schema was written
expecting this day would come.

It comes when Portico is offered as a service Portico itself operates for more
than one tenant. Today "tenant" is already a first-class string threaded
through `sessions` and `browser_sessions` (schema.ts:52-58, 87-96), the CLI
(`--tenant`, default `"default"`), and the console UI — but it is an
application-level partition key, not a database-enforced boundary. Nothing
today stops a bug in application code from reading tenant B's row while scoped
to tenant A; `docs/ROADMAP.md:49` already tracks this gap ("tenant scoping
exists in the store" / "Multi-tenant isolation hardening" still open).
ARCHITECTURE.md §6 already promises the fix: "Postgres **RLS** for tenant
data" (ARCHITECTURE.md:162). This ADR is that promise made concrete.

**Trigger signals** (any one is sufficient to start this migration):
- A second tenant is onboarded onto Portico-*operated* (not self-hosted)
  infrastructure.
- A compliance review (BAA-adjacent, per ARCHITECTURE.md §6 data-residency)
  requires isolation enforced by the database, not just application code.
- SQLite's single-writer model becomes the bottleneck under concurrent
  multi-tenant write load.
- The org commits to the "Commercial/cloud later" tier (ARCHITECTURE.md §10).

Until one of these fires, this stays a design document. SQLite is not a legacy
path being phased out — it is the permanent default for self-hosters, and the
only backend CI runs against.

## Decision (proposed)

**Keep `Store` as the seam.** The platform already has a precedent for this
exact move: `EngineAdapter` (`packages/engine/src/types.ts:112-123` — 1
property + 3 methods) lets the platform be built so that "the platform depends
only on the `EngineAdapter` interface (`packages/engine`); engine specifics
stay behind adapters" (CONTRIBUTING.md:46-47), while `LibrettoAdapter` and
`FallbackAdapter` compete underneath it. `Store` has no equivalent today — it
is a concrete class (`packages/store/src/store.ts:182-1132`) with no
`interface Store` / `IStore` anywhere in the package (verified by grep across
`packages/store/src/*.ts`). Extract one from its current public surface
(~50 methods, all synchronous — see below), keep today's implementation
(renamed `SqliteStore`, behavior untouched) as the default, and add `PgStore`
as a second implementation of the same interface. No call-site changes for the
SQLite path; it stays default and CI-tested.

**Naming note:** existing tenant columns are the bare word `tenant`
(schema.ts:53, 89). ARCHITECTURE.md §9 already anticipates a proper registry —
"registries (**tenants**·targets·flows·runs)" (ARCHITECTURE.md:201) — so new
columns are proposed as `tenant_id` (the natural FK name once that registry
exists), and `sessions.tenant` / `browser_sessions.tenant` are renamed
alongside them. One consistent column name, not two conventions coexisting.

**Schema mapping.** Of the store's 14 tables, 2 are already tenant-scoped, 5
need `tenant_id` added, and 7 are legitimately global:

| Table (schema.ts) | Tenant today | Postgres treatment |
|---|---|---|
| `sessions` (52-58) | Yes — `tenant` is half the PK | Rename to `tenant_id`; direct RLS policy |
| `browser_sessions` (87-96) | Yes — `tenant NOT NULL`, indexed | Rename to `tenant_id`; direct RLS policy |
| `runs` (21-35) | No | **Add `tenant_id`** — ARCHITECTURE.md:178 already defines a run as "one execution for (tenant, credential, inputs)"; the column is overdue, not new |
| `run_steps` (37-50) | No (FK to `runs` only) | **Add `tenant_id`**, denormalized from parent (see below) |
| `audit_events` (60-69) | No | **Add `tenant_id`**, nullable for platform-level events — the one table that must never leak cross-tenant |
| `run_queue` (227-239 — uncommitted as of this writing) | No | **Add `tenant_id`** — a durable queue of pending `runs`, same reasoning |
| `recordings` (152-168) | No (FK-ish via `session_id`) | **Add `tenant_id`**, denormalized from `browser_sessions`, same reasoning as `run_steps` |
| `flows` (75-85), `connectors` (116-126), `validations` (102-110) | No | **Global, stays global** — a flow/connector is shared platform content (ARCHITECTURE.md §2.5: "connectors are the extension surface"); a validation checks a flow definition, not a tenant's data |
| `author_jobs` / `author_job_events` (177-205) | No | **Global for now** — authoring targets a `connector`, itself shared; add `tenant_id` only if private per-tenant flows become a real requirement |
| `app_config` (128-137) | No | **Different axis, not tenant.** `scope` already discriminates `"global"` vs. a connector key (`apps/console/lib/store.ts:79`); leave it — a future tenant-level override should extend `scope` (e.g. `"tenant:<id>"`), not overload it with `tenant_id` |
| `schema_migrations` (249-252) | No | Instance-level, never tenant data |

For `run_steps` and `recordings`, denormalizing `tenant_id` onto the child
(rather than an RLS policy that joins back to the parent) is the
recommendation: `USING (run_id IN (SELECT id FROM runs WHERE tenant_id = ...))`
works but costs a subquery on every read of a hot child table; a direct column
keeps the policy — and the query plan — the same shape as the parent's.

**RLS shape**, applied to every tenant-scoped table above:
```sql
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON runs
  USING (tenant_id = current_setting('portico.tenant')::text);
```
`PgStore` sets the GUC with `SET LOCAL portico.tenant = $1` inside the same
transaction as the query it scopes — `SET LOCAL`, not a bare `SET`, so it
can't leak onto another query from a pooled connection. This lives in exactly
one place (a wrapper every `PgStore` method routes through), not copy-pasted
per method.

## The sync → async problem

better-sqlite3 is synchronous by construction. Every one of `Store`'s ~50
public methods returns a plain value, `void`, or `T | undefined` — never a
`Promise` (confirmed by grep: no method signature in store.ts returns
`Promise<...>`). `pg` is Promise-only. The sharper edge is
`db.transaction(...)`, better-sqlite3's synchronous transaction wrapper, used
5 times (store.ts:207, 269, 442, 452, 1050) — including one `.immediate(...)`
call (store.ts:1064) that takes Postgres's write lock up front specifically
*because* it's synchronous and shared across worker processes on one file.
`pg` has no equivalent; a Postgres transaction is hand-written
`BEGIN`/`COMMIT`/`ROLLBACK` across `await`ed calls. This gap — not the SQL
itself — is the real cost of this migration.

Options:

1. **Migrate the whole `Store` interface to async** — every method returns a
   `Promise`; `SqliteStore` wraps its already-computed sync result in
   `Promise.resolve(...)` at the boundary. Touches every call site
   (`apps/cli/src/index.ts` alone constructs `Store` 30+ times), but `main()`
   there is already `async` (index.ts:170), so most sites need only an
   inserted `await`; a few synchronous nested calls (e.g. a store read inside
   a `.map()` callback) need a small `Promise.all` restructure.
2. **Worker-thread sync bridge** — front `PgStore` with a synchronous-looking
   facade backed by `Atomics.wait` and a worker thread, so no call site
   changes at all. Rejected: it fakes synchrony over a network-bound driver by
   blocking, trading one complexity (an async call site) for a worse one (a
   thread + message-passing layer whose only job is hiding latency that should
   be visible).
3. **Two separate, unshared interfaces** — sync `Store` for SQLite, async
   `AsyncStore` for Postgres. Rejected: avoids touching SQLite call sites, but
   forks the ~50-method surface permanently; every future method is written
   and reviewed twice, and the two drift.

**Recommendation: option 1.** It is the only one of the three that is a
one-time cost rather than a standing tax. `SqliteStore`'s actual database
calls stay exactly as synchronous and as fast internally as they are today —
only the public method boundary gains a `Promise.resolve` wrapper, which
doesn't yield to the event loop in any way that changes its transaction
semantics. Pay the call-site migration once, not per method forever.

## Migration & dual-run story

A self-hoster who outgrows SQLite exports through the same shape already
shipped for audit data: `list-audit --json` (`apps/cli/src/index.ts:277`)
reads a table via `store.listAudit()` and writes one `JSON.stringify`d array to
stdout; `list-runs`, `list-flows`, `list-sessions`, `list-connectors`, and
`list-recordings` share the same `store.listX() → emit()` shape (`emit()` at
index.ts:131). None of them stream today (no NDJSON mode anywhere in the CLI
or store package) and there is no `import` counterpart at all — export-only.
Generalizing this into `portico export --all` (one JSON file per table, NDJSON
if a table grows large) plus a new `portico import --db <pg-url>` that loads
them into `PgStore` in dependency order (connectors/flows first; then
sessions/runs/run_steps/run_queue; then audit_events last) is additive to a
pattern that already exists, not new plumbing.

What never moves to Postgres: local dev, single-operator self-host, and CI.
Both are explicit in ARCHITECTURE.md — "self-host first" (§2.3) and
"single-tenant self-host" as the OSS tier (§10) — so SQLite isn't a
way-station on the road to Postgres for every deployment, only for the hosted
multi-tenant one.

## Consequences

- `Store` becomes an interface; `SqliteStore` is today's class plus a
  `Promise.resolve` skin, not a rewrite. File layout, `StoreOptions.dbPath` /
  `dataDir` (store.ts:41-50), and CI are unaffected.
- Five tables gain `tenant_id` in a Postgres-only path (`runs`, `run_steps`,
  `audit_events`, `run_queue`, `recordings`); two existing `tenant` columns are
  renamed for consistency. SQLite's `MIGRATIONS` array (schema.ts) is
  untouched by this ADR.
- Every `Store` call site becomes `await`-bearing — mechanical and one-time,
  largest surface `apps/cli/src/index.ts`'s 30+ construction sites — not an
  ongoing design risk.
- Closes `docs/ROADMAP.md:49`'s "Multi-tenant isolation hardening" once
  implemented.

**Explicitly deferred:**
- Per-tenant envelope-encryption key hierarchy (today's KMS-wrapped DEKs,
  ARCHITECTURE.md:163, are not tenant-scoped).
- Connection pooling and how `SET LOCAL portico.tenant` interacts with a
  transaction-mode pooler (pgbouncer).
- Read replicas / read-write split.
- Tenant-scoping `flows` / `connectors` / `author_jobs` — only if/when private
  per-tenant connectors become a real request, not speculatively now.
