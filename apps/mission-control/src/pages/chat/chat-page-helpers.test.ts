import { describe, expect, it } from "vitest";
import {
  buildQueuedOutboundItemView,
  isLikelyLocalProviderUrl,
  resolveProviderModelSelection,
  resolveProviderSelectionPlan,
  resolveStreamTurnOperation,
} from "./chat-page-helpers";

describe("chat page characterization helpers", () => {
  it("maps send/edit/retry actions to the correct stream operation and resume path", () => {
    expect(resolveStreamTurnOperation({ action: "send", resumeAttempts: 0 })).toBe("send");
    expect(resolveStreamTurnOperation({ action: "edit", resumeAttempts: 0, targetTurnId: "turn-1" })).toBe("edit");
    expect(resolveStreamTurnOperation({ action: "retry", resumeAttempts: 0, targetTurnId: "turn-1" })).toBe("retry");
    expect(resolveStreamTurnOperation({ action: "retry", resumeAttempts: 1, targetTurnId: "turn-1" })).toBe("resume");
  });

  it("builds queue labels from content when present and from target turn when not", () => {
    expect(buildQueuedOutboundItemView({
      id: "queue-1",
      action: "send",
      content: "Ship the fix after review",
      createdAt: "2026-03-22T12:00:00.000Z",
    })).toMatchObject({
      label: "Ship the fix after review",
      paused: undefined,
    });

    expect(buildQueuedOutboundItemView({
      id: "queue-2",
      action: "retry",
      content: "",
      targetTurnId: "turn-abcdef",
      createdAt: "2026-03-22T12:00:00.000Z",
      paused: true,
    })).toMatchObject({
      label: "Turn abcdef",
      paused: true,
    });
  });

  it("keeps provider-disabled and misconfigured model messaging explicit", () => {
    expect(resolveProviderSelectionPlan({
      provider: {
        providerId: "anthropic",
        label: "Anthropic",
        disabled: true,
        availabilityHint: "Anthropic is disabled until the API key is configured.",
        models: [],
      },
      loadedModels: [],
    })).toEqual({
      blockedMessage: "Anthropic is disabled until the API key is configured.",
    });

    expect(resolveProviderSelectionPlan({
      provider: {
        providerId: "openai",
        label: "OpenAI",
        models: [],
      },
      loadedModels: [],
    })).toEqual({
      missingModelMessage: "No models are available for OpenAI yet. Check the provider configuration and retry.",
    });

    expect(resolveProviderSelectionPlan({
      provider: {
        providerId: "openai",
        label: "OpenAI",
        models: ["gpt-5.4-mini"],
        defaultModel: "gpt-5.4",
      },
      loadedModels: ["gpt-5.4"],
    })).toEqual({
      nextModel: "gpt-5.4",
    });
  });

  it("detects likely local provider urls", () => {
    expect(isLikelyLocalProviderUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLikelyLocalProviderUrl("http://localhost:1234/v1")).toBe(true);
    expect(isLikelyLocalProviderUrl("https://api.openai.com/v1")).toBe(false);
  });

  it("normalizes obviously mismatched provider/model combinations back to the provider catalog", () => {
    expect(resolveProviderModelSelection({
      provider: {
        providerId: "openai",
        label: "OpenAI",
        defaultModel: "gpt-5.4-mini",
        models: ["gpt-5.4-mini", "gpt-5.4"],
      },
      loadedModels: [],
      selectedModel: "claude-sonnet-4-6",
    })).toEqual({
      nextModel: "gpt-5.4-mini",
      model: "gpt-5.4-mini",
      modelNormalized: true,
    });

    expect(resolveProviderModelSelection({
      provider: {
        providerId: "openrouter",
        label: "OpenRouter",
        defaultModel: "openai/gpt-5.4-mini",
        models: ["openai/gpt-5.4-mini", "anthropic/claude-sonnet-4"],
      },
      loadedModels: [],
      selectedModel: "anthropic/claude-sonnet-4",
    })).toEqual({
      nextModel: "openai/gpt-5.4-mini",
      model: "anthropic/claude-sonnet-4",
    });
  });
});
