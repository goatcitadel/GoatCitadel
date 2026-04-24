import { describe, expect, it, vi } from "vitest";
import type { ChatTurnTraceRecord } from "@goatcitadel/contracts";
import type { ChatTurnStreamHost } from "./chat-turn-stream-service.js";

vi.mock("./chat-turn-helpers.js", () => ({
  buildDelegationFailureGuidance: () => "fallback guidance",
  buildEmptyAssistantTurnFallbackText: () => "Recovered empty assistant output.",
  ChatTurnCancelledError: class ChatTurnCancelledError extends Error {},
  dedupeChatCitations: (items: unknown[]) => items,
  isChatTurnCancelledError: () => false,
  mergeExecutionPlanStepStatuses: (_steps: unknown, next: unknown) => next,
  renderExecutionPlanAsMarkdown: () => "execution plan",
  splitIntoChunks: (value: string) => [value],
  toTitleCase: (value: string) => value,
  truncateSummaryLine: (value: string) => value,
}));

vi.mock("./chat-turn-realtime.js", () => ({
  buildChatTurnRealtimeOptions: () => undefined,
}));

const { streamPreparedAgentChatTurn } = await import("./chat-turn-stream-service.js");

describe("streamPreparedAgentChatTurn", () => {
  it("marks empty-output stream recovery as repaired in both the trace and message_done", async () => {
    const host = createHost();
    const chunks = [];

    for await (const chunk of streamPreparedAgentChatTurn(
      host,
      "session-1",
      { content: "hello", mode: "chat" } as never,
      createPreparedTurn(),
      "chat_thread_turn_appended",
    )) {
      chunks.push(chunk);
    }

    const messageDone = chunks.find((chunk) => chunk.type === "message_done");
    const traceUpdate = [...chunks].reverse().find((chunk) => chunk.type === "trace_update");

    expect(messageDone).toEqual(
      expect.objectContaining({
        type: "message_done",
        content: "Recovered empty assistant output.",
        repaired: true,
        repair: {
          applied: true,
          kind: "deterministic_empty_output_synthesis",
          source: "stream_layer",
          preRepairContent: "",
          postRepairContent: "Recovered empty assistant output.",
        },
      }),
    );
    expect(traceUpdate).toEqual(
      expect.objectContaining({
        type: "trace_update",
        trace: expect.objectContaining({
          completion: expect.objectContaining({
            status: "complete",
            repaired: true,
            repair: expect.objectContaining({
              applied: true,
              kind: "deterministic_empty_output_synthesis",
              source: "stream_layer",
            }),
          }),
        }),
      }),
    );
    expect(host.storage.chatTurnTraces.get("turn-1").completion).toEqual({
      status: "complete",
      repaired: true,
      repair: {
        applied: true,
        kind: "deterministic_empty_output_synthesis",
        source: "stream_layer",
        preRepairContent: "",
        postRepairContent: "Recovered empty assistant output.",
      },
    });
    expect(host.hooksService.runInlineHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "before_message_write",
        payload: expect.objectContaining({
          turnId: "turn-1",
          messageId: "assistant-1",
          contentLength: "Recovered empty assistant output.".length,
          stream: true,
        }),
      }),
    );
    expect(host.hooksService.enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "agent_end",
        payload: expect.objectContaining({
          turnId: "turn-1",
          status: "completed",
          stream: true,
          repaired: true,
        }),
      }),
    );
    expect(chunks.at(-1)).toEqual(
      expect.objectContaining({
        type: "done",
      }),
    );
  });
});

function createHost(): ChatTurnStreamHost & {
  storage: {
    chatTurnTraces: {
      get: (turnId: string) => ChatTurnTraceRecord;
      patch: ReturnType<typeof vi.fn>;
    };
  };
  hooksService: {
    runInlineHooks: ReturnType<typeof vi.fn>;
    enqueueAfterHooks: ReturnType<typeof vi.fn>;
  };
} {
  let trace: ChatTurnTraceRecord = {
    turnId: "turn-1",
    sessionId: "session-1",
    userMessageId: "user-1",
    parentTurnId: "turn-0",
    branchKind: "append",
    status: "running",
    mode: "chat",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    startedAt: "2026-04-18T00:00:00.000Z",
    toolRuns: [],
    citations: [],
    routing: {},
  };

  const patchTrace = vi.fn((_turnId: string, patch: Partial<ChatTurnTraceRecord>) => {
    trace = { ...trace, ...patch };
    return trace;
  });

  return {
    storage: {
      chatDelegationSteps: {
        listByRun: vi.fn(() => []),
      },
      chatToolRuns: {
        listByTurn: vi.fn(() => []),
        listByTurnIds: vi.fn(() => new Map()),
      },
      chatExecutionPlans: {
        create: vi.fn(),
        patch: vi.fn(),
        get: vi.fn(),
      },
      chatDelegationRuns: {
        create: vi.fn(),
        patch: vi.fn(),
      },
      chatSessionProjects: {
        get: vi.fn(),
      },
      chatTurnTraces: {
        create: vi.fn(() => trace),
        patch: patchTrace,
        get: vi.fn((_turnId: string) => trace),
      },
    },
    turnRuntime: {
      runStream: vi.fn(async function* () {}),
    },
    hooksService: {
      runInlineHooks: vi.fn(async () => ({ runs: [] })),
      enqueueAfterHooks: vi.fn(),
    } as never,
    resolvePreparedTurnOrchestration: vi.fn(async () => undefined),
    createChatCompletion: vi.fn(),
    recordDevDiagnostic: vi.fn(),
    buildChatOrchestrationSummary: vi.fn(),
    createChatSession: vi.fn(),
    inheritDelegatedSessionToolGrants: vi.fn(),
    updateChatSessionPrefs: vi.fn(),
    agentSendChatMessage: vi.fn(),
    beginActiveChatTurnExecution: vi.fn(() => new AbortController()),
    endActiveChatTurnExecution: vi.fn(),
    ingestEvent: vi.fn(async () => undefined),
    updateActiveLeafOrThrow: vi.fn(),
    collectCapabilityUpgradeSuggestions: vi.fn(async () => []),
    collectSpecialistCandidateSuggestions: vi.fn(() => []),
    publishRealtime: vi.fn(),
    extractAndPersistLearnedMemory: vi.fn(),
    scheduleChatMemoryContextPrewarm: vi.fn(),
    scheduleMemoryMaintenancePostTurnEvaluation: vi.fn(),
    recordCapabilityGapFromTrace: vi.fn(),
    markChatTurnCancelled: vi.fn(() => trace),
  } as unknown as ChatTurnStreamHost & {
    storage: {
      chatTurnTraces: {
        get: (turnId: string) => ChatTurnTraceRecord;
        patch: ReturnType<typeof vi.fn>;
      };
    };
    hooksService: {
      runInlineHooks: ReturnType<typeof vi.fn>;
      enqueueAfterHooks: ReturnType<typeof vi.fn>;
    };
  };
}

function createPreparedTurn() {
  return {
    session: {
      sessionId: "session-1",
    },
    turnId: "turn-1",
    userEventId: "user-1",
    assistantMessageId: "assistant-1",
    parentTurnId: "turn-0",
    branchKind: "append",
    sourceTurnId: undefined,
    content: "hello",
    route: {
      provider: "openai",
      model: "gpt-5.4",
    },
    normalized: {
      mode: "chat",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
    },
    prefs: {
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
    },
    history: [],
    autonomy: {
      proactiveMode: "off",
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
