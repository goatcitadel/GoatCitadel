import type {
  ChatRetrievalMode,
  ChatMemoryMode,
  ChatMode,
  ChatSendMessageRequest,
  ChatSessionPrefsPatch,
  ChatSpeedMode,
  ChatSubagentPolicy,
  ChatThinkingLevel,
  ChatWebMode,
  ChatSessionPrefsRecord,
  ToolPolicyActorContext,
} from "@goatcitadel/contracts";

interface BuildDelegatedChatSendRequestInput {
  content: string;
  providerId?: string;
  model?: string;
  mode: ChatMode;
  webMode: ChatWebMode;
  memoryMode: ChatMemoryMode;
  thinkingLevel: ChatThinkingLevel;
  speedMode?: ChatSpeedMode;
  subagentPolicy?: ChatSubagentPolicy;
  retrievalMode: ChatRetrievalMode;
  toolAutonomy?: ChatSessionPrefsRecord["toolAutonomy"];
  normalizationProfile?: ChatSendMessageRequest["normalizationProfile"];
  parentDelegationStepId?: string;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: ChatSendMessageRequest["authActorSource"];
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  policyRunId?: string;
  policyTaskId?: string;
  fullWebAccess?: boolean;
  policyContext?: ToolPolicyActorContext;
}

export function buildDelegatedChatSendRequest(
  input: BuildDelegatedChatSendRequestInput,
): ChatSendMessageRequest & { policyContext?: ToolPolicyActorContext } {
  const prefsOverride: ChatSessionPrefsPatch = {
    planningMode: "off",
    orchestrationEnabled: false,
    orchestrationIntensity: "minimal",
    orchestrationVisibility: "explicit",
    orchestrationParallelism: "sequential",
    toolAutonomy: input.toolAutonomy,
    speedMode: input.speedMode,
    subagentPolicy: input.subagentPolicy ?? "off",
    proactiveMode: "off",
    retrievalMode: input.retrievalMode,
    reflectionMode: "off",
  };

  return {
    content: input.content,
    providerId: input.providerId,
    model: input.model,
    mode: "chat",
    webMode: input.webMode,
    memoryMode: input.memoryMode,
    thinkingLevel: input.thinkingLevel,
    speedMode: input.speedMode,
    subagentPolicy: input.subagentPolicy ?? "off",
    normalizationProfile: input.normalizationProfile,
    prefsOverride,
    parentDelegationStepId: input.parentDelegationStepId,
    operatorId: input.operatorId,
    authActorId: input.authActorId,
    authActorSource: input.authActorSource,
    permissionProfileId: input.permissionProfileId,
    localOperatorOverrideId: input.localOperatorOverrideId,
    policyRunId: input.policyRunId,
    policyTaskId: input.policyTaskId,
    fullWebAccess: input.fullWebAccess,
    policyContext: input.policyContext,
  };
}
