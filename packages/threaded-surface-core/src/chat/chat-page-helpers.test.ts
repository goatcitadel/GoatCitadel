import { describe, expect, it } from "vitest";
import {
  buildQueuedOutboundItemView,
  isLikelyLocalProviderUrl,
  resolveProviderModelSelection,
  resolveProviderSelectionPlan,
  resolveStreamTurnOperation,
} from "./chat-page-helpers";

describe("chat-page-helpers", () => {
  it("builds readable queue labels with fallback target identifiers", () => {
    expect(
      buildQueuedOutboundItemView({
        id: "queue-1",
        action: "send",
        content: ` ${"x".repeat(120)} `,
        createdAt: "2026-05-04T12:00:00.000Z",
        paused: true,
      }),
    ).toMatchObject({
      id: "queue-1",
      action: "send",
      label: "x".repeat(96),
      paused: true,
    });
    expect(
      buildQueuedOutboundItemView({
        id: "queue-2",
        action: "retry",
        content: "   ",
        targetTurnId: "turn-abcdef",
        createdAt: "2026-05-04T12:00:00.000Z",
      }).label,
    ).toBe("Turn abcdef");
  });

  it("resolves stream operations from resume attempts, actions, and targets", () => {
    expect(resolveStreamTurnOperation({ action: "send", resumeAttempts: 1 })).toBe("resume");
    expect(resolveStreamTurnOperation({ action: "retry", resumeAttempts: 0, targetTurnId: "turn-1" })).toBe("retry");
    expect(resolveStreamTurnOperation({ action: "edit", resumeAttempts: 0, targetTurnId: "turn-1" })).toBe("edit");
    expect(resolveStreamTurnOperation({ action: "retry", resumeAttempts: 0 })).toBe("send");
  });

  it("resolves provider selection blocks, missing models, and deduped defaults", () => {
    expect(resolveProviderSelectionPlan({ provider: null, loadedModels: [] })).toEqual({ blockedMessage: undefined });
    expect(
      resolveProviderSelectionPlan({
        provider: {
          providerId: "openai",
          label: "OpenAI",
          disabled: true,
          models: [],
        },
        loadedModels: [],
      }),
    ).toEqual({ blockedMessage: "OpenAI is not configured yet." });
    expect(
      resolveProviderSelectionPlan({
        provider: {
          providerId: "openai",
          label: "OpenAI",
          availabilityHint: "Missing key",
          disabled: true,
          models: [],
        },
        loadedModels: [],
      }),
    ).toEqual({ blockedMessage: "Missing key" });
    expect(
      resolveProviderSelectionPlan({
        provider: {
          providerId: "empty",
          label: "Empty",
          models: ["", " "],
        },
        loadedModels: [],
      }),
    ).toEqual({
      missingModelMessage: "No models are available for Empty yet. Check the provider configuration and retry.",
    });
    expect(
      resolveProviderSelectionPlan({
        provider: {
          providerId: "openai",
          label: "OpenAI",
          models: ["gpt-5.5"],
          defaultModel: "gpt-5.4-mini",
        },
        loadedModels: ["gpt-5.5", "gpt-5.5"],
      }),
    ).toEqual({ nextModel: "gpt-5.5" });
  });

  it("detects likely local provider URLs", () => {
    expect(isLikelyLocalProviderUrl("http://localhost:8080")).toBe(true);
    expect(isLikelyLocalProviderUrl("https://127.0.0.1:8080")).toBe(true);
    expect(isLikelyLocalProviderUrl("http://10.0.0.5")).toBe(true);
    expect(isLikelyLocalProviderUrl("http://172.20.0.5")).toBe(true);
    expect(isLikelyLocalProviderUrl("http://192.168.1.2")).toBe(true);
    expect(isLikelyLocalProviderUrl("https://api.example.test")).toBe(false);
    expect(isLikelyLocalProviderUrl(undefined)).toBe(false);
  });

  it("normalizes provider model selections without crossing provider boundaries", () => {
    const provider = {
      providerId: "openai",
      label: "OpenAI",
      models: ["gpt-5.5", "gpt-5.4-mini"],
      defaultModel: "gpt-5.4-mini",
    };

    expect(resolveProviderModelSelection({ provider: null, loadedModels: [] })).toEqual({
      blockedMessage: undefined,
    });
    const knownSelection = resolveProviderModelSelection({ provider, loadedModels: [], selectedModel: " gpt-5.5 " });
    expect(knownSelection.model).toBe("gpt-5.5");
    expect(knownSelection).not.toHaveProperty("modelNormalized");
    expect(
      resolveProviderModelSelection({ provider, loadedModels: [], selectedModel: "anthropic/claude-sonnet-4" }),
    ).toMatchObject({
      model: "gpt-5.5",
      modelNormalized: true,
      nextModel: "gpt-5.5",
    });
    expect(resolveProviderModelSelection({ provider, loadedModels: [], selectedModel: "custom-model" })).toMatchObject({
      model: "custom-model",
    });
    expect(resolveProviderModelSelection({ provider, loadedModels: [], selectedModel: " " })).toMatchObject({
      model: "gpt-5.5",
      modelNormalized: true,
    });
  });
});
