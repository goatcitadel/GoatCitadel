import type { ChatCompletionReasoningEffort, LlmProviderCapabilities } from "@goatcitadel/contracts";

interface ProviderReasoningSource {
  capabilities?: Pick<LlmProviderCapabilities, "reasoning" | "reasoningEfforts">;
  reasoningEffortsByModel?: Record<string, ChatCompletionReasoningEffort[]>;
}

/**
 * The reasoning efforts the Gateway accepts for this model, in the order it checks them: a provider that reports no
 * reasoning takes only "none"; otherwise the model's catalog list, then the provider's declared list (plus "none",
 * which is always accepted). Undefined when nothing is known, so every effort stays offered and the Gateway decides.
 */
export function selectedModelReasoningEfforts(
  provider: ProviderReasoningSource | undefined,
  model: string,
): ChatCompletionReasoningEffort[] | undefined {
  if (!provider) return undefined;
  if (provider.capabilities?.reasoning === false) return ["none"];
  const byModel = provider.reasoningEffortsByModel?.[model];
  if (byModel?.length) return byModel;
  const declared = provider.capabilities?.reasoningEfforts;
  if (declared?.length) return ["none", ...declared.filter((effort) => effort !== "none")];
  return undefined;
}
