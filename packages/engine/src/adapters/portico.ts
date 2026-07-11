/**
 * Portico's own engine adapter (ADR-0001 — accepted engine; ADR-0004 — the
 * engine is now in-house, on Playwright, rather than composed from a
 * third-party automation library).
 *
 * Thin boundary over the compiler + runner. A Portico `Flow` is compiled
 * (compiler.ts) to an instrumented step plan and executed in-process by the
 * runner (launch.ts/runner.ts → page → compiled plan). See ./compiler.ts and
 * ./runner.ts.
 *
 * HARD INVARIANT (docs/ARCHITECTURE.md §4): a promoted deterministic replay makes
 * ZERO model calls. Recovery (recover.ts) and model extraction are the
 * author/heal tier — only reached on failure or when a step has no cached
 * locator — never the hot path.
 *
 * This class was named `LibrettoAdapter` through ADR-0001; renamed here to
 * reflect that the engine is Portico's own (ADR-0004). Its `name` field stays
 * `"libretto"` deliberately — that string is the stable `EngineAdapter`
 * registry key (`getEngine("libretto")`, `index.ts`'s `EngineName`), an
 * external-facing selector unrelated to (and outliving) the removed npm
 * dependency of the same name.
 */

import type {
  EngineAdapter,
  EngineCapabilities,
  EngineRunOptions,
  EngineRunResult,
} from "../types.js";
import { healModelConfigured } from "../model.js";
import { runFlow, runnerMode } from "../runner.js";

export class PorticoAdapter implements EngineAdapter {
  readonly name = "libretto";

  capabilities(): EngineCapabilities {
    return {
      // API-tier execution is implemented (page-request.ts's pageRequest) for
      // flow-marked steps. We do NOT yet do author-time network capture →
      // auto-promotion, so this stays honest about *execution*, not
      // capture-based promotion.
      apiPromotion: true,
      // HONEST + dynamic: self-heal exists only when a recovery model is configured.
      selfHeal: healModelConfigured(),
      // In-process, always — the only runner since ADR-0004.
      inProcess: runnerMode() === "programmatic",
    };
  }

  run(opts: EngineRunOptions): Promise<EngineRunResult> {
    return runFlow(opts);
  }
}
