import type {
  ChatRetrievalMode,
  ChatMemoryMode,
  ChatMode,
  ChatSendMessageRequest,
  ChatSessionPrefsPatch,
  ChatThinkingLevel,
  ChatWebMode,
  ChatSessionPrefsRecord,
} from "@goatcitadel/contracts";

interface BuildDelegatedChatSendRequestInput {
  content: string;
  providerId?: string;
  model?: string;
  mode: ChatMode;
  webMode: ChatWebMode;
  memoryMode: ChatMemoryMode;
  thinkingLevel: ChatThinkingLevel;
  retrievalMode: ChatRetrievalMode;
  toolAutonomy?: ChatSessionPrefsRecord["toolAutonomy"];
  normalizationProfile?: ChatSendMessageRequest["normalizationProfile"];
}

export function buildDelegatedChatSendRequest(input: BuildDelegatedChatSendRequestInput): ChatSendMessageRequest {
  const prefsOverride: ChatSessionPrefsPatch = {
    planningMode: "off",
    orchestrationEnabled: false,
    orchestrationIntensity: "minimal",
    orchestrationVisibility: "explicit",
    orchestrationParallelism: "sequential",
    toolAutonomy: input.toolAutonomy,
    proactiveMode: "off",
    retrievalMode: input.retrievalMode,
    reflectionMode: "off",
  };

  return {
    content: input.content,
    providerId: input.providerId,
    model: input.model,
    mode: input.mode,
    webMode: input.webMode,
    memoryMode: input.memoryMode,
    thinkingLevel: input.thinkingLevel,
    normalizationProfile: input.normalizationProfile,
    prefsOverride,
  };
}
