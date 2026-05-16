import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, ChatCompletionResponse } from "@goatcitadel/contracts";
import { ChatSteerService } from "./chat-steer-service.js";
import { streamWithSteerDrain } from "./chat-turn-stream-service.js";

function makeRequest(): ChatCompletionRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "original prompt" }],
  };
}

function makeResponse(): ChatCompletionResponse {
  return {
    id: "resp-1",
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
  } as ChatCompletionResponse;
}

describe("streamWithSteerDrain", () => {
  it("appends drained steer messages as user-role chat messages before delegating", async () => {
    const steerService = new ChatSteerService();
    steerService.registerActiveTurn({ sessionId: "sess-1", turnId: "turn-1" });
    steerService.enqueue({ sessionId: "sess-1", instruction: "shorten the answer" });
    steerService.enqueue({ sessionId: "sess-1", instruction: "be precise" });

    const createChatCompletion = vi.fn(
      async (_request: ChatCompletionRequest): Promise<ChatCompletionResponse> => makeResponse(),
    );

    const result = await streamWithSteerDrain({
      host: { steerService, createChatCompletion },
      sessionId: "sess-1",
      turnId: "turn-1",
      request: makeRequest(),
    });

    expect(result.id).toBe("resp-1");
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    const composedRequest = createChatCompletion.mock.calls[0]?.[0] as ChatCompletionRequest;
    expect(composedRequest.messages).toEqual([
      { role: "user", content: "original prompt" },
      { role: "user", content: "[Steer] shorten the answer" },
      { role: "user", content: "[Steer] be precise" },
    ]);

    // Queue drained — second call sees no steer additions.
    await streamWithSteerDrain({
      host: { steerService, createChatCompletion },
      sessionId: "sess-1",
      turnId: "turn-1",
      request: makeRequest(),
    });
    const secondRequest = createChatCompletion.mock.calls[1]?.[0] as ChatCompletionRequest;
    expect(secondRequest.messages).toEqual([{ role: "user", content: "original prompt" }]);
  });

  it("delegates unchanged when no steer instructions are pending (no-op)", async () => {
    const steerService = new ChatSteerService();
    steerService.registerActiveTurn({ sessionId: "sess-1", turnId: "turn-1" });

    const createChatCompletion = vi.fn(
      async (_request: ChatCompletionRequest): Promise<ChatCompletionResponse> => makeResponse(),
    );

    const originalRequest = makeRequest();
    await streamWithSteerDrain({
      host: { steerService, createChatCompletion },
      sessionId: "sess-1",
      turnId: "turn-1",
      request: originalRequest,
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    const forwarded = createChatCompletion.mock.calls[0]?.[0] as ChatCompletionRequest;
    // No steers means the helper should not touch the messages array.
    expect(forwarded).toBe(originalRequest);
  });
});
