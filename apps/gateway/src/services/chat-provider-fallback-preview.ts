import type { ChatProviderFallbackPreference } from "@goatcitadel/contracts";
import type { LlmService } from "./llm-service.js";
import type { ChatRouteResolutionDependencies } from "./chat-route-resolution.js";
import { isLocalChatProviderUrl } from "./chat-provider-fallback-authority.js";
type LlmRuntimeConfig = ReturnType<LlmService["getRuntimeConfig"]>;
type RuntimeProvider = LlmRuntimeConfig["providers"][number];
/** Preview only: the admission owner must issue runtime authority separately. */
export async function resolveOptedInFallback(
  host: Pick<ChatRouteResolutionDependencies, "isFeatureEnabled">,
  runtime: LlmRuntimeConfig,
  primary: RuntimeProvider,
  preference: ChatProviderFallbackPreference | undefined,
  getModelAvailability:
    | ((providerId: string, model: string) => ReturnType<LlmService["getCachedModelAvailability"]>)
    | undefined,
  resolveEffectiveModel: (input: {
    runtime: LlmRuntimeConfig;
    provider: RuntimeProvider;
    requestedModel?: string;
    getModelAvailability?: (providerId: string, model: string) => ReturnType<LlmService["getCachedModelAvailability"]>;
  }) => { model?: string; blockedReason?: string; normalizationReason?: string },
): Promise<ChatProviderFallbackPreference | undefined> {
  if ((await host.isFeatureEnabled?.("chatProviderFallbackV1Enabled")) !== true) return undefined;
  if (
    !preference ||
    !preference.providerId?.trim() ||
    !preference.model?.trim() ||
    typeof preference.allowLocalToCloud !== "boolean" ||
    preference.providerId === primary.providerId
  )
    return undefined;
  const target = runtime.providers.find((provider) => provider.providerId === preference.providerId);
  if (!target || (!target.hasApiKey && classifyRuntime(target) !== "local")) return undefined;
  if (classifyRuntime(primary) === "local" && classifyRuntime(target) !== "local" && !preference.allowLocalToCloud)
    return undefined;
  const model = resolveEffectiveModel({
    runtime,
    provider: target,
    requestedModel: preference.model,
    getModelAvailability,
  });
  // Never silently replace the operator's fallback model with a default model.
  if (model.blockedReason || model.normalizationReason || !model.model) return undefined;
  return { providerId: target.providerId, model: model.model, allowLocalToCloud: preference.allowLocalToCloud };
}

function classifyRuntime(provider: RuntimeProvider) {
  return isLocalChatProviderUrl(provider.baseUrl) ? "local" : "cloud";
}
