import type { LlmProviderSummary } from "@goatcitadel/contracts";

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
