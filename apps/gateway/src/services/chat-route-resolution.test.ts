import { describe, expect, it, vi } from "vitest";
import { preflightChatRoute, resolveChatRouteDescriptor } from "./chat-route-resolution.js";

function createHost(input?: {
  sessionPrefs?: {
    providerId?: string;
    model?: string;
    mode?: "chat" | "cowork" | "code";
    webMode?: "auto" | "off" | "quick" | "deep";
    thinkingLevel?: "minimal" | "standard" | "extended";
  };
  runtime?: {
    activeProviderId?: string;
    activeModel?: string;
    providers?: Array<{
      providerId: string;
      label: string;
      defaultModel?: string;
      hasApiKey?: boolean;
      baseUrl?: string;
    }>;
  };
  fallbacks?: Array<{ providerId: string; model: string }>;
  listModels?: Array<{ id: string }> | Error;
}) {
  return {
    storage: {
      chatSessionPrefs: {
        ensure: vi.fn(() => ({
          sessionId: "session-1",
          mode: input?.sessionPrefs?.mode ?? "cowork",
          planningMode: "off",
          providerId: input?.sessionPrefs?.providerId,
          model: input?.sessionPrefs?.model,
          webMode: input?.sessionPrefs?.webMode ?? "auto",
          memoryMode: "auto",
          thinkingLevel: input?.sessionPrefs?.thinkingLevel ?? "extended",
          toolAutonomy: "safe_auto",
          orchestrationEnabled: true,
          orchestrationIntensity: "balanced",
          orchestrationVisibility: "expandable",
          orchestrationProviderPreference: "balanced",
          orchestrationReviewDepth: "standard",
          orchestrationParallelism: "parallel",
          codeAutoApply: "manual",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
        })),
      },
    },
    llmService: {
      getRuntimeConfig: vi.fn(() => ({
        activeProviderId: input?.runtime?.activeProviderId ?? "openai",
        activeModel: input?.runtime?.activeModel ?? "gpt-5.4-mini",
        providers: input?.runtime?.providers ?? [
          {
            providerId: "openai",
            label: "OpenAI",
            defaultModel: "gpt-5.4-mini",
            hasApiKey: true,
            baseUrl: "https://api.openai.com/v1",
          },
          {
            providerId: "ollama",
            label: "Ollama",
            defaultModel: "llama3.2",
            hasApiKey: false,
            baseUrl: "http://127.0.0.1:11434/v1",
          },
        ],
      })),
    },
    resolveFallbackTargets: vi.fn(() => input?.fallbacks ?? []),
    listLlmModels: vi.fn(async () => {
      if (input?.listModels instanceof Error) {
        throw input.listModels;
      }
      return input?.listModels ?? [{ id: "llama3.2" }];
    }),
    requireChatTurnContext: vi.fn(async () => ({
      trace: { sessionId: "session-1" },
    })),
  };
}

describe("chat-route-resolution", () => {
  it("normalizes a foreign model onto the selected provider default", () => {
    const host = createHost({
      sessionPrefs: {
        providerId: "openai",
        model: "claude-sonnet-4-6",
      },
    });

    const result = resolveChatRouteDescriptor(host as never, "session-1", {
      action: "send",
      prefsOverride: {
        providerId: "openai",
        model: "claude-sonnet-4-6",
      },
    });

    expect(result.selectionSource).toBe("session");
    expect(result.requestedProviderId).toBe("openai");
    expect(result.requestedModel).toBe("claude-sonnet-4-6");
    expect(result.effectiveModel).toBe("gpt-5.4-mini");
    expect(result.normalizationReason).toContain("Model changed from claude-sonnet-4-6 to gpt-5.4-mini");
  });

  it("predicts local-to-cloud fallback when the global route can cross boundaries", () => {
    const host = createHost({
      runtime: {
        activeProviderId: "ollama",
        activeModel: "llama3.2",
      },
      fallbacks: [{ providerId: "openai", model: "gpt-5.4-mini" }],
    });

    const result = resolveChatRouteDescriptor(host as never, "session-1", {
      action: "send",
    });

    expect(result.selectionSource).toBe("global");
    expect(result.fallbackPolicy).toBe("armed");
    expect(result.fallbackResult).toBe("local_to_cloud");
    expect(result.degradedReason).toContain("local to cloud");
  });

  it("blocks when a local runtime is unreachable during preflight", async () => {
    const host = createHost({
      runtime: {
        activeProviderId: "ollama",
        activeModel: "llama3.2",
      },
      listModels: new Error("ECONNREFUSED"),
    });

    const result = await preflightChatRoute(host as never, "session-1", {
      action: "send",
    });

    expect(result.runtimeClass).toBe("local");
    expect(result.runtimeReachability).toBe("unreachable");
    expect(result.blockedReason).toContain("runtime could not be reached");
  });

  it("uses selected turn context validation for retry/edit preflight requests", async () => {
    const host = createHost();

    await preflightChatRoute(host as never, "session-1", {
      action: "retry",
      turnId: "turn-1",
    });

    expect(host.requireChatTurnContext).toHaveBeenCalledWith("session-1", "turn-1");
  });
});
