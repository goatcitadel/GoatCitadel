import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableRunRecord } from "@goatcitadel/contracts";
vi.mock("@goatcitadel/storage", () => ({}));
vi.mock("sqlite", () => ({}));
vi.mock("./connector-delivery.js", () => ({
  dispatchConnectorDelivery: vi.fn(),
}));
vi.mock("./chat-turn-dispatch-service.js", () => ({
  executePreparedAgentChatTurnBackground: vi.fn(),
}));
import { dispatchConnectorDelivery } from "./connector-delivery.js";
import { executePreparedAgentChatTurnBackground } from "./chat-turn-dispatch-service.js";
import {
  buildDurableChatTurnResumeContent,
  buildDurableWorkflowExecutors,
  createDurableWorkflowExecutorRegistry,
  executeDurableApprovalWaitRun,
  executeDurableChatTurnRun,
  executeDurableConnectorDeliveryRun,
  executeDurableHookDeliveryRun,
  executeDurableWorkflowRun,
  isDurableWorkflowRecoverable,
  markDurableWorkflowUnrecoverable,
  parseApprovalWaitWorkflowPayload,
  parseConnectorDeliveryWorkflowPayload,
  parseDurableChatTurnPayload,
  parseHookDeliveryWorkflowPayload,
  parseOrchestrationWorkflowPayload,
  parseProactiveTickWorkflowPayload,
  type DurableWorkflowExecutorHosts,
} from "./durable-execution-service.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

function buildRun(): DurableRunRecord {
  return {
    runId: "durable-run-1",
    workflowKey: "orchestration.plan.execute",
    status: "queued",
    attemptCount: 0,
    maxAttempts: 3,
    version: 1,
    payload: {
      version: "orchestration.plan.execute.v1",
      orchestrationRunId: "orch-run-1",
      planId: "plan-1",
      workspaceId: "default",
      requestedAt: "2026-04-19T00:00:00.000Z",
    },
    metadata: {
      orchestrationRunId: "orch-run-1",
      worktreePath: "F:/code/personal-ai/.worktrees/orchestration/orch-run-1",
    },
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
  };
}

function createHosts(outcome: "paused" | "completed"): {
  hosts: DurableWorkflowExecutorHosts;
  durableRuns: {
    getRun: ReturnType<typeof vi.fn>;
    updateRun: ReturnType<typeof vi.fn>;
    createCheckpoint: ReturnType<typeof vi.fn>;
  };
  publishRealtime: ReturnType<typeof vi.fn>;
  recordDurableTimelineEvent: ReturnType<typeof vi.fn>;
  executeDurableOrchestrationRun: ReturnType<typeof vi.fn>;
} {
  let storedRun = buildRun();
  const durableRuns = {
    getRun: vi.fn((runId: string) => {
      expect(runId).toBe("durable-run-1");
      return storedRun;
    }),
    updateRun: vi.fn((patch: Record<string, unknown>) => {
      storedRun = {
        ...storedRun,
        ...(patch.status ? { status: patch.status as DurableRunRecord["status"] } : {}),
        ...(patch.updatedAt ? { updatedAt: patch.updatedAt as string } : {}),
        ...(patch.finishedAt ? { finishedAt: patch.finishedAt as string } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError as string | undefined } : {}),
        version: storedRun.version + 1,
      };
      return storedRun;
    }),
    createCheckpoint: vi.fn(),
  };
  const publishRealtime = vi.fn();
  const recordDurableTimelineEvent = vi.fn();
  const executeDurableOrchestrationRun = vi.fn(async () => ({
    outcome,
    checkpointState: {
      orchestrationRunId: "orch-run-1",
      executionState: outcome === "paused" ? "paused_for_approval" : "completed",
      worktreeStatus: "ready",
    },
  }));

  const orchestrationHost = {
    storage: {
      durableRuns,
    },
    publishRealtime,
    recordDurableTimelineEvent,
    executeDurableOrchestrationRun,
    durableRunService: {},
  } as unknown as DurableWorkflowExecutorHosts["orchestration"];

  const inertHost = {} as DurableWorkflowExecutorHosts["memoryMaintenance"];

  return {
    hosts: {
      memoryMaintenance: inertHost,
      chatTurn: {} as DurableWorkflowExecutorHosts["chatTurn"],
      proactiveTick: {} as DurableWorkflowExecutorHosts["proactiveTick"],
      approvalWait: {} as DurableWorkflowExecutorHosts["approvalWait"],
      connectorDelivery: {} as DurableWorkflowExecutorHosts["connectorDelivery"],
      hookDelivery: {} as DurableWorkflowExecutorHosts["hookDelivery"],
      orchestration: orchestrationHost,
    },
    durableRuns,
    publishRealtime,
    recordDurableTimelineEvent,
    executeDurableOrchestrationRun,
  };
}

describe("durable-execution-service orchestration workflow", () => {
  it("validates durable workflow payload parser boundaries", () => {
    expect(
      parseDurableChatTurnPayload(
        buildRunWithPayload("chat.turn.execute", {
          version: "chat.turn.execute.v1",
          sessionId: "session-1",
          turnId: "turn-1",
          userMessageId: "user-1",
          assistantMessageId: "assistant-1",
          branchKind: "new",
          threadEventType: "chat_thread_turn_appended",
          request: { content: "resume" },
        }),
      ),
    ).toEqual(expect.objectContaining({ sessionId: "session-1", turnId: "turn-1" }));
    expect(parseDurableChatTurnPayload(buildRunWithPayload("chat.turn.execute", { version: "wrong" }))).toBeUndefined();

    expect(
      parseApprovalWaitWorkflowPayload(
        buildRunWithPayload("approval.wait", {
          version: "approval.wait.v1",
          approvalId: "approval-1",
          approvalKind: "tool.invoke",
          createdAt: "2026-04-19T00:00:00.000Z",
        }),
      ),
    ).toEqual(expect.objectContaining({ approvalId: "approval-1" }));
    expect(
      parseApprovalWaitWorkflowPayload(buildRunWithPayload("approval.wait", { version: "approval.wait.v1" })),
    ).toBeUndefined();

    expect(
      parseProactiveTickWorkflowPayload(
        buildRunWithPayload("proactive.tick", {
          version: "proactive.tick.v1",
          sessionId: "session-1",
          proactiveRunId: "proactive-1",
          originSurface: "chat",
          triggerSource: "scheduler",
          requestedAt: "2026-04-19T00:00:00.000Z",
          policySnapshot: { mode: "auto_safe" },
        }),
      ),
    ).toEqual(expect.objectContaining({ proactiveRunId: "proactive-1" }));
    expect(
      parseProactiveTickWorkflowPayload(buildRunWithPayload("proactive.tick", { version: "proactive.tick.v1" })),
    ).toBeUndefined();

    expect(
      parseConnectorDeliveryWorkflowPayload(
        buildRunWithPayload("connector.delivery", {
          version: "connector.delivery.v1",
          connectorId: "slack",
          action: "send",
          payload: { channelId: "C1" },
        }),
      ),
    ).toEqual(expect.objectContaining({ connectorId: "slack" }));
    expect(
      parseConnectorDeliveryWorkflowPayload(
        buildRunWithPayload("connector.delivery", {
          version: "connector.delivery.v1",
          connectorId: "slack",
          action: "send",
          payload: ["not", "record"],
        }),
      ),
    ).toBeUndefined();

    expect(
      parseHookDeliveryWorkflowPayload(
        buildRunWithPayload("hook.delivery", {
          version: "hook.delivery.v1",
          hookRunId: "hook-run-1",
          hookId: "hook-1",
          workspaceId: "default",
          trigger: "before_message_write",
          entityType: "chat_turn",
          entityId: "turn-1",
        }),
      ),
    ).toEqual(expect.objectContaining({ hookRunId: "hook-run-1" }));
    expect(
      parseHookDeliveryWorkflowPayload(buildRunWithPayload("hook.delivery", { version: "hook.delivery.v1" })),
    ).toBeUndefined();

    expect(parseOrchestrationWorkflowPayload(buildRun())).toEqual(
      expect.objectContaining({ orchestrationRunId: "orch-run-1" }),
    );
    expect(
      parseOrchestrationWorkflowPayload(
        buildRunWithPayload("orchestration.plan.execute", { version: "orchestration.plan.execute.v1" }),
      ),
    ).toBeUndefined();
  });

  it("reports unsupported workflows as non-recoverable and no-ops unrecoverable marking", async () => {
    const registry = createDurableWorkflowExecutorRegistry({});
    const run = buildRunWithPayload("missing.workflow", { version: "missing.v1" });

    await expect(registry.executeWorkflow(run)).rejects.toThrow("Unsupported durable workflow: missing.workflow");
    expect(registry.isWorkflowRecoverable(run)).toEqual({
      recoverable: false,
      reason: "Unsupported durable workflow: missing.workflow",
    });
    await expect(registry.markWorkflowUnrecoverable(run, "terminal")).resolves.toBeUndefined();
  });

  it("completes resolved approval wait runs and blocks pending approvals", async () => {
    const run = buildRunWithPayload("approval.wait", {
      version: "approval.wait.v1",
      approvalId: "approval-1",
      approvalKind: "tool.invoke",
      createdAt: "2026-04-19T00:00:00.000Z",
    });
    const host = createApprovalWaitHost(run, "pending");

    await expect(executeDurableApprovalWaitRun(host as never, run)).rejects.toThrow("is still pending");

    const completedHost = createApprovalWaitHost(run, "approved");
    await executeDurableApprovalWaitRun(completedHost as never, run);

    expect(completedHost.storage.audit.append).toHaveBeenCalledWith(
      "approvals",
      expect.objectContaining({
        event: "durable.approval_wait.complete",
        approvalId: "approval-1",
        status: "approved",
      }),
    );
    expect(completedHost.storage.durableRuns.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.runId,
        status: "completed",
        clearLease: true,
      }),
    );
    expect(completedHost.publishRealtime).toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({ type: "durable_run_completed", runId: run.runId }),
      expect.objectContaining({
        links: expect.objectContaining({ runId: run.runId }),
      }),
    );

    const wrapperHost = createApprovalWaitHost(run, "approved");
    await executeDurableWorkflowRun(wrapperHost as never, run);
    expect(wrapperHost.storage.durableRuns.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: run.runId, status: "completed" }),
    );

    const controller = new AbortController();
    controller.abort("lease lost");
    await expect(
      executeDurableApprovalWaitRun(createApprovalWaitHost(run, "approved") as never, run, {
        signal: controller.signal,
      }),
    ).rejects.toThrow("lease lost");
  });

  it("marks wrapper workflow types unrecoverable with retained realtime links", async () => {
    const publishRealtime = vi.fn();
    const host = {
      publishRealtime,
      hooksService: {
        markHookRunDeadLettered: vi.fn(),
      },
    };

    await markDurableWorkflowUnrecoverable(
      host as never,
      buildRunWithPayload("approval.wait", {
        version: "approval.wait.v1",
        approvalId: "approval-1",
        approvalKind: "tool.invoke",
        createdAt: "2026-04-19T00:00:00.000Z",
      }),
      "terminal approval wait",
    );
    await markDurableWorkflowUnrecoverable(
      host as never,
      buildRunWithPayload("connector.delivery", {
        version: "connector.delivery.v1",
        connectorId: "slack",
        action: "send",
      }),
      "terminal connector delivery",
    );
    await markDurableWorkflowUnrecoverable(
      host as never,
      buildRunWithPayload("hook.delivery", {
        version: "hook.delivery.v1",
        hookRunId: "hook-run-1",
        hookId: "hook-1",
        workspaceId: "default",
        trigger: "agent_end",
        entityType: "chat_turn",
        entityId: "turn-1",
      }),
      "terminal hook delivery",
    );

    expect(host.hooksService.markHookRunDeadLettered).toHaveBeenCalledWith("hook-run-1", "terminal hook delivery");
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({ reason: "terminal approval wait" }),
      expect.objectContaining({ links: expect.objectContaining({ approvalId: "approval-1" }) }),
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({ reason: "terminal connector delivery" }),
      expect.objectContaining({ links: expect.objectContaining({ connectorId: "slack" }) }),
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({ reason: "terminal hook delivery" }),
      expect.objectContaining({ links: expect.objectContaining({ runId: expect.any(String) }) }),
    );
  });

  it("executes connector delivery runs with retained domain links", async () => {
    vi.mocked(dispatchConnectorDelivery).mockResolvedValue({
      capabilityId: "comms.send",
      dispatchKind: "send",
      result: { delivered: true },
    } as never);
    const run = buildRunWithPayload("connector.delivery", {
      version: "connector.delivery.v1",
      connectorId: "connector-slack",
      action: "send",
      payload: {
        sessionId: " session-1 ",
        turnId: "turn-1",
        proactiveRunId: "proactive-1",
        approvalId: "approval-1",
        taskId: "task-1",
        workspaceId: "workspace-1",
        messageId: "message-1",
      },
    });
    const storedRun = { ...run };
    const updateRun = vi.fn();
    const createCheckpoint = vi.fn();
    const publishRealtime = vi.fn();
    const host = {
      requireConnectorRecord: vi.fn(() => ({
        connectorId: "connector-slack",
        connectorType: "slack",
      })),
      commsSend: vi.fn(),
      commsReply: vi.fn(),
      commsReact: vi.fn(),
      commsUnsend: vi.fn(),
      commsTyping: vi.fn(),
      invokeMcpTool: vi.fn(),
      storage: {
        durableRuns: {
          getRun: vi.fn(() => storedRun),
          updateRun,
          createCheckpoint,
        },
      },
      recordDurableTimelineEvent: vi.fn(),
      publishRealtime,
    };

    await executeDurableConnectorDeliveryRun(host as never, run);

    expect(dispatchConnectorDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: "connector-slack" }),
      expect.objectContaining({ action: "send" }),
      expect.any(Object),
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "connector_delivery_completed",
      "connectors",
      expect.objectContaining({
        runId: run.runId,
        connectorId: "connector-slack",
        connectorType: "slack",
        action: "send",
      }),
      expect.objectContaining({
        links: {
          runId: run.runId,
          connectorId: "connector-slack",
          sessionId: "session-1",
          turnId: "turn-1",
          proactiveRunId: "proactive-1",
          approvalId: "approval-1",
          taskId: "task-1",
          workspaceId: "workspace-1",
          messageId: "message-1",
        },
      }),
    );
    expect(updateRun).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId, status: "completed" }));
    expect(createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.runId,
        state: expect.objectContaining({ connectorId: "connector-slack", dispatchKind: "send" }),
      }),
    );
  });

  it("retries hook delivery runs and dead-letters exhausted hook attempts", async () => {
    vi.useFakeTimers();
    const run = buildRunWithPayload("hook.delivery", {
      version: "hook.delivery.v1",
      hookRunId: "hook-run-1",
      hookId: "hook-1",
      workspaceId: "default",
      trigger: "agent_end",
      entityType: "chat_turn",
      entityId: "turn-1",
    });
    const requestRunProcessing = vi.fn();
    const retryHost = {
      hooksService: {
        executeHookDelivery: vi.fn(async () => {
          throw new Error("temporary hook outage");
        }),
        markHookRunDeadLettered: vi.fn(),
      },
      durableRunService: {
        retryDurableRun: vi.fn(() => ({ ...run, status: "queued", attemptCount: 2 })),
        requestRunProcessing,
      },
      computeDurableRetryDelayMs: vi.fn(() => 25),
    };

    await executeDurableHookDeliveryRun(retryHost as never, run);
    expect(retryHost.hooksService.markHookRunDeadLettered).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    expect(requestRunProcessing).toHaveBeenCalledWith(run.runId);

    const exhaustedHost = {
      hooksService: {
        executeHookDelivery: vi.fn(async () => {
          throw new Error("terminal hook failure");
        }),
        markHookRunDeadLettered: vi.fn(),
      },
      durableRunService: {
        retryDurableRun: vi.fn(() => ({ ...run, status: "failed", attemptCount: 3 })),
        requestRunProcessing: vi.fn(),
      },
      computeDurableRetryDelayMs: vi.fn(),
    };

    await executeDurableHookDeliveryRun(exhaustedHost as never, run);
    expect(exhaustedHost.hooksService.markHookRunDeadLettered).toHaveBeenCalledWith(
      "hook-run-1",
      "terminal hook failure",
    );
  });

  it("resumes durable chat turns and marks interrupted traces unrecoverable", async () => {
    vi.mocked(executePreparedAgentChatTurnBackground).mockResolvedValue(undefined as never);
    const run = buildRunWithPayload("chat.turn.execute", {
      version: "chat.turn.execute.v1",
      sessionId: "session-1",
      turnId: "turn-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      branchKind: "new",
      threadEventType: "chat_thread_turn_appended",
      request: { content: "original" },
      userInputResponses: [
        {
          promptId: "prompt-1",
          kind: "text",
          question: "Clarify the target?",
          answeredAt: "2026-04-19T00:00:01.000Z",
          response: { kind: "text", text: "Use the local gateway." },
        },
      ],
    });
    const prepareAgentChatTurn = vi.fn(async (_sessionId: string, request: Record<string, unknown>) => ({
      turnId: "turn-1",
      branchKind: "new",
      userMessage: { messageId: "user-1", content: request.content },
      assistantMessage: { messageId: "assistant-1", content: "" },
    }));
    const patch = vi.fn();
    const persistChatStreamChunk = vi.fn();
    const host = {
      storage: {
        chatMessages: {
          get: vi.fn(() => ({
            messageId: "user-1",
            sessionId: "session-1",
            role: "user",
            content: "Ship it",
          })),
        },
        chatTurnTraces: {
          get: vi.fn(() => ({
            turnId: "turn-1",
            sessionId: "session-1",
            userMessageId: "user-1",
            completion: { finishReason: "error", repaired: true },
          })),
          patch,
        },
        chatToolRuns: {
          listByTurn: vi.fn(() => []),
        },
      },
      prepareAgentChatTurn,
      registerActiveChatTurnStream: vi.fn(),
      persistChatStreamChunk,
    };

    await executeDurableChatTurnRun(host as never, run);

    expect(prepareAgentChatTurn).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        content: expect.stringContaining("Use the local gateway."),
      }),
      expect.objectContaining({
        ingestUserMessage: false,
        turnId: "turn-1",
        assistantMessageId: "assistant-1",
      }),
    );
    expect(executePreparedAgentChatTurnBackground).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.objectContaining({ content: expect.stringContaining("Resume context") }),
      expect.any(Object),
      "chat_thread_turn_appended",
      run.runId,
      undefined,
      { skipMessageStart: true },
    );

    await markDurableWorkflowUnrecoverable(host as never, run, "operator stopped the run");
    expect(patch).toHaveBeenCalledWith(
      "turn-1",
      expect.objectContaining({
        status: "failed",
        failure: expect.objectContaining({ message: "operator stopped the run" }),
        durable: expect.objectContaining({ runId: run.runId, status: "failed" }),
      }),
    );
    expect(persistChatStreamChunk).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", error: "operator stopped the run" }),
      run.runId,
    );
  });

  it("marks proactive tick workflows unrecoverable with durable and session links", async () => {
    const run = buildRunWithPayload("proactive.tick", {
      version: "proactive.tick.v1",
      sessionId: "session-1",
      proactiveRunId: "proactive-1",
      originSurface: "chat",
      triggerSource: "scheduler",
      requestedAt: "2026-04-19T00:00:00.000Z",
      policySnapshot: { mode: "auto_safe" },
      taskId: "task-1",
    });
    const sqlRun = vi.fn();
    const publishRealtime = vi.fn();
    const host = {
      listChatSessionProactiveRuns: vi.fn(() => [{ runId: "proactive-1" }]),
      gatewaySql: {
        prepare: vi.fn(() => ({ run: sqlRun })),
      },
      publishRealtime,
    };

    await markDurableWorkflowUnrecoverable(host as never, run, "terminal proactive failure");

    expect(sqlRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "proactive-1",
        reason: "terminal proactive failure",
      }),
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({ reason: "terminal proactive failure" }),
      expect.objectContaining({
        links: expect.objectContaining({
          runId: run.runId,
          proactiveRunId: "proactive-1",
          sessionId: "session-1",
          taskId: "task-1",
        }),
      }),
    );
  });

  it("classifies durable chat turn recoverability through the execution-host wrapper", () => {
    const host = {
      storage: {
        chatTurnTraces: {
          get: vi.fn(() => ({
            turnId: "turn-1",
            sessionId: "session-1",
            userMessageId: "user-1",
            assistantMessageId: undefined,
          })),
        },
        chatToolRuns: {
          listByTurn: vi.fn(() => []),
        },
      },
    };
    const run = buildRunWithPayload("chat.turn.execute", {
      version: "chat.turn.execute.v1",
      sessionId: "session-1",
      turnId: "turn-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      branchKind: "new",
      threadEventType: "chat_thread_turn_appended",
      request: { content: "continue" },
    });

    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({ recoverable: true });

    host.storage.chatTurnTraces.get.mockReturnValueOnce({
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
    });
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({
      recoverable: false,
      reason: "Assistant output was already persisted before interruption.",
    });

    host.storage.chatTurnTraces.get.mockReturnValueOnce({
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: undefined,
    });
    host.storage.chatToolRuns.listByTurn.mockReturnValueOnce([{ toolRunId: "tool-1" }]);
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({
      recoverable: false,
      reason: "Durable chat run was interrupted after tool execution began and cannot be safely replayed.",
    });
  });

  it("merges answered user-input prompts into resumed chat content", () => {
    expect(
      buildDurableChatTurnResumeContent("Ship it", [
        {
          promptId: "prompt-1",
          kind: "single_select",
          title: "Choose target",
          question: "Which environment should we deploy to?",
          answeredAt: "2026-04-19T00:00:00.000Z",
          response: { kind: "single_select", optionId: "prod" },
          selectedOption: {
            optionId: "prod",
            label: "Production",
            description: "Deploy to the live environment.",
          },
        },
        {
          promptId: "prompt-2",
          kind: "text",
          question: "Anything else to keep in mind?",
          answeredAt: "2026-04-19T00:00:01.000Z",
          response: { kind: "text", text: "Hold until the migration window opens." },
        },
      ]),
    ).toContain("Resume context from answered blocking prompts:");
    expect(
      buildDurableChatTurnResumeContent("Ship it", [
        {
          promptId: "prompt-1",
          kind: "single_select",
          title: "Choose target",
          question: "Which environment should we deploy to?",
          answeredAt: "2026-04-19T00:00:00.000Z",
          response: { kind: "single_select", optionId: "prod" },
          selectedOption: {
            optionId: "prod",
            label: "Production",
            description: "Deploy to the live environment.",
          },
        },
      ]),
    ).toContain("Answer: Production");
    expect(
      buildDurableChatTurnResumeContent("Ship it", [
        {
          promptId: "prompt-2",
          kind: "text",
          question: "Anything else to keep in mind?",
          answeredAt: "2026-04-19T00:00:01.000Z",
          response: { kind: "text", text: "Hold until the migration window opens." },
        },
      ]),
    ).toContain("Answer: Hold until the migration window opens.");
  });

  it("registers orchestration.plan.execute and leaves paused runs open", async () => {
    const { hosts, durableRuns, executeDurableOrchestrationRun } = createHosts("paused");
    const registry = createDurableWorkflowExecutorRegistry(buildDurableWorkflowExecutors(hosts));
    const run = buildRun();

    await registry.executeWorkflow(run);

    expect(executeDurableOrchestrationRun).toHaveBeenCalledWith(run, undefined);
    expect(durableRuns.updateRun).not.toHaveBeenCalled();
    expect(durableRuns.createCheckpoint).not.toHaveBeenCalled();
  });

  it("completes orchestration.plan.execute runs through the durable registry", async () => {
    const { hosts, durableRuns, publishRealtime, recordDurableTimelineEvent, executeDurableOrchestrationRun } =
      createHosts("completed");
    const registry = createDurableWorkflowExecutorRegistry(buildDurableWorkflowExecutors(hosts));
    const run = buildRun();

    await registry.executeWorkflow(run);

    expect(executeDurableOrchestrationRun).toHaveBeenCalledWith(run, undefined);
    expect(durableRuns.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "durable-run-1",
        status: "completed",
        clearLease: true,
      }),
    );
    expect(durableRuns.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "durable-run-1",
        checkpointKind: "run_completed",
      }),
    );
    expect(recordDurableTimelineEvent).toHaveBeenCalledWith(
      "durable-run-1",
      "run_completed",
      expect.objectContaining({
        orchestrationRunId: "orch-run-1",
      }),
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({
        type: "durable_run_completed",
        runId: "durable-run-1",
      }),
      expect.objectContaining({
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: expect.objectContaining({
          runId: "durable-run-1",
        }),
      }),
    );
  });
});

function buildRunWithPayload(workflowKey: string, payload: Record<string, unknown>): DurableRunRecord {
  return {
    ...buildRun(),
    workflowKey,
    payload,
  };
}

function createApprovalWaitHost(run: DurableRunRecord, status: "pending" | "approved") {
  let storedRun = run;
  return {
    storage: {
      approvals: {
        get: vi.fn(() => ({
          approvalId: "approval-1",
          kind: "tool.invoke",
          status,
          resolvedAt: status === "approved" ? "2026-04-19T00:01:00.000Z" : undefined,
          resolvedBy: status === "approved" ? "operator-1" : undefined,
        })),
      },
      audit: {
        append: vi.fn(async () => undefined),
      },
      durableRuns: {
        getRun: vi.fn(() => storedRun),
        updateRun: vi.fn((patch: Partial<DurableRunRecord> & { clearLease?: boolean }) => {
          storedRun = { ...storedRun, ...patch, version: storedRun.version + 1 };
          return storedRun;
        }),
        createCheckpoint: vi.fn(),
      },
    },
    recordDurableTimelineEvent: vi.fn(),
    publishRealtime: vi.fn(),
  };
}
