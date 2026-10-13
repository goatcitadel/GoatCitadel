import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, ChatCompletionResponse } from "@goatcitadel/contracts";
import { ChatTurnAgentRunner, type ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { createMockStorage } from "./chat-turn-agent-runner-test-fixtures.js";
import {
  issueChatProviderFallbackAuthorization,
  readAuthorizedChatProviderFallback,
  requiresChatProviderFallbackAuthorization,
} from "./chat-provider-fallback-authority.js";

function input(): ChatTurnAgentRunnerInput {
  return {
    sessionId: "session",
    turnId: "turn",
    userMessageId: "user",
    content: "Answer directly.",
    mode: "chat",
    providerId: "primary",
    model: "model",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    policyRunId: "run",
    canonicalWriteFence: async <T>(work: () => T | Promise<T>): Promise<Awaited<T>> => await work(),
    historyMessages: [{ role: "user", content: "Answer directly." }],
  };
}
const response: ChatCompletionResponse = {
  model: "model",
  choices: [{ index: 0, message: { role: "assistant", content: "A direct answer." } }],
};
function handle() {
  return issueChatProviderFallbackAuthorization({
    sessionId: "session",
    turnId: "turn",
    runId: "run",
    primary: { providerId: "primary", model: "model" },
    fallback: { providerId: "backup", model: "backup-model" },
    allowLocalToCloud: false,
    revalidateBeforeFallback: async () => {},
    dispatchGuard: async () => {},
  });
}

describe("Chat runner fallback admission", () => {
  it.each([false, true])(
    "does not dispatch after admission preparation exhausts the turn deadline (stream %s)",
    async (stream) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const createChatCompletion = vi.fn(async () => response);
      const createChatCompletionStream = vi.fn(async function* () {
        yield { choices: [{ delta: { content: "answer" } }] };
      });
      const runner = new ChatTurnAgentRunner({
        storage: createMockStorage() as never,
        listToolCatalog: () => [],
        invokeTool: vi.fn(),
        createChatCompletion,
        ...(stream ? { createChatCompletionStream } : {}),
        authorizeProviderFallback: async () => {
          clock.mockReturnValue(now + 86_400_000);
          return undefined;
        },
      });
      try {
        const result = await runner.run(input());
        expect(result.turnTrace.status).not.toBe("completed");
        expect(createChatCompletion).not.toHaveBeenCalled();
        expect(createChatCompletionStream).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("attaches only the host-issued handle to the initial canonical request", async () => {
    const authorizeProviderFallback = vi.fn(async () => handle());
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) => {
      expect(requiresChatProviderFallbackAuthorization(request)).toBe(true);
      expect(readAuthorizedChatProviderFallback(request)).toEqual({ providerId: "backup", model: "backup-model" });
      return response;
    });
    const runner = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => [],
      invokeTool: vi.fn(),
      authorizeProviderFallback,
      createChatCompletion,
    });
    const result = await runner.run(input());
    expect(result.assistantContent).toBe("A direct answer.");
    expect(authorizeProviderFallback).toHaveBeenCalledTimes(1);
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("keeps Chat marked and unbound when canonical admission is missing", async () => {
    const authorizeProviderFallback = vi.fn(async () => handle());
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest) => {
      expect(requiresChatProviderFallbackAuthorization(request)).toBe(true);
      expect(readAuthorizedChatProviderFallback(request)).toBeUndefined();
      return response;
    });
    const runner = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => [],
      invokeTool: vi.fn(),
      authorizeProviderFallback,
      createChatCompletion,
    });
    await runner.run({ ...input(), canonicalWriteFence: undefined });
    expect(authorizeProviderFallback).not.toHaveBeenCalled();
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("rejects a serialized authority returned by an invalid host adapter before model execution", async () => {
    const createChatCompletion = vi.fn(async () => response);
    const runner = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => [],
      invokeTool: vi.fn(),
      authorizeProviderFallback: async () => JSON.parse(JSON.stringify(handle())),
      createChatCompletion,
    });
    const result = await runner.run(input());
    expect(result.turnTrace.status).toBe("failed");
    expect(createChatCompletion).not.toHaveBeenCalled();
  });
});
