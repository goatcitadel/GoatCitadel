import type { RuntimeSettings } from "./gateway/runtime-settings.js";
export type ChatFeatureAvailability = ReturnType<typeof projectChatFeatureAvailability>;

/** Read-only rollout availability, not a grant, model-health result or task-success claim. */
export function projectChatFeatureAvailability(
  durable: { enabled: boolean; executionEnabled: boolean },
  features: RuntimeSettings["features"],
) {
  const durableExecution = durable.enabled && durable.executionEnabled && features.durableKernelV1Enabled === true;
  return {
    durableExecution,
    explicitContext: durableExecution && features.chatExplicitContextV1Enabled === true,
    supervisedDelegation: durableExecution && features.chatDelegationControlsV1Enabled === true,
    automaticFanout:
      durableExecution &&
      features.chatAutomaticFanoutV1Enabled === true &&
      features.durableChatFanoutV1Enabled === true &&
      features.subagentFanoutV1Disabled !== true,
    providerFallback: durableExecution && features.chatProviderFallbackV1Enabled === true,
    staticMcp: durableExecution && features.chatStaticMcpV1Enabled === true,
    explicitContextBranches:
      durableExecution &&
      features.chatExplicitContextV1Enabled === true &&
      features.chatExplicitContextBranchesV1Enabled === true,
    modelCouncil: durableExecution && features.chatModelCouncilV1Enabled === true,
    workPassport: durableExecution && features.chatWorkPassportV1Enabled === true,
  };
}
