import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalRequest,
  ChatTurnTraceRecord,
  ConnectorRecord,
  CuratorTickWorkflowPayload,
  DurableRunRecord,
  ExternalSideEffectReplayWorkflowPayload,
  ExternalSideEffectRunRecord,
} from "@goatcitadel/contracts";
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
  createDurableChatPostCommitEffectWorkflowExecutor,
  createDeferredDurableWorkflowExecutorRegistry,
  createDurableWorkflowExecutorRegistry,
  executeDurableApprovalWaitRun,
  executeDurableChatTurnRun,
  executeGeneralChatPostCommit,
  executeAutonomousChatPostCommit,
  executeDurableConnectorDeliveryRun,
  executeDurableExternalSideEffectReplayRun,
  executeDurableHookDeliveryRun,
  executeDurableWorkflowRun,
  isDurableWorkflowRecoverable,
  markDurableWorkflowUnrecoverable,
  maybeCleanupSilentHeartbeatTurn,
  maybeEnqueueAutonomousDelivery,
  parseAutonomousNotifySignal,
  parseApprovalWaitWorkflowPayload,
  parseCuratorTickWorkflowPayload,
  parseConnectorDeliveryWorkflowPayload,
  parseDurableChatTurnPayload,
  parseExternalSideEffectReplayWorkflowPayload,
  parseGeneralChatPostCommitEffectWorkflowPayload,
  parseHookDeliveryWorkflowPayload,
  parseOrchestrationWorkflowPayload,
  parseProactiveTickWorkflowPayload,
  type DurableWorkflowExecutorHosts,
  type DurableChatPostCommitEffectWorkflowPort,
} from "./durable-execution-service.js";
import { buildApprovalRemoteTokenConnectorDeliveryPayload } from "./approval-connector-delivery.js";
import { ApprovalRemoteTokenSecretService } from "./approval-remote-token-secret.js";
import { buildGatewayExternalSideEffectReplayJob } from "./external-side-effect-replay-job-service.js";
import {
  computeEffectiveChatTurnRequestMaterialSha256,
  computeFrozenChatTurnAdmissionMaterialSha256,
} from "./session-control-service.js";
import {
  buildHeartbeatDecisionReceipt,
  HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY,
  HEARTBEAT_DECISION_RECEIPT_METADATA_KEY,
} from "./chat-durable-runtime-authority.js";
import { IDEMPOTENT_REALTIME_ENVELOPE_KEY } from "./realtime-event-service.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

function buildRun(): DurableRunRecord {
  return {
    runId: "durable-run-1",
    workflowKey: "orchestration.plan.execute",
    status: "running",
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
    leaseOwnerId: "test-claim-1",
    leaseHeartbeatAt: "2026-04-19T00:00:00.000Z",
    leaseExpiresAt: "2099-04-19T00:00:00.000Z",
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
  };
}

function createConnectorDeliveryLedger(options?: {
  failMutationCompletion?: boolean;
  initialMutationStatus?: "pending" | "completed" | "failed";
  initialSideEffectStatus?: ExternalSideEffectRunRecord["status"];
}) {
  let mutationStatus: "pending" | "completed" | "failed" | undefined = options?.initialMutationStatus;
  let mutationRecord: Record<string, string> | undefined;
  let sideEffectRecord: ExternalSideEffectRunRecord | undefined;
  return {
    runImmediateTransaction: <T>(work: () => T): T => {
      const mutationStatusSnapshot = mutationStatus;
      const mutationRecordSnapshot = mutationRecord ? { ...mutationRecord } : undefined;
      const sideEffectRecordSnapshot = sideEffectRecord ? { ...sideEffectRecord } : undefined;
      try {
        return work();
      } catch (error) {
        mutationStatus = mutationStatusSnapshot;
        mutationRecord = mutationRecordSnapshot;
        sideEffectRecord = sideEffectRecordSnapshot;
        throw error;
      }
    },
    mutationIdempotency: {
      claim: vi.fn((input: Record<string, string>) => {
        mutationRecord ??= {
          method: input.method,
          routePath: input.routePath,
          idempotencyKey: input.idempotencyKey,
          actorScope: input.actorScope,
          payloadHash: input.payloadHash,
          createdAt: input.now,
          updatedAt: input.now,
        };
        if (!mutationStatus || mutationStatus === "failed") {
          const claimKind = mutationStatus === "failed" ? "retry_after_failure" : "new";
          mutationStatus = "pending";
          return {
            outcome: "claimed" as const,
            claimKind,
            record: { ...mutationRecord, status: "pending" as const },
          };
        }
        return {
          outcome: mutationStatus === "completed" ? ("duplicate" as const) : ("in_progress" as const),
          record: { ...mutationRecord, status: mutationStatus },
        };
      }),
      markCompleted: vi.fn(() => {
        if (options?.failMutationCompletion) {
          throw new Error("mutation completion unavailable");
        }
        mutationStatus = "completed";
      }),
      markFailed: vi.fn(() => {
        mutationStatus = "failed";
      }),
    },
    externalSideEffectRuns: {
      createOrGet: vi.fn((input: Record<string, unknown>, now: string) => {
        sideEffectRecord ??= {
          runId: "external-side-effect-connector-1",
          workspaceId: (input.workspaceId as string | undefined) ?? "default",
          boundary: input.boundary as string,
          routePath: input.routePath as string,
          catalogId: input.catalogId as string | undefined,
          connectionId: input.connectionId as string | undefined,
          actionId: input.actionId as string | undefined,
          actorScope: input.actorScope as string,
          idempotencyKey: input.idempotencyKey as string,
          payloadHash: input.payloadHash as string,
          status: options?.initialSideEffectStatus ?? (input.status as ExternalSideEffectRunRecord["status"]),
          replayPolicy: "idempotent_external",
          replayOutcome: input.replayOutcome as ExternalSideEffectRunRecord["replayOutcome"],
          replayAttempt: input.replayAttempt as ExternalSideEffectRunRecord["replayAttempt"],
          resumeState:
            (options?.initialSideEffectStatus ?? input.status) === "unknown_external_outcome"
              ? "manual_review_unknown_external_outcome"
              : (options?.initialSideEffectStatus ?? input.status) === "completed"
                ? "completed"
                : "not_resumable",
          attemptCount: 0,
          createdAt: now,
          updatedAt: now,
        };
        return sideEffectRecord;
      }),
      markExternalCallStarted: vi.fn(() => {
        sideEffectRecord = { ...sideEffectRecord!, status: "external_call_started" };
        return sideEffectRecord;
      }),
      markCompleted: vi.fn(() => {
        sideEffectRecord = { ...sideEffectRecord!, status: "completed", resumeState: "completed" };
        return sideEffectRecord;
      }),
      markFailure: vi.fn((_runId, input: { status: ExternalSideEffectRunRecord["status"] }) => {
        sideEffectRecord = {
          ...sideEffectRecord!,
          status: input.status,
          resumeState:
            input.status === "unknown_external_outcome"
              ? "manual_review_unknown_external_outcome"
              : "manual_retry_after_recorded_failure",
        };
        return sideEffectRecord;
      }),
      markFailureIfStatus: vi.fn(
        (
          _runId: string,
          expectedStatus: ExternalSideEffectRunRecord["status"],
          input: { status: ExternalSideEffectRunRecord["status"] },
        ) => {
          if (sideEffectRecord?.status === expectedStatus) {
            sideEffectRecord = {
              ...sideEffectRecord,
              status: input.status,
              resumeState:
                input.status === "unknown_external_outcome"
                  ? "manual_review_unknown_external_outcome"
                  : "manual_retry_after_recorded_failure",
            };
          }
          return sideEffectRecord!;
        },
      ),
      get: vi.fn(() => sideEffectRecord!),
      findByIdempotency: vi.fn((routePath: string, idempotencyKey: string, actorScope: string) =>
        sideEffectRecord?.routePath === routePath &&
        sideEffectRecord.idempotencyKey === idempotencyKey &&
        sideEffectRecord.actorScope === actorScope
          ? sideEffectRecord
          : undefined,
      ),
      listByConnection: vi.fn((connectionId: string) =>
        sideEffectRecord?.connectionId === connectionId ? [sideEffectRecord] : [],
      ),
    },
  };
}

function createConnectorDeliveryRecoveryHarness(
  run: DurableRunRecord,
  commsSend: ReturnType<typeof vi.fn>,
  ledger = createConnectorDeliveryLedger(),
) {
  let currentRun = run;
  const durableRuns = {
    getRun: vi.fn(() => currentRun),
    lockFreshActiveLeaseForUpdate: vi.fn((_runId: string, leaseOwnerId: string) =>
      currentRun.status === "running" && currentRun.leaseOwnerId === leaseOwnerId ? currentRun : undefined,
    ),
    updateRun: vi.fn((input: Record<string, unknown>) => {
      currentRun = {
        ...currentRun,
        status: (input.status as DurableRunRecord["status"] | undefined) ?? currentRun.status,
        version: currentRun.version + 1,
      };
      return currentRun;
    }),
    createCheckpoint: vi.fn(),
  };
  const connector = {
    connectorId: "connector-effect-recovery",
    connectorType: "integration_connection",
    sourceId: "channel-effect-recovery",
    status: "active",
    capabilities: [{ id: "outbound_messages", enabled: true }],
    metadata: {},
  } as unknown as ConnectorRecord;
  const host = {
    requireConnectorRecord: vi.fn(() => connector),
    approvalRemoteTokenSecrets: { resolve: vi.fn(), delete: vi.fn() },
    commsSend,
    commsReply: vi.fn(),
    commsReact: vi.fn(),
    commsUnsend: vi.fn(),
    commsTyping: vi.fn(),
    commsActivity: vi.fn(),
    invokeMcpTool: vi.fn(),
    resolveDurableRunHookWorkspaceId: vi.fn(() => "workspace-effect-recovery"),
    storage: { ...ledger, durableRuns },
    recordDurableTimelineEvent: vi.fn(),
    publishRealtime: vi.fn(),
  };
  return {
    host,
    ledger,
    setCurrentRun(next: DurableRunRecord) {
      currentRun = next;
    },
    getCurrentRun: () => currentRun,
  };
}

function createHosts(outcome: "paused" | "completed" | "failed" | "cancelled"): {
  hosts: DurableWorkflowExecutorHosts;
  durableRuns: {
    getRun: ReturnType<typeof vi.fn>;
    lockFreshActiveLeaseForUpdate: ReturnType<typeof vi.fn>;
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
    lockFreshActiveLeaseForUpdate: vi.fn((runId: string, expectedLeaseOwnerId: string) => {
      expect(runId).toBe("durable-run-1");
      return storedRun.status === "running" && storedRun.leaseOwnerId === expectedLeaseOwnerId ? storedRun : undefined;
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
      ...(outcome === "failed" ? { error: "phase failed" } : {}),
      executionState: outcome === "paused" ? "paused_for_approval" : outcome,
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
      chatPostCommitEffect: {} as DurableWorkflowExecutorHosts["chatPostCommitEffect"],
      proactiveTick: {} as DurableWorkflowExecutorHosts["proactiveTick"],
      approvalWait: {} as DurableWorkflowExecutorHosts["approvalWait"],
      connectorDelivery: {} as DurableWorkflowExecutorHosts["connectorDelivery"],
      hookDelivery: {} as DurableWorkflowExecutorHosts["hookDelivery"],
      orchestration: orchestrationHost,
      externalSideEffectReplay: {} as DurableWorkflowExecutorHosts["externalSideEffectReplay"],
      curatorTick: {} as DurableWorkflowExecutorHosts["curatorTick"],
    },
    durableRuns,
    publishRealtime,
    recordDurableTimelineEvent,
    executeDurableOrchestrationRun,
  };
}

describe("durable Chat post-commit effect workflow", () => {
  it("awaits the effect and validates operator-visible parent/workspace/session/turn linkage", async () => {
    const parentRunId = "parent-post-commit-1";
    const childRunId = "chat-post-commit-child-1";
    const generationId = "generation-post-commit-1";
    const parent = {
      ...buildRunWithPayload("chat.turn.execute", {
        version: "chat.turn.execute.v1",
        workspaceId: "workspace-post-commit-1",
        sessionId: "session-post-commit-1",
        turnId: "turn-post-commit-1",
        userMessageId: "user-post-commit-1",
        assistantMessageId: "assistant-post-commit-1",
        branchKind: "append",
        threadEventType: "chat_thread_turn_appended",
        request: { content: "remember this" },
      }),
      runId: parentRunId,
      status: "completed" as const,
      metadata: {
        generalChatPostCommit: {
          generationId,
          durableEffectRunIds: { commitments: childRunId },
        },
      },
    } satisfies DurableRunRecord;
    let child = {
      ...buildRunWithPayload("chat.post_commit.effect", {
        version: "chat.post_commit.effect.v2",
        parentRunId,
        postCommitGenerationId: generationId,
        effect: "commitments",
        traceStatus: "completed",
        input: {
          effect: "commitments",
          sessionId: "session-post-commit-1",
          workspaceId: "workspace-post-commit-1",
          turnId: "turn-post-commit-1",
          autonomous: false,
        },
        childAdmission: {
          admissionId: "child-admission-post-commit-1",
          sessionIncarnationId: "incarnation:session-post-commit-1",
          workspaceId: "workspace-post-commit-1",
          sessionId: "session-post-commit-1",
          aggregateRevision: 1,
          controllerGeneration: 1,
          actorKind: "operator",
          actorId: "operator:test",
          operation: "chat_post_commit_child",
          materialSha256: "a".repeat(64),
        },
        postCommitEligibility: {
          version: 1,
          autonomyEnabledAtParentSettlement: true,
          evalIntegrityTurn: false,
          humanSession: true,
        },
      }),
      runId: childRunId,
      metadata: {
        parentRunId,
        postCommitGenerationId: generationId,
        effect: "commitments",
        workspaceId: "workspace-post-commit-1",
        sessionId: "session-post-commit-1",
        turnId: "turn-post-commit-1",
        childAdmission: {
          admissionId: "child-admission-post-commit-1",
          sessionIncarnationId: "incarnation:session-post-commit-1",
          workspaceId: "workspace-post-commit-1",
          sessionId: "session-post-commit-1",
          aggregateRevision: 1,
          controllerGeneration: 1,
          actorKind: "operator",
          actorId: "operator:test",
          operation: "chat_post_commit_child",
          materialSha256: "a".repeat(64),
        },
        postCommitEligibility: {
          version: 1,
          autonomyEnabledAtParentSettlement: true,
          evalIntegrityTurn: false,
          humanSession: true,
        },
      },
    } satisfies DurableRunRecord;
    let releaseEffect!: () => void;
    const effectGate = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    const executeEffect = vi.fn(async () => {
      await effectGate;
      return { status: "evaluated" };
    });
    const storage = {
      runImmediateTransaction: <T>(work: () => T): T => work(),
      durableRuns: {
        getRun: vi.fn((runId: string) => (runId === parentRunId ? parent : child)),
        updateRun: vi.fn((input: { status: DurableRunRecord["status"]; updatedAt: string }) => {
          child = { ...child, status: input.status, updatedAt: input.updatedAt, version: child.version + 1 };
          return child;
        }),
        createCheckpoint: vi.fn(),
      },
      chatTurnTraces: {
        get: vi.fn(() => ({
          turnId: "turn-post-commit-1",
          sessionId: "session-post-commit-1",
          assistantMessageId: "assistant-post-commit-1",
          guidance: {
            workspaceId: "workspace-post-commit-1",
            globalFilesUsed: [],
            workspaceFilesUsed: [],
            truncated: false,
          },
        })),
      },
      chatMessages: {
        get: vi.fn((messageId: string) =>
          messageId === "user-post-commit-1"
            ? {
                messageId,
                sessionId: "session-post-commit-1",
                role: "user",
                content: "canonical user text",
              }
            : {
                messageId,
                sessionId: "session-post-commit-1",
                role: "assistant",
                content: "canonical assistant text",
              },
        ),
      },
    };
    const port = {
      storage,
      executeGeneralChatPostCommitDurableEffect: executeEffect,
      publishRealtime: vi.fn(),
      recordDurableTimelineEvent: vi.fn(),
      recordImprovementDurableRunCompletion: vi.fn(),
    } as unknown as DurableChatPostCommitEffectWorkflowPort;
    const inert = {} as DurableWorkflowExecutorHosts["memoryMaintenance"];
    const executors = buildDurableWorkflowExecutors({
      memoryMaintenance: inert,
      chatTurn: {} as DurableWorkflowExecutorHosts["chatTurn"],
      chatPostCommitEffect: createDurableChatPostCommitEffectWorkflowExecutor(port),
      proactiveTick: {} as DurableWorkflowExecutorHosts["proactiveTick"],
      approvalWait: {} as DurableWorkflowExecutorHosts["approvalWait"],
      connectorDelivery: {} as DurableWorkflowExecutorHosts["connectorDelivery"],
      hookDelivery: {} as DurableWorkflowExecutorHosts["hookDelivery"],
      orchestration: {} as DurableWorkflowExecutorHosts["orchestration"],
      externalSideEffectReplay: {} as DurableWorkflowExecutorHosts["externalSideEffectReplay"],
      curatorTick: {} as DurableWorkflowExecutorHosts["curatorTick"],
    });

    const execution = executors["chat.post_commit.effect"]!.execute(child);
    await vi.waitFor(() => expect(executeEffect).toHaveBeenCalledTimes(1));
    expect(child.status).toBe("running");
    expect(executeEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        effect: "commitments",
        userText: "canonical user text",
        assistantText: "canonical assistant text",
        postCommitEligibility: expect.objectContaining({ humanSession: true }),
      }),
      expect.objectContaining({
        effectRunId: childRunId,
        parentRunId,
        generationId,
        postCommitAuthority: expect.objectContaining({
          child: expect.objectContaining({ admissionId: "child-admission-post-commit-1" }),
          childDurableClaim: expect.objectContaining({ durableRunId: childRunId, leaseOwnerId: "test-claim-1" }),
        }),
      }),
    );
    releaseEffect();
    await execution;

    expect(child.status).toBe("completed");
    expect(storage.durableRuns.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: childRunId,
        state: expect.objectContaining({ deliverySemantics: "at_least_once" }),
      }),
    );
  });
});

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
      parseGeneralChatPostCommitEffectWorkflowPayload(
        buildRunWithPayload("chat.post_commit.effect", {
          version: "chat.post_commit.effect.v2",
          parentRunId: "parent-1",
          postCommitGenerationId: "generation-1",
          effect: "memory_maintenance",
          traceStatus: "completed",
          input: {
            effect: "memory_maintenance",
            sessionId: "session-1",
            workspaceId: "workspace-1",
            turnId: "turn-1",
            delegatedChild: false,
          },
          childAdmission: {
            admissionId: "child-admission-1",
            sessionIncarnationId: "incarnation-1",
            workspaceId: "workspace-1",
            sessionId: "session-1",
            aggregateRevision: 1,
            controllerGeneration: 1,
            actorKind: "operator",
            actorId: "operator:test",
            operation: "chat_post_commit_child",
            materialSha256: "b".repeat(64),
          },
          postCommitEligibility: {
            version: 1,
            autonomyEnabledAtParentSettlement: true,
            evalIntegrityTurn: false,
            humanSession: true,
          },
        }),
      ),
    ).toMatchObject({ parentRunId: "parent-1", input: { effect: "memory_maintenance" } });
    expect(
      parseGeneralChatPostCommitEffectWorkflowPayload(
        buildRunWithPayload("chat.post_commit.effect", {
          version: "chat.post_commit.effect.v1",
          parentRunId: "parent-1",
          generationId: "generation-1",
          traceStatus: "completed",
          input: { effect: "memory_maintenance", sessionId: "session-1" },
        }),
      ),
    ).toBeUndefined();

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

    expect(
      parseExternalSideEffectReplayWorkflowPayload(
        buildRunWithPayload("external_side_effect.replay", {
          version: "external_side_effect.replay.v1",
          workspaceId: "default",
          requestedBy: "operator",
          requestedAt: "2026-05-31T00:00:00.000Z",
          runIds: ["extfx_1"],
        }),
      ),
    ).toEqual(expect.objectContaining({ workspaceId: "default", runIds: ["extfx_1"] }));
    expect(
      parseExternalSideEffectReplayWorkflowPayload(
        buildRunWithPayload("external_side_effect.replay", {
          version: "external_side_effect.replay.v1",
          workspaceId: "default",
          requestedBy: "operator",
          requestedAt: "2026-05-31T00:00:00.000Z",
          runIds: [123],
        }),
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

  it("forwards finalization identity and cancellation through the deferred Gateway registry bridge", async () => {
    const finalization = {
      finalizationId: "finalization-bridge-1",
      signal: new AbortController().signal,
    };
    const markWorkflowUnrecoverable = vi.fn(async () => undefined);
    const registry = createDeferredDurableWorkflowExecutorRegistry(() => ({
      executeWorkflow: vi.fn(async () => undefined),
      isWorkflowRecoverable: vi.fn(() => ({ recoverable: true })),
      markWorkflowUnrecoverable,
    }));
    const run = buildRun();

    await registry.markWorkflowUnrecoverable(run, "terminal", finalization);

    expect(markWorkflowUnrecoverable).toHaveBeenCalledWith(run, "terminal", finalization);
  });

  it("honors an aborted finalization before mutating linked workflow state", async () => {
    const markHookRunDeadLettered = vi.fn();
    const publishRealtime = vi.fn();
    const hosts = {
      memoryMaintenance: {} as DurableWorkflowExecutorHosts["memoryMaintenance"],
      chatTurn: {} as DurableWorkflowExecutorHosts["chatTurn"],
      proactiveTick: {} as DurableWorkflowExecutorHosts["proactiveTick"],
      approvalWait: {} as DurableWorkflowExecutorHosts["approvalWait"],
      connectorDelivery: {} as DurableWorkflowExecutorHosts["connectorDelivery"],
      hookDelivery: {
        hooksService: { markHookRunDeadLettered },
        publishRealtime,
      } as unknown as DurableWorkflowExecutorHosts["hookDelivery"],
      orchestration: {} as DurableWorkflowExecutorHosts["orchestration"],
      externalSideEffectReplay: {} as DurableWorkflowExecutorHosts["externalSideEffectReplay"],
      curatorTick: {} as DurableWorkflowExecutorHosts["curatorTick"],
    };
    const registry = createDurableWorkflowExecutorRegistry(buildDurableWorkflowExecutors(hosts));
    const run = buildRunWithPayload("hook.delivery", {
      version: "hook.delivery.v1",
      hookRunId: "hook-run-aborted",
      hookId: "hook-aborted",
      workspaceId: "default",
      trigger: "agent_end",
      entityType: "chat_turn",
      entityId: "turn-aborted",
    });
    const abort = new AbortController();
    const interruption = new Error("finalization ownership moved");
    abort.abort(interruption);

    await expect(
      registry.markWorkflowUnrecoverable(run, "terminal", {
        finalizationId: "finalization-aborted-1",
        signal: abort.signal,
      }),
    ).rejects.toBe(interruption);
    expect(markHookRunDeadLettered).not.toHaveBeenCalled();
    expect(publishRealtime).not.toHaveBeenCalled();

    const liveFinalization = {
      finalizationId: "finalization-live-1",
      signal: new AbortController().signal,
    };
    await registry.markWorkflowUnrecoverable(run, "terminal", liveFinalization);

    expect(markHookRunDeadLettered).toHaveBeenCalledWith("hook-run-aborted", "terminal");
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({
        type: "durable_workflow_unrecoverable",
        finalizationId: liveFinalization.finalizationId,
      }),
      expect.any(Object),
    );
  });

  it("executes external side-effect replay workflows through integration-owned replay jobs only", async () => {
    const run = buildRunWithPayload("external_side_effect.replay", {
      version: "external_side_effect.replay.v1",
      workspaceId: "default",
      requestedBy: "operator",
      requestedAt: "2026-05-31T00:00:00.000Z",
      runIds: ["extfx-retry", "extfx-retry", "extfx-missing"],
    });
    let storedRun = { ...run, status: "running" as const };
    const externalRun: ExternalSideEffectRunRecord = {
      runId: "extfx-retry",
      workspaceId: "default",
      boundary: "integration_operator_action",
      routePath: "external_side_effect:integration_operator_action:automation.activepieces:conn-1:trigger_webhook",
      catalogId: "automation.activepieces",
      connectionId: "conn-1",
      actionId: "trigger_webhook",
      actorScope: "conn-1",
      idempotencyKey: "key-1",
      payloadHash: "802624c9dab98681fc943c66e08422d1619a24739bb2dc703f91877cf4fbc09a",
      status: "failed_before_boundary",
      replayPolicy: "idempotent_external",
      replayOutcome: "claimed",
      replayAttempt: "new",
      resumeState: "manual_retry_after_recorded_failure",
      attemptCount: 1,
      createdAt: "2026-05-31T00:00:00.000Z",
      updatedAt: "2026-05-31T00:00:00.000Z",
    };
    const mutationStore = {
      markFailed: vi.fn(() => true),
      claim: vi
        .fn()
        .mockReturnValueOnce({
          outcome: "claimed",
          claimKind: "retry_after_failure",
          record: {
            method: "POST",
            routePath: externalRun.routePath,
            idempotencyKey: externalRun.idempotencyKey,
            actorScope: externalRun.actorScope,
            payloadHash: externalRun.payloadHash,
            status: "pending",
            claimToken: "durable-replay-claim-1",
            createdAt: externalRun.createdAt,
            updatedAt: externalRun.updatedAt,
          },
        })
        .mockReturnValueOnce({
          outcome: "claimed",
          claimKind: "retry_after_failure",
          record: {
            method: "POST",
            routePath: externalRun.routePath,
            idempotencyKey: externalRun.idempotencyKey,
            actorScope: externalRun.actorScope,
            payloadHash: externalRun.payloadHash,
            status: "pending",
            claimToken: "durable-replay-boundary-2",
            createdAt: externalRun.createdAt,
            updatedAt: externalRun.updatedAt,
          },
        }),
      markCompleted: vi.fn(() => true),
    };
    let currentExternalRun: ExternalSideEffectRunRecord = { ...externalRun };
    const sideEffectRunStore = {
      createOrGet: vi.fn(() => currentExternalRun),
      markExternalCallStarted: vi.fn((_runId, _input, now) => {
        currentExternalRun = {
          ...currentExternalRun,
          status: "external_call_started",
          attemptCount: currentExternalRun.attemptCount + 1,
          updatedAt: now,
        };
        return currentExternalRun;
      }),
      markCompleted: vi.fn((_runId, _input, now) => {
        currentExternalRun = { ...currentExternalRun, status: "completed", updatedAt: now };
        return currentExternalRun;
      }),
      markFailure: vi.fn((_runId, input, now) => {
        currentExternalRun = { ...currentExternalRun, status: input.status, updatedAt: now };
        return currentExternalRun;
      }),
      markFailureIfStatus: vi.fn((_runId, expectedStatus, input, now) => {
        if (currentExternalRun.status === expectedStatus) {
          currentExternalRun = { ...currentExternalRun, status: input.status, updatedAt: now };
        }
        return currentExternalRun;
      }),
    };
    const createCheckpoint = vi.fn();
    const updateRun = vi.fn((patch: Record<string, unknown>) => {
      storedRun = { ...storedRun, status: patch.status as DurableRunRecord["status"], version: storedRun.version + 1 };
      return storedRun;
    });
    const host = {
      storage: {
        durableRuns: {
          getRun: vi.fn(() => storedRun),
          updateRun,
          createCheckpoint,
        },
        externalSideEffectRuns: {
          get: vi.fn((runId: string) => {
            if (runId === "extfx-retry") {
              return externalRun;
            }
            throw new Error(`missing run ${runId}`);
          }),
          listByConnection: vi.fn(),
          listByWorkspace: vi.fn(),
        },
      },
      publishRealtime: vi.fn(),
      recordDurableTimelineEvent: vi.fn(),
      buildExternalSideEffectReplayJob: vi.fn((candidate) => ({
        mutationStore,
        sideEffectRunStore,
        runClaimTransaction: (work) => work(),
        boundary: candidate.boundary,
        catalogId: candidate.catalogId,
        connectionId: candidate.connectionId,
        actionId: candidate.actionId,
        checkedAt: "2026-05-31T00:00:01.000Z",
        idempotencyKey: candidate.idempotencyKey,
        actorScope: candidate.actorScope,
        payload: { replay: true },
        label: "Activepieces replay",
        execute: vi.fn(async (claim) => {
          claim.markExternalCallStarted();
          return { replayed: true };
        }),
      })),
    };

    await executeDurableExternalSideEffectReplayRun(host as never, run);

    expect(mutationStore.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        routePath: externalRun.routePath,
        idempotencyKey: "key-1",
      }),
    );
    expect(host.buildExternalSideEffectReplayJob).toHaveBeenCalledTimes(1);
    expect(mutationStore.markCompleted).toHaveBeenCalledTimes(1);
    expect(updateRun).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId, status: "completed" }));
    expect(createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointKind: "run_completed",
        state: expect.objectContaining({
          workflow: "external_side_effect.replay",
          requestedRunIds: ["extfx-retry", "extfx-retry", "extfx-missing"],
          candidates: 1,
          found: 1,
          missing: 1,
          missingRunIds: ["extfx-missing"],
          executed: 1,
          replayed: 1,
          skipped: 1,
          replayAuditResults: [
            expect.objectContaining({
              runId: "extfx-retry",
              status: "skipped",
              reason: "duplicate_requested_run",
            }),
            expect.objectContaining({
              runId: "extfx-missing",
              status: "not_found",
              reason: "requested_run_missing",
            }),
            expect.objectContaining({
              runId: "extfx-retry",
              status: "executed",
              replayOutcome: "claimed",
              replayAttempt: "retry_after_failure",
            }),
          ],
        }),
      }),
    );
  });

  it("skips crossed-boundary side-effect replay runs when no owning integration job is available", async () => {
    const run = buildRunWithPayload("external_side_effect.replay", {
      version: "external_side_effect.replay.v1",
      workspaceId: "default",
      requestedBy: "operator",
      requestedAt: "2026-05-31T00:00:00.000Z",
      connectionId: "conn-1",
    });
    let storedRun = { ...run, status: "running" as const };
    const updateRun = vi.fn((patch: Record<string, unknown>) => {
      storedRun = { ...storedRun, status: patch.status as DurableRunRecord["status"], version: storedRun.version + 1 };
      return storedRun;
    });
    const createCheckpoint = vi.fn();
    const host = {
      storage: {
        durableRuns: {
          getRun: vi.fn(() => storedRun),
          updateRun,
          createCheckpoint,
        },
        externalSideEffectRuns: {
          get: vi.fn(),
          listByConnection: vi.fn(() => [
            {
              runId: "extfx-started",
              workspaceId: "default",
              boundary: "integration_operator_action",
              routePath:
                "/api/v1/external-side-effects/integration_operator_action/automation.activepieces/conn-1/trigger_webhook",
              catalogId: "automation.activepieces",
              connectionId: "conn-1",
              actionId: "trigger_webhook",
              actorScope: "",
              idempotencyKey: "key-1",
              payloadHash: "hash-1",
              status: "external_call_started",
              replayPolicy: "idempotent_external",
              replayOutcome: "claimed",
              replayAttempt: "new",
              resumeState: "manual_retry_after_recorded_failure",
              attemptCount: 1,
              createdAt: "2026-05-31T00:00:00.000Z",
              updatedAt: "2026-05-31T00:00:00.000Z",
            },
          ]),
          listByWorkspace: vi.fn(),
        },
      },
      publishRealtime: vi.fn(),
      recordDurableTimelineEvent: vi.fn(),
      buildExternalSideEffectReplayJob: vi.fn(),
    };

    await executeDurableExternalSideEffectReplayRun(host as never, run);

    expect(host.buildExternalSideEffectReplayJob).not.toHaveBeenCalled();
    expect(createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          candidates: 1,
          executed: 0,
          skipped: 1,
          results: [
            expect.objectContaining({
              runId: "extfx-started",
              status: "skipped",
              reason: "external_boundary_already_crossed",
            }),
          ],
        }),
      }),
    );
  });

  it("wires the production Activepieces replay job builder end-to-end when the kill switch is off", async () => {
    const run = buildRunWithPayload("external_side_effect.replay", {
      version: "external_side_effect.replay.v1",
      workspaceId: "default",
      requestedBy: "operator",
      requestedAt: "2026-06-01T00:00:00.000Z",
      runIds: ["extfx-activepieces"],
    });
    let storedRun = { ...run, status: "running" as const };
    const externalRun: ExternalSideEffectRunRecord = {
      runId: "extfx-activepieces",
      workspaceId: "default",
      boundary: "integration_operator_action",
      routePath: "external_side_effect:integration_operator_action:automation.activepieces:conn-1:trigger_webhook",
      catalogId: "automation.activepieces",
      connectionId: "conn-1",
      actionId: "trigger_webhook",
      actorScope: "actor-1",
      idempotencyKey: "key-activepieces-1",
      payloadHash: "183a143763547eabd66a12ae7762fb872bb3105cbc4918d8014ec063b308b2c1",
      status: "failed_before_boundary",
      replayPolicy: "idempotent_external",
      replayOutcome: "claimed",
      replayAttempt: "new",
      resumeState: "manual_retry_after_recorded_failure",
      attemptCount: 1,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const updateRun = vi.fn((patch: Record<string, unknown>) => {
      storedRun = { ...storedRun, status: patch.status as DurableRunRecord["status"], version: storedRun.version + 1 };
      return storedRun;
    });
    const createCheckpoint = vi.fn();
    const connection = {
      connectionId: "conn-1",
      catalogId: "automation.activepieces",
      kind: "automation",
      key: "activepieces",
      label: "Activepieces",
      enabled: true,
      status: "connected",
      config: { webhookUrl: "https://activepieces.example.test/hooks/flow-1", defaultFlowId: "flow-1" },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "run-prod-1", message: "flow accepted" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    let currentExternalRun: ExternalSideEffectRunRecord = { ...externalRun };
    const sideEffectRunStore = {
      createOrGet: vi.fn(() => currentExternalRun),
      markExternalCallStarted: vi.fn((_runId, _input, now) => {
        currentExternalRun = {
          ...currentExternalRun,
          status: "external_call_started",
          attemptCount: currentExternalRun.attemptCount + 1,
          updatedAt: now,
        };
        return currentExternalRun;
      }),
      markCompleted: vi.fn((_runId, _input, now) => {
        currentExternalRun = { ...currentExternalRun, status: "completed", updatedAt: now };
        return currentExternalRun;
      }),
      markFailure: vi.fn((_runId, input, now) => {
        currentExternalRun = { ...currentExternalRun, status: input.status, updatedAt: now };
        return currentExternalRun;
      }),
      markFailureIfStatus: vi.fn((_runId, expectedStatus, input, now) => {
        if (currentExternalRun.status === expectedStatus) {
          currentExternalRun = { ...currentExternalRun, status: input.status, updatedAt: now };
        }
        return currentExternalRun;
      }),
    };
    const integrationActionHost = {
      storage: {
        integrationConnections: { get: vi.fn(() => connection) },
        runImmediateTransaction: (work: () => unknown) => work(),
      },
      fetchWithDiagnosticsTimeout: fetchMock,
      readConnectionConfigValue: (config: Record<string, unknown>, key: string) => {
        const value = config[key];
        return typeof value === "string" ? value : undefined;
      },
      resolveConnectionSecret: () => undefined,
      publishRealtime: vi.fn(),
      sideEffectRunStore,
      mutationStore: {
        claim: vi
          .fn()
          .mockReturnValueOnce({
            outcome: "claimed" as const,
            record: {
              method: "POST",
              routePath: externalRun.routePath,
              idempotencyKey: externalRun.idempotencyKey,
              actorScope: externalRun.actorScope,
              payloadHash: "hash",
              status: "pending" as const,
              claimToken: "activepieces-replay-claim-1",
              createdAt: "2026-06-01T00:00:00.000Z",
              updatedAt: "2026-06-01T00:00:00.000Z",
            },
          })
          .mockReturnValueOnce({
            outcome: "claimed" as const,
            claimKind: "retry_after_failure" as const,
            record: {
              method: "POST",
              routePath: externalRun.routePath,
              idempotencyKey: externalRun.idempotencyKey,
              actorScope: externalRun.actorScope,
              payloadHash: "hash",
              status: "pending" as const,
              claimToken: "activepieces-replay-boundary-2",
              createdAt: "2026-06-01T00:00:00.000Z",
              updatedAt: "2026-06-01T00:00:00.000Z",
            },
          }),
        markCompleted: vi.fn(() => true),
        markFailed: vi.fn(() => true),
      },
    };
    const host = {
      storage: {
        durableRuns: {
          getRun: vi.fn(() => storedRun),
          updateRun,
          createCheckpoint,
        },
        externalSideEffectRuns: {
          get: vi.fn((runId: string) => {
            if (runId === "extfx-activepieces") {
              return currentExternalRun;
            }
            throw new Error(`missing run ${runId}`);
          }),
          listByConnection: vi.fn(),
          listByWorkspace: vi.fn(),
        },
      },
      publishRealtime: vi.fn(),
      recordDurableTimelineEvent: vi.fn(),
      // Mirrors the EXACT gateway-service.ts host-block wiring (kill switch
      // off ⇒ delegate to the real production builder against a
      // production-shaped IntegrationActionHost).
      buildExternalSideEffectReplayJob: (
        candidate: ExternalSideEffectRunRecord,
        payload: ExternalSideEffectReplayWorkflowPayload,
      ) => buildGatewayExternalSideEffectReplayJob(integrationActionHost as never, candidate, payload),
    };

    await executeDurableExternalSideEffectReplayRun(host as never, run);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(updateRun).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId, status: "completed" }));
    expect(createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          workflow: "external_side_effect.replay",
          executed: 1,
          replayed: 1,
          skipped: 0,
        }),
      }),
    );
  });

  it("returns job_unavailable for every candidate when the replay job kill switch is on", async () => {
    const run = buildRunWithPayload("external_side_effect.replay", {
      version: "external_side_effect.replay.v1",
      workspaceId: "default",
      requestedBy: "operator",
      requestedAt: "2026-06-01T00:00:00.000Z",
      runIds: ["extfx-activepieces"],
    });
    let storedRun = { ...run, status: "running" as const };
    const externalRun = {
      runId: "extfx-activepieces",
      workspaceId: "default",
      boundary: "integration_operator_action",
      routePath: "external_side_effect:integration_operator_action:automation.activepieces:conn-1:trigger_webhook",
      catalogId: "automation.activepieces",
      connectionId: "conn-1",
      actionId: "trigger_webhook",
      actorScope: "actor-1",
      idempotencyKey: "key-activepieces-1",
      payloadHash: "hash-1",
      status: "failed_before_boundary",
      replayPolicy: "idempotent_external",
      replayOutcome: "claimed",
      replayAttempt: "new",
      resumeState: "manual_retry_after_recorded_failure",
      attemptCount: 1,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const updateRun = vi.fn((patch: Record<string, unknown>) => {
      storedRun = { ...storedRun, status: patch.status as DurableRunRecord["status"], version: storedRun.version + 1 };
      return storedRun;
    });
    const createCheckpoint = vi.fn();
    const host = {
      storage: {
        durableRuns: {
          getRun: vi.fn(() => storedRun),
          updateRun,
          createCheckpoint,
        },
        externalSideEffectRuns: {
          get: vi.fn((runId: string) => {
            if (runId === "extfx-activepieces") {
              return externalRun;
            }
            throw new Error(`missing run ${runId}`);
          }),
          listByConnection: vi.fn(),
          listByWorkspace: vi.fn(),
        },
      },
      publishRealtime: vi.fn(),
      recordDurableTimelineEvent: vi.fn(),
      // Mirrors the EXACT gateway-service.ts host-block wiring with the kill
      // switch on: the hook is called but never reaches the production
      // builder, and always returns undefined.
      buildExternalSideEffectReplayJob: vi.fn(() => undefined),
    };

    await executeDurableExternalSideEffectReplayRun(host as never, run);

    expect(host.buildExternalSideEffectReplayJob).toHaveBeenCalledTimes(1);
    expect(updateRun).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId, status: "completed" }));
    expect(createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          executed: 0,
          skipped: 1,
          results: [
            expect.objectContaining({
              runId: "extfx-activepieces",
              status: "skipped",
              reason: "job_unavailable",
            }),
          ],
        }),
      }),
    );
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

    const transactionOwnedHost = createApprovalWaitHost(run, "approved");
    const transactionState = { calls: 0 };
    Object.assign(transactionOwnedHost.storage, {
      runImmediateTransaction(this: typeof transactionOwnedHost.storage, callback: () => unknown) {
        expect(this).toBe(transactionOwnedHost.storage);
        transactionState.calls += 1;
        return callback();
      },
    });
    await executeDurableApprovalWaitRun(transactionOwnedHost as never, run);
    expect(transactionState.calls).toBe(1);

    const wrapperHost = createApprovalWaitHost(run, "approved");
    await executeDurableWorkflowRun(wrapperHost as never, run);
    expect(wrapperHost.storage.durableRuns.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: run.runId, status: "completed" }),
    );

    const cancelledHost = createApprovalWaitHost({ ...run, status: "cancelled", version: 2 }, "approved");
    await executeDurableApprovalWaitRun(cancelledHost as never, run);
    expect(cancelledHost.storage.durableRuns.updateRun).not.toHaveBeenCalled();
    expect(cancelledHost.storage.durableRuns.createCheckpoint).not.toHaveBeenCalled();
    expect(cancelledHost.recordDurableTimelineEvent).not.toHaveBeenCalled();
    expect(cancelledHost.publishRealtime).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort("lease lost");
    await expect(
      executeDurableApprovalWaitRun(createApprovalWaitHost(run, "approved") as never, run, {
        signal: controller.signal,
      }),
    ).rejects.toThrow("lease lost");
  });

  it("uses the database clock fence when completing despite a fast or slow host clock", async () => {
    const databaseNow = Date.now();
    const payload = {
      version: "approval.wait.v1" as const,
      approvalId: "approval-1",
      approvalKind: "tool.invoke",
      createdAt: new Date(databaseNow).toISOString(),
    };
    const freshRun = {
      ...buildRunWithPayload("approval.wait", payload),
      leaseExpiresAt: new Date(databaseNow + 60_000).toISOString(),
    };
    const fastHost = createApprovalWaitHost(freshRun, "approved");
    fastHost.storage.durableRuns.lockFreshActiveLeaseForUpdate.mockReturnValue(freshRun);
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(databaseNow + 60 * 60 * 1_000);

    await executeDurableApprovalWaitRun(fastHost as never, freshRun);

    expect(fastHost.storage.durableRuns.lockFreshActiveLeaseForUpdate).toHaveBeenCalledWith(
      freshRun.runId,
      freshRun.leaseOwnerId,
    );
    expect(fastHost.storage.durableRuns.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: freshRun.runId, status: "completed" }),
    );

    const expiredRun = {
      ...freshRun,
      leaseExpiresAt: new Date(databaseNow - 60_000).toISOString(),
    };
    const slowHost = createApprovalWaitHost(expiredRun, "approved");
    slowHost.storage.durableRuns.lockFreshActiveLeaseForUpdate.mockReturnValue(undefined);
    dateNow.mockReturnValue(databaseNow - 60 * 60 * 1_000);

    await executeDurableApprovalWaitRun(slowHost as never, expiredRun);

    expect(slowHost.storage.durableRuns.lockFreshActiveLeaseForUpdate).toHaveBeenCalledWith(
      expiredRun.runId,
      expiredRun.leaseOwnerId,
    );
    expect(slowHost.storage.durableRuns.updateRun).not.toHaveBeenCalled();
    expect(slowHost.storage.durableRuns.createCheckpoint).not.toHaveBeenCalled();
    dateNow.mockRestore();
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
    vi.mocked(dispatchConnectorDelivery).mockImplementation(async (_connector, _payload, deps) => {
      deps.markExternalCallStarted?.();
      return {
        capabilityId: "comms.send",
        dispatchKind: "send",
        result: { delivered: true },
      } as never;
    });
    const run = buildRunWithPayload("connector.delivery", {
      version: "connector.delivery.v1",
      connectorId: "connector-slack",
      action: "send",
      workspaceId: "workspace-1",
      taskId: "policy-task-1",
      runId: "policy-run-1",
      operatorId: "operator-1",
      authActorId: "actor-1",
      authActorSource: "loopback",
      permissionProfileId: "profile-safe",
      localOperatorOverrideId: "override-1",
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
      resolveDurableRunHookWorkspaceId: vi.fn(() => "workspace-1"),
      storage: {
        ...createConnectorDeliveryLedger(),
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
      expect.objectContaining({
        mcpInvokeContext: expect.objectContaining({
          workspaceId: "workspace-1",
          taskId: "policy-task-1",
          runId: "policy-run-1",
          permissionProfileId: "profile-safe",
          localOperatorOverrideId: "override-1",
          policyContext: expect.objectContaining({
            operatorId: "operator-1",
            authActorId: "actor-1",
            authActorSource: "loopback",
            permissionProfileId: "profile-safe",
            localOperatorOverrideId: "override-1",
          }),
          consentContext: expect.objectContaining({ operatorId: "operator-1" }),
        }),
      }),
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

  it.each([
    ["generic provider failure", () => new Error("provider timeout after dispatch")],
    [
      "structured post-send failure",
      () =>
        Object.assign(new Error("provider acknowledged then connection dropped"), {
          deliveryStatus: "manual_reconciliation_required",
          providerMessageId: "provider-message-1",
        }),
    ],
  ])("does not replay a connector delivery after %s", async (_label, buildFailure) => {
    const run = buildRunWithPayload("connector.delivery", {
      version: "connector.delivery.v1",
      connectorId: "connector-effect-recovery",
      connectorType: "integration_connection",
      action: "channel.send",
      workspaceId: "workspace-effect-recovery",
      payload: { target: "#ops", message: "ship once" },
    });
    const providerCall = vi.fn(async () => {
      throw buildFailure();
    });
    const harness = createConnectorDeliveryRecoveryHarness(run, providerCall);
    vi.mocked(dispatchConnectorDelivery).mockImplementation(async (_connector, _payload, deps) => {
      deps.markExternalCallStarted?.();
      const result = await deps.commsSend({} as never);
      return {
        capabilityId: "outbound_messages",
        dispatchKind: "integration_channel_send",
        result,
      } as never;
    });

    await expect(executeDurableConnectorDeliveryRun(harness.host as never, run)).rejects.toThrow();

    expect(providerCall).toHaveBeenCalledTimes(1);
    expect(harness.ledger.externalSideEffectRuns.get()).toMatchObject({
      status: "unknown_external_outcome",
      resumeState: "manual_review_unknown_external_outcome",
    });
    expect(isDurableWorkflowRecoverable(harness.host as never, run)).toEqual({
      recoverable: false,
      reason: expect.stringMatching(/automatic replay is blocked.*manual reconciliation is required/i),
    });

    const recoveredRun = { ...run, version: run.version + 1, leaseOwnerId: "recovered-effect-lease" };
    harness.setCurrentRun(recoveredRun);
    await expect(executeDurableConnectorDeliveryRun(harness.host as never, recoveredRun)).rejects.toThrow();
    expect(providerCall).toHaveBeenCalledTimes(1);
  });

  it("keeps a structured delivery refusal retryable when it proves the provider was not dispatched", async () => {
    const run = buildRunWithPayload("connector.delivery", {
      version: "connector.delivery.v1",
      connectorId: "connector-effect-recovery",
      connectorType: "integration_connection",
      action: "channel.send",
      workspaceId: "workspace-effect-recovery",
      payload: { target: "#ops", message: "retry only when safe" },
    });
    const providerCall = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: "blocked",
        policyReason: "destination allowlist refused before provider dispatch",
        auditEventId: "audit-pre-boundary-1",
      })
      .mockResolvedValueOnce({ status: "sent", deliveryStatus: "sent", providerMessageId: "provider-message-2" });
    const harness = createConnectorDeliveryRecoveryHarness(run, providerCall);
    vi.mocked(dispatchConnectorDelivery).mockImplementation(async (_connector, _payload, deps) => {
      deps.markExternalCallStarted?.();
      const result = await deps.commsSend({} as never);
      return {
        capabilityId: "outbound_messages",
        dispatchKind: "integration_channel_send",
        result,
      } as never;
    });

    await expect(executeDurableConnectorDeliveryRun(harness.host as never, run)).rejects.toThrow(
      /destination allowlist refused/i,
    );
    expect(harness.ledger.externalSideEffectRuns.get()).toMatchObject({
      status: "failed_before_boundary",
      resumeState: "manual_retry_after_recorded_failure",
    });
    expect(isDurableWorkflowRecoverable(harness.host as never, run)).toEqual({ recoverable: true });

    const recoveredRun = { ...run, version: run.version + 1, leaseOwnerId: "recovered-safe-retry-lease" };
    harness.setCurrentRun(recoveredRun);
    await expect(executeDurableConnectorDeliveryRun(harness.host as never, recoveredRun)).resolves.toBeUndefined();

    expect(providerCall).toHaveBeenCalledTimes(2);
    expect(harness.ledger.externalSideEffectRuns.get()).toMatchObject({
      status: "completed",
      resumeState: "completed",
    });
    expect(harness.getCurrentRun().status).toBe("completed");
  });

  it.each(["external_call_started", "unknown_external_outcome"] as const)(
    "blocks recovery directly from a persisted %s connector effect",
    async (status) => {
      const run = buildRunWithPayload("connector.delivery", {
        version: "connector.delivery.v1",
        connectorId: "connector-effect-recovery",
        connectorType: "integration_connection",
        action: "channel.send",
        workspaceId: "workspace-effect-recovery",
        payload: { target: "#ops", message: "do not replay" },
      });
      const ledger = createConnectorDeliveryLedger({ initialSideEffectStatus: status });
      ledger.externalSideEffectRuns.createOrGet(
        {
          workspaceId: "workspace-effect-recovery",
          boundary: "durable_connector_delivery",
          routePath:
            "external_side_effect:durable_connector_delivery:connector.integration_connection:connector-effect-recovery:channel.send",
          catalogId: "connector.integration_connection",
          connectionId: "connector-effect-recovery",
          actionId: "channel.send",
          actorScope: "workspace-effect-recovery",
          idempotencyKey: `durable-connector:${run.runId}`,
          payloadHash: "persisted-payload-hash",
          status,
          replayOutcome: "claimed",
        },
        "2026-07-13T00:00:00.000Z",
      );
      const harness = createConnectorDeliveryRecoveryHarness(run, vi.fn(), ledger);

      expect(isDurableWorkflowRecoverable(harness.host as never, run)).toEqual({
        recoverable: false,
        reason: expect.stringMatching(/manual reconciliation is required/i),
      });
      await markDurableWorkflowUnrecoverable(
        harness.host as never,
        run,
        "Provider outcome is ambiguous; manual reconciliation is required.",
      );
      expect(ledger.externalSideEffectRuns.get()).toMatchObject({
        status: "unknown_external_outcome",
        resumeState: "manual_review_unknown_external_outcome",
      });
    },
  );

  it("blocks autonomous connector delivery runs while the autonomy kill switch is engaged", async () => {
    const run = {
      ...buildRunWithPayload("connector.delivery", {
        version: "connector.delivery.v1",
        connectorId: "connector-slack",
        action: "send",
      }),
      metadata: {
        deliveryKind: "autonomous.assistant_message",
        autonomous: true,
      },
    };
    const host = {
      isFeatureEnabled: vi.fn((feature: string) => feature === "autonomyV1Disabled"),
      requireConnectorRecord: vi.fn(),
    };

    await expect(executeDurableConnectorDeliveryRun(host as never, run)).rejects.toThrow(/autonomy kill switch/i);
    expect(host.requireConnectorRecord).not.toHaveBeenCalled();
    expect(dispatchConnectorDelivery).not.toHaveBeenCalled();
  });

  it("preserves approval delivery lineage from real remote-token connector payloads", async () => {
    vi.mocked(dispatchConnectorDelivery).mockImplementation(async (_connector, _payload, deps) => {
      deps.markExternalCallStarted?.();
      return {
        capabilityId: "outbound_messages",
        dispatchKind: "integration_channel_send",
        result: { delivered: true },
      } as never;
    });
    const approval = {
      approvalId: "approval-real-1",
      kind: "tool.invoke",
      riskLevel: "danger",
      status: "pending",
      payload: {
        workspaceId: "workspace-real",
        sessionId: "session-real",
        taskId: "task-real",
        runId: "policy-run-real",
        operatorId: "operator-real",
        authActorId: "actor-real",
        authActorSource: "loopback",
        permissionProfileId: "profile-real",
        localOperatorOverrideId: "override-real",
      },
      preview: {},
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z",
    } as ApprovalRequest;
    const connector = {
      connectorId: "connector-approval",
      connectorType: "integration_connection",
      sourceId: "channel-approval",
      status: "active",
      capabilities: [
        { id: "approvals", enabled: true },
        { id: "outbound_messages", enabled: true },
        { id: "interactive_actions", enabled: true },
      ],
      metadata: {
        approvalDeliveryTarget: "#approvals",
        approvalDeliveryPlatform: "telegram",
        approvalInlineActionsReady: true,
      },
    } as unknown as ConnectorRecord;
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval,
      connector,
      tokenRef: "keychain:goatcitadel:approval-remote-action:token-1",
      tokenId: "token-1",
      expiresAt: "2099-05-18T00:15:00.000Z",
    });
    expect(payload).toBeDefined();
    const run = buildRunWithPayload("connector.delivery", payload!);
    const storedRun = { ...run };
    const publishRealtime = vi.fn();
    const host = {
      requireConnectorRecord: vi.fn(() => connector),
      approvalRemoteTokenSecrets: {
        resolve: vi.fn(() => `grat_${"l".repeat(43)}`),
        delete: vi.fn(),
      },
      commsSend: vi.fn(),
      commsReply: vi.fn(),
      commsReact: vi.fn(),
      commsUnsend: vi.fn(),
      commsTyping: vi.fn(),
      invokeMcpTool: vi.fn(),
      resolveDurableRunHookWorkspaceId: vi.fn(() => "workspace-real"),
      storage: {
        ...createConnectorDeliveryLedger(),
        durableRuns: {
          getRun: vi.fn(() => storedRun),
          updateRun: vi.fn(),
          createCheckpoint: vi.fn(),
        },
      },
      recordDurableTimelineEvent: vi.fn(),
      publishRealtime,
    };

    await executeDurableConnectorDeliveryRun(host as never, run);

    expect(publishRealtime).toHaveBeenCalledWith(
      "connector_delivery_completed",
      "connectors",
      expect.any(Object),
      expect.objectContaining({
        links: expect.objectContaining({
          runId: run.runId,
          connectorId: "connector-approval",
          approvalId: "approval-real-1",
          sessionId: "session-real",
          taskId: "task-real",
          workspaceId: "workspace-real",
        }),
      }),
    );
  });

  it("keeps integration approval templates sealed for the downstream channel queue", async () => {
    const rawToken = `grat_${"i".repeat(43)}`;
    const tokenRef = "keychain:goatcitadel:approval-remote-action:token-integration";
    const connector = {
      connectorId: "connector-approval-buttons",
      connectorType: "integration_connection",
      sourceId: "channel-approval-buttons",
      status: "active",
      capabilities: [
        { id: "approvals", enabled: true },
        { id: "outbound_messages", enabled: true },
        { id: "interactive_actions", enabled: true },
      ],
      metadata: {
        approvalDeliveryTarget: "#approvals",
        approvalDeliveryPlatform: "telegram",
        approvalInlineActionsReady: true,
      },
    } as unknown as ConnectorRecord;
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: {
        approvalId: "approval-integration-buttons",
        kind: "tool.invoke",
        riskLevel: "danger",
        status: "pending",
        payload: {},
        preview: {},
        createdAt: "2026-07-10T00:00:00.000Z",
      } as ApprovalRequest,
      connector,
      tokenRef,
      tokenId: "token-integration",
      expiresAt: "2099-07-10T00:15:00.000Z",
    });
    const run = buildRunWithPayload("connector.delivery", payload!);
    const updateRun = vi.fn(() => ({ ...run, status: "completed" as const }));
    const createCheckpoint = vi.fn();
    const deleteApprovalRemoteActionTokenSecret = vi.fn();
    vi.mocked(dispatchConnectorDelivery).mockImplementation(async (_connector, _payload, deps) => {
      deps.markExternalCallStarted?.();
      return {
        capabilityId: "outbound_messages",
        dispatchKind: "integration_channel_send",
        result: { delivered: true },
      } as never;
    });
    const host = {
      requireConnectorRecord: vi.fn(() => connector),
      approvalRemoteTokenSecrets: {
        resolve: vi.fn(() => rawToken),
        delete: deleteApprovalRemoteActionTokenSecret,
      },
      storage: {
        ...createConnectorDeliveryLedger(),
        durableRuns: {
          getRun: vi.fn(() => run),
          updateRun,
          createCheckpoint,
        },
      },
      recordDurableTimelineEvent: vi.fn(),
      publishRealtime: vi.fn(),
      resolveDurableRunHookWorkspaceId: vi.fn(() => "default"),
    };

    expect(JSON.stringify(run)).not.toContain(rawToken);
    await executeDurableConnectorDeliveryRun(host as never, run);

    expect(dispatchConnectorDelivery).toHaveBeenCalledWith(
      connector,
      expect.objectContaining({
        payload: expect.objectContaining({
          interactiveActionTemplate: {
            platform: "telegram",
            tokenId: "token-integration",
            tokenRef,
            expiresAt: "2099-07-10T00:15:00.000Z",
            buttons: [
              { label: "Approve", decision: "a" },
              { label: "Deny", decision: "r" },
            ],
          },
        }),
      }),
      expect.any(Object),
    );
    const dispatchedPayload = vi.mocked(dispatchConnectorDelivery).mock.calls[0]?.[1];
    expect(dispatchedPayload?.payload?.interactiveActions).toBeUndefined();
    expect(host.approvalRemoteTokenSecrets.resolve).not.toHaveBeenCalled();
    expect(deleteApprovalRemoteActionTokenSecret).not.toHaveBeenCalled();
    expect(JSON.stringify(updateRun.mock.calls)).not.toContain(rawToken);
    expect(JSON.stringify(createCheckpoint.mock.calls)).not.toContain(rawToken);
  });

  it("hydrates browser approval bearer only for live dispatch and keeps durable proof redacted", async () => {
    const rawToken = `grat_${"d".repeat(43)}`;
    const tokenRef = "keychain:goatcitadel:approval-remote-action:token-browser";
    const connector = {
      connectorId: "browser:mission-control",
      connectorType: "browser",
      sourceId: "mission-control-web",
      status: "active",
      capabilities: [
        { id: "approvals", enabled: true },
        { id: "interactive_actions", enabled: true },
      ],
      metadata: {},
    } as unknown as ConnectorRecord;
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: {
        approvalId: "approval-browser",
        kind: "tool.invoke",
        riskLevel: "danger",
        status: "pending",
        payload: {},
        preview: {},
        createdAt: "2026-07-10T00:00:00.000Z",
      } as ApprovalRequest,
      connector,
      tokenRef,
      tokenId: "token-browser",
      expiresAt: "2099-07-10T00:15:00.000Z",
    });
    const run = buildRunWithPayload("connector.delivery", payload!);
    const updateRun = vi.fn(() => ({ ...run, status: "completed" as const }));
    const createCheckpoint = vi.fn();
    const deleteApprovalRemoteActionTokenSecret = vi.fn();
    vi.mocked(dispatchConnectorDelivery).mockImplementation(async (_connector, _payload, deps) => {
      deps.markExternalCallStarted?.();
      return {
        capabilityId: "interactive_actions",
        dispatchKind: "browser_realtime",
        result: { payload: { token: "[REDACTED]" } },
      } as never;
    });
    const host = {
      requireConnectorRecord: vi.fn(() => connector),
      approvalRemoteTokenSecrets: {
        resolve: vi.fn(() => rawToken),
        delete: deleteApprovalRemoteActionTokenSecret,
      },
      storage: {
        ...createConnectorDeliveryLedger(),
        durableRuns: {
          getRun: vi.fn(() => run),
          updateRun,
          createCheckpoint,
        },
      },
      recordDurableTimelineEvent: vi.fn(),
      publishRealtime: vi.fn(),
      resolveDurableRunHookWorkspaceId: vi.fn(() => "default"),
    };

    expect(JSON.stringify(run)).not.toContain(rawToken);
    await executeDurableConnectorDeliveryRun(host as never, run);

    expect(dispatchConnectorDelivery).toHaveBeenCalledWith(
      connector,
      expect.objectContaining({
        payload: expect.objectContaining({
          payload: expect.objectContaining({ token: rawToken }),
        }),
      }),
      expect.any(Object),
    );
    expect(deleteApprovalRemoteActionTokenSecret).toHaveBeenCalledWith(tokenRef);
    expect(JSON.stringify(updateRun.mock.calls)).not.toContain(rawToken);
    expect(JSON.stringify(createCheckpoint.mock.calls)).not.toContain(rawToken);
  });

  it("recovers committed browser delivery without resolving its bearer or dispatching twice", async () => {
    const rawToken = `grat_${"r".repeat(43)}`;
    const tokenRef = "keychain:goatcitadel:approval-remote-action:token-browser-recovery";
    const connector = {
      connectorId: "browser:recovery",
      connectorType: "browser",
      sourceId: "mission-control-web",
      status: "active",
      capabilities: [
        { id: "approvals", enabled: true },
        { id: "interactive_actions", enabled: true },
      ],
      metadata: {},
    } as unknown as ConnectorRecord;
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: {
        approvalId: "approval-browser-recovery",
        kind: "tool.invoke",
        riskLevel: "danger",
        status: "pending",
        payload: {},
        preview: {},
        createdAt: "2026-07-10T00:00:00.000Z",
      } as ApprovalRequest,
      connector,
      tokenRef,
      tokenId: "token-browser-recovery",
      expiresAt: "2099-07-10T00:15:00.000Z",
    })!;
    const firstClaim = buildRunWithPayload("connector.delivery", payload);
    let currentRun = firstClaim;
    let rejectFirstTerminalCommit = true;
    const updateRun = vi.fn((input: Record<string, unknown>) => {
      if (input.status === "completed" && rejectFirstTerminalCommit) {
        rejectFirstTerminalCommit = false;
        throw new Error("durable terminal commit unavailable");
      }
      currentRun = {
        ...currentRun,
        status: (input.status as DurableRunRecord["status"]) ?? currentRun.status,
        version: currentRun.version + 1,
      };
      return currentRun;
    });
    const ledger = createConnectorDeliveryLedger();
    const resolve = vi.fn(() => rawToken);
    const deleteSecret = vi.fn();
    vi.mocked(dispatchConnectorDelivery).mockImplementation(async (_connector, _payload, deps) => {
      deps.markExternalCallStarted?.();
      return {
        capabilityId: "interactive_actions",
        dispatchKind: "browser_realtime",
        result: { delivered: true },
      } as never;
    });
    const host = {
      requireConnectorRecord: vi.fn(() => connector),
      approvalRemoteTokenSecrets: { resolve, delete: deleteSecret },
      storage: {
        ...ledger,
        durableRuns: {
          getRun: vi.fn(() => currentRun),
          updateRun,
          createCheckpoint: vi.fn(),
        },
      },
      recordDurableTimelineEvent: vi.fn(),
      publishRealtime: vi.fn(),
      resolveDurableRunHookWorkspaceId: vi.fn(() => "default"),
    };

    await expect(executeDurableConnectorDeliveryRun(host as never, firstClaim)).rejects.toThrow(
      "durable terminal commit unavailable",
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(deleteSecret).not.toHaveBeenCalled();

    const replacementClaim = {
      ...firstClaim,
      version: firstClaim.version + 1,
      leaseOwnerId: "replacement-claim",
    };
    currentRun = replacementClaim;
    await executeDurableConnectorDeliveryRun(host as never, replacementClaim);

    expect(dispatchConnectorDelivery).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(deleteSecret).toHaveBeenCalledTimes(1);
    expect(currentRun.status).toBe("completed");
  });

  it("recovers from a legacy completed side-effect row while mutation completion is still pending", async () => {
    const connector = {
      connectorId: "connector-ledger-recovery",
      connectorType: "integration_connection",
      sourceId: "channel-ledger-recovery",
      status: "active",
      capabilities: [{ id: "outbound_messages", enabled: true }],
      metadata: {},
    } as unknown as ConnectorRecord;
    const firstClaim = buildRunWithPayload("connector.delivery", {
      version: "connector.delivery.v1",
      connectorId: connector.connectorId,
      connectorType: connector.connectorType,
      action: "channel.send",
      payload: { target: "#ops", message: "ship" },
    });
    let currentRun = firstClaim;
    let rejectFirstTerminalCommit = true;
    const updateRun = vi.fn((input: Record<string, unknown>) => {
      if (input.status === "completed" && rejectFirstTerminalCommit) {
        rejectFirstTerminalCommit = false;
        throw new Error("durable completion unavailable");
      }
      currentRun = {
        ...currentRun,
        status: (input.status as DurableRunRecord["status"]) ?? currentRun.status,
        version: currentRun.version + 1,
      };
      return currentRun;
    });
    const ledger = createConnectorDeliveryLedger({
      initialMutationStatus: "pending",
      initialSideEffectStatus: "completed",
    });
    vi.mocked(dispatchConnectorDelivery).mockImplementation(async (_connector, _payload, deps) => {
      deps.markExternalCallStarted?.();
      return { capabilityId: "outbound_messages", dispatchKind: "integration_channel_send" } as never;
    });
    const host = {
      requireConnectorRecord: vi.fn(() => connector),
      approvalRemoteTokenSecrets: { resolve: vi.fn(), delete: vi.fn() },
      storage: {
        ...ledger,
        durableRuns: {
          getRun: vi.fn(() => currentRun),
          updateRun,
          createCheckpoint: vi.fn(),
        },
      },
      recordDurableTimelineEvent: vi.fn(),
      publishRealtime: vi.fn(),
      resolveDurableRunHookWorkspaceId: vi.fn(() => "default"),
    };

    await expect(executeDurableConnectorDeliveryRun(host as never, firstClaim)).rejects.toThrow(
      "durable completion unavailable",
    );
    const replacementClaim = { ...firstClaim, version: 2, leaseOwnerId: "replacement-ledger-claim" };
    currentRun = replacementClaim;
    await executeDurableConnectorDeliveryRun(host as never, replacementClaim);

    expect(dispatchConnectorDelivery).not.toHaveBeenCalled();
    expect(currentRun.status).toBe("completed");
  });

  it("keeps connector completion committed when retained realtime is unavailable", async () => {
    const connector = {
      connectorId: "connector-realtime-failure",
      connectorType: "integration_connection",
      sourceId: "channel-realtime-failure",
      status: "active",
      capabilities: [{ id: "outbound_messages", enabled: true }],
      metadata: {},
    } as unknown as ConnectorRecord;
    const run = buildRunWithPayload("connector.delivery", {
      version: "connector.delivery.v1",
      connectorId: connector.connectorId,
      connectorType: connector.connectorType,
      action: "channel.send",
      payload: { target: "#ops", message: "ship" },
    });
    let currentRun: DurableRunRecord = run;
    vi.mocked(dispatchConnectorDelivery).mockImplementation(async (_connector, _payload, deps) => {
      deps.markExternalCallStarted?.();
      return { capabilityId: "outbound_messages", dispatchKind: "integration_channel_send" } as never;
    });
    const updateRun = vi.fn((input: Record<string, unknown>) => {
      currentRun = { ...currentRun, status: input.status as DurableRunRecord["status"], version: 2 };
      return currentRun;
    });
    const host = {
      requireConnectorRecord: vi.fn(() => connector),
      approvalRemoteTokenSecrets: { resolve: vi.fn(), delete: vi.fn() },
      storage: {
        ...createConnectorDeliveryLedger(),
        durableRuns: { getRun: vi.fn(() => currentRun), updateRun, createCheckpoint: vi.fn() },
      },
      recordDurableTimelineEvent: vi.fn(),
      publishRealtime: vi.fn(() => {
        throw new Error("retained stream unavailable");
      }),
      resolveDurableRunHookWorkspaceId: vi.fn(() => "default"),
    };

    await expect(executeDurableConnectorDeliveryRun(host as never, run)).resolves.toBeUndefined();
    expect(currentRun.status).toBe("completed");
    expect(dispatchConnectorDelivery).toHaveBeenCalledTimes(1);
  });

  it("fails an expired approval connector delivery before hydrating or dispatching its bearer", async () => {
    const tokenRef = "keychain:goatcitadel:approval-remote-action:token-expired";
    const payload = {
      version: "connector.delivery.v1" as const,
      connectorId: "browser:mission-control",
      connectorType: "browser",
      action: "realtime.emit",
      approvalAction: {
        tokenId: "token-expired",
        expiresAt: "2020-07-10T00:15:00.000Z",
      },
      secretRefs: { approvalActionToken: tokenRef },
      payload: { eventType: "approval_remote_action_ready", payload: { approvalId: "approval-expired" } },
    };
    const run = buildRunWithPayload("connector.delivery", payload);
    const updateRun = vi.fn();
    const createCheckpoint = vi.fn();
    const expirePendingAtOrBefore = vi.fn(() => ({ state: "expired" }));
    const deleteApprovalRemoteActionTokenSecret = vi.fn();
    const requireConnectorRecord = vi.fn();
    const publishRealtime = vi.fn(() => {
      throw new Error("retained stream unavailable");
    });
    const host = {
      requireConnectorRecord,
      approvalRemoteTokenSecrets: {
        resolve: vi.fn(),
        delete: deleteApprovalRemoteActionTokenSecret,
      },
      storage: {
        durableRuns: {
          getRun: vi.fn(() => run),
          updateRun,
          createCheckpoint,
        },
        remoteActionTokens: { expirePendingAtOrBefore },
      },
      recordDurableTimelineEvent: vi.fn(),
      publishRealtime,
    };

    await executeDurableConnectorDeliveryRun(host as never, run);

    expect(deleteApprovalRemoteActionTokenSecret).toHaveBeenCalledWith(tokenRef);
    expect(expirePendingAtOrBefore).toHaveBeenCalledWith("token-expired", expect.any(String));
    expect(requireConnectorRecord).not.toHaveBeenCalled();
    expect(dispatchConnectorDelivery).not.toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.runId,
        status: "failed",
        lastError: "Approval remote-action delivery expired before dispatch.",
      }),
    );
    expect(createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointKind: "run_failed",
        state: expect.objectContaining({ deliveryStatus: "expired", tokenId: "token-expired" }),
      }),
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "connector_delivery_expired",
      "connectors",
      expect.objectContaining({ tokenId: "token-expired" }),
      expect.any(Object),
    );
  });

  it("dispatches a database-fresh approval token even when the host clock is far ahead", async () => {
    const payload = {
      version: "connector.delivery.v1" as const,
      connectorId: "connector-fast-clock",
      connectorType: "integration_connection",
      action: "channel.send",
      approvalAction: { tokenId: "token-fast-clock", expiresAt: "2026-07-11T23:59:00.000Z" },
      payload: { target: "#approvals", message: "approve" },
    };
    const run = buildRunWithPayload("connector.delivery", payload);
    const updateRun = vi.fn((input: Record<string, unknown>) => ({
      ...run,
      status: input.status as DurableRunRecord["status"],
      version: run.version + 1,
    }));
    const findPendingFresh = vi.fn(() => ({
      tokenId: payload.approvalAction.tokenId,
      state: "pending",
      connectorId: payload.connectorId,
      expiresAt: payload.approvalAction.expiresAt,
    }));
    vi.mocked(dispatchConnectorDelivery).mockImplementation(async (_connector, _payload, deps) => {
      deps.markExternalCallStarted?.();
      return { capabilityId: "outbound_messages", dispatchKind: "integration_channel_send" } as never;
    });
    const host = {
      requireConnectorRecord: vi.fn(() => ({
        connectorId: payload.connectorId,
        connectorType: payload.connectorType,
        capabilities: [{ id: "outbound_messages", enabled: true }],
      })),
      approvalRemoteTokenSecrets: { resolve: vi.fn(), delete: vi.fn() },
      storage: {
        ...createConnectorDeliveryLedger(),
        remoteActionTokens: {
          findPendingFresh,
          get: vi.fn(),
          expirePendingIfExpired: vi.fn(),
          expirePendingAtOrBefore: vi.fn(),
        },
        durableRuns: {
          getRun: vi.fn(() => run),
          lockFreshActiveLeaseForUpdate: vi.fn(() => run),
          updateRun,
          createCheckpoint: vi.fn(),
        },
      },
      recordDurableTimelineEvent: vi.fn(),
      publishRealtime: vi.fn(),
      resolveDurableRunHookWorkspaceId: vi.fn(() => "default"),
    };
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2100-07-11T00:00:00.000Z"));

    await executeDurableConnectorDeliveryRun(host as never, run);

    expect(findPendingFresh).toHaveBeenCalledWith(payload.approvalAction.tokenId);
    expect(dispatchConnectorDelivery).toHaveBeenCalledTimes(1);
    expect(updateRun).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
    dateNow.mockRestore();
  });

  it("does not dispatch a database-expired approval token when the host clock is far behind", async () => {
    const payload = {
      version: "connector.delivery.v1" as const,
      connectorId: "connector-slow-clock",
      connectorType: "integration_connection",
      action: "channel.send",
      approvalAction: { tokenId: "token-slow-clock", expiresAt: "2099-07-11T23:59:00.000Z" },
      payload: { target: "#approvals", message: "approve" },
    };
    const run = buildRunWithPayload("connector.delivery", payload);
    const updateRun = vi.fn((input: Record<string, unknown>) => ({
      ...run,
      status: input.status as DurableRunRecord["status"],
      version: run.version + 1,
    }));
    const expirePendingIfExpired = vi.fn(() => ({
      tokenId: payload.approvalAction.tokenId,
      state: "expired",
      connectorId: payload.connectorId,
      expiresAt: payload.approvalAction.expiresAt,
    }));
    const host = {
      requireConnectorRecord: vi.fn(() => ({
        connectorId: payload.connectorId,
        connectorType: payload.connectorType,
        capabilities: [{ id: "outbound_messages", enabled: true }],
      })),
      approvalRemoteTokenSecrets: { resolve: vi.fn(), delete: vi.fn() },
      storage: {
        ...createConnectorDeliveryLedger(),
        remoteActionTokens: {
          findPendingFresh: vi.fn(() => undefined),
          get: vi.fn(() => ({
            tokenId: payload.approvalAction.tokenId,
            state: "pending",
            connectorId: payload.connectorId,
            expiresAt: payload.approvalAction.expiresAt,
          })),
          expirePendingIfExpired,
        },
        durableRuns: {
          getRun: vi.fn(() => run),
          lockFreshActiveLeaseForUpdate: vi.fn(() => run),
          updateRun,
          createCheckpoint: vi.fn(),
        },
      },
      recordDurableTimelineEvent: vi.fn(),
      publishRealtime: vi.fn(),
      resolveDurableRunHookWorkspaceId: vi.fn(() => "default"),
    };
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2000-07-11T00:00:00.000Z"));

    await executeDurableConnectorDeliveryRun(host as never, run);

    expect(expirePendingIfExpired).toHaveBeenCalledWith(payload.approvalAction.tokenId);
    expect(dispatchConnectorDelivery).not.toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        lastError: "Approval remote-action delivery expired before dispatch.",
      }),
    );
    dateNow.mockRestore();
  });

  it("leaves an expired token pending until failed keychain cleanup can be reconciled", async () => {
    const tokenId = "token-expired-retry";
    const tokenRef = `keychain:goatcitadel:approval-remote-action:${tokenId}`;
    const payload = {
      version: "connector.delivery.v1" as const,
      connectorId: "browser:mission-control",
      connectorType: "browser",
      action: "realtime.emit",
      approvalAction: { tokenId, expiresAt: "2020-07-10T00:15:00.000Z" },
      secretRefs: { approvalActionToken: tokenRef },
      payload: { eventType: "approval_remote_action_ready", payload: { approvalId: "approval-expired-retry" } },
    };
    const run = buildRunWithPayload("connector.delivery", payload);
    let tokenState = "pending";
    let secretPresent = true;
    const deleteSecret = vi.fn(() => {
      if (deleteSecret.mock.calls.length === 1) {
        throw new Error("keychain temporarily unavailable");
      }
      secretPresent = false;
    });
    const tokens = {
      listPendingExpired: vi.fn(() => (tokenState === "pending" ? [{ tokenId }] : [])),
      expirePendingIfExpired: vi.fn(() => {
        tokenState = "expired";
        return { state: tokenState };
      }),
      expirePendingAtOrBefore: vi.fn(() => ({ state: tokenState })),
    };
    const tokenSecrets = new ApprovalRemoteTokenSecretService(
      { setSecret: vi.fn(), getSecret: vi.fn(), deleteSecret } as never,
      tokens as never,
      () => new Date("2026-07-10T12:00:00.000Z"),
    );
    const updateRun = vi.fn();
    const createCheckpoint = vi.fn();
    const host = {
      requireConnectorRecord: vi.fn(),
      approvalRemoteTokenSecrets: {
        resolve: vi.fn(),
        delete: (secretRef: string) => tokenSecrets.delete(secretRef),
      },
      storage: {
        durableRuns: { getRun: vi.fn(() => run), updateRun, createCheckpoint },
        remoteActionTokens: tokens,
      },
      recordDurableTimelineEvent: vi.fn(),
      publishRealtime: vi.fn(),
    };

    await executeDurableConnectorDeliveryRun(host as never, run);

    expect(tokenState).toBe("pending");
    expect(secretPresent).toBe(true);
    expect(tokens.expirePendingIfExpired).not.toHaveBeenCalled();
    expect(createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ state: expect.objectContaining({ secretCleanupPending: true }) }),
    );

    expect(tokenSecrets.reconcileExpired()).toBe(1);
    expect(secretPresent).toBe(false);
    expect(tokenState).toBe("expired");
    expect(deleteSecret).toHaveBeenCalledTimes(2);
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
        scheduleRunningWorkflowRetry: vi.fn(() => ({ ...run, status: "queued", attemptCount: 2 })),
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
        scheduleRunningWorkflowRetry: vi.fn(() => ({ ...run, status: "dead_lettered", attemptCount: 3 })),
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

  it("finalizes a terminal durable chat trace after lease takeover without rerunning the turn", async () => {
    const run = {
      ...buildRunWithPayload("chat.turn.execute", {
        version: "chat.turn.execute.v1",
        sessionId: "session-recovered",
        turnId: "turn-recovered",
        userMessageId: "user-recovered",
        assistantMessageId: "assistant-recovered",
        branchKind: "new",
        threadEventType: "chat_thread_turn_appended",
        request: { content: "finish the durable turn" },
      }),
      attemptCount: 1,
      leaseOwnerId: "replacement-worker",
      leaseHeartbeatAt: "2026-07-11T00:00:00.000Z",
      leaseExpiresAt: "2099-07-11T00:05:00.000Z",
    } satisfies DurableRunRecord;
    const userMessage = {
      messageId: "user-recovered",
      sessionId: "session-recovered",
      role: "user",
      content: "finish the durable turn",
    };
    const assistantMessage = {
      messageId: "assistant-recovered",
      sessionId: "session-recovered",
      role: "assistant",
      content: "The committed answer.",
    };
    const terminalTrace = {
      turnId: "turn-recovered",
      sessionId: "session-recovered",
      userMessageId: "user-recovered",
      assistantMessageId: "assistant-recovered",
      status: "completed",
      completion: { status: "complete", finishReason: "stop", repaired: false },
      durable: { runId: run.runId, status: "running" },
    } as ChatTurnTraceRecord;
    const prepared = {
      turnId: "turn-recovered",
      assistantMessageId: "assistant-recovered",
      userMessage,
      content: userMessage.content,
    };
    let currentRun = run;
    const finalizeDurableChatRun = vi.fn(() => {
      currentRun = {
        ...currentRun,
        status: "completed",
        leaseOwnerId: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
      };
    });
    let generalPostCommitPending = true;
    const enqueueAgentEnd = vi.fn();
    const persistLearnedMemory = vi.fn();
    const scheduleMaintenance = vi.fn();
    const reconcileGeneralChatPostCommit = vi.fn(async () => {
      if (!generalPostCommitPending) {
        return true;
      }
      enqueueAgentEnd();
      persistLearnedMemory();
      scheduleMaintenance();
      generalPostCommitPending = false;
      return true;
    });
    const reconcileAutonomousChatPostCommit = vi.fn(async () => true);
    const host = {
      storage: {
        chatMessages: {
          get: vi.fn((messageId: string) =>
            messageId === userMessage.messageId
              ? userMessage
              : messageId === assistantMessage.messageId
                ? assistantMessage
                : undefined,
          ),
        },
        chatTurnTraces: {
          get: vi.fn(() => terminalTrace),
        },
        durableRuns: {
          getRun: vi.fn(() => currentRun),
        },
      },
      prepareAgentChatTurn: vi.fn(async () => prepared),
      registerActiveChatTurnStream: vi.fn(),
      finalizeDurableChatRun,
      reconcileGeneralChatPostCommit,
      reconcileAutonomousChatPostCommit,
      persistChatStreamChunk: vi.fn(),
    };

    await executeDurableChatTurnRun(withTestDurableAdmissionOwner(host) as never, run);
    await executeDurableChatTurnRun(withTestDurableAdmissionOwner(host) as never, run);

    expect(finalizeDurableChatRun).toHaveBeenCalledWith(run.runId, prepared, terminalTrace, "replacement-worker");
    expect(reconcileGeneralChatPostCommit).toHaveBeenCalledTimes(2);
    expect(enqueueAgentEnd).toHaveBeenCalledTimes(1);
    expect(persistLearnedMemory).toHaveBeenCalledTimes(1);
    expect(scheduleMaintenance).toHaveBeenCalledTimes(1);
    expect(reconcileAutonomousChatPostCommit).toHaveBeenCalledWith(run.runId);
    expect(reconcileAutonomousChatPostCommit.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileGeneralChatPostCommit.mock.invocationCallOrder[0]!,
    );
    expect(host.registerActiveChatTurnStream).not.toHaveBeenCalled();
    expect(executePreparedAgentChatTurnBackground).not.toHaveBeenCalled();
  });

  it("rejects an active durable Chat run whose fetched user message belongs to another session", async () => {
    vi.mocked(executePreparedAgentChatTurnBackground).mockResolvedValue(undefined as never);
    const run = buildRunWithPayload("chat.turn.execute", {
      version: "chat.turn.execute.v1",
      sessionId: "session-owned",
      turnId: "turn-owned",
      userMessageId: "user-cross-session",
      assistantMessageId: "assistant-owned",
      branchKind: "new",
      threadEventType: "chat_thread_turn_appended",
      request: { content: "Do not dispatch with foreign transcript state." },
    });
    const prepareAgentChatTurn = vi.fn(async () => ({
      turnId: "turn-owned",
      userMessage: { messageId: "user-cross-session", content: "foreign" },
      assistantMessageId: "assistant-owned",
    }));
    const host = {
      storage: {
        chatMessages: {
          get: vi.fn(() => ({
            messageId: "user-cross-session",
            sessionId: "session-other",
            role: "user",
            content: "foreign transcript content",
          })),
        },
        chatTurnTraces: { get: vi.fn(() => undefined) },
      },
      prepareAgentChatTurn,
      registerActiveChatTurnStream: vi.fn(() => ({
        registrationId: "stream-cross-session",
        sessionId: "session-owned",
        turnId: "turn-owned",
        runId: run.runId,
      })),
      persistChatStreamChunk: vi.fn(),
    };

    await expect(executeDurableChatTurnRun(withTestDurableAdmissionOwner(host) as never, run)).rejects.toThrow(
      /linked user message/i,
    );

    expect(prepareAgentChatTurn).not.toHaveBeenCalled();
    expect(host.registerActiveChatTurnStream).not.toHaveBeenCalled();
    expect(executePreparedAgentChatTurnBackground).not.toHaveBeenCalled();
  });

  it("rejects an active Chat trace explicitly linked to a different durable run", async () => {
    vi.mocked(executePreparedAgentChatTurnBackground).mockResolvedValue(undefined as never);
    const run = buildRunWithPayload("chat.turn.execute", {
      version: "chat.turn.execute.v1",
      sessionId: "session-run-link",
      turnId: "turn-run-link",
      userMessageId: "user-run-link",
      assistantMessageId: "assistant-run-link",
      branchKind: "new",
      threadEventType: "chat_thread_turn_appended",
      request: { content: "Keep durable ownership exact." },
    });
    const userMessage = {
      messageId: "user-run-link",
      sessionId: "session-run-link",
      role: "user",
      content: "Keep durable ownership exact.",
    };
    const host = {
      storage: {
        chatMessages: { get: vi.fn(() => userMessage) },
        chatTurnTraces: {
          get: vi.fn(
            () =>
              ({
                turnId: "turn-run-link",
                sessionId: "session-run-link",
                userMessageId: "user-run-link",
                assistantMessageId: "assistant-run-link",
                status: "running",
                durable: { runId: "durable-run-other", status: "running" },
              }) as ChatTurnTraceRecord,
          ),
        },
      },
      prepareAgentChatTurn: vi.fn(async () => ({
        turnId: "turn-run-link",
        userMessage,
        assistantMessageId: "assistant-run-link",
      })),
      registerActiveChatTurnStream: vi.fn(() => ({
        registrationId: "stream-run-link",
        sessionId: "session-run-link",
        turnId: "turn-run-link",
        runId: run.runId,
      })),
      persistChatStreamChunk: vi.fn(),
    };

    await expect(executeDurableChatTurnRun(withTestDurableAdmissionOwner(host) as never, run)).rejects.toThrow(
      /durable run linkage/i,
    );

    expect(host.prepareAgentChatTurn).not.toHaveBeenCalled();
    expect(host.registerActiveChatTurnStream).not.toHaveBeenCalled();
    expect(executePreparedAgentChatTurnBackground).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled"] as const)(
    "finalizes a %s durable Chat trace without assistant output instead of replaying the provider",
    async (status) => {
      const run = {
        ...buildRunWithPayload("chat.turn.execute", {
          version: "chat.turn.execute.v1",
          sessionId: "session-terminal-no-assistant",
          turnId: `turn-terminal-${status}`,
          userMessageId: "user-terminal-no-assistant",
          assistantMessageId: "assistant-terminal-not-written",
          branchKind: "new",
          threadEventType: "chat_thread_turn_appended",
          request: { content: "Stop before assistant persistence." },
        }),
        leaseOwnerId: "replacement-worker",
      } satisfies DurableRunRecord;
      const userMessage = {
        messageId: "user-terminal-no-assistant",
        sessionId: "session-terminal-no-assistant",
        role: "user",
        content: "Stop before assistant persistence.",
      };
      const trace = {
        turnId: `turn-terminal-${status}`,
        sessionId: "session-terminal-no-assistant",
        userMessageId: userMessage.messageId,
        assistantMessageId: "assistant-terminal-not-written",
        status,
        branchKind: "new",
        toolRuns: [],
      } as ChatTurnTraceRecord;
      const prepared = {
        turnId: trace.turnId,
        assistantMessageId: "assistant-terminal-not-written",
        userMessage,
        content: userMessage.content,
      };
      let currentRun = run;
      const finalizeDurableChatRun = vi.fn(() => {
        currentRun = { ...currentRun, status, leaseOwnerId: undefined };
      });
      const reconcileGeneralChatPostCommit = vi.fn(async () => true);
      const host = {
        storage: {
          chatMessages: {
            get: vi.fn((messageId: string) => (messageId === userMessage.messageId ? userMessage : undefined)),
          },
          chatTurnTraces: { get: vi.fn(() => trace) },
          chatToolRuns: { listByTurn: vi.fn(() => []) },
          durableRuns: { getRun: vi.fn(() => currentRun) },
        },
        prepareAgentChatTurn: vi.fn(async () => prepared),
        registerActiveChatTurnStream: vi.fn(),
        finalizeDurableChatRun,
        reconcileGeneralChatPostCommit,
        reconcileAutonomousChatPostCommit: vi.fn(async () => true),
        persistChatStreamChunk: vi.fn(),
      };

      await executeDurableChatTurnRun(withTestDurableAdmissionOwner(host) as never, run);

      expect(finalizeDurableChatRun).toHaveBeenCalledWith(run.runId, prepared, trace, "replacement-worker");
      expect(reconcileGeneralChatPostCommit).toHaveBeenCalledWith(run.runId);
      expect(host.registerActiveChatTurnStream).not.toHaveBeenCalled();
      expect(executePreparedAgentChatTurnBackground).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      status: "waiting_for_approval" as const,
      pendingUserInput: undefined,
      toolRuns: [
        {
          toolRunId: "tool-waiting-approval",
          turnId: "turn-waiting",
          sessionId: "session-waiting",
          toolName: "shell.exec",
          status: "approval_required" as const,
          approvalId: "approval-waiting",
          startedAt: "2026-07-11T00:00:00.000Z",
        },
      ],
    },
    {
      status: "waiting_for_user_input" as const,
      pendingUserInput: {
        promptId: "prompt-waiting",
        turnId: "turn-waiting",
        kind: "text" as const,
        question: "Which deployment target should I use?",
      },
      toolRuns: [],
    },
  ])("parks a recovered $status trace and reconciles its status hook without provider replay", async (fixture) => {
    const run = {
      ...buildRunWithPayload("chat.turn.execute", {
        version: "chat.turn.execute.v1",
        sessionId: "session-waiting",
        turnId: "turn-waiting",
        userMessageId: "user-waiting",
        assistantMessageId: "assistant-waiting-not-written",
        branchKind: "new",
        threadEventType: "chat_thread_turn_appended",
        request: { content: "Pause for operator input." },
      }),
      leaseOwnerId: "replacement-worker",
    } satisfies DurableRunRecord;
    const userMessage = {
      messageId: "user-waiting",
      sessionId: "session-waiting",
      role: "user",
      content: "Pause for operator input.",
    };
    const trace = {
      turnId: "turn-waiting",
      sessionId: "session-waiting",
      userMessageId: userMessage.messageId,
      assistantMessageId: "assistant-waiting-not-written",
      branchKind: "new",
      status: fixture.status,
      pendingUserInput: fixture.pendingUserInput,
      toolRuns: fixture.toolRuns,
    } as ChatTurnTraceRecord;
    const prepared = {
      turnId: trace.turnId,
      assistantMessageId: "assistant-waiting-not-written",
      userMessage,
      content: userMessage.content,
    };
    let currentRun = run;
    const finalizeDurableChatRun = vi.fn(() => {
      currentRun = { ...currentRun, status: "waiting", leaseOwnerId: undefined };
    });
    let waitingAgentEndPending = true;
    const enqueueWaitingAgentEnd = vi.fn();
    const reconcileGeneralChatPostCommit = vi.fn(async () => {
      if (waitingAgentEndPending) {
        enqueueWaitingAgentEnd();
        waitingAgentEndPending = false;
      }
      return true;
    });
    const host = {
      storage: {
        chatMessages: {
          get: vi.fn((messageId: string) => (messageId === userMessage.messageId ? userMessage : undefined)),
        },
        chatTurnTraces: { get: vi.fn(() => trace) },
        chatToolRuns: { listByTurn: vi.fn(() => fixture.toolRuns) },
        durableRuns: { getRun: vi.fn(() => currentRun) },
      },
      prepareAgentChatTurn: vi.fn(async () => prepared),
      registerActiveChatTurnStream: vi.fn(),
      finalizeDurableChatRun,
      reconcileGeneralChatPostCommit,
      reconcileAutonomousChatPostCommit: vi.fn(async () => true),
      persistChatStreamChunk: vi.fn(),
    };

    await executeDurableChatTurnRun(withTestDurableAdmissionOwner(host) as never, run);
    await executeDurableChatTurnRun(withTestDurableAdmissionOwner(host) as never, run);

    expect(finalizeDurableChatRun).toHaveBeenCalledWith(run.runId, prepared, trace, "replacement-worker");
    expect(reconcileGeneralChatPostCommit).toHaveBeenCalledTimes(2);
    expect(enqueueWaitingAgentEnd).toHaveBeenCalledTimes(1);
    expect(host.registerActiveChatTurnStream).not.toHaveBeenCalled();
    expect(executePreparedAgentChatTurnBackground).not.toHaveBeenCalled();
  });

  it("reconciles the canonical general Chat post-commit consumers from persisted truth", () => {
    const run = {
      ...buildRunWithPayload("chat.turn.execute", {
        version: "chat.turn.execute.v1",
        sessionId: "session-post-commit",
        turnId: "turn-post-commit",
        userMessageId: "user-post-commit",
        assistantMessageId: "assistant-post-commit",
        parentTurnId: "turn-previous",
        branchKind: "append",
        threadEventType: "chat_thread_turn_appended",
        request: { content: "Remember this and follow up." },
      }),
      status: "completed",
      metadata: {
        generalChatPostCommitPending: { version: 1, requestedAt: "2026-07-11T00:00:00.000Z" },
      },
    } satisfies DurableRunRecord;
    const userMessage = {
      messageId: "user-post-commit",
      sessionId: "session-post-commit",
      role: "user",
      content: "Remember this and follow up.",
    };
    const assistantMessage = {
      messageId: "assistant-post-commit",
      sessionId: "session-post-commit",
      role: "assistant",
      content: "I will remember and follow up.",
    };
    const terminalTrace = {
      turnId: "turn-post-commit",
      sessionId: "session-post-commit",
      userMessageId: "user-post-commit",
      assistantMessageId: "assistant-post-commit",
      parentTurnId: "turn-previous",
      branchKind: "append",
      status: "completed",
      completion: { status: "complete", repaired: false },
      guidance: { workspaceId: "workspace-1", globalFilesUsed: [], workspaceFilesUsed: [], truncated: false },
      routing: { primaryProviderId: "openai", primaryModel: "gpt-5.4" },
      toolRuns: [],
      citations: [],
    } as ChatTurnTraceRecord;
    const enqueueAfterHooks = vi.fn();
    const host = {
      storage: {
        chatMessages: {
          get: vi.fn((messageId: string) =>
            messageId === userMessage.messageId
              ? userMessage
              : messageId === assistantMessage.messageId
                ? assistantMessage
                : undefined,
          ),
        },
        chatTurnTraces: { get: vi.fn(() => terminalTrace) },
        chatToolRuns: { listByTurn: vi.fn(() => []) },
      },
      hooksService: { runInlineHooks: vi.fn(), enqueueAfterHooks },
      recordCapabilityGapFromTrace: vi.fn(),
      extractAndPersistLearnedMemory: vi.fn(),
      recordTurnCommitments: vi.fn(),
      scheduleBackgroundReviewIfDue: vi.fn(),
      scheduleMemoryMaintenancePostTurnEvaluation: vi.fn(),
      scheduleChatMemoryContextPrewarm: vi.fn(),
      publishRealtime: vi.fn(),
    };

    expect(() => executeGeneralChatPostCommit(host as never, run)).toThrow(/canonical durable progress owner/);
    expect(host.recordCapabilityGapFromTrace).not.toHaveBeenCalled();
    expect(host.extractAndPersistLearnedMemory).not.toHaveBeenCalled();
    expect(host.recordTurnCommitments).not.toHaveBeenCalled();
    expect(host.scheduleBackgroundReviewIfDue).not.toHaveBeenCalled();
    expect(host.scheduleMemoryMaintenancePostTurnEvaluation).not.toHaveBeenCalled();

    expect(() =>
      executeGeneralChatPostCommit(host as never, run, {
        generationId: "generation-stale-wait",
        requestedAt: "2026-07-11T00:00:00.000Z",
        targetTraceStatus: "waiting_for_approval",
        completedEffects: [],
        runEffect: vi.fn(),
        publishEffect: vi.fn(),
        enqueueDurableEffect: vi.fn(),
      }),
    ).toThrow(/targets waiting_for_approval, but the canonical trace is completed/);
    expect(host.recordCapabilityGapFromTrace).not.toHaveBeenCalled();

    const enqueueDurableEffect = vi.fn((input: { effect: string }) => `durable-child-${input.effect}`);
    const result = executeGeneralChatPostCommit(host as never, run, {
      generationId: "generation-post-commit",
      requestedAt: "2026-07-11T00:00:00.000Z",
      targetTraceStatus: "completed",
      completedEffects: [],
      runEffect: vi.fn((_effect, callback) => {
        callback();
        return true;
      }),
      publishEffect: vi.fn((_effect, callback) => {
        callback();
        return true;
      }),
      enqueueDurableEffect,
    });

    expect(host.recordCapabilityGapFromTrace).toHaveBeenCalledTimes(1);
    expect(host.extractAndPersistLearnedMemory).not.toHaveBeenCalled();
    expect(host.recordTurnCommitments).not.toHaveBeenCalled();
    expect(enqueueDurableEffect).toHaveBeenCalledTimes(3);
    expect(enqueueDurableEffect).toHaveBeenCalledWith(
      expect.objectContaining({ effect: "background_review", turnId: "turn-post-commit", delegatedChild: false }),
    );
    expect(enqueueDurableEffect).toHaveBeenCalledWith(
      expect.objectContaining({ effect: "memory_maintenance", turnId: "turn-post-commit", delegatedChild: false }),
    );
    expect(host.scheduleBackgroundReviewIfDue).not.toHaveBeenCalled();
    expect(host.scheduleMemoryMaintenancePostTurnEvaluation).not.toHaveBeenCalled();
    expect(host.publishRealtime).toHaveBeenCalledTimes(1);
    expect(enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "agent_end",
        entityId: "turn-post-commit",
        idempotencyDiscriminator: "completed",
      }),
    );
    expect(result).toMatchObject({
      turnId: "turn-post-commit",
      agentEnd: "reconciled",
      learnedMemory: {
        user: "not_applicable",
        assistant: "not_applicable",
      },
      commitments: "durably_enqueued",
      backgroundReview: "durably_enqueued",
      memoryMaintenance: "durably_enqueued",
    });
  });

  it.each([
    { rawOutput: '{"notify":false}', notify: false },
    {
      rawOutput: '{"notify":true,"message":"  Rotate the backup secret now.  "}',
      notify: true,
    },
  ])(
    "publishes one deterministic content-free Chat invalidation only when a system heartbeat notify decision is $notify",
    ({ rawOutput, notify }) => {
      const base = buildExactSystemHeartbeatRun();
      const payload = parseDurableChatTurnPayload(base)!;
      const decision = buildHeartbeatDecisionReceipt({
        occurrenceId: String((base.payload as Record<string, unknown>).heartbeatOccurrenceId),
        claimSha256: String((base.payload as Record<string, unknown>).heartbeatClaimSha256),
        rawOutput,
      });
      const run = {
        ...base,
        status: "completed" as const,
        metadata: {
          ...(base.metadata ?? {}),
          [HEARTBEAT_DECISION_RECEIPT_METADATA_KEY]: decision.receipt,
          [HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY]: rawOutput,
        },
      };
      const trace = {
        turnId: payload.turnId,
        sessionId: payload.sessionId,
        userMessageId: payload.userMessageId,
        assistantMessageId: payload.assistantMessageId,
        status: "completed",
        completion: { status: "complete", repaired: false },
        routing: {},
        toolRuns: [],
        citations: [],
      } as ChatTurnTraceRecord;
      const assistantMessage = notify
        ? {
            messageId: payload.assistantMessageId,
            sessionId: payload.sessionId,
            role: "assistant",
            actorType: "system",
            actorId: "system-heartbeat",
            content: "Rotate the backup secret now.",
          }
        : undefined;
      const publishRealtime = vi.fn();
      const host = {
        storage: {
          chatMessages: {
            get: vi.fn((messageId: string) =>
              messageId === payload.assistantMessageId ? assistantMessage : undefined,
            ),
          },
          chatTurnTraces: { get: vi.fn(() => trace) },
          chatToolRuns: { listByTurn: vi.fn(() => []) },
        },
        hooksService: { runInlineHooks: vi.fn(), enqueueAfterHooks: vi.fn() },
        recordCapabilityGapFromTrace: vi.fn(),
        extractAndPersistLearnedMemory: vi.fn(),
        recordTurnCommitments: vi.fn(),
        scheduleBackgroundReviewIfDue: vi.fn(),
        scheduleMemoryMaintenancePostTurnEvaluation: vi.fn(),
        scheduleChatMemoryContextPrewarm: vi.fn(),
        publishRealtime,
      };
      const publishEffect = vi.fn((_effect, callback: () => void) => {
        callback();
        return true;
      });
      const progress = {
        generationId: "heartbeat-generation-1",
        requestedAt: "2026-07-11T00:00:00.000Z",
        targetTraceStatus: "completed" as const,
        completedEffects: [],
        runEffect: vi.fn((_effect, callback: () => void) => {
          callback();
          return true;
        }),
        publishEffect,
        enqueueDurableEffect: vi.fn(),
      };

      const first = executeGeneralChatPostCommit(host as never, run, progress);
      const second = executeGeneralChatPostCommit(host as never, run, progress);

      if (!notify) {
        expect(first.realtime).toBe("not_applicable");
        expect(second.realtime).toBe("not_applicable");
        expect(publishEffect).not.toHaveBeenCalled();
        expect(publishRealtime).not.toHaveBeenCalled();
        return;
      }

      expect(first.realtime).toBe("reconciled");
      expect(second.realtime).toBe("reconciled");
      expect(publishEffect).toHaveBeenCalledTimes(2);
      expect(publishRealtime).toHaveBeenCalledTimes(2);
      const firstPublish = publishRealtime.mock.calls[0];
      const replayPublish = publishRealtime.mock.calls[1];
      expect(replayPublish).toEqual(firstPublish);
      expect(firstPublish).toEqual([
        "chat_heartbeat_message_committed",
        "chat",
        {
          type: "chat_heartbeat_message_committed",
          sessionId: payload.sessionId,
          turnId: payload.turnId,
          assistantMessageId: payload.assistantMessageId,
          occurrenceId: "heartbeat-occurrence-1",
          [IDEMPOTENT_REALTIME_ENVELOPE_KEY]: {
            deliveryId: `${run.runId}:heartbeat-generation-1:heartbeat-message:${payload.assistantMessageId}`,
            occurredAt: "2026-07-11T00:00:00.000Z",
          },
        },
        {
          eventClass: "domain_fact",
          eventAuthority: "retained_stream",
          links: {
            sessionId: payload.sessionId,
            turnId: payload.turnId,
            runId: run.runId,
          },
        },
      ]);
      const publicPayload = JSON.stringify(firstPublish);
      expect(publicPayload).not.toContain(rawOutput);
      expect(publicPayload).not.toContain("Rotate the backup secret now.");
      expect(publicPayload).not.toContain("activeLeafTurnId");
    },
  );

  it.each(["failed", "cancelled"] as const)(
    "reconciles a %s Chat trace without assistant output as agent-end only",
    (status) => {
      const run = {
        ...buildRunWithPayload("chat.turn.execute", {
          version: "chat.turn.execute.v1",
          sessionId: "session-no-assistant",
          turnId: `turn-${status}`,
          userMessageId: "user-no-assistant",
          assistantMessageId: "assistant-not-written",
          branchKind: "append",
          threadEventType: "chat_thread_turn_appended",
          request: { content: "This turn stops before an assistant message." },
        }),
        status,
        metadata: {
          generalChatPostCommitPending: { version: 1, requestedAt: "2026-07-11T00:00:00.000Z" },
        },
      } satisfies DurableRunRecord;
      const userMessage = {
        messageId: "user-no-assistant",
        sessionId: "session-no-assistant",
        role: "user",
        content: "This turn stops before an assistant message.",
      };
      const trace = {
        turnId: `turn-${status}`,
        sessionId: "session-no-assistant",
        userMessageId: "user-no-assistant",
        assistantMessageId: "assistant-not-written",
        branchKind: "append",
        status,
        mode: "chat",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        startedAt: "2026-07-11T00:00:00.000Z",
        finishedAt: "2026-07-11T00:00:01.000Z",
        routing: {},
        toolRuns: [],
        citations: [],
      } as ChatTurnTraceRecord;
      const enqueueAfterHooks = vi.fn();
      const host = {
        storage: {
          chatMessages: {
            get: vi.fn((messageId: string) => (messageId === userMessage.messageId ? userMessage : undefined)),
          },
          chatTurnTraces: { get: vi.fn(() => trace) },
          chatToolRuns: { listByTurn: vi.fn(() => []) },
        },
        hooksService: { runInlineHooks: vi.fn(), enqueueAfterHooks },
        recordCapabilityGapFromTrace: vi.fn(),
        extractAndPersistLearnedMemory: vi.fn(),
        recordTurnCommitments: vi.fn(),
        scheduleBackgroundReviewIfDue: vi.fn(),
        scheduleMemoryMaintenancePostTurnEvaluation: vi.fn(),
        scheduleChatMemoryContextPrewarm: vi.fn(),
        publishRealtime: vi.fn(),
      };

      const result = executeGeneralChatPostCommit(
        host as never,
        run,
        buildTestPostCommitProgress(status, `generation-${status}`),
      );

      expect(enqueueAfterHooks).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: "agent_end",
          entityId: `turn-${status}`,
          idempotencyDiscriminator: status,
        }),
      );
      expect(host.recordCapabilityGapFromTrace).not.toHaveBeenCalled();
      expect(host.extractAndPersistLearnedMemory).not.toHaveBeenCalled();
      expect(host.recordTurnCommitments).not.toHaveBeenCalled();
      expect(host.scheduleBackgroundReviewIfDue).not.toHaveBeenCalled();
      expect(host.scheduleMemoryMaintenancePostTurnEvaluation).not.toHaveBeenCalled();
      expect(host.scheduleChatMemoryContextPrewarm).not.toHaveBeenCalled();
      expect(host.publishRealtime).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        status,
        agentEnd: "reconciled",
        capabilityGap: "not_applicable",
        realtime: "not_applicable",
      });
    },
  );

  it.each(["failed", "cancelled"] as const)(
    "does not treat the payload assistant fallback as %s transcript evidence",
    (status) => {
      const run = {
        ...buildRunWithPayload("chat.turn.execute", {
          version: "chat.turn.execute.v1",
          sessionId: "session-fallback-owner",
          turnId: `turn-fallback-${status}`,
          userMessageId: "user-fallback-owner",
          assistantMessageId: "assistant-payload-fallback",
          branchKind: "append",
          threadEventType: "chat_thread_turn_appended",
          request: { content: "Do not ingest unrelated assistant text." },
        }),
        status,
        metadata: {
          generalChatPostCommitPending: { version: 1, requestedAt: "2026-07-11T00:00:00.000Z" },
        },
      } satisfies DurableRunRecord;
      const userMessage = {
        messageId: "user-fallback-owner",
        sessionId: "session-fallback-owner",
        role: "user",
        content: "Do not ingest unrelated assistant text.",
      };
      const foreignAssistant = {
        messageId: "assistant-payload-fallback",
        sessionId: "session-other",
        role: "assistant",
        content: "Foreign assistant memory that must not cross sessions.",
      };
      const trace = {
        turnId: `turn-fallback-${status}`,
        sessionId: "session-fallback-owner",
        userMessageId: userMessage.messageId,
        assistantMessageId: undefined,
        branchKind: "append",
        status,
        mode: "chat",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        startedAt: "2026-07-11T00:00:00.000Z",
        routing: {},
        toolRuns: [],
        citations: [],
      } as ChatTurnTraceRecord;
      const host = {
        storage: {
          chatMessages: {
            get: vi.fn((messageId: string) =>
              messageId === userMessage.messageId
                ? userMessage
                : messageId === foreignAssistant.messageId
                  ? foreignAssistant
                  : undefined,
            ),
          },
          chatTurnTraces: { get: vi.fn(() => trace) },
          chatToolRuns: { listByTurn: vi.fn(() => []) },
        },
        hooksService: { runInlineHooks: vi.fn(), enqueueAfterHooks: vi.fn() },
        recordCapabilityGapFromTrace: vi.fn(),
        extractAndPersistLearnedMemory: vi.fn(),
        recordTurnCommitments: vi.fn(),
        scheduleBackgroundReviewIfDue: vi.fn(),
        scheduleMemoryMaintenancePostTurnEvaluation: vi.fn(),
        scheduleChatMemoryContextPrewarm: vi.fn(),
        publishRealtime: vi.fn(),
      };

      const result = executeGeneralChatPostCommit(
        host as never,
        run,
        buildTestPostCommitProgress(status, `generation-fallback-${status}`),
      );

      expect(host.extractAndPersistLearnedMemory).not.toHaveBeenCalled();
      expect(host.recordCapabilityGapFromTrace).not.toHaveBeenCalled();
      expect(host.scheduleChatMemoryContextPrewarm).not.toHaveBeenCalled();
      expect(host.publishRealtime).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        status,
        learnedMemory: { user: "not_applicable", assistant: "not_applicable" },
      });
    },
  );

  it("reconciles an approval wait with capability, realtime, and status-hook parity only", () => {
    const run = {
      ...buildRunWithPayload("chat.turn.execute", {
        version: "chat.turn.execute.v1",
        sessionId: "session-wait-post-commit",
        turnId: "turn-wait-post-commit",
        userMessageId: "user-wait-post-commit",
        assistantMessageId: "assistant-wait-not-written",
        branchKind: "append",
        threadEventType: "chat_thread_turn_appended",
        request: { content: "Run the approval-gated command." },
      }),
      status: "waiting",
      metadata: {
        generalChatPostCommitPending: { version: 1, requestedAt: "2026-07-11T00:00:00.000Z" },
      },
    } satisfies DurableRunRecord;
    const userMessage = {
      messageId: "user-wait-post-commit",
      sessionId: "session-wait-post-commit",
      role: "user",
      content: "Run the approval-gated command.",
    };
    const toolRun = {
      toolRunId: "tool-wait-post-commit",
      turnId: "turn-wait-post-commit",
      sessionId: "session-wait-post-commit",
      toolName: "shell.exec",
      status: "approval_required",
      approvalId: "approval-wait-post-commit",
      startedAt: "2026-07-11T00:00:00.000Z",
    } as const;
    const trace = {
      turnId: "turn-wait-post-commit",
      sessionId: "session-wait-post-commit",
      userMessageId: userMessage.messageId,
      assistantMessageId: "assistant-wait-not-written",
      branchKind: "append",
      status: "waiting_for_approval",
      mode: "chat",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      startedAt: "2026-07-11T00:00:00.000Z",
      routing: {},
      toolRuns: [toolRun],
      citations: [],
    } as ChatTurnTraceRecord;
    const enqueueAfterHooks = vi.fn();
    const host = {
      storage: {
        chatMessages: {
          get: vi.fn((messageId: string) => (messageId === userMessage.messageId ? userMessage : undefined)),
        },
        chatTurnTraces: { get: vi.fn(() => trace) },
        chatToolRuns: { listByTurn: vi.fn(() => [toolRun]) },
      },
      hooksService: { runInlineHooks: vi.fn(), enqueueAfterHooks },
      recordCapabilityGapFromTrace: vi.fn(),
      extractAndPersistLearnedMemory: vi.fn(),
      recordTurnCommitments: vi.fn(),
      scheduleBackgroundReviewIfDue: vi.fn(),
      scheduleMemoryMaintenancePostTurnEvaluation: vi.fn(),
      scheduleChatMemoryContextPrewarm: vi.fn(),
      publishRealtime: vi.fn(),
    };

    const result = executeGeneralChatPostCommit(
      host as never,
      run,
      buildTestPostCommitProgress("waiting_for_approval", "generation-wait-post-commit"),
    );

    expect(host.recordCapabilityGapFromTrace).toHaveBeenCalledTimes(1);
    expect(host.publishRealtime).toHaveBeenCalledTimes(1);
    expect(enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "agent_end",
        idempotencyDiscriminator: "waiting_for_approval",
        payload: expect.objectContaining({ approvalId: "approval-wait-post-commit" }),
      }),
    );
    expect(host.extractAndPersistLearnedMemory).not.toHaveBeenCalled();
    expect(host.recordTurnCommitments).not.toHaveBeenCalled();
    expect(host.scheduleBackgroundReviewIfDue).not.toHaveBeenCalled();
    expect(host.scheduleMemoryMaintenancePostTurnEvaluation).not.toHaveBeenCalled();
    expect(host.scheduleChatMemoryContextPrewarm).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "waiting_for_approval",
      agentEnd: "reconciled",
      capabilityGap: "reconciled",
      realtime: "reconciled",
    });
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
    let traceStatus: ChatTurnTraceRecord["status"] = "running";
    const patchIfStatus = vi.fn((_turnId, expectedStatuses, input) => {
      if (!expectedStatuses.includes(traceStatus)) {
        return undefined;
      }
      traceStatus = input.status;
      return { turnId: "turn-1", status: traceStatus };
    });
    const persistChatStreamChunk = vi.fn();
    const host = {
      storage: {
        runImmediateTransaction: (callback: () => unknown) => callback(),
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
            status: traceStatus,
            durable: { runId: run.runId, status: "running" },
            completion: { finishReason: "error", repaired: true },
          })),
          getForUpdate: vi.fn(() => ({
            turnId: "turn-1",
            sessionId: "session-1",
            userMessageId: "user-1",
            status: traceStatus,
            durable: { runId: run.runId, status: "running" },
            completion: { finishReason: "error", repaired: true },
          })),
          patchIfStatus,
        },
        chatToolRuns: {
          listByTurn: vi.fn(() => []),
        },
        chatStreamEvents: {
          listByTurn: vi.fn(() => []),
        },
      },
      prepareAgentChatTurn,
      registerActiveChatTurnStream: vi.fn(() => ({
        registrationId: "stream-registration-resume",
        sessionId: "session-1",
        turnId: "turn-1",
        runId: run.runId,
      })),
      persistChatStreamChunk,
    };

    await executeDurableChatTurnRun(withTestDurableAdmissionOwner(host) as never, run);

    expect(host.registerActiveChatTurnStream).toHaveBeenCalledWith("session-1", "turn-1", run.runId, {
      continuation: true,
    });

    expect(prepareAgentChatTurn).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        content: expect.stringContaining("Use the local gateway."),
      }),
      expect.objectContaining({
        ingestUserMessage: false,
        turnId: "turn-1",
        assistantMessageId: "assistant-1",
        capabilityProfileContent: "Ship it",
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
      {
        streamRegistration: expect.objectContaining({ registrationId: "stream-registration-resume" }),
        skipMessageStart: true,
        durableLeaseOwnerId: run.leaseOwnerId,
      },
    );

    await markDurableWorkflowUnrecoverable(host as never, run, "operator stopped the run");
    await markDurableWorkflowUnrecoverable(host as never, run, "operator stopped the run");
    expect(patchIfStatus).toHaveBeenCalledWith(
      "turn-1",
      expect.arrayContaining(["running"]),
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
    expect(persistChatStreamChunk).toHaveBeenCalledTimes(1);
  });

  it("preserves completed chat output while correcting failed durable linkage", async () => {
    const run = buildRunWithPayload("chat.turn.execute", {
      version: "chat.turn.execute.v1",
      sessionId: "session-completed",
      turnId: "turn-completed",
      userMessageId: "user-completed",
      assistantMessageId: "assistant-completed",
      branchKind: "new",
      threadEventType: "chat_thread_turn_appended",
      request: { content: "completed before crash" },
    });
    const completedTrace = {
      turnId: "turn-completed",
      sessionId: "session-completed",
      userMessageId: "user-completed",
      status: "completed",
      completion: { status: "completed", finishReason: "stop" },
      durable: { runId: run.runId, status: "running" },
    } as ChatTurnTraceRecord;
    const patchIfStatus = vi.fn((_turnId, _expectedStatuses, input) => ({ ...completedTrace, ...input }));
    const persistChatStreamChunk = vi.fn();
    const host = {
      storage: {
        runImmediateTransaction: (callback: () => unknown) => callback(),
        chatTurnTraces: {
          get: vi.fn(() => completedTrace),
          getForUpdate: vi.fn(() => completedTrace),
          patchIfStatus,
        },
      },
      persistChatStreamChunk,
    };

    await markDurableWorkflowUnrecoverable(host as never, run, "durable completion commit was interrupted");

    expect(patchIfStatus).toHaveBeenCalledWith("turn-completed", ["completed"], {
      durable: {
        runId: run.runId,
        status: "failed",
        checkpointKind: "run_failed",
      },
    });
    expect(persistChatStreamChunk).not.toHaveBeenCalled();
  });

  it.each(["running", "completed"] as const)(
    "does not let an unrecoverable stale run overwrite a %s trace rebound to another durable run",
    async (status) => {
      const run = buildRunWithPayload("chat.turn.execute", {
        version: "chat.turn.execute.v1",
        sessionId: "session-rebound",
        turnId: "turn-rebound",
        userMessageId: "user-rebound",
        assistantMessageId: "assistant-rebound",
        branchKind: "new",
        threadEventType: "chat_thread_turn_appended",
        request: { content: "new durable owner" },
      });
      let insideTransaction = false;
      const staleTrace = {
        turnId: "turn-rebound",
        sessionId: "session-rebound",
        userMessageId: "user-rebound",
        status,
        durable: { runId: run.runId, status: "running" },
        toolRuns: [],
        citations: [],
        routing: {},
      } as ChatTurnTraceRecord;
      const reboundTrace = {
        ...staleTrace,
        durable: { runId: "durable-run-new-owner", status: "running" },
      } as ChatTurnTraceRecord;
      const patchIfStatus = vi.fn(() => reboundTrace);
      const persistChatStreamChunk = vi.fn();
      const host = {
        storage: {
          runImmediateTransaction: (callback: () => unknown) => {
            insideTransaction = true;
            return callback();
          },
          chatTurnTraces: {
            get: vi.fn(() => (insideTransaction ? reboundTrace : staleTrace)),
            getForUpdate: vi.fn(() => (insideTransaction ? reboundTrace : staleTrace)),
            patchIfStatus,
          },
        },
        persistChatStreamChunk,
      };

      await markDurableWorkflowUnrecoverable(host as never, run, "stale worker failed");

      expect(patchIfStatus).not.toHaveBeenCalled();
      expect(persistChatStreamChunk).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "durable run", tracePatch: {} },
    { label: "session", tracePatch: { sessionId: "session-foreign" } },
    { label: "user message", tracePatch: { userMessageId: "user-foreign" } },
    { label: "assistant message", tracePatch: { assistantMessageId: "assistant-foreign" } },
  ])(
    "does not let an unrecoverable run overwrite an unlinked trace with incomplete or foreign $label linkage",
    async ({ tracePatch }) => {
      const run = buildRunWithPayload("chat.turn.execute", {
        version: "chat.turn.execute.v1",
        sessionId: "session-unlinked",
        turnId: "turn-unlinked",
        userMessageId: "user-unlinked",
        assistantMessageId: "assistant-unlinked",
        branchKind: "new",
        threadEventType: "chat_thread_turn_appended",
        request: { content: "stale durable payload" },
      });
      const foreignTrace = {
        turnId: "turn-unlinked",
        sessionId: "session-unlinked",
        userMessageId: "user-unlinked",
        assistantMessageId: "assistant-unlinked",
        status: "running",
        toolRuns: [],
        citations: [],
        routing: {},
        ...tracePatch,
      } as ChatTurnTraceRecord;
      const patchIfStatus = vi.fn();
      const persistChatStreamChunk = vi.fn();
      const host = {
        storage: {
          runImmediateTransaction: (callback: () => unknown) => callback(),
          chatTurnTraces: {
            get: vi.fn(() => foreignTrace),
            getForUpdate: vi.fn(() => foreignTrace),
            patchIfStatus,
          },
        },
        persistChatStreamChunk,
      };

      await markDurableWorkflowUnrecoverable(host as never, run, "stale worker failed");

      expect(patchIfStatus).not.toHaveBeenCalled();
      expect(persistChatStreamChunk).not.toHaveBeenCalled();
    },
  );

  it("passes durable chat worker cancellation into the active turn dispatcher", async () => {
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
    });
    const prepareAgentChatTurn = vi.fn(async (_sessionId: string, request: Record<string, unknown>) => ({
      turnId: "turn-1",
      branchKind: "new",
      userMessage: { messageId: "user-1", content: request.content },
      assistantMessage: { messageId: "assistant-1", content: "" },
    }));
    const abortController = new AbortController();
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
          get: vi.fn(() => undefined),
        },
      },
      prepareAgentChatTurn,
      registerActiveChatTurnStream: vi.fn(() => ({
        registrationId: "stream-registration-cancel",
        sessionId: "session-1",
        turnId: "turn-1",
        runId: run.runId,
      })),
      persistChatStreamChunk: vi.fn(),
    };

    await executeDurableChatTurnRun(withTestDurableAdmissionOwner(host) as never, run, {
      signal: abortController.signal,
    });

    expect(host.registerActiveChatTurnStream).toHaveBeenCalledWith("session-1", "turn-1", run.runId, undefined);

    expect(prepareAgentChatTurn).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        signal: abortController.signal,
      }),
      expect.any(Object),
    );
    expect(executePreparedAgentChatTurnBackground).toHaveBeenCalledWith(
      host,
      "session-1",
      expect.objectContaining({ signal: abortController.signal }),
      expect.any(Object),
      "chat_thread_turn_appended",
      run.runId,
      undefined,
      {
        streamRegistration: expect.objectContaining({ registrationId: "stream-registration-cancel" }),
        skipMessageStart: true,
        abortSignal: abortController.signal,
        durableLeaseOwnerId: run.leaseOwnerId,
      },
    );
  });

  it("recognizes a reclaimed exact-turn lease as a continuation after retained events expire", async () => {
    vi.mocked(executePreparedAgentChatTurnBackground).mockResolvedValue(undefined as never);
    const run = {
      ...buildRunWithPayload("chat.turn.execute", {
        version: "chat.turn.execute.v1",
        sessionId: "session-1",
        turnId: "turn-1",
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        branchKind: "new",
        threadEventType: "chat_thread_turn_appended",
        request: { content: "original" },
      }),
      startedAt: "2026-04-19T00:00:00.000Z",
      leaseHeartbeatAt: "2026-04-20T00:00:00.000Z",
    };
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
          get: vi.fn(() => undefined),
        },
      },
      prepareAgentChatTurn: vi.fn(async () => ({
        turnId: "turn-1",
        branchKind: "new",
        userMessage: { messageId: "user-1", content: "Ship it" },
        assistantMessage: { messageId: "assistant-1", content: "" },
      })),
      registerActiveChatTurnStream: vi.fn(() => ({
        registrationId: "stream-registration-reclaimed",
        sessionId: "session-1",
        turnId: "turn-1",
        runId: run.runId,
      })),
      persistChatStreamChunk: vi.fn(),
    };

    await executeDurableChatTurnRun(withTestDurableAdmissionOwner(host) as never, run);

    expect(host.registerActiveChatTurnStream).toHaveBeenCalledWith("session-1", "turn-1", run.runId, {
      continuation: true,
    });
  });

  it("blocks queued autonomous chat turns while the autonomy kill switch is engaged", async () => {
    const run = {
      ...buildRunWithPayload("chat.turn.execute", {
        version: "chat.turn.execute.v1",
        sessionId: "session-1",
        turnId: "turn-1",
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        branchKind: "new",
        threadEventType: "chat_thread_turn_appended",
        request: { content: "autonomous run" },
      }),
      metadata: {
        autonomous: {
          kind: "scheduled",
          deliverMode: "always",
        },
      },
    };
    const host = {
      isFeatureEnabled: vi.fn((feature: string) => feature === "autonomyV1Disabled"),
      prepareAgentChatTurn: vi.fn(),
    };

    await expect(executeDurableChatTurnRun(withTestDurableAdmissionOwner(host) as never, run)).rejects.toThrow(
      /autonomy kill switch/i,
    );
    expect(host.prepareAgentChatTurn).not.toHaveBeenCalled();
    expect(executePreparedAgentChatTurnBackground).not.toHaveBeenCalled();
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
    const messages: {
      assistant?: {
        messageId: string;
        sessionId: string;
        role: "assistant";
      };
    } = {};
    const host = {
      storage: {
        chatTurnTraces: {
          get: vi.fn(() => ({
            turnId: "turn-1",
            sessionId: "session-1",
            userMessageId: "user-1",
            assistantMessageId: undefined,
            status: "running",
          })),
        },
        chatMessages: {
          get: vi.fn((messageId: string) =>
            messageId === "user-1"
              ? {
                  messageId,
                  sessionId: "session-1",
                  role: "user",
                  content: "continue",
                }
              : messages.assistant,
          ),
        },
        chatToolRuns: {
          listByTurn: vi.fn(() => []),
        },
        chatStreamEvents: {
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
      status: "running",
    });
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({ recoverable: true });

    host.storage.chatTurnTraces.get.mockReturnValueOnce({
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      status: "running",
    });
    host.storage.chatStreamEvents.listByTurn.mockReturnValueOnce([
      {
        eventId: "event-visible-delta",
        sessionId: "session-1",
        turnId: "turn-1",
        runId: run.runId,
        sequence: 2,
        chunkType: "delta",
        payload: { type: "delta", delta: "visible prefix" },
        createdAt: "2026-07-30T00:00:00.000Z",
      },
    ]);
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({
      recoverable: false,
      reason: "Durable Chat output was emitted before interruption and cannot be safely replayed.",
    });

    host.storage.chatTurnTraces.get.mockReturnValueOnce({
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      status: "running",
    });
    host.storage.chatStreamEvents.listByTurn.mockReturnValueOnce([
      {
        eventId: "event-visible-thinking-delta",
        sessionId: "session-1",
        turnId: "turn-1",
        runId: run.runId,
        sequence: 3,
        chunkType: "thinking_delta",
        payload: { type: "thinking_delta", delta: "visible reasoning prefix" },
        createdAt: "2026-07-30T00:00:00.000Z",
      },
    ]);
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({
      recoverable: false,
      reason: "Durable Chat output was emitted before interruption and cannot be safely replayed.",
    });

    host.storage.chatTurnTraces.get.mockReturnValueOnce({
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      status: "running",
    });
    host.storage.chatStreamEvents.listByTurn.mockReturnValueOnce([
      {
        eventId: "event-visible-message-done",
        sessionId: "session-1",
        turnId: "turn-1",
        runId: run.runId,
        sequence: 4,
        chunkType: "message_done",
        payload: { type: "message_done", content: "visible completed response" },
        createdAt: "2026-07-30T00:00:00.000Z",
      },
    ]);
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({
      recoverable: false,
      reason: "Durable Chat output was emitted before interruption and cannot be safely replayed.",
    });

    host.storage.chatTurnTraces.get.mockReturnValueOnce({
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      status: "running",
    });
    messages.assistant = {
      messageId: "assistant-1",
      sessionId: "session-1",
      role: "assistant",
    };
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({
      recoverable: false,
      reason: "Assistant output was persisted while the Chat turn trace was still active.",
    });

    host.storage.chatTurnTraces.get.mockReturnValueOnce({
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      status: "completed",
    });
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({ recoverable: true });

    host.storage.chatTurnTraces.get.mockReturnValueOnce({
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-other",
      status: "completed",
    });
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({
      recoverable: false,
      reason: "Persisted assistant output does not match the durable Chat run linkage.",
    });

    host.storage.chatTurnTraces.get.mockReturnValueOnce({
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: undefined,
      status: "running",
    });
    host.storage.chatToolRuns.listByTurn.mockReturnValueOnce([{ toolRunId: "tool-1" }]);
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({
      recoverable: false,
      reason: "Durable chat run was interrupted after tool execution began and cannot be safely replayed.",
    });
  });

  it("requires canonical semantic evidence before recovering a persisted Chat wait", () => {
    const run = buildRunWithPayload("chat.turn.execute", {
      version: "chat.turn.execute.v1",
      sessionId: "session-resting",
      turnId: "turn-resting",
      userMessageId: "user-resting",
      assistantMessageId: "assistant-resting",
      branchKind: "new",
      threadEventType: "chat_thread_turn_appended",
      request: { content: "Wait safely." },
    });
    let trace = {
      turnId: "turn-resting",
      sessionId: "session-resting",
      userMessageId: "user-resting",
      assistantMessageId: "assistant-resting",
      status: "waiting_for_approval",
      toolRuns: [],
    } as ChatTurnTraceRecord;
    let toolRuns: ChatTurnTraceRecord["toolRuns"] = [
      {
        toolRunId: "tool-approval",
        turnId: "turn-resting",
        sessionId: "session-resting",
        toolName: "shell.exec",
        status: "approval_required",
        approvalId: "approval-resting",
        startedAt: "2026-07-11T00:00:00.000Z",
      },
    ];
    const host = {
      storage: {
        chatTurnTraces: { get: vi.fn(() => trace) },
        chatMessages: {
          get: vi.fn((messageId: string) =>
            messageId === "user-resting"
              ? {
                  messageId,
                  sessionId: "session-resting",
                  role: "user",
                  content: "Wait safely.",
                }
              : undefined,
          ),
        },
        chatToolRuns: { listByTurn: vi.fn(() => toolRuns) },
      },
    };

    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({ recoverable: true });

    toolRuns = [{ ...toolRuns[0]!, turnId: "turn-other" }];
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({
      recoverable: false,
      reason: "Durable Chat trace turn-resting lacks canonical evidence for waiting_for_approval.",
    });

    toolRuns = [{ ...toolRuns[0]!, turnId: "turn-resting", sessionId: "session-other" }];
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({
      recoverable: false,
      reason: "Durable Chat trace turn-resting lacks canonical evidence for waiting_for_approval.",
    });

    toolRuns = [];
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({
      recoverable: false,
      reason: "Durable Chat trace turn-resting lacks canonical evidence for waiting_for_approval.",
    });

    trace = {
      ...trace,
      status: "waiting_for_user_input",
      pendingUserInput: {
        promptId: "prompt-resting",
        turnId: "turn-resting",
        kind: "text",
        question: "Which target should I use?",
      },
    };
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({ recoverable: true });

    trace = { ...trace, pendingUserInput: undefined };
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({
      recoverable: false,
      reason: "Durable Chat trace turn-resting lacks canonical evidence for waiting_for_user_input.",
    });

    trace = { ...trace, status: "waiting_for_tool", pendingUserInput: undefined };
    toolRuns = [
      {
        toolRunId: "tool-started",
        turnId: "turn-resting",
        sessionId: "session-resting",
        toolName: "browser.search",
        status: "started",
        startedAt: "2026-07-11T00:00:00.000Z",
      },
    ];
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({ recoverable: true });

    toolRuns = [{ ...toolRuns[0]!, turnId: "turn-other" }];
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({
      recoverable: false,
      reason: "Durable Chat trace turn-resting lacks canonical evidence for waiting_for_tool.",
    });

    toolRuns = [{ ...toolRuns[0]!, turnId: "turn-resting", sessionId: "session-other" }];
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({
      recoverable: false,
      reason: "Durable Chat trace turn-resting lacks canonical evidence for waiting_for_tool.",
    });

    toolRuns = [];
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({
      recoverable: false,
      reason: "Durable Chat trace turn-resting lacks canonical evidence for waiting_for_tool.",
    });

    trace = { ...trace, status: "failed" };
    expect(isDurableWorkflowRecoverable(host as never, run)).toEqual({ recoverable: true });
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

  it("leaves cancelled orchestration.plan.execute runs terminal without completing them again", async () => {
    const { hosts, durableRuns, executeDurableOrchestrationRun } = createHosts("cancelled");
    const registry = createDurableWorkflowExecutorRegistry(buildDurableWorkflowExecutors(hosts));
    const run = buildRun();

    await registry.executeWorkflow(run);

    expect(executeDurableOrchestrationRun).toHaveBeenCalledWith(run, undefined);
    expect(durableRuns.updateRun).not.toHaveBeenCalled();
    expect(durableRuns.createCheckpoint).not.toHaveBeenCalled();
  });

  it("marks failed orchestration.plan.execute runs failed in the durable registry", async () => {
    const { hosts, durableRuns, publishRealtime, recordDurableTimelineEvent, executeDurableOrchestrationRun } =
      createHosts("failed");
    const registry = createDurableWorkflowExecutorRegistry(buildDurableWorkflowExecutors(hosts));
    const run = buildRun();

    await registry.executeWorkflow(run);

    expect(executeDurableOrchestrationRun).toHaveBeenCalledWith(run, undefined);
    expect(durableRuns.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "durable-run-1",
        status: "failed",
        clearLease: true,
        lastError: "phase failed",
      }),
    );
    expect(durableRuns.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "durable-run-1",
        checkpointKind: "run_failed",
      }),
    );
    expect(recordDurableTimelineEvent).toHaveBeenCalledWith(
      "durable-run-1",
      "run_failed",
      expect.objectContaining({
        orchestrationRunId: "orch-run-1",
      }),
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({
        type: "durable_run_failed",
        runId: "durable-run-1",
        error: "phase failed",
      }),
      expect.any(Object),
    );
  });

  it("does not fail a durable run after the database clock says its lease expired", async () => {
    const databaseNow = Date.now();
    const { hosts, durableRuns } = createHosts("failed");
    const run = {
      ...buildRun(),
      leaseExpiresAt: new Date(databaseNow - 60_000).toISOString(),
    };
    durableRuns.getRun.mockReturnValue(run);
    durableRuns.lockFreshActiveLeaseForUpdate.mockReturnValue(undefined);
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(databaseNow - 60 * 60 * 1_000);

    await createDurableWorkflowExecutorRegistry(buildDurableWorkflowExecutors(hosts)).executeWorkflow(run);

    expect(durableRuns.lockFreshActiveLeaseForUpdate).toHaveBeenCalledWith(run.runId, run.leaseOwnerId);
    expect(durableRuns.updateRun).not.toHaveBeenCalled();
    expect(durableRuns.createCheckpoint).not.toHaveBeenCalled();
    dateNow.mockRestore();
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
  const runId = "durable-run-1";
  const normalizedPayload =
    workflowKey === "chat.turn.execute" && payload.version === "chat.turn.execute.v1"
      ? buildAdmittedChatTurnV2Fixture(payload, runId)
      : payload;
  return {
    ...buildRun(),
    workflowKey,
    payload: normalizedPayload,
  };
}

function buildAdmittedChatTurnV2Fixture(payload: Record<string, unknown>, runId: string): Record<string, unknown> {
  const sessionId = String(payload.sessionId ?? "session-1");
  const turnId = String(payload.turnId ?? "turn-1");
  const request = {
    ...((payload.request as Record<string, unknown> | undefined) ?? { content: "test" }),
    policyRunId:
      typeof (payload.request as Record<string, unknown> | undefined)?.policyRunId === "string"
        ? (payload.request as Record<string, unknown>).policyRunId
        : runId,
  };
  const admissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(request as never);
  return {
    ...payload,
    version: "chat.turn.execute.v2",
    admissionId: `admission:${turnId}`,
    sessionIncarnationId: `incarnation:${sessionId}`,
    admissionMaterialSha256,
    workspaceId: typeof payload.workspaceId === "string" ? payload.workspaceId : "default",
    admissionAggregateRevision: 1,
    admissionControllerGeneration: 1,
    effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(
      admissionMaterialSha256,
      request as never,
    ),
    requestActor: { actorKind: "operator", actorId: "operator:test" },
    request,
  };
}

function buildExactSystemHeartbeatRun(): DurableRunRecord {
  const runId = "durable-heartbeat-1";
  const sessionId = "session-heartbeat-1";
  const turnId = "turn-heartbeat-1";
  const request = {
    content: "Perform the bounded heartbeat check and return the exact decision object.",
    permissionProfileId: "heartbeat-restricted",
    policyRunId: runId,
  };
  const admissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(request as never);
  return {
    ...buildRun(),
    runId,
    workflowKey: "chat.turn.execute",
    payload: {
      version: "chat.turn.execute.v2",
      admissionId: `admission:${turnId}`,
      sessionIncarnationId: `incarnation:${sessionId}`,
      admissionMaterialSha256,
      workspaceId: "default",
      admissionAggregateRevision: 1,
      admissionControllerGeneration: 1,
      effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(
        admissionMaterialSha256,
        request as never,
      ),
      requestActor: { actorKind: "system", actorId: "system-heartbeat" },
      sessionId,
      turnId,
      userMessageId: "user-heartbeat-ephemeral-1",
      assistantMessageId: "assistant-heartbeat-1",
      branchKind: "new",
      threadEventType: "chat_thread_turn_appended",
      request,
      heartbeatOccurrenceId: "heartbeat-occurrence-1",
      heartbeatClaimSha256: "a".repeat(64),
      heartbeatEvaluatedPolicySha256: "b".repeat(64),
      heartbeatFrozenObjectiveSha256: "c".repeat(64),
    },
    metadata: {
      autonomous: {
        kind: "heartbeat",
        systemActorId: "system-heartbeat",
        deliverMode: "on_notify",
      },
    },
    leaseOwnerId: "heartbeat-worker-1",
    attemptCount: 1,
  };
}

function createExactSystemHeartbeatRuntimeHarness(run: DurableRunRecord) {
  const payload = parseDurableChatTurnPayload(run)!;
  let currentRun = structuredClone(run);
  let trace = {
    turnId: payload.turnId,
    sessionId: payload.sessionId,
    userMessageId: payload.userMessageId,
    status: "running",
    durable: { runId: run.runId, status: "running" },
    toolRuns: [],
    citations: [],
    routing: {},
  } as ChatTurnTraceRecord;
  let messages = new Map<string, Record<string, unknown>>();
  let failRunUpdateOnce = false;
  let authoritySuperseded = false;
  const runImmediateTransaction = <T>(work: () => T): T => {
    const runSnapshot = structuredClone(currentRun);
    const traceSnapshot = structuredClone(trace);
    const messageSnapshot = new Map([...messages].map(([key, value]) => [key, structuredClone(value)] as const));
    try {
      return work();
    } catch (error) {
      currentRun = runSnapshot;
      trace = traceSnapshot;
      messages = messageSnapshot;
      throw error;
    }
  };
  const host = withTestDurableAdmissionOwner({
    storage: {
      runImmediateTransaction,
      chatMessages: {
        get: vi.fn((messageId: string) => messages.get(messageId)),
        upsert: vi.fn((message: Record<string, unknown>) => {
          messages.set(String(message.messageId), structuredClone(message));
          return message;
        }),
      },
      chatTurnTraces: {
        get: vi.fn(() => trace),
        getForUpdate: vi.fn(() => trace),
        patch: vi.fn((_turnId: string, patch: Partial<ChatTurnTraceRecord>) => {
          trace = { ...trace, ...structuredClone(patch) } as ChatTurnTraceRecord;
          return trace;
        }),
        patchIfStatus: vi.fn(
          (_turnId: string, expectedStatuses: ChatTurnTraceRecord["status"][], patch: Partial<ChatTurnTraceRecord>) => {
            if (!expectedStatuses.includes(trace.status)) return undefined;
            trace = { ...trace, ...structuredClone(patch) } as ChatTurnTraceRecord;
            return trace;
          },
        ),
      },
      chatToolRuns: { listByTurn: vi.fn(() => []) },
      durableRuns: {
        getRun: vi.fn(() => currentRun),
        lockFreshActiveLeaseForUpdate: vi.fn((runId: string, leaseOwnerId: string) =>
          currentRun.runId === runId && currentRun.status === "running" && currentRun.leaseOwnerId === leaseOwnerId
            ? currentRun
            : undefined,
        ),
        updateRun: vi.fn((input: Record<string, unknown>) => {
          if (failRunUpdateOnce) {
            failRunUpdateOnce = false;
            throw new Error("heartbeat decision persistence failpoint");
          }
          currentRun = {
            ...currentRun,
            ...input,
            version: currentRun.version + 1,
          } as DurableRunRecord;
          return currentRun;
        }),
      },
    },
    durableRunService: {
      scheduleRunningWorkflowRetry: vi.fn(() => ({ ...currentRun, status: "queued" as const })),
      requestRunProcessing: vi.fn(),
    },
    prepareAgentChatTurn: vi.fn(async (_sessionId: string, _request: unknown, options: Record<string, unknown>) => ({
      turnId: payload.turnId,
      userEventId: payload.userMessageId,
      assistantMessageId: payload.assistantMessageId,
      branchKind: payload.branchKind,
      content: payload.request.content,
      turnAdmission: options.turnAdmission,
      serverOnlyPosture: options.serverOnlyPosture,
    })),
    registerActiveChatTurnStream: vi.fn(() => ({
      registrationId: "heartbeat-stream-registration",
      sessionId: payload.sessionId,
      turnId: payload.turnId,
      runId: run.runId,
    })),
    finalizeDurableChatRun: vi.fn(() => {
      currentRun = {
        ...currentRun,
        status: "completed",
        leaseOwnerId: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
      };
    }),
    persistChatStreamChunk: vi.fn(),
    reconcileAutonomousChatPostCommit: vi.fn(async () => true),
    reconcileGeneralChatPostCommit: vi.fn(async () => true),
    steerService: { drainPending: vi.fn(() => []) },
    hooksService: {
      runInlineHooks: vi.fn(async () => ({ runs: [] })),
      enqueueAfterHooks: vi.fn(),
    },
    updateActiveLeafOrThrow: vi.fn(),
    publishRealtime: vi.fn(),
    recordDevDiagnostic: vi.fn(),
    recordRuntimeDecision: vi.fn(),
    recordCapabilityGapFromTrace: vi.fn(),
    collectCapabilityUpgradeSuggestions: vi.fn(async () => []),
    collectSpecialistCandidateSuggestions: vi.fn(() => []),
    createHydratedChatTurnTrace: vi.fn((_turnId: string, value: ChatTurnTraceRecord) => value),
  });
  host.sessionControlRuntimeOwner.assertActiveTurnWrite.mockImplementation(() => {
    if (authoritySuperseded) {
      throw new Error("authority_superseded");
    }
  });
  return {
    host,
    payload,
    getCurrentRun: () => currentRun,
    getTrace: () => trace,
    getMessages: () => messages,
    replaceDecisionRawOutput: (rawOutput: string) => {
      currentRun = {
        ...currentRun,
        metadata: {
          ...(currentRun.metadata ?? {}),
          [HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY]: rawOutput,
        },
        version: currentRun.version + 1,
      };
    },
    failNextRunUpdate: () => {
      failRunUpdateOnce = true;
    },
    supersedeAuthority: () => {
      authoritySuperseded = true;
      currentRun = {
        ...currentRun,
        status: "cancelled",
        leaseOwnerId: undefined,
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
      };
    },
  };
}

function withTestDurableAdmissionOwner<T extends Record<string, unknown>>(
  host: T,
): T & {
  sessionControlRuntimeOwner: {
    withDurableClaim: ReturnType<typeof vi.fn>;
    assertActiveTurnWrite: ReturnType<typeof vi.fn>;
  };
} {
  const owned = host as T & {
    sessionControlRuntimeOwner: {
      withDurableClaim: ReturnType<typeof vi.fn>;
      assertActiveTurnWrite: ReturnType<typeof vi.fn>;
    };
  };
  owned.sessionControlRuntimeOwner ??= {
    withDurableClaim: vi.fn(
      (
        identity: Record<string, unknown>,
        admittedRequest: Record<string, unknown>,
        requestActor: Record<string, unknown>,
        durableClaim: Record<string, unknown>,
        systemHeartbeatOccurrence?: Record<string, unknown>,
      ) => ({
        identity,
        admittedRequest,
        requestActor,
        durableClaim,
        ...(systemHeartbeatOccurrence ? { systemHeartbeatOccurrence } : {}),
      }),
    ),
    assertActiveTurnWrite: vi.fn(),
  };
  return owned;
}

describe("exact system-heartbeat durable runtime", () => {
  function installProviderResult(
    harness: ReturnType<typeof createExactSystemHeartbeatRuntimeHarness>,
    rawOutput: string,
    beforeIngest?: () => void,
    completion: ChatTurnTraceRecord["completion"] | null = {
      status: "complete",
      repaired: false,
    },
  ): void {
    vi.mocked(executePreparedAgentChatTurnBackground)
      .mockReset()
      .mockImplementation(async (dispatchHost) => {
        await dispatchHost.hooksService.runInlineHooks({} as never);
        dispatchHost.persistChatStreamChunk(
          {
            type: "delta",
            sessionId: harness.payload.sessionId,
            turnId: harness.payload.turnId,
            messageId: harness.payload.assistantMessageId,
            delta: rawOutput,
          },
          harness.getCurrentRun().runId,
          undefined as never,
        );
        beforeIngest?.();
        await dispatchHost.ingestEvent(
          "heartbeat-decision-event",
          {
            eventId: harness.payload.assistantMessageId,
            message: { role: "assistant", content: rawOutput },
          } as never,
          {
            onCommit: () => {
              dispatchHost.storage.chatTurnTraces.patch(harness.payload.turnId, {
                assistantMessageId: harness.payload.assistantMessageId,
                status: "completed",
                ...(completion ? { completion } : {}),
                finishedAt: "2026-07-15T20:00:00.000Z",
              });
            },
          },
        );
      });
  }

  it("atomically commits an exact silent decision without transcript, branch, realtime, or hook writes", async () => {
    const run = buildExactSystemHeartbeatRun();
    const harness = createExactSystemHeartbeatRuntimeHarness(run);
    const rawOutput = '{"notify":false}';
    installProviderResult(harness, rawOutput);

    await executeDurableChatTurnRun(harness.host as never, run);

    const expected = buildHeartbeatDecisionReceipt({
      occurrenceId: "heartbeat-occurrence-1",
      claimSha256: "a".repeat(64),
      rawOutput,
    });
    expect(harness.getCurrentRun().metadata).toMatchObject({
      [HEARTBEAT_DECISION_RECEIPT_METADATA_KEY]: expected.receipt,
      [HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY]: rawOutput,
    });
    expect(harness.getTrace()).toMatchObject({ status: "completed", completion: { status: "complete" } });
    expect(harness.getMessages().size).toBe(0);
    expect(harness.host.hooksService.runInlineHooks).not.toHaveBeenCalled();
    expect(harness.host.updateActiveLeafOrThrow).not.toHaveBeenCalled();
    expect(harness.host.publishRealtime).not.toHaveBeenCalled();
    expect(harness.host.persistChatStreamChunk).not.toHaveBeenCalled();
  });

  it.each([
    ["raw code-unit ceiling", ["x".repeat(65_537)]],
    ["delta chunk ceiling", Array.from({ length: 8_193 }, () => "")],
  ])("bounds heartbeat decision streaming at the %s before any durable decision artifact", async (_case, deltas) => {
    const run = buildExactSystemHeartbeatRun();
    const harness = createExactSystemHeartbeatRuntimeHarness(run);
    vi.mocked(executePreparedAgentChatTurnBackground)
      .mockReset()
      .mockImplementation(async (dispatchHost) => {
        for (const delta of deltas) {
          dispatchHost.persistChatStreamChunk(
            {
              type: "delta",
              sessionId: harness.payload.sessionId,
              turnId: harness.payload.turnId,
              messageId: harness.payload.assistantMessageId,
              delta,
            },
            run.runId,
            undefined as never,
          );
        }
      });

    await expect(executeDurableChatTurnRun(harness.host as never, run)).rejects.toMatchObject({
      name: "DurableWorkerInterruptionError",
    });

    expect(harness.host.durableRunService.scheduleRunningWorkflowRetry).toHaveBeenCalledWith(
      run.runId,
      "heartbeat_decision_stream_oversized",
      "system-heartbeat",
      run.leaseOwnerId,
    );
    expect(harness.host.durableRunService.requestRunProcessing).toHaveBeenCalledTimes(1);
    expect(harness.getCurrentRun().metadata?.[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY]).toBeUndefined();
    expect(harness.getCurrentRun().metadata?.[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY]).toBeUndefined();
    expect(harness.getTrace().status).toBe("running");
    expect(harness.getMessages().size).toBe(0);
    expect(harness.host.finalizeDurableChatRun).not.toHaveBeenCalled();
    expect(harness.host.publishRealtime).not.toHaveBeenCalled();
  });

  it("rolls back completed trace, evidence, and output at the post-trace failpoint, then replays cleanly", async () => {
    const run = buildExactSystemHeartbeatRun();
    const harness = createExactSystemHeartbeatRuntimeHarness(run);
    const rawOutput = '{"notify":true,"message":"Disk pressure high"}';
    harness.failNextRunUpdate();
    installProviderResult(harness, rawOutput);

    await expect(executeDurableChatTurnRun(harness.host as never, run)).rejects.toMatchObject({
      name: "DurableWorkerInterruptionError",
    });
    expect(harness.getTrace().status).toBe("running");
    expect(harness.getCurrentRun().metadata?.[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY]).toBeUndefined();
    expect(harness.getCurrentRun().metadata?.[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY]).toBeUndefined();
    expect(harness.getMessages().size).toBe(0);
    expect(harness.host.durableRunService.scheduleRunningWorkflowRetry).toHaveBeenCalledWith(
      run.runId,
      "heartbeat_decision_commit_failed",
      "system-heartbeat",
      run.leaseOwnerId,
    );

    await executeDurableChatTurnRun(harness.host as never, run);

    expect(harness.getTrace().status).toBe("completed");
    expect(harness.getCurrentRun().metadata?.[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY]).toBe(rawOutput);
    expect(harness.getMessages().get("assistant-heartbeat-1")).toMatchObject({
      role: "assistant",
      actorType: "system",
      actorId: "system-heartbeat",
      content: "Disk pressure high",
    });
  });

  it.each([
    ["missing", null],
    ["repaired", { status: "complete" as const, repaired: true }],
    ["extra-key", { status: "complete" as const, repaired: false, finishReason: "stop" }],
  ])(
    "rolls back a completed heartbeat trace with %s completion evidence and schedules bounded retry",
    async (_case, completion) => {
      const run = buildExactSystemHeartbeatRun();
      const harness = createExactSystemHeartbeatRuntimeHarness(run);
      installProviderResult(harness, '{"notify":true,"message":"Disk pressure high"}', undefined, completion);

      await expect(executeDurableChatTurnRun(harness.host as never, run)).rejects.toMatchObject({
        name: "DurableWorkerInterruptionError",
      });

      expect(harness.getTrace().status).toBe("running");
      expect(harness.getTrace().completion).toBeUndefined();
      expect(harness.getCurrentRun().metadata?.[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY]).toBeUndefined();
      expect(harness.getCurrentRun().metadata?.[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY]).toBeUndefined();
      expect(harness.getMessages().size).toBe(0);
      expect(harness.host.durableRunService.scheduleRunningWorkflowRetry).toHaveBeenCalledWith(
        run.runId,
        "heartbeat_decision_incomplete",
        "system-heartbeat",
        run.leaseOwnerId,
      );
      expect(harness.host.durableRunService.requestRunProcessing).toHaveBeenCalledTimes(1);
      expect(harness.host.finalizeDurableChatRun).not.toHaveBeenCalled();
      expect(harness.host.publishRealtime).not.toHaveBeenCalled();
    },
  );

  it("fences a late provider result after operator preemption without decision, transcript, or effects", async () => {
    const run = buildExactSystemHeartbeatRun();
    const harness = createExactSystemHeartbeatRuntimeHarness(run);
    installProviderResult(harness, '{"notify":true,"message":"Late output"}', harness.supersedeAuthority);

    await expect(executeDurableChatTurnRun(harness.host as never, run)).rejects.toMatchObject({
      name: "DurableWorkerInterruptionError",
      message: expect.stringMatching(/superseded/i),
    });

    expect(harness.getCurrentRun().status).toBe("cancelled");
    expect(harness.getCurrentRun().metadata?.[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY]).toBeUndefined();
    expect(harness.getCurrentRun().metadata?.[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY]).toBeUndefined();
    expect(harness.getTrace().status).toBe("running");
    expect(harness.getMessages().size).toBe(0);
    expect(harness.host.durableRunService.scheduleRunningWorkflowRetry).not.toHaveBeenCalled();
    expect(harness.host.reconcileAutonomousChatPostCommit).not.toHaveBeenCalled();
    expect(harness.host.reconcileGeneralChatPostCommit).not.toHaveBeenCalled();
    expect(harness.host.publishRealtime).not.toHaveBeenCalled();
  });

  it.each(['{"notify":false}', '{"notify":true,"message":"  Disk pressure high  "}'])(
    "finalizes a decision-committed heartbeat after a lost finalization window without redispatch",
    async (rawOutput) => {
      const run = buildExactSystemHeartbeatRun();
      const harness = createExactSystemHeartbeatRuntimeHarness(run);
      installProviderResult(harness, rawOutput);

      await executeDurableChatTurnRun(harness.host as never, run);
      expect(harness.getCurrentRun().status).toBe("running");
      expect(harness.getTrace()).toMatchObject({ status: "completed", completion: { status: "complete" } });
      expect(harness.getCurrentRun().metadata?.[HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY]).toBe(rawOutput);

      await executeDurableChatTurnRun(harness.host as never, harness.getCurrentRun());

      expect(executePreparedAgentChatTurnBackground).toHaveBeenCalledTimes(1);
      expect(harness.host.finalizeDurableChatRun).toHaveBeenCalledTimes(1);
      expect(harness.getCurrentRun().status).toBe("completed");
      if (rawOutput === '{"notify":false}') {
        expect(harness.getMessages().size).toBe(0);
      } else {
        expect(harness.getMessages().get("assistant-heartbeat-1")).toMatchObject({
          actorType: "system",
          actorId: "system-heartbeat",
          content: "Disk pressure high",
        });
      }
    },
  );

  it("rejects decision evidence drift after storage commit and before recovered worker entry without redispatch", async () => {
    const run = buildExactSystemHeartbeatRun();
    const harness = createExactSystemHeartbeatRuntimeHarness(run);
    installProviderResult(harness, '{"notify":true,"message":"Disk pressure high"}');

    await executeDurableChatTurnRun(harness.host as never, run);
    expect(harness.getTrace()).toMatchObject({ status: "completed", completion: { status: "complete" } });
    expect(harness.getCurrentRun().metadata?.[HEARTBEAT_DECISION_RECEIPT_METADATA_KEY]).toBeDefined();

    harness.replaceDecisionRawOutput('{"notify":true,"message":"Different bytes"}');

    await expect(executeDurableChatTurnRun(harness.host as never, harness.getCurrentRun())).rejects.toThrow(
      /decision evidence|receipt|raw output/i,
    );
    expect(executePreparedAgentChatTurnBackground).toHaveBeenCalledTimes(1);
    expect(harness.host.finalizeDurableChatRun).not.toHaveBeenCalled();
    expect(harness.host.durableRunService.scheduleRunningWorkflowRetry).not.toHaveBeenCalled();
    expect(harness.host.durableRunService.requestRunProcessing).not.toHaveBeenCalled();
    expect(harness.getCurrentRun().status).toBe("running");
  });

  it.each(['{"notify":false}', '{"notify":true,"message":"Disk pressure high"}'])(
    "never routes exact heartbeat decision output through autonomous delivery or legacy cleanup",
    (rawOutput) => {
      const run = buildExactSystemHeartbeatRun();
      const decision = buildHeartbeatDecisionReceipt({
        occurrenceId: "heartbeat-occurrence-1",
        claimSha256: "a".repeat(64),
        rawOutput,
      });
      const completedRun = {
        ...run,
        status: "completed" as const,
        metadata: {
          ...run.metadata,
          [HEARTBEAT_DECISION_RECEIPT_METADATA_KEY]: decision.receipt,
          [HEARTBEAT_DECISION_RAW_OUTPUT_METADATA_KEY]: rawOutput,
          autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-07-15T20:00:00.000Z" },
        },
      } satisfies DurableRunRecord;
      const enqueue = vi.fn(() => "delivery-run-forbidden");
      const cleanup = vi.fn(() => ({ status: "completed" as const }));
      const host = {
        storage: {
          durableRuns: { getRun: vi.fn(() => completedRun) },
          chatTurnTraces: { get: vi.fn() },
          chatMessages: { get: vi.fn() },
        },
        enqueueAutonomousChannelDelivery: enqueue,
        cleanupSilentHeartbeatTurn: cleanup,
      };

      expect(executeAutonomousChatPostCommit(host as never, completedRun)).toEqual({
        delivery: { status: "skipped", reason: "system_heartbeat_inline_output" },
        heartbeatCleanup: { status: "not_required" },
      });
      expect(enqueue).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
      expect(host.storage.chatTurnTraces.get).not.toHaveBeenCalled();
      expect(host.storage.chatMessages.get).not.toHaveBeenCalled();
    },
  );

  it("terminalizes an unrecoverable exact heartbeat without public error chunks", async () => {
    const run = buildExactSystemHeartbeatRun();
    const harness = createExactSystemHeartbeatRuntimeHarness(run);

    await markDurableWorkflowUnrecoverable(harness.host as never, run, "heartbeat decision remained malformed");

    expect(harness.getTrace()).toMatchObject({
      status: "failed",
      failure: {
        message: "heartbeat decision remained malformed",
        retryable: false,
      },
      durable: { runId: run.runId, status: "failed" },
    });
    expect(harness.host.persistChatStreamChunk).not.toHaveBeenCalled();
    expect(harness.getMessages().size).toBe(0);
  });

  it("repairs a prematurely completed heartbeat trace while terminalizing an exhausted decision", async () => {
    const run = buildExactSystemHeartbeatRun();
    const harness = createExactSystemHeartbeatRuntimeHarness(run);
    harness.host.storage.chatTurnTraces.patch(harness.payload.turnId, {
      status: "completed",
      finishedAt: "2026-07-15T20:00:00.000Z",
      completion: {
        status: "complete",
        repaired: false,
        repair: { applied: false },
        finishReason: "stop",
        providerCallCount: 1,
      },
    });

    await markDurableWorkflowUnrecoverable(harness.host as never, run, "heartbeat decision remained incomplete");

    expect(harness.getTrace()).toMatchObject({
      status: "failed",
      failure: {
        message: "heartbeat decision remained incomplete",
        retryable: false,
      },
      completion: { status: "interrupted" },
      durable: { runId: run.runId, status: "failed" },
    });
    expect(harness.host.persistChatStreamChunk).not.toHaveBeenCalled();
    expect(harness.getMessages().size).toBe(0);
  });
});

function buildTestPostCommitProgress(targetTraceStatus: ChatTurnTraceRecord["status"], generationId: string) {
  return {
    generationId,
    requestedAt: "2026-07-11T00:00:00.000Z",
    targetTraceStatus,
    completedEffects: [],
    runEffect: vi.fn((_effect, callback: () => void) => {
      callback();
      return true;
    }),
    publishEffect: vi.fn((_effect, callback: () => void) => {
      callback();
      return true;
    }),
    enqueueDurableEffect: vi.fn((input: { effect: string }) => `durable-child-${input.effect}`),
  };
}

describe("parseAutonomousNotifySignal", () => {
  it("detects a structured top-level notify:true (pure JSON)", () => {
    expect(parseAutonomousNotifySignal('{"notify": true}')).toBe(true);
    expect(parseAutonomousNotifySignal('{"notify": true, "message": "disk full"}')).toBe(true);
    expect(parseAutonomousNotifySignal('  {"notify":true}  ')).toBe(true);
  });

  it("treats notify:false / absent / empty as no-notify", () => {
    expect(parseAutonomousNotifySignal('{"notify": false}')).toBe(false);
    expect(parseAutonomousNotifySignal('{"message": "fyi"}')).toBe(false);
    expect(parseAutonomousNotifySignal("nothing notable to report")).toBe(false);
    expect(parseAutonomousNotifySignal("")).toBe(false);
    expect(parseAutonomousNotifySignal("   ")).toBe(false);
  });

  it("matches a quoted notify key embedded in prose (model wrapped the JSON)", () => {
    expect(parseAutonomousNotifySignal('Urgent: disk full. {"notify": true}')).toBe(true);
  });

  it("does NOT match bare prose / tool-arg mentions of notify (strict, no false positives)", () => {
    // The dropped broad fallback used to match these and mis-trigger delivery.
    expect(parseAutonomousNotifySignal("notify=true")).toBe(false);
    expect(parseAutonomousNotifySignal("I will notify: true believers tomorrow")).toBe(false);
    expect(parseAutonomousNotifySignal("Calling tool with notify: true in its args.")).toBe(false);
    // Pure JSON with notify nested under another key is NOT a top-level signal:
    // the JSON branch checks only top-level `notify`, so this is correctly false.
    expect(parseAutonomousNotifySignal('{"args": {"notify": true}}')).toBe(false);
  });
});

describe("maybeCleanupSilentHeartbeatTurn", () => {
  const heartbeatPayload = {
    version: "chat.turn.execute.v1" as const,
    sessionId: "session-hb",
    turnId: "turn-hb",
    userMessageId: "user-hb",
    assistantMessageId: "assistant-hb",
    branchKind: "new" as const,
    parentTurnId: "turn-prev",
    threadEventType: "chat_thread_turn_appended" as const,
    request: { content: "heartbeat self-check" },
  };

  function buildHeartbeatHost(
    assistantContent: string,
    currentRun: DurableRunRecord,
    cleanup = vi.fn(() => ({ status: "completed" as const })),
  ) {
    return {
      storage: {
        durableRuns: { getRun: vi.fn(() => currentRun) },
        chatTurnTraces: { get: vi.fn(() => ({ turnId: "turn-hb", assistantMessageId: "assistant-hb" })) },
        chatMessages: { get: vi.fn(() => ({ messageId: "assistant-hb", content: assistantContent })) },
      },
      cleanupSilentHeartbeatTurn: cleanup,
    };
  }

  function heartbeatRun(content: string, cleanup = vi.fn(() => ({ status: "completed" as const }))) {
    const run = {
      ...buildRunWithPayload("chat.turn.execute", heartbeatPayload),
      status: "completed" as const,
      metadata: {
        outputText: content.trim() || undefined,
        autonomous: {
          kind: "heartbeat",
          systemActorId: "system-heartbeat",
          reason: "heartbeat self-wake:session-hb",
          deliverMode: "on_notify",
        },
        autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-04-10T00:00:00.000Z" },
      },
    };
    return {
      run,
      host: buildHeartbeatHost(content, run, cleanup),
      cleanup,
    };
  }

  it("prunes a silent (notify:false) heartbeat turn from the transcript", () => {
    const { run, host, cleanup } = heartbeatRun('{"notify": false}');

    maybeCleanupSilentHeartbeatTurn(host as never, run, heartbeatPayload);

    expect(cleanup).toHaveBeenCalledWith({
      sessionId: "session-hb",
      turnId: "turn-hb",
      userMessageId: "user-hb",
      assistantMessageId: "assistant-hb",
      parentTurnId: "turn-prev",
    });
  });

  it("prunes a heartbeat turn that produced empty output", () => {
    const { run, host, cleanup } = heartbeatRun("   ");
    maybeCleanupSilentHeartbeatTurn(host as never, run, heartbeatPayload);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("keeps a notifying heartbeat turn visible (no cleanup)", () => {
    const { run, host, cleanup } = heartbeatRun('{"notify": true, "message": "Reminder: standup in 5"}');
    maybeCleanupSilentHeartbeatTurn(host as never, run, heartbeatPayload);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("is a no-op for non-heartbeat autonomous turns (e.g. scheduled/cron)", () => {
    const cleanup = vi.fn(() => ({ status: "completed" as const }));
    const run = {
      ...buildRunWithPayload("chat.turn.execute", heartbeatPayload),
      status: "completed" as const,
      metadata: {
        autonomous: { kind: "scheduled", systemActorId: "system-cron", deliverMode: "always" },
        autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-04-10T00:00:00.000Z" },
      },
    };
    maybeCleanupSilentHeartbeatTurn(
      buildHeartbeatHost('{"notify": false}', run, cleanup) as never,
      run,
      heartbeatPayload,
    );
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("is a no-op for non-autonomous (human) turns", () => {
    const cleanup = vi.fn(() => ({ status: "completed" as const }));
    const run = { ...buildRunWithPayload("chat.turn.execute", heartbeatPayload), status: "completed" as const };
    maybeCleanupSilentHeartbeatTurn(
      buildHeartbeatHost('{"notify": false}', run, cleanup) as never,
      run,
      heartbeatPayload,
    );
    expect(cleanup).not.toHaveBeenCalled();
  });
});

describe("maybeEnqueueAutonomousDelivery", () => {
  const chatTurnPayload = {
    version: "chat.turn.execute.v1" as const,
    sessionId: "session-cron",
    turnId: "turn-cron",
    userMessageId: "user-cron",
    assistantMessageId: "assistant-cron",
    branchKind: "new" as const,
    threadEventType: "chat_thread_turn_appended" as const,
    request: { content: "Summarize alerts" },
  };

  function buildDeliveryHost(
    assistantContent: string,
    enqueue = vi.fn(() => "delivery-run-1"),
    options: {
      traceStatus?: "completed" | "failed" | "cancelled" | "partial";
      runStatus?: DurableRunRecord["status"];
      currentRun?: DurableRunRecord;
    } = {},
  ) {
    return {
      storage: {
        durableRuns: {
          getRun: vi.fn((runId: string) => ({
            ...(options.currentRun ?? buildRunWithPayload("chat.turn.execute", chatTurnPayload)),
            runId,
            status: options.currentRun?.status ?? options.runStatus ?? "completed",
          })),
        },
        chatTurnTraces: {
          get: vi.fn(() => ({
            turnId: "turn-cron",
            assistantMessageId: "assistant-cron",
            status: options.traceStatus ?? "completed",
          })),
        },
        chatMessages: { get: vi.fn(() => ({ messageId: "assistant-cron", content: assistantContent })) },
      },
      enqueueAutonomousChannelDelivery: enqueue,
    };
  }

  it("enqueues channel delivery for an autonomous turn with assistant output", () => {
    const enqueue = vi.fn(() => "delivery-run-1");
    const run = {
      ...buildRunWithPayload("chat.turn.execute", chatTurnPayload),
      status: "completed" as const,
      metadata: {
        outputText: "Overnight summary ready.",
        autonomous: {
          kind: "scheduled",
          systemActorId: "system-cron",
          reason: "cron agent_turn:job",
          deliverMode: "always",
          deliveryChannel: { channelKey: "telegram", target: "42" },
        },
        autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-04-10T00:00:00.000Z" },
      },
    };
    const host = buildDeliveryHost("Overnight summary ready.", enqueue, { currentRun: run });

    const result = maybeEnqueueAutonomousDelivery(host as never, run, chatTurnPayload);

    expect(result).toBe("delivery-run-1");
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.runId,
        sessionId: "session-cron",
        turnId: "turn-cron",
        assistantText: "Overnight summary ready.",
        deliveryChannel: { channelKey: "telegram", target: "42" },
        systemActorId: "system-cron",
      }),
    );
  });

  it("still delegates delivery reconciliation while the autonomy kill switch is engaged", () => {
    const enqueue = vi.fn(() => "delivery-run-1");
    const run = {
      ...buildRunWithPayload("chat.turn.execute", chatTurnPayload),
      status: "completed" as const,
      metadata: {
        outputText: "Overnight summary ready.",
        autonomous: {
          kind: "scheduled",
          deliverMode: "always",
          deliveryChannel: { channelKey: "telegram", target: "42" },
        },
        autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-04-10T00:00:00.000Z" },
      },
    };
    const host = {
      ...buildDeliveryHost("Overnight summary ready.", enqueue, { currentRun: run }),
      isFeatureEnabled: vi.fn((feature: string) => feature === "autonomyV1Disabled"),
    };

    expect(maybeEnqueueAutonomousDelivery(host as never, run, chatTurnPayload)).toBe("delivery-run-1");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for non-autonomous turns", () => {
    const enqueue = vi.fn(() => "delivery-run-1");
    const run = { ...buildRunWithPayload("chat.turn.execute", chatTurnPayload), status: "completed" as const };
    const host = buildDeliveryHost("ignored", enqueue, { currentRun: run });

    expect(maybeEnqueueAutonomousDelivery(host as never, run, chatTurnPayload)).toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("suppresses delivery for on_notify turns that do not signal notify", () => {
    const enqueue = vi.fn(() => "delivery-run-1");
    const run = {
      ...buildRunWithPayload("chat.turn.execute", chatTurnPayload),
      status: "completed" as const,
      metadata: {
        outputText: "Nothing actionable overnight.",
        autonomous: {
          kind: "scheduled",
          deliverMode: "on_notify",
          deliveryChannel: { channelKey: "telegram" },
        },
        autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-04-10T00:00:00.000Z" },
      },
    };
    const host = buildDeliveryHost("Nothing actionable overnight.", enqueue, { currentRun: run });

    expect(maybeEnqueueAutonomousDelivery(host as never, run, chatTurnPayload)).toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("delivers on_notify turns that emit a notify signal", () => {
    const enqueue = vi.fn(() => "delivery-run-2");
    const run = {
      ...buildRunWithPayload("chat.turn.execute", chatTurnPayload),
      status: "completed" as const,
      metadata: {
        outputText: 'Urgent: disk full. {"notify": true}',
        autonomous: {
          kind: "scheduled",
          deliverMode: "on_notify",
          deliveryChannel: { channelKey: "telegram" },
        },
        autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-04-10T00:00:00.000Z" },
      },
    };
    const host = buildDeliveryHost('Urgent: disk full. {"notify": true}', enqueue, { currentRun: run });

    expect(maybeEnqueueAutonomousDelivery(host as never, run, chatTurnPayload)).toBe("delivery-run-2");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("uses completed parent truth despite a missing/stale trace and rejects failed parent runs", () => {
    const failedTraceEnqueue = vi.fn(() => "delivery-run-failed-trace");
    const failedTraceRun = {
      ...buildRunWithPayload("chat.turn.execute", chatTurnPayload),
      status: "completed" as const,
      metadata: {
        outputText: "Canonical completed answer.",
        autonomous: {
          kind: "scheduled",
          deliverMode: "always",
          deliveryChannel: { channelKey: "telegram" },
        },
        autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-04-10T00:00:00.000Z" },
      },
    };
    const failedTraceHost = buildDeliveryHost("Partial answer before failure.", failedTraceEnqueue, {
      traceStatus: "failed",
      currentRun: failedTraceRun,
    });

    expect(maybeEnqueueAutonomousDelivery(failedTraceHost as never, failedTraceRun, chatTurnPayload)).toBe(
      "delivery-run-failed-trace",
    );
    expect(failedTraceEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ assistantText: "Canonical completed answer." }),
    );

    const failedRunEnqueue = vi.fn(() => "delivery-run-failed-run");
    const failedRun = {
      ...buildRunWithPayload("chat.turn.execute", chatTurnPayload),
      status: "failed" as const,
      metadata: {
        autonomous: {
          kind: "scheduled",
          deliverMode: "always",
          deliveryChannel: { channelKey: "telegram" },
        },
        autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-04-10T00:00:00.000Z" },
      },
    };
    const failedRunHost = buildDeliveryHost("Looks complete but durable run failed.", failedRunEnqueue, {
      currentRun: failedRun,
    });

    expect(maybeEnqueueAutonomousDelivery(failedRunHost as never, failedRun, chatTurnPayload)).toBeUndefined();
    expect(failedRunEnqueue).not.toHaveBeenCalled();
  });

  it("does not enqueue from a stale worker while the parent is still running under another lease", () => {
    const enqueue = vi.fn(() => "delivery-run-stale");
    const run = {
      ...buildRunWithPayload("chat.turn.execute", chatTurnPayload),
      status: "running" as const,
      leaseOwnerId: "worker-b",
      metadata: {
        outputText: "Stale worker output",
        autonomous: {
          kind: "scheduled",
          deliverMode: "always",
          deliveryChannel: { channelKey: "telegram" },
        },
        autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-04-10T00:00:00.000Z" },
      },
    };
    const host = buildDeliveryHost("Stale worker output", enqueue, { currentRun: run });

    expect(maybeEnqueueAutonomousDelivery(host as never, run, chatTurnPayload)).toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("returns explicit durable delivery and cleanup resolution truth", () => {
    const enqueue = vi.fn(() => "autonomous-delivery:run-chat.turn.execute");
    const run = {
      ...buildRunWithPayload("chat.turn.execute", chatTurnPayload),
      status: "completed" as const,
      metadata: {
        outputText: "Overnight summary ready.",
        autonomous: {
          kind: "scheduled",
          deliverMode: "always",
          deliveryChannel: { channelKey: "telegram" },
        },
        autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-04-10T00:00:00.000Z" },
      },
    };
    const host = buildDeliveryHost("deleted transcript output", enqueue, { currentRun: run });

    expect(executeAutonomousChatPostCommit(host as never, run)).toEqual({
      delivery: { status: "enqueued", runId: "autonomous-delivery:run-chat.turn.execute" },
      heartbeatCleanup: { status: "not_required" },
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ assistantText: "Overnight summary ready." }));
  });

  it("records manual reconciliation instead of retrying cleanup across an advanced branch", () => {
    const run = {
      ...buildRunWithPayload("chat.turn.execute", chatTurnPayload),
      status: "completed" as const,
      metadata: {
        outputText: '{"notify": false}',
        autonomous: { kind: "heartbeat", deliverMode: "on_notify" },
        autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-04-10T00:00:00.000Z" },
      },
    };
    const cleanup = vi.fn(() => ({
      status: "manual_reconciliation" as const,
      reason: "active leaf advanced to turn-newer",
    }));
    const host = {
      ...buildDeliveryHost('{"notify": false}', vi.fn(), { currentRun: run }),
      cleanupSilentHeartbeatTurn: cleanup,
    };

    expect(executeAutonomousChatPostCommit(host as never, run)).toEqual({
      delivery: { status: "skipped", reason: "delivery_not_configured" },
      heartbeatCleanup: {
        status: "manual_reconciliation",
        reason: "active leaf advanced to turn-newer",
      },
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

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
        lockFreshActiveLeaseForUpdate: vi.fn((_runId: string, expectedLeaseOwnerId: string) =>
          storedRun.status === "running" && storedRun.leaseOwnerId === expectedLeaseOwnerId ? storedRun : undefined,
        ),
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

describe("parseCuratorTickWorkflowPayload", () => {
  it("returns payload when valid", () => {
    const run = {
      payload: {
        version: "curator.tick.v1",
        runId: "curator-run-xyz",
        triggerMode: "scheduled",
        cycleDays: 7,
        requestedAt: "2026-05-15T12:00:00Z",
      } as CuratorTickWorkflowPayload,
    } as unknown as DurableRunRecord;
    expect(parseCuratorTickWorkflowPayload(run)).toEqual(run.payload);
  });
  it("returns undefined when version mismatches", () => {
    const run = { payload: { version: "wrong.v1" } } as unknown as DurableRunRecord;
    expect(parseCuratorTickWorkflowPayload(run)).toBeUndefined();
  });
  it("returns undefined when payload is missing required fields", () => {
    const run = { payload: { version: "curator.tick.v1" } } as unknown as DurableRunRecord;
    expect(parseCuratorTickWorkflowPayload(run)).toBeUndefined();
  });
});
