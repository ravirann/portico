/**
 * Recovery / extraction model resolution — the *author/heal* tier only.
 *
 * The hard invariant (docs/ARCHITECTURE.md §4) is that a promoted deterministic
 * replay makes ZERO model calls. So this module is deliberately opt-in: a model
 * is resolved ONLY when the operator configures one via env, and it is only ever
 * invoked on failure (recovery) or when a step cannot be served deterministically
 * (extract without a cached locator). When nothing is configured, `resolveHealModel`
 * returns `null` and the whole deterministic path runs unchanged, keyless.
 *
 * Env contract:
 *   PORTICO_HEAL_PROVIDER = "anthropic" | "openai"
 *   PORTICO_HEAL_MODEL    = model id (defaults per provider)
 *   PORTICO_HEAL_API_KEY  = key (falls back to ANTHROPIC_API_KEY / OPENAI_API_KEY)
 *
 * The AI-SDK providers are imported *dynamically* so the deterministic path never
 * loads them, and any resolution error degrades to `null` (deterministic).
 */

import type { LanguageModel } from "ai";
import { popupRecoveryAction, type RecoveryAction } from "libretto";

export interface HealModel {
  /** ai-SDK LanguageModel for `extractFromPage` / `attemptWithRecovery`. */
  languageModel: LanguageModel;
  /** Libretto recovery action (popup/overlay recovery) for `recoveryAction`. */
  recoveryAction: RecoveryAction;
  provider: string;
  modelId: string;
}

type Provider = "anthropic" | "openai";

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.5",
};

/** Cheap synchronous check used by `capabilities().selfHeal` — no imports. */
export function healModelConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const provider = (env.PORTICO_HEAL_PROVIDER ?? "").toLowerCase();
  if (provider !== "anthropic" && provider !== "openai") return false;
  const key =
    env.PORTICO_HEAL_API_KEY ||
    (provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);
  return Boolean(key);
}

let cached: HealModel | null | undefined;

/**
 * Resolve the configured heal/extract model, or `null` when none is configured
 * (or the provider SDK can't be loaded). Result is memoised for the process.
 */
export async function resolveHealModel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HealModel | null> {
  if (cached !== undefined) return cached;
  cached = await build(env).catch(() => null);
  return cached;
}

async function build(env: NodeJS.ProcessEnv): Promise<HealModel | null> {
  const provider = (env.PORTICO_HEAL_PROVIDER ?? "").toLowerCase() as Provider;
  if (provider !== "anthropic" && provider !== "openai") return null;
  const apiKey =
    env.PORTICO_HEAL_API_KEY ||
    (provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);
  if (!apiKey) return null;
  const modelId = env.PORTICO_HEAL_MODEL || DEFAULT_MODEL[provider];

  let languageModel: LanguageModel;
  if (provider === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    languageModel = createAnthropic({ apiKey })(modelId);
  } else {
    const { createOpenAI } = await import("@ai-sdk/openai");
    languageModel = createOpenAI({ apiKey })(modelId);
  }

  return {
    languageModel,
    recoveryAction: popupRecoveryAction({ languageModel }),
    provider,
    modelId,
  };
}

/** Test seam: drop the memoised model (used by unit tests). */
export function _resetHealModelCache(): void {
  cached = undefined;
}
