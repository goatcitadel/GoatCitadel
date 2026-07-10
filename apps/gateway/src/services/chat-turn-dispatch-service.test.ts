import { describe, expect, it, vi } from "vitest";
import type { ChatTurnTraceRecord, DurableRunRecord } from "@goatcitadel/contracts";
import type { ChatTurnDispatchHost } from "./chat-turn-dispatch-service.js";
import { ChatTurnExecutionRegistry } from "./chat-turn-execution-registry.js";

vi.mock("./chat-turn-helpers.js", () => ({
  dedupeChatCitations: (items: unknown[]) => items,
  splitIntoChunks: (value: string) => [value],
}));

const { launchPreparedAgentChatTurnStream, shouldUseDurableExecution } =
  await import("./chat-turn-dispatch-service.js");
const { sendPreparedIntegrationChatTurn, streamPreparedIntegrationChatTurn } =
  await import("./chat-turn-dispatch-service.js");

describe("chat turn dispatch durable ownership", () => {
  it("treats shipped chat, cowork, and code surfaces as durable-owned when the 1.0 defaults are on", () => {
    const host = createHost();
    expect(shouldUseDurableExecution(host, createPrepared("chat"), { content: "hello" })).toBe(true);
    expect(shouldUseDurableExecution(host, createPrepared("cowork"), { content: "hello" })).toBe(true);
    expect(shouldUseDurableExecution(host, createPrepared("code"), { content: "hello" })).toBe(true);
  });

  it("keeps quick-web turns on the inline fast path instead of durable execution", () => {
    const host = createHost();
    expect(
      shouldUseDurableExecution(host, createPrepared("chat", { normalizationProfile: "quick_web" }), {
        content: "please look up the best way to eat sushi",
      }),
    ).toBe(false);
  });

  it("registers the active stream against the durable run when one is created", () => {
    const durableRun = { runId: "run-1" } as DurableRunRecord;
    const host = createHost({
      beginDurableChatRun: vi.fn(() => durableRun),
    });

    launchPreparedAgentChatTurnStream(
      host,
      "session-1",
      { content: "hello", mode: "chat" },
      createPrepared("chat"),
      "chat_thread_turn_appended",
    );

    expect(host.registerActiveChatTurnStream).toHaveBeenCalledWith("session-1", "turn-1", "run-1", {
      reservation: true,
    });
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.dispatch.stream_registered",
        sessionId: "session-1",
        turnId: "turn-1",
        context: expect.objectContaining({
          durableRequested: true,
          durableRunId: "run-1",
        }),
      }),
    );
    expect(host.backgroundTasks.size).toBe(0);
    expect(host.persistChatStreamChunk).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("fails closed instead of silently falling back to background execution when a shipped durable send cannot allocate a run", () => {
    const traceState = {
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      status: "running",
      routing: {},
      startedAt: "2026-04-11T00:00:00.000Z",
    } as unknown as ChatTurnTraceRecord;
    const host = createHost({
      beginDurableChatRun: vi.fn(() => undefined),
      traceState,
    });

    launchPreparedAgentChatTurnStream(
      host,
      "session-1",
      { content: "hello", mode: "chat" },
      createPrepared("chat"),
      "chat_thread_turn_appended",
    );

    expect(host.backgroundTasks.size).toBe(0);
    expect(host.registerActiveChatTurnStream.mock.invocationCallOrder[0]).toBeLessThan(
      (host.storage.chatTurnTraces.patch as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ??
        Number.MAX_SAFE_INTEGER,
    );
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.dispatch.durable_unavailable",
        level: "warn",
        context: expect.objectContaining({
          providerCallStarted: false,
        }),
      }),
    );
    expect(host.storage.chatTurnTraces.patch).toHaveBeenCalledWith(
      "turn-1",
      expect.objectContaining({
        status: "failed",
      }),
    );
    expect(host.persistChatStreamChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        error: expect.stringContaining("durable_unavailable"),
      }),
      undefined,
      expect.objectContaining({ sessionId: "session-1", turnId: "turn-1" }),
    );
    expect(host.getActiveChatTurnStream("turn-1")?.completed).toBe(true);
  });

  it("records completed integration writeback traces without allocating a durable run", async () => {
    const host = createHost();
    const response = await sendPreparedIntegrationChatTurn(
      host,
      "session-1",
      {
        mode: "chat",
        operatorId: "operator-1",
        authActorId: "actor-1",
        authActorSource: "token",
        policyRunId: "run-1",
        policyTaskId: "task-1",
        permissionProfileId: "profile-safe",
        localOperatorOverrideId: "override-1",
      },
      createPrepared("chat"),
      createBinding(),
      "chat_thread_turn_appended",
    );

    expect(host.beginDurableChatRun).not.toHaveBeenCalled();
    expect(host.storage.chatTurnTraces.create).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: "turn-1",
        sessionId: "session-1",
        status: "running",
      }),
    );
    expect(host.commsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-1",
        target: "target-1",
        sessionId: "session-1",
        message: "hello",
        agentId: "operator-1",
        operatorId: "operator-1",
        authActorId: "actor-1",
        authActorSource: "token",
        runId: "run-1",
        taskId: "task-1",
        permissionProfileId: "profile-safe",
        localOperatorOverrideId: "override-1",
        surface: "chat",
      }),
    );
    expect(host.storage.chatTurnTraces.patch).toHaveBeenCalledWith(
      "turn-1",
      expect.objectContaining({
        status: "completed",
        assistantMessageId: "assistant-1",
      }),
    );
    expect(response.transport).toBe("integration");
  });

  it("marks the integration trace failed if bookkeeping breaks after external delivery", async () => {
    const host = createHost({
      ingestEvent: vi.fn(async () => {
        throw new Error("local ingest failed");
      }),
    });

    await expect(
      sendPreparedIntegrationChatTurn(
        host,
        "session-1",
        {},
        createPrepared("chat"),
        createBinding(),
        "chat_thread_turn_appended",
      ),
    ).rejects.toThrow("local ingest failed");

    expect(host.commsSend).toHaveBeenCalled();
    expect(host.storage.chatTurnTraces.patch).toHaveBeenLastCalledWith(
      "turn-1",
      expect.objectContaining({
        status: "failed",
      }),
    );
  });

  it("streams integration writeback through the one-shot delivery path", async () => {
    const host = createHost();
    const chunks = [];
    for await (const chunk of streamPreparedIntegrationChatTurn(
      host,
      "session-1",
      {},
      createPrepared("chat"),
      createBinding(),
      "chat_thread_turn_appended",
    )) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "message_start",
      "delta",
      "message_done",
      "trace_update",
      "done",
    ]);
    expect(chunks[1]).toEqual(
      expect.objectContaining({
        type: "delta",
        delta: "Delivered via integration conn-1 to target-1.",
      }),
    );
    expect(chunks[3]).toEqual(
      expect.objectContaining({
        type: "trace_update",
        trace: expect.objectContaining({
          status: "completed",
        }),
      }),
    );
  });
});

function createHost(
  overrides: {
    beginDurableChatRun?: (...args: unknown[]) => DurableRunRecord | undefined;
    traceState?: ChatTurnTraceRecord;
    ingestEvent?: (...args: unknown[]) => Promise<unknown>;
  } = {},
): ChatTurnDispatchHost & {
  registerActiveChatTurnStream: ReturnType<typeof vi.fn>;
  persistChatStreamChunk: ReturnType<typeof vi.fn>;
  completeActiveChatTurnStream: ReturnType<typeof vi.fn>;
  beginDurableChatRun: ReturnType<typeof vi.fn>;
  recordDevDiagnostic: ReturnType<typeof vi.fn>;
} {
  const traceState =
    overrides.traceState ??
    ({
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      status: "running",
      routing: {},
      startedAt: "2026-04-11T00:00:00.000Z",
    } as unknown as ChatTurnTraceRecord);
  const executionRegistry = new ChatTurnExecutionRegistry();
  const registerActiveChatTurnStream = vi.fn((sessionId: string, turnId: string, runId?: string) =>
    executionRegistry.registerActiveStream(sessionId, turnId, 0, runId),
  );
  const persistChatStreamChunk = vi.fn();
  const completeActiveChatTurnStream = vi.fn();
  const closeActiveChatTurnStream = vi.fn();
  const beginDurableChatRun = overrides.beginDurableChatRun ?? vi.fn(() => undefined);
  const createTrace = vi.fn((input: Partial<ChatTurnTraceRecord>) => ({ ...traceState, ...input }));
  const patchTrace = vi.fn((_turnId: string, patch: Partial<ChatTurnTraceRecord>) => ({ ...traceState, ...patch }));
  return {
    config: {
      assistant: {
        durable: {
          enabled: true,
          executionEnabled: true,
          chatAutoPromoteEnabled: true,
        },
      },
    },
    storage: {
      durableRuns: {
        getRun: vi.fn(() => ({ status: "running" })),
      },
      chatTurnTraces: {
        create: createTrace,
        patch: patchTrace,
        get: vi.fn(() => traceState),
      },
    } as never,
    backgroundTasks: new Set(),
    isFeatureEnabled: vi.fn((flag: string) => flag === "durableKernelV1Enabled"),
    streamPersistedChatTurnEvents: vi.fn(async function* () {}),
    persistChatStreamChunk,
    createHydratedChatTurnTrace: vi.fn((_turnId: string, trace: ChatTurnTraceRecord) => trace),
    recordDevDiagnostic: vi.fn(),
    finalizeDurableChatRun: vi.fn(),
    completeActiveChatTurnStream,
    closeActiveChatTurnStream,
    getActiveChatTurnStream: vi.fn((turnId: string) => executionRegistry.getActiveStream(turnId)),
    beginDurableChatRun,
    registerActiveChatTurnStream,
    ensureSessionInternalToolGrant: vi.fn(),
    requireExecutedToolResult: vi.fn(),
    commsSend: vi.fn(),
    ingestEvent: overrides.ingestEvent ?? vi.fn(),
    updateActiveLeafOrThrow: vi.fn(),
    publishRealtime: vi.fn(),
  } as unknown as ChatTurnDispatchHost & {
    registerActiveChatTurnStream: ReturnType<typeof vi.fn>;
    persistChatStreamChunk: ReturnType<typeof vi.fn>;
    completeActiveChatTurnStream: ReturnType<typeof vi.fn>;
    beginDurableChatRun: ReturnType<typeof vi.fn>;
    recordDevDiagnostic: ReturnType<typeof vi.fn>;
  };
}

function createPrepared(mode: "chat" | "cowork" | "code", normalizedOverrides: Record<string, unknown> = {}) {
  return {
    session: {
      sessionId: "session-1",
    },
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
    assistantMessageId: "assistant-1",
    parentTurnId: "turn-0",
    branchKind: "append",
    content: "hello",
    route: {
      provider: "openai",
      model: "gpt-5.4",
    },
    normalized: {
      mode,
      ...normalizedOverrides,
    },
    prefs: {
      mode,
    },
    autonomy: {
      reflectionMode: "off",
      proactiveMode: "manual",
      lastProactiveRunId: undefined,
    },
    effectiveToolAutonomy: "manual",
    retrievalTrace: undefined,
    workspaceId: "default",
    resolvedGuidance: {
      globalFilesUsed: [],
      workspaceFilesUsed: [],
      truncated: false,
    },
  } as never;
}

function createBinding() {
  return {
    transport: "integration",
    connectionId: "conn-1",
    target: "target-1",
    writable: true,
  } as never;
}
