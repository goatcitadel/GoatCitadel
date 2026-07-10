import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatCitationRecord,
  ChatStreamChunk,
  ChatTurnTraceRecord,
  DurableRunRecord,
} from "@goatcitadel/contracts";
import type { ChatTurnDispatchHost } from "./chat-turn-dispatch-service.js";
import { ChatTurnExecutionRegistry, ChatTurnStreamRegistrationMismatchError } from "./chat-turn-execution-registry.js";

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
    expect(host.registerActiveChatTurnStream).toHaveBeenCalledWith("session-1", "turn-1", "run-1", {
      reservation: true,
    });
    expect(host.streamPersistedChatTurnEvents).toHaveBeenCalledWith("session-1", "turn-1", {
      liveTail: true,
      returnOnDurableInterrupt: true,
    });
    expect(streamPreparedAgentChatTurn).not.toHaveBeenCalled();
    expect(response.assistantMessage?.content).toBe("Durable answer.");
    expect(response.model).toBe("durable-model");
  });

  it("does not suppress a brand-new non-durable retry turn as a continuation", async () => {
    streamPreparedAgentChatTurn.mockImplementation(async function* () {
      yield {
        type: "delta",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "assistant-1",
        delta: "retry remains live",
      };
    });
    const host = createHost({ durableEnabled: false });

    dispatchService.launchPreparedAgentChatTurnStream(
      host,
      "session-1",
      { content: "retry" },
      createPrepared(),
      "chat_thread_turn_retried",
    );
    await Promise.allSettled([...host.backgroundTasks]);

    expect(host.registerActiveChatTurnStream).toHaveBeenCalledWith("session-1", "turn-1", undefined, {});
    expect(host.persistChatStreamChunk).toHaveBeenCalledWith(
      expect.objectContaining({ type: "delta", delta: "retry remains live" }),
      undefined,
      expect.objectContaining({ turnId: "turn-1" }),
    );
  });

  it("persists background stream chunks with durable run status and finalizes the active stream", async () => {
    vi.useFakeTimers();
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
    const streamRegistration = host.registerActiveChatTurnStream("session-1", "turn-1", "run-1");

    try {
      await dispatchService.executePreparedAgentChatTurnBackground(
        host,
        "session-1",
        { content: "hello" },
        createPrepared(),
        "chat_thread_turn_appended",
        "run-1",
        undefined,
        { streamRegistration, skipMessageStart: true },
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
        streamRegistration,
      );
      expect(host.finalizeDurableChatRun).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({ turnId: "turn-1" }),
        trace,
      );
      expect(streamRegistration.completed).toBe(true);
      expect(host.getActiveChatTurnStream("turn-1")).toBe(streamRegistration);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(host.getActiveChatTurnStream("turn-1")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rethrows stale stream registration writes without patching the trace or persisting an error", async () => {
    vi.useFakeTimers();
    const mismatch = new ChatTurnStreamRegistrationMismatchError("turn-1", "stream-registration-stale");
    streamPreparedAgentChatTurn.mockImplementation(async function* () {
      yield {
        type: "delta",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "assistant-1",
        delta: "stale producer output",
      };
    });
    const host = createHost();
    const staleRegistration = host.registerActiveChatTurnStream("session-1", "turn-1", "run-stale");
    host.registerActiveChatTurnStream("session-1", "turn-1", "run-resumed");
    host.persistChatStreamChunk.mockImplementation(() => {
      throw mismatch;
    });

    try {
      await expect(
        dispatchService.executePreparedAgentChatTurnBackground(
          host,
          "session-1",
          { content: "hello" },
          createPrepared(),
          "chat_thread_turn_appended",
          undefined,
          undefined,
          { streamRegistration: staleRegistration },
        ),
      ).rejects.toBe(mismatch);

      expect(host.persistChatStreamChunk).toHaveBeenCalledTimes(1);
      expect(host.persistChatStreamChunk).toHaveBeenCalledWith(
        expect.objectContaining({ type: "delta" }),
        undefined,
        staleRegistration,
      );
      expect(host.storage.chatTurnTraces.patch).not.toHaveBeenCalled();
      expect(host.recordDevDiagnostic).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("fences stale provider failures before they can patch a resumed attempt trace", async () => {
    vi.useFakeTimers();
    streamPreparedAgentChatTurn.mockImplementation(async function* () {
      yield* [];
      throw new Error("paused provider failed");
    });
    const host = createHost();
    const staleRegistration = host.registerActiveChatTurnStream("session-1", "turn-1", "run-stale");
    host.registerActiveChatTurnStream("session-1", "turn-1", "run-resumed");

    try {
      await expect(
        dispatchService.executePreparedAgentChatTurnBackground(
          host,
          "session-1",
          { content: "hello" },
          createPrepared(),
          "chat_thread_turn_appended",
          "run-stale",
          undefined,
          { streamRegistration: staleRegistration },
        ),
      ).rejects.toBeInstanceOf(ChatTurnStreamRegistrationMismatchError);

      expect(host.storage.chatTurnTraces.patch).not.toHaveBeenCalled();
      expect(host.persistChatStreamChunk).not.toHaveBeenCalled();
      expect(host.recordDevDiagnostic).not.toHaveBeenCalled();
      expect(host.finalizeDurableChatRun).not.toHaveBeenCalled();
      expect(host.completeActiveChatTurnStream).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not leak an unhandled rejection when explicit cancellation fences a non-durable background stream", async () => {
    let releaseProvider: (() => void) | undefined;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    streamPreparedAgentChatTurn.mockImplementation(async function* () {
      await providerGate;
      yield {
        type: "delta",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "assistant-1",
        delta: "late provider output",
      };
    });
    const host = createHost({ durableEnabled: false });
    let cancelled = false;
    host.completeActiveChatTurnStream.mockImplementation((turnId, registrationId) => {
      cancelled = true;
      return host.getActiveChatTurnStream(turnId)?.registrationId === registrationId
        ? host.getActiveChatTurnStream(turnId)!.complete()
        : false;
    });
    host.persistChatStreamChunk.mockImplementation((_chunk, _durableRunId, registration) => {
      if (cancelled) {
        throw new ChatTurnStreamRegistrationMismatchError(
          "turn-1",
          registration?.registrationId ?? "missing-registration",
        );
      }
    });
    const unhandledReasons: unknown[] = [];
    const trackUnhandledRejection = (reason: unknown): void => {
      unhandledReasons.push(reason);
    };
    process.on("unhandledRejection", trackUnhandledRejection);

    try {
      dispatchService.launchPreparedAgentChatTurnStream(
        host,
        "session-1",
        { content: "hello" },
        createPrepared(),
        "chat_thread_turn_appended",
      );
      const launchedTasks = [...host.backgroundTasks];
      expect(launchedTasks).toHaveLength(1);
      const streamRegistration = host.getActiveChatTurnStream("turn-1");
      expect(streamRegistration).toBeDefined();

      // Model cancelChatTurn completing this registration while the provider is
      // still in flight. Its eventual output must be fenced without becoming a
      // process-level rejection from the fire-and-forget launcher.
      host.completeActiveChatTurnStream("turn-1", streamRegistration!.registrationId);
      releaseProvider?.();
      await Promise.allSettled(launchedTasks);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(host.persistChatStreamChunk).toHaveBeenCalledTimes(1);
      expect(host.storage.chatTurnTraces.patch).not.toHaveBeenCalled();
      expect(host.finalizeDurableChatRun).not.toHaveBeenCalled();
      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off("unhandledRejection", trackUnhandledRejection);
    }
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
  const executionRegistry = new ChatTurnExecutionRegistry();
  const registerActiveChatTurnStream = vi.fn((sessionId: string, turnId: string, runId?: string) =>
    executionRegistry.registerActiveStream(sessionId, turnId, 0, runId),
  );
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
    registerActiveChatTurnStream,
    getActiveChatTurnStream: vi.fn((turnId: string) => executionRegistry.getActiveStream(turnId)),
    streamPersistedChatTurnEvents: vi.fn(async function* () {
      for (const chunk of persistedChunks) {
        yield chunk;
      }
    }),
    persistChatStreamChunk: vi.fn(),
    createHydratedChatTurnTrace: vi.fn((_turnId: string, trace: ChatTurnTraceRecord) => trace),
    recordDevDiagnostic: vi.fn(),
    finalizeDurableChatRun: vi.fn(),
    completeActiveChatTurnStream: vi.fn((turnId: string, registrationId: string) =>
      executionRegistry.completeActiveStream(turnId, registrationId),
    ),
    closeActiveChatTurnStream: vi.fn((turnId: string, registrationId: string) =>
      executionRegistry.closeActiveStream(turnId, registrationId),
    ),
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
