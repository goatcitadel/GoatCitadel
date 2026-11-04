import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmConfigFile } from "@goatcitadel/contracts";
import { ProxyAgent } from "undici";
import { createFakeModelUsageAccounting } from "../test/claude-code-cli-fake-spawn.js";
import { createModelChatWardDispatchGuard, readCitadelWardDispatchReason, routeWardActionsFor } from "./chat-route-local-ward.js";
import { LlmDispatchGuardRejectedError } from "./llm-dispatch-guard.js";
import { LlmService } from "./llm-service.js";
import { createNoopSecretStore } from "../test/llm-fixtures.js";

// Keep provider fixtures explicit; real transport tests use the pinned implementation.
vi.mock("./llm-provider-fetch.js", () => ({
  fetchLlmProvider: (url: string, init: RequestInit) => globalThis.fetch(url, init),
}));

const config: LlmConfigFile = {
  activeProviderId: "moonshot",
  activeModel: "kimi-k2",
  providers: [
    {
      providerId: "moonshot",
      label: "Moonshot",
      baseUrl: "https://api.moonshot.ai/v1",
      apiStyle: "openai-chat-completions",
      defaultModel: "kimi-k2",
      apiKeyEnv: "MOONSHOT_TEST_KEY",
    },
  ],
};

function createService(): LlmService {
  return new LlmService(
    config,
    { MOONSHOT_TEST_KEY: "test-key" },
    {
      secretStore: createNoopSecretStore(),
      networkAllowlist: ["api.moonshot.ai"],
    },
  );
}

function routeLocalWardStorage() {
  return {
    workspaces: { find: vi.fn(async () => ({ citadelId: "citadel-ops" })) },
    citadels: {
      listWards: vi.fn(async () => [{ name: "keep-local", actionPattern: "model.chat.*", effect: "route_local" }]),
    },
  };
}

// A durable resume or bound capability profile turn reuses its frozen route and
// never re-runs route resolution; this is the attribution such a turn dispatches with.
const durableTurnAttribution = {
  workspaceId: "workspace-ops",
  sessionId: "session-1",
  turnId: "turn-1",
  durableRunId: "run-1",
  callKind: "chat_initial" as const,
};

function completionResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "kimi-k2",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("LlmService Citadel Ward dispatch backstop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a route_local chat turn bound to a cloud provider before any network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => completionResponse());
    const service = createService();
    service.setDispatchWardGuard(createModelChatWardDispatchGuard({ storage: routeLocalWardStorage() as never }));

    await expect(
      service.chatCompletions(
        { providerId: "moonshot", model: "kimi-k2", messages: [{ role: "user", content: "hello" }] },
        durableTurnAttribution,
      ),
    ).rejects.toBeInstanceOf(LlmDispatchGuardRejectedError);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(service.admitsDispatchWard(durableTurnAttribution, "moonshot")).resolves.toBe(false);
  });

  it("rejects a streamed route_local turn bound to a cloud provider before any network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => completionResponse());
    const service = createService();
    service.setDispatchWardGuard(createModelChatWardDispatchGuard({ storage: routeLocalWardStorage() as never }));

    const consume = async () => {
      for await (const _chunk of service.chatCompletionsStream(
        { providerId: "moonshot", model: "kimi-k2", messages: [{ role: "user", content: "hello" }] },
        { ...durableTurnAttribution, callKind: "chat_tool_loop" },
      )) {
        // never reached
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(LlmDispatchGuardRejectedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dispatches the same turn when no ward applies", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => completionResponse());
    const service = createService();
    const listWards = vi.fn(async () => []);
    service.setDispatchWardGuard(
      createModelChatWardDispatchGuard({
        storage: {
          workspaces: { find: vi.fn(async () => ({ citadelId: "citadel-ops" })) },
          citadels: { listWards },
        } as never,
      }),
    );

    await service.chatCompletions(
      { providerId: "moonshot", model: "kimi-k2", messages: [{ role: "user", content: "hello" }] },
      durableTurnAttribution,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(listWards).toHaveBeenCalledWith("citadel-ops");
    await expect(service.admitsDispatchWard(durableTurnAttribution, "moonshot")).resolves.toBe(true);
  });

  it("keeps the requested provider's route_local ward on a rerouted turn whose local provider moved off this machine", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => completionResponse());
    // The turn asked for openai, a `model.chat.openai` route_local ward rerouted
    // it to ollama, and ollama's endpoint was later changed to a remote host.
    const service = new LlmService(
      {
        activeProviderId: "ollama",
        activeModel: "llama3.2",
        providers: [
          {
            providerId: "ollama",
            label: "Ollama",
            baseUrl: "https://ollama.example.com/v1",
            apiStyle: "openai-chat-completions",
            defaultModel: "llama3.2",
            apiKeyEnv: "OLLAMA_TEST_KEY",
          },
        ],
      },
      { OLLAMA_TEST_KEY: "test-key" },
      { secretStore: createNoopSecretStore(), networkAllowlist: ["ollama.example.com"] },
    );
    service.setDispatchWardGuard(
      createModelChatWardDispatchGuard({
        storage: {
          workspaces: { find: vi.fn(async () => ({ citadelId: "citadel-ops" })) },
          citadels: {
            listWards: vi.fn(async () => [
              { name: "openai-local", actionPattern: "model.chat.openai", effect: "route_local" },
            ]),
          },
        } as never,
      }),
    );
    const rerouted = {
      ...durableTurnAttribution,
      wardActions: routeWardActionsFor({ requestedProviderId: "openai", effectiveProviderId: "ollama" }),
    };

    await expect(
      service.chatCompletions(
        { providerId: "ollama", model: "llama3.2", messages: [{ role: "user", content: "hello" }] },
        rerouted,
      ),
    ).rejects.toBeInstanceOf(LlmDispatchGuardRejectedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("LlmService Citadel Ward effective proxy boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const loopbackModelUrl = "http://127.0.0.1:11434/v1";
  const externalProxyUrl = "http://ward-proxy.invalid:3128";
  const localProxyUrl = "http://127.0.0.1:3128";
  const request = {
    providerId: "ollama",
    model: "llama3.2",
    messages: [{ role: "user" as const, content: "synthetic Ward dispatch marker" }],
  };

  function createProxiedService(proxyUrl: string, ward: boolean, bypassHosts?: string[]) {
    const accounting = createFakeModelUsageAccounting();
    const service = new LlmService(
      {
        activeProviderId: "ollama",
        activeModel: "llama3.2",
        providers: [
          {
            providerId: "ollama",
            label: "Local fixture",
            baseUrl: loopbackModelUrl,
            apiStyle: "openai-chat-completions",
            defaultModel: "llama3.2",
            apiKeyEnv: "WARD_TEST_PROVIDER_KEY",
            request: { proxy: { url: proxyUrl, ...(bypassHosts ? { bypassHosts } : {}) } },
          },
        ],
      },
      { WARD_TEST_PROVIDER_KEY: "synthetic-ward-test-value" },
      {
        secretStore: createNoopSecretStore(),
        networkAllowlist: ["127.0.0.1", "ward-proxy.invalid"],
        modelUsageAccounting: accounting.service,
      },
    );
    const storage = routeLocalWardStorage();
    if (!ward) storage.citadels.listWards.mockResolvedValue([]);
    service.setDispatchWardGuard(createModelChatWardDispatchGuard({ storage: storage as never }));
    return { service, accounting };
  }

  async function dispatch(service: LlmService, kind: "completion" | "stream") {
    if (kind === "completion") {
      await service.chatCompletions(request, durableTurnAttribution);
      return;
    }
    for await (const _chunk of service.chatCompletionsStream(request, {
      ...durableTurnAttribution,
      callKind: "chat_tool_loop",
    })) {
      // Drain the fake provider's complete response.
    }
  }

  it.each(["completion", "stream"] as const)(
    "blocks a %s through an active off-machine proxy before any usage intent or transport",
    async (kind) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        kind === "completion"
          ? completionResponse()
          : new Response('data: {"model":"llama3.2","choices":[{"index":0,"delta":{"content":"fixture"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
              headers: { "content-type": "text/event-stream" },
            }),
      );
      const { service, accounting } = createProxiedService(externalProxyUrl, true);

      const error = await dispatch(service, kind).then(() => undefined, (cause: unknown) => cause);

      expect({
        refused: error instanceof LlmDispatchGuardRejectedError,
        reason: readCitadelWardDispatchReason(error),
        fetches: fetchSpy.mock.calls.length,
        usageIntents: accounting.prepareDispatch.mock.calls.length,
      }).toEqual({
        refused: true,
        reason: "citadel_ward_route_local_unavailable",
        fetches: 0,
        usageIntents: 0,
      });
      await expect(service.admitsDispatchWard(durableTurnAttribution, "ollama")).resolves.toBe(false);
    },
  );

  it.each([
    { name: "allows the configured proxy without a matching Ward", proxy: externalProxyUrl, ward: false, bypass: undefined, proxied: true },
    { name: "keeps explicit proxy bypass direct under route_local", proxy: externalProxyUrl, ward: true, bypass: ["127.0.0.1"], proxied: false },
    { name: "trusts a loopback proxy under route_local", proxy: localProxyUrl, ward: true, bypass: undefined, proxied: true },
  ])("$name", async ({ proxy, ward, bypass, proxied }) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => completionResponse());
    const { service, accounting } = createProxiedService(proxy, ward, bypass);

    await dispatch(service, "completion");

    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(
      loopbackModelUrl + "/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    const options = fetchSpy.mock.calls[0]?.[1] as (RequestInit & { dispatcher?: unknown }) | undefined;
    expect(options?.dispatcher).toBeDefined();
    expect(options?.dispatcher instanceof ProxyAgent).toBe(proxied);
    expect(accounting.prepareDispatch).toHaveBeenCalledOnce();
    await expect(service.admitsDispatchWard(durableTurnAttribution, "ollama")).resolves.toBe(true);
  });
});
