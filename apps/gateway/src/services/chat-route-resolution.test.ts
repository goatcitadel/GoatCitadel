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
  liveCatalog?: Record<string, string[]>;
  catalogStale?: boolean;
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
      getCachedModelAvailability: vi.fn((providerId: string, model: string) => {
        const models = input?.liveCatalog?.[providerId];
        return models
          ? models.includes(model)
            ? input?.catalogStale
              ? "stale_available"
              : "available"
            : input?.catalogStale
              ? "stale_unavailable"
              : "unavailable"
          : "unverified";
      }),
      getRuntimeConfig: vi.fn(() => ({
        activeProviderId: input?.runtime?.activeProviderId !== undefined ? input.runtime.activeProviderId : "openai",
        activeModel: input?.runtime?.activeModel !== undefined ? input.runtime.activeModel : "gpt-5.4-mini",
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
  it("normalizes a foreign model onto the selected provider default", async () => {
    const host = createHost({
      sessionPrefs: {
        providerId: "openai",
        model: "claude-sonnet-4-6",
      },
    });

    const result = await resolveChatRouteDescriptor(host as never, "session-1", {
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

  it("predicts local-to-cloud fallback when the global route can cross boundaries", async () => {
    const host = createHost({
      runtime: {
        activeProviderId: "ollama",
        activeModel: "llama3.2",
      },
      fallbacks: [{ providerId: "openai", model: "gpt-5.4-mini" }],
    });

    const result = await resolveChatRouteDescriptor(host as never, "session-1", {
      action: "send",
    });

    expect(result.selectionSource).toBe("global");
    expect(result.fallbackPolicy).toBe("off");
    expect(result.fallbackResult).toBe("not_applicable");
    expect(result.degradedReason).toBeUndefined();
  });

  it("keeps sends on the preflight route without resolving a capability profile", async () => {
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
    expect(result.degradedReason).toBeUndefined();
    expect(result.capabilityProfile).toBeUndefined();
    expect(result.decision.capabilityFingerprint).toBeUndefined();
    expect(host.resolveCapabilityPreflight).not.toHaveBeenCalled();
  });

  it.each(["retry", "edit"] as const)("keeps a content-free %s preflight on its selected provider", async (action) => {
    const host = createHost({
      runtime: { activeProviderId: "ollama", activeModel: "llama3.2" },
      fallbacks: [{ providerId: "openai", model: "gpt-5.4-mini" }],
    });
    const result = await preflightChatRoute(host as never, "session-1", { action, turnId: "source-turn" });
    expect(result.fallbackPolicy).toBe("off");
    expect(result.fallbackResult).toBe("not_applicable");
    expect(result.degradedReason).toBeUndefined();
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

  it("does not classify public hosts with private-address prefixes as local", async () => {
    for (const baseUrl of [
      "http://localhost.evil.test",
      "http://10.evil.test",
      "http://192.168.evil.test",
      "http://172.20.evil.test",
    ]) {
      const host = createHost({
        runtime: {
          activeProviderId: "custom",
          activeModel: "model-1",
          providers: [{ providerId: "custom", label: "Custom", baseUrl, defaultModel: "model-1", hasApiKey: false }],
        },
      });
      const result = await resolveChatRouteDescriptor(host as never, "session-1", { action: "send" });
      expect(result.runtimeClass).toBe("cloud");
      expect(result.blockedReason).toContain("Add an API key");
    }
  });

  it("uses selected turn context validation for retry/edit preflight requests", async () => {
    const host = createHost();

    await preflightChatRoute(host as never, "session-1", {
      action: "retry",
      turnId: "turn-1",
    });

    expect(host.requireChatTurnContext).toHaveBeenCalledWith("session-1", "turn-1");
  });

  it("blocks missing, unknown, unauthenticated, and model-less provider routes before dispatch", async () => {
    expect(
      await resolveChatRouteDescriptor(
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
      await resolveChatRouteDescriptor(createHost() as never, "session-1", {
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
      await resolveChatRouteDescriptor(
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
      await resolveChatRouteDescriptor(
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

  it("points a missing provider at the real Settings destination", async () => {
    const route = await resolveChatRouteDescriptor(
      createHost({
        sessionPrefs: { providerId: undefined, model: undefined },
        runtime: { activeProviderId: "", activeModel: "", providers: [] },
      }) as never,
      "session-1",
      { action: "send" },
    );

    expect(route.blockedReason).toContain("Settings → Providers & models");
    // Mission Control has no "Configure" destination; clients echo this text.
    expect(route.blockedReason).not.toContain("Configure");
  });

  it("normalizes an unsupported bare GPT model on the explicitly selected OpenAI Codex provider", async () => {
    const route = await resolveChatRouteDescriptor(
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
        effectiveModel: "gpt-5.5",
        blockedReason: undefined,
        normalizationReason: expect.stringContaining("cannot run gpt-5.4"),
      }),
    );
  });

  it("uses a fresh account catalog for new and removed models", async () => {
    const host = createHost({
      runtime: {
        activeProviderId: "openai-codex",
        activeModel: "gpt-5.4",
        providers: [
          {
            providerId: "openai-codex",
            label: "OpenAI Codex",
            defaultModel: "gpt-5.5",
            hasApiKey: true,
            baseUrl: "https://chatgpt.com/backend-api/codex",
          },
        ],
      },
      liveCatalog: { "openai-codex": ["gpt-new"] },
    });
    const added = await resolveChatRouteDescriptor(host as never, "session-1", {
      action: "send",
      providerId: "openai-codex",
      model: "gpt-new",
    });
    expect(added).toMatchObject({ effectiveModel: "gpt-new", blockedReason: undefined });

    const removed = await resolveChatRouteDescriptor(host as never, "session-1", {
      action: "send",
      providerId: "openai-codex",
      model: "gpt-5.4",
    });
    expect(removed).toMatchObject({
      effectiveModel: undefined,
      blockedReason: expect.stringContaining("no longer listed"),
    });

    const removedDefault = await resolveChatRouteDescriptor(host as never, "session-1", { action: "send" });
    expect(removedDefault).toMatchObject({
      effectiveModel: undefined,
      blockedReason: expect.stringContaining("Choose an available model"),
    });
  });

  it("keeps stale catalog membership distinct from a newly verified removal", async () => {
    const host = createHost({
      runtime: {
        activeProviderId: "openai-codex",
        activeModel: "gpt-5.4",
        providers: [
          {
            providerId: "openai-codex",
            label: "OpenAI Codex",
            defaultModel: "gpt-5.5",
            hasApiKey: true,
            baseUrl: "https://chatgpt.com/backend-api/codex",
          },
        ],
      },
      liveCatalog: { "openai-codex": ["gpt-new"] },
      catalogStale: true,
    });
    const kept = await resolveChatRouteDescriptor(host as never, "session-1", {
      action: "send",
      providerId: "openai-codex",
      model: "gpt-new",
    });
    expect(kept.effectiveModel).toBe("gpt-new");
    const absent = await resolveChatRouteDescriptor(host as never, "session-1", {
      action: "send",
      providerId: "openai-codex",
      model: "gpt-5.4",
    });
    expect(absent.blockedReason).toContain("last known model list");
    expect(absent.blockedReason).toContain("Refresh the catalog");
  });

  it("normalizes google model ids and keeps cross-provider fallback off", async () => {
    const google = await resolveChatRouteDescriptor(
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

    const googlePrefixed = await resolveChatRouteDescriptor(
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

    const googleNonGemini = await resolveChatRouteDescriptor(
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

    const providerDefaultWhenInactive = await resolveChatRouteDescriptor(
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

    const missingModel = await resolveChatRouteDescriptor(
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

    const sameBoundary = await resolveChatRouteDescriptor(
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
        fallbackPolicy: "off",
        fallbackResult: "not_applicable",
        degradedReason: undefined,
      }),
    );

    const cloudToLocal = await resolveChatRouteDescriptor(
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
        fallbackPolicy: "off",
        fallbackResult: "not_applicable",
        degradedReason: undefined,
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
