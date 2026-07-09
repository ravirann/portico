# Portico — Architecture

> **Open-source, self-hostable, TypeScript-native platform that turns
> demonstration-authored automations into deterministic, self-healing, audited
> runs against authenticated portals — deployed in the operator's own
> infrastructure so credentials and sensitive data never leave it.**

Status: founding draft. Engine: [ADR-0001](decisions/0001-execution-engine.md).
Authoring: [ADR-0002](decisions/0002-agent-authoring.md).

![Portico — author once, replay deterministically](architecture.svg)

---

## 1. Overview

Existing browser-automation tools are either libraries or managed cloud
services; the production concerns around them — multi-tenant control plane,
credential vault, durable/resumable runs, audit, replay, and self-host — are
left to each team to build. Portico is an open-source platform for exactly those
concerns, and it **composes an existing execution engine rather than
reinventing one**.

Portico targets **authenticated portals the operator is entitled to access**
(e.g. healthcare payer/EHR portals), not the open web. Modern anti-bot is
behavioral and fingerprint-based, so "automate any website" is not a goal; the
focus is portals where the operator holds legitimate credentials.

## 2. Principles

1. **Deterministic-first, AI-assisted.** AI authors and heals; deterministic
   code runs. See the hard invariant in §4.
2. **Compose, don't reinvent.** The execution engine is a pluggable adapter over
   an existing engine ([ADR-0001](decisions/0001-execution-engine.md)). Portico's
   value is the platform layer, which is engine-agnostic.
3. **Self-host first.** One-command deploy in the operator's own infrastructure,
   so credentials and sensitive data never leave it.
4. **Fail safe, never guess.** On genuine change, stop with a clear reason and a
   replay — never silently do the wrong thing. Especially for writes.
5. **Connectors are the extension surface.** A connector = a target site + its
   flows + auth. Contributors fork and extend by adding connectors.

## 3. Tiered execution model

Every target is authored once by demonstration; the engine **always captures the
network** and promotes the target to the fastest *safe* tier:

| Tier | How | Latency | When |
|---|---|---|---|
| **API** | Replay captured JSON endpoints; no browser | sub-second | Portal exposes a clean, stable, auth-compatible API |
| **DOM** | Deterministic replay, cached locators, self-heal | seconds | Hardened / server-rendered portals |
| **Agent** | Planner/Actor/Validator + vision | slow | Authoring, and rare novel branches only — never a promoted hot path |

Capturing the network at authoring time is the *signal* that unlocks the API
tier; it is not always the runtime path (some portals' CSRF-bound, session-coupled
endpoints stay on the DOM tier). This is strictly more capable than a
browser-replay-only approach.

The **run tier is derived from what a run actually did** (`deriveTier` over the
step traces), not hardcoded — a run that reached its data purely via passive
interception is labeled `api`, one that drove the DOM is `dom`, one that
self-healed is `agent`.

### Authoring: demonstration → deterministic flow  ([ADR-0002](decisions/0002-agent-authoring.md))

A flow is authored **once** by demonstration, then frozen. An agent
([Stagehand](https://github.com/browserbase/stagehand)) drives the live,
authenticated session toward a plain-language goal; Portico captures **two
independent streams** and reconciles them (see the diagram above):

- the **agent action stream** — authority on INTENT + SEQUENCE (which
  interactions were deliberate), plus the element the agent resolved (an xpath);
- a **DOM click hook** — authority on ELEMENT IDENTITY (the real accessible name
  + role, captured at click time) that a resilient `getByRole(name)` / `getByText`
  locator needs at replay.

The reliable join is **exact xpath identity**: the agent's resolved xpath equals
the clean DOM-hook capture for the same control, so we recover the element's real
accessible name rather than the agent's paraphrase. The result compiles to a
frozen `intercept → navigate → act… → wait` flow — pure Libretto, no model on
replay. When the agent stream is thin or uncorrelated it falls back to the
DOM-hook path (no regression). Compiling from raw DOM clicks alone froze noise
and mis-identified elements; the agent stream supplies intent, the DOM hook the
real name — neither alone is enough. This layer is `@portico/author`, isolated
from the engine (the authoring agent pins `ai@5`; the engine uses `ai@6`).

## 4. Latency budget & SLO

Latency is a committed property, guaranteed via one rule:

> **HARD INVARIANT — No AI on the hot path.** A *promoted* flow makes **zero**
> LLM calls on its synchronous run path. LLM inference is permitted only at
> (a) authoring time and (b) in the asynchronous heal/canary lane. A promoted
> flow with an LLM call on its hot path **fails review/CI.** As long as this
> holds, a healthy run's latency is *browser speed*, not *model speed*.

### Service-level objectives (steady state, warm, pre-authenticated)

| Metric | Target |
|---|---|
| **API-tier run** (end to end) | p50 < **500 ms**, p95 < **1 s** |
| **DOM-tier run** (typical multi-step flow) | p50 < **6 s**, p95 < **12 s** |
| **Hot-path LLM calls on a promoted flow** | **0** (enforced invariant) |
| **Platform overhead per run** (queue + dispatch, excl. engine) | < **200 ms** |
| **Cold browser start** (warm-pool hit rate) | > **95%** → ~0 ms; miss ≤ 3 s |
| **Self-heal event** | +≤ **2 s once**, then cached; not counted against steady-state SLO |
| **First run** (author + login + 2FA, human-in-loop) | one-time, **out of SLO** |

Excluded from SLO (physics we don't control): the portal's own page-load/render
time, portal outages, and portal-imposed rate limits.

### Latency levers

- **No LLM in the loop** (the 10–100× lever vs per-step agents).
- **Cached locators** resolve in ms.
- **Warm session pool** — pre-spun browser contexts; no cold start.
- **Persisted trusted sessions** — login + 2FA done once; later runs skip auth.
- **Junk blocking** — fonts/analytics/trackers/images blocked during runs.
- **Event-driven waits** — never fixed sleeps.
- **Deep-linking** — navigate straight to target URLs, skip intermediate pages.
- **In-process execution** — no subprocess/interpreter cold start per run.
- **API tier** where available — no browser at all → sub-second.

### Latency ≠ throughput

For *thousands* of runs we **fan out** across the warm pool + worker fleet.
Per-run latency stays within SLO; aggregate throughput scales, bounded only by
per-credential portal rate limits (which we respect).

### Proactive heal

Canaries detect and heal drift in a **background lane** before a real run needs
it, so production runs never pay heal latency.

## 5. Reliability model

Each deterministic step stores a **cached locator** *and* a **semantic
descriptor** (role + accessible name + nearby text + authoring intent).

1. Try cached locator (ms, no LLM).
2. On failure → **AI-heal** by meaning → cache the fix → open a healing
   suggestion against the connector (shared across all instances of that
   framework).
3. If heal can't safely infer intent → **fail-safe stop** with reason + replay +
   **resume-from-step**; a human re-records that one step.

| Change | Result |
|---|---|
| Cosmetic | Unaffected |
| Structural (element moved/renamed, action exists) | **Auto-heal, cache, continue** |
| Semantic/flow change (new step, redesigned flow) | **Fail-safe**, re-record one step |
| Auth change (new 2FA/login) | Pause → HITL re-auth → resume |

Guards make heal safe: the healer operates strictly within the step's declared
intent and the policy guards. On a no-write flow there is **no commit step to
heal into** and the guard is enforced — a rogue heal is structurally impossible.

## 6. Security model

- **Isolation:** one ephemeral browser context per (tenant, credential, run);
  hardened container; **egress firewall to the target's allowed-domains only**.
  Postgres **RLS** for tenant data.
- **Secrets:** envelope encryption (KMS-wrapped DEKs); injected at runtime,
  **never persisted in run state**; **TOTP generated in-process** from a vaulted
  seed. Supports password, API key, cookie, token, session-state, TOTP.
- **Redaction by construction:** flagged secret inputs auto-masked in DOM
  traces, screenshots, replays, and logs.
- **Audit:** append-only `audit_events` (implemented; write-once, exportable);
  per-run rrweb + per-step screenshots captured to the artifact store.
- **Data residency:** self-host in the operator's infrastructure → sensitive
  data never leaves it → supports BAA / regulated-industry requirements.

## 7. Execution / workflow model

- **Flow** = versioned, typed step graph. Steps: `navigate`, `act`
  (AI-resolvable), `extract` (schema-validated), `assert`/`guard`, `download`,
  `upload`, `human` (HITL), `subflow`.
- **Run** = one execution for (tenant, credential, inputs). **Durable step
  state → resume-from-last-good-step.**
- **Guards & idempotency:** write/destructive steps require explicit `commit` +
  idempotency key; **dry-run** mode; policy engine with stop-conditions. Writes
  are idempotent so retries never double-fire.
- **HITL step** for CAPTCHA / SMS-2FA / ambiguity: pause → notify → human
  resolves → resume. We do not build CAPTCHA auto-solving.

## 8. AI strategy

LLMs are used for exactly five things, **never the hot path**: (1) authoring
(demo → compiled flow, human-reviewed), (2) healing (resolve a broken locator,
cached), (3) perception (vision fallback on DOM failure), (4) extraction
(structured data from messy pages), (5) planning (novel branches, via
Planner/Actor/Validator with a bounded action set). Model routing: small/fast
model for heal/extract; frontier only for authoring (offline); vision only on
DOM failure.

## 9. System architecture

```
Console (Next.js) · SDK (TS) · CLI · REST/Webhooks
─────────────────────────────────────────────────
CONTROL PLANE (Node/TS): registries (tenants·targets·flows·runs) ·
  scheduler · policy engine · vault interface
─────────────────────────────────────────────────
ORCHESTRATION: durable run state machine · queue → run → steps ·
  retries · resume-from-step
─────────────────────────────────────────────────
EXECUTION ENGINE (per-run, ephemeral): API → DOM → agent tiers ·
  locator cache · AI-heal   [engine adapter — see ADR-0001]
  inside → browser sandbox (1 ctx / run)
─────────────────────────────────────────────────
DATA: SQLite store (runs·steps·sessions·audit) + local artifact store
      (rrweb/screenshots) — pilot; Postgres(RLS) + KMS + object store = scale path
```

## 10. Repo structure & open-core

```
packages/  flow-spec · engine · vault · store · author
apps/      cli · console
connectors/ ·  scripts/ ·  examples/ ·  docs/
```

- **`flow-spec`** — declarative flow contract + `compileRecording` (shared, pure).
- **`engine`** — `EngineAdapter` + Libretto adapter, tiered runner, self-heal,
  `deriveTier`.  **`vault`** — secret resolution, redaction, TOTP.
  **`store`** — SQLite store (runs · steps · sessions · flows · audit · author jobs).
  **`author`** — agent authoring + two-source reconciliation (Stagehand).
- **`apps/cli`** — `portico` runner (run/validate/confirm/sessions).
  **`apps/console`** — Next.js admin console (overview · runs · flows · sessions ·
  connectors), with async agent-authoring and live timelines.

- **OSS (Apache-2.0):** engine adapter, SDK, flow spec, deterministic runtime,
  self-heal, console, single-tenant self-host, connectors, compose.
- **Commercial/cloud later:** hosted control plane, SSO/SCIM, org RBAC, managed
  secrets, SLA, autoscaling fleet, private connector registry.

## 11. Scope

TypeScript-first, self-host-first. Phase 0 proves the engine on one flow — a
scheduling flow that reaches the selection screen and **stops before any
booking**.

## Decisions

- [ADR-0001 — Execution engine](decisions/0001-execution-engine.md)
