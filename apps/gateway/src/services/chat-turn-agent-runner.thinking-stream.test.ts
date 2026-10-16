import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChatCompletionResponse } from "@goatcitadel/contracts";
import { ChatTurnAgentRunner, type ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { createMockStorage, createToolCatalog } from "./chat-turn-agent-runner-test-fixtures.js";

function reasoningCompletion(answer: string): ChatCompletionResponse {
  return {
    model: "gpt-5.4",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: answer,
          provider_native_content: [
            {
              type: "thinking",
              thinking: "The user wants a short answer, so I will keep it brief.",
              signature: "sig-1",
            },
          ],
        },
      },
    ],
  };
}

function baseTurn(sessionId: string, content: string): ChatTurnAgentRunnerInput {
  return {
    sessionId,
    turnId: randomUUID(),
    userMessageId: `msg-${sessionId}`,
    content,
    mode: "chat",
    providerId: "openai",
    model: "gpt-5.4",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content }],
  };
}

describe("ChatTurnAgentRunner thinking-display skeleton (chatThinkingStreamV1Enabled)", () => {
  it("emits NO thinking_delta chunk when the flag is left at its default (off)", async () => {
    const createChatCompletion = async () => reasoningCompletion("Sure, here you go.");
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: async () => {
        throw new Error("not expected");
      },
      // chatThinkingStreamV1Enabled intentionally omitted: default-off.
    });

    const input = baseTurn("sess-thinking-default-off", "What is 2 plus 2?");
    const chunks: Array<{ type: string }> = [];
    for await (const chunk of orchestrator.runStream(input)) {
      chunks.push(chunk as { type: string });
    }

    expect(chunks.some((chunk) => chunk.type === "thinking_delta")).toBe(false);
    const doneChunk = chunks.find((chunk) => chunk.type === "message_done") as { content?: string } | undefined;
    expect(doneChunk?.content).toBe("Sure, here you go.");
  });

  it("emits NO thinking_delta chunk when the flag is explicitly false", async () => {
    const createChatCompletion = async () => reasoningCompletion("Sure, here you go.");
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: async () => {
        throw new Error("not expected");
      },
      chatThinkingStreamV1Enabled: () => false,
    });

    const input = baseTurn("sess-thinking-explicit-off", "What is 2 plus 2?");
    const chunks: Array<{ type: string }> = [];
    for await (const chunk of orchestrator.runStream(input)) {
      chunks.push(chunk as { type: string });
    }

    expect(chunks.some((chunk) => chunk.type === "thinking_delta")).toBe(false);
  });

  it("persists a thinking_delta chunk carrying turnId + delta when the flag is enabled", async () => {
    const createChatCompletion = async () => reasoningCompletion("Sure, here you go.");
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: async () => {
        throw new Error("not expected");
      },
      chatThinkingStreamV1Enabled: () => true,
    });

    const input = baseTurn("sess-thinking-on", "What is 2 plus 2?");
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of orchestrator.runStream(input)) {
      chunks.push(chunk as Record<string, unknown>);
    }

    const thinkingChunk = chunks.find((chunk) => chunk.type === "thinking_delta");
    expect(thinkingChunk).toBeDefined();
    expect(thinkingChunk?.turnId).toBe(input.turnId);
    expect(thinkingChunk?.delta).toBe("The user wants a short answer, so I will keep it brief.");

    // SAFETY INVARIANT: the reasoning text must never land in the persisted
    // assistant message content.
    const doneChunk = chunks.find((chunk) => chunk.type === "message_done");
    expect(doneChunk?.content).toBe("Sure, here you go.");
    expect(String(doneChunk?.content)).not.toContain("short answer");

    // The thinking_delta must be emitted before message_done (terminal-block
    // variant: one thinking_delta ahead of the done chunk for this completion).
    const thinkingIndex = chunks.findIndex((chunk) => chunk.type === "thinking_delta");
    const doneIndex = chunks.findIndex((chunk) => chunk.type === "message_done");
    expect(thinkingIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(thinkingIndex);
  });

  it("does not emit a thinking_delta when the flag is enabled but the completion carries no reasoning content", async () => {
    const createChatCompletion = async (): Promise<ChatCompletionResponse> => ({
      model: "gpt-5.4",
      choices: [{ index: 0, message: { role: "assistant", content: "Just the answer." } }],
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: async () => {
        throw new Error("not expected");
      },
      chatThinkingStreamV1Enabled: () => true,
    });

    const input = baseTurn("sess-thinking-on-no-reasoning", "What is 2 plus 2?");
    const chunks: Array<{ type: string }> = [];
    for await (const chunk of orchestrator.runStream(input)) {
      chunks.push(chunk as { type: string });
    }

    expect(chunks.some((chunk) => chunk.type === "thinking_delta")).toBe(false);
  });

  it("reads the flag live on every turn, not a cached snapshot from construction time", async () => {
    // Mirrors the `isFeatureEnabled` closures other gateway services already pass
    // in: an operator toggling this flag at runtime (e.g. via the dashboard) must
    // take effect on the NEXT turn without a gateway restart.
    let enabled = false;
    const createChatCompletion = async () => reasoningCompletion("Sure, here you go.");
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: async () => {
        throw new Error("not expected");
      },
      chatThinkingStreamV1Enabled: () => enabled,
    });

    const firstInput = baseTurn("sess-thinking-live-off", "What is 2 plus 2?");
    const firstChunks: Array<{ type: string }> = [];
    for await (const chunk of orchestrator.runStream(firstInput)) {
      firstChunks.push(chunk as { type: string });
    }
    expect(firstChunks.some((chunk) => chunk.type === "thinking_delta")).toBe(false);

    enabled = true;
    const secondInput = baseTurn("sess-thinking-live-on", "What is 2 plus 2?");
    const secondChunks: Array<{ type: string }> = [];
    for await (const chunk of orchestrator.runStream(secondInput)) {
      secondChunks.push(chunk as { type: string });
    }
    expect(secondChunks.some((chunk) => chunk.type === "thinking_delta")).toBe(true);
  });

  it("never emits a redacted_thinking block's encrypted data as visible reasoning text", async () => {
    // IMPORTANT-2 regression coverage: a redacted_thinking block's `data` field
    // is an opaque encrypted blob, not readable text. extractReasoningText must
    // skip it entirely rather than falling through the `?? item.data` chain.
    const createChatCompletion = async (): Promise<ChatCompletionResponse> => ({
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Sure, here you go.",
            provider_native_content: [
              {
                type: "thinking",
                thinking: "visible reasoning",
                signature: "sig-1",
              },
              {
                type: "redacted_thinking",
                data: "ENCRYPTED",
              },
            ],
          },
        },
      ],
    });
    const orchestrator = new ChatTurnAgentRunner({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog([]),
      createChatCompletion,
      invokeTool: async () => {
        throw new Error("not expected");
      },
      chatThinkingStreamV1Enabled: () => true,
    });

    const input = baseTurn("sess-thinking-redacted", "What is 2 plus 2?");
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of orchestrator.runStream(input)) {
      chunks.push(chunk as Record<string, unknown>);
    }

    const thinkingChunk = chunks.find((chunk) => chunk.type === "thinking_delta");
    expect(thinkingChunk).toBeDefined();
    expect(String(thinkingChunk?.delta)).toContain("visible reasoning");
    expect(String(thinkingChunk?.delta)).not.toContain("ENCRYPTED");
  });
});

function streamingDeps(chunks: Array<Record<string, unknown>>, seenRequests: Array<Record<string, unknown>>) {
  return {
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog([]),
    createChatCompletion: async () => {
      throw new Error("non-stream path not expected");
    },
    createChatCompletionStream: async (request: Record<string, unknown>) => {
      seenRequests.push(request);
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
    invokeTool: async () => {
      throw new Error("not expected");
    },
  };
}

const reasoningStream = [
  { id: "s1", model: "m", choices: [{ index: 0, delta: { reasoning_content: "First, " } }] },
  { id: "s1", model: "m", choices: [{ index: 0, delta: { reasoning_content: "then second." } }] },
  { id: "s1", model: "m", choices: [{ index: 0, delta: { content: "Done." } }] },
  { id: "s1", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];

describe("ChatTurnAgentRunner incremental thinking stream", () => {
  it("yields one thinking_delta per provider reasoning chunk, in order, before message_done", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const orchestrator = new ChatTurnAgentRunner({
      ...streamingDeps(reasoningStream, seen),
      chatThinkingStreamV1Enabled: () => true,
    } as never);
    const input = baseTurn("sess-incremental", "Explain.");
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of orchestrator.runStream(input)) chunks.push(chunk as Record<string, unknown>);
    const thinking = chunks.filter((chunk) => chunk.type === "thinking_delta");
    expect(thinking.map((chunk) => chunk.delta)).toEqual(["First, ", "then second."]);
    const doneIndex = chunks.findIndex((chunk) => chunk.type === "message_done");
    expect(chunks.findIndex((chunk) => chunk.type === "thinking_delta")).toBeLessThan(doneIndex);
    expect(chunks.filter((chunk) => chunk.type === "thinking_delta")).toHaveLength(2); // no end-of-pass duplicate
    expect(String(chunks[doneIndex]?.content)).toBe("Done.");
    expect(seen[0]?.streamReasoningDeltas).toBe(true);
  });

  it("neither requests nor yields reasoning when the flag is off", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const orchestrator = new ChatTurnAgentRunner(streamingDeps(reasoningStream, seen) as never);
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of orchestrator.runStream(baseTurn("sess-incremental-off", "Explain."))) {
      chunks.push(chunk as Record<string, unknown>);
    }
    expect(chunks.some((chunk) => chunk.type === "thinking_delta")).toBe(false);
    expect("streamReasoningDeltas" in (seen[0] ?? {})).toBe(false);
  });

  it("never streams a redacted_thinking block's data as a thinking_delta", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const redactedStream = [
      {
        id: "s2",
        model: "m",
        choices: [{ index: 0, delta: { provider_native_content: [{ type: "redacted_thinking", data: "cipher" }] } }],
      },
      { id: "s2", model: "m", choices: [{ index: 0, delta: { content: "Done." } }] },
      { id: "s2", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    const orchestrator = new ChatTurnAgentRunner({
      ...streamingDeps(redactedStream, seen),
      chatThinkingStreamV1Enabled: () => true,
    } as never);
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of orchestrator.runStream(baseTurn("sess-incremental-redacted", "Explain."))) {
      chunks.push(chunk as Record<string, unknown>);
    }
    const thinking = chunks.filter((chunk) => chunk.type === "thinking_delta");
    expect(thinking.some((chunk) => String(chunk.delta).includes("cipher"))).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.streamReasoningDeltas).toBe(true);
    expect(chunks.find((chunk) => chunk.type === "message_done")?.content).toBe("Done.");
  });
});
