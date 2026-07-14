import { describe, expect, it, vi } from "vitest";
import {
  createRoutingDecisionFingerprint,
  preflightChatRoute,
  resolveChatRouteDescriptor,
} from "./chat-route-resolution.js";

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

  it("freezes cross-provider fallback off when capability admission is resolved", async () => {
    const host = createHost({
      runtime: { activeProviderId: "ollama", activeModel: "llama3.2" },
      fallbacks: [{ providerId: "openai", model: "gpt-5.4-mini" }],
    }) as ReturnType<typeof createHost> & { resolveCapabilityPreflight: ReturnType<typeof vi.fn> };
    host.resolveCapabilityPreflight = vi.fn(async () => ({
      schemaVersion: "chat.turn.capability-profile.v1",
      fingerprint: "a".repeat(64),
      contentHash: "b".repeat(64),
      providerId: "ollama",
      model: "llama3.2",
      fallbackCount: 0,
      selectedTools: [],
      trustedSkills: [],
      memory: {
        mode: "auto",
        retrievalMode: "standard",
        workspaceId: "default",
        sessionId: "session-1",
        contextManifestRef: `chat-memory-scope:${"c".repeat(64)}`,
        writeApprovalRequired: true,
      },
      approval: {
        mode: "approve_all",
        selectedToolCount: 0,
        toolsRequiringApproval: [],
        approvalGranted: false,
      },
      authReadiness: [],
      blockedReasons: [],
    }));

    const result = await preflightChatRoute(host as never, "session-1", {
      action: "send",
      content: "Use only the frozen route.",
    });

    expect(result.fallbackPolicy).toBe("off");
    expect(result.fallbackResult).toBe("not_applicable");
    expect(result.capabilityProfile?.fallbackCount).toBe(0);
    expect(result.decision.capabilityFingerprint).toBe("a".repeat(64));
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

  it("blocks missing, unknown, unauthenticated, and model-less provider routes before dispatch", () => {
    expect(
      resolveChatRouteDescriptor(
        createHost({
          sessionPrefs: { providerId: undefined, model: undefined },
          runtime: {
            activeProviderId: "",
            activeModel: "",
            providers: [],
          },
        }) as never,
        "session-1",
        { action: "send" },
      ),
    ).toEqual(
      expect.objectContaining({
        runtimeClass: "unknown",
        blockedReason: expect.stringContaining("No model provider is configured"),
      }),
    );

    expect(
      resolveChatRouteDescriptor(createHost() as never, "session-1", {
        action: "send",
        providerId: "missing-provider",
      }),
    ).toEqual(
      expect.objectContaining({
        effectiveProviderId: "missing-provider",
        runtimeClass: "unknown",
        blockedReason: "Unknown model provider: missing-provider.",
      }),
    );

    expect(
      resolveChatRouteDescriptor(
        createHost({
          runtime: {
            activeProviderId: "anthropic",
            activeModel: "claude-sonnet-4-6",
            providers: [
              {
                providerId: "anthropic",
                label: "Anthropic",
                defaultModel: "claude-sonnet-4-6",
                hasApiKey: false,
                baseUrl: "https://api.anthropic.com/v1",
              },
            ],
          },
        }) as never,
        "session-1",
        { action: "send" },
      ),
    ).toEqual(
      expect.objectContaining({
        runtimeClass: "cloud",
        blockedReason: "Anthropic is not configured yet. Add an API key before using it.",
      }),
    );

    expect(
      resolveChatRouteDescriptor(
        createHost({
          sessionPrefs: { providerId: "openai", model: "claude-sonnet-4-6" },
          runtime: {
            activeProviderId: "openai",
            activeModel: "",
            providers: [
              {
                providerId: "openai",
                label: "OpenAI",
                hasApiKey: true,
                baseUrl: "https://api.openai.com/v1",
              },
            ],
          },
        }) as never,
        "session-1",
        { action: "send", providerId: "openai", model: "claude-sonnet-4-6" },
      ),
    ).toEqual(
      expect.objectContaining({
        effectiveModel: undefined,
        blockedReason: "Model claude-sonnet-4-6 belongs to anthropic; choose a openai model first.",
      }),
    );
  });

  it("keeps a supported shared bare GPT model on the explicitly selected OpenAI Codex provider", () => {
    const route = resolveChatRouteDescriptor(
      createHost({
        runtime: {
          activeProviderId: "openai-codex",
          activeModel: "gpt-5.5",
          providers: [
            {
              providerId: "openai-codex",
              label: "OpenAI Codex (ChatGPT OAuth)",
              defaultModel: "gpt-5.5",
              hasApiKey: true,
              baseUrl: "https://chatgpt.com/backend-api/codex",
            },
          ],
        },
      }) as never,
      "session-1",
      { action: "send", providerId: "openai-codex", model: "gpt-5.4" },
    );

    expect(route).toEqual(
      expect.objectContaining({
        effectiveProviderId: "openai-codex",
        effectiveModel: "gpt-5.4",
        blockedReason: undefined,
      }),
    );
  });

  it("normalizes google model ids and reports fallback boundary direction", () => {
    const google = resolveChatRouteDescriptor(
      createHost({
        runtime: {
          activeProviderId: "google",
          activeModel: "gemini-2.5-flash",
          providers: [
            {
              providerId: "google",
              label: "Google",
              defaultModel: "gemini-2.5-flash",
              hasApiKey: true,
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            },
          ],
        },
      }) as never,
      "session-1",
      { action: "send", providerId: "google", model: "gemini-2.5-pro" },
    );
    expect(google.effectiveModel).toBe("models/gemini-2.5-pro");

    const googlePrefixed = resolveChatRouteDescriptor(
      createHost({
        runtime: {
          activeProviderId: "google",
          activeModel: "models/gemini-2.5-flash",
          providers: [
            {
              providerId: "google",
              label: "Google",
              defaultModel: "models/gemini-2.5-flash",
              hasApiKey: true,
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            },
          ],
        },
      }) as never,
      "session-1",
      { action: "send", providerId: "google", model: "models/gemini-2.5-flash" },
    );
    expect(googlePrefixed.effectiveModel).toBe("models/gemini-2.5-flash");

    const googleNonGemini = resolveChatRouteDescriptor(
      createHost({
        runtime: {
          activeProviderId: "google",
          activeModel: "text-bison",
          providers: [
            {
              providerId: "google",
              label: "Google",
              defaultModel: "text-bison",
              hasApiKey: true,
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            },
          ],
        },
      }) as never,
      "session-1",
      { action: "send", providerId: "google", model: " text-bison " },
    );
    expect(googleNonGemini.effectiveModel).toBe("text-bison");

    const providerDefaultWhenInactive = resolveChatRouteDescriptor(
      createHost({
        sessionPrefs: { providerId: "anthropic" },
        runtime: {
          activeProviderId: "openai",
          activeModel: "gpt-5.4",
          providers: [
            {
              providerId: "openai",
              label: "OpenAI",
              defaultModel: "gpt-5.4",
              hasApiKey: true,
              baseUrl: "https://api.openai.com/v1",
            },
            {
              providerId: "anthropic",
              label: "Anthropic",
              defaultModel: "claude-sonnet-4-6",
              hasApiKey: true,
              baseUrl: "https://api.anthropic.com/v1",
            },
          ],
        },
      }) as never,
      "session-1",
      { action: "send", providerId: "anthropic" },
    );
    expect(providerDefaultWhenInactive.effectiveModel).toBe("claude-sonnet-4-6");

    const missingModel = resolveChatRouteDescriptor(
      createHost({
        runtime: {
          activeProviderId: "openai",
          activeModel: "",
          providers: [
            {
              providerId: "openai",
              label: "OpenAI",
              hasApiKey: true,
              baseUrl: "https://api.openai.com/v1",
            },
          ],
        },
      }) as never,
      "session-1",
      { action: "send" },
    );
    expect(missingModel.blockedReason).toBe("No model is configured for OpenAI. Select a model first.");

    const sameBoundary = resolveChatRouteDescriptor(
      createHost({
        runtime: {
          activeProviderId: "openai",
          activeModel: "gpt-5.4",
          providers: [
            {
              providerId: "openai",
              label: "OpenAI",
              defaultModel: "gpt-5.4",
              hasApiKey: true,
              baseUrl: "https://api.openai.com/v1",
            },
            {
              providerId: "anthropic",
              label: "Anthropic",
              defaultModel: "claude-sonnet-4-6",
              hasApiKey: true,
              baseUrl: "https://api.anthropic.com/v1",
            },
          ],
        },
        fallbacks: [{ providerId: "anthropic", model: "claude-sonnet-4-6" }],
      }) as never,
      "session-1",
      { action: "send" },
    );
    expect(sameBoundary).toEqual(
      expect.objectContaining({
        fallbackPolicy: "armed",
        fallbackResult: "same_boundary",
        degradedReason: "Fallback is armed if the primary route fails.",
      }),
    );

    const cloudToLocal = resolveChatRouteDescriptor(
      createHost({
        runtime: {
          activeProviderId: "openai",
          activeModel: "gpt-5.4",
          providers: [
            {
              providerId: "openai",
              label: "OpenAI",
              defaultModel: "gpt-5.4",
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
        },
        fallbacks: [{ providerId: "ollama", model: "llama3.2" }],
      }) as never,
      "session-1",
      { action: "send" },
    );
    expect(cloudToLocal).toEqual(
      expect.objectContaining({
        fallbackPolicy: "armed",
        fallbackResult: "cloud_to_local",
        degradedReason: expect.stringContaining("cloud to local"),
      }),
    );
  });

  it("preflights local runtimes with empty model lists and uses stable fingerprints", async () => {
    const host = createHost({
      runtime: {
        activeProviderId: "ollama",
        activeModel: "llama3.2",
      },
      listModels: [],
    });

    const preflight = await preflightChatRoute(host as never, "session-1", { action: "send" });

    expect(preflight).toEqual(
      expect.objectContaining({
        runtimeClass: "local",
        runtimeReachability: "models_unavailable",
        blockedReason: "No models are currently available for Ollama.",
      }),
    );

    const base = {
      action: "send" as const,
      requestedProviderId: "openai",
      requestedModel: "gpt-5.4",
      effectiveProviderId: "openai",
      effectiveModel: "gpt-5.4",
      selectionSource: "manual" as const,
      fallbackPolicy: "off" as const,
      fallbackResult: "not_applicable" as const,
      runtimeReachability: "not_checked" as const,
      runtimeClass: "cloud" as const,
      issuedAt: "2026-05-14T00:00:00.000Z",
      expiresAt: "2026-05-14T00:00:30.000Z",
    };
    expect(createRoutingDecisionFingerprint(base)).toBe(
      createRoutingDecisionFingerprint({
        ...base,
        issuedAt: "2026-05-14T00:01:00.000Z",
        expiresAt: "2026-05-14T00:01:30.000Z",
      }),
    );
    expect(
      createRoutingDecisionFingerprint({
        ...base,
        requestedModel: ["gpt-5.4", "backup"] as never,
      }),
    ).toEqual(expect.any(String));
  });
});
