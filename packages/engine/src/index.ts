/**
 * @portico/engine — the engine boundary + adapter registry.
 *
 * Portico's platform layer depends only on `EngineAdapter`. The concrete engine
 * is selected here (Portico's own in-house engine; a fallback adapter is
 * retained). See docs/decisions/0001-execution-engine.md and
 * docs/decisions/0004-own-engine.md.
 */

export * from "./types.js";
export { PorticoAdapter } from "./adapters/portico.js";
export { FallbackAdapter } from "./adapters/fallback.js";

// Compiler + runner surface.
export { compileFlow, waitForDomQuiet } from "./compiler.js";
export type { CompileResult, CompiledStep, StepRuntime } from "./compiler.js";
export { runFlow, runnerMode } from "./runner.js";
export { resolveHealModel, healModelConfigured } from "./model.js";
export type { HealModel } from "./model.js";
export { resolveProfile, refreshProfile } from "./auth-profile.js";
export { jsonSchemaToZod, validateAgainst } from "./json-schema.js";
// compileRecording moved to @portico/flow-spec (shared, pure) — re-exported here
// for back-compat so existing `import { compileRecording } from "@portico/engine"`
// call sites keep working.
export { compileRecording, collapseTogglePairs } from "@portico/flow-spec";
export type { Recording, ClickEvent, NetworkEntry, CompileRecordingOptions } from "@portico/flow-spec";
export { evaluateValidation, expectedOutputKeys, missingFlowInputs, sampleInputsFromFlow } from "./validate-flow.js";
export type { ValidationResult, RunResultLike } from "./validate-flow.js";
export { refineFlow, applyNameRefinements, applyRefinements } from "./refine-flow.js";
export type { NameRefinement, FlowRefinements } from "./refine-flow.js";
export { sessionHealth, registerSession, keepAliveSession, endSession, listSessions } from "./session-manager.js";
export type { SessionHealth, TrackedSession, SessionStore } from "./session-manager.js";
export { deriveTier } from "./tier.js";
export type { Tier } from "./tier.js";

import type { EngineAdapter } from "./types.js";
import { PorticoAdapter } from "./adapters/portico.js";
import { FallbackAdapter } from "./adapters/fallback.js";

// "portico" is the canonical engine since ADR-0004; "libretto" survives only
// as a deprecated selector alias for external callers that pinned the old
// name — it resolves to the same in-house adapter, not to the removed npm
// dependency. See adapters/portico.ts's header.
export type EngineName = "portico" | "libretto" | "fallback";

const REGISTRY: Record<EngineName, () => EngineAdapter> = {
  portico: () => new PorticoAdapter(),
  libretto: () => new PorticoAdapter(),
  fallback: () => new FallbackAdapter(),
};

/** Resolve the engine for a run. Defaults to Portico's own engine. */
export function getEngine(name: EngineName = "portico"): EngineAdapter {
  const make = REGISTRY[name];
  if (!make) throw new Error(`Unknown engine '${name}'. Known: ${Object.keys(REGISTRY).join(", ")}`);
  return make();
}
