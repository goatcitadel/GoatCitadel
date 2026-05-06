import { describe, expect, it } from "vitest";
import type {
  ChatSendMessageRequest,
  ChatStreamChunkDraft,
  ChatTurnTraceRecord,
  DurableCheckpointRecord,
  DurableRunCreateRequest,
  DurableRunRecord,
  DurableRunTimelineEvent,
} from "@goatcitadel/contracts";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import {
  beginDurableChatRun,
  finalizeDurableChatRun,
  type ChatDurableRunFinalizeDeps,
} from "./chat-durable-run-service.js";

describe("chat-durable-run-service", () => {
  it("creates and schedules a durable chat run", () => {
    const prepared = createPreparedTurn();
    const input = createSendRequest();
    const streamChunks: Array<{ chunk: ChatStreamChunkDraft; durableRunId?: string }> = [];
    const requestedRunIds: string[] = [];
    const createInputs: DurableRunCreateRequest[] = [];
    const run = createRun("run-1", "queued");

    const created = beginDurableChatRun(
      {
        shouldUseDurableExecution: true,
        createDurableRun: (createInput) => {
          createInputs.push(createInput);
          return run;
        },
        buildDurablePayloadRecord: (_prepared, request, threadEventType) => ({
          requestContent: request.content,
          threadEventType,
        }),
        persistChatStreamChunk: (chunk, durableRunId) => streamChunks.push({ chunk, durableRunId }),
        requestDurableRunProcessing: (runId) => requestedRunIds.push(runId),
      },
      prepared,
      input,
      "chat_thread_turn_appended",
    );

    expect(created).toEqual(run);
    expect(createInputs).toEqual([
      expect.objectContaining({
        workflowKey: "chat.turn.execute",
        payload: {
          requestContent: input.content,
          threadEventType: "chat_thread_turn_appended",
        },
        metadata: {
          surface: "chat",
          autoPromoted: true,
          objective: prepared.content,
        },
      }),
    ]);
    expect(streamChunks).toEqual([
      {
        chunk: {
          type: "message_start",
          sessionId: "session-1",
          turnId: "turn-1",
          messageId: "assistant-1",
          parentTurnId: undefined,
          branchKind: "append",
          sourceTurnId: undefined,
        },
        durableRunId: "run-1",
      },
    ]);
    expect(requestedRunIds).toEqual(["run-1"]);
  });

  it("skips durable run creation when the flow stays synchronous", () => {
    const prepared = createPreparedTurn();
    const input = createSendRequest();
    let created = false;

    const run = beginDurableChatRun(
      {
        shouldUseDurableExecution: false,
        createDurableRun: () => {
          created = true;
          return createRun("run-unexpected", "queued");
        },
        buildDurablePayloadRecord: () => ({}),
        persistChatStreamChunk: () => undefined,
        requestDurableRunProcessing: () => undefined,
      },
      prepared,
      input,
      "chat_thread_turn_appended",
    );

    expect(run).toBeUndefined();
    expect(created).toBe(false);
  });

  it("marks waiting traces as durable waiting checkpoints", () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({
      status: "waiting_for_approval",
      failure: {
        failureClass: "approval_required",
        message: "Waiting for approval",
        retryable: true,
        recommendedAction: "approve_pending_step",
      },
    });
    const state = createFinalizeState();

    finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace);

    expect(state.runs.get("run-waiting")?.status).toBe("waiting");
    expect(state.runs.get("run-waiting")?.finishedAt).toBeUndefined();
    expect(state.checkpoints).toEqual([
      expect.objectContaining({
        runId: "run-waiting",
        checkpointKind: "run_waiting",
        state: expect.objectContaining({
          currentStep: "waiting_for_approval",
          blocker: "Waiting for approval",
          nextAction: "approve_pending_step",
        }),
      }),
    ]);
    expect(state.timelineEvents).toEqual([
      expect.objectContaining({
        runId: "run-waiting",
        eventType: "run_waiting",
      }),
    ]);
    expect(state.tracePatches).toEqual([
      {
        turnId: "turn-1",
        patch: {
          durable: {
            runId: "run-waiting",
            status: "waiting",
            checkpointKind: "run_waiting",
          },
        },
      },
    ]);
  });

  it("marks user-input waits as durable waiting checkpoints", () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({
      status: "waiting_for_user_input",
      failure: {
        failureClass: "needs_input",
        message: "Waiting for deployment target",
        retryable: true,
        recommendedAction: "answer_prompt",
      },
    });
    const state = createFinalizeState();

    finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace);

    expect(state.runs.get("run-waiting")?.status).toBe("waiting");
    expect(state.checkpoints).toEqual([
      expect.objectContaining({
        runId: "run-waiting",
        checkpointKind: "run_waiting",
        state: expect.objectContaining({
          currentStep: "waiting_for_user_input",
          blocker: "Waiting for deployment target",
          nextAction: "answer_prompt",
        }),
      }),
    ]);
  });

  it("marks cancelled traces as durable cancellation checkpoints", () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({
      status: "cancelled",
    });
    const state = createFinalizeState();

    finalizeDurableChatRun(state.deps, "run-cancelled", prepared, trace);

    expect(state.runs.get("run-cancelled")?.status).toBe("cancelled");
    expect(state.runs.get("run-cancelled")?.finishedAt).toBeDefined();
    expect(state.checkpoints).toEqual([
      expect.objectContaining({
        runId: "run-cancelled",
        checkpointKind: "run_cancelled",
        state: expect.objectContaining({
          currentStep: "cancelled",
        }),
      }),
    ]);
    expect(state.timelineEvents).toEqual([
      expect.objectContaining({
        runId: "run-cancelled",
        eventType: "run_cancelled",
      }),
    ]);
    expect(state.tracePatches).toEqual([
      {
        turnId: "turn-1",
        patch: {
          durable: {
            runId: "run-cancelled",
            status: "cancelled",
            checkpointKind: "run_cancelled",
          },
        },
      },
    ]);
  });

  it("records completed checkpoints with tool and artifact summaries", () => {
    const prepared = createPreparedTurn({ content: "Ship the patch" });
    const trace = createTrace({
      status: "completed",
      completion: {
        status: "complete",
        finishReason: "stop",
        repaired: false,
      },
    });
    const state = createFinalizeState({
      toolRuns: [
        {
          toolRunId: "tool-1",
          toolName: "browser.navigate",
          status: "completed",
          startedAt: "2026-04-10T00:00:01.000Z",
          finishedAt: "2026-04-10T00:00:02.000Z",
        },
      ],
      artifacts: [
        {
          artifactId: "artifact-1",
          toolRunId: "tool-1",
          toolName: "browser.navigate",
          contentType: "text/html",
          byteLength: 128,
          storageRelPath: "chat/artifact-1.html",
          snippet: "<html>",
        },
      ],
    });

    finalizeDurableChatRun(state.deps, "run-complete", prepared, trace);

    expect(state.runs.get("run-complete")?.status).toBe("completed");
    expect(state.runs.get("run-complete")?.lastError).toBeUndefined();
    expect(state.checkpoints).toEqual([
      expect.objectContaining({
        runId: "run-complete",
        checkpointKind: "run_completed",
        state: {
          objective: "Ship the patch",
          currentStep: "completed",
          attemptedTools: [
            {
              toolRunId: "tool-1",
              toolName: "browser.navigate",
              status: "completed",
              startedAt: "2026-04-10T00:00:01.000Z",
              finishedAt: "2026-04-10T00:00:02.000Z",
            },
          ],
          artifactPointers: [
            {
              artifactId: "artifact-1",
              toolRunId: "tool-1",
              toolName: "browser.navigate",
              contentType: "text/html",
              byteLength: 128,
              storageRelPath: "chat/artifact-1.html",
              snippet: "<html>",
            },
          ],
          blocker: undefined,
          nextAction: undefined,
        },
      }),
    ]);
    expect(state.timelineEvents).toEqual([
      expect.objectContaining({
        runId: "run-complete",
        eventType: "run_completed",
      }),
    ]);
    expect(state.tracePatches).toEqual([
      {
        turnId: "turn-1",
        patch: {
          durable: {
            runId: "run-complete",
            status: "completed",
            checkpointKind: "run_completed",
          },
        },
      },
    ]);
  });

  it("records completed checkpoints when older traces do not include completion metadata", () => {
    const prepared = createPreparedTurn({ content: "Run the agentic smoke" });
    const trace = createTrace({
      status: "completed",
      completion: undefined,
    });
    const state = createFinalizeState();

    finalizeDurableChatRun(state.deps, "run-complete", prepared, trace);

    expect(state.runs.get("run-complete")?.status).toBe("completed");
    expect(state.checkpoints).toEqual([
      expect.objectContaining({
        runId: "run-complete",
        checkpointKind: "run_completed",
        state: expect.objectContaining({
          currentStep: "completed",
        }),
      }),
    ]);
    expect(state.tracePatches).toEqual([
      {
        turnId: "turn-1",
        patch: {
          durable: {
            runId: "run-complete",
            status: "completed",
            checkpointKind: "run_completed",
          },
        },
      },
    ]);
  });

  it("records failed checkpoints when completion metadata is explicitly incomplete", () => {
    const prepared = createPreparedTurn({ content: "Run the agentic smoke" });
    const trace = createTrace({
      status: "completed",
      completion: {
        status: "incomplete",
        finishReason: "length",
        repaired: false,
      },
    });
    const state = createFinalizeState();

    finalizeDurableChatRun(state.deps, "run-complete", prepared, trace);

    expect(state.runs.get("run-complete")?.status).toBe("failed");
    expect(state.checkpoints).toEqual([
      expect.objectContaining({
        runId: "run-complete",
        checkpointKind: "run_failed",
        state: expect.objectContaining({
          currentStep: "completed",
        }),
      }),
    ]);
  });
});

function createPreparedTurn(overrides: Partial<PreparedAgentChatTurn> = {}): PreparedAgentChatTurn {
  return {
    session: { sessionId: "session-1" },
    route: { channel: "chat", account: "operator" },
    workspaceId: "default",
    content: "Research this repo",
    userEventId: "user-1",
    userMessage: {
      messageId: "user-1",
      sessionId: "session-1",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "Research this repo",
      timestamp: "2026-04-10T00:00:00.000Z",
    },
    prefs: {
      mode: "chat",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      toolAutonomy: "manual",
      reflectionMode: "off",
      provider: "openai",
      model: "gpt-5.4",
    },
    autonomy: {
      proactiveMode: "off",
      maxActionsPerHour: 0,
      maxActionsPerTurn: 0,
      cooldownSeconds: 0,
      retrievalMode: "off",
      reflectionMode: "off",
    },
    normalized: {
      mode: "chat",
      webMode: "auto",
    },
    retrievalTrace: {
      l0Used: false,
      l1Used: false,
      l2Used: false,
    },
    resolvedGuidance: {
      workspaceId: "default",
      files: [],
      truncated: false,
    },
    conversationMessages: [],
    history: [],
    turnId: "turn-1",
    assistantMessageId: "assistant-1",
    branchKind: "append",
    effectiveToolAutonomy: "manual",
    ...overrides,
  } as PreparedAgentChatTurn;
}

function createTrace(overrides: Partial<ChatTurnTraceRecord> = {}): ChatTurnTraceRecord {
  return {
    turnId: "turn-1",
    sessionId: "session-1",
    userMessageId: "user-1",
    branchKind: "append",
    status: "completed",
    mode: "chat",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    startedAt: "2026-04-10T00:00:00.000Z",
    toolRuns: [],
    citations: [],
    routing: {},
    completion: {
      status: "complete",
      finishReason: "stop",
      repaired: false,
    },
    ...overrides,
  };
}

function createSendRequest(overrides: Partial<ChatSendMessageRequest> = {}): ChatSendMessageRequest {
  return {
    content: "Research this repo",
    ...overrides,
  } as ChatSendMessageRequest;
}

function createRun(
  runId: string,
  status: DurableRunRecord["status"],
  workflowKey: DurableRunRecord["workflowKey"] = "chat.turn.execute",
): DurableRunRecord {
  return {
    runId,
    workflowKey,
    status,
    attemptCount: 0,
    maxAttempts: 3,
    version: 1,
    payload: {},
    metadata: {},
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    startedAt: "2026-04-10T00:00:00.000Z",
  };
}

function createFinalizeState(options?: {
  toolRuns?: Array<{
    toolRunId: string;
    toolName: string;
    status: string;
    startedAt?: string;
    finishedAt?: string;
  }>;
  artifacts?: Array<{
    artifactId: string;
    toolRunId?: string;
    toolName?: string;
    contentType: string;
    byteLength?: number;
    storageRelPath?: string;
    snippet?: string;
  }>;
}) {
  const runs = new Map<string, DurableRunRecord>([
    ["run-waiting", createRun("run-waiting", "running")],
    [
      "run-complete",
      {
        ...createRun("run-complete", "running"),
        lastError: "stale failure",
      },
    ],
    ["run-cancelled", createRun("run-cancelled", "running")],
  ]);
  const checkpoints: DurableCheckpointRecord[] = [];
  const timelineEvents: Array<{
    runId: string;
    eventType: DurableRunTimelineEvent["eventType"];
    payload?: Record<string, unknown>;
  }> = [];
  const tracePatches: Array<{ turnId: string; patch: Record<string, unknown> }> = [];
  const deps: ChatDurableRunFinalizeDeps = {
    durableRuns: {
      updateRun: (input) => updateRun(runs, input.runId, input),
      createCheckpoint: (input) => {
        const record: DurableCheckpointRecord = {
          checkpointId: `checkpoint-${checkpoints.length + 1}`,
          runId: input.runId,
          checkpointKind: input.checkpointKind,
          state: input.state,
          createdAt: input.createdAt ?? "2026-04-10T00:00:00.000Z",
        };
        checkpoints.push(record);
        return record;
      },
    },
    chatToolRuns: {
      listByTurn: () => options?.toolRuns ?? [],
    },
    chatToolArtifacts: {
      listByTurn: () => options?.artifacts ?? [],
    },
    recordDurableTimelineEvent: (runId, eventType, payload) => {
      timelineEvents.push({ runId, eventType, payload });
    },
    patchDurableTraceIfPresent: (turnId, patch) => {
      tracePatches.push({ turnId, patch: patch as Record<string, unknown> });
    },
  };
  return { deps, runs, checkpoints, timelineEvents, tracePatches };
}

function updateRun(
  runs: Map<string, DurableRunRecord>,
  runId: string,
  patch: {
    status?: DurableRunRecord["status"];
    updatedAt?: string;
    finishedAt?: string;
    clearFinishedAt?: boolean;
    lastError?: string;
    clearLastError?: boolean;
    clearLease?: boolean;
  },
): DurableRunRecord {
  const current = runs.get(runId);
  if (!current) {
    throw new Error(`Unknown run ${runId}`);
  }
  const next: DurableRunRecord = {
    ...current,
    version: (current.version ?? 1) + 1,
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
    ...(patch.clearFinishedAt
      ? { finishedAt: undefined }
      : patch.finishedAt !== undefined
        ? { finishedAt: patch.finishedAt }
        : {}),
    ...(patch.clearLastError
      ? { lastError: undefined }
      : patch.lastError !== undefined
        ? { lastError: patch.lastError }
        : {}),
    ...(patch.clearLease ? { leaseOwnerId: undefined, leaseExpiresAt: undefined, leaseHeartbeatAt: undefined } : {}),
  };
  runs.set(runId, next);
  return next;
}
