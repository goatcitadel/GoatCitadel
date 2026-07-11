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

  it("marks tool waits as durable waiting checkpoints", () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({
      status: "waiting_for_tool",
      failure: {
        failureClass: "tool_wait",
        message: "Waiting for browser.search to finish",
        retryable: true,
        recommendedAction: "resume_tool_wait",
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
          currentStep: "waiting_for_tool",
          blocker: "Waiting for browser.search to finish",
          nextAction: "resume_tool_wait",
        }),
      }),
    ]);
  });

  it("parks approval waits with an approval.resolved waitForEvent keyed to the pending approval", () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({
      status: "waiting_for_approval",
      toolRuns: [
        {
          toolRunId: "tool-run-1",
          turnId: "turn-1",
          toolName: "shell.exec",
          status: "approval_required",
          approvalId: "approval-xyz",
          startedAt: "2026-04-10T00:00:01.000Z",
        },
      ],
      failure: {
        failureClass: "approval_required",
        message: "Waiting for approval",
        retryable: true,
        recommendedAction: "approve_pending_step",
      },
    });
    const state = createFinalizeState();
    // Seed pre-existing run metadata to prove finalize preserves it (the repo
    // REPLACES metadata on updateRun, so the waiting branch must spread it).
    state.runs.set("run-waiting", {
      ...createRun("run-waiting", "running"),
      metadata: { surface: "chat", objective: "Research this repo", retryPolicy: { maxAttempts: 3 } },
    });

    finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace);

    expect(state.runs.get("run-waiting")?.metadata).toMatchObject({
      surface: "chat",
      objective: "Research this repo",
      retryPolicy: { maxAttempts: 3 },
      waitForEvent: {
        eventKey: "approval.resolved",
        correlationId: "approval-xyz",
      },
    });
  });

  it("parks user-input waits with a chat.user_input.resolved waitForEvent keyed to the pending prompt", () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({
      status: "waiting_for_user_input",
      pendingUserInput: {
        promptId: "prompt-abc",
        turnId: "turn-1",
        kind: "text",
        title: "Deployment target",
        question: "Which environment should I deploy to?",
      },
      failure: {
        failureClass: "needs_input",
        message: "Waiting for deployment target",
        retryable: true,
        recommendedAction: "answer_prompt",
      },
    });
    const state = createFinalizeState();

    finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace);

    expect(state.runs.get("run-waiting")?.metadata).toMatchObject({
      waitForEvent: {
        eventKey: "chat.user_input.resolved",
        correlationId: "prompt-abc",
      },
    });
  });

  it("parks tool waits with an eventKey-only waitForEvent (no known wake correlation)", () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({
      status: "waiting_for_tool",
      failure: {
        failureClass: "tool_wait",
        message: "Waiting for browser.search to finish",
        retryable: true,
        recommendedAction: "resume_tool_wait",
      },
    });
    const state = createFinalizeState();

    finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace);

    const waitForEvent = (state.runs.get("run-waiting")?.metadata as { waitForEvent?: Record<string, unknown> })
      ?.waitForEvent;
    expect(waitForEvent).toEqual({ eventKey: "chat.tool_wait.resolved" });
    expect(waitForEvent).not.toHaveProperty("correlationId");
  });

  it("falls back to a runId-scoped waitForEvent when an approval wait lacks a resolvable approvalId", () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({
      status: "waiting_for_approval",
      // No approval_required toolRun and no pendingApprovalSummary: the approvalId
      // cannot be resolved, so we must NOT emit a correlationId that could reject a
      // legit wake — fall back to eventKey-only.
      toolRuns: [],
      failure: {
        failureClass: "approval_required",
        message: "Waiting for approval",
        retryable: true,
      },
    });
    const state = createFinalizeState();

    finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace);

    const waitForEvent = (state.runs.get("run-waiting")?.metadata as { waitForEvent?: Record<string, unknown> })
      ?.waitForEvent;
    expect(waitForEvent).toEqual({ eventKey: "approval.resolved" });
    expect(waitForEvent).not.toHaveProperty("correlationId");
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

  it("does not duplicate durable cancellation checkpoints after an operator cancel already settled the run", () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({
      status: "cancelled",
    });
    const state = createFinalizeState();
    state.runs.set("run-cancelled", {
      ...createRun("run-cancelled", "cancelled"),
      lastError: "cancelled by tester",
      finishedAt: "2026-04-10T00:00:00.000Z",
    });

    finalizeDurableChatRun(state.deps, "run-cancelled", prepared, trace);

    expect(state.runs.get("run-cancelled")).toMatchObject({
      status: "cancelled",
      lastError: "cancelled by tester",
      finishedAt: "2026-04-10T00:00:00.000Z",
    });
    expect(state.checkpoints).toEqual([]);
    expect(state.timelineEvents).toEqual([]);
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

  it("does not let late completed traces overwrite an operator-cancelled durable run", () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({
      status: "completed",
      completion: {
        status: "complete",
        finishReason: "stop",
        repaired: false,
      },
    });
    const state = createFinalizeState();
    state.runs.set("run-cancelled", {
      ...createRun("run-cancelled", "cancelled"),
      lastError: "cancelled by operator",
      finishedAt: "2026-04-10T00:00:00.000Z",
    });

    finalizeDurableChatRun(state.deps, "run-cancelled", prepared, trace);

    expect(state.runs.get("run-cancelled")).toMatchObject({
      status: "cancelled",
      lastError: "cancelled by operator",
      finishedAt: "2026-04-10T00:00:00.000Z",
    });
    expect(state.checkpoints).toEqual([]);
    expect(state.timelineEvents).toEqual([]);
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

  it("does not let late traces rewrite already-terminal durable runs", () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({
      status: "waiting_for_approval",
      failure: {
        failureClass: "approval_required",
        message: "late approval wait",
        retryable: true,
      },
    });
    const state = createFinalizeState();
    state.runs.set("run-terminal", {
      ...createRun("run-terminal", "completed"),
      finishedAt: "2026-04-10T00:02:00.000Z",
    });

    finalizeDurableChatRun(state.deps, "run-terminal", prepared, trace);

    expect(state.runs.get("run-terminal")).toMatchObject({
      status: "completed",
      finishedAt: "2026-04-10T00:02:00.000Z",
    });
    expect(state.checkpoints).toEqual([]);
    expect(state.timelineEvents).toEqual([]);
    expect(state.tracePatches).toEqual([
      {
        turnId: "turn-1",
        patch: {
          durable: {
            runId: "run-terminal",
            status: "completed",
            checkpointKind: "run_completed",
          },
        },
      },
    ]);
  });

  it("does not let late traces rewrite durable runs that already moved out of running", () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({
      status: "completed",
      completion: {
        status: "complete",
        finishReason: "stop",
        repaired: false,
      },
    });
    const state = createFinalizeState();
    state.runs.set("run-late-waiting", {
      ...createRun("run-late-waiting", "waiting"),
      metadata: {
        waitForEvent: {
          eventKey: "cowork.turn.operator_resume",
          correlationId: "run-late-waiting",
        },
      },
    });

    finalizeDurableChatRun(state.deps, "run-late-waiting", prepared, trace);

    expect(state.runs.get("run-late-waiting")).toMatchObject({
      status: "waiting",
    });
    expect(state.runs.get("run-late-waiting")?.finishedAt).toBeUndefined();
    expect(state.checkpoints).toEqual([]);
    expect(state.timelineEvents).toEqual([]);
    expect(state.tracePatches).toEqual([
      {
        turnId: "turn-1",
        patch: {
          durable: {
            runId: "run-late-waiting",
            status: "waiting",
            checkpointKind: "run_waiting",
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
    expect(state.runs.get("run-complete")?.metadata).toMatchObject({
      outputText: "Approved child phase completed with real output.",
      finalOutput: "Approved child phase completed with real output.",
      outputSummary: "Approved child phase completed with real output.",
      finalSummary: "Approved child phase completed with real output.",
    });
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
          assistantMessageId: "assistant-1",
          outputText: "Approved child phase completed with real output.",
          outputSummary: "Approved child phase completed with real output.",
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

  it("commits autonomous post-commit recovery truth with the winning Chat completion", () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({ status: "completed" });
    const state = createFinalizeState();
    state.runs.set("run-complete", {
      ...createRun("run-complete", "running"),
      metadata: {
        surface: "chat",
        autonomous: {
          kind: "scheduled",
          deliverMode: "always",
          deliveryChannel: { channelKey: "telegram", target: "42" },
        },
      },
    });

    finalizeDurableChatRun(state.deps, "run-complete", prepared, trace);

    expect(state.runs.get("run-complete")).toMatchObject({
      status: "completed",
      metadata: {
        surface: "chat",
        autonomous: expect.objectContaining({ kind: "scheduled" }),
        autonomousChatPostCommitPending: {
          version: 1,
          requestedAt: expect.any(String),
        },
      },
    });
  });

  it("rolls back every finalization projection when a late transaction write fails", () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({ status: "completed" });
    const state = createFinalizeState();
    const before = state.runs.get("run-complete");
    const patchTrace = state.deps.chatTurnTraces.patch;
    state.deps.chatTurnTraces.patch = (turnId, patch) => {
      patchTrace(turnId, patch);
      throw new Error("injected trace commit failure");
    };

    expect(() => finalizeDurableChatRun(state.deps, "run-complete", prepared, trace)).toThrow(
      "injected trace commit failure",
    );

    expect(state.runs.get("run-complete")).toEqual(before);
    expect(state.checkpoints).toEqual([]);
    expect(state.timelineEvents).toEqual([]);
    expect(state.tracePatches).toEqual([]);

    state.deps.chatTurnTraces.patch = patchTrace;
    finalizeDurableChatRun(state.deps, "run-complete", prepared, trace);

    expect(state.runs.get("run-complete")?.status).toBe("completed");
    expect(state.checkpoints).toHaveLength(1);
    expect(state.timelineEvents).toHaveLength(1);
    expect(state.tracePatches).toHaveLength(1);
  });

  it("does not create autonomous post-commit work for failed or human Chat finalization", () => {
    const prepared = createPreparedTurn();
    const failed = createFinalizeState();
    failed.runs.set("run-complete", {
      ...createRun("run-complete", "running"),
      metadata: { autonomous: { kind: "scheduled" } },
    });
    finalizeDurableChatRun(failed.deps, "run-complete", prepared, createTrace({ status: "failed" }));

    const human = createFinalizeState();
    finalizeDurableChatRun(human.deps, "run-complete", prepared, createTrace({ status: "completed" }));

    expect(failed.runs.get("run-complete")?.metadata).not.toHaveProperty("autonomousChatPostCommitPending");
    expect(human.runs.get("run-complete")?.metadata).not.toHaveProperty("autonomousChatPostCommitPending");
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
    runImmediateTransaction: (callback) => {
      const runSnapshot = new Map(runs);
      const checkpointSnapshot = [...checkpoints];
      const timelineSnapshot = [...timelineEvents];
      const tracePatchSnapshot = [...tracePatches];
      try {
        return callback();
      } catch (error) {
        runs.clear();
        for (const [runId, run] of runSnapshot) {
          runs.set(runId, run);
        }
        checkpoints.splice(0, checkpoints.length, ...checkpointSnapshot);
        timelineEvents.splice(0, timelineEvents.length, ...timelineSnapshot);
        tracePatches.splice(0, tracePatches.length, ...tracePatchSnapshot);
        throw error;
      }
    },
    durableRuns: {
      getRun: (runId) => {
        const current = runs.get(runId);
        if (!current) {
          throw new Error(`Unknown run ${runId}`);
        }
        return current;
      },
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
    chatMessages: {
      get: (messageId) =>
        messageId === "assistant-1"
          ? {
              messageId,
              sessionId: "session-1",
              role: "assistant",
              actorType: "agent",
              actorId: "assistant",
              content: "Approved child phase completed with real output.",
              timestamp: "2026-04-10T00:00:03.000Z",
            }
          : undefined,
    },
    recordDurableTimelineEvent: (runId, eventType, payload) => {
      timelineEvents.push({ runId, eventType, payload });
    },
    chatTurnTraces: {
      patch: (turnId, patch) => {
        tracePatches.push({ turnId, patch: patch as Record<string, unknown> });
        return { turnId } as unknown as ReturnType<ChatDurableRunFinalizeDeps["chatTurnTraces"]["patch"]>;
      },
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
    metadata?: Record<string, unknown>;
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
    ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
    ...(patch.clearLease ? { leaseOwnerId: undefined, leaseExpiresAt: undefined, leaseHeartbeatAt: undefined } : {}),
  };
  runs.set(runId, next);
  return next;
}
