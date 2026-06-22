import type {
  ChatCapabilityUpgradeSuggestion,
  ChatMessageRecord,
  ChatSpecialistCandidateSuggestionRecord,
  ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchMocks = vi.hoisted(() => ({
  consumePreparedAgentChatTurn: vi.fn(async (_host, sessionId, _request, prepared, eventType, orchestration) => ({
    sessionId,
    userMessage: prepared.userMessage,
    assistantMessage: {
      messageId: prepared.assistantMessageId,
      sessionId,
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: orchestration ? `orchestrated:${eventType}` : `durable:${eventType}`,
      timestamp: "2026-05-14T00:00:01.000Z",
    },
    transport: "llm",
    model: prepared.prefs.model,
    turnId: prepared.turnId,
    trace: { turnId: prepared.turnId, sessionId, status: "completed" },
    citations: [],
    routing: {},
  })),
  launchPreparedAgentChatTurnStream: vi.fn(),
  sendPreparedIntegrationChatTurn: vi.fn(),
  shouldUseDurableExecution: vi.fn(() => false),
  streamPreparedIntegrationChatTurn: vi.fn(),
}));

vi.mock("./chat-turn-dispatch-service.js", () => dispatchMocks);

import { agentSendChatMessage, agentSendChatMessageStream, type ChatTurnEntryHost } from "./chat-turn-entry-service.js";

function createTrace(patch: Partial<ChatTurnTraceRecord> = {}): ChatTurnTraceRecord {
  return {
    turnId: "turn-1",
    sessionId: "session-1",
    userMessageId: "user-1",
    parentTurnId: "parent-1",
    branchKind: "append",
    status: "running",
    mode: "chat",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    startedAt: "2026-05-14T00:00:00.000Z",
    routing: { primaryProviderId: "openai", primaryModel: "gpt-5.4", fallbackUsed: false },
    toolRuns: [],
    citations: [],
    ...patch,
  };
}

function createPreparedTurn(overrides: Record<string, unknown> = {}) {
  const userMessage: ChatMessageRecord = {
    messageId: "user-1",
    sessionId: "session-1",
    role: "user",
    actorType: "user",
    actorId: "operator",
    content: "Have the architect, coder, and QA review this handoff.",
    timestamp: "2026-05-14T00:00:00.000Z",
  };

  return {
    turnId: "turn-1",
    userEventId: "user-1",
    assistantMessageId: "assistant-1",
    userMessage,
    parentTurnId: "parent-1",
    branchKind: "append",
    sourceTurnId: undefined,
    content: userMessage.content,
    route: { channel: "mission", account: "operator" },
    workspaceId: "default",
    history: [{ role: "user", content: userMessage.content }],
    normalized: { mode: "chat", webMode: "off", memoryMode: "off" },
    prefs: {
      sessionId: "session-1",
      mode: "chat",
      webMode: "off",
      memoryMode: "off",
      providerId: "openai",
      model: "gpt-5.4",
      planningMode: "off",
      reflectionMode: "off",
    },
    autonomy: {
      reflectionMode: "off",
      proactiveMode: "off",
      lastProactiveRunId: undefined,
    },
    effectiveToolAutonomy: "safe_auto",
    retrievalTrace: { mode: "off" },
    threadKnowledgeCitations: [],
    resolvedGuidance: {
      globalFilesUsed: ["AGENTS.md"],
      workspaceFilesUsed: [],
      truncated: false,
    },
    ...overrides,
  };
}

function createHost(turnRuntimeResult: Record<string, unknown> = {}) {
  let trace = createTrace();
  const patchedTraces: Array<Partial<ChatTurnTraceRecord>> = [];
  const controller = new AbortController();

  const host = {
    config: {
      assistant: {
        durable: {
          enabled: false,
          executionEnabled: false,
          chatAutoPromoteEnabled: false,
        },
      },
    },
    storage: {
      chatSessionPrefs: {
        ensure: vi.fn(() => ({
          sessionId: "session-1",
          mode: "chat",
          webMode: "off",
          memoryMode: "off",
          providerId: "openai",
          model: "gpt-5.4",
          planningMode: "off",
          reflectionMode: "off",
        })),
      },
      chatSessionBindings: {
        get: vi.fn(() => undefined),
        upsert: vi.fn((input) => ({ ...input, transport: input.transport ?? "llm", writable: true })),
      },
      chatReflectionAttempts: {
        create: vi.fn(),
      },
      chatTurnTraces: {
        get: vi.fn(() => trace),
        patch: vi.fn((_turnId: string, patch: Partial<ChatTurnTraceRecord>) => {
          patchedTraces.push(patch);
          trace = { ...trace, ...patch };
          return trace;
        }),
      },
      chatToolRuns: {
        listByTurn: vi.fn(() => []),
      },
      durableRuns: {
        createRun: vi.fn(),
      },
    },
    llmService: {
      getRuntimeConfig: vi.fn(() => ({
        activeProviderId: "openai",
        activeModel: "gpt-5.4",
        providers: [
          {
            providerId: "openai",
            label: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            defaultModel: "gpt-5.4",
            hasApiKey: true,
          },
        ],
      })),
    },
    turnRuntime: {
      run: vi.fn(async () => turnRuntimeResult),
      runStream: vi.fn(),
    },
    withChatTurnWriteLease: vi.fn(async (_sessionId, _label, task) => task()),
    withChatTurnWriteLeaseStream: vi.fn((_sessionId, _label, task) => task()),
    withEphemeralStreamEnvelope: vi.fn(async function* (stream: AsyncGenerator<Record<string, unknown>>) {
      yield* stream;
    }),
    prepareAgentChatTurn: vi.fn(async () => createPreparedTurn()),
    requireChatTurnContext: vi.fn(),
    resolvePreparedTurnOrchestration: vi.fn(async () => undefined),
    resolveFallbackTargets: vi.fn(() => []),
    recordDevDiagnostic: vi.fn(),
    isFeatureEnabled: vi.fn(() => false),
    beginActiveChatTurnExecution: vi.fn(() => controller),
    endActiveChatTurnExecution: vi.fn(),
    getActiveChatTurnExecution: vi.fn(() => ({ sessionId: "session-1", controller })),
    markChatTurnCancelled: vi.fn(),
    streamPersistedChatTurnEvents: vi.fn(async function* (_sessionId, turnId, options) {
      yield { type: "trace_update", sessionId: "session-1", turnId, trace: createTrace({ turnId }), options };
      yield { type: "done", sessionId: "session-1", turnId };
    }),
    ingestEvent: vi.fn(),
    collectCapabilityUpgradeSuggestions: vi.fn(async () => []),
    collectSpecialistCandidateSuggestions: vi.fn(() => []),
    recordCapabilityGapFromTrace: vi.fn(),
    extractAndPersistLearnedMemory: vi.fn(),
    recordTurnCommitments: vi.fn(),
    updateActiveLeafOrThrow: vi.fn(),
    publishRealtime: vi.fn(),
    isReplayScratchSession: vi.fn(() => false),
    triggerChatSessionProactive: vi.fn(),
    scheduleChatMemoryContextPrewarm: vi.fn(),
    scheduleMemoryMaintenancePostTurnEvaluation: vi.fn(),
    scheduleBackgroundReviewIfDue: vi.fn(),
  } as unknown as ChatTurnEntryHost & {
    patchedTraces: Array<Partial<ChatTurnTraceRecord>>;
  };

  host.patchedTraces = patchedTraces;
  return host;
}

async function collectChunks(stream: AsyncGenerator<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const chunks: Array<Record<string, unknown>> = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("chat-turn-entry-service loop 20 coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchMocks.shouldUseDurableExecution.mockReturnValue(false);
  });

  it("routes prepared sends through mode orchestration before durable dispatch", async () => {
    const host = createHost();
    const orchestrationResolution = {
      routeDecision: { workflowTemplate: "cowork.plan.work.synthesize" },
      executionPlanDraft: { summary: "Delegate and synthesize." },
    };
    host.resolvePreparedTurnOrchestration = vi.fn(async () => orchestrationResolution) as never;

    const result = await agentSendChatMessage(host, "session-1", { content: "plan this", mode: "cowork" });

    expect(result.assistantMessage?.content).toBe("orchestrated:chat_thread_turn_appended");
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "orchestration",
        event: "chat.orchestration.selected",
        turnId: "turn-1",
      }),
    );
    expect(dispatchMocks.consumePreparedAgentChatTurn).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.objectContaining({ content: "plan this" }),
      expect.objectContaining({ turnId: "turn-1" }),
      "chat_thread_turn_appended",
      orchestrationResolution,
      expect.objectContaining({ abortSignal: undefined }),
    );
    expect(dispatchMocks.shouldUseDurableExecution).not.toHaveBeenCalled();
  });

  it("routes durable-eligible prepared sends through the dispatch service without orchestration", async () => {
    const host = createHost();
    dispatchMocks.shouldUseDurableExecution.mockReturnValue(true);

    const result = await agentSendChatMessage(host, "session-1", { content: "run durably", mode: "code" });

    expect(result.assistantMessage?.content).toBe("durable:chat_thread_turn_appended");
    expect(dispatchMocks.consumePreparedAgentChatTurn).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.objectContaining({ content: "run durably" }),
      expect.objectContaining({ turnId: "turn-1" }),
      "chat_thread_turn_appended",
      undefined,
      expect.objectContaining({ abortSignal: undefined }),
    );
  });

  it("streams ordinary LLM sends by launching prepared execution and tailing persisted events", async () => {
    const host = createHost();

    const chunks = await collectChunks(agentSendChatMessageStream(host, "session-1", { content: "stream this" }));

    expect(dispatchMocks.launchPreparedAgentChatTurnStream).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.objectContaining({ content: "stream this" }),
      expect.objectContaining({ turnId: "turn-1" }),
      "chat_thread_turn_appended",
    );
    expect(host.streamPersistedChatTurnEvents).toHaveBeenCalledWith("session-1", "turn-1", { liveTail: true });
    expect(chunks.map((chunk) => chunk.type)).toEqual(["trace_update", "done"]);
  });

  it("persists empty-response fallback text, suggestions, and proactive delegation hints on completed LLM turns", async () => {
    const capabilitySuggestion: ChatCapabilityUpgradeSuggestion = {
      suggestionId: "capability-1",
      capabilityId: "browser.search",
      label: "Browser search",
      reason: "The turn would benefit from web search.",
    };
    const specialistSuggestion = {
      suggestionId: "specialist-1",
      role: "qa",
      label: "QA review",
      reason: "The prompt asks for QA review.",
    } as unknown as ChatSpecialistCandidateSuggestionRecord;
    const host = createHost({
      assistantContent: "",
      assistantModel: "gpt-5.4",
      requiresApproval: false,
      turnTrace: createTrace({ status: "completed" }),
    });
    host.collectCapabilityUpgradeSuggestions = vi.fn(async () => [capabilitySuggestion]) as never;
    host.collectSpecialistCandidateSuggestions = vi.fn(() => [specialistSuggestion]) as never;

    const result = await agentSendChatMessage(host, "session-1", {
      content: "Have the architect, coder, and QA review this handoff.",
      mode: "chat",
    });

    expect(result.assistantMessage?.content).toContain("Summary");
    expect(host.ingestEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        message: expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("the final assistant text was empty"),
        }),
      }),
    );
    expect(host.storage.chatTurnTraces.patch).toHaveBeenCalledWith(
      "turn-1",
      expect.objectContaining({
        capabilityUpgradeSuggestions: [capabilitySuggestion],
        specialistCandidateSuggestions: [specialistSuggestion],
      }),
    );
    expect(host.triggerChatSessionProactive).toHaveBeenCalledWith("session-1", {
      source: "chat",
      reason: "Detected multi-role phrasing; generated delegation suggestion.",
    });
  });

  it("persists capability suggestions on approval waits without assistant messages", async () => {
    const capabilitySuggestion: ChatCapabilityUpgradeSuggestion = {
      suggestionId: "capability-approval",
      capabilityId: "filesystem.read",
      label: "File read",
      reason: "The approval wait is tied to file access.",
    };
    const approvalTrace = createTrace({
      status: "waiting_for_approval",
      failure: {
        failureClass: "approval_required",
        message: "Approval required before reading a local file.",
        retryable: true,
      },
    });
    const host = createHost({
      assistantContent: "Approval required before reading a local file.",
      assistantModel: "gpt-5.4",
      requiresApproval: true,
      turnTrace: approvalTrace,
    });
    host.collectCapabilityUpgradeSuggestions = vi.fn(async () => [capabilitySuggestion]) as never;

    const result = await agentSendChatMessage(host, "session-1", { content: "read the file", mode: "code" });

    expect(result.assistantMessage).toBeUndefined();
    expect(host.ingestEvent).not.toHaveBeenCalled();
    expect(host.storage.chatTurnTraces.patch).toHaveBeenCalledWith("turn-1", {
      capabilityUpgradeSuggestions: [capabilitySuggestion],
    });
    expect(host.recordCapabilityGapFromTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        trace: expect.objectContaining({
          capabilityUpgradeSuggestions: [capabilitySuggestion],
        }),
      }),
    );
  });
});
