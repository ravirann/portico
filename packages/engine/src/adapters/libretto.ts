/**
 * Libretto engine adapter (ADR-0001 — accepted engine).
 *
 * Thin boundary over the compiler + runner. A Portico `Flow` is compiled to
 * Libretto's canonical `workflow()` artifact (Zod input/output, `credentials`,
 * `authProfile`, `startUrl`, `viewport`, `recoveryAction`) and executed in-process
 * by the runner (`launchBrowser` → page → compiled plan). See ./compiler.ts and
 * ./runner.ts.
 *
 * Wired Libretto APIs: `launchBrowser`, `workflow`, `createRecoveryPage` +
 * `attemptWithRecovery` (model-gated recovery), `extractFromPage`, `pageRequest`
 * (API tier), `librettoAuthenticate` + `authProfile` (session persistence),
 * `pause` (HITL). See the README/report for the full map.
 *
 * HARD INVARIANT (docs/ARCHITECTURE.md §4): a promoted deterministic replay makes
 * ZERO model calls. Recovery and `extractFromPage` are the author/heal tier — only
 * reached on failure or when a step has no cached locator — never the hot path.
 */

import type {
  EngineAdapter,
  EngineCapabilities,
  EngineRunOptions,
  EngineRunResult,
} from "../types.js";
import { healModelConfigured } from "../model.js";
import { runFlow, runnerMode } from "../runner.js";

export class LibrettoAdapter implements EngineAdapter {
  readonly name = "libretto";

  capabilities(): EngineCapabilities {
    return {
      // API-tier execution is implemented (pageRequest) for flow-marked steps.
      // We do NOT yet do author-time network capture → auto-promotion, so this
      // stays honest about *execution*, not capture-based promotion.
      apiPromotion: true,
      // HONEST + dynamic: self-heal exists only when a recovery model is configured.
      selfHeal: healModelConfigured(),
      // In-process by default; false when routed through the CLI subprocess runner.
      inProcess: runnerMode() === "programmatic",
    };
  }

  run(opts: EngineRunOptions): Promise<EngineRunResult> {
    return runFlow(opts);
  }
}
