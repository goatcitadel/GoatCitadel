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

  it("streams orchestration progress and final synthesized deltas before message_done", async () => {
    const host = createHost();
    host.resolvePreparedTurnOrchestration = vi.fn(async () => createModeOrchestrationResolution()) as never;
    host.createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [{ index: 0, message: { content: "Planner output" }, finish_reason: "stop" }],
      })
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: { content: "## Dinner Party Plan\n\nFinal host-ready checklist." },
            finish_reason: "stop",
          },
        ],
      }) as never;

    const chunks = [];
    for await (const chunk of streamPreparedAgentChatTurn(
      host,
      "session-1",
      { content: "plan dinner", mode: "cowork" } as never,
      createPreparedTurn({ mode: "cowork" }),
      "chat_thread_turn_appended",
      createModeOrchestrationResolution(),
    )) {
      chunks.push(chunk);
    }

    const messageDoneIndex = chunks.findIndex((chunk) => chunk.type === "message_done");
    const progressTraceIndex = chunks.findIndex(
      (chunk) => chunk.type === "trace_update" && Boolean(chunk.trace.orchestration?.steps.length),
    );
    const deltaIndex = chunks.findIndex((chunk) => chunk.type === "delta");

    expect(progressTraceIndex).toBeGreaterThan(0);
    expect(progressTraceIndex).toBeLessThan(messageDoneIndex);
    expect(deltaIndex).toBeGreaterThan(progressTraceIndex);
    expect(deltaIndex).toBeLessThan(messageDoneIndex);
    expect(chunks[deltaIndex]).toEqual(
      expect.objectContaining({
        type: "delta",
        delta: "## Dinner Party Plan\n\nFinal host-ready checklist.",
      }),
    );
    expect(chunks[messageDoneIndex]).toEqual(
      expect.objectContaining({
        type: "message_done",
        content: "## Dinner Party Plan\n\nFinal host-ready checklist.",
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
        create: vi.fn((input) => ({
          ...input,
          status: input.status ?? "pending",
          startedAt: input.startedAt ?? "2026-04-18T00:00:00.000Z",
        })),
        patch: vi.fn((stepId, input) => ({
          stepId,
          runId: "run-1",
          role: "synthesizer",
          index: 1,
          startedAt: "2026-04-18T00:00:00.000Z",
          ...input,
        })),
        listByRun: vi.fn(() => []),
      },
      chatToolRuns: {
        listByTurn: vi.fn(() => []),
        listByTurnIds: vi.fn(() => new Map()),
      },
      chatExecutionPlans: {
        create: vi.fn((input) => ({
          planId: "plan-1",
          ...input,
          steps: input.steps ?? [],
        })),
        patch: vi.fn(),
        get: vi.fn(() => ({ planId: "plan-1", steps: [] })),
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
    buildChatOrchestrationSummary: vi.fn((input) => ({
      runId: input.runId,
      objective: input.objective,
      workflowTemplate: input.routeDecision.workflowTemplate,
      status: input.finalized ? "completed" : "running",
      modePolicy: input.modePolicy,
      visibility: input.routeDecision.visibility,
      finalSummary: input.finalSummary,
      integritySignals: input.integritySignals,
      routeDecision: input.routeDecision,
      steps: input.stepResults.map((step: any) => ({
        stepId: step.stepId,
        role: step.role,
        label: step.label,
        index: step.index,
        status: step.status,
        providerId: step.providerId,
        model: step.model,
        startedAt: step.startedAt,
        finishedAt: step.finishedAt,
        durationMs: step.durationMs,
        summary: step.summary,
        error: step.error,
      })),
    })),
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

function createPreparedTurn(overrides: { mode?: "chat" | "cowork" | "code" } = {}) {
  const mode = overrides.mode ?? "chat";
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
      mode,
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
    },
    prefs: {
      mode,
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

function createModeOrchestrationResolution() {
  const routeDecision = {
    modePolicy: "cowork",
    workflowTemplate: "cowork.plan.work.synthesize",
    hidden: false,
    visibility: "explicit",
    intensity: "balanced",
    providerPreference: "balanced",
    reviewDepth: "standard",
    parallelism: "sequential",
    selectedRoles: ["Planner", "Synthesis"],
    selectedProviders: [],
    triggerReason: "test",
  };
  const steps = [
    {
      stepId: "orch-step-1",
      index: 0,
      role: "planner",
      stage: 0,
      objective: "Plan the dinner party.",
      parallelizable: false,
      providerId: "openai",
      model: "gpt-5.4",
    },
    {
      stepId: "orch-step-2",
      index: 1,
      role: "synthesizer",
      label: "Synthesis",
      stage: 1,
      objective: "Synthesize the final answer.",
      parallelizable: false,
      dependsOnStepIds: ["orch-step-1"],
      providerId: "openai",
      model: "gpt-5.4",
    },
  ];
  return {
    routerInput: {
      task: {
        sessionId: "session-1",
        workspaceId: "default",
        mode: "cowork",
        objective: "plan dinner",
        prefs: {
          mode: "cowork",
          providerId: "openai",
          model: "gpt-5.4",
          webMode: "off",
          memoryMode: "off",
          thinkingLevel: "standard",
        },
        conversation: [],
        historyMessages: [],
      },
      runtime: {},
      capabilities: [],
      policy: {},
    },
    orchestrationPlan: {
      workflowTemplate: "cowork.plan.work.synthesize",
      routeDecision,
      summary: "Dinner planning workflow.",
      source: "workflow_template",
      steps,
    },
    executionPlanDraft: {
      source: "workflow_template",
      advisoryOnly: false,
      objective: "plan dinner",
      summary: "Dinner planning workflow.",
      steps: steps.map((step) => ({
        stepId: step.stepId,
        index: step.index,
        objective: step.objective,
        parallelizable: step.parallelizable,
        dependsOnStepIds: step.dependsOnStepIds,
        status: "pending",
      })),
    },
  } as never;
}
