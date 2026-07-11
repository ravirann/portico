# Adapter SDK — the `EngineAdapter` seam

> Documents the actual interface in `packages/engine/src/types.ts`. Every type
> and method named below exists verbatim in that file — line numbers are cited
> so you can check this doc against the source directly.

## Why this seam exists

Portico's platform layer (control plane, vault, multi-tenancy, audit,
connectors) depends on a single interface, `EngineAdapter`, not on any
particular automation engine. [ADR-0001](decisions/0001-execution-engine.md)
adopted [Libretto](https://github.com/saffron-health/libretto) as the shipped
engine, but put it "behind the `EngineAdapter` interface (`packages/engine`)"
specifically so the choice is **"reversible and swappable per-connector
without touching the platform layer"** (ADR-0001, "Decision"). A stub adapter,
`FallbackAdapter`, exists purely to document that seam:

> "A placeholder that keeps the engine choice reversible: the platform depends
> only on `EngineAdapter`, so an alternative engine can be dropped in here
> without touching anything else."
> — `packages/engine/src/adapters/fallback.ts:3-6`

[ADR-0004](decisions/0004-own-engine.md) is that reversibility exercised for
real: Libretto was retired and replaced by `PorticoAdapter`, an in-house
engine built directly on Playwright, without the platform layer changing at
all — every call site still only touches `EngineAdapter`. The `libretto` npm
dependency is gone from `package.json`; `"libretto"` survives only as a
deprecated selector alias in the adapter registry (see "How an engine is
selected today" below).

This doc is for anyone implementing a second real adapter (a different
automation engine, a mock for testing, etc.).

## The `EngineAdapter` interface

Source: `packages/engine/src/types.ts:133-144`.

```ts
export interface EngineAdapter {
  readonly name: string;
  capabilities(): EngineCapabilities;

  /** Deterministic replay of a promoted flow. MUST make zero LLM calls on the
   *  hot path (see docs/ARCHITECTURE.md §4 hard invariant). */
  run(opts: EngineRunOptions): Promise<EngineRunResult>;

  /** Author a flow from a live demonstration (LLM allowed — off the hot path).
   *  Optional: engines that can't author are used replay-only. */
  author?(opts: { target: Target; auth: AuthContext }): Promise<AuthoredFlow>;
}
```

Four members, all real:

| Member | Signature | Line |
|---|---|---|
| `name` | `readonly name: string` | `types.ts:134` |
| `capabilities` | `capabilities(): EngineCapabilities` | `types.ts:135` |
| `run` | `run(opts: EngineRunOptions): Promise<EngineRunResult>` | `types.ts:139` |
| `author` | `author?(opts: { target: Target; auth: AuthContext }): Promise<AuthoredFlow>` | `types.ts:143` |

### `name`

A stable identifier for the adapter instance. `PorticoAdapter.name` is,
deliberately, still the literal string `"libretto"` (`adapters/portico.ts:34`)
— kept as a stable, external-facing identifier unrelated to (and outliving)
the removed npm dependency of the same name; see the class's own header
comment for the rationale. `FallbackAdapter.name` is `"fallback"`
(`fallback.ts:17`). It's used for logging/telemetry — e.g. the CLI prints
`` `▶ running flow "${flow.key}" via ${engine.name} …` `` (`apps/cli/src/index.ts:1242`),
which today prints `via libretto` even though the engine is *selected* via
`getEngine("portico")` a few lines above — the registry key and the adapter's
own `name` field are two different strings by design; don't conflate them.

### `capabilities()`

Returns an `EngineCapabilities` describing what this adapter actually does —
see below. Both shipped adapters treat this as an honesty contract, not a
wishlist:

- `FallbackAdapter.capabilities()` — "Placeholder: advertises nothing it does
  not implement" → `{ apiPromotion: false, selfHeal: false, inProcess: true }`
  (`fallback.ts:19-22`).
- `PorticoAdapter.capabilities()` — `selfHeal` is computed from
  `healModelConfigured()` at call time: "HONEST + dynamic: self-heal exists
  only when a recovery model is configured"; `inProcess` reflects
  `runnerMode() === "programmatic"`, the only mode ADR-0004 leaves standing
  (`portico.ts:36-48`).

Follow the same convention in your own adapter: don't hardcode `true` for
something you haven't wired up.

### `run(opts)`

The hot path. Its doc comment is the load-bearing constraint: **"MUST make
zero LLM calls on the hot path"** (`types.ts:137-138`), which is the same
invariant [ARCHITECTURE.md §4](ARCHITECTURE.md) states as a hard rule:

> **HARD INVARIANT — No AI on the hot path.** A *promoted* flow makes **zero**
> LLM calls on its synchronous run path. LLM inference is permitted only at
> (a) authoring time and (b) in the asynchronous heal/canary lane.
> — `docs/ARCHITECTURE.md:96-98`

`PorticoAdapter.run` is a one-line passthrough to the compiler/runner:
`run(opts) { return runFlow(opts); }` (`portico.ts:50-52`). `FallbackAdapter.run`
intentionally throws — it's unwired, not a real implementation
(`fallback.ts:24-26`).

### `author?(opts)`

Optional — "engines that can't author are used replay-only" (`types.ts:142`).
**Neither shipped adapter implements it today**: it's absent from both
`FallbackAdapter` and `PorticoAdapter`. In the current codebase, authoring
(demonstration → compiled flow) is done by the separate `@portico/author`
package, which does not implement or call `EngineAdapter` at all — see
[ARCHITECTURE.md §3](ARCHITECTURE.md), "This layer is `@portico/author`,
isolated from the engine" (`docs/ARCHITECTURE.md:87-88`). Treat `author?` as a
real, typed extension point for an engine that *can* drive authoring
end-to-end — just know it's currently unused plumbing, not a proven path.

Note its parameter type is an inline object literal (`{ target: Target; auth:
AuthContext }`), not `EngineRunOptions` — don't conflate the two.

## Supporting types

All from `packages/engine/src/types.ts` unless noted.

### `RunMode` (line 10)

```ts
export type RunMode = "dry_run" | "live";
```

### `AuthContext` (lines 13-18)

```ts
export interface AuthContext {
  /** Resolved secret values keyed by reference (password, apiKey, totpSeed, …). */
  secrets: Record<string, string>;
  /** A persisted trusted-device session (cookies + storage) to skip login/2FA. */
  sessionState?: unknown;
}
```

Secrets are resolved (by `@portico/vault`) before they reach the adapter —
`run()` never sees a secret *reference*, only its resolved value, and never
persists it itself.

### `StepStatus` / `StepTrace` (lines 20, 22-36)

```ts
export type StepStatus = "ok" | "healed" | "failed" | "skipped" | "paused";

export interface StepTrace {
  index: number;
  type: string;
  label?: string;
  status: StepStatus;
  detail?: string;
  /** Set when a locator was self-healed, for the audit/suggestion pipeline. */
  healedFrom?: string;
  healedTo?: string;
  screenshotRef?: string;
  startedAt: number;
  endedAt: number;
  /** Classified failure kind (see errors.ts StepErrorKind) — set on "failed" traces. */
  errorKind?: string;
}
```

Emitted per step during `run()` via `opts.onStep` (see `EngineRunOptions`
below), and collected into `EngineRunResult.traces`.

### `RunStatus` / `EngineRunResult` (lines 38, 40-60)

```ts
export type RunStatus = "completed" | "failed" | "paused";

export interface EngineRunResult {
  status: RunStatus;
  /** Schema-validated outputs from `extract` steps. */
  output: Record<string, unknown>;
  traces: StepTrace[];
  /** Reference to the captured session recording (rrweb events file or video). */
  rrwebRef?: string;
  /** Present when status = failed | paused. `paused` ⇒ HITL/resume needed. */
  failure?: { stepIndex: number; reason: string; resumable: boolean; kind?: string };
  /** Updated trusted session to persist back to the vault, if it changed. */
  sessionState?: unknown;
  /** Output keys whose extracted/intercepted value did NOT pass its declared
   *  schema — the raw value is still stored (never dropped), just flagged. */
  unvalidatedOutputKeys?: string[];
  /** The auth profile (auth-profile.ts) this run loaded/refreshed, if any. */
  authProfile?: string;
  /** Mutating `act` steps skipped outside live mode (dry-run safety gate). Only set when non-empty. */
  skippedMutations?: string[];
  /** Requests blocked by the egress boundary, as "METHOD host" strings. Only set when non-empty. */
  blockedRequests?: string[];
}
```

`failure.kind`, `skippedMutations`, and `blockedRequests` are later,
reliability-phase additions (structured error taxonomy, dry-run mutation
gate, egress enforcement — see [docs/RELIABILITY.md](RELIABILITY.md));
included here so this block stays verbatim against current `types.ts`.

`authProfile` is named after Portico's own auth-profile concept
(`auth-profile.ts`; see `EngineRunOptions.profileId` below) — a generic
adapter can leave it `undefined`.

### `EngineRunOptions` (lines 62-111)

```ts
export interface EngineRunOptions {
  target: Target;
  flow: Flow;
  inputs: Record<string, unknown>;
  auth: AuthContext;
  mode: RunMode;
  /** Live step tracing for the console. */
  onStep?: (trace: StepTrace) => void;
  /** Interactive HITL handler (e.g. wait for the human to log in + 2FA). If
   *  provided, a `human` step awaits it and continues; otherwise it pauses. */
  onHuman?: (step: { index: number; label?: string }) => Promise<void>;
  /** Resume a previously paused run from this step index (durable resume). */
  resumeFrom?: number;
  signal?: AbortSignal;
  /** Run the browser headless (true) or headed (false). Defaults to headless. */
  headless?: boolean;
  /**
   * Stable id used to derive the **auth profile** name (auth-profile.ts) so
   * that a one-time login persists to `.portico/profiles/<name>.json` and
   * later runs skip auth. Typically a target/credential id. When absent, no
   * profile is loaded or written (fresh browser every run).
   */
  profileId?: string;
  /**
   * Attach to an ALREADY-RUNNING browser over CDP (e.g. `http://localhost:9222`)
   * instead of launching one. The browser keeps its logged-in session between
   * runs, so you log in ONCE (in that browser) and every run reuses it — no
   * re-login. Started via `scripts/serve-browser.mjs`. Takes precedence over
   * profileId; the attached browser is never closed by the run.
   */
  cdpEndpoint?: string;
  /** Where to write session recordings + per-step screenshots. Defaults to
   *  `<repo>/data/artifacts`. Recording is best-effort and never fails a run. */
  artifactsDir?: string;
  /** Capture rrweb/screenshots. Defaults to true; set false for speed. */
  record?: boolean;
  /** Sector profile key (see @portico/flow-spec SectorKey) selecting
   *  reliability defaults (timeouts, retries, readiness gates, mutation
   *  guards). Falls back to `flow.sector`, then the generic profile. */
  sector?: string;
  /** Hard network-egress boundary: when non-empty (and PORTICO_EGRESS_ENFORCE
   *  !== "0"), a main-frame navigation or any mutating (non-GET/HEAD/OPTIONS)
   *  request to a host outside this list is aborted before it leaves the
   *  browser. GET subresources (CDNs, fonts, analytics) always pass. */
  allowedDomains?: string[];
  /** Seed `output` with prior values before replay — combined with
   *  `resumeFrom`, this lets a resumed run's templated {{output.x}}
   *  references resolve to what an earlier (paused) attempt already produced. */
  resumeOutput?: Record<string, unknown>;
}
```

`sector`, `allowedDomains`, and `resumeOutput` are later, reliability-phase
additions (see [docs/RELIABILITY.md](RELIABILITY.md) and
[docs/SECTORS.md](SECTORS.md)); included here so this block stays verbatim
against current `types.ts`, same as `EngineRunResult` above.

`target: Target` and `flow: Flow` are **not defined in this package** — they
come from `@portico/flow-spec` (`packages/flow-spec/src/index.ts:129-137` and
`:140-147`) and are only `import type`-ed here, not re-exported. See "A note
on `Flow`/`Target` imports" below — a real gotcha if you copy-paste imports
from this doc.

`profileId` and `cdpEndpoint` are session-reuse concepts specific to how
`PorticoAdapter`'s runner interprets them (profile files under
`.portico/profiles`, CDP attach) — generic fields on `EngineRunOptions`, but
a different engine's adapter can ignore them. Don't repurpose the field names
for something else — callers (the CLI, the console) pass them expecting this
documented behavior.

### `EngineCapabilities` (lines 113-123)

```ts
export interface EngineCapabilities {
  /** Can execute API-tier steps directly (via page-request.ts's `pageRequest`),
   *  for steps/flows the flow-spec marks API-eligible. */
  apiPromotion: boolean;
  /** Self-heals at run time via the recovery model. HONEST + dynamic: true only
   *  when a heal model is configured (PORTICO_HEAL_* / provider API key). With no
   *  model the deterministic path still runs, but there is no self-heal. */
  selfHeal: boolean;
  /** Runs in-process (vs CLI/subprocess) — decides multi-tenant/latency shape. */
  inProcess: boolean;
}
```

These three flags map to concepts in [ARCHITECTURE.md §3](ARCHITECTURE.md)
(tiered execution: API / DOM / Agent) and §4 (latency SLOs) — `apiPromotion`
is the API tier, `selfHeal` is the heal lane, `inProcess` decides whether a
run pays subprocess-launch cost.

### `AuthoredFlow` (lines 126-131)

```ts
export interface AuthoredFlow {
  flow: Flow;
  /** True if network capture showed a clean API → eligible for the API tier. */
  apiTierEligible: boolean;
  capture?: unknown;
}
```

Return type of the optional `author?()` method — see above.

## How an engine is selected today

Source: `packages/engine/src/index.ts`.

```ts
// "portico" is the canonical engine since ADR-0004; "libretto" survives only
// as a deprecated selector alias — see adapters/portico.ts's header.
export type EngineName = "portico" | "libretto" | "fallback";    // line 44

const REGISTRY: Record<EngineName, () => EngineAdapter> = {      // lines 46-50
  portico: () => new PorticoAdapter(),
  libretto: () => new PorticoAdapter(),
  fallback: () => new FallbackAdapter(),
};

/** Resolve the engine for a run. Defaults to Portico's own engine. */
export function getEngine(name: EngineName = "portico"): EngineAdapter {  // lines 53-57
  const make = REGISTRY[name];
  if (!make) throw new Error(`Unknown engine '${name}'. Known: ${Object.keys(REGISTRY).join(", ")}`);
  return make();
}
```

This is a **closed, static map over exactly three names** — there is no
dynamic plugin-registration function (no `registerEngine()` or similar)
anywhere in the codebase. `EngineName` is a three-member string-literal
union, so `REGISTRY` is exhaustive by construction. `"portico"` and
`"libretto"` both construct a `PorticoAdapter` — they are the same engine
under two selector names, not two engines.

Real call site, `apps/cli/src/index.ts:1239,1255-1270`:

```ts
const engine = getEngine("portico");
const mode: RunMode = opts.live ? "live" : "dry_run";
const result = await engine.run({
  target,
  flow,
  inputs: opts.inputs,
  auth: { secrets },
  mode,
  headless: opts.headless,
  profileId: opts.profile,
  cdpEndpoint: opts.cdp,
  onHuman,
  onStep: (t) => log(`  [${t.index}] ${t.type}${t.label ? ` — ${t.label}` : ""}: ${t.status}${t.detail ? ` (${t.detail})` : ""}`),
  sector,
  allowedDomains,
  resumeFrom: opts.resumeFrom,
  resumeOutput: resumeOutputValue,
});
```

Everything downstream of `getEngine(...)` only ever touches the
`EngineAdapter` interface (`engine.name`, `engine.run(...)`) — never a
`PorticoAdapter`-specific type. That's the seam ADR-0001 established and
ADR-0004 exercised: the shipped engine changed underneath it, and this call
site didn't (only its selector string did, from `"libretto"` to `"portico"`).

## Implementing a custom adapter

`FallbackAdapter` (`packages/engine/src/adapters/fallback.ts`) is the
reference shape — it's intentionally the smallest possible adapter, minus a
real `run()` body (it throws). Here's the same shape filled in:

```ts
// packages/engine/src/adapters/my-engine.ts
import type {
  EngineAdapter,
  EngineCapabilities,
  EngineRunOptions,
  EngineRunResult,
  StepTrace,
} from "../types.js";

export class MyEngineAdapter implements EngineAdapter {
  readonly name = "my-engine";

  capabilities(): EngineCapabilities {
    // Advertise only what you've actually wired up — see the "HONEST +
    // dynamic" convention on PorticoAdapter (adapters/portico.ts:43-44).
    return { apiPromotion: false, selfHeal: false, inProcess: true };
  }

  async run(opts: EngineRunOptions): Promise<EngineRunResult> {
    const traces: StepTrace[] = [];

    for (const [index, step] of opts.flow.steps.entries()) {
      if (opts.signal?.aborted) {
        return {
          status: "failed",
          output: {},
          traces,
          failure: { stepIndex: index, reason: "aborted", resumable: true },
        };
      }

      const startedAt = Date.now();
      // --- Replace this block with your engine's real step execution. ---
      const trace: StepTrace = {
        index,
        type: step.type,
        label: step.label,
        status: "ok",
        startedAt,
        endedAt: Date.now(),
      };
      traces.push(trace);
      opts.onStep?.(trace);
    }

    return { status: "completed", output: {}, traces };
  }

  // `author?` is optional — omit it entirely if your engine is replay-only,
  // exactly like FallbackAdapter and PorticoAdapter both do today.
}
```

This compiles against the real interface: `step.type` and `step.label` come
from `Step` in `@portico/flow-spec` (`packages/flow-spec/src/index.ts:46-49`),
and every field set on `trace`/the returned `EngineRunResult` matches the
required vs. optional fields listed above.

### Wiring it in

There is no plugin-registration API — `getEngine`'s `REGISTRY` is a closed
map inside `packages/engine`. Two honest options:

**Option A — extend the registry (requires editing `packages/engine`):**

```ts
// packages/engine/src/index.ts
export type EngineName = "portico" | "libretto" | "fallback" | "my-engine";

const REGISTRY: Record<EngineName, () => EngineAdapter> = {
  portico: () => new PorticoAdapter(),
  libretto: () => new PorticoAdapter(),
  fallback: () => new FallbackAdapter(),
  "my-engine": () => new MyEngineAdapter(),
};
```

**Option B — bypass `getEngine` entirely.** Nothing outside `packages/engine`
depends on `REGISTRY` — only on the `EngineAdapter` type. Anywhere the
platform currently does `getEngine("portico")` (e.g. `apps/cli/src/index.ts:1239`),
construct your adapter directly instead:

```ts
import type { EngineAdapter } from "@portico/engine";
import { MyEngineAdapter } from "./my-engine.js";

const engine: EngineAdapter = new MyEngineAdapter();
const result = await engine.run({ target, flow, inputs, auth: { secrets }, mode: "dry_run" });
```

Option B is what "swappable per-connector" (ADR-0001) implies in practice
today: pick the adapter per call site, since the registry itself doesn't
support per-connector selection yet.

### A note on `Flow`/`Target` imports

`packages/engine/src/index.ts:10` re-exports everything from `types.ts` via
`export * from "./types.js"`, but `types.ts` only *imports* `Flow` and
`Target` from `@portico/flow-spec` (`import type { Flow, Target } from
"@portico/flow-spec";`, `types.ts:8`) — it does not re-export them. So:

```ts
// Works — these are genuinely exported from types.ts:
import type { EngineAdapter, EngineRunOptions, EngineRunResult } from "@portico/engine";

// Needed separately — Flow/Target are @portico/flow-spec's, not @portico/engine's:
import type { Flow, Target } from "@portico/flow-spec";
```

## Reference adapters in this repo

| Adapter | File | Role |
|---|---|---|
| `FallbackAdapter` | `packages/engine/src/adapters/fallback.ts` | Minimal placeholder; `run()` throws. Not wired into any real path — exists to document the seam. |
| `PorticoAdapter` | `packages/engine/src/adapters/portico.ts` | The in-house engine (ADR-0001 accepted an engine behind this seam; ADR-0004 brought the engine itself in-house, replacing what was `LibrettoAdapter`). `run()` delegates to `runFlow` (`../runner.js`); `capabilities()` reads live config (`healModelConfigured()`, `runnerMode()`). Registered under both the `"portico"` (canonical) and `"libretto"` (deprecated alias) selector keys — see above. |

Both are constructed only through `REGISTRY` in `packages/engine/src/index.ts:46-50`,
never instantiated directly outside that file (confirmed: no other source file
in the repo references `PorticoAdapter` or `FallbackAdapter` by name — only
generated `dist/` output does).

## Checklist for a new adapter

- [ ] `run()` makes **zero LLM calls** on a promoted/replay path (`types.ts:137-138`,
      `ARCHITECTURE.md:96-98`).
- [ ] `capabilities()` reports only what's actually implemented — recompute
      dynamically if it depends on runtime config (see `PorticoAdapter.selfHeal`).
- [ ] Respect `opts.signal` for cancellation and `opts.mode` (`dry_run` vs `live`)
      if your engine can distinguish them.
- [ ] Call `opts.onStep` per step if you want live tracing in the console/CLI;
      it's optional (`onStep?:`) but that's the only hook that populates
      per-step feedback during a run.
- [ ] Only implement `author?()` if your engine can genuinely drive an
      authoring session end-to-end — leaving it unimplemented (like both
      shipped adapters) is a normal, supported choice.
- [ ] Decide Option A vs Option B above for wiring the adapter in, since there
      is no dynamic registration API.
