import { describe, expect, it, vi } from "vitest";
import { streamChatModelCouncil } from "./chat-turn-stream-service.js";

describe("Chat model council stream adapter", () => {
  it("projects one canonical answer and canonical HX-306 usage owners into Chat chunks", async () => {
    const executeChatModelCouncil = vi.fn(async () => ({
      runId: "council-1",
      answer: "One canonical answer.",
      usage: { inputTokens: 30, outputTokens: 10, costUsd: 0.02 },
      modelUsageEventIds: ["usage-p1", "usage-p2", "usage-synthesis"],
      evidence: {
        schemaVersion: "assembly.model-council-evidence.v1" as const,
        resolutionHash: "a".repeat(64),
        participantCount: 2,
        completedParticipantCount: 2,
        dissentCount: 1,
        minorityCount: 1,
        dissentFingerprints: ["b".repeat(64)],
        minorityFingerprints: ["b".repeat(64)],
        canonicalAnswerHash: "c".repeat(64),
        attempts: [],
        updatedAt: "2026-07-13T00:00:00.000Z",
      },
    }));
    const chunks = [];
    for await (const chunk of streamChatModelCouncil(
      { executeChatModelCouncil } as never,
      {
        session: { sessionId: "session-1" },
        turnId: "turn-1",
        assistantMessageId: "assistant-1",
      } as never,
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      expect.objectContaining({
        type: "usage",
        modelUsageEventIds: ["usage-p1", "usage-p2", "usage-synthesis"],
      }),
      {
        type: "message_done",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "assistant-1",
        content: "One canonical answer.",
      },
    ]);
    expect(executeChatModelCouncil).toHaveBeenCalledOnce();
  });

  it("fails closed when the Assembly council collaborator is absent", async () => {
    const consume = async () => {
      for await (const _chunk of streamChatModelCouncil(
        {} as never,
        { session: { sessionId: "session-1" }, turnId: "turn-1", assistantMessageId: "assistant-1" } as never,
      )) {
        // consume
      }
    };
    await expect(consume()).rejects.toThrow(/collaborator is unavailable/i);
  });
});
