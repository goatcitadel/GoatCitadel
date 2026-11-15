import type { ChatCompletionReasoningEffort, LlmProviderCapabilities } from "@goatcitadel/contracts";

interface ProviderReasoningSource {
  capabilities?: Pick<LlmProviderCapabilities, "reasoning" | "reasoningEfforts">;
  reasoningEffortsByModel?: Record<string, ChatCompletionReasoningEffort[]>;
}

/**
 * The reasoning efforts this model can be sent with, in the order dispatch resolves them: the model's own catalog list
 * first (the Gateway removes it for adapters that never send an effort, such as the Claude Code CLI); then, for a
 * provider that reports no reasoning, only "none"; then the provider's declared list plus "none". Undefined when
 * nothing is known, so every effort stays offered and the Gateway decides.
 */
export function selectedModelReasoningEfforts(
  provider: ProviderReasoningSource | undefined,
  model: string,
): ChatCompletionReasoningEffort[] | undefined {
  if (!provider) return undefined;
  const byModel = provider.reasoningEffortsByModel?.[model];
  if (byModel?.length) return byModel;
  if (provider.capabilities?.reasoning === false) return ["none"];
  const declared = provider.capabilities?.reasoningEfforts;
  if (declared?.length) return ["none", ...declared.filter((effort) => effort !== "none")];
  return undefined;
}

/**
 * The efforts a provider and model pair can be sent with, read from the catalog the committed model's list comes from
 * (a model id may carry its provider as a prefix). Undefined when the catalog does not know them, so the caller shows
 * the effort as unverified rather than offering another model's list.
 */
export function reasoningEffortsForSelection(
  providers: ReadonlyArray<ProviderReasoningSource & { providerId: string }>,
  providerId: string,
  model: string,
): ChatCompletionReasoningEffort[] | undefined {
  return selectedModelReasoningEfforts(
    providers.find((provider) => provider.providerId === providerId),
    model.replace(`${providerId}/`, ""),
  );
}
