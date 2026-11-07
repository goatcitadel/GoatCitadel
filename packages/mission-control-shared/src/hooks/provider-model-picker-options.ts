import type {
  ProviderModelCatalogOption,
  ProviderModelProbeSource,
  ProviderModelProbeState,
} from "./useProviderModelCatalog.js";
import {
  dedupeProviderModels,
  isModelMissingFromStaleCatalog,
  isModelUnavailableInFreshCatalog,
} from "./provider-model-values.js";

export type UniversalModelPickerAvailability = "ready" | "suggested" | "blocked" | "unknown";

export interface UniversalModelPickerOption {
  id: string;
  providerId: string;
  providerLabel: string;
  model: string;
  label: string;
  searchText: string;
  availability: UniversalModelPickerAvailability;
  availabilityReason: string;
  endpointIdentity: string;
  credentialStatus: "configured" | "local_endpoint" | "missing" | "unknown";
  contextWindowTokens?: number;
  contextLimitSource?: ProviderModelCatalogOption["contextLimitSource"];
  fallbackReason?: string;
  policyReason?: string;
  probeState: ProviderModelProbeState;
  probeSource?: ProviderModelProbeSource;
  probeCheckedAt?: string;
}

export function buildUniversalModelPickerOptions(input: {
  providers: ProviderModelCatalogOption[];
  query?: string;
  activeProviderId?: string;
  activeModel?: string;
}): UniversalModelPickerOption[] {
  const query = normalizeSearchText(input.query ?? "");
  return input.providers
    .flatMap((provider) => buildUniversalModelPickerOptionsForProvider(provider, input))
    .filter((option) => !query || option.searchText.includes(query))
    .sort((left, right) => scoreUniversalModelOption(right, input) - scoreUniversalModelOption(left, input));
}

function buildUniversalModelPickerOptionsForProvider(
  provider: ProviderModelCatalogOption,
  input: { activeProviderId?: string; activeModel?: string },
): UniversalModelPickerOption[] {
  const models =
    provider.models.length || provider.modelProbeSource === "live"
      ? [...provider.models]
      : dedupeProviderModels([provider.defaultModel]);
  const missingActiveModel =
    provider.providerId === input.activeProviderId &&
    input.activeModel &&
    (isModelUnavailableInFreshCatalog(provider, input.activeModel) ||
      isModelMissingFromStaleCatalog(provider, input.activeModel))
      ? input.activeModel
      : undefined;
  if (missingActiveModel) models.push(missingActiveModel);
  return models.map((model) => {
    const credentialStatus = resolveCredentialStatus(provider);
    const removed = model === missingActiveModel;
    const needsRefresh = removed && provider.modelRefreshStatus === "stale";
    const availability = removed ? "blocked" : resolveModelAvailability(provider, credentialStatus);
    const fallbackReason = removed
      ? needsRefresh
        ? "This model was not in the last known account catalog. Refresh to verify before using it."
        : "This model is no longer listed in the provider's live account catalog. Choose an available model."
      : resolveModelFallbackReason(provider);
    const policyReason = credentialStatus === "missing" ? "Provider credential is missing." : undefined;
    const availabilityReason = resolveModelAvailabilityReason({
      provider,
      credentialStatus,
      availability,
      fallbackReason,
      policyReason,
    });
    const active = provider.providerId === input.activeProviderId && model === input.activeModel;
    const label = active ? `${provider.label} / ${model} (active)` : `${provider.label} / ${model}`;
    return {
      id: `${provider.providerId}:${model}`,
      providerId: provider.providerId,
      providerLabel: provider.label,
      model,
      label,
      searchText: normalizeSearchText(
        [
          provider.providerId,
          provider.label,
          model,
          provider.apiStyle,
          provider.resolvedApiStyle,
          provider.sanitizedEndpointIdentity,
          provider.contextLimitSource,
          availability,
          fallbackReason,
          policyReason,
        ].join(" "),
      ),
      availability,
      availabilityReason,
      endpointIdentity: provider.sanitizedEndpointIdentity,
      credentialStatus,
      contextWindowTokens: provider.contextWindowTokens,
      contextLimitSource: provider.contextLimitSource,
      fallbackReason,
      policyReason,
      probeState: provider.modelProbeState ?? "not_checked",
      probeSource: provider.modelProbeSource,
      probeCheckedAt: provider.modelProbeCheckedAt,
    } satisfies UniversalModelPickerOption;
  });
}

function resolveCredentialStatus(provider: ProviderModelCatalogOption): UniversalModelPickerOption["credentialStatus"] {
  if (provider.hasApiKey) {
    return "configured";
  }
  if (provider.localCostPosture === "zero_cost_local_runtime") {
    return "local_endpoint";
  }
  return provider.hasApiKey === false ? "missing" : "unknown";
}

function resolveModelAvailability(
  provider: ProviderModelCatalogOption,
  credentialStatus: UniversalModelPickerOption["credentialStatus"],
): UniversalModelPickerAvailability {
  if (credentialStatus === "missing" || provider.modelProbeState === "error") {
    return "blocked";
  }
  if (provider.modelProbeSource === "live" && provider.modelRefreshStatus === "stale") {
    return "suggested";
  }
  if (provider.modelProbeState === "fallback" || provider.modelProbeSource === "template_fallback") {
    return "suggested";
  }
  if (provider.modelProbeState === "ready" && provider.modelProbeSource === "live") {
    return "ready";
  }
  return "unknown";
}

function resolveModelFallbackReason(provider: ProviderModelCatalogOption): string | undefined {
  if (provider.modelProbeSource === "live" && provider.modelRefreshStatus === "stale") {
    return provider.modelProbeWarning
      ? `Showing the last known account catalog; refresh has not verified it: ${provider.modelProbeWarning}`
      : "Showing the last known account catalog; refresh has not verified it.";
  }
  if (provider.modelProbeSource === "error_fallback") {
    return provider.modelProbeWarning
      ? `Live discovery failed: ${provider.modelProbeWarning}`
      : "Live discovery failed.";
  }
  if (provider.modelProbeState === "fallback" || provider.modelProbeSource === "template_fallback") {
    return "Using template fallback models; availability is not account-verified.";
  }
  if (provider.modelProbeState === "empty") {
    return "Live discovery returned no models.";
  }
  return undefined;
}

function resolveModelAvailabilityReason(input: {
  provider: ProviderModelCatalogOption;
  credentialStatus: UniversalModelPickerOption["credentialStatus"];
  availability: UniversalModelPickerAvailability;
  fallbackReason?: string;
  policyReason?: string;
}): string {
  if (input.policyReason) {
    return input.policyReason;
  }
  if (input.fallbackReason) {
    return input.fallbackReason;
  }
  if (input.credentialStatus === "local_endpoint") {
    return "Local endpoint model; verify the runtime is reachable before send.";
  }
  if (input.availability === "ready") {
    return "Live model discovery verified this model for the configured provider.";
  }
  return "Model has not been live-checked yet.";
}

function scoreUniversalModelOption(
  option: UniversalModelPickerOption,
  input: { activeProviderId?: string; activeModel?: string },
): number {
  let score = 0;
  if (option.providerId === input.activeProviderId && option.model === input.activeModel) {
    score += 100;
  }
  if (option.availability === "ready") {
    score += 20;
  } else if (option.availability === "suggested") {
    score += 10;
  } else if (option.availability === "blocked") {
    score -= 20;
  }
  if (option.credentialStatus === "configured" || option.credentialStatus === "local_endpoint") {
    score += 5;
  }
  return score;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}
