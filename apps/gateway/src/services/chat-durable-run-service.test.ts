import { describe, expect, it, vi } from "vitest";
import {
  buildRemoteWorkerAssignmentParentContext,
  NotFoundError,
  remoteWorkerAssignmentParentContextSha256,
} from "@goatcitadel/contracts";
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
  readCanonicalDurableChatTerminalOutput,
  type ChatDurableRunFinalizeDeps,
} from "./chat-durable-run-service.js";
import { DURABLE_RETRY_POLICY_DEFAULT } from "./durable-retry-policy.js";
import {
  computeEffectiveChatTurnRequestMaterialSha256,
  computeFrozenChatTurnAdmissionMaterialSha256,
} from "./session-control-service.js";
import {
  buildAutonomousChatAdmissionMetadataMaterial,
  buildChatTurnRuntimeAuthoritySeal,
  buildHeartbeatDecisionReceipt,
  hashChatTurnRuntimeAuthorityValue,
  sealAutonomousChatAdmissionMetadata,
  withChatTurnRuntimeAuthorityCheckpoint,
} from "./chat-durable-runtime-authority.js";

describe("chat-durable-run-service", () => {
  it("reads terminal output only from the immutable prepared assistant message and preserves exact text", async () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({ status: "completed", assistantMessageId: "assistant-1" });
    const state = createFinalizeState();
    state.deps.chatMessages = {
      get: async () => ({
        messageId: "assistant-1",
        sessionId: "session-1",
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        content: "  Exact stored\noutput.  ",
        timestamp: "2026-04-10T00:00:03.000Z",
      }),
    };

    await expect(readCanonicalDurableChatTerminalOutput(state.deps, prepared, trace)).resolves.toEqual({
      assistantMessageId: "assistant-1",
      outputText: "  Exact stored\noutput.  ",
      outputSummary: "Exact stored output.",
    });
    await expect(
      readCanonicalDurableChatTerminalOutput(
        state.deps,
        prepared,
        createTrace({ status: "completed", assistantMessageId: "assistant-drift" }),
      ),
    ).rejects.toThrow("different assistant message");
  });

  it("rejects terminal assistant records with the wrong session, role, or actor type", async () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({ status: "completed", assistantMessageId: "assistant-1" });
    const state = createFinalizeState();
    for (const invalid of [
      { sessionId: "other-session", role: "assistant", actorType: "agent" },
      { sessionId: "session-1", role: "user", actorType: "agent" },
      { sessionId: "session-1", role: "assistant", actorType: "system" },
    ] as const) {
      state.deps.chatMessages = {
        get: async () => ({
          messageId: "assistant-1",
          ...invalid,
          actorId: "assistant",
          content: "Output",
          timestamp: "2026-04-10T00:00:03.000Z",
        }),
      };
      await expect(readCanonicalDurableChatTerminalOutput(state.deps, prepared, trace)).rejects.toThrow(
        "invalid canonical linkage",
      );
    }
  });

  it("creates and schedules a durable chat run", async () => {
    const prepared = createPreparedTurn();
    const input = createSendRequest();
    const streamChunks: Array<{ chunk: ChatStreamChunkDraft; durableRunId?: string }> = [];
    const requestedRunIds: string[] = [];
    const createInputs: DurableRunCreateRequest[] = [];
    const admissionEvents: string[] = [];
    const run = createRun("run-1", "queued");

    const created = await beginDurableChatRun(
      {
        shouldUseDurableExecution: true,
        runImmediateTransaction: async (work) => await work(),
        createDurableRun: async (createInput) => {
          createInputs.push(createInput);
          return run;
        },
        buildDurablePayloadRecord: (_prepared, request, threadEventType) => ({
          requestContent: request.content,
          threadEventType,
        }),
        assertTurnAdmissionWrite: (selected) => {
          expect(selected).toBe(prepared);
          admissionEvents.push("admission:asserted");
        },
        bindTurnAdmissionToDurableRun: async (selected, durableRunId) => {
          expect(selected).toBe(prepared);
          expect(durableRunId).toBe("run-1");
          admissionEvents.push("admission:binding");
          await Promise.resolve();
          admissionEvents.push("admission:bound");
        },
        persistChatStreamChunk: async (chunk, durableRunId) => {
          admissionEvents.push("stream:persisted");
          streamChunks.push({ chunk, durableRunId });
        },
        requestDurableRunProcessing: (runId) => requestedRunIds.push(runId),
      },
      prepared,
      input,
      "chat_thread_turn_appended",
      { runId: "run-1" },
    );

    expect(created).toEqual(run);
    expect(createInputs).toEqual([
      expect.objectContaining({
        runId: "run-1",
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
    expect(admissionEvents).toEqual(["admission:asserted", "admission:binding", "admission:bound", "stream:persisted"]);
    expect(requestedRunIds).toEqual(["run-1"]);
  });

  it("binds task-scoped durable Chat to the immutable remote-worker parent context without widening ordinary Chat", async () => {
    const createInputs: DurableRunCreateRequest[] = [];
    const prepared = createPreparedTurn({
      workspaceId: "stale-projection",
      session: { sessionId: "stale-session" },
      turnId: "stale-turn",
    });
    const parentInput = {
      executionWorkspaceId: "default",
      durableRunId: "run-task-bound",
      taskId: "task-remote-1",
      sessionId: "session-1",
      turnId: "turn-1",
    } as const;

    await beginDurableChatRun(
      {
        shouldUseDurableExecution: true,
        runImmediateTransaction: async (work) => await work(),
        createDurableRun: async (input) => {
          createInputs.push(input);
          return createRun("run-task-bound", "queued");
        },
        buildDurablePayloadRecord: () => ({}),
        assertTurnAdmissionWrite: async () => undefined,
        bindTurnAdmissionToDurableRun: async () => undefined,
        persistChatStreamChunk: async () => undefined,
        requestDurableRunProcessing: () => undefined,
      },
      prepared,
      createSendRequest({ policyTaskId: parentInput.taskId }),
      "chat_thread_turn_appended",
      { runId: parentInput.durableRunId },
    );

    expect(createInputs[0]?.metadata).toMatchObject({
      remoteWorkerAssignmentParentContext: buildRemoteWorkerAssignmentParentContext(parentInput),
      remoteWorkerAssignmentParentContextSha256: remoteWorkerAssignmentParentContextSha256(parentInput),
    });
    expect(createInputs[0]?.metadata).not.toHaveProperty("remoteWorkerAssignmentLeaseToken");
  });

  it.each(["retry", "edit"] as const)(
    "atomically selects an earlier %s sibling branch before durable provider scheduling",
    async (branchKind) => {
      const events: string[] = [];
      const prepared = createPreparedTurn({
        turnAdmission: undefined,
        turnId: `turn-${branchKind}`,
        assistantMessageId: `assistant-${branchKind}`,
        branchKind,
        sourceTurnId: "turn-earlier-source",
        parentTurnId: "turn-source-parent",
        branchSelectionBaseTurnId: "turn-later-active-leaf",
      });
      const run = createRun(`run-${branchKind}`, "queued");

      await beginDurableChatRun(
        {
          shouldUseDurableExecution: true,
          runImmediateTransaction: async (work) => {
            events.push("transaction:start");
            const result = await work();
            events.push("transaction:commit");
            return result;
          },
          createDurableRun: async () => {
            events.push("run");
            return run;
          },
          buildDurablePayloadRecord: () => ({}),
          persistChatStreamChunk: async () => {
            events.push("message_start");
          },
          chatTurnTraces: {
            get: async () => {
              throw new NotFoundError({ entity: "chat turn trace", id: prepared.turnId });
            },
            create: async (input) => {
              events.push("trace");
              return input as ChatTurnTraceRecord;
            },
          },
          activatePreparedBranch: async (selected) => {
            events.push("branch");
            expect(selected).toMatchObject({
              branchKind,
              parentTurnId: "turn-source-parent",
              branchSelectionBaseTurnId: "turn-later-active-leaf",
              turnId: `turn-${branchKind}`,
            });
          },
          requestDurableRunProcessing: () => events.push("provider:scheduled"),
        },
        prepared,
        createSendRequest(),
        branchKind === "retry" ? "chat_thread_turn_retried" : "chat_thread_turn_edited",
        { runId: run.runId },
      );

      expect(events).toEqual([
        "transaction:start",
        "run",
        "trace",
        "branch",
        "message_start",
        "transaction:commit",
        "provider:scheduled",
      ]);
    },
  );

  it("fails a stale retry branch before stream publication or provider scheduling", async () => {
    const persistChatStreamChunk = vi.fn(async () => undefined);
    const requestDurableRunProcessing = vi.fn();
    const prepared = createPreparedTurn({
      turnAdmission: undefined,
      branchKind: "retry",
      sourceTurnId: "turn-earlier-source",
      parentTurnId: "turn-source-parent",
      branchSelectionBaseTurnId: "turn-stale-leaf",
    });

    await expect(
      beginDurableChatRun(
        {
          shouldUseDurableExecution: true,
          runImmediateTransaction: async (work) => await work(),
          createDurableRun: async () => createRun("run-stale-retry", "queued"),
          buildDurablePayloadRecord: () => ({}),
          persistChatStreamChunk,
          activatePreparedBranch: async () => {
            throw new Error("active leaf changed before retry branch admission");
          },
          requestDurableRunProcessing,
        },
        prepared,
        createSendRequest(),
        "chat_thread_turn_retried",
        { runId: "run-stale-retry" },
      ),
    ).rejects.toThrow(/active leaf changed before retry branch admission/i);
    expect(persistChatStreamChunk).not.toHaveBeenCalled();
    expect(requestDurableRunProcessing).not.toHaveBeenCalled();
  });

  it("skips durable run creation when the flow stays synchronous", async () => {
    const prepared = createPreparedTurn();
    const input = createSendRequest();
    let created = false;

    const run = await beginDurableChatRun(
      {
        shouldUseDurableExecution: false,
        createDurableRun: async () => {
          created = true;
          return createRun("run-unexpected", "queued");
        },
        buildDurablePayloadRecord: () => ({}),
        persistChatStreamChunk: async () => undefined,
        requestDurableRunProcessing: () => undefined,
      },
      prepared,
      input,
      "chat_thread_turn_appended",
    );

    expect(run).toBeUndefined();
    expect(created).toBe(false);
  });

  it("signals durable commit before a pre-yield stream persistence failure escapes", async () => {
    const markCommitted = vi.fn();

    await expect(
      beginDurableChatRun(
        {
          shouldUseDurableExecution: true,
          createDurableRun: async () => createRun("run-commit-signal", "queued"),
          buildDurablePayloadRecord: () => ({}),
          persistChatStreamChunk: async () => {
            throw new Error("stream chunk persistence unavailable");
          },
          activatePreparedBranch: vi.fn(async () => undefined),
          requestDurableRunProcessing: vi.fn(),
        },
        createPreparedTurn({ turnAdmission: undefined }),
        createSendRequest(),
        "chat_thread_turn_retried",
        { mutationLifecycle: { markCommitted } },
      ),
    ).rejects.toThrow("stream chunk persistence unavailable");

    expect(markCommitted).toHaveBeenCalledTimes(1);
  });

  it("marks waiting traces as durable waiting checkpoints", async () => {
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

    await finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace);

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

  it("replays waiting turns only from their exact latest seal and checkpoint", async () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({
      status: "waiting_for_approval",
      failure: {
        failureClass: "approval_required",
        message: "Waiting for approval",
        retryable: true,
      },
    });
    const state = createFinalizeState();
    await finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace);
    const stored = state.runs.get("run-waiting");
    const checkpointCount = state.checkpoints.length;
    const timelineCount = state.timelineEvents.length;
    state.tracePatches.length = 0;

    await finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace);

    expect(state.runs.get("run-waiting")).toEqual(stored);
    expect(state.checkpoints).toHaveLength(checkpointCount);
    expect(state.timelineEvents).toHaveLength(timelineCount);
    expect(state.tracePatches).toEqual([
      {
        turnId: "turn-1",
        patch: { durable: { runId: "run-waiting", status: "waiting", checkpointKind: "run_waiting" } },
      },
    ]);

    state.checkpoints.length = 0;
    await expect(finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace)).rejects.toThrow(
      "no exact latest waiting authority checkpoint",
    );
  });

  it("accepts an exactly settled waiting finalizer and rejects stale output evidence", async () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({ status: "waiting_for_tool" });
    const state = createFinalizeState();
    await finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace);
    const run = state.runs.get("run-waiting")!;
    const pending = run.metadata?.generalChatPostCommitPending as Record<string, unknown>;
    const metadata = { ...(run.metadata ?? {}) };
    delete metadata.generalChatPostCommitPending;
    metadata.generalChatPostCommit = buildFinalGeneralSettlement(pending, "2026-04-10T00:00:04.000Z");
    state.runs.set("run-waiting", { ...run, metadata });

    await expect(finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace)).resolves.toBeUndefined();

    const settled = state.runs.get("run-waiting")!;
    state.runs.set("run-waiting", {
      ...settled,
      metadata: { ...(settled.metadata ?? {}), outputText: "stale terminal output" },
    });
    await expect(finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace)).rejects.toThrow(
      "stale output evidence for a waiting replay",
    );
  });

  it("marks user-input waits as durable waiting checkpoints", async () => {
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

    await finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace);

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

  it("marks tool waits as durable waiting checkpoints", async () => {
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

    await finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace);

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

  it("parks approval waits with an approval.resolved waitForEvent keyed to the pending approval", async () => {
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
      metadata: {
        surface: "chat",
        objective: "Research this repo",
        retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT },
      },
    });

    await finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace);

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

  it("parks user-input waits with a chat.user_input.resolved waitForEvent keyed to the pending prompt", async () => {
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

    await finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace);

    expect(state.runs.get("run-waiting")?.metadata).toMatchObject({
      waitForEvent: {
        eventKey: "chat.user_input.resolved",
        correlationId: "prompt-abc",
      },
    });
  });

  it("parks tool waits with an eventKey-only waitForEvent (no known wake correlation)", async () => {
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

    await finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace);

    const waitForEvent = (state.runs.get("run-waiting")?.metadata as { waitForEvent?: Record<string, unknown> })
      ?.waitForEvent;
    expect(waitForEvent).toEqual({ eventKey: "chat.tool_wait.resolved" });
    expect(waitForEvent).not.toHaveProperty("correlationId");
  });

  it("falls back to a runId-scoped waitForEvent when an approval wait lacks a resolvable approvalId", async () => {
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

    await finalizeDurableChatRun(state.deps, "run-waiting", prepared, trace);

    const waitForEvent = (state.runs.get("run-waiting")?.metadata as { waitForEvent?: Record<string, unknown> })
      ?.waitForEvent;
    expect(waitForEvent).toEqual({ eventKey: "approval.resolved" });
    expect(waitForEvent).not.toHaveProperty("correlationId");
  });

  it("marks cancelled traces as durable cancellation checkpoints", async () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({
      status: "cancelled",
    });
    const state = createFinalizeState();

    await finalizeDurableChatRun(state.deps, "run-cancelled", prepared, trace);

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

  it("does not duplicate durable cancellation checkpoints after an operator cancel already settled the run", async () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({
      status: "cancelled",
    });
    const state = createFinalizeState();
    await finalizeDurableChatRun(state.deps, "run-cancelled", prepared, trace);
    const settled = state.runs.get("run-cancelled");
    const checkpointCount = state.checkpoints.length;
    const timelineCount = state.timelineEvents.length;
    state.tracePatches.length = 0;

    await finalizeDurableChatRun(state.deps, "run-cancelled", prepared, trace);

    expect(state.runs.get("run-cancelled")).toEqual(settled);
    expect(state.checkpoints).toHaveLength(checkpointCount);
    expect(state.timelineEvents).toHaveLength(timelineCount);
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

  it("does not let late completed traces overwrite an operator-cancelled durable run", async () => {
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
    await finalizeDurableChatRun(state.deps, "run-cancelled", prepared, createTrace({ status: "cancelled" }));
    const settled = state.runs.get("run-cancelled");
    const checkpointCount = state.checkpoints.length;
    const timelineCount = state.timelineEvents.length;
    state.tracePatches.length = 0;

    await expect(finalizeDurableChatRun(state.deps, "run-cancelled", prepared, trace)).rejects.toThrow(
      "no exact terminal replay authority",
    );

    expect(state.runs.get("run-cancelled")).toEqual(settled);
    expect(state.checkpoints).toHaveLength(checkpointCount);
    expect(state.timelineEvents).toHaveLength(timelineCount);
    expect(state.tracePatches).toEqual([]);
  });

  it("does not let late traces rewrite already-terminal durable runs", async () => {
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
    state.runs.set("run-terminal", createRun("run-terminal", "running"));
    await finalizeDurableChatRun(state.deps, "run-terminal", prepared, createTrace({ status: "completed" }));
    const settled = state.runs.get("run-terminal");
    const checkpointCount = state.checkpoints.length;
    const timelineCount = state.timelineEvents.length;
    state.tracePatches.length = 0;

    await expect(finalizeDurableChatRun(state.deps, "run-terminal", prepared, trace)).rejects.toThrow(
      "no exact terminal replay authority",
    );

    expect(state.runs.get("run-terminal")).toEqual(settled);
    expect(state.checkpoints).toHaveLength(checkpointCount);
    expect(state.timelineEvents).toHaveLength(timelineCount);
    expect(state.tracePatches).toEqual([]);
  });

  it("quarantines a waiting run that moved out of running without exact replay authority", async () => {
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
        retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT },
        waitForEvent: {
          eventKey: "cowork.turn.operator_resume",
          correlationId: "run-late-waiting",
        },
      },
    });

    await expect(finalizeDurableChatRun(state.deps, "run-late-waiting", prepared, trace)).rejects.toThrow(
      "no exact waiting replay authority",
    );

    expect(state.runs.get("run-late-waiting")).toMatchObject({
      status: "waiting",
    });
    expect(state.runs.get("run-late-waiting")?.finishedAt).toBeUndefined();
    expect(state.checkpoints).toEqual([]);
    expect(state.timelineEvents).toEqual([]);
    expect(state.tracePatches).toEqual([]);
  });

  it("does not finalize after the database reports that the expected lease expired", async () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({ status: "completed" });
    const state = createFinalizeState();
    state.runs.set("run-complete", {
      ...createRun("run-complete", "running"),
      leaseOwnerId: "worker-a",
      leaseHeartbeatAt: "2026-04-10T00:00:00.000Z",
      leaseExpiresAt: "2999-04-10T00:05:00.000Z",
    });
    const lockFreshActiveLeaseForUpdate = vi.fn(async () => undefined);
    Object.assign(state.deps.durableRuns, { lockFreshActiveLeaseForUpdate });

    await finalizeDurableChatRun(state.deps, "run-complete", prepared, trace, "worker-a");

    expect(lockFreshActiveLeaseForUpdate).toHaveBeenCalledWith("run-complete", "worker-a");
    expect(state.runs.get("run-complete")?.status).toBe("running");
    expect(state.checkpoints).toEqual([]);
    expect(state.timelineEvents).toEqual([]);
    expect(state.tracePatches).toEqual([]);
  });

  it("records completed checkpoints with tool and artifact summaries", async () => {
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

    await finalizeDurableChatRun(state.deps, "run-complete", prepared, trace);

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
        state: expect.objectContaining({
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
        }),
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

  it("does not infer autonomous finalizer authority from descriptive autonomous metadata", async () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({ status: "completed" });
    const state = createFinalizeState();
    state.runs.set("run-complete", {
      ...createRun("run-complete", "running"),
      metadata: {
        retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT },
        surface: "chat",
        autonomous: {
          kind: "scheduled",
          deliverMode: "always",
          deliveryChannel: { channelKey: "telegram", target: "42" },
        },
      },
    });

    await finalizeDurableChatRun(state.deps, "run-complete", prepared, trace);

    expect(state.runs.get("run-complete")).toMatchObject({
      status: "completed",
      metadata: {
        surface: "chat",
        autonomous: expect.objectContaining({ kind: "scheduled" }),
      },
    });
    expect(state.runs.get("run-complete")?.metadata).not.toHaveProperty("autonomousChatPostCommitPending");
  });

  it("rolls back every finalization projection when a late transaction write fails", async () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({ status: "completed" });
    const state = createFinalizeState();
    const before = state.runs.get("run-complete");
    const patchTrace = state.deps.chatTurnTraces.patch;
    state.deps.chatTurnTraces.patch = async (turnId, patch) => {
      await patchTrace(turnId, patch);
      throw new Error("injected trace commit failure");
    };

    await expect(finalizeDurableChatRun(state.deps, "run-complete", prepared, trace)).rejects.toThrow(
      "injected trace commit failure",
    );

    expect(state.runs.get("run-complete")).toEqual(before);
    expect(state.checkpoints).toEqual([]);
    expect(state.timelineEvents).toEqual([]);
    expect(state.tracePatches).toEqual([]);

    state.deps.chatTurnTraces.patch = patchTrace;
    await finalizeDurableChatRun(state.deps, "run-complete", prepared, trace);

    expect(state.runs.get("run-complete")?.status).toBe("completed");
    expect(state.checkpoints).toHaveLength(1);
    expect(state.timelineEvents).toHaveLength(1);
    expect(state.tracePatches).toHaveLength(1);
  });

  it("does not create autonomous post-commit work for failed or human Chat finalization", async () => {
    const prepared = createPreparedTurn();
    const failed = createFinalizeState();
    failed.runs.set("run-complete", {
      ...createRun("run-complete", "running"),
      metadata: {
        retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT },
        autonomous: { kind: "scheduled" },
      },
    });
    await finalizeDurableChatRun(failed.deps, "run-complete", prepared, createTrace({ status: "failed" }));

    const human = createFinalizeState();
    await finalizeDurableChatRun(human.deps, "run-complete", prepared, createTrace({ status: "completed" }));

    expect(failed.runs.get("run-complete")?.metadata).not.toHaveProperty("autonomousChatPostCommitPending");
    expect(human.runs.get("run-complete")?.metadata).not.toHaveProperty("autonomousChatPostCommitPending");
  });

  it("records completed checkpoints when older traces do not include completion metadata", async () => {
    const prepared = createPreparedTurn({ content: "Run the agentic smoke" });
    const trace = createTrace({
      status: "completed",
      completion: undefined,
    });
    const state = createFinalizeState();

    await finalizeDurableChatRun(state.deps, "run-complete", prepared, trace);

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

  it("records failed checkpoints when completion metadata is explicitly incomplete", async () => {
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

    await finalizeDurableChatRun(state.deps, "run-complete", prepared, trace);

    expect(state.runs.get("run-complete")?.status).toBe("failed");
    expect(state.checkpoints).toEqual([
      expect.objectContaining({
        runId: "run-complete",
        checkpointKind: "run_failed",
        state: expect.objectContaining({
          currentStep: "failed",
        }),
      }),
    ]);
    expect(state.checkpoints[0]?.state).not.toHaveProperty("assistantMessageId");
    expect(state.checkpoints[0]?.state).not.toHaveProperty("outputText");
    expect(state.runs.get("run-complete")?.metadata).not.toHaveProperty("outputText");
  });

  it("quarantines legacy and unadmitted v2 runs without creating terminal or autonomous evidence", async () => {
    const trace = createTrace({ status: "completed" });
    const legacy = createFinalizeState();
    legacy.runs.set("run-complete", {
      ...createRun("run-complete", "running"),
      payload: { version: "chat.turn.execute.v1" },
      metadata: {
        retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT },
        autonomous: { kind: "scheduled" },
      },
    });
    const legacyBefore = structuredClone(legacy.runs.get("run-complete"));

    await expect(finalizeDurableChatRun(legacy.deps, "run-complete", createPreparedTurn(), trace)).rejects.toThrow(
      "quarantined from finalization",
    );
    expect(legacy.runs.get("run-complete")).toEqual(legacyBefore);
    expect(legacy.checkpoints).toEqual([]);
    expect(legacy.timelineEvents).toEqual([]);
    expect(legacy.tracePatches).toEqual([]);
    expect(legacy.runs.get("run-complete")?.metadata).not.toHaveProperty("autonomousChatPostCommitPending");

    const unadmitted = createFinalizeState();
    const unadmittedBefore = structuredClone(unadmitted.runs.get("run-complete"));
    await expect(
      finalizeDurableChatRun(unadmitted.deps, "run-complete", createPreparedTurn({ turnAdmission: undefined }), trace),
    ).rejects.toThrow("no exact admitted finalize context");
    expect(unadmitted.runs.get("run-complete")).toEqual(unadmittedBefore);
    expect(unadmitted.checkpoints).toEqual([]);
    expect(unadmitted.timelineEvents).toEqual([]);
    expect(unadmitted.tracePatches).toEqual([]);
  });

  it("accepts an exact terminal replay while general post-commit remains pending", async () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({ status: "completed" });
    const state = createFinalizeState();
    await finalizeDurableChatRun(state.deps, "run-complete", prepared, trace);
    const settled = state.runs.get("run-complete");
    const checkpointCount = state.checkpoints.length;
    const timelineCount = state.timelineEvents.length;
    state.tracePatches.length = 0;

    await finalizeDurableChatRun(state.deps, "run-complete", prepared, trace);

    expect(state.runs.get("run-complete")).toEqual(settled);
    expect(state.checkpoints).toHaveLength(checkpointCount);
    expect(state.timelineEvents).toHaveLength(timelineCount);
    expect(state.tracePatches).toEqual([
      {
        turnId: "turn-1",
        patch: {
          durable: { runId: "run-complete", status: "completed", checkpointKind: "run_completed" },
        },
      },
    ]);
  });

  it("rejects terminal replay when the latest checkpoint or general finalizer evidence is missing", async () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({ status: "completed" });

    const missingCheckpoint = createFinalizeState();
    await finalizeDurableChatRun(missingCheckpoint.deps, "run-complete", prepared, trace);
    missingCheckpoint.checkpoints.length = 0;
    await expect(finalizeDurableChatRun(missingCheckpoint.deps, "run-complete", prepared, trace)).rejects.toThrow(
      "no exact latest terminal authority checkpoint",
    );

    const missingFinalizer = createFinalizeState();
    await finalizeDurableChatRun(missingFinalizer.deps, "run-complete", prepared, trace);
    const run = missingFinalizer.runs.get("run-complete")!;
    const metadata = { ...(run.metadata ?? {}) };
    delete metadata.generalChatPostCommitPending;
    missingFinalizer.runs.set("run-complete", { ...run, metadata });
    await expect(finalizeDurableChatRun(missingFinalizer.deps, "run-complete", prepared, trace)).rejects.toThrow(
      "general finalizer drifted from terminal authority",
    );
  });

  it("rejects a handoff before the pending general finalizer settles", async () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({ status: "completed" });
    const state = createFinalizeState();
    await finalizeDurableChatRun(state.deps, "run-complete", prepared, trace);
    const run = state.runs.get("run-complete")!;
    const pending = run.metadata?.generalChatPostCommitPending as Record<string, unknown>;
    state.runs.set("run-complete", {
      ...run,
      metadata: {
        ...(run.metadata ?? {}),
        chatTurnAdmissionHandoff: buildExactTestHandoff(
          "run-complete",
          String(pending.generationId),
          [],
          "2026-04-10T00:00:04.000Z",
        ),
      },
    });

    await expect(finalizeDurableChatRun(state.deps, "run-complete", prepared, trace)).rejects.toThrow(
      "committed a handoff before finalizers settled",
    );
  });

  it("accepts the exact all-settled general finalizer and admission handoff", async () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({ status: "completed" });
    const state = createFinalizeState();
    await finalizeDurableChatRun(state.deps, "run-complete", prepared, trace);
    const run = state.runs.get("run-complete")!;
    const pending = run.metadata?.generalChatPostCommitPending as Record<string, unknown>;
    const metadata = { ...(run.metadata ?? {}) };
    delete metadata.generalChatPostCommitPending;
    metadata.generalChatPostCommit = buildFinalGeneralSettlement(pending, "2026-04-10T00:00:04.000Z");
    metadata.chatTurnAdmissionHandoff = buildExactTestHandoff(
      "run-complete",
      String(pending.generationId),
      [],
      "2026-04-10T00:00:04.000Z",
    );
    state.runs.set("run-complete", { ...run, metadata });
    const checkpointCount = state.checkpoints.length;
    const timelineCount = state.timelineEvents.length;
    state.tracePatches.length = 0;

    await finalizeDurableChatRun(state.deps, "run-complete", prepared, trace);

    expect(state.checkpoints).toHaveLength(checkpointCount);
    expect(state.timelineEvents).toHaveLength(timelineCount);
    expect(state.tracePatches).toHaveLength(1);
  });

  it("accepts a linked-to-general pending prefix but rejects an out-of-order general settlement", async () => {
    const prepared = createPreparedTurn();
    const trace = createTrace({ status: "failed" });
    const state = createFinalizeState();
    await finalizeDurableChatRun(state.deps, "run-complete", prepared, trace);
    const run = state.runs.get("run-complete")!;
    const checkpoint = state.checkpoints[0]!;
    const pending = run.metadata?.generalChatPostCommitPending as Record<string, unknown>;
    const requestedAt = String(pending.requestedAt);
    const reason = "linked child finalization failed";
    const finalizationId = "linked-finalization-1";
    const authority = buildChatTurnRuntimeAuthoritySeal({
      runId: "run-complete",
      turnId: "turn-1",
      transitionKind: "linked_finalization",
      durableStatus: "failed",
      traceStatus: "failed",
      transitionAt: requestedAt,
      postCommitGenerationId: String(pending.generationId),
      postCommitEligibility: pending.postCommitEligibility as never,
      linkedFinalization: { finalizationId, requestedAt, reason },
      requiredFinalizers: ["linked", "general"],
    });
    const linkedPending = { reason, requestedAt, finalizationId };
    state.runs.set("run-complete", {
      ...run,
      metadata: {
        ...(run.metadata ?? {}),
        linkedFinalizationPending: linkedPending,
        chatTurnRuntimeAuthority: authority,
      },
    });
    checkpoint.state = withChatTurnRuntimeAuthorityCheckpoint(checkpoint.state, authority);
    state.tracePatches.length = 0;

    await expect(finalizeDurableChatRun(state.deps, "run-complete", prepared, trace)).resolves.toBeUndefined();

    const pendingPrefixRun = state.runs.get("run-complete")!;
    const outOfOrderMetadata = { ...(pendingPrefixRun.metadata ?? {}) };
    delete outOfOrderMetadata.generalChatPostCommitPending;
    outOfOrderMetadata.generalChatPostCommit = buildFinalGeneralSettlement(pending, "2026-04-10T00:00:04.000Z");
    state.runs.set("run-complete", { ...pendingPrefixRun, metadata: outOfOrderMetadata });
    await expect(finalizeDurableChatRun(state.deps, "run-complete", prepared, trace)).rejects.toThrow(
      "settled finalizers out of canonical order",
    );
  });

  it("finalizes and replays an exact silent system heartbeat without visible output or raw timeline disclosure", async () => {
    const rawOutput = '{"notify":false}';
    const fixture = createHeartbeatFinalizeFixture(rawOutput);
    const state = createFinalizeState();
    state.runs.set(fixture.run.runId, fixture.run);

    await finalizeDurableChatRun(state.deps, fixture.run.runId, fixture.prepared, fixture.trace);

    const completed = state.runs.get(fixture.run.runId)!;
    expect(completed).toMatchObject({ status: "completed" });
    expect(completed.metadata).toMatchObject({
      heartbeatDecisionReceipt: fixture.receipt,
      heartbeatDecisionRawOutput: rawOutput,
      generalChatPostCommitPending: {
        postCommitEligibility: {
          version: 1,
          autonomyEnabledAtParentSettlement: false,
          evalIntegrityTurn: false,
          humanSession: false,
        },
      },
      autonomousChatPostCommitPending: expect.any(Object),
      chatTurnRuntimeAuthority: {
        material: {
          heartbeatDecisionReceipt: fixture.receipt,
          terminalOutput: null,
        },
      },
    });
    expect(completed.metadata).not.toHaveProperty("outputText");
    expect(completed.metadata).not.toHaveProperty("outputSummary");
    expect(state.checkpoints).toHaveLength(1);
    expect(state.checkpoints[0]?.state).toMatchObject({
      heartbeatDecisionReceipt: fixture.receipt,
      heartbeatDecisionRawOutput: rawOutput,
    });
    expect(state.checkpoints[0]?.state).not.toHaveProperty("assistantMessageId");
    expect(state.checkpoints[0]?.state).not.toHaveProperty("outputText");
    expect(state.timelineEvents).toHaveLength(1);
    expect(JSON.stringify(state.timelineEvents[0])).not.toContain("heartbeatDecisionRawOutput");
    expect(JSON.stringify(state.timelineEvents[0])).not.toContain(rawOutput);

    const checkpointCount = state.checkpoints.length;
    const timelineCount = state.timelineEvents.length;
    state.tracePatches.length = 0;
    await finalizeDurableChatRun(state.deps, fixture.run.runId, fixture.prepared, fixture.trace);
    expect(state.checkpoints).toHaveLength(checkpointCount);
    expect(state.timelineEvents).toHaveLength(timelineCount);
    expect(state.tracePatches).toEqual([
      {
        turnId: fixture.trace.turnId,
        patch: {
          durable: {
            runId: fixture.run.runId,
            status: "completed",
            checkpointKind: "run_completed",
          },
        },
      },
    ]);
  });

  it("finalizes a notifying system heartbeat only from its exact normalized system message", async () => {
    const rawOutput = '{"notify":true,"message":"  Check the backup now.  "}';
    const fixture = createHeartbeatFinalizeFixture(rawOutput);
    const state = createFinalizeState();
    state.runs.set(fixture.run.runId, fixture.run);
    state.deps.chatMessages = {
      get: async (messageId) =>
        messageId === fixture.prepared.assistantMessageId
          ? {
              messageId,
              sessionId: fixture.prepared.session.sessionId,
              role: "assistant",
              actorType: "system",
              actorId: "system-heartbeat",
              content: "Check the backup now.",
              timestamp: "2026-04-10T00:00:03.000Z",
            }
          : undefined,
    };

    await finalizeDurableChatRun(state.deps, fixture.run.runId, fixture.prepared, fixture.trace);

    const completed = state.runs.get(fixture.run.runId)!;
    expect(completed.metadata).toMatchObject({
      heartbeatDecisionReceipt: fixture.receipt,
      heartbeatDecisionRawOutput: rawOutput,
      outputText: "Check the backup now.",
      finalOutput: "Check the backup now.",
      outputSummary: "Check the backup now.",
      finalSummary: "Check the backup now.",
      chatTurnRuntimeAuthority: {
        material: {
          heartbeatDecisionReceipt: fixture.receipt,
          terminalOutput: expect.objectContaining({
            assistantMessageId: fixture.prepared.assistantMessageId,
          }),
        },
      },
    });
    expect(state.checkpoints[0]?.state).toMatchObject({
      assistantMessageId: fixture.prepared.assistantMessageId,
      outputText: "Check the backup now.",
      outputSummary: "Check the backup now.",
      heartbeatDecisionReceipt: fixture.receipt,
      heartbeatDecisionRawOutput: rawOutput,
    });
    expect(JSON.stringify(state.timelineEvents[0])).not.toContain("heartbeatDecisionRawOutput");
    expect(JSON.stringify(state.timelineEvents[0])).not.toContain(rawOutput);
  });

  it.each([
    ["missing", undefined],
    ["repaired", { status: "complete" as const, repaired: true }],
    ["extra-key", { status: "complete" as const, repaired: false, finishReason: "stop" }],
  ])("rejects %s heartbeat completion evidence before finalization", async (_case, completion) => {
    const fixture = createHeartbeatFinalizeFixture('{"notify":false}');
    const state = createFinalizeState();
    state.runs.set(fixture.run.runId, fixture.run);

    await expect(
      finalizeDurableChatRun(state.deps, fixture.run.runId, fixture.prepared, { ...fixture.trace, completion }),
    ).rejects.toThrow(/partial, repaired, or incomplete decision/);

    expect(state.runs.get(fixture.run.runId)).toMatchObject({ status: "running" });
    expect(state.checkpoints).toHaveLength(0);
    expect(state.timelineEvents).toHaveLength(0);
  });

  it("terminally blocks a system heartbeat approval wait without decision or output evidence", async () => {
    const fixture = createHeartbeatFinalizeFixture(undefined);
    const state = createFinalizeState();
    state.runs.set(fixture.run.runId, fixture.run);
    const approvalTrace = {
      ...fixture.trace,
      status: "waiting_for_approval" as const,
      completion: { status: "interrupted" as const, repaired: false },
    };

    await finalizeDurableChatRun(state.deps, fixture.run.runId, fixture.prepared, approvalTrace);

    const failed = state.runs.get(fixture.run.runId)!;
    expect(failed).toMatchObject({
      status: "failed",
      lastError: "System heartbeat tool execution requires an approval and was blocked.",
      metadata: {
        generalChatPostCommitPending: {
          postCommitEligibility: {
            version: 1,
            autonomyEnabledAtParentSettlement: false,
            evalIntegrityTurn: false,
            humanSession: false,
          },
        },
      },
    });
    expect(failed.metadata).not.toHaveProperty("heartbeatDecisionReceipt");
    expect(failed.metadata).not.toHaveProperty("heartbeatDecisionRawOutput");
    expect(failed.metadata).not.toHaveProperty("outputText");
    expect(state.checkpoints[0]?.state).not.toHaveProperty("heartbeatDecisionReceipt");
    expect(state.checkpoints[0]?.state).not.toHaveProperty("heartbeatDecisionRawOutput");
    expect(state.checkpoints[0]?.state).not.toHaveProperty("assistantMessageId");
    expect(state.tracePatches[0]?.patch).toMatchObject({
      status: "failed",
      failure: { failureClass: "approval_required", retryable: false },
    });
  });
});

function createPreparedTurn(overrides: Partial<PreparedAgentChatTurn> = {}): PreparedAgentChatTurn {
  const admittedRequest = { content: "Research this repo" };
  const admissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(admittedRequest);
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
    turnAdmission: {
      identity: {
        admissionId: "admission-1",
        sessionIncarnationId: "incarnation-1",
        workspaceId: "default",
        sessionId: "session-1",
        turnId: "turn-1",
        aggregateRevision: 1,
        controllerGeneration: 1,
        materialSha256: admissionMaterialSha256,
      },
      admittedRequest,
      requestActor: { actorKind: "operator", actorId: "operator" },
    },
    ...overrides,
  } as PreparedAgentChatTurn;
}

function createTrace(overrides: Partial<ChatTurnTraceRecord> = {}): ChatTurnTraceRecord {
  return {
    turnId: "turn-1",
    sessionId: "session-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
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
  const request = { content: "Research this repo" };
  const admissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(request);
  return {
    runId,
    workflowKey,
    status,
    attemptCount: 0,
    maxAttempts: 3,
    version: 1,
    payload: {
      version: "chat.turn.execute.v2",
      admissionId: "admission-1",
      sessionIncarnationId: "incarnation-1",
      admissionMaterialSha256,
      effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(admissionMaterialSha256, request),
      workspaceId: "default",
      admissionAggregateRevision: 1,
      admissionControllerGeneration: 1,
      requestActor: { actorKind: "operator", actorId: "operator" },
      request,
      sessionId: "session-1",
      turnId: "turn-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
    },
    metadata: { retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT } },
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    startedAt: "2026-04-10T00:00:00.000Z",
  };
}

function createHeartbeatFinalizeFixture(rawOutput: string | undefined): {
  run: DurableRunRecord;
  prepared: PreparedAgentChatTurn;
  trace: ChatTurnTraceRecord;
  receipt?: ReturnType<typeof buildHeartbeatDecisionReceipt>["receipt"];
} {
  const runId = "run-heartbeat";
  const sessionId = "session-heartbeat";
  const turnId = "turn-heartbeat";
  const userMessageId = "user-heartbeat-ephemeral";
  const assistantMessageId = "assistant-heartbeat";
  const occurrenceId = "heartbeat-occurrence";
  const claimSha256 = "a".repeat(64);
  const request = {
    content: "Perform the bounded heartbeat check and return the exact decision object.",
    permissionProfileId: "heartbeat-restricted",
    policyRunId: runId,
  };
  const admissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(request);
  const payload = {
    version: "chat.turn.execute.v2" as const,
    admissionId: "admission-heartbeat",
    sessionIncarnationId: "incarnation-heartbeat",
    admissionMaterialSha256,
    effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(admissionMaterialSha256, request),
    workspaceId: "default",
    admissionAggregateRevision: 1,
    admissionControllerGeneration: 1,
    requestActor: { actorKind: "system", actorId: "system-heartbeat" },
    request,
    sessionId,
    turnId,
    userMessageId,
    assistantMessageId,
    heartbeatOccurrenceId: occurrenceId,
    heartbeatClaimSha256: claimSha256,
    heartbeatEvaluatedPolicySha256: "b".repeat(64),
    heartbeatFrozenObjectiveSha256: "c".repeat(64),
  };
  const autonomous = {
    kind: "heartbeat" as const,
    systemActorId: "system-heartbeat",
    sourceRunId: runId,
    reason: `heartbeat self-wake:${sessionId}`,
    deliverMode: "on_notify" as const,
  };
  const autonomousAdmission = sealAutonomousChatAdmissionMetadata(
    buildAutonomousChatAdmissionMetadataMaterial({
      identity: { userMessageId, turnId, assistantMessageId, durableRunId: runId },
      sessionId,
      objective: request.content,
      autonomous,
      payload,
    }),
  );
  const decision = rawOutput ? buildHeartbeatDecisionReceipt({ occurrenceId, claimSha256, rawOutput }) : undefined;
  const run: DurableRunRecord = {
    ...createRun(runId, "running"),
    runId,
    payload,
    metadata: {
      retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT },
      objective: request.content,
      autonomous,
      autonomousAdmission,
      ...(decision
        ? {
            heartbeatDecisionReceipt: decision.receipt,
            heartbeatDecisionRawOutput: rawOutput,
          }
        : {}),
    },
    attemptCount: 1,
  };
  const prepared = createPreparedTurn({
    session: { sessionId },
    workspaceId: "default",
    content: request.content,
    userEventId: userMessageId,
    userMessage: {
      messageId: userMessageId,
      sessionId,
      role: "user",
      actorType: "system",
      actorId: "system-heartbeat",
      content: request.content,
      timestamp: "2026-04-10T00:00:00.000Z",
    },
    turnId,
    assistantMessageId,
    turnAdmission: {
      identity: {
        admissionId: payload.admissionId,
        sessionIncarnationId: payload.sessionIncarnationId,
        workspaceId: payload.workspaceId,
        sessionId,
        turnId,
        aggregateRevision: payload.admissionAggregateRevision,
        controllerGeneration: payload.admissionControllerGeneration,
        materialSha256: admissionMaterialSha256,
      },
      admittedRequest: request,
      requestActor: payload.requestActor,
    },
    serverOnlyPosture: {
      kind: "system_heartbeat",
      actorId: "system-heartbeat",
      operation: "chat_system_heartbeat",
      occurrenceId,
      claimSha256,
      durableRunId: runId,
    },
  } as Partial<PreparedAgentChatTurn>);
  const trace = createTrace({
    turnId,
    sessionId,
    userMessageId,
    assistantMessageId,
    status: "completed",
    completion: { status: "complete", repaired: false },
  });
  return { run, prepared, trace, ...(decision ? { receipt: decision.receipt } : {}) };
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
    runImmediateTransaction: async (callback) => {
      const runSnapshot = new Map(runs);
      const checkpointSnapshot = [...checkpoints];
      const timelineSnapshot = [...timelineEvents];
      const tracePatchSnapshot = [...tracePatches];
      try {
        return await callback();
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
      getRun: async (runId) => {
        const current = runs.get(runId);
        if (!current) {
          throw new Error(`Unknown run ${runId}`);
        }
        return current;
      },
      updateRun: async (input) => updateRun(runs, input.runId, input),
      getLatestCheckpointByKind: async (runId, checkpointKind) =>
        [...checkpoints]
          .reverse()
          .find((checkpoint) => checkpoint.runId === runId && checkpoint.checkpointKind === checkpointKind),
      createCheckpoint: async (input) => {
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
      listByTurn: async () => options?.toolRuns ?? [],
    },
    chatToolArtifacts: {
      listByTurn: async () => options?.artifacts ?? [],
    },
    chatMessages: {
      get: async (messageId) =>
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
    resolvePostCommitEligibility: async () => ({
      version: 1,
      autonomyEnabledAtParentSettlement: true,
      evalIntegrityTurn: false,
      humanSession: true,
    }),
    recordDurableTimelineEvent: async (runId, eventType, payload) => {
      timelineEvents.push({ runId, eventType, payload });
    },
    chatTurnTraces: {
      patch: async (turnId, patch) => {
        tracePatches.push({ turnId, patch: patch as Record<string, unknown> });
        return { turnId } as unknown as Awaited<ReturnType<ChatDurableRunFinalizeDeps["chatTurnTraces"]["patch"]>>;
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

function buildFinalGeneralSettlement(pending: Record<string, unknown>, completedAt: string): Record<string, unknown> {
  return {
    generationId: pending.generationId,
    traceStatus: pending.traceStatus,
    requestedAt: pending.requestedAt,
    postCommitEligibility: pending.postCommitEligibility,
    parentLocalEffectsStatus: "settled",
    parentLocalEffectsSettledAt: completedAt,
    completedEffects: pending.completedEffects,
    durableEffectRunIds: pending.durableEffectRunIds,
    durableEffectOutcomes: {},
    childOutcomeAuthority: "child_durable_runs",
    settlementStatus: "completed",
    completedAt,
  };
}

function buildExactTestHandoff(
  parentRunId: string,
  postCommitGenerationId: string,
  childRunIds: string[],
  committedAt: string,
): Record<string, unknown> {
  const normalizedChildRunIds = [...new Set(childRunIds)].sort((left, right) => left.localeCompare(right));
  return {
    version: 1,
    admissionId: "admission-1",
    sessionIncarnationId: "incarnation-1",
    turnId: "turn-1",
    parentRunId,
    postCommitGenerationId,
    parentLocalEffectsStatus: "settled",
    childRunIds: normalizedChildRunIds,
    childRunIdsSha256: hashChatTurnRuntimeAuthorityValue(normalizedChildRunIds),
    committedAt,
  };
}
