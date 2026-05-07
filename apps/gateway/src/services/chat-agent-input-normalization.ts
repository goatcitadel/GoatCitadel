import type {
  ChatMemoryMode,
  ChatMode,
  ChatNormalizationProfile,
  ChatSendMessageRequest,
  ChatThinkingLevel,
  ChatWebMode,
} from "@goatcitadel/contracts";

export interface NormalizedAgentInputFromSend {
  readonly mode: ChatMode;
  readonly webMode: ChatWebMode;
  readonly memoryMode: ChatMemoryMode;
  readonly thinkingLevel: ChatThinkingLevel;
  readonly speedMode: "standard" | "fast";
  readonly subagentPolicy: "off" | "ask_when_useful" | "auto_when_useful";
  readonly normalizationProfile: ChatNormalizationProfile;
}

export function normalizeAgentInputFromSend(request: ChatSendMessageRequest): NormalizedAgentInputFromSend {
  return {
    mode: request.mode ?? "chat",
    webMode: request.webMode ?? "auto",
    memoryMode: request.memoryMode ?? (request.useMemory === false ? "off" : "auto"),
    thinkingLevel: request.thinkingLevel ?? "standard",
    speedMode: request.speedMode ?? "standard",
    subagentPolicy: request.subagentPolicy ?? "ask_when_useful",
    normalizationProfile: request.normalizationProfile ?? "live",
  };
}
