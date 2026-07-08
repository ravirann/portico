/**
 * @portico/engine — the engine boundary + adapter registry.
 *
 * Portico's platform layer depends only on `EngineAdapter`. The concrete engine
 * is selected here (Libretto for the pilot; a fallback adapter is retained).
 * See docs/decisions/0001-execution-engine.md.
 */

export * from "./types.js";
export { LibrettoAdapter } from "./adapters/libretto.js";
export { FallbackAdapter } from "./adapters/fallback.js";

import type { EngineAdapter } from "./types.js";
import { LibrettoAdapter } from "./adapters/libretto.js";
import { FallbackAdapter } from "./adapters/fallback.js";

export type EngineName = "libretto" | "fallback";

const REGISTRY: Record<EngineName, () => EngineAdapter> = {
  libretto: () => new LibrettoAdapter(),
  fallback: () => new FallbackAdapter(),
};

/** Resolve the engine for a run. Defaults to the pilot engine (Libretto). */
export function getEngine(name: EngineName = "libretto"): EngineAdapter {
  const make = REGISTRY[name];
  if (!make) throw new Error(`Unknown engine '${name}'. Known: ${Object.keys(REGISTRY).join(", ")}`);
  return make();
}
