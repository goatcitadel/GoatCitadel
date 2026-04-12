import { describe, expect, it } from "vitest";
import type {
  ApprovalRequest,
  ChatTurnTraceRecord,
  DurableRunRecord,
  ProactiveRunRecord,
  SessionMeta,
  SessionSummary,
  TaskRecord,
} from "@goatcitadel/contracts";
import { RuntimeLifecycleReadService, type RuntimeLifecycleReadHost } from "./runtime-lifecycle-read-service.js";

function createHost(overrides: Partial<RuntimeLifecycleReadHost> = {}): RuntimeLifecycleReadHost {
  return {
    getApproval: (approvalId) =>
      ({
        approvalId,
        kind: "tool.invoke",
        riskLevel: "danger",
        status: "pending",
        payload: {},
        preview: undefined,
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
        explanationStatus: "not_requested",
      }) as unknown as ApprovalRequest,
    getApprovalWaitRunId: () => undefined,
    getDurableRun: (runId) =>
      ({
        runId,
        workflowKey: "chat.turn.execute",
        status: "running",
        payload: {},
        metadata: {},
        createdAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
        retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000, backoffMultiplier: 2 },
        currentAttempt: 1,
      }) as unknown as DurableRunRecord,
    findDurableRunMaybe: () => undefined,
    findTask: () => undefined,
    getTurnTrace: (turnId) =>
      ({
        turnId,
        sessionId: "session-1",
        userMessageId: "user-1",
        status: "completed",
        mode: "chat",
        startedAt: "2026-04-12T00:00:00.000Z",
        toolRuns: [],
      }) as unknown as ChatTurnTraceRecord,
    listHydratedChatTurnTraces: () => [],
    getSession: (sessionId) =>
      ({
        sessionId,
        sessionKey: "key-1",
        kind: "dm",
        channel: "chat",
        account: "local",
        lastActivityAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
        health: "healthy",
        tokenInput: 0,
        tokenOutput: 0,
        tokenCachedInput: 0,
        tokenTotal: 0,
        costUsdTotal: 0,
        budgetState: "ok",
      }) as unknown as SessionMeta,
    getSessionSummary: async (sessionId) =>
      ({
        sessionId,
        transcript: [],
        turns: [],
      }) as unknown as SessionSummary,
    listChatSessionProactiveRuns: () => [],
    listApprovalEffects: () => [],
    ...overrides,
  };
}

describe("RuntimeLifecycleReadService", () => {
  it("prefers explicit approval linkage over fallback payload fields", async () => {
    const service = new RuntimeLifecycleReadService(
      createHost({
        getApproval: (approvalId) =>
          ({
            approvalId,
            kind: "tool.invoke",
            riskLevel: "danger",
            status: "pending",
            payload: {
              sessionId: "session-fallback",
              turnId: "turn-fallback",
            },
            preview: undefined,
            linkage: {
              sessionId: "session-link",
              taskId: "task-link",
              durableRunId: "run-link",
              proactiveRunId: "proactive-link",
              workspaceId: "workspace-link",
            },
            createdAt: "2026-04-12T00:00:00.000Z",
            updatedAt: "2026-04-12T00:00:00.000Z",
            explanationStatus: "not_requested",
          }) as unknown as ApprovalRequest,
        getDurableRun: (runId) =>
          ({
            runId,
            workflowKey: "approval.wait",
            status: "waiting",
            payload: {},
            metadata: {},
            createdAt: "2026-04-12T00:00:00.000Z",
            updatedAt: "2026-04-12T00:00:00.000Z",
            retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000, backoffMultiplier: 2 },
            currentAttempt: 1,
          }) as unknown as DurableRunRecord,
        findTask: (taskId) =>
          ({
            taskId,
            workspaceId: "workspace-link",
            title: "Task",
            status: "in_progress",
            priority: "normal",
            createdAt: "2026-04-12T00:00:00.000Z",
            updatedAt: "2026-04-12T00:00:00.000Z",
          }) as unknown as TaskRecord,
      }),
    );

    const response = await service.getRuntimeLifecycle({ approvalId: "approval-1" });

    expect(response.query.sessionId).toBe("session-link");
    expect(response.query.runId).toBe("run-link");
    expect(response.query.taskId).toBe("task-link");
    expect(response.resolution).toMatchObject({
      sessionIdSource: "approval_linkage",
      runIdSource: "approval_linkage",
      taskIdSource: "approval_linkage",
    });
    expect(response.linked.turnIds).toContain("turn-fallback");
    expect(response.linked.workspaceIds).toContain("workspace-link");
    expect(response.resolution?.fallbackSources).toContain("fallback_payload");
  });

  it("loads canonical approval and durable records after deriving ids from task context", async () => {
    const service = new RuntimeLifecycleReadService(
      createHost({
        findTask: (taskId) =>
          ({
            taskId,
            workspaceId: "workspace-1",
            title: "Task",
            status: "in_progress",
            priority: "normal",
            proactiveContext: {
              sessionId: "session-1",
              durableRunId: "run-1",
              approvalId: "approval-1",
              proactiveRunId: "proactive-1",
            },
            createdAt: "2026-04-12T00:00:00.000Z",
            updatedAt: "2026-04-12T00:00:00.000Z",
          }) as unknown as TaskRecord,
        getApproval: (approvalId) =>
          ({
            approvalId,
            kind: "tool.invoke",
            riskLevel: "danger",
            status: "pending",
            payload: {},
            preview: undefined,
            createdAt: "2026-04-12T00:00:00.000Z",
            updatedAt: "2026-04-12T00:00:00.000Z",
            explanationStatus: "not_requested",
          }) as unknown as ApprovalRequest,
        getDurableRun: (runId) =>
          ({
            runId,
            workflowKey: "chat.turn.execute",
            status: "running",
            payload: { sessionId: "session-1" },
            metadata: {},
            createdAt: "2026-04-12T00:00:00.000Z",
            updatedAt: "2026-04-12T00:00:00.000Z",
            retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000, backoffMultiplier: 2 },
            currentAttempt: 1,
          }) as unknown as DurableRunRecord,
        listChatSessionProactiveRuns: () => [
          {
            runId: "proactive-1",
            linkedTaskId: "task-1",
            linkedDurableRunId: "run-1",
            approvalId: "approval-1",
          } as ProactiveRunRecord,
        ],
      }),
    );

    const response = await service.getRuntimeLifecycle({ taskId: "task-1" });

    expect(response.query).toMatchObject({
      sessionId: "session-1",
      runId: "run-1",
      approvalId: "approval-1",
      taskId: "task-1",
    });
    expect(response.resolution).toMatchObject({
      sessionIdSource: "task_context",
      runIdSource: "task_context",
      approvalIdSource: "task_context",
    });
    expect(response.approval?.approvalId).toBe("approval-1");
    expect(response.durableRun?.runId).toBe("run-1");
    expect(response.linked.proactiveRunIds).toContain("proactive-1");
  });

  it("marks session provenance as turn_trace when recovered from a queried turn", async () => {
    const service = new RuntimeLifecycleReadService(
      createHost({
        getTurnTrace: (turnId) =>
          ({
            turnId,
            sessionId: "session-turn",
            userMessageId: "user-1",
            status: "completed",
            mode: "chat",
            startedAt: "2026-04-12T00:00:00.000Z",
            durable: { runId: "run-turn" },
            toolRuns: [
              {
                toolRunId: "tool-1",
                turnId,
                sessionId: "session-turn",
                toolName: "shell.exec",
                status: "completed",
                approvalId: "approval-turn",
                startedAt: "2026-04-12T00:00:00.000Z",
                finishedAt: "2026-04-12T00:00:01.000Z",
              },
            ],
          }) as unknown as ChatTurnTraceRecord,
        getApproval: (approvalId) =>
          ({
            approvalId,
            kind: "tool.invoke",
            riskLevel: "danger",
            status: "approved",
            payload: {},
            preview: undefined,
            createdAt: "2026-04-12T00:00:00.000Z",
            updatedAt: "2026-04-12T00:00:00.000Z",
            explanationStatus: "completed",
          }) as unknown as ApprovalRequest,
        getDurableRun: (runId) =>
          ({
            runId,
            workflowKey: "chat.turn.execute",
            status: "completed",
            payload: {},
            metadata: {},
            createdAt: "2026-04-12T00:00:00.000Z",
            updatedAt: "2026-04-12T00:00:00.000Z",
            retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000, backoffMultiplier: 2 },
            currentAttempt: 1,
          }) as unknown as DurableRunRecord,
      }),
    );

    const response = await service.getRuntimeLifecycle({ turnId: "turn-1" });

    expect(response.query.sessionId).toBe("session-turn");
    expect(response.query.runId).toBe("run-turn");
    expect(response.query.approvalId).toBe("approval-turn");
    expect(response.resolution).toMatchObject({
      sessionIdSource: "turn_trace",
      runIdSource: "turn_trace",
      approvalIdSource: "turn_trace",
    });
    expect(response.toolRuns).toHaveLength(1);
  });
});
