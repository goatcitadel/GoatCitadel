import type { LlmProviderSummary, LlmRuntimeConfig } from "@goatcitadel/contracts";

export interface UtilityModelOverride {
  providerId: string;
  model: string;
}

/**
 * Resolves the cheap utility-model override for background LLM calls
 * (improvement scans, judges, classifiers, prompt packs).
 *
 * Returns `undefined` — meaning "keep today's model selection exactly" —
 * unless every precondition holds: the `utilityModelRoutingV1Enabled` flag is
 * on, a utility provider is configured, that provider is known, and it has a
 * usable API key. A missing utility model falls back to the provider's
 * default model rather than failing.
 */
export function resolveUtilityModelOverride(input: {
  flagEnabled: boolean;
  utilityProviderId?: string;
  utilityModel?: string;
  provider?: Pick<LlmProviderSummary, "providerId" | "hasApiKey" | "defaultModel">;
}): UtilityModelOverride | undefined {
  if (!input.flagEnabled) {
    return undefined;
  }
  const providerId = input.utilityProviderId?.trim();
  if (!providerId) {
    return undefined;
  }
  if (!input.provider || input.provider.providerId !== providerId || !input.provider.hasApiKey) {
    return undefined;
  }
  const model = input.utilityModel?.trim() || input.provider.defaultModel?.trim();
  if (!model) {
    return undefined;
  }
  return { providerId, model };
}

export interface JudgeModelDefaults {
  providerId?: string;
  model?: string;
}

// Keyed fallbacks tried in order when the active provider is not ready. Each
// uses its own configured default model; the literal is only a last resort.
const JUDGE_FALLBACK_PROVIDERS: ReadonlyArray<{ providerId: string; fallbackModel?: string }> = [
  { providerId: "openai-codex" },
  { providerId: "openai", fallbackModel: "gpt-5.4" },
  { providerId: "glm", fallbackModel: "glm-5" },
  { providerId: "moonshot" },
];

/**
 * Picks the model for background judge-style calls (post-turn commitment
 * classification, background review, proactive planning) when no utility
 * override applies. The operator's active provider wins whenever it is ready,
 * so background work follows the provider they chose for Chat.
 */
export function resolveJudgeModelDefaults(
  runtime: Pick<LlmRuntimeConfig, "activeProviderId" | "activeModel"> & {
    providers: ReadonlyArray<Pick<LlmProviderSummary, "providerId" | "hasApiKey" | "defaultModel">>;
  },
): JudgeModelDefaults {
  const active = runtime.providers.find((provider) => provider.providerId === runtime.activeProviderId);
  const activeModel = runtime.activeModel || active?.defaultModel;
  if (active?.hasApiKey && activeModel) {
    return { providerId: active.providerId, model: activeModel };
  }
  for (const candidate of JUDGE_FALLBACK_PROVIDERS) {
    const provider = runtime.providers.find((item) => item.providerId === candidate.providerId && item.hasApiKey);
    const model = provider?.defaultModel || candidate.fallbackModel;
    if (provider && model) {
      return { providerId: provider.providerId, model };
    }
  }
  return { providerId: active?.providerId ?? runtime.activeProviderId, model: activeModel };
}
