import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { ChatMessageRecord, TranscriptEvent } from "@goatcitadel/contracts";
import {
  buildLlmMessagesFromBranchPath,
  buildLlmMessagesFromTranscript,
  extractMessagePreview,
  parseMessageAttachments,
  parseMessageParts,
  type ChatMessageHistoryDependencies,
} from "./chat-message-history-service.js";

describe("chat-message-history-service", () => {
  it("normalizes transcript messages with system guidance and multimodal user content", async () => {
    const deps = createDeps({
      transcript: [
        createTranscriptEvent("event-user", "message.user", {
          message: {
            role: "user",
            content: "see attached",
            parts: [
              { type: "text", text: "Inspect this" },
              { type: "image_ref", attachmentId: "att-image", mimeType: "image/png", detail: "high" },
              { type: "image_ref", mimeType: "image/png" },
            ],
            attachments: [
              { attachmentId: "att-image", fileName: "diagram.png", mimeType: "image/png", sizeBytes: 1234 },
              { attachmentId: "bad" },
            ],
          },
        }),
        createTranscriptEvent("event-assistant", "message.assistant", {
          message: { role: "assistant", content: "The diagram is available." },
        }),
        createTranscriptEvent("ignored", "tool.started", { content: "not chat" }),
      ],
      buildUserMessageContent: async (message, supportsVision) => [
        { type: "text", text: message.content },
        { type: "vision_support", enabled: supportsVision },
        { type: "attachments", count: message.attachments?.length ?? 0 },
        { type: "parts", count: message.parts?.length ?? 0 },
      ],
    });

    const messages = await buildLlmMessagesFromTranscript(deps, "session-1", {
      providerId: "openai",
      model: "gpt-4.1",
      guidanceSystemInstruction: "  Stay concise.  ",
    });

    expect(messages).toEqual([
      { role: "system", content: "Stay concise." },
      {
        role: "user",
        content: [
          { type: "text", text: "see attached" },
          { type: "vision_support", enabled: true },
          { type: "attachments", count: 1 },
          { type: "parts", count: 2 },
        ],
      },
      { role: "assistant", content: "The diagram is available." },
    ]);
  });

  it("compacts long transcripts while preserving recent turns", async () => {
    const transcript = Array.from({ length: 48 }, (_, index) =>
      createTranscriptEvent(`event-${index}`, index % 2 === 0 ? "message.user" : "message.assistant", {
        content: `${index % 2 === 0 ? "User" : "Assistant"} ${index} ${"detail ".repeat(260)}`,
      }),
    );
    const deps = createDeps({
      transcript,
      buildUserMessageContent: async (message) => [
        { type: "text", text: message.content },
        { nested: { content: ["array", "content"] } },
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
        content: expect.stringContaining("Assistant 47"),
      }),
    );
    expect(messages.length).toBeLessThan(transcript.length);
  });

  it("builds branch-path messages from traced turns and reuses persisted compaction summaries", async () => {
    const sessionState = createBranchSessionState(8);
    const summaries = [
      {
        sessionId: "session-1",
        branchHeadTurnId: "turn-8",
        startTurnId: "turn-1",
        endTurnId: "turn-2",
        turnIds: ["turn-1", "turn-2"],
        sourceHash: "not-matching",
        tokenEstimate: 100,
        summary: "stale summary",
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
      },
    ];
    const upsert = vi.fn((input) => ({
      ...input,
      summary: input.summary,
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    }));
    const deps = createDeps({
      sessionState,
      summaries,
      upsertSummary: upsert,
    });

    const messages = await buildLlmMessagesFromBranchPath(
      deps,
      "session-1",
      Array.from({ length: 8 }, (_, index) => `turn-${index + 1}`),
      createMessage("current-user", "user", "Current branch question."),
      { guidanceSystemInstruction: "Use branch context." },
    );

    expect(messages[0]).toEqual({ role: "system", content: "Use branch context." });
    expect(messages[1]).toEqual(
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("Compacted conversation context"),
      }),
    );
    expect(messages.at(-1)).toEqual({ role: "user", content: "Current branch question." });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        branchHeadTurnId: "turn-8",
        startTurnId: "turn-1",
        endTurnId: "turn-2",
        turnIds: ["turn-1", "turn-2"],
      }),
    );
  });

  it("maps short branch paths without loading state when state is provided", async () => {
    const sessionState = createBranchSessionState(2, "short");
    const deps = createDeps({ sessionState });

    const messages = await buildLlmMessagesFromBranchPath(
      deps,
      "session-1",
      ["turn-1", "missing-turn", "turn-2"],
      undefined,
      undefined,
      sessionState as never,
    );

    expect(deps.loadChatTurnSessionState).not.toHaveBeenCalled();
    expect(messages).toEqual([
      { role: "user", content: expect.stringContaining("short user 1") },
      { role: "assistant", content: expect.stringContaining("short assistant 1") },
      { role: "user", content: expect.stringContaining("short user 2") },
      { role: "assistant", content: expect.stringContaining("short assistant 2") },
    ]);
  });

  it("keeps short low-token transcripts verbatim and maps system records from branch state", async () => {
    const transcript = Array.from({ length: 14 }, (_, index) =>
      createTranscriptEvent(`brief-${index}`, index % 2 === 0 ? "message.user" : "message.assistant", {
        content: index % 2 === 0 ? `brief user ${index}` : `brief assistant ${index}`,
      }),
    );
    const deps = createDeps({ transcript });

    await expect(buildLlmMessagesFromTranscript(deps, "session-1")).resolves.toHaveLength(14);

    const tracesById = new Map([["turn-system", { userMessageId: "system-1" }]]);
    const messagesById = new Map<string, ChatMessageRecord>([
      ["system-1", createMessage("system-1", "system", "Preserve the operator guidance.")],
    ]);
    const branchDeps = createDeps({
      sessionState: {
        tracesById,
        messagesById,
      },
    });

    await expect(
      buildLlmMessagesFromBranchPath(branchDeps, "session-1", ["turn-system"], undefined, undefined, {
        tracesById,
        messagesById,
      } as never),
    ).resolves.toEqual([{ role: "system", content: "Preserve the operator guidance." }]);
  });

  it("reuses matching persisted branch compaction summaries before writing new ones", async () => {
    const sessionState = createBranchSessionState(8, "persisted");
    const source = ["turn-1", "turn-2"]
      .flatMap((turnId) => {
        const trace = sessionState.tracesById.get(turnId)!;
        return [
          sessionState.messagesById.get(trace.userMessageId)!,
          sessionState.messagesById.get(trace.assistantMessageId!)!,
        ];
      })
      .map((message) => `${message.role.toUpperCase()}: ${message.content.trim()}`)
      .join("\n\n");
    const sourceHash = createHash("sha256").update(source).digest("hex");
    const upsert = vi.fn((input) => input);
    const deps = createDeps({
      sessionState,
      summaries: [
        {
          sessionId: "session-1",
          branchHeadTurnId: "turn-8",
          startTurnId: "turn-1",
          endTurnId: "turn-2",
          turnIds: ["turn-1", "turn-2"],
          sourceHash,
          tokenEstimate: 100,
          summary: "Persisted summary for the first two turns.",
          createdAt: "2026-05-14T00:00:00.000Z",
          updatedAt: "2026-05-14T00:00:00.000Z",
        },
      ],
      upsertSummary: upsert,
    });

    const messages = await buildLlmMessagesFromBranchPath(
      deps,
      "session-1",
      Array.from({ length: 8 }, (_, index) => `turn-${index + 1}`),
      undefined,
    );

    expect(messages[0]).toEqual({ role: "system", content: "Persisted summary for the first two turns." });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("keeps compacted transcripts verbatim when older context has no summary content", async () => {
    const transcript = Array.from({ length: 30 }, (_, index) =>
      createTranscriptEvent(
        `blank-${index}`,
        index % 2 === 0 ? "message.user" : "message.assistant",
        index < 18
          ? { content: "" }
          : {
              message: {
                content: `${index % 2 === 0 ? "User" : "Assistant"} ${index} ${"detail ".repeat(260)}`,
              },
            },
      ),
    );
    const deps = createDeps({ transcript });

    const messages = await buildLlmMessagesFromTranscript(deps, "session-1");

    expect(messages[0]).not.toEqual(expect.objectContaining({ role: "system" }));
    expect(messages.at(-1)).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("Assistant 29"),
      }),
    );
    expect(messages.length).toBeLessThan(transcript.length);
  });

  it("skips blank branch compaction windows without persisting empty summaries", async () => {
    const sessionState = createBranchSessionState(8, "blank-window");
    for (const messageId of ["user-1", "assistant-1", "user-2", "assistant-2"]) {
      const message = sessionState.messagesById.get(messageId)!;
      sessionState.messagesById.set(messageId, { ...message, content: "   " });
    }
    const upsert = vi.fn((input) => input);
    const deps = createDeps({ sessionState, upsertSummary: upsert });

    const messages = await buildLlmMessagesFromBranchPath(
      deps,
      "session-1",
      Array.from({ length: 8 }, (_, index) => `turn-${index + 1}`),
      undefined,
    );

    expect(messages[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("blank-window user 3"),
      }),
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it("infers vision support from model names when provider metadata is absent", async () => {
    const seen: boolean[] = [];
    const transcript = [
      createTranscriptEvent("vision-user", "message.user", {
        message: { content: "describe this image" },
      }),
    ];
    const deps = createDeps({
      transcript,
      runtimeConfig: {
        activeProviderId: "missing-provider",
        activeModel: "text-only-model",
        providers: [],
      },
      buildUserMessageContent: async (_message, supportsVision) => {
        seen.push(supportsVision);
        return supportsVision ? "vision enabled" : "vision disabled";
      },
    });

    for (const model of ["vision-pro", "gpt-4o-mini", "gemini-pro", "claude-3-opus", "kimi-k2", "glm-4"]) {
      await buildLlmMessagesFromTranscript(deps, "session-1", { providerId: "missing-provider", model });
    }
    await buildLlmMessagesFromTranscript(deps, "session-1", {
      providerId: "missing-provider",
      model: "text-only-model",
    });

    expect(seen).toEqual([true, true, true, true, true, true, false]);
  });

  it("extracts previews, parts, and attachments defensively", () => {
    expect(extractMessagePreview({ content: "x".repeat(300) })).toHaveLength(240);
    expect(extractMessagePreview({ content: [{ text: "hello" }] })).toBe('[{"text":"hello"}]');
    expect(extractMessagePreview({ message: "assistant text" })).toBe("assistant text");
    expect(extractMessagePreview({ payload: { nested: true } })).toBe('{"payload":{"nested":true}}');

    expect(parseMessageParts("bad")).toBeUndefined();
    expect(parseMessageParts([null, {}, { type: "audio_ref" }])).toBeUndefined();
    expect(
      parseMessageParts([
        { type: "text", text: "hello" },
        { type: "image_ref", attachmentId: "image-1", detail: "auto" },
        { type: "audio_ref", attachmentId: "audio-1", mimeType: "audio/wav" },
        { type: "video_ref", attachmentId: "video-1" },
        { type: "file_ref", attachmentId: "file-1" },
        { type: "image_ref" },
        { type: "unknown", attachmentId: "ignored" },
        null,
      ]),
    ).toEqual([
      { type: "text", text: "hello" },
      { type: "image_ref", attachmentId: "image-1", mimeType: undefined, detail: "auto" },
      { type: "audio_ref", attachmentId: "audio-1", mimeType: "audio/wav" },
      { type: "video_ref", attachmentId: "video-1", mimeType: undefined },
      { type: "file_ref", attachmentId: "file-1", mimeType: undefined },
    ]);
    expect(parseMessageParts([{ type: "text" }])).toBeUndefined();

    expect(parseMessageAttachments("bad")).toBeUndefined();
    expect(
      parseMessageAttachments([
        { attachmentId: "att-1", fileName: "one.txt", mimeType: "text/plain", sizeBytes: 10 },
        { attachmentId: "att-2", fileName: "two.txt", mimeType: "text/plain" },
      ]),
    ).toEqual([{ attachmentId: "att-1", fileName: "one.txt", mimeType: "text/plain", sizeBytes: 10 }]);
    expect(parseMessageAttachments([{ attachmentId: "bad" }])).toBeUndefined();
  });
});

function createDeps(
  overrides: {
    transcript?: TranscriptEvent[];
    sessionState?: unknown;
    summaries?: unknown[];
    upsertSummary?: ReturnType<typeof vi.fn>;
    runtimeConfig?: ReturnType<ChatMessageHistoryDependencies["llmService"]["getRuntimeConfig"]>;
    buildUserMessageContent?: ChatMessageHistoryDependencies["buildUserMessageContent"];
  } = {},
): ChatMessageHistoryDependencies {
  const sessionState = overrides.sessionState ?? createBranchSessionState(0);
  return {
    storage: {
      chatConversationSummaries: {
        listByBranch: vi.fn(() => overrides.summaries ?? []),
        upsert: overrides.upsertSummary ?? vi.fn((input) => input),
      },
    },
    llmService: {
      getRuntimeConfig: () =>
        overrides.runtimeConfig ?? {
          activeProviderId: "openai",
          activeModel: "gpt-4.1-mini",
          providers: [
            {
              providerId: "openai",
              defaultModel: "gpt-4.1-mini",
              capabilities: { vision: false },
            },
          ],
        },
    },
    readTranscriptOrEmpty: vi.fn(async () => overrides.transcript ?? []),
    loadChatTurnSessionState: vi.fn(async () => sessionState),
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

function createBranchSessionState(turnCount: number, prefix = "branch") {
  const tracesById = new Map<string, { userMessageId: string; assistantMessageId?: string }>();
  const messagesById = new Map<string, ChatMessageRecord>();
  for (let index = 1; index <= turnCount; index += 1) {
    const turnId = `turn-${index}`;
    const userMessageId = `user-${index}`;
    const assistantMessageId = `assistant-${index}`;
    tracesById.set(turnId, { userMessageId, assistantMessageId });
    messagesById.set(
      userMessageId,
      createMessage(userMessageId, "user", `${prefix} user ${index} ${"detail ".repeat(180)}`),
    );
    messagesById.set(
      assistantMessageId,
      createMessage(assistantMessageId, "assistant", `${prefix} assistant ${index} ${"detail ".repeat(180)}`),
    );
  }
  return {
    tracesById,
    messagesById,
  };
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
