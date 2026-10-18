import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmConfigFile } from "@goatcitadel/contracts";
import { createModelChatWardDispatchGuard } from "./chat-route-local-ward.js";
import { LlmDispatchGuardRejectedError } from "./llm-dispatch-guard.js";
import { LlmService } from "./llm-service.js";
import { createNoopSecretStore } from "../test/llm-fixtures.js";

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

  it("dispatches the same turn when no ward applies", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => completionResponse());
    const service = createService();

    await service.chatCompletions(
      { providerId: "moonshot", model: "kimi-k2", messages: [{ role: "user", content: "hello" }] },
      durableTurnAttribution,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(service.admitsDispatchWard(durableTurnAttribution, "moonshot")).resolves.toBe(true);
  });
});
