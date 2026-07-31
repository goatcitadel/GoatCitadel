import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageRecord, ChatTurnTraceRecord } from "@goatcitadel/contracts";
import { ConflictError, NotFoundError, SCHEDULED_TURN_PERMISSION_PROFILE_ID } from "@goatcitadel/contracts";

const dispatchMocks = vi.hoisted(() => ({
  consumePreparedAgentChatTurn: vi.fn(async (_host, sessionId, _request, prepared, eventType) => ({
    sessionId,
    userMessage: prepared.userMessage,
    assistantMessage: {
      messageId: prepared.assistantMessageId,
      sessionId,
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: `dispatched:${eventType}`,
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
  sendPreparedIntegrationChatTurn: vi.fn(async (_host, sessionId, _input, prepared, binding, eventType) => ({
    sessionId,
    userMessage: prepared.userMessage,
    transport: binding.transport,
    turnId: prepared.turnId,
    trace: { turnId: prepared.turnId, sessionId, status: "completed", eventType },
    citations: [],
    routing: {},
  })),
  shouldUseDurableExecution: vi.fn(() => false),
  streamPreparedIntegrationChatTurn: vi.fn(async function* (_host, sessionId, _input, prepared, binding, eventType) {
    yield {
      type: "done",
      sessionId,
      turnId: prepared.turnId,
      trace: { turnId: prepared.turnId, sessionId, status: "completed", eventType, transport: binding.transport },
    };
  }),
}));

vi.mock("./chat-turn-dispatch-service.js", () => dispatchMocks);

import {
  agentSendChatMessage,
  agentSendChatMessageStream,
  cancelChatTurn,
  editChatTurn,
  editChatTurnStream,
  resumeAgentChatTurnStream,
  routePreflight,
  retryChatTurn,
  retryChatTurnStream,
  type ChatTurnEntryHost,
} from "./chat-turn-entry-service.js";
import { ChatTurnStreamRegistrationMismatchError } from "./chat-turn-execution-registry.js";
import { routeWithModelRouter } from "./model-router-decision-service.js";
import {
  computeChatTurnAdmissionMaterialSha256,
  createExternalCompanionAdmissionContext,
} from "./session-control-service.js";

function createPreparedTurn(overrides: Record<string, unknown> = {}) {
  const userMessage: ChatMessageRecord = {
    messageId: "user-1",
    sessionId: "session-1",
    role: "user",
    actorType: "user",
    actorId: "operator",
    content: "hello",
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
    content: "hello",
    route: { channel: "mission", account: "operator" },
    workspaceId: "default",
    history: [{ role: "user", content: "hello" }],
    normalized: { mode: "chat", webMode: "off", memoryMode: "off" },
    prefs: {
      sessionId: "session-1",
      mode: "chat",
      webMode: "off",
      memoryMode: "off",
      providerId: "primary",
      model: "primary-model",
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
    threadKnowledgeCitations: [
      {
        citationId: "knowledge:file-1",
        title: "Guide",
        snippet: "thread knowledge",
        knowledge: {
          attachmentId: "file-1",
          sourceRef: "guide.md",
          title: "Guide",
          retrievalMode: "full_text",
        },
      },
    ],
    resolvedGuidance: {
      globalFilesUsed: ["AGENTS.md"],
      workspaceFilesUsed: [],
      truncated: false,
    },
    ...overrides,
  };
}

function createFanoutEligiblePreparedTurn(
  overrides: { subagentPolicy?: "off" | "ask_when_useful" | "auto_when_useful" } = {},
) {
  const subagentPolicy = overrides.subagentPolicy ?? "auto_when_useful";
  return createPreparedTurn({
    normalized: { mode: "cowork", webMode: "off", memoryMode: "off", subagentPolicy },
    prefs: {
      sessionId: "session-1",
      mode: "cowork",
      webMode: "off",
      memoryMode: "off",
      providerId: "primary",
      model: "primary-model",
      planningMode: "off",
      reflectionMode: "off",
      subagentPolicy,
    },
  });
}

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
    routing: { primaryProviderId: "primary", primaryModel: "primary-model", fallbackUsed: false },
    toolRuns: [],
    citations: [],
    ...patch,
  };
}

function createHost(turnRuntimeResult: Record<string, unknown>) {
  let trace = createTrace();
  let binding: Record<string, unknown> | undefined;
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
      runImmediateTransaction: vi.fn((work) => work()),
      chatSessionPrefs: {
        ensure: vi.fn(() => ({ providerId: "primary", model: "primary-model", mode: "chat" })),
      },
      chatSessionBindings: {
        get: vi.fn(() => binding),
        upsert: vi.fn((input) => {
          binding = {
            sessionId: input.sessionId,
            transport: input.transport ?? "llm",
            writable: input.writable ?? true,
            createdAt: "2026-05-14T00:00:00.000Z",
            updatedAt: "2026-05-14T00:00:00.000Z",
          };
          return binding;
        }),
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
    sessionControlRuntimeOwner: {
      admitOperatorChatTurn: vi.fn((input) => ({
        identity: {
          admissionId: `admission-${input.turnId}`,
          sessionIncarnationId: "incarnation-1",
          workspaceId: "default",
          sessionId: input.sessionId,
          turnId: input.turnId,
          aggregateRevision: 1,
          controllerGeneration: 1,
          materialSha256: computeChatTurnAdmissionMaterialSha256(input.request),
        },
        admittedRequest: input.request,
        requestActor: { actorKind: "operator", actorId: input.actorId },
        requestClaim: { runtimeOwnerId: `runtime-${input.turnId}`, leaseRevision: 1 },
      })),
      admitChatTurn: vi.fn((input) => ({
        identity: {
          admissionId: `admission-${input.turnId}`,
          sessionIncarnationId: "incarnation-1",
          workspaceId: "default",
          sessionId: input.sessionId,
          turnId: input.turnId,
          aggregateRevision: 1,
          controllerGeneration: input.actor?.actorKind === "external_companion" ? input.actor.expectedGeneration : 1,
          materialSha256: computeChatTurnAdmissionMaterialSha256(input.request),
        },
        admittedRequest: input.request,
        requestActor: { actorKind: input.actor.actorKind, actorId: input.actor.actorId },
        requestClaim: { runtimeOwnerId: `runtime-${input.turnId}`, leaseRevision: 1 },
      })),
      startRequestLeaseHeartbeat: vi.fn(() => ({ stop: vi.fn(), assertHealthy: vi.fn() })),
      renewRequestLease: vi.fn(),
      bindDurableRun: vi.fn((admission) => {
        admission.requestClaim = undefined;
      }),
      withDurableClaim: vi.fn(),
      assertActiveTurnWrite: vi.fn(),
      closeTurnWrite: vi.fn(),
    },
    llmService: {
      getRuntimeConfig: vi.fn(() => ({
        activeProviderId: "primary",
        activeModel: "primary-model",
        providers: [{ providerId: "primary", label: "Primary", defaultModel: "primary-model" }],
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
    prepareAgentChatTurn: vi.fn(async (_sessionId, _input, options) =>
      createPreparedTurn({
        turnId: options?.turnId ?? "turn-1",
        userEventId: options?.userMessageId ?? "user-1",
        assistantMessageId: options?.assistantMessageId ?? "assistant-1",
        turnAdmission: options?.turnAdmission,
      }),
    ),
    requireChatTurnContext: vi.fn(async () => ({
      trace: createTrace({ parentTurnId: "turn-root" }),
      userMessage: {
        messageId: "user-original",
        sessionId: "session-1",
        role: "user",
        actorType: "user",
        actorId: "operator",
        content: "original prompt",
        timestamp: "2026-05-14T00:00:00.000Z",
        attachments: [{ attachmentId: "attachment-1", fileName: "notes.md" }],
      },
      assistantMessage: {
        messageId: "assistant-original",
        sessionId: "session-1",
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        content: "original answer",
        timestamp: "2026-05-14T00:00:01.000Z",
      },
    })),
    resolvePreparedTurnOrchestration: vi.fn(async () => undefined),
    resolveFallbackTargets: vi.fn(() => []),
    recordDevDiagnostic: vi.fn(),
    isFeatureEnabled: vi.fn(() => false),
    beginActiveChatTurnExecution: vi.fn(() => controller),
    endActiveChatTurnExecution: vi.fn(),
    getActiveChatTurnExecution: vi.fn(() => ({ sessionId: "session-1", controller })),
    getActiveChatTurnStream: vi.fn(() => undefined),
    cancelDurableChatRun: vi.fn(),
    markChatTurnCancelled: vi.fn((_sessionId, turnId, cancelledBy) =>
      createTrace({
        turnId,
        status: "cancelled",
        failure: {
          failureClass: "cancelled",
          message: `Cancelled by ${cancelledBy ?? "operator"}.`,
          retryable: true,
        },
      }),
    ),
    streamPersistedChatTurnEvents: vi.fn(async function* (_sessionId, turnId, options) {
      yield { type: "trace_update", sessionId: "session-1", turnId, trace: createTrace({ turnId }), options };
      yield { type: "done", sessionId: "session-1", turnId };
    }),
    persistChatStreamChunk: vi.fn(),
    registerActiveChatTurnStream: vi.fn(() => ({
      registrationId: "stream-registration-1",
      sessionId: "session-1",
      turnId: "turn-1",
    })),
    completeActiveChatTurnStream: vi.fn(),
    closeActiveChatTurnStream: vi.fn(),
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

describe("agentSendChatMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchMocks.shouldUseDurableExecution.mockImplementation((_host, _prepared, _input, requireDurableExecution) =>
      Boolean(requireDurableExecution),
    );
  });

  it("returns the canonical deterministic turn without preparing or redispatching it", async () => {
    const host = createHost({});
    const trace = createTrace({
      turnId: "turn-deterministic",
      sessionId: "session-1",
      userMessageId: "user-deterministic",
      assistantMessageId: "assistant-deterministic",
      status: "completed",
      model: "primary-model",
      citations: [{ citationId: "canonical-citation", title: "Canonical" }],
    });
    const userMessage: ChatMessageRecord = {
      messageId: "user-deterministic",
      sessionId: "session-1",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "deterministic child work",
      timestamp: "2026-07-11T00:00:00.000Z",
    };
    const assistantMessage: ChatMessageRecord = {
      messageId: "assistant-deterministic",
      sessionId: "session-1",
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: "canonical child result",
      timestamp: "2026-07-11T00:00:01.000Z",
    };
    host.requireChatTurnContext = vi.fn(async () => ({ trace, userMessage, assistantMessage }));
    host.storage.chatTurnTraces.get = vi.fn(() => trace);

    const response = await agentSendChatMessage(
      host,
      "session-1",
      { content: "deterministic child work", mode: "chat" },
      {
        turnIdentity: {
          turnId: "turn-deterministic",
          userMessageId: "user-deterministic",
          assistantMessageId: "assistant-deterministic",
        },
      },
    );

    expect(response).toEqual(
      expect.objectContaining({
        turnId: "turn-deterministic",
        userMessage,
        assistantMessage,
        citations: trace.citations,
      }),
    );
    expect(host.prepareAgentChatTurn).not.toHaveBeenCalled();
    expect(host.turnRuntime.run).not.toHaveBeenCalled();
    expect(dispatchMocks.consumePreparedAgentChatTurn).not.toHaveBeenCalled();
    expect(dispatchMocks.sendPreparedIntegrationChatTurn).not.toHaveBeenCalled();
  });

  it("forces a policy-linked deterministic child through durable dispatch with its execution fence", async () => {
    const host = createHost({});
    host.requireChatTurnContext = vi.fn(async () => {
      throw new NotFoundError({ entity: "Chat turn", id: "turn-deterministic" });
    });
    host.prepareAgentChatTurn = vi.fn(async (_sessionId, _input, options) =>
      createPreparedTurn({
        turnId: options?.turnId,
        userEventId: options?.userMessageId,
        assistantMessageId: options?.assistantMessageId,
      }),
    );
    dispatchMocks.shouldUseDurableExecution.mockReturnValue(false);
    const assertDispatchOwnership = vi.fn();

    await agentSendChatMessage(
      host,
      "session-1",
      { content: "deterministic child work", mode: "chat", policyRunId: "delegation-run-1" },
      {
        assertDispatchOwnership,
        turnIdentity: {
          turnId: "turn-deterministic",
          userMessageId: "user-deterministic",
          assistantMessageId: "assistant-deterministic",
        },
      },
    );

    expect(assertDispatchOwnership).toHaveBeenCalledTimes(1);
    expect(dispatchMocks.shouldUseDurableExecution).toHaveBeenCalledWith(
      host,
      expect.objectContaining({ turnId: "turn-deterministic" }),
      expect.objectContaining({ policyRunId: "delegation-run-1" }),
      true,
    );
    expect(dispatchMocks.consumePreparedAgentChatTurn).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.objectContaining({ content: "deterministic child work" }),
      expect.objectContaining({ turnId: "turn-deterministic" }),
      "chat_thread_turn_appended",
      undefined,
      expect.objectContaining({
        assertDispatchOwnership,
        durableRunId: expect.stringMatching(/^durable-chat-[a-f0-9]{32}$/),
        requireDurableExecution: true,
      }),
    );
    expect(host.turnRuntime.run).not.toHaveBeenCalled();
    expect(host.resolvePreparedTurnOrchestration).not.toHaveBeenCalled();
  });

  it("never resolves mode orchestration before durable admission for a routed-context turn", async () => {
    const host = createHost({});
    host.prepareAgentChatTurn = vi.fn(async () =>
      createPreparedTurn({
        modelRouterDecision: routeWithModelRouter({ prompt: "compare the selected context" }),
        routedContextSnapshot: {
          snapshotId: "routed-snapshot-1",
          sourceRequestHash: "1".repeat(64),
          snapshotHash: "2".repeat(64),
          contextText: "Routed context snapshot (immutable).\nExact admitted bytes.",
        },
      }),
    );
    dispatchMocks.shouldUseDurableExecution.mockReturnValue(true);

    await agentSendChatMessage(host, "session-1", {
      content: "compare the selected context",
      mode: "chat",
      contextRefs: [{ kind: "memory_item", ref: "memory-1" }],
    });

    expect(host.resolvePreparedTurnOrchestration).not.toHaveBeenCalled();
    expect(dispatchMocks.consumePreparedAgentChatTurn).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.objectContaining({ contextRefs: [{ kind: "memory_item", ref: "memory-1" }] }),
      expect.objectContaining({ routedContextSnapshot: expect.objectContaining({ snapshotId: "routed-snapshot-1" }) }),
      "chat_thread_turn_appended",
      undefined,
      expect.any(Object),
    );
  });

  it("fails a policy-linked deterministic child closed when its session binding is no longer LLM", async () => {
    const host = createHost({});
    host.requireChatTurnContext = vi.fn(async () => {
      throw new NotFoundError({ entity: "Chat turn", id: "turn-deterministic" });
    });
    host.storage.chatSessionBindings.get = vi.fn(() => ({
      sessionId: "session-1",
      workspaceId: "default",
      transport: "discord",
      writable: true,
    })) as never;

    await expect(
      agentSendChatMessage(
        host,
        "session-1",
        { content: "deterministic child work", mode: "chat", policyRunId: "delegation-run-1" },
        {
          turnIdentity: {
            turnId: "turn-deterministic",
            userMessageId: "user-deterministic",
            assistantMessageId: "assistant-deterministic",
          },
        },
      ),
    ).rejects.toThrow(/requires an LLM session binding/i);

    expect(host.prepareAgentChatTurn).not.toHaveBeenCalled();
    expect(dispatchMocks.shouldUseDurableExecution).not.toHaveBeenCalled();
    expect(dispatchMocks.sendPreparedIntegrationChatTurn).not.toHaveBeenCalled();
    expect(dispatchMocks.consumePreparedAgentChatTurn).not.toHaveBeenCalled();
    expect(host.turnRuntime.run).not.toHaveBeenCalled();
    expect(host.storage.durableRuns.createRun).not.toHaveBeenCalled();
    expect(host.ingestEvent).not.toHaveBeenCalled();
  });

  it("threads deterministic identities through preparation when the canonical trace is not created yet", async () => {
    const host = createHost({
      assistantContent: "Recovered result",
      assistantModel: "primary-model",
      turnTrace: createTrace({ turnId: "turn-deterministic", status: "completed" }),
    });
    const userMessage: ChatMessageRecord = {
      messageId: "user-deterministic",
      sessionId: "session-1",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "deterministic child work",
      timestamp: "2026-07-11T00:00:00.000Z",
    };
    host.requireChatTurnContext = vi.fn(async () => {
      throw new NotFoundError({ entity: "Chat turn", id: "turn-deterministic" });
    });
    host.prepareAgentChatTurn = vi.fn(async (_sessionId, _input, options) =>
      createPreparedTurn({
        turnId: options?.turnId,
        userEventId: options?.userMessageId,
        assistantMessageId: options?.assistantMessageId,
        userMessage,
      }),
    );

    await agentSendChatMessage(
      host,
      "session-1",
      { content: "deterministic child work", mode: "chat" },
      {
        turnIdentity: {
          turnId: "turn-deterministic",
          userMessageId: "user-deterministic",
          assistantMessageId: "assistant-deterministic",
        },
      },
    );

    expect(host.prepareAgentChatTurn).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ content: "deterministic child work" }),
      expect.objectContaining({
        turnId: "turn-deterministic",
        userMessageId: "user-deterministic",
        assistantMessageId: "assistant-deterministic",
      }),
    );
    expect(host.turnRuntime.run).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect a buffered turn cancelled after the runtime returns", async () => {
    const host = createHost({
      assistantContent: "Completed answer.",
      assistantModel: "primary-model",
      turnTrace: createTrace({ status: "completed" }),
    });
    const controller = new AbortController();
    host.beginActiveChatTurnExecution = vi.fn(() => controller);
    host.turnRuntime.run = vi.fn(async () => {
      host.storage.chatTurnTraces.patch("turn-1", {
        status: "cancelled",
        completion: { status: "interrupted", repaired: false },
      });
      controller.abort();
      return {
        assistantContent: "Completed answer.",
        assistantModel: "primary-model",
        turnTrace: createTrace({ status: "completed" }),
      };
    }) as never;

    await expect(agentSendChatMessage(host, "session-1", { content: "hello", mode: "chat" })).rejects.toThrow(
      /cancelled/i,
    );

    expect(host.ingestEvent).not.toHaveBeenCalled();
    expect(host.patchedTraces).not.toContainEqual(expect.objectContaining({ status: "completed" }));
    expect(host.endActiveChatTurnExecution).toHaveBeenCalledWith(expect.any(String), controller);
  });

  it("registers a turn-scoped agent.fanout executor before the runtime runs and disposes it afterwards", async () => {
    const host = createHost({
      assistantContent: "Completed answer.",
      turnTrace: createTrace({ status: "completed" }),
    });
    (host.prepareAgentChatTurn as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      createFanoutEligiblePreparedTurn(),
    );
    const dispose = vi.fn();
    const register = vi.fn(() => dispose);
    (host as unknown as { subagentFanout: { register: typeof register } }).subagentFanout = { register };
    (host.turnRuntime.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // The executor must already be registered while the runtime (and thus a
      // model agent.fanout call routed through the policy engine) is running.
      expect(register).toHaveBeenCalledWith("session-1", expect.any(Function));
      expect(dispose).not.toHaveBeenCalled();
      return {
        assistantContent: "Completed answer.",
        turnTrace: createTrace({ status: "completed" }),
      };
    });

    await agentSendChatMessage(host, "session-1", { content: "hello", mode: "cowork" });

    expect(register).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("never registers an agent.fanout executor for a turn floored to subagentPolicy off (delegated-child shape)", async () => {
    const host = createHost({
      assistantContent: "Child answer.",
      turnTrace: createTrace({ status: "completed" }),
    });
    (host.prepareAgentChatTurn as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      createFanoutEligiblePreparedTurn({ subagentPolicy: "off" }),
    );
    const register = vi.fn(() => vi.fn());
    (host as unknown as { subagentFanout: { register: typeof register } }).subagentFanout = { register };

    await agentSendChatMessage(host, "session-1", { content: "delegated work", mode: "cowork" });

    // Even if a child model hallucinated an agent.fanout call past the schema
    // gate, its session must hold no executor — the runtime hook fails closed.
    expect(register).not.toHaveBeenCalled();
  });

  it("never registers an agent.fanout executor for ask-before-delegating turns", async () => {
    const host = createHost({
      assistantContent: "Ask-first answer.",
      turnTrace: createTrace({ status: "completed" }),
    });
    (host.prepareAgentChatTurn as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      createFanoutEligiblePreparedTurn({ subagentPolicy: "ask_when_useful" }),
    );
    const register = vi.fn(() => vi.fn());
    (host as unknown as { subagentFanout: { register: typeof register } }).subagentFanout = { register };

    await agentSendChatMessage(host, "session-1", {
      content: "compare vendors",
      mode: "cowork",
      subagentPolicy: "ask_when_useful",
    });

    expect(register).not.toHaveBeenCalled();
  });

  it("never registers an agent.fanout executor for restricted autonomous turns", async () => {
    const host = createHost({
      assistantContent: "Scheduled answer.",
      turnTrace: createTrace({ status: "completed" }),
    });
    (host.prepareAgentChatTurn as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      createFanoutEligiblePreparedTurn(),
    );
    const register = vi.fn(() => vi.fn());
    (host as unknown as { subagentFanout: { register: typeof register } }).subagentFanout = { register };

    await agentSendChatMessage(host, "session-1", {
      content: "scheduled work",
      mode: "cowork",
      permissionProfileId: SCHEDULED_TURN_PERMISSION_PROFILE_ID,
    });

    expect(register).not.toHaveBeenCalled();
  });

  it("rebinds the agent.fanout executor to the retry turn during a reflection retry", async () => {
    const host = createHost({});
    (host.prepareAgentChatTurn as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      createPreparedTurn({
        normalized: { mode: "cowork", webMode: "off", memoryMode: "off", subagentPolicy: "auto_when_useful" },
        prefs: {
          sessionId: "session-1",
          mode: "cowork",
          webMode: "off",
          memoryMode: "off",
          providerId: "primary",
          model: "primary-model",
          planningMode: "off",
          reflectionMode: "on",
          subagentPolicy: "auto_when_useful",
        },
        autonomy: {
          reflectionMode: "on",
          proactiveMode: "off",
          lastProactiveRunId: undefined,
        },
      }),
    );
    const disposals: number[] = [];
    let registrations = 0;
    const register = vi.fn(() => {
      registrations += 1;
      const registrationSeq = registrations;
      return () => disposals.push(registrationSeq);
    });
    (host as unknown as { subagentFanout: { register: typeof register } }).subagentFanout = { register };
    let callCount = 0;
    host.turnRuntime.run = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        expect(register).toHaveBeenCalledTimes(1);
        return {
          assistantContent: "The first attempt failed.",
          assistantModel: "primary-model",
          turnTrace: createTrace({
            status: "failed",
            failure: { failureClass: "tool_failed", message: "tool failed", retryable: true },
          }),
        };
      }
      // The retry run must see a FRESH registration bound to the retry turn
      // (the executor derives child runIds/diagnostics from prepared.turnId —
      // pinned in chat-subagent-fanout-service.test.ts), with the original
      // turn's registration already disposed.
      expect(register).toHaveBeenCalledTimes(2);
      expect(disposals).toEqual([1]);
      return {
        assistantContent: "Recovered answer.",
        assistantModel: "primary-model",
        turnTrace: createTrace({ status: "completed" }),
      };
    }) as never;

    await agentSendChatMessage(host, "session-1", { content: "hello", mode: "cowork" });

    expect(register).toHaveBeenCalledTimes(2);
    expect(disposals).toEqual([1, 2]);
  });

  it("disposes the agent.fanout executor even when the turn runtime throws", async () => {
    const host = createHost({});
    (host.prepareAgentChatTurn as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      createFanoutEligiblePreparedTurn(),
    );
    const dispose = vi.fn();
    const register = vi.fn(() => dispose);
    (host as unknown as { subagentFanout: { register: typeof register } }).subagentFanout = { register };
    (host.turnRuntime.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("synthetic runtime failure"));

    await expect(agentSendChatMessage(host, "session-1", { content: "hello", mode: "cowork" })).rejects.toThrow(
      /synthetic runtime failure/,
    );

    // A stale registration would let a LATER turn's agent.fanout call resolve
    // this dead turn's executor — disposal must be unconditional.
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("runs the synchronous LLM path, persists the assistant turn, and emits trace/realtime evidence", async () => {
    const host = createHost({
      assistantContent: "Completed answer.",
      assistantModel: "primary-model",
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      requiresApproval: false,
      turnTrace: createTrace({
        status: "completed",
        citations: [{ citationId: "model:1", title: "Model source", url: "https://example.com/source" }],
      }),
    });

    const result = await agentSendChatMessage(host, "session-1", { content: "hello", mode: "chat" });

    expect(result.assistantMessage).toEqual(
      expect.objectContaining({
        messageId: expect.any(String),
        content: "Completed answer.",
      }),
    );
    expect(host.turnRuntime.run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        turnId: result.turnId,
        content: "hello",
        outputMessageId: result.assistantMessage?.messageId,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(host.ingestEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        eventId: result.assistantMessage?.messageId,
        message: { role: "assistant", content: "Completed answer." },
      }),
      expect.objectContaining({ onCommit: expect.any(Function) }),
    );
    expect(host.storage.chatTurnTraces.patch).toHaveBeenCalledWith(
      result.turnId,
      expect.objectContaining({
        assistantMessageId: result.assistantMessage?.messageId,
        status: "completed",
        retrieval: { mode: "off" },
        guidance: expect.objectContaining({ workspaceId: "default" }),
      }),
    );
    expect(result.citations.map((citation) => citation.citationId)).toEqual(["knowledge:file-1", "model:1"]);
    expect(host.recordCapabilityGapFromTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        turnId: result.turnId,
      }),
    );
    expect(host.recordTurnCommitments).not.toHaveBeenCalled();
    expect(host.scheduleBackgroundReviewIfDue).not.toHaveBeenCalled();
    expect(host.scheduleMemoryMaintenancePostTurnEvaluation).not.toHaveBeenCalled();
    expect(host.publishRealtime).toHaveBeenCalledWith(
      "chat_thread_updated",
      "chat",
      expect.objectContaining({
        type: "chat_thread_turn_appended",
        activeLeafTurnId: result.turnId,
      }),
      expect.anything(),
    );
    expect(host.endActiveChatTurnExecution).toHaveBeenCalled();
  });

  it("places delegated canonical usage task ownership on the ingest payload", async () => {
    const host = createHost({
      assistantContent: "Delegated answer.",
      assistantModel: "primary-model",
      modelUsageEventIds: ["usage-child-1"],
      turnTrace: createTrace({ status: "completed" }),
    });

    await agentSendChatMessage(host, "session-1", {
      content: "delegated work",
      mode: "chat",
      policyTaskId: "chat-orchestration:parent-turn",
    });

    const payload = vi.mocked(host.ingestEvent).mock.calls[0]?.[1];
    expect(payload).toEqual(
      expect.objectContaining({
        taskId: "chat-orchestration:parent-turn",
        usage: expect.objectContaining({
          canonicalUsageEventIds: ["usage-child-1"],
          canonicalUsageOwner: {
            workspaceId: "default",
            sessionId: "session-1",
            turnId: expect.any(String),
          },
        }),
      }),
    );
    expect(payload?.usage?.canonicalUsageOwner).not.toHaveProperty("taskId");
  });

  it("does not run legacy provider schedulers for delegated-child non-stream turns", async () => {
    const host = createHost({
      assistantContent: "Child answer.",
      assistantModel: "primary-model",
      turnTrace: createTrace({ status: "completed" }),
    });
    (host.prepareAgentChatTurn as ReturnType<typeof vi.fn>).mockResolvedValue(
      createPreparedTurn({ parentDelegationStepId: "run-1:step-1" }),
    );

    await agentSendChatMessage(host, "session-1", {
      content: "delegated work",
      mode: "chat",
      parentDelegationStepId: "run-1:step-1",
    });

    expect(host.turnRuntime.run).toHaveBeenCalledWith(
      expect.objectContaining({ parentDelegationStepId: "run-1:step-1" }),
    );

    expect(host.recordTurnCommitments).not.toHaveBeenCalled();
    expect(host.scheduleBackgroundReviewIfDue).not.toHaveBeenCalled();
    expect(host.scheduleMemoryMaintenancePostTurnEvaluation).not.toHaveBeenCalled();
  });

  it("inherits actor, permission profile, and override context for automatic proactive suggestions", async () => {
    const host = createHost({
      assistantContent: "Architect and QA can split the work.",
      assistantModel: "primary-model",
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      requiresApproval: false,
      turnTrace: createTrace({ status: "completed" }),
    });
    host.prepareAgentChatTurn = vi.fn(async () =>
      createPreparedTurn({
        content: "Architect and QA should review this implementation.",
      }),
    ) as never;

    await agentSendChatMessage(host, "session-1", {
      content: "Architect and QA should review this implementation.",
      mode: "cowork",
      operatorId: "operator-1",
      authActorId: "operator-1",
      authActorSource: "token",
      permissionProfileId: "profile-1",
      localOperatorOverrideId: "override-1",
    });

    expect(host.triggerChatSessionProactive).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        source: "chat",
        operatorId: "operator-1",
        authActorId: "operator-1",
        authActorSource: "token",
        permissionProfileId: "profile-1",
        localOperatorOverrideId: "override-1",
      }),
    );
  });

  it("fails a non-durable approval wait closed instead of orphaning a request lease", async () => {
    const approvalTrace = createTrace({
      status: "waiting_for_approval",
      failure: {
        failureClass: "approval_required",
        message: "Approval required by policy.",
        retryable: true,
        recommendedAction: "approve_or_reject",
      },
    });
    const host = createHost({
      assistantContent: "Approval required by policy.",
      assistantModel: "primary-model",
      requiresApproval: true,
      turnTrace: approvalTrace,
    });

    await expect(agentSendChatMessage(host, "session-1", { content: "read local file", mode: "code" })).rejects.toThrow(
      /must transfer mutation authority to a durable run/i,
    );

    expect(host.ingestEvent).not.toHaveBeenCalled();
    expect(host.storage.chatTurnTraces.patch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        reflection: expect.objectContaining({ attempted: false }),
        proactive: { runId: undefined, mode: "off" },
        failure: approvalTrace.failure,
      }),
    );
    expect(host.sessionControlRuntimeOwner.closeTurnWrite).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" }),
    );
  });

  it("runs a reflection retry for failed autonomous LLM turns and persists the recovered answer", async () => {
    const host = createHost({});
    host.prepareAgentChatTurn = vi.fn(async () =>
      createPreparedTurn({
        prefs: {
          sessionId: "session-1",
          mode: "chat",
          webMode: "off",
          memoryMode: "off",
          providerId: "primary",
          model: "primary-model",
          planningMode: "off",
          reflectionMode: "on",
        },
        autonomy: {
          reflectionMode: "on",
          proactiveMode: "off",
          lastProactiveRunId: undefined,
        },
      }),
    ) as never;
    let callCount = 0;
    host.turnRuntime.run = vi.fn(async (request: { turnId: string; sourceTurnId?: string; content: string }) => {
      callCount += 1;
      if (callCount === 1) {
        return {
          assistantContent: "The first attempt failed.",
          assistantModel: "primary-model",
          turnTrace: createTrace({
            status: "failed",
            failure: {
              failureClass: "tool_failed",
              message: "tool failed",
              retryable: true,
            },
          }),
        };
      }
      return {
        assistantContent: "Recovered answer.",
        assistantModel: "primary-model",
        turnTrace: createTrace({
          turnId: request.turnId,
          sourceTurnId: request.sourceTurnId,
          branchKind: "retry",
          status: "completed",
        }),
      };
    }) as never;

    const result = await agentSendChatMessage(host, "session-1", { content: "hello", mode: "chat" });
    const retryRequest = vi.mocked(host.turnRuntime.run).mock.calls[1]?.[0] as {
      turnId: string;
      sourceTurnId?: string;
      content: string;
    };

    expect(host.turnRuntime.run).toHaveBeenCalledTimes(2);
    expect(retryRequest).toEqual(
      expect.objectContaining({
        sourceTurnId: "turn-1",
        content: expect.stringContaining("Retry guidance: last attempt was incomplete."),
      }),
    );
    expect(host.storage.chatReflectionAttempts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "tool failure or completion failure",
        outcome: "still_failed",
      }),
    );
    expect(result.turnId).toBe(retryRequest.turnId);
    expect(result.assistantMessage?.content).toBe("Recovered answer.");
    expect(host.storage.chatTurnTraces.patch).toHaveBeenCalledWith(
      retryRequest.turnId,
      expect.objectContaining({
        reflection: expect.objectContaining({
          attempted: true,
          outcome: "recovered",
        }),
      }),
    );
    expect(host.updateActiveLeafOrThrow).toHaveBeenCalledWith("session-1", "parent-1", retryRequest.turnId);
  });

  it("routes retry turns through prepared dispatch with the original user message and attachment ids", async () => {
    const host = createHost({});

    const result = await retryChatTurn(host, "session-1", "turn-original", {
      providerId: "backup",
      model: "backup-model",
      webMode: "on",
      contextRefs: [{ kind: "attachment", ref: "attachment-retry" }],
    });

    expect(host.requireChatTurnContext).toHaveBeenCalledWith("session-1", "turn-original");
    expect(host.prepareAgentChatTurn).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        content: "original prompt",
        attachments: ["attachment-1"],
        providerId: "backup",
        model: "backup-model",
        webMode: "on",
        contextRefs: [{ kind: "attachment", ref: "attachment-retry" }],
      }),
      expect.objectContaining({
        branchKind: "retry",
        sourceTurnId: "turn-original",
        parentTurnId: "turn-root",
        ingestUserMessage: false,
      }),
    );
    expect(dispatchMocks.consumePreparedAgentChatTurn).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.objectContaining({
        content: "original prompt",
        contextRefs: [{ kind: "attachment", ref: "attachment-retry" }],
      }),
      expect.objectContaining({ turnId: expect.any(String), turnAdmission: expect.any(Object) }),
      "chat_thread_turn_retried",
    );
    expect(result.assistantMessage?.content).toBe("dispatched:chat_thread_turn_retried");
  });

  it("routes edited turns through prepared dispatch and keeps existing attachments when omitted", async () => {
    const host = createHost({});

    const result = await editChatTurn(host, "session-1", "turn-original", {
      content: "edited prompt",
      mode: "code",
    });

    expect(host.prepareAgentChatTurn).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        content: "edited prompt",
        attachments: ["attachment-1"],
        mode: "code",
      }),
      expect.objectContaining({
        branchKind: "edit",
        sourceTurnId: "turn-original",
        parentTurnId: "turn-root",
      }),
    );
    expect(dispatchMocks.consumePreparedAgentChatTurn).toHaveBeenLastCalledWith(
      host,
      "session-1",
      expect.objectContaining({ content: "edited prompt" }),
      expect.objectContaining({ turnId: expect.any(String), turnAdmission: expect.any(Object) }),
      "chat_thread_turn_edited",
    );
    expect(result.assistantMessage?.content).toBe("dispatched:chat_thread_turn_edited");
  });

  it("routes non-stream send, retry, and edit turns through integration dispatch when bound off LLM", async () => {
    const host = createHost({});
    host.storage.chatSessionBindings.get = vi.fn(() => ({
      sessionId: "session-1",
      workspaceId: "default",
      transport: "discord",
      writable: true,
    })) as never;

    const sent = await agentSendChatMessage(host, "session-1", { content: "hello", mode: "chat" });
    const retried = await retryChatTurn(host, "session-1", "turn-original", { mode: "chat" });
    const edited = await editChatTurn(host, "session-1", "turn-original", { content: "edited prompt" });

    expect(sent.transport).toBe("discord");
    expect(retried.transport).toBe("discord");
    expect(edited.transport).toBe("discord");
    expect(dispatchMocks.sendPreparedIntegrationChatTurn).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.objectContaining({ content: "hello", mode: "chat" }),
      expect.objectContaining({ turnId: expect.any(String), turnAdmission: expect.any(Object) }),
      expect.objectContaining({ transport: "discord" }),
      "chat_thread_turn_appended",
      expect.objectContaining({ abortSignal: undefined }),
    );
    expect(dispatchMocks.sendPreparedIntegrationChatTurn).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.objectContaining({ mode: "chat" }),
      expect.objectContaining({ turnId: expect.any(String), turnAdmission: expect.any(Object) }),
      expect.objectContaining({ transport: "discord" }),
      "chat_thread_turn_retried",
    );
    expect(dispatchMocks.sendPreparedIntegrationChatTurn).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.objectContaining({ content: "edited prompt" }),
      expect.objectContaining({ turnId: expect.any(String), turnAdmission: expect.any(Object) }),
      expect.objectContaining({ transport: "discord" }),
      "chat_thread_turn_edited",
    );
    expect(dispatchMocks.consumePreparedAgentChatTurn).not.toHaveBeenCalled();
  });

  it("streams send turns through the integration envelope when the session binding is non-LLM", async () => {
    const host = createHost({});
    host.storage.chatSessionBindings.get = vi.fn(() => ({
      sessionId: "session-1",
      workspaceId: "default",
      transport: "slack",
      writable: true,
    })) as never;

    const chunks = await collectChunks(agentSendChatMessageStream(host, "session-1", { content: "hello" }));

    expect(host.withChatTurnWriteLeaseStream).toHaveBeenCalledWith("session-1", "agent-send/stream", expect.anything());
    expect(dispatchMocks.streamPreparedIntegrationChatTurn).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.objectContaining({ content: "hello" }),
      expect.objectContaining({ turnId: expect.any(String), turnAdmission: expect.any(Object) }),
      expect.objectContaining({ transport: "slack" }),
      "chat_thread_turn_appended",
    );
    expect(chunks.at(-1)).toEqual(expect.objectContaining({ type: "done", turnId: expect.any(String) }));
  });

  it("keeps durable streamed send runs alive when the SSE abort signal fires", async () => {
    const host = createHost({});
    const controller = new AbortController();
    let resolveStreamReady: (() => void) | undefined;
    const streamReady = new Promise<void>((resolve) => {
      resolveStreamReady = resolve;
    });

    dispatchMocks.launchPreparedAgentChatTurnStream.mockReturnValueOnce("durable-run-1");
    host.streamPersistedChatTurnEvents = vi.fn(async function* (
      _sessionId,
      turnId,
      options?: { signal?: AbortSignal },
    ) {
      resolveStreamReady?.();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) {
          resolve();
          return;
        }
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "done", sessionId: "session-1", turnId };
    }) as never;

    const pending = collectChunks(
      agentSendChatMessageStream(host, "session-1", { content: "hello" }, { abortSignal: controller.signal }),
    );

    await streamReady;
    controller.abort();
    const chunks = await pending;

    expect(host.cancelDurableChatRun).not.toHaveBeenCalled();
    expect(host.getActiveChatTurnExecution("turn-1")?.controller.signal.aborted).toBe(false);
    expect(host.streamPersistedChatTurnEvents).toHaveBeenCalledWith("session-1", expect.any(String), {
      liveTail: true,
      signal: controller.signal,
    });
    expect(chunks.at(-1)).toEqual(expect.objectContaining({ type: "done", turnId: expect.any(String) }));
  });

  it("still aborts non-durable streamed send execution when the SSE abort signal fires", async () => {
    const host = createHost({});
    const controller = new AbortController();
    let resolveStreamReady: (() => void) | undefined;
    const streamReady = new Promise<void>((resolve) => {
      resolveStreamReady = resolve;
    });

    dispatchMocks.launchPreparedAgentChatTurnStream.mockReturnValueOnce(undefined);
    host.streamPersistedChatTurnEvents = vi.fn(async function* (
      _sessionId,
      turnId,
      options?: { signal?: AbortSignal },
    ) {
      resolveStreamReady?.();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) {
          resolve();
          return;
        }
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "done", sessionId: "session-1", turnId };
    }) as never;

    const pending = collectChunks(
      agentSendChatMessageStream(host, "session-1", { content: "hello" }, { abortSignal: controller.signal }),
    );

    await streamReady;
    expect(host.getActiveChatTurnExecution("turn-1")?.controller.signal.aborted).toBe(false);
    controller.abort();
    const chunks = await pending;

    expect(host.cancelDurableChatRun).not.toHaveBeenCalled();
    expect(host.getActiveChatTurnExecution("turn-1")?.controller.signal.aborted).toBe(true);
    expect(chunks.at(-1)).toEqual(expect.objectContaining({ type: "done", turnId: expect.any(String) }));
  });

  it("streams retry and edit turns through integration envelopes when bound off LLM", async () => {
    const host = createHost({});
    host.storage.chatSessionBindings.get = vi.fn(() => ({
      sessionId: "session-1",
      workspaceId: "default",
      transport: "slack",
      writable: true,
    })) as never;

    const retryChunks = await collectChunks(retryChatTurnStream(host, "session-1", "turn-original", { mode: "chat" }));
    const editChunks = await collectChunks(editChatTurnStream(host, "session-1", "turn-original", { content: "edit" }));

    expect(dispatchMocks.streamPreparedIntegrationChatTurn).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.objectContaining({ mode: "chat" }),
      expect.objectContaining({ turnId: expect.any(String), turnAdmission: expect.any(Object) }),
      expect.objectContaining({ transport: "slack" }),
      "chat_thread_turn_retried",
    );
    expect(dispatchMocks.streamPreparedIntegrationChatTurn).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.objectContaining({ content: "edit" }),
      expect.objectContaining({ turnId: expect.any(String), turnAdmission: expect.any(Object) }),
      expect.objectContaining({ transport: "slack" }),
      "chat_thread_turn_edited",
    );
    expect(dispatchMocks.launchPreparedAgentChatTurnStream).not.toHaveBeenCalled();
    expect(retryChunks.at(-1)).toEqual(expect.objectContaining({ type: "done", turnId: expect.any(String) }));
    expect(editChunks.at(-1)).toEqual(expect.objectContaining({ type: "done", turnId: expect.any(String) }));
  });

  it("streams retry and edit turns through persisted turn events after launching prepared execution", async () => {
    const host = createHost({});

    const retryChunks = await collectChunks(
      retryChatTurnStream(host, "session-1", "turn-original", {
        mode: "chat",
        contextRefs: [{ kind: "memory_item", ref: "memory-retry" }],
      }),
    );
    const editChunks = await collectChunks(editChatTurnStream(host, "session-1", "turn-original", { content: "edit" }));

    expect(host.prepareAgentChatTurn).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        content: "original prompt",
        contextRefs: [{ kind: "memory_item", ref: "memory-retry" }],
      }),
      expect.objectContaining({ branchKind: "retry", sourceTurnId: "turn-original", ingestUserMessage: false }),
    );

    expect(dispatchMocks.launchPreparedAgentChatTurnStream).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.objectContaining({
        content: "original prompt",
        contextRefs: [{ kind: "memory_item", ref: "memory-retry" }],
      }),
      expect.objectContaining({ turnId: expect.any(String), turnAdmission: expect.any(Object) }),
      "chat_thread_turn_retried",
    );
    expect(dispatchMocks.launchPreparedAgentChatTurnStream).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.objectContaining({ content: "edit" }),
      expect.objectContaining({ turnId: expect.any(String), turnAdmission: expect.any(Object) }),
      "chat_thread_turn_edited",
    );
    expect(host.streamPersistedChatTurnEvents).toHaveBeenCalledWith("session-1", expect.any(String), {
      liveTail: true,
    });
    expect(retryChunks.map((chunk) => chunk.type)).toEqual(["trace_update", "done"]);
    expect(editChunks.map((chunk) => chunk.type)).toEqual(["trace_update", "done"]);
  });

  it("propagates streamed mutation lifecycle ownership through preparation and dispatch", async () => {
    const host = createHost({});
    const mutationLifecycle = { markCommitted: vi.fn() };

    await collectChunks(agentSendChatMessageStream(host, "session-1", { content: "hello" }, { mutationLifecycle }));
    await collectChunks(
      retryChatTurnStream(host, "session-1", "turn-original", { mode: "chat" }, { mutationLifecycle }),
    );
    await collectChunks(
      editChatTurnStream(host, "session-1", "turn-original", { content: "edit" }, { mutationLifecycle }),
    );

    expect(host.prepareAgentChatTurn).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ content: "hello" }),
      expect.objectContaining({ branchKind: "append", mutationLifecycle }),
    );
    expect(host.prepareAgentChatTurn).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ content: "original prompt" }),
      expect.objectContaining({ branchKind: "retry", ingestUserMessage: false, mutationLifecycle }),
    );
    expect(host.prepareAgentChatTurn).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ content: "edit" }),
      expect.objectContaining({ branchKind: "edit", mutationLifecycle }),
    );
    expect(dispatchMocks.launchPreparedAgentChatTurnStream).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.any(Object),
      expect.any(Object),
      "chat_thread_turn_appended",
      undefined,
      { mutationLifecycle },
    );
    expect(dispatchMocks.launchPreparedAgentChatTurnStream).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.any(Object),
      expect.any(Object),
      "chat_thread_turn_retried",
      undefined,
      { mutationLifecycle },
    );
    expect(dispatchMocks.launchPreparedAgentChatTurnStream).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.any(Object),
      expect.any(Object),
      "chat_thread_turn_edited",
      undefined,
      { mutationLifecycle },
    );
  });

  it("cancels active turns, rejects cross-session cancellation, and resumes persisted streams", async () => {
    const host = createHost({});
    host.storage.chatTurnTraces.get = vi.fn(() => createTrace({ durable: { runId: "durable-run-1" } })) as never;
    host.getActiveChatTurnStream = vi.fn(() => ({
      registrationId: "stream-registration-1",
      sessionId: "session-1",
      turnId: "turn-1",
      runId: "durable-run-1",
    })) as never;

    const cancelled = await cancelChatTurn(host, "session-1", "turn-1", "operator");
    const resumed = await collectChunks(resumeAgentChatTurnStream(host, "session-1", "turn-1", "event-4"));

    expect(cancelled).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-1",
        cancelled: true,
      }),
    );
    expect(host.markChatTurnCancelled).toHaveBeenCalledWith("session-1", "turn-1", "operator");
    expect(host.cancelDurableChatRun).toHaveBeenCalledWith("durable-run-1", "operator");
    expect(host.persistChatStreamChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "trace_update",
        sessionId: "session-1",
        turnId: "turn-1",
        trace: expect.objectContaining({ status: "cancelled" }),
      }),
      "durable-run-1",
      expect.objectContaining({ registrationId: "stream-registration-1" }),
    );
    expect(host.completeActiveChatTurnStream).toHaveBeenCalledWith("turn-1", "stream-registration-1");
    expect(host.streamPersistedChatTurnEvents).toHaveBeenCalledWith("session-1", "turn-1", {
      sinceEventId: "event-4",
      liveTail: true,
    });
    expect(resumed.at(-1)).toEqual(expect.objectContaining({ type: "done", turnId: "turn-1" }));

    host.storage.chatTurnTraces.get = vi.fn(() => createTrace({ sessionId: "other-session" })) as never;
    await expect(cancelChatTurn(host, "session-1", "turn-1")).rejects.toThrow(/does not belong/);
    await expect(collectChunks(resumeAgentChatTurnStream(host, "session-1", "turn-1"))).rejects.toThrow(
      /does not belong/,
    );
  });

  it("cancels a just-launched durable stream before its trace row is visible", async () => {
    const host = createHost({});
    host.storage.chatTurnTraces.get = vi.fn(() => {
      throw new NotFoundError({ entity: "Chat turn", id: "turn-1" });
    }) as never;
    host.getActiveChatTurnStream = vi.fn(() => ({
      registrationId: "stream-registration-fast",
      sessionId: "session-1",
      turnId: "turn-1",
      runId: "durable-run-fast",
    })) as never;

    const cancelled = await cancelChatTurn(host, "session-1", "turn-1", "operator");

    expect(cancelled).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-1",
        cancelled: true,
      }),
    );
    expect(host.cancelDurableChatRun).toHaveBeenCalledWith("durable-run-fast", "operator");
    expect(host.markChatTurnCancelled).toHaveBeenCalledWith("session-1", "turn-1", "operator");
    expect(host.completeActiveChatTurnStream).toHaveBeenCalledWith("turn-1", "stream-registration-fast");
  });

  it("does not cancel Chat truth when durable approval materialization wins the terminal CAS", async () => {
    const host = createHost({});
    const runningTrace = createTrace({
      status: "waiting_for_approval",
      durable: { runId: "durable-run-race", status: "running" },
    });
    const completedTrace = createTrace({
      status: "completed",
      assistantMessageId: "assistant-approved-turn-1",
      durable: { runId: "durable-run-race", status: "completed" },
      finishedAt: "2026-05-14T00:00:02.000Z",
    });
    host.storage.chatTurnTraces.get = vi
      .fn()
      .mockReturnValueOnce(runningTrace)
      .mockReturnValue(completedTrace) as never;
    host.cancelDurableChatRun = vi.fn(() => ({
      runId: "durable-run-race",
      workflowKey: "chat.turn.execute",
      status: "completed",
      attemptCount: 1,
      maxAttempts: 3,
      version: 5,
      payload: {},
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:02.000Z",
      finishedAt: "2026-05-14T00:00:02.000Z",
    }));

    await expect(cancelChatTurn(host, "session-1", "turn-1", "operator")).resolves.toEqual(
      expect.objectContaining({
        cancelled: false,
        trace: completedTrace,
      }),
    );

    expect(host.cancelDurableChatRun).toHaveBeenCalledWith("durable-run-race", "operator");
    expect(host.markChatTurnCancelled).not.toHaveBeenCalled();
  });

  it("leaves an active stream open while a durable completion winner is still projecting Chat truth", async () => {
    const host = createHost({});
    const waitingTrace = createTrace({
      status: "waiting_for_approval",
      durable: { runId: "durable-run-projecting", status: "running" },
    });
    host.storage.chatTurnTraces.get = vi.fn(() => waitingTrace) as never;
    host.getActiveChatTurnStream = vi.fn(() => ({
      registrationId: "stream-registration-projecting",
      sessionId: "session-1",
      turnId: "turn-1",
      runId: "durable-run-projecting",
    })) as never;
    host.cancelDurableChatRun = vi.fn(() => ({
      runId: "durable-run-projecting",
      workflowKey: "chat.turn.execute",
      status: "completed",
      attemptCount: 1,
      maxAttempts: 3,
      version: 5,
      payload: {},
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:02.000Z",
      finishedAt: "2026-05-14T00:00:02.000Z",
    }));

    await expect(cancelChatTurn(host, "session-1", "turn-1", "operator")).resolves.toEqual(
      expect.objectContaining({
        cancelled: false,
        trace: waitingTrace,
      }),
    );

    expect(host.markChatTurnCancelled).not.toHaveBeenCalled();
    expect(host.persistChatStreamChunk).not.toHaveBeenCalled();
    expect(host.completeActiveChatTurnStream).not.toHaveBeenCalled();
    expect(host.closeActiveChatTurnStream).not.toHaveBeenCalled();
  });

  it("keeps terminal cancellation idempotent while a completed stream registration is retained", async () => {
    const host = createHost({});
    const terminalTrace = createTrace({
      status: "completed",
      assistantMessageId: "assistant-1",
      durable: { runId: "durable-run-terminal", status: "completed" },
      finishedAt: "2026-05-14T00:00:02.000Z",
    });
    host.storage.chatTurnTraces.get = vi.fn(() => terminalTrace) as never;
    host.markChatTurnCancelled = vi.fn(() => terminalTrace);
    host.getActiveChatTurnStream = vi.fn(() => ({
      registrationId: "stream-registration-completed",
      sessionId: "session-1",
      turnId: "turn-1",
      runId: "durable-run-terminal",
      completed: true,
    })) as never;
    host.persistChatStreamChunk = vi.fn((_chunk, _durableRunId, registrationId) => {
      if (registrationId !== undefined) {
        throw new ChatTurnStreamRegistrationMismatchError("turn-1", registrationId);
      }
      return {} as never;
    }) as never;

    await expect(cancelChatTurn(host, "session-1", "turn-1", "operator")).resolves.toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-1",
        cancelled: false,
        trace: terminalTrace,
      }),
    );

    expect(host.persistChatStreamChunk).toHaveBeenCalledTimes(2);
    expect(host.persistChatStreamChunk).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "trace_update", trace: terminalTrace }),
      "durable-run-terminal",
      undefined,
    );
    expect(host.persistChatStreamChunk).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "done", messageId: "assistant-1" }),
      "durable-run-terminal",
      undefined,
    );
    expect(host.completeActiveChatTurnStream).not.toHaveBeenCalled();
    expect(host.closeActiveChatTurnStream).not.toHaveBeenCalled();
  });

  it("preflights chat routes through the live route resolver and validates retry context", async () => {
    const host = createHost({});
    host.llmService.getRuntimeConfig = vi.fn(() => ({
      activeProviderId: "openai",
      activeModel: "gpt-5.4",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          resolvedApiStyle: "openai-responses",
          defaultModel: "gpt-5.4",
          authMode: "api-key",
          hasApiKey: true,
          apiKeySource: "inline",
          hasKeychainSecret: false,
          capabilities: {},
        },
      ],
    })) as never;

    const result = await routePreflight(host, "session-1", {
      action: "retry",
      turnId: "turn-original",
      providerId: "openai",
      model: "gpt-5.4",
      mode: "chat",
    });

    expect(host.requireChatTurnContext).toHaveBeenCalledWith("session-1", "turn-original");
    expect(result).toEqual(
      expect.objectContaining({
        requestedProviderId: "openai",
        requestedModel: "gpt-5.4",
        effectiveProviderId: "openai",
        effectiveModel: "gpt-5.4",
        selectionSource: "manual",
        fallbackPolicy: "off",
        runtimeClass: "cloud",
      }),
    );
    expect(result.decision.fingerprint).toEqual(expect.any(String));
  });
});

describe("agentSendChatMessage external companion pipeline (HX-411)", () => {
  const externalCompanion = createExternalCompanionAdmissionContext({
    companionSessionId: "companion-session-1",
    deviceGrantId: "device-grant-1",
    clientInstanceId: "client-instance-1",
    tokenHashSha256: "b".repeat(64),
    expectedGeneration: 5,
  });

  it("runs a bound external send through the canonical LLM pipeline to one answer, fenced by the external admission", async () => {
    const host = createHost({
      assistantContent: "External controller answer.",
      assistantModel: "primary-model",
      turnTrace: createTrace({ status: "completed" }),
    });

    const response = await agentSendChatMessage(
      host,
      "session-1",
      { content: "hello", mode: "chat" },
      { externalCompanion },
    );

    // Canonical answer produced through the same pipeline as an operator turn.
    expect(response.assistantMessage?.content).toBe("External controller answer.");
    expect(host.ingestEvent).toHaveBeenCalledTimes(1);
    // Admitted as an external companion carrying its presented generation.
    const admitChatTurn = host.sessionControlRuntimeOwner.admitChatTurn as ReturnType<typeof vi.fn>;
    expect(admitChatTurn).toHaveBeenCalledTimes(1);
    expect(admitChatTurn.mock.calls[0][0].actor).toMatchObject({
      actorKind: "external_companion",
      companionSessionId: "companion-session-1",
      requiredCapability: "send",
      expectedGeneration: 5,
    });
    expect(host.sessionControlRuntimeOwner.admitOperatorChatTurn).not.toHaveBeenCalled();
    // The same late fence used for operator turns rechecks the external admission.
    const assertActiveTurnWrite = host.sessionControlRuntimeOwner.assertActiveTurnWrite as ReturnType<typeof vi.fn>;
    expect(assertActiveTurnWrite).toHaveBeenCalled();
    expect(assertActiveTurnWrite.mock.calls[0][0].requestActor.actorKind).toBe("external_companion");
    // Terminal closure is content-free and completed for a clean turn.
    expect(host.sessionControlRuntimeOwner.closeTurnWrite).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", actorId: "companion-session-1" }),
    );
  });

  it("blocks the external assistant result and never ingests content when the generation advances after preparation", async () => {
    const host = createHost({
      assistantContent: "Should never be committed.",
      assistantModel: "primary-model",
      turnTrace: createTrace({ status: "completed" }),
    });
    const authorityChanged = new ConflictError({
      message: "Mutation admission no longer matches the current session controller authority.",
    });
    let prepared = false;
    const prepareMock = host.prepareAgentChatTurn as ReturnType<typeof vi.fn>;
    const originalPrepareImpl = prepareMock.getMockImplementation();
    prepareMock.mockImplementation(async (...args: unknown[]) => {
      prepared = true;
      return originalPrepareImpl?.(...args);
    });
    // The controller generation advances during preparation: the next authority
    // recheck fences the turn before any authority-bearing result is written.
    (host.sessionControlRuntimeOwner.assertActiveTurnWrite as ReturnType<typeof vi.fn>).mockImplementation(() => {
      if (prepared) {
        throw authorityChanged;
      }
    });

    await expect(
      agentSendChatMessage(host, "session-1", { content: "hello", mode: "chat" }, { externalCompanion }),
    ).rejects.toBe(authorityChanged);

    // HX-305/HX-306 truth is preserved by the durable/agent-runner evidence sources
    // (proven at the storage layer); the fence only blocks the authority-bearing
    // assistant result and terminalizes the admission content-free.
    expect(host.ingestEvent).not.toHaveBeenCalled();
    expect(host.updateActiveLeafOrThrow).not.toHaveBeenCalled();
    expect(host.sessionControlRuntimeOwner.closeTurnWrite).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", actorId: "companion-session-1" }),
    );
  });
});

async function collectChunks(stream: AsyncGenerator<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const chunks: Array<Record<string, unknown>> = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}
