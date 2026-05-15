import { describe, expect, it, vi } from "vitest";
import type { ChatMessageRecord, TranscriptEvent } from "@goatcitadel/contracts";
import {
  buildLlmMessagesFromBranchPath,
  buildLlmMessagesFromTranscript,
  type ChatMessageHistoryDependencies,
} from "./chat-message-history-service.js";

describe("chat-message-history-service loop30 coverage", () => {
  it("maps a current branch message when there are no prior branch turns", async () => {
    const deps = createDeps({
      sessionState: {
        tracesById: new Map(),
        messagesById: new Map(),
      },
    });

    const messages = await buildLlmMessagesFromBranchPath(
      deps,
      "session-1",
      [],
      createMessage("current-only", "user", "Start a new branch from here."),
      { guidanceSystemInstruction: "   " },
    );

    expect(messages).toEqual([{ role: "user", content: "Start a new branch from here." }]);
    expect(deps.storage.chatConversationSummaries.listByBranch).not.toHaveBeenCalled();
  });

  it("compacts transcript multimodal content with primitive nested values", async () => {
    const transcript = Array.from({ length: 32 }, (_, index) =>
      createTranscriptEvent(`primitive-${index}`, index % 2 === 0 ? "message.user" : "message.assistant", {
        content: `${index % 2 === 0 ? "User" : "Assistant"} ${index} ${"detail ".repeat(280)}`,
      }),
    );
    const deps = createDeps({
      transcript,
      buildUserMessageContent: async (message) => [
        false,
        0,
        null,
        { text: message.content, nested: ["visible", undefined] },
      ],
    });

    const messages = await buildLlmMessagesFromTranscript(deps, "session-1");

    expect(messages[0]).toEqual(
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("Compacted conversation context"),
      }),
    );
    expect(messages.at(-1)).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("Assistant 31"),
      }),
    );
    expect(messages.length).toBeLessThan(transcript.length);
  });
});

function createDeps(
  overrides: {
    transcript?: TranscriptEvent[];
    sessionState?: unknown;
    buildUserMessageContent?: ChatMessageHistoryDependencies["buildUserMessageContent"];
  } = {},
): ChatMessageHistoryDependencies {
  return {
    storage: {
      chatConversationSummaries: {
        listByBranch: vi.fn(() => []),
        upsert: vi.fn((input) => input),
      },
    },
    llmService: {
      getRuntimeConfig: () => ({
        activeProviderId: "openai",
        activeModel: "gpt-4.1-mini",
        providers: [
          {
            providerId: "openai",
            defaultModel: "gpt-4.1-mini",
            capabilities: { vision: false },
          },
        ],
      }),
    },
    readTranscriptOrEmpty: vi.fn(async () => overrides.transcript ?? []),
    loadChatTurnSessionState: vi.fn(
      async () =>
        overrides.sessionState ?? {
          tracesById: new Map(),
          messagesById: new Map(),
        },
    ),
    buildUserMessageContent:
      overrides.buildUserMessageContent ?? vi.fn(async (message: ChatMessageRecord) => message.content),
  } as unknown as ChatMessageHistoryDependencies;
}

function createTranscriptEvent(eventId: string, type: string, payload: Record<string, unknown>): TranscriptEvent {
  return {
    eventId,
    sessionId: "session-1",
    type,
    timestamp: "2026-05-14T00:00:00.000Z",
    payload,
  } as TranscriptEvent;
}

function createMessage(messageId: string, role: ChatMessageRecord["role"], content: string): ChatMessageRecord {
  return {
    messageId,
    sessionId: "session-1",
    role,
    actorType: role === "assistant" ? "agent" : "user",
    actorId: role === "assistant" ? "assistant" : "operator",
    content,
    timestamp: "2026-05-14T00:00:00.000Z",
  };
}
