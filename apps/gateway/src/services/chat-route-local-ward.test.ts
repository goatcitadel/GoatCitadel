import { describe, expect, it, vi } from "vitest";
import { PolicyViolationError, type ModelUsageAttributionContext } from "@goatcitadel/contracts";
import {
  admitChatRouteWard,
  assertChatRouteWardAdmitsTurn,
  buildModelChatWardAction,
  createModelChatWardDispatchGuard,
  filterWardAdmittedFallbackTargets,
  isLoopbackUrl,
  isRouteLocalProvider,
  readCitadelWardDispatchReason,
  routeWardActionsFor,
  selectRouteLocalProvider,
} from "./chat-route-local-ward.js";
import { LlmDispatchGuardRejectedError } from "./llm-dispatch-guard.js";

function provider(providerId: string, baseUrl: string, defaultModel = "model-a") {
  return { providerId, label: providerId, baseUrl, defaultModel, hasApiKey: false };
}

describe("chat-route-local-ward", () => {
  it("isLoopbackUrl accepts only loopback hosts", () => {
    expect(isLoopbackUrl("http://localhost:11434")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.2:8080/v1")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:1234")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.5:11434")).toBe(false);
    expect(isLoopbackUrl("https://api.openai.com")).toBe(false);
    expect(isLoopbackUrl("http://localhost.evil.com")).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
  });

  it("isRouteLocalProvider means a loopback host for any engine kind", () => {
    expect(isRouteLocalProvider(provider("ollama", "http://127.0.0.1:11434"))).toBe(true);
    expect(isRouteLocalProvider(provider("openai_compatible", "http://10.0.0.5:8000"))).toBe(false);
    expect(isRouteLocalProvider(provider("ollama", "https://ollama.com"))).toBe(false);
    // "Kept on this machine": a LAN Ollama or llama.cpp host is not this machine.
    expect(isRouteLocalProvider(provider("ollama", "http://192.168.1.20:11434"))).toBe(false);
    expect(isRouteLocalProvider(provider("llamacpp", "http://10.0.0.7:8080"))).toBe(false);
    expect(isRouteLocalProvider(provider("llamacpp", "http://localhost:8080"))).toBe(true);
    expect(isRouteLocalProvider(provider("my-endpoint", "http://127.0.0.1:8000/v1"))).toBe(true);
    // No engine-kind inference: LM Studio and a loopback port that merely contains
    // "11434" are judged by the host alone.
    expect(isRouteLocalProvider(provider("lmstudio", "http://127.0.0.1:1234/v1"))).toBe(true);
    expect(isRouteLocalProvider(provider("cloud-proxy", "https://proxy.example.com:11234/v1"))).toBe(false);
    expect(isRouteLocalProvider(provider("vllm", "http://[::1]:8000/v1"))).toBe(true);
  });

  it("buildModelChatWardAction names the per-provider chat action", () => {
    expect(buildModelChatWardAction("ollama")).toBe("model.chat.ollama");
  });

  it("selectRouteLocalProvider skips cloud, unavailable and denied candidates", () => {
    const providers = [
      provider("openai", "https://api.openai.com/v1", "gpt"),
      provider("ollama", "http://127.0.0.1:11434", "llama3.2"),
      provider("llamacpp", "http://localhost:8080", "qwen"),
    ];
    expect(selectRouteLocalProvider({ providers })).toMatchObject({
      provider: { providerId: "ollama" },
      model: "llama3.2",
    });
    expect(
      selectRouteLocalProvider({
        providers,
        getModelAvailability: (providerId) => (providerId === "ollama" ? "unavailable" : "available"),
      }),
    ).toMatchObject({ provider: { providerId: "llamacpp" }, model: "qwen" });
    expect(
      selectRouteLocalProvider({ providers, isProviderDenied: (providerId) => providerId !== "openai" }),
    ).toBeUndefined();
  });

  it("assertChatRouteWardAdmitsTurn throws only for blocking ward codes", () => {
    expect(() => assertChatRouteWardAdmitsTurn({ wardReasonCode: "citadel_ward_route_local" })).not.toThrow();
    expect(() => assertChatRouteWardAdmitsTurn({})).not.toThrow();
    let caught: unknown;
    try {
      assertChatRouteWardAdmitsTurn({
        wardReasonCode: "citadel_ward_route_local_unavailable",
        wardCitadelId: "citadel-1",
        blockedReason: "blocked",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PolicyViolationError);
    expect((caught as PolicyViolationError).details).toEqual({
      reason: "citadel_ward_route_local_unavailable",
      citadelId: "citadel-1",
    });
  });

  it("admitChatRouteWard returns an admitted descriptor and fails a blocked one closed", () => {
    const admitted = { wardReasonCode: "citadel_ward_route_local" as const, effectiveProviderId: "ollama" };
    expect(admitChatRouteWard(admitted)).toBe(admitted);
    expect(admitChatRouteWard(undefined)).toBeUndefined();
    expect(() => admitChatRouteWard({ wardReasonCode: "citadel_ward_deny", wardCitadelId: "citadel-1" })).toThrow(
      PolicyViolationError,
    );
  });
});

describe("model.chat ward dispatch backstop", () => {
  function wardDeps(effect: "route_local" | "deny" | "allow", actionPattern = "model.chat.*") {
    return {
      storage: {
        workspaces: { find: vi.fn(async () => ({ citadelId: "citadel-ops" })) },
        citadels: { listWards: vi.fn(async () => [{ name: "keep-local", actionPattern, effect }]) },
        chatSessionMeta: { get: vi.fn(async () => ({ workspaceId: "workspace-from-session" })) },
      },
    };
  }
  const chatAttribution: ModelUsageAttributionContext = {
    workspaceId: "workspace-ops",
    sessionId: "session-1",
    callKind: "chat_initial",
  };

  async function rejection(promise: Promise<void>) {
    try {
      await promise;
    } catch (error) {
      return error as Error & { cause?: unknown };
    }
    return undefined;
  }

  it("route_local ward rejects a dispatch to a non-local provider", async () => {
    const deps = wardDeps("route_local");
    const guard = createModelChatWardDispatchGuard(deps as never);
    const error = await rejection(
      guard({
        attribution: chatAttribution,
        route: { providerId: "moonshot" },
        providerBaseUrl: "https://api.moonshot.ai/v1",
      }),
    );
    expect(error).toBeInstanceOf(LlmDispatchGuardRejectedError);
    expect(error?.cause).toBeInstanceOf(PolicyViolationError);
    expect((error?.cause as PolicyViolationError).details).toEqual({
      reason: "citadel_ward_route_local_unavailable",
      citadelId: "citadel-ops",
    });
    expect(deps.storage.chatSessionMeta.get).toHaveBeenCalledWith("session-1");
    expect(deps.storage.workspaces.find).toHaveBeenCalledWith("workspace-from-session");
    expect(deps.storage.workspaces.find).not.toHaveBeenCalledWith("workspace-ops");
  });

  it("route_local ward passes a loopback local provider and rejects a LAN one", async () => {
    const guard = createModelChatWardDispatchGuard(wardDeps("route_local") as never);
    await expect(
      guard({
        attribution: chatAttribution,
        route: { providerId: "ollama" },
        providerBaseUrl: "http://127.0.0.1:11434",
      }),
    ).resolves.toBeUndefined();
    await expect(
      guard({
        attribution: chatAttribution,
        route: { providerId: "ollama" },
        providerBaseUrl: "http://192.168.1.20:11434",
      }),
    ).rejects.toBeInstanceOf(LlmDispatchGuardRejectedError);
  });

  it("deny ward rejects every provider, local or not", async () => {
    const guard = createModelChatWardDispatchGuard(wardDeps("deny") as never);
    for (const [providerId, providerBaseUrl] of [
      ["ollama", "http://127.0.0.1:11434"],
      ["moonshot", "https://api.moonshot.ai/v1"],
    ] as const) {
      const error = await rejection(guard({ attribution: chatAttribution, route: { providerId }, providerBaseUrl }));
      expect(error).toBeInstanceOf(LlmDispatchGuardRejectedError);
      expect((error?.cause as PolicyViolationError).details).toMatchObject({ reason: "citadel_ward_deny" });
    }
  });

  it("checks every chat call kind and resolves an unattributed workspace from the session", async () => {
    const deps = wardDeps("route_local");
    const guard = createModelChatWardDispatchGuard(deps as never);
    for (const callKind of ["chat_tool_loop", "chat_repair", "chat_fallback"] as const) {
      await expect(
        guard({ attribution: { ...chatAttribution, callKind }, route: { providerId: "moonshot" } }),
      ).rejects.toBeInstanceOf(LlmDispatchGuardRejectedError);
    }
    await expect(
      guard({ attribution: { sessionId: "session-1", callKind: "chat_initial" }, route: { providerId: "moonshot" } }),
    ).rejects.toBeInstanceOf(LlmDispatchGuardRejectedError);
    expect(deps.storage.chatSessionMeta.get).toHaveBeenCalledWith("session-1");
    expect(deps.storage.workspaces.find).toHaveBeenCalledWith("workspace-from-session");
  });

  it.each(["delegation_worker", "assembly_participant", "assembly_synthesis"] as const)(
    "route_local rejects a %s dispatch to a cloud provider",
    async (callKind) => {
      const guard = createModelChatWardDispatchGuard(wardDeps("route_local") as never);
      const error = await rejection(
        guard({
          attribution: { ...chatAttribution, callKind },
          route: { providerId: "moonshot" },
          providerBaseUrl: "https://api.moonshot.ai/v1",
        }),
      );
      expect(error).toBeInstanceOf(LlmDispatchGuardRejectedError);
      expect(readCitadelWardDispatchReason(error)).toBe("citadel_ward_route_local_unavailable");
    },
  );

  it("gates a utility call that carries session or turn lineage and passes one without it", async () => {
    const deps = wardDeps("route_local");
    const guard = createModelChatWardDispatchGuard(deps as never);
    for (const lineage of [{ sessionId: "session-1" }, { turnId: "turn-1", workspaceId: "workspace-ops" }]) {
      await expect(
        guard({
          attribution: { callKind: "utility", utilityKind: "chat_execution_plan_draft", ...lineage },
          route: { providerId: "moonshot" },
          providerBaseUrl: "https://api.moonshot.ai/v1",
        }),
      ).rejects.toBeInstanceOf(LlmDispatchGuardRejectedError);
    }
    deps.storage.citadels.listWards.mockClear();
    for (const callKind of ["utility", "embedding", "image_generation"] as const) {
      await expect(
        guard({
          attribution: { callKind, workspaceId: "workspace-ops" },
          route: { providerId: "moonshot" },
          providerBaseUrl: "https://api.moonshot.ai/v1",
        }),
      ).resolves.toBeUndefined();
    }
    expect(deps.storage.citadels.listWards).not.toHaveBeenCalled();
  });

  it("readCitadelWardDispatchReason reads only ward dispatch rejections", () => {
    const ward = new LlmDispatchGuardRejectedError(
      new PolicyViolationError({ message: "blocked", details: { reason: "citadel_ward_deny", citadelId: "c" } }),
    );
    expect(readCitadelWardDispatchReason(ward)).toBe("citadel_ward_deny");
    expect(readCitadelWardDispatchReason(new LlmDispatchGuardRejectedError(new Error("budget")))).toBeUndefined();
    expect(
      readCitadelWardDispatchReason(
        new LlmDispatchGuardRejectedError(
          new PolicyViolationError({ message: "other", details: { reason: "something_else" } }),
        ),
      ),
    ).toBeUndefined();
    expect(readCitadelWardDispatchReason(new Error("plain"))).toBeUndefined();
  });

  it("passes when no ward matches or ward storage is not wired", async () => {
    await expect(
      createModelChatWardDispatchGuard(wardDeps("allow") as never)({
        attribution: chatAttribution,
        route: { providerId: "moonshot" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      createModelChatWardDispatchGuard({ storage: {} })({
        attribution: chatAttribution,
        route: { providerId: "moonshot" },
      }),
    ).resolves.toBeUndefined();
  });

  it("filterWardAdmittedFallbackTargets drops targets the dispatch ward refuses", async () => {
    const admitsDispatchWard = vi.fn(
      async (_attribution: ModelUsageAttributionContext, providerId: string) => providerId !== "moonshot",
    );
    const targets = [
      { providerId: "moonshot", model: "kimi" },
      { providerId: "ollama", model: "llama3.2" },
    ];
    await expect(
      filterWardAdmittedFallbackTargets({ llmService: { admitsDispatchWard } }, chatAttribution, targets),
    ).resolves.toEqual([{ providerId: "ollama", model: "llama3.2" }]);
    expect(admitsDispatchWard).toHaveBeenCalledWith(chatAttribution, "moonshot");
    await expect(filterWardAdmittedFallbackTargets({ llmService: {} }, chatAttribution, targets)).resolves.toEqual(
      targets,
    );
  });
});

describe("model.chat ward across a local reroute", () => {
  // `model.chat.openai` is route_local; no ward names the local provider.
  function openAiRouteLocalDeps(sessionWorkspaceId: string | undefined = "workspace-ops") {
    return {
      storage: {
        workspaces: {
          find: vi.fn(async (workspaceId: string) =>
            workspaceId === "workspace-ops" ? { citadelId: "citadel-ops" } : undefined,
          ),
        },
        citadels: {
          listWards: vi.fn(async (citadelId: string) =>
            citadelId === "citadel-ops"
              ? [{ name: "openai-local", actionPattern: "model.chat.openai", effect: "route_local" as const }]
              : [],
          ),
        },
        chatSessionMeta: {
          get: vi.fn(async () => (sessionWorkspaceId ? { workspaceId: sessionWorkspaceId } : undefined)),
        },
      },
      recordDevDiagnostic: vi.fn(),
    };
  }
  const reroutedAttribution: ModelUsageAttributionContext = {
    workspaceId: "workspace-ops",
    sessionId: "session-1",
    turnId: "turn-1",
    callKind: "chat_initial",
    wardActions: routeWardActionsFor({ requestedProviderId: "openai", effectiveProviderId: "ollama" }),
  };

  it("routeWardActionsFor names the requested and effective providers once", () => {
    expect(routeWardActionsFor({ requestedProviderId: "openai", effectiveProviderId: "ollama" })).toEqual([
      "model.chat.openai",
      "model.chat.ollama",
    ]);
    expect(routeWardActionsFor({ requestedProviderId: "ollama", effectiveProviderId: "ollama" })).toEqual([
      "model.chat.ollama",
    ]);
    expect(routeWardActionsFor({})).toBeUndefined();
    expect(routeWardActionsFor(undefined)).toBeUndefined();
  });

  it("rejects a rerouted turn whose local provider now points at a remote URL", async () => {
    const guard = createModelChatWardDispatchGuard(openAiRouteLocalDeps() as never);
    await expect(
      guard({
        attribution: reroutedAttribution,
        route: { providerId: "ollama" },
        providerBaseUrl: "http://127.0.0.1:11434/v1",
      }),
    ).resolves.toBeUndefined();
    let caught: unknown;
    try {
      await guard({
        attribution: reroutedAttribution,
        route: { providerId: "ollama" },
        providerBaseUrl: "https://ollama.example.com/v1",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LlmDispatchGuardRejectedError);
    expect(readCitadelWardDispatchReason(caught)).toBe("citadel_ward_route_local_unavailable");
  });

  it("rejects a durable-resume dispatch that carries the governing ward action", async () => {
    const guard = createModelChatWardDispatchGuard(openAiRouteLocalDeps() as never);
    await expect(
      guard({
        attribution: { ...reroutedAttribution, durableRunId: "run-1", callKind: "chat_tool_loop" },
        route: { providerId: "ollama" },
        providerBaseUrl: "https://ollama.example.com/v1",
      }),
    ).rejects.toBeInstanceOf(LlmDispatchGuardRejectedError);
  });

  it("ignores carried actions outside model.chat", async () => {
    const deps = openAiRouteLocalDeps();
    deps.storage.citadels.listWards.mockImplementation(async () => [
      { name: "integration-local", actionPattern: "integration.*", effect: "route_local" as const },
    ]);
    const guard = createModelChatWardDispatchGuard(deps as never);
    await expect(
      guard({
        attribution: { ...reroutedAttribution, wardActions: ["integration.automation.gmail.send"] },
        route: { providerId: "ollama" },
        providerBaseUrl: "https://ollama.example.com/v1",
      }),
    ).resolves.toBeUndefined();
  });

  it("scopes the ward to the canonical session workspace, not the attribution workspace", async () => {
    const deps = openAiRouteLocalDeps("workspace-ops");
    const guard = createModelChatWardDispatchGuard(deps as never);
    await expect(
      guard({
        attribution: { workspaceId: "default", sessionId: "session-1", callKind: "chat_initial" },
        route: { providerId: "openai" },
        providerBaseUrl: "https://api.openai.com/v1",
      }),
    ).rejects.toBeInstanceOf(LlmDispatchGuardRejectedError);
    expect(deps.storage.workspaces.find).toHaveBeenCalledWith("workspace-ops");
    expect(deps.storage.workspaces.find).not.toHaveBeenCalledWith("default");
    expect(deps.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "chat.citadel_ward.workspace_scope_mismatch",
        sessionId: "session-1",
        context: { attributionWorkspaceId: "default", sessionWorkspaceId: "workspace-ops" },
      }),
    );
  });

  it("falls back to the attribution workspace only when the session is unknown", async () => {
    const deps = openAiRouteLocalDeps(undefined);
    const guard = createModelChatWardDispatchGuard(deps as never);
    await expect(
      guard({
        attribution: { workspaceId: "workspace-ops", sessionId: "mason-session", callKind: "chat_initial" },
        route: { providerId: "openai" },
        providerBaseUrl: "https://api.openai.com/v1",
      }),
    ).rejects.toBeInstanceOf(LlmDispatchGuardRejectedError);
    expect(deps.storage.workspaces.find).toHaveBeenCalledWith("workspace-ops");
    expect(deps.recordDevDiagnostic).not.toHaveBeenCalled();
  });
});
