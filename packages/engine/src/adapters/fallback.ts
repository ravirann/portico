/**
 * Fallback engine adapter.
 *
 * A placeholder that keeps the engine choice reversible: the platform depends
 * only on `EngineAdapter`, so an alternative engine can be dropped in here
 * without touching anything else. Not wired — see ADR-0001.
 */

import type {
  EngineAdapter,
  EngineCapabilities,
  EngineRunOptions,
  EngineRunResult,
} from "../types.js";

export class FallbackAdapter implements EngineAdapter {
  readonly name = "fallback";

  capabilities(): EngineCapabilities {
    // Placeholder: advertises nothing it does not implement.
    return { apiPromotion: false, selfHeal: false, inProcess: true };
  }

  async run(_opts: EngineRunOptions): Promise<EngineRunResult> {
    throw new Error("FallbackAdapter is a placeholder and not wired (ADR-0001).");
  }
}
