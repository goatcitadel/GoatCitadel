import { describe, expect, it } from "vitest";
import type {
  ApprovalRequest,
  ChatDelegationRunRecord,
  ChatDelegationStepRecord,
  ChatExecutionPlanRecord,
  ChatTurnTraceRecord,
  DurableRunRecord,
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
    listChatExecutionPlans: () => [],
    listChatDelegationRuns: () => [],
    listChatDelegationSteps: () => [],
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

function buildPlan(overrides: Partial<ChatExecutionPlanRecord> = {}): ChatExecutionPlanRecord {
  return {
    planId: "plan-1",
    sessionId: "session-1",
    turnId: "turn-1",
    mode: "cowork",
    planningMode: "manual",
    status: "running",
    source: "delegate_request",
    advisoryOnly: false,
    objective: "Plan objective",
    summary: "Plan summary",
    createdAt: "2026-04-12T00:00:00.000Z",
    updatedAt: "2026-04-12T00:00:00.000Z",
    steps: [
      {
        stepId: "step-1",
        index: 0,
        objective: "Plan step",
        parallelizable: false,
        status: "running",
        childRunId: "run-legacy",
        durableRunId: "run-plan",
        childSessionId: "session-child",
        childTurnId: "turn-child",
      },
    ],
    ...overrides,
  };
}

function buildDelegationRun(overrides: Partial<ChatDelegationRunRecord> = {}): ChatDelegationRunRecord {
  return {
    runId: "delegation-1",
    sessionId: "session-1",
    taskId: "task-1",
    objective: "Delegate objective",
    roles: ["architect"],
    mode: "parallel",
    status: "running",
    startedAt: "2026-04-12T00:00:00.000Z",
    citations: [],
    ...overrides,
  };
}

function buildDelegationStep(overrides: Partial<ChatDelegationStepRecord> = {}): ChatDelegationStepRecord {
  return {
    stepId: "delegation-step-1",
    runId: "delegation-1",
    role: "architect",
    status: "completed",
    index: 0,
    startedAt: "2026-04-12T00:00:00.000Z",
    durableRunId: "run-delegation",
    childSessionId: "session-delegate-child",
    childTurnId: "turn-delegate-child",
    ...overrides,
  };
}

describe("RuntimeLifecycleReadService", () => {
  it("prefers execution-plan lineage over fallback payloads and keeps deprecated childRunId as diagnostic only", async () => {
    const service = new RuntimeLifecycleReadService(
      createHost({
        getTurnTrace: (turnId) =>
          ({
            turnId,
            sessionId: "session-1",
            userMessageId: "user-1",
            status: "completed",
            mode: "chat",
            startedAt: "2026-04-12T00:00:00.000Z",
            executionPlanId: "plan-1",
            toolRuns: [],
          }) as unknown as ChatTurnTraceRecord,
        listChatExecutionPlans: () => [buildPlan()],
        findDurableRunMaybe: (runId) =>
          runId === "run-legacy"
            ? ({
                runId,
                workflowKey: "legacy.child",
                status: "completed",
                payload: {},
                metadata: {},
                createdAt: "2026-04-12T00:00:00.000Z",
                updatedAt: "2026-04-12T00:00:00.000Z",
                retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000, backoffMultiplier: 2 },
                currentAttempt: 1,
              }) as unknown as DurableRunRecord
            : undefined,
        getApproval: (approvalId) =>
          ({
            approvalId,
            kind: "tool.invoke",
            riskLevel: "danger",
            status: "pending",
            payload: {
              runId: "run-fallback",
              turnId: "turn-fallback",
            },
            preview: { runId: "run-preview" },
            createdAt: "2026-04-12T00:00:00.000Z",
            updatedAt: "2026-04-12T00:00:00.000Z",
            explanationStatus: "not_requested",
          }) as unknown as ApprovalRequest,
      }),
    );

    const response = await service.getRuntimeLifecycle({ turnId: "turn-1", approvalId: "approval-1" });

    expect(response.query.runId).toBe("run-plan");
    expect(response.query.turnId).toBe("turn-1");
    expect(response.resolution).toMatchObject({
      runIdSource: "execution_plan",
      turnIdSource: "query",
    });
    expect(response.linked.runIds).toEqual(expect.arrayContaining(["run-plan", "run-fallback"]));
    expect(response.executionPlans?.[0]?.steps[0]).toMatchObject({
      durableRunId: "run-plan",
      childRunId: "run-legacy",
      childSessionId: "session-child",
      childTurnId: "turn-child",
    });
    expect(response.resolution?.fallbackSources).toEqual(expect.arrayContaining(["fallback_preview", "fallback_payload"]));
  });

  it("lets turn-trace durable linkage outrank execution-plan linkage when both are present", async () => {
    const service = new RuntimeLifecycleReadService(
      createHost({
        getTurnTrace: (turnId) =>
          ({
            turnId,
            sessionId: "session-1",
            userMessageId: "user-1",
            status: "completed",
            mode: "chat",
            startedAt: "2026-04-12T00:00:00.000Z",
            executionPlanId: "plan-1",
            durable: { runId: "run-turn" },
            toolRuns: [],
          }) as unknown as ChatTurnTraceRecord,
        listChatExecutionPlans: () => [buildPlan()],
      }),
    );

    const response = await service.getRuntimeLifecycle({ turnId: "turn-1" });

    expect(response.query.runId).toBe("run-turn");
    expect(response.resolution?.runIdSource).toBe("turn_trace");
  });

  it("prefers delegation-step canonical linkage over task context and durable payload inference", async () => {
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
              durableRunId: "run-task",
            },
            createdAt: "2026-04-12T00:00:00.000Z",
            updatedAt: "2026-04-12T00:00:00.000Z",
          }) as unknown as TaskRecord,
        listChatDelegationRuns: () => [buildDelegationRun()],
        listChatDelegationSteps: () => [buildDelegationStep()],
        getDurableRun: (runId) =>
          ({
            runId,
            workflowKey: "chat.turn.execute",
            status: "running",
            payload: { sessionId: "session-payload", taskId: "task-payload" },
            metadata: { sessionId: "session-meta" },
            createdAt: "2026-04-12T00:00:00.000Z",
            updatedAt: "2026-04-12T00:00:00.000Z",
            retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000, backoffMultiplier: 2 },
            currentAttempt: 1,
          }) as unknown as DurableRunRecord,
      }),
    );

    const response = await service.getRuntimeLifecycle({ taskId: "task-1" });

    expect(response.query).toMatchObject({
      sessionId: "session-1",
      turnId: "turn-delegate-child",
      runId: "run-delegation",
      taskId: "task-1",
    });
    expect(response.resolution).toMatchObject({
      sessionIdSource: "turn_trace",
      turnIdSource: "turn_trace",
      runIdSource: "delegation_step",
      taskIdSource: "query",
    });
    expect(response.delegationRuns?.[0]?.runId).toBe("delegation-1");
    expect(response.delegationSteps?.[0]).toMatchObject({
      durableRunId: "run-delegation",
      childSessionId: "session-delegate-child",
      childTurnId: "turn-delegate-child",
    });
    expect(response.resolution?.fallbackSources).toEqual(expect.arrayContaining(["fallback_payload", "fallback_metadata"]));
  });

  it("surfaces persisted repair, reuse, and explicit halt metadata without inferring from prose", async () => {
    const service = new RuntimeLifecycleReadService(
      createHost({
        getTurnTrace: (turnId) =>
          ({
            turnId,
            sessionId: "session-1",
            userMessageId: "user-1",
            assistantMessageId: "assistant-1",
            status: "completed",
            mode: "chat",
            startedAt: "2026-04-12T00:00:00.000Z",
            finishedAt: "2026-04-12T00:01:00.000Z",
            completion: {
              status: "complete",
              repaired: true,
              repair: {
                applied: true,
                kind: "degraded_answer_synthesis",
                source: "orchestrator",
                preRepairContent: "bad fallback",
                postRepairContent: "good answer",
              },
            },
            failure: {
              failureClass: "global_circuit_breaker",
              message: "Repeated tool failure for browser.navigate (2 attempts).",
            },
            toolRuns: [
              {
                toolRunId: "tool-1",
                turnId,
                sessionId: "session-1",
                toolName: "browser.navigate",
                status: "executed",
                startedAt: "2026-04-12T00:00:10.000Z",
                finishedAt: "2026-04-12T00:00:12.000Z",
                reused: true,
                reusedFromToolRunId: "tool-0",
                reuseReason: "matching_recent_browser_result",
              },
            ],
          }) as unknown as ChatTurnTraceRecord,
      }),
    );

    const response = await service.getRuntimeLifecycle({ turnId: "turn-1" });

    expect(response.turns[0]).toMatchObject({
      turnId: "turn-1",
      completion: {
        repaired: true,
        repair: expect.objectContaining({
          kind: "degraded_answer_synthesis",
          postRepairContent: "good answer",
        }),
      },
      failure: {
        failureClass: "global_circuit_breaker",
      },
    });
    expect(response.toolRuns[0]).toMatchObject({
      toolRunId: "tool-1",
      reused: true,
      reusedFromToolRunId: "tool-0",
      reuseReason: "matching_recent_browser_result",
    });
  });
});
