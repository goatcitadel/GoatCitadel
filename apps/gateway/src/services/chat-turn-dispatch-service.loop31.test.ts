import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatCitationRecord,
  ChatStreamChunk,
  ChatTurnTraceRecord,
  DurableRunRecord,
} from "@goatcitadel/contracts";
import type { ChatTurnDispatchHost } from "./chat-turn-dispatch-service.js";

const streamPreparedAgentChatTurn = vi.fn();

vi.mock("./chat-turn-stream-service.js", () => ({
  streamPreparedAgentChatTurn,
}));

const dispatchService = await import("./chat-turn-dispatch-service.js");

describe("chat turn dispatch loop 31 execution coverage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("assembles non-durable prepared turn responses from streamed message, trace, and citation chunks", async () => {
    const citation = {
      citationId: "citation-1",
      title: "Runtime note",
      url: "https://example.test/runtime",
    } as ChatCitationRecord;
    const trace = {
      turnId: "turn-1",
      sessionId: "session-1",
      status: "completed",
      model: "gpt-5.4",
      routing: { effectiveProviderId: "openai" },
      citations: [citation],
    } as unknown as ChatTurnTraceRecord;
    streamPreparedAgentChatTurn.mockImplementation(async function* () {
      yield {
        type: "citation",
        sessionId: "session-1",
        turnId: "turn-1",
        citation,
      };
      yield {
        type: "message_done",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "assistant-1",
        content: "Non-durable answer.",
      };
      yield {
        type: "trace_update",
        sessionId: "session-1",
        turnId: "turn-1",
        trace,
      };
    });
    const host = createHost({ durableEnabled: false });

    const response = await dispatchService.consumePreparedAgentChatTurn(
      host,
      "session-1",
      { content: "hello", model: "input-model" },
      createPrepared(),
      "chat_thread_turn_appended",
    );

    expect(streamPreparedAgentChatTurn).toHaveBeenCalledWith(
      host,
      "session-1",
      { content: "hello", model: "input-model" },
      expect.objectContaining({ turnId: "turn-1" }),
      "chat_thread_turn_appended",
      undefined,
    );
    expect(response).toMatchObject({
      sessionId: "session-1",
      transport: "llm",
      model: "gpt-5.4",
      turnId: "turn-1",
      assistantMessage: {
        messageId: "assistant-1",
        content: "Non-durable answer.",
      },
      routing: { effectiveProviderId: "openai" },
    });
    expect(response.citations).toEqual([citation]);
    expect(response.trace?.citations).toEqual([citation]);
  });

  it("launches durable execution and consumes the retained event stream for shipped chat turns", async () => {
    const durableRun = { runId: "run-1" } as DurableRunRecord;
    const host = createHost({
      beginDurableChatRun: vi.fn(() => durableRun),
      persistedChunks: [
        {
          type: "message_done",
          sessionId: "session-1",
          turnId: "turn-1",
          messageId: "assistant-1",
          content: "Durable answer.",
        },
        {
          type: "trace_update",
          sessionId: "session-1",
          turnId: "turn-1",
          trace: {
            turnId: "turn-1",
            sessionId: "session-1",
            status: "completed",
            model: "durable-model",
            routing: { effectiveProviderId: "durable-provider" },
          } as ChatTurnTraceRecord,
        },
      ],
    });

    const response = await dispatchService.consumePreparedAgentChatTurn(
      host,
      "session-1",
      { content: "hello", mode: "chat" },
      createPrepared(),
      "chat_thread_turn_appended",
    );

    expect(host.beginDurableChatRun).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: "turn-1" }),
      { content: "hello", mode: "chat" },
      "chat_thread_turn_appended",
    );
    expect(host.registerActiveChatTurnStream).toHaveBeenCalledWith("session-1", "turn-1", "run-1");
    expect(host.streamPersistedChatTurnEvents).toHaveBeenCalledWith("session-1", "turn-1", { liveTail: true });
    expect(streamPreparedAgentChatTurn).not.toHaveBeenCalled();
    expect(response.assistantMessage?.content).toBe("Durable answer.");
    expect(response.model).toBe("durable-model");
  });

  it("persists background stream chunks with durable run status and finalizes the active stream", async () => {
    const trace = {
      turnId: "turn-1",
      sessionId: "session-1",
      status: "running",
      routing: {},
    } as ChatTurnTraceRecord;
    streamPreparedAgentChatTurn.mockImplementation(async function* () {
      yield {
        type: "trace_update",
        sessionId: "session-1",
        turnId: "turn-1",
        trace,
      };
      yield {
        type: "message_done",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "assistant-1",
        content: "done",
      };
    });
    const host = createHost({ traceState: trace });

    await dispatchService.executePreparedAgentChatTurnBackground(
      host,
      "session-1",
      { content: "hello" },
      createPrepared(),
      "chat_thread_turn_appended",
      "run-1",
      undefined,
      { skipMessageStart: true },
    );

    expect(host.persistChatStreamChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "trace_update",
        trace: expect.objectContaining({
          durable: expect.objectContaining({
            runId: "run-1",
            status: "running",
            checkpointKind: "run_started",
          }),
        }),
      }),
      "run-1",
    );
    expect(host.finalizeDurableChatRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ turnId: "turn-1" }),
      trace,
    );
    expect(host.completeActiveChatTurnStream).toHaveBeenCalledWith("turn-1");
  });
});

function createHost(
  options: {
    durableEnabled?: boolean;
    beginDurableChatRun?: (...args: unknown[]) => DurableRunRecord | undefined;
    persistedChunks?: ChatStreamChunk[];
    traceState?: ChatTurnTraceRecord;
  } = {},
): ChatTurnDispatchHost & {
  beginDurableChatRun: ReturnType<typeof vi.fn>;
  registerActiveChatTurnStream: ReturnType<typeof vi.fn>;
  streamPersistedChatTurnEvents: ReturnType<typeof vi.fn>;
  persistChatStreamChunk: ReturnType<typeof vi.fn>;
  finalizeDurableChatRun: ReturnType<typeof vi.fn>;
  completeActiveChatTurnStream: ReturnType<typeof vi.fn>;
} {
  const durableEnabled = options.durableEnabled ?? true;
  const persistedChunks = options.persistedChunks ?? [];
  const traceState =
    options.traceState ??
    ({
      turnId: "turn-1",
      sessionId: "session-1",
      status: "completed",
      routing: {},
    } as ChatTurnTraceRecord);
  return {
    config: {
      assistant: {
        durable: {
          enabled: durableEnabled,
          executionEnabled: durableEnabled,
          chatAutoPromoteEnabled: true,
        },
      },
    },
    storage: {
      durableRuns: {
        getRun: vi.fn(() => ({ status: "running" })),
      },
      chatTurnTraces: {
        get: vi.fn(() => traceState),
        patch: vi.fn((_turnId: string, patch: Partial<ChatTurnTraceRecord>) => ({ ...traceState, ...patch })),
      },
    } as never,
    backgroundTasks: new Set(),
    isFeatureEnabled: vi.fn((flag: string) => flag === "durableKernelV1Enabled"),
    beginDurableChatRun: options.beginDurableChatRun ?? vi.fn(() => undefined),
    registerActiveChatTurnStream: vi.fn(),
    streamPersistedChatTurnEvents: vi.fn(async function* () {
      for (const chunk of persistedChunks) {
        yield chunk;
      }
    }),
    persistChatStreamChunk: vi.fn(),
    createHydratedChatTurnTrace: vi.fn((_turnId: string, trace: ChatTurnTraceRecord) => trace),
    recordDevDiagnostic: vi.fn(),
    finalizeDurableChatRun: vi.fn(),
    completeActiveChatTurnStream: vi.fn(),
    closeActiveChatTurnStream: vi.fn(),
  } as unknown as ChatTurnDispatchHost & {
    beginDurableChatRun: ReturnType<typeof vi.fn>;
    registerActiveChatTurnStream: ReturnType<typeof vi.fn>;
    streamPersistedChatTurnEvents: ReturnType<typeof vi.fn>;
    persistChatStreamChunk: ReturnType<typeof vi.fn>;
    finalizeDurableChatRun: ReturnType<typeof vi.fn>;
    completeActiveChatTurnStream: ReturnType<typeof vi.fn>;
  };
}

function createPrepared() {
  return {
    turnId: "turn-1",
    userEventId: "user-1",
    userMessage: {
      messageId: "user-1",
      sessionId: "session-1",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "hello",
      timestamp: "2026-04-11T00:00:00.000Z",
    },
    content: "hello",
    normalized: {
      mode: "chat",
    },
    prefs: {
      mode: "chat",
      model: "pref-model",
      providerId: "pref-provider",
      webMode: "off",
    },
    autonomy: {
      reflectionMode: "off",
    },
  } as never;
}
