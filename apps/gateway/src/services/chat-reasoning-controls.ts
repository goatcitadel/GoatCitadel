import type { ChatCompletionRequest, ChatMode, ChatThinkingLevel } from "@goatcitadel/contracts";

export type ChatReasoningEffort = NonNullable<ChatCompletionRequest["reasoning"]>["effort"];

export function resolveChatReasoningEffort(thinkingLevel: ChatThinkingLevel): ChatReasoningEffort {
  switch (thinkingLevel) {
    case "off":
      return "none";
    case "minimal":
      return "low";
    case "standard":
      return "medium";
    case "extended":
      return "high";
    case "deep":
      return "xhigh";
    case "max":
      return "max";
    case "ultra":
      return "ultra";
  }
}

export function resolvePromptLabReasoningEffort(mode: ChatMode, thinkingLevel: ChatThinkingLevel): ChatReasoningEffort {
  if (thinkingLevel === "max" || thinkingLevel === "ultra") {
    return thinkingLevel;
  }
  if (thinkingLevel === "minimal") {
    return "low";
  }
  if (thinkingLevel === "standard") {
    return mode === "cowork" ? "medium" : "low";
  }
  return mode === "cowork" ? "high" : "medium";
}
