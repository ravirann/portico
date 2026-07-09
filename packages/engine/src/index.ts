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

// Compiler + runner surface (used by generated workflow modules + tooling).
export { compileFlow, compileToWorkflow, emitWorkflowModule, waitForDomQuiet } from "./compiler.js";
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
