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

This doc is for anyone implementing a second real adapter (a different
automation engine, a mock for testing, etc.).

## The `EngineAdapter` interface

Source: `packages/engine/src/types.ts:112-123`.

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
| `name` | `readonly name: string` | `types.ts:113` |
| `capabilities` | `capabilities(): EngineCapabilities` | `types.ts:114` |
| `run` | `run(opts: EngineRunOptions): Promise<EngineRunResult>` | `types.ts:118` |
| `author` | `author?(opts: { target: Target; auth: AuthContext }): Promise<AuthoredFlow>` | `types.ts:122` |

### `name`

A stable identifier for the adapter, e.g. `"libretto"` (`libretto.ts:30`) or
`"fallback"` (`fallback.ts:17`). It's used for logging/telemetry — e.g. the CLI
prints `` `▶ running flow "${flow.key}" via ${engine.name} …` `` (`apps/cli/src/index.ts:779`).

### `capabilities()`

Returns an `EngineCapabilities` describing what this adapter actually does —
see below. Both shipped adapters treat this as an honesty contract, not a
wishlist:

- `FallbackAdapter.capabilities()` — "Placeholder: advertises nothing it does
  not implement" → `{ apiPromotion: false, selfHeal: false, inProcess: true }`
  (`fallback.ts:19-22`).
- `LibrettoAdapter.capabilities()` — `selfHeal` is computed from
  `healModelConfigured()` at call time: "HONEST + dynamic: self-heal exists
  only when a recovery model is configured" (`libretto.ts:32-43`).

Follow the same convention in your own adapter: don't hardcode `true` for
something you haven't wired up.

### `run(opts)`

The hot path. Its doc comment is the load-bearing constraint: **"MUST make
zero LLM calls on the hot path"** (`types.ts:116-117`), which is the same
invariant [ARCHITECTURE.md §4](ARCHITECTURE.md) states as a hard rule:

> **HARD INVARIANT — No AI on the hot path.** A *promoted* flow makes **zero**
> LLM calls on its synchronous run path. LLM inference is permitted only at
> (a) authoring time and (b) in the asynchronous heal/canary lane.
> — `docs/ARCHITECTURE.md:91-95`

`LibrettoAdapter.run` is a one-line passthrough to the compiler/runner:
`run(opts) { return runFlow(opts); }` (`libretto.ts:45-47`). `FallbackAdapter.run`
intentionally throws — it's unwired, not a real implementation
(`fallback.ts:24-26`).

### `author?(opts)`

Optional — "engines that can't author are used replay-only" (`types.ts:121`).
**Neither shipped adapter implements it today**: it's absent from both
`FallbackAdapter` and `LibrettoAdapter`. In the current codebase, authoring
(demonstration → compiled flow) is done by the separate `@portico/author`
package, which does not implement or call `EngineAdapter` at all — see
[ARCHITECTURE.md §3](ARCHITECTURE.md), "This layer is `@portico/author`,
isolated from the engine" (`docs/ARCHITECTURE.md:84`). Treat `author?` as a
real, typed extension point for an engine that *can* drive authoring
end-to-end — just know it's currently unused plumbing, not a proven path.

Note its parameter type is an inline object literal (`{ target: Target; auth:
AuthContext }`), not `EngineRunOptions` — don't conflate the two.

## Supporting types

All from `packages/engine/src/types.ts` unless noted.

### `RunMode` (line 9)

```ts
export type RunMode = "dry_run" | "live";
```

### `AuthContext` (lines 12-17)

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

### `StepStatus` / `StepTrace` (lines 19, 21-33)

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
}
```

Emitted per step during `run()` via `opts.onStep` (see `EngineRunOptions`
below), and collected into `EngineRunResult.traces`.

### `RunStatus` / `EngineRunResult` (lines 35, 37-52)

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
  failure?: { stepIndex: number; reason: string; resumable: boolean };
  /** Updated trusted session to persist back to the vault, if it changed. */
  sessionState?: unknown;
  /** Output keys that could NOT be schema-validated (no model → raw-DOM fallback). */
  unvalidatedOutputKeys?: string[];
  /** The Libretto auth profile this run loaded/refreshed, if any. */
  authProfile?: string;
}
```

`authProfile` is named after Libretto's own concept (see `EngineRunOptions.profileId`
below) — a generic adapter can leave it `undefined`.

### `EngineRunOptions` (lines 54-90)

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
   * Stable id used to derive the Libretto **auth profile** name so that a
   * one-time login persists to `.libretto/profiles/<name>.json` and later runs
   * skip auth. Typically a target/credential id. When absent, no profile is
   * loaded or written (fresh browser every run).
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
}
```

`target: Target` and `flow: Flow` are **not defined in this package** — they
come from `@portico/flow-spec` (`packages/flow-spec/src/index.ts:129-137` and
`:140-147`) and are only `import type`-ed here, not re-exported. See "A note
on `Flow`/`Target` imports" below — a real gotcha if you copy-paste imports
from this doc.

`profileId` and `cdpEndpoint` are Libretto-specific session-reuse concepts
(profile files, CDP attach). A different engine's adapter can ignore them,
but should not repurpose the field names for something else — callers
(the CLI, the console) pass them expecting this documented behavior.

### `EngineCapabilities` (lines 92-102)

```ts
export interface EngineCapabilities {
  /** Can execute API-tier steps directly (via Libretto `pageRequest`), for
   *  steps/flows the flow-spec marks API-eligible. */
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

### `AuthoredFlow` (lines 104-110)

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
export type EngineName = "libretto" | "fallback";               // line 39

const REGISTRY: Record<EngineName, () => EngineAdapter> = {      // lines 41-44
  libretto: () => new LibrettoAdapter(),
  fallback: () => new FallbackAdapter(),
};

/** Resolve the engine for a run. Defaults to the pilot engine (Libretto). */
export function getEngine(name: EngineName = "libretto"): EngineAdapter {  // lines 47-51
  const make = REGISTRY[name];
  if (!make) throw new Error(`Unknown engine '${name}'. Known: ${Object.keys(REGISTRY).join(", ")}`);
  return make();
}
```

This is a **closed, static map over exactly two names** — there is no dynamic
plugin-registration function (no `registerEngine()` or similar) anywhere in
the codebase. `EngineName` is a two-member string-literal union, so
`REGISTRY` is exhaustive by construction.

Real call site, `apps/cli/src/index.ts:776,792-803`:

```ts
const engine = getEngine("libretto");
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
});
```

Everything downstream of `getEngine(...)` only ever touches the
`EngineAdapter` interface (`engine.name`, `engine.run(...)`) — never a
Libretto-specific type. That's the seam ADR-0001 is describing.

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
    // dynamic" convention on LibrettoAdapter (adapters/libretto.ts:38-39).
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
  // exactly like FallbackAdapter and LibrettoAdapter both do today.
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
export type EngineName = "libretto" | "fallback" | "my-engine";

const REGISTRY: Record<EngineName, () => EngineAdapter> = {
  libretto: () => new LibrettoAdapter(),
  fallback: () => new FallbackAdapter(),
  "my-engine": () => new MyEngineAdapter(),
};
```

**Option B — bypass `getEngine` entirely.** Nothing outside `packages/engine`
depends on `REGISTRY` — only on the `EngineAdapter` type. Anywhere the
platform currently does `getEngine("libretto")` (e.g. `apps/cli/src/index.ts:776`),
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

`packages/engine/src/index.ts:9` re-exports everything from `types.ts` via
`export * from "./types.js"`, but `types.ts` only *imports* `Flow` and
`Target` from `@portico/flow-spec` (`import type { Flow, Target } from
"@portico/flow-spec";`, `types.ts:7`) — it does not re-export them. So:

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
| `LibrettoAdapter` | `packages/engine/src/adapters/libretto.ts` | The accepted, shipped engine (ADR-0001). `run()` delegates to `runFlow` (`../runner.js`); `capabilities()` reads live config (`healModelConfigured()`, `runnerMode()`). |

Both are constructed only through `REGISTRY` in `packages/engine/src/index.ts:41-44`,
never instantiated directly outside that file (confirmed: no other file in the
repo references `LibrettoAdapter` or `FallbackAdapter` by name).

## Checklist for a new adapter

- [ ] `run()` makes **zero LLM calls** on a promoted/replay path (`types.ts:116-117`,
      `ARCHITECTURE.md:91-95`).
- [ ] `capabilities()` reports only what's actually implemented — recompute
      dynamically if it depends on runtime config (see `LibrettoAdapter.selfHeal`).
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
