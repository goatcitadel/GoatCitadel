import type {
  ChatMemoryMode,
  ChatMode,
  ChatNormalizationProfile,
  ChatSendMessageRequest,
  ChatThinkingLevel,
  ChatWebMode,
} from "@goatcitadel/contracts";
import { resolveChatNormalizationProfile } from "./chat-turn-execution-profile.js";

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
  const normalizationProfile = resolveChatNormalizationProfile({ request });
  if (normalizationProfile === "quick_web") {
    return {
      mode: "chat",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "minimal",
      speedMode: "fast",
      subagentPolicy: "off",
      normalizationProfile,
    };
  }
  return {
    mode: request.mode ?? "chat",
    webMode: request.webMode ?? "auto",
    memoryMode: request.memoryMode ?? (request.useMemory === false ? "off" : "auto"),
    thinkingLevel: request.thinkingLevel ?? "standard",
    speedMode: request.speedMode ?? "standard",
    subagentPolicy: request.subagentPolicy ?? "ask_when_useful",
    normalizationProfile,
  };
}
