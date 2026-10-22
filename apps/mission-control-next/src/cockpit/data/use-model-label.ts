import { useQuery } from "@tanstack/react-query";
import { fetchLlmConfig, fetchLlmModels } from "@goatcitadel/mission-control-shared/api/platform";

const LABEL_STALE_MS = 10 * 60_000;

/** Provider display names from the LLM config ("Anthropic"), shared by every caller through one query key. */
export function useProviderLabelLookup(enabled = true): (providerId?: string) => string | undefined {
  const config = useQuery({
    queryKey: ["system", "llm-config-labels"],
    queryFn: fetchLlmConfig,
    enabled,
    staleTime: LABEL_STALE_MS,
  });
  const providers = config.data?.providerConfigs ?? [];
  return (providerId) =>
    providerId ? providers.find((provider) => provider.providerId === providerId)?.label || undefined : undefined;
}

/**
 * Catalog model names for one provider, for lists of observed model IDs (Spend attribution). Unlike useModelLabel it
 * never shows an ID: once the catalog is read, a model it doesn't name reads "Unnamed model", and the ID belongs in
 * technical details. Until then `status` says whether names are still loading or unavailable.
 */
export function useModelLabelLookup(
  providerId: string | undefined,
  enabled = true,
): { status: "ready" | "loading" | "unavailable"; labelFor: (modelId: string) => string } {
  const models = useQuery({
    queryKey: ["system", "llm-model-labels", providerId],
    queryFn: () => fetchLlmModels(providerId),
    enabled: enabled && Boolean(providerId),
    staleTime: LABEL_STALE_MS,
    retry: false,
  });
  return {
    status: models.data ? "ready" : models.isError || !providerId ? "unavailable" : "loading",
    labelFor: (modelId) => models.data?.items.find((model) => model.id === modelId)?.label || "Unnamed model",
  };
}

/**
 * "Claude Sonnet · Anthropic" from catalog labels. Falls back to the model id (the name operators pick from) and a
 * plain "Unknown model" when there is none; provider and model ids belong in technical details.
 */
export function useModelLabel(providerId: string | undefined, modelId: string | undefined, enabled = true): string {
  const providerLabel = useProviderLabelLookup(enabled && Boolean(providerId))(providerId);
  const models = useQuery({
    queryKey: ["system", "llm-model-labels", providerId],
    queryFn: () => fetchLlmModels(providerId),
    enabled: enabled && Boolean(providerId && modelId),
    staleTime: LABEL_STALE_MS,
    retry: false,
  });
  const modelLabel = models.data?.items.find((model) => model.id === modelId)?.label || modelId;
  if (!modelLabel) return providerLabel ?? "Unknown model";
  return providerLabel ? `${modelLabel} · ${providerLabel}` : modelLabel;
}
