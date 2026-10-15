import { useQuery } from "@tanstack/react-query";
import { fetchLlmModels } from "@goatcitadel/mission-control-shared/api/platform";

const LABEL_STALE_MS = 10 * 60_000;

/**
 * Catalog names for one provider's models, shared with `useModelLabel` through the same query key. Unknown ids fall
 * back to the id itself: it is the name operators pick from, and the wire value stays in the option's `value`.
 */
export function useChatModelLabels(providerId: string | undefined, enabled = true): (modelId: string) => string {
  const models = useQuery({
    queryKey: ["system", "llm-model-labels", providerId],
    queryFn: () => fetchLlmModels(providerId),
    enabled: enabled && Boolean(providerId),
    staleTime: LABEL_STALE_MS,
    retry: false,
  });
  const items = models.data?.items ?? [];
  return (modelId) => items.find((model) => model.id === modelId)?.label || modelId;
}
