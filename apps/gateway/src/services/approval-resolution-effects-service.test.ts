import type {
  ApprovalEffectRecord,
  ApprovalRequest,
  ChatDelegationStepRecord,
  ChatTurnTraceRecord,
  DurableWakeResult,
} from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ApprovalEffectsService,
  deriveApprovalResolutionEffectsResult,
} from "./approval-resolution-effects-service.js";
import type { ServiceContext } from "./service-context.js";

describe("approval-resolution-effects-service", () => {
  it("derives compatibility wake metadata from effect rows", () => {
    const result = deriveApprovalResolutionEffectsResult([
      createEffect({
        effectKind: "approval_wait_wake",
        targetKind: "durable_run",
        targetId: "approval-wait-1",
      }),
      createEffect({
        effectKind: "proactive_run_wake",
        targetKind: "durable_run",
        targetId: "proactive-1",
        status: "completed",
        result: { outcome: "woke" },
      }),
      createEffect({
        effectKind: "linked_chat_turn_wake",
        targetKind: "chat_turn",
        targetId: "turn-1",
        status: "completed",
        result: {
          outcome: "woke",
          turnId: "turn-1",
          runId: "durable-turn-1",
        },
      }),
    ]);

    expect(result).toEqual({
      approvalWaitDurableRunId: "approval-wait-1",
      proactiveRunIds: ["proactive-1"],
      chatTurnResume: {
        resumed: true,
        turnId: "turn-1",
        durableRunId: "durable-turn-1",
        wakeOutcome: "woke",
      },
    });
  });

  it("enqueues the canonical approval effect set from current linkage", () => {
    const upsert = vi.fn((input: Record<string, unknown>) => ({
      effectId: String(input.targetId),
      approvalId: String(input.approvalId),
      effectKind: input.effectKind,
      targetKind: input.targetKind,
      targetId: String(input.targetId),
      idempotencyKey: "key",
      status: "pending",
      attemptCount: 0,
      payload: (input.payload as Record<string, unknown>) ?? {},
      result: {},
      version: 1,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    }));
    const ctx = {
      storage: {
        approvalEffects: { upsert, claimNextPendingEffect: vi.fn(), get: vi.fn(), listByApproval: vi.fn() },
        approvalWaitRuns: {
          getRunId: vi.fn(() => "approval-wait-1"),
        },
        pendingApprovalActions: {
          find: vi.fn(() => ({
            approvalId: "approval-1",
            actionType: "tool.invoke",
            request: {},
            createdAt: "2026-04-11T00:00:00.000Z",
            resolutionStatus: "pending",
          })),
        },
        approvalInbox: {
          findByApprovalAndToken: vi.fn(() => ({ inboxItemId: "inbox-1" })),
        },
        chatInlineApprovals: {
          get: vi.fn(() => undefined),
        },
        chatTurnTraces: {
          get: vi.fn(() => ({
            durable: { runId: "durable-turn-1" },
          })),
        },
      },
      publishRealtime: vi.fn(),
    } as unknown as ServiceContext;
    const service = new ApprovalEffectsService(ctx, {
      backgroundTasks: new Set(),
      wakeDurableRun: vi.fn(),
      requestRunProcessing: vi.fn(),
      findProactiveDurableRunIdsForApproval: vi.fn(() => ["proactive-1"]),
      executeCodeModePendingApproval: vi.fn(),
      executeApprovedPendingAction: vi.fn(),
      enqueueAfterHooks: vi.fn(),
      resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
    });

    service.enqueueResolutionEffects(
      {
        approvalId: "approval-1",
        kind: "shell.exec",
        riskLevel: "danger",
        status: "approved",
        payload: {},
        preview: {},
        linkage: {
          turnId: "turn-1",
          connectorId: "connector-1",
          tokenId: "token-1",
        },
        createdAt: "2026-04-11T00:00:00.000Z",
        resolvedAt: "2026-04-11T00:01:00.000Z",
        resolvedBy: "operator",
        explanationStatus: "not_requested",
      } satisfies ApprovalRequest,
      {
        decision: "approve",
        resolvedBy: "operator",
      },
    );

    expect(upsert.mock.calls.map(([input]) => input.effectKind)).toEqual([
      "pending_action_execute",
      "approval_wait_wake",
      "proactive_run_wake",
      "linked_chat_turn_wake",
      "approval_inbox_follow_up",
      "approval_after_hooks",
    ]);
  });

  it("does not wake a linked turn when the turn trace belongs to another session", () => {
    const upsert = vi.fn((input: Record<string, unknown>) => ({
      effectId: String(input.targetId),
      approvalId: String(input.approvalId),
      effectKind: input.effectKind,
      targetKind: input.targetKind,
      targetId: String(input.targetId),
      idempotencyKey: "key",
      status: "pending",
      attemptCount: 0,
      payload: (input.payload as Record<string, unknown>) ?? {},
      result: {},
      version: 1,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    }));
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { upsert, claimNextPendingEffect: vi.fn(), get: vi.fn(), listByApproval: vi.fn() },
          approvalWaitRuns: { getRunId: vi.fn(() => undefined) },
          pendingApprovalActions: { find: vi.fn(() => undefined) },
          approvalInbox: { findByApprovalAndToken: vi.fn(() => undefined) },
          chatInlineApprovals: { get: vi.fn(() => undefined) },
          chatTurnTraces: {
            get: vi.fn(() => ({
              turnId: "turn-b",
              sessionId: "session-b",
              durable: { runId: "durable-turn-b" },
            })),
          },
          chatDelegationSteps: { listParentsByChildSessionIds: vi.fn(() => new Map()) },
          orchestration: { getRun: vi.fn() },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: vi.fn(),
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
      },
    );

    service.enqueueResolutionEffects(
      {
        approvalId: "approval-1",
        kind: "code_mode.run",
        riskLevel: "caution",
        status: "approved",
        payload: {},
        preview: {},
        linkage: {
          sessionId: "session-a",
          turnId: "turn-b",
          workspaceId: "workspace-1",
        },
        createdAt: "2026-04-11T00:00:00.000Z",
        resolvedAt: "2026-04-11T00:01:00.000Z",
        resolvedBy: "operator",
        explanationStatus: "not_requested",
      } satisfies ApprovalRequest,
      {
        decision: "approve",
        resolvedBy: "operator",
      },
    );

    expect(upsert.mock.calls.map(([input]) => input.effectKind)).toEqual([
      "pending_action_execute",
      "approval_after_hooks",
    ]);
  });

  it("enqueues Code Mode recovery effects when the pending action row is missing", () => {
    const upsert = vi.fn((input: Record<string, unknown>) => ({
      effectId: String(input.targetId),
      approvalId: String(input.approvalId),
      effectKind: input.effectKind,
      targetKind: input.targetKind,
      targetId: String(input.targetId),
      idempotencyKey: "key",
      status: "pending",
      attemptCount: 0,
      payload: (input.payload as Record<string, unknown>) ?? {},
      result: {},
      version: 1,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    }));
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { upsert, claimNextPendingEffect: vi.fn(), get: vi.fn(), listByApproval: vi.fn() },
          approvalWaitRuns: { getRunId: vi.fn(() => undefined) },
          pendingApprovalActions: { find: vi.fn(() => undefined) },
          approvalInbox: { findByApprovalAndToken: vi.fn(() => undefined) },
          chatInlineApprovals: { get: vi.fn(() => undefined) },
          chatTurnTraces: { get: vi.fn(() => undefined), listBySession: vi.fn(() => []) },
          chatDelegationSteps: { listParentsByChildSessionIds: vi.fn(() => new Map()) },
          orchestration: { getRun: vi.fn() },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: vi.fn(),
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
      },
    );

    service.enqueueResolutionEffects(
      {
        approvalId: "approval-code-1",
        kind: "code_mode.run",
        riskLevel: "danger",
        status: "rejected",
        payload: { runId: "code-run-1" },
        preview: {},
        linkage: { runId: "code-run-1", workspaceId: "workspace-1" },
        createdAt: "2026-04-11T00:00:00.000Z",
        resolvedAt: "2026-04-11T00:01:00.000Z",
        resolvedBy: "operator",
        explanationStatus: "not_requested",
      } satisfies ApprovalRequest,
      {
        decision: "reject",
        resolvedBy: "operator",
      },
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        effectKind: "pending_action_execute",
        targetId: "approval-code-1",
        payload: expect.objectContaining({
          actionType: "code_mode.run",
          pendingActionMissing: true,
          decision: "reject",
        }),
      }),
    );
  });

  it("wakes the child delegated turn and parent orchestration when a child subagent approval resolves", () => {
    const upsert = vi.fn((input: Record<string, unknown>) => ({
      effectId: String(input.targetId),
      approvalId: String(input.approvalId),
      effectKind: input.effectKind,
      targetKind: input.targetKind,
      targetId: String(input.targetId),
      idempotencyKey: "key",
      status: "pending",
      attemptCount: 0,
      payload: (input.payload as Record<string, unknown>) ?? {},
      result: {},
      version: 1,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    }));
    const ctx = {
      storage: {
        approvalEffects: { upsert, claimNextPendingEffect: vi.fn(), get: vi.fn(), listByApproval: vi.fn() },
        approvalWaitRuns: { getRunId: vi.fn(() => undefined) },
        pendingApprovalActions: { find: vi.fn(() => undefined) },
        approvalInbox: { findByApprovalAndToken: vi.fn(() => undefined) },
        chatInlineApprovals: { get: vi.fn(() => undefined) },
        chatTurnTraces: {
          get: vi.fn(() => ({ sessionId: "child-session-1", durable: { runId: "child-durable-run" } })),
          listBySession: vi.fn(() => [
            {
              turnId: "parent-turn-1",
              durable: { runId: "parent-durable-run" },
              orchestration: { runId: "delegation-run-1" },
            },
          ]),
        },
        chatDelegationSteps: {
          listParentsByChildSessionIds: vi.fn(
            () =>
              new Map([
                [
                  "child-session-1",
                  {
                    parentSessionId: "parent-session-1",
                    runId: "delegation-run-1",
                    stepId: "step-1",
                    role: "qa",
                    index: 0,
                  },
                ],
              ]),
          ),
        },
        orchestration: {
          getRun: vi.fn(() => ({
            runId: "orchestration-run-1",
            workspaceId: "workspace-1",
            planId: "plan-1",
            status: "running",
            startedAt: "2026-04-11T00:00:00.000Z",
            totalIterations: 0,
            totalCostUsd: 0,
            durableRunId: "parent-orchestration-durable-run",
            executionState: "paused_for_approval",
          })),
        },
      },
      publishRealtime: vi.fn(),
    } as unknown as ServiceContext;
    const service = new ApprovalEffectsService(ctx, {
      backgroundTasks: new Set(),
      wakeDurableRun: vi.fn(),
      requestRunProcessing: vi.fn(),
      findProactiveDurableRunIdsForApproval: vi.fn(() => []),
      executeCodeModePendingApproval: vi.fn(),
      executeApprovedPendingAction: vi.fn(),
      enqueueAfterHooks: vi.fn(),
      resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
    });

    service.enqueueResolutionEffects(
      {
        approvalId: "approval-1",
        kind: "shell.exec",
        riskLevel: "danger",
        status: "approved",
        payload: {},
        preview: {},
        linkage: {
          sessionId: "child-session-1",
          turnId: "child-turn-1",
          runId: "orchestration-run-1",
          workspaceId: "workspace-1",
        },
        createdAt: "2026-04-11T00:00:00.000Z",
        resolvedAt: "2026-04-11T00:01:00.000Z",
        resolvedBy: "operator",
        explanationStatus: "not_requested",
      } satisfies ApprovalRequest,
      {
        decision: "approve",
        resolvedBy: "operator",
      },
    );

    const linkedWakeInputs = upsert.mock.calls
      .map(([input]) => input)
      .filter((input) => {
        return input.effectKind === "linked_chat_turn_wake";
      });
    expect(linkedWakeInputs).toEqual([
      expect.objectContaining({
        targetId: "child-turn-1",
        payload: expect.objectContaining({ runId: "child-durable-run" }),
      }),
      expect.objectContaining({
        targetId: "parent-turn-1",
        payload: expect.objectContaining({
          runId: "parent-durable-run",
          childSessionId: "child-session-1",
          delegationRunId: "delegation-run-1",
        }),
      }),
    ]);
    expect(upsert.mock.calls.map(([input]) => input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          effectKind: "orchestration_parent_wake",
          targetKind: "durable_run",
          targetId: "parent-orchestration-durable-run",
          payload: expect.objectContaining({
            orchestrationRunId: "orchestration-run-1",
            childRunId: "child-durable-run",
            childTurnId: "child-turn-1",
          }),
        }),
      ]),
    );
  });

  it("defers orchestration parent wakes while the linked child durable run is still live", async () => {
    const effect = createEffect({
      effectKind: "orchestration_parent_wake",
      targetKind: "durable_run",
      targetId: "parent-orchestration-durable-run",
      payload: {
        childRunId: "child-durable-run",
        childTurnId: "child-turn-1",
      },
      status: "running",
    });
    const completeEffect = vi.fn();
    const failEffect = vi.fn();
    const skipEffect = vi.fn();
    const renewEffectLease = vi.fn(() => ({ ...effect, version: 2 }));
    const wakeDurableRun = vi.fn();
    const requestRunProcessing = vi.fn();
    const publishRealtime = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            renewEffectLease,
            completeEffect,
            failEffect,
            skipEffect,
          },
          approvalWaitRuns: { markResolved: vi.fn() },
          durableRuns: {
            getRun: vi.fn(() => ({
              runId: "child-durable-run",
              status: "running",
            })),
          },
          pendingApprovalActions: { find: vi.fn(() => undefined) },
        },
        publishRealtime,
      } as unknown as ServiceContext,
      {
        backgroundTasks: new Set(),
        wakeDurableRun,
        requestRunProcessing,
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
      },
    );

    await (
      service as unknown as {
        handleWakeEffect(effect: ApprovalEffectRecord, resolveApprovalWait: boolean): Promise<void>;
      }
    ).handleWakeEffect(effect, false);

    expect(wakeDurableRun).not.toHaveBeenCalled();
    expect(requestRunProcessing).toHaveBeenCalledWith("child-durable-run");
    expect(renewEffectLease).toHaveBeenCalledWith(
      "effect-1",
      expect.any(String),
      1,
      expect.any(String),
      expect.any(String),
    );
    expect(completeEffect).not.toHaveBeenCalled();
    expect(failEffect).not.toHaveBeenCalled();
    expect(skipEffect).not.toHaveBeenCalled();
    expect(publishRealtime).toHaveBeenCalledWith(
      "approval_effect_deferred",
      "approvals",
      expect.objectContaining({
        approvalId: "approval-1",
        effectKind: "orchestration_parent_wake",
        reason: "child_durable_run_not_terminal",
        childRunId: "child-durable-run",
        childRunStatus: "running",
      }),
      expect.any(Object),
    );
  });

  it("wakes orchestration parents when the linked child durable run is terminal", async () => {
    const effect = createEffect({
      effectKind: "orchestration_parent_wake",
      targetKind: "durable_run",
      targetId: "parent-orchestration-durable-run",
      payload: {
        childRunId: "child-durable-run",
        childTurnId: "child-turn-1",
      },
      status: "running",
    });
    const completeEffect = vi.fn();
    const renewEffectLease = vi.fn();
    const wakeDurableRun = vi.fn(() => ({
      runId: "parent-orchestration-durable-run",
      eventKey: "approval.resolved",
      correlationId: "approval-1",
      outcome: "woke",
    }));
    const requestRunProcessing = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            renewEffectLease,
            completeEffect,
            failEffect: vi.fn(),
            skipEffect: vi.fn(),
          },
          approvalWaitRuns: { markResolved: vi.fn() },
          durableRuns: {
            getRun: vi.fn(() => ({
              runId: "child-durable-run",
              status: "completed",
            })),
          },
          pendingApprovalActions: { find: vi.fn(() => undefined) },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        backgroundTasks: new Set(),
        wakeDurableRun,
        requestRunProcessing,
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
      },
    );

    await (
      service as unknown as {
        handleWakeEffect(effect: ApprovalEffectRecord, resolveApprovalWait: boolean): Promise<void>;
      }
    ).handleWakeEffect(effect, false);

    expect(renewEffectLease).not.toHaveBeenCalled();
    expect(wakeDurableRun).toHaveBeenCalledWith("parent-orchestration-durable-run", expect.any(Object));
    expect(requestRunProcessing).toHaveBeenCalledWith("parent-orchestration-durable-run");
    expect(completeEffect).toHaveBeenCalledWith(
      "effect-1",
      expect.any(String),
      1,
      expect.objectContaining({
        result: expect.objectContaining({
          outcome: "woke",
          targetId: "parent-orchestration-durable-run",
        }),
      }),
    );
  });

  it("does not enqueue orchestration parent wakes across approval workspace boundaries", () => {
    const upsert = vi.fn((input: Record<string, unknown>) => ({
      effectId: String(input.targetId),
      approvalId: String(input.approvalId),
      effectKind: input.effectKind,
      targetKind: input.targetKind,
      targetId: String(input.targetId),
      idempotencyKey: "key",
      status: "pending",
      attemptCount: 0,
      payload: (input.payload as Record<string, unknown>) ?? {},
      result: {},
      version: 1,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    }));
    const ctx = {
      storage: {
        approvalEffects: { upsert, claimNextPendingEffect: vi.fn(), get: vi.fn(), listByApproval: vi.fn() },
        approvalWaitRuns: { getRunId: vi.fn(() => undefined) },
        pendingApprovalActions: { find: vi.fn(() => undefined) },
        approvalInbox: { findByApprovalAndToken: vi.fn(() => undefined) },
        chatInlineApprovals: { get: vi.fn(() => undefined) },
        chatTurnTraces: { get: vi.fn(() => undefined), listBySession: vi.fn(() => []) },
        chatDelegationSteps: { listParentsByChildSessionIds: vi.fn(() => new Map()) },
        orchestration: {
          getRun: vi.fn(() => ({
            runId: "orchestration-run-1",
            workspaceId: "workspace-other",
            planId: "plan-1",
            status: "running",
            startedAt: "2026-04-11T00:00:00.000Z",
            totalIterations: 0,
            totalCostUsd: 0,
            durableRunId: "parent-orchestration-durable-run",
            executionState: "paused_for_approval",
          })),
        },
      },
      publishRealtime: vi.fn(),
    } as unknown as ServiceContext;
    const service = new ApprovalEffectsService(ctx, {
      backgroundTasks: new Set(),
      wakeDurableRun: vi.fn(),
      requestRunProcessing: vi.fn(),
      findProactiveDurableRunIdsForApproval: vi.fn(() => []),
      executeCodeModePendingApproval: vi.fn(),
      executeApprovedPendingAction: vi.fn(),
      enqueueAfterHooks: vi.fn(),
      resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
    });

    service.enqueueResolutionEffects(
      {
        approvalId: "approval-1",
        kind: "shell.exec",
        riskLevel: "danger",
        status: "approved",
        payload: { workspaceId: "workspace-1" },
        preview: {},
        linkage: {
          runId: "orchestration-run-1",
          workspaceId: "workspace-1",
        },
        createdAt: "2026-04-11T00:00:00.000Z",
        resolvedAt: "2026-04-11T00:01:00.000Z",
        resolvedBy: "operator",
        explanationStatus: "not_requested",
      } satisfies ApprovalRequest,
      {
        decision: "approve",
        resolvedBy: "operator",
      },
    );

    expect(upsert.mock.calls.map(([input]) => input.effectKind)).not.toContain("orchestration_parent_wake");
  });

  it("skips enqueueing all effects for expired approvals", () => {
    const upsert = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { upsert, claimNextPendingEffect: vi.fn(), get: vi.fn(), listByApproval: vi.fn() },
          approvalWaitRuns: { getRunId: vi.fn(() => "approval-wait-1") },
          pendingApprovalActions: { find: vi.fn(() => undefined) },
          approvalInbox: { findByApprovalAndToken: vi.fn(() => undefined) },
          chatInlineApprovals: { get: vi.fn(() => undefined) },
          chatTurnTraces: { get: vi.fn(() => undefined) },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: vi.fn(),
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: vi.fn(() => ["proactive-1"]),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
      },
    );

    const result = service.enqueueResolutionEffects(
      {
        approvalId: "approval-1",
        kind: "shell.exec",
        riskLevel: "danger",
        status: "approved",
        payload: {},
        preview: {},
        createdAt: "2026-04-11T00:00:00.000Z",
        resolvedAt: "2026-04-11T00:01:00.000Z",
        resolvedBy: "operator",
        expiresAt: "2020-04-11T00:00:00.000Z",
        explanationStatus: "not_requested",
      } satisfies ApprovalRequest,
      {
        decision: "approve",
        resolvedBy: "operator",
      },
    );

    expect(result).toEqual([]);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("enqueues Code Mode execution when approval resolved before expiry even if effects run later", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-11T00:06:00.000Z"));
    try {
      const upsert = vi.fn((input: Record<string, unknown>) => ({
        effectId: String(input.targetId),
        approvalId: String(input.approvalId),
        effectKind: input.effectKind,
        targetKind: input.targetKind,
        targetId: String(input.targetId),
        idempotencyKey: "key",
        status: "pending",
        attemptCount: 0,
        payload: (input.payload as Record<string, unknown>) ?? {},
        result: {},
        version: 1,
        createdAt: "2026-04-11T00:06:00.000Z",
        updatedAt: "2026-04-11T00:06:00.000Z",
      }));
      const service = new ApprovalEffectsService(
        {
          storage: {
            approvalEffects: { upsert, claimNextPendingEffect: vi.fn(), get: vi.fn(), listByApproval: vi.fn() },
            approvalWaitRuns: { getRunId: vi.fn(() => undefined) },
            pendingApprovalActions: {
              find: vi.fn(() => ({
                approvalId: "approval-1",
                actionType: "code_mode.run",
                request: {},
                createdAt: "2026-04-11T00:00:00.000Z",
                resolutionStatus: "pending",
              })),
            },
            approvalInbox: { findByApprovalAndToken: vi.fn(() => undefined) },
            chatInlineApprovals: { get: vi.fn(() => undefined) },
            chatTurnTraces: { get: vi.fn(() => undefined) },
          },
          publishRealtime: vi.fn(),
        } as unknown as ServiceContext,
        {
          backgroundTasks: new Set(),
          wakeDurableRun: vi.fn(),
          requestRunProcessing: vi.fn(),
          findProactiveDurableRunIdsForApproval: vi.fn(() => []),
          executeCodeModePendingApproval: vi.fn(),
          executeApprovedPendingAction: vi.fn(),
          enqueueAfterHooks: vi.fn(),
          resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
        },
      );

      const result = service.enqueueResolutionEffects(
        {
          approvalId: "approval-1",
          kind: "code_mode.run",
          riskLevel: "danger",
          status: "approved",
          payload: {},
          preview: {},
          createdAt: "2026-04-11T00:00:00.000Z",
          resolvedAt: "2026-04-11T00:04:59.000Z",
          resolvedBy: "operator",
          expiresAt: "2026-04-11T00:05:00.000Z",
          explanationStatus: "not_requested",
        } satisfies ApprovalRequest,
        {
          decision: "approve",
          resolvedBy: "operator",
        },
      );

      expect(result.map((effect) => effect.effectKind)).toContain("pending_action_execute");
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "approval-1",
          effectKind: "pending_action_execute",
          targetKind: "pending_action",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails the effect when durable wake returns a failed outcome", async () => {
    const failEffect = vi.fn();
    const skipEffect = vi.fn();
    const completeEffect = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { failEffect, skipEffect, completeEffect },
          approvalWaitRuns: { markResolved: vi.fn() },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: vi.fn(
          (): DurableWakeResult => ({
            runId: "durable-1",
            eventKey: "approval.resolved",
            outcome: "failed",
            detail: "update conflict",
          }),
        ),
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
      },
    );

    await (
      service as unknown as {
        handleWakeEffect(effect: ApprovalEffectRecord, resolveApprovalWait: boolean): Promise<void>;
      }
    ).handleWakeEffect(
      createEffect({
        effectKind: "approval_wait_wake",
        targetKind: "durable_run",
        targetId: "durable-1",
        payload: { correlationId: "approval-1" },
      }),
      true,
    );

    expect(failEffect).toHaveBeenCalledWith(
      "effect-1",
      expect.any(String),
      1,
      expect.objectContaining({
        result: expect.objectContaining({
          outcome: "failed",
          operatorStatus: "failed",
        }),
      }),
    );
    expect(skipEffect).not.toHaveBeenCalled();
    expect(completeEffect).not.toHaveBeenCalled();
  });

  it("reconciles a previously woken wait run when retry sees queued status", async () => {
    const markResolved = vi.fn();
    const completeEffect = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { failEffect: vi.fn(), skipEffect: vi.fn(), completeEffect },
          approvalWaitRuns: { markResolved },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: vi.fn(
          (): DurableWakeResult => ({
            runId: "durable-1",
            eventKey: "approval.resolved",
            outcome: "skipped_not_waiting",
            detail: "Durable run durable-1 is queued.",
            run: {
              runId: "durable-1",
              workflowKey: "approval.wait",
              status: "queued",
              attemptCount: 0,
              maxAttempts: 3,
              version: 2,
              payload: {},
              createdAt: "2026-04-11T00:00:00.000Z",
              updatedAt: "2026-04-11T00:00:00.000Z",
            },
          }),
        ),
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
      },
    );

    await (
      service as unknown as {
        handleWakeEffect(effect: ApprovalEffectRecord, resolveApprovalWait: boolean): Promise<void>;
      }
    ).handleWakeEffect(
      createEffect({
        effectKind: "approval_wait_wake",
        targetKind: "durable_run",
        targetId: "durable-1",
      }),
      true,
    );

    expect(markResolved).toHaveBeenCalledOnce();
    expect(completeEffect).toHaveBeenCalledWith(
      "effect-1",
      expect.any(String),
      1,
      expect.objectContaining({
        result: expect.objectContaining({
          outcome: "woke",
          operatorStatus: "woke",
          reconciled: true,
          reconciledFrom: "skipped_not_waiting",
          observedRunStatus: "queued",
        }),
      }),
    );
  });

  it("does not reconcile already-running durable runs as woke", async () => {
    const markResolved = vi.fn();
    const completeEffect = vi.fn();
    const skipEffect = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { failEffect: vi.fn(), skipEffect, completeEffect },
          approvalWaitRuns: { markResolved },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: vi.fn(
          (): DurableWakeResult => ({
            runId: "durable-1",
            eventKey: "approval.resolved",
            outcome: "skipped_not_waiting",
            detail: "Durable run durable-1 is running.",
            run: {
              runId: "durable-1",
              workflowKey: "approval.wait",
              status: "running",
              attemptCount: 0,
              maxAttempts: 3,
              version: 2,
              payload: {},
              createdAt: "2026-04-11T00:00:00.000Z",
              updatedAt: "2026-04-11T00:00:00.000Z",
            },
          }),
        ),
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
      },
    );

    await (
      service as unknown as {
        handleWakeEffect(effect: ApprovalEffectRecord, resolveApprovalWait: boolean): Promise<void>;
      }
    ).handleWakeEffect(
      createEffect({
        effectKind: "approval_wait_wake",
        targetKind: "durable_run",
        targetId: "durable-1",
      }),
      true,
    );

    expect(markResolved).not.toHaveBeenCalled();
    expect(completeEffect).not.toHaveBeenCalled();
    expect(skipEffect).toHaveBeenCalledWith(
      "effect-1",
      expect.any(String),
      1,
      expect.objectContaining({
        result: expect.objectContaining({
          outcome: "already_running_unverified",
          operatorStatus: "already_running",
          reconciled: false,
          observedRunStatus: "running",
        }),
      }),
    );
  });

  it("attaches proof metadata when an already-running wake has executed approval evidence", async () => {
    const skipEffect = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { failEffect: vi.fn(), skipEffect, completeEffect: vi.fn() },
          approvalWaitRuns: { markResolved: vi.fn() },
          pendingApprovalActions: {
            find: vi.fn(() => ({
              approvalId: "approval-1",
              actionType: "tool.invoke",
              request: {},
              createdAt: "2026-04-11T00:00:00.000Z",
              resolutionStatus: "executed",
              result: {
                outcome: "executed",
              },
            })),
          },
          approvalInbox: { findByApprovalAndToken: vi.fn(() => ({ inboxItemId: "inbox-1" })) },
          approvals: { get: vi.fn() },
          chatInlineApprovals: { get: vi.fn(() => undefined) },
          chatTurnTraces: { get: vi.fn(() => ({ durable: { runId: "durable-1" } })) },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: vi.fn(
          (): DurableWakeResult => ({
            runId: "durable-1",
            eventKey: "approval.resolved",
            outcome: "skipped_not_waiting",
            detail: "Durable run durable-1 is running.",
            run: {
              runId: "durable-1",
              workflowKey: "approval.wait",
              status: "running",
              attemptCount: 0,
              maxAttempts: 3,
              version: 2,
              payload: {},
              createdAt: "2026-04-11T00:00:00.000Z",
              updatedAt: "2026-04-11T00:00:00.000Z",
            },
          }),
        ),
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
      },
    );

    await (
      service as unknown as {
        handleWakeEffect(effect: ApprovalEffectRecord, resolveApprovalWait: boolean): Promise<void>;
      }
    ).handleWakeEffect(
      createEffect({
        effectKind: "approval_wait_wake",
        targetKind: "durable_run",
        targetId: "durable-1",
      }),
      true,
    );

    expect(skipEffect).toHaveBeenCalledWith(
      "effect-1",
      expect.any(String),
      1,
      expect.objectContaining({
        result: expect.objectContaining({
          outcome: "already_running_unverified",
          proof: expect.objectContaining({
            proofSource: "pending_approval_action",
            proofStatus: "executed",
          }),
        }),
      }),
    );
  });

  it("does not re-fire an already-executed pending tool action when a replayed effect is processed", async () => {
    const completeEffect = vi.fn();
    const executeApprovedPendingAction = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { failEffect: vi.fn(), skipEffect: vi.fn(), completeEffect },
          pendingApprovalActions: {
            find: vi.fn(() => ({
              approvalId: "approval-1",
              actionType: "tool.invoke",
              request: {
                toolName: "shell.exec",
                args: {
                  command: "pwd",
                },
              },
              createdAt: "2026-04-11T00:00:00.000Z",
              resolutionStatus: "executed",
              result: {
                outcome: "executed",
                auditEventId: "audit-1",
                result: { ok: true },
              },
            })),
          },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: vi.fn(),
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction,
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
      },
    );

    await (
      service as unknown as {
        handlePendingActionExecute(effect: ApprovalEffectRecord): Promise<void>;
      }
    ).handlePendingActionExecute(
      createEffect({
        effectKind: "pending_action_execute",
        targetKind: "pending_action",
        targetId: "approval-1",
      }),
    );

    expect(executeApprovedPendingAction).not.toHaveBeenCalled();
    expect(completeEffect).toHaveBeenCalledWith(
      "effect-1",
      expect.any(String),
      1,
      expect.objectContaining({
        result: expect.objectContaining({
          actionType: "tool.invoke",
          resolutionStatus: "executed",
        }),
      }),
    );
  });

  it("emits explicit retained-stream metadata when an approval wait wake is skipped", async () => {
    const publishRealtime = vi.fn();
    const skipEffect = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { failEffect: vi.fn(), skipEffect, completeEffect: vi.fn() },
          approvalWaitRuns: { markResolved: vi.fn() },
        },
        publishRealtime,
      } as unknown as ServiceContext,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: vi.fn(
          (): DurableWakeResult => ({
            runId: "durable-1",
            eventKey: "approval.resolved",
            outcome: "skipped_paused",
            detail: "Durable run durable-1 is operator-paused.",
          }),
        ),
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
      },
    );

    await (
      service as unknown as {
        handleWakeEffect(effect: ApprovalEffectRecord, resolveApprovalWait: boolean): Promise<void>;
      }
    ).handleWakeEffect(
      createEffect({
        effectKind: "approval_wait_wake",
        targetKind: "durable_run",
        targetId: "durable-1",
      }),
      true,
    );

    expect(skipEffect).toHaveBeenCalledOnce();
    expect(publishRealtime).toHaveBeenCalledWith(
      "approval_wait_wake_skipped",
      "approvals",
      expect.objectContaining({
        approvalId: "approval-1",
        effectKind: "approval_wait_wake",
        targetId: "durable-1",
        reason: "skipped_paused",
      }),
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          approvalId: "approval-1",
          runId: "durable-1",
        },
      },
    );
  });

  it("stops polling when the worker is stopped", async () => {
    vi.useFakeTimers();
    try {
      const backgroundTasks = new Set<Promise<void>>();
      const service = new ApprovalEffectsService(
        {
          storage: {
            approvalEffects: {
              claimNextPendingEffect: vi.fn(() => undefined),
              listByApproval: vi.fn(() => []),
            },
          },
          publishRealtime: vi.fn(),
        } as unknown as ServiceContext,
        {
          backgroundTasks,
          wakeDurableRun: vi.fn(),
          requestRunProcessing: vi.fn(),
          findProactiveDurableRunIdsForApproval: vi.fn(() => []),
          executeCodeModePendingApproval: vi.fn(),
          executeApprovedPendingAction: vi.fn(),
          enqueueAfterHooks: vi.fn(),
          resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
        },
      );

      service.startWorker();
      await Promise.all([...backgroundTasks]);
      service.stopWorker();

      await vi.advanceTimersByTimeAsync(5_000);

      expect(backgroundTasks.size).toBe(0);
      expect(service["requestEffectProcessing"]).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails the effect when lease heartbeat renewal throws", async () => {
    vi.useFakeTimers();
    try {
      let effectState = createEffect({
        status: "running",
      });
      const failEffect = vi.fn(
        (_effectId: string, _workerId: string, _version: number, input: { lastError: string }) => {
          effectState = {
            ...effectState,
            status: "failed",
            lastError: input.lastError,
          };
          return effectState;
        },
      );
      const backgroundTasks = new Set<Promise<void>>();
      let resolveEffect!: () => void;
      const executeEffect = new Promise<void>((resolve) => {
        resolveEffect = resolve;
      });
      const service = new ApprovalEffectsService(
        {
          storage: {
            approvalEffects: {
              claimNextPendingEffect: vi.fn(() => (effectState.status === "running" ? effectState : undefined)),
              listByApproval: vi.fn(() => []),
              get: vi.fn(() => effectState),
              renewEffectLease: vi.fn(() => {
                throw new Error("lease renewal failed");
              }),
              failEffect,
            },
          },
          publishRealtime: vi.fn(),
        } as unknown as ServiceContext,
        {
          backgroundTasks,
          wakeDurableRun: vi.fn(),
          requestRunProcessing: vi.fn(),
          findProactiveDurableRunIdsForApproval: vi.fn(() => []),
          executeCodeModePendingApproval: vi.fn(() => executeEffect.then(() => undefined)),
          executeApprovedPendingAction: vi.fn(),
          enqueueAfterHooks: vi.fn(),
          resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
        },
      );
      effectState = {
        ...effectState,
        claimedBy: (service as unknown as { workerId: string }).workerId,
      };

      (
        service as unknown as {
          executeClaimedEffect(effectId: string): Promise<void>;
        }
      ).executeClaimedEffect = vi.fn(() => executeEffect) as never;

      service.startWorker();
      await vi.advanceTimersByTimeAsync(5_100);
      await Promise.allSettled([...backgroundTasks]);
      resolveEffect();

      expect(failEffect).toHaveBeenCalledOnce();
      expect(effectState.status).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts pending-action execution without terminal writes after lease ownership moves", async () => {
    vi.useFakeTimers();
    try {
      let effectState = createEffect({
        effectKind: "pending_action_execute",
        targetKind: "approval",
        targetId: "approval-1",
        status: "running",
      });
      const completeEffect = vi.fn();
      const failEffect = vi.fn();
      const skipEffect = vi.fn();
      const markResolved = vi.fn();
      const backgroundTasks = new Set<Promise<void>>();
      let capturedSignal: AbortSignal | undefined;
      let claimed = false;
      const executeApprovedPendingAction = vi.fn(
        (_approvalId: string, signal?: AbortSignal) =>
          new Promise<undefined>((_resolve, reject) => {
            capturedSignal = signal;
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener(
              "abort",
              () => {
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      );
      const service = new ApprovalEffectsService(
        {
          storage: {
            approvalEffects: {
              claimNextPendingEffect: vi.fn(() => {
                if (claimed || effectState.status !== "running" || effectState.claimedBy === "worker-other") {
                  return undefined;
                }
                claimed = true;
                return effectState;
              }),
              listByApproval: vi.fn(() => []),
              get: vi.fn(() => effectState),
              renewEffectLease: vi.fn(() => {
                effectState = {
                  ...effectState,
                  claimedBy: "worker-other",
                };
                return false;
              }),
              completeEffect,
              failEffect,
              skipEffect,
            },
            pendingApprovalActions: {
              find: vi.fn(() => ({
                approvalId: "approval-1",
                actionType: "tool.invoke",
                request: {},
                createdAt: "2026-04-11T00:00:00.000Z",
                resolutionStatus: "pending",
              })),
              markResolved,
            },
          },
          publishRealtime: vi.fn(),
        } as unknown as ServiceContext,
        {
          backgroundTasks,
          wakeDurableRun: vi.fn(),
          requestRunProcessing: vi.fn(),
          findProactiveDurableRunIdsForApproval: vi.fn(() => []),
          executeCodeModePendingApproval: vi.fn(),
          executeApprovedPendingAction,
          enqueueAfterHooks: vi.fn(),
          resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
        },
      );
      effectState = {
        ...effectState,
        claimedBy: (service as unknown as { workerId: string }).workerId,
      };

      service.startWorker();
      await vi.advanceTimersByTimeAsync(5_100);
      service.stopWorker();
      await Promise.allSettled([...backgroundTasks]);

      expect(executeApprovedPendingAction).toHaveBeenCalledOnce();
      expect(capturedSignal?.aborted).toBe(true);
      expect(completeEffect).not.toHaveBeenCalled();
      expect(failEffect).not.toHaveBeenCalled();
      expect(skipEffect).not.toHaveBeenCalled();
      expect(markResolved).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps pending Code Mode effects recoverable when execution is already claimed", async () => {
    let effectState = createEffect({
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "approval-1",
      status: "running",
    });
    const completeEffect = vi.fn();
    const failEffect = vi.fn();
    const skipEffect = vi.fn();
    const markResolved = vi.fn();
    const publishRealtime = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            get: vi.fn(() => effectState),
            completeEffect,
            failEffect,
            skipEffect,
          },
          pendingApprovalActions: {
            find: vi.fn(() => ({
              approvalId: "approval-1",
              actionType: "code_mode.run",
              request: { runId: "code-run-1" },
              createdAt: "2026-04-11T00:00:00.000Z",
              resolutionStatus: "pending",
            })),
            markResolved,
          },
        },
        publishRealtime,
      } as unknown as ServiceContext,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: vi.fn(),
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(async () => undefined),
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
      },
    );
    effectState = {
      ...effectState,
      claimedBy: (service as unknown as { workerId: string }).workerId,
    };

    await (
      service as unknown as {
        handlePendingActionExecute(effect: ApprovalEffectRecord): Promise<void>;
      }
    ).handlePendingActionExecute(
      createEffect({
        effectKind: "pending_action_execute",
        targetKind: "pending_action",
        targetId: "approval-1",
      }),
    );

    expect(markResolved).not.toHaveBeenCalled();
    expect(failEffect).not.toHaveBeenCalled();
    expect(completeEffect).not.toHaveBeenCalled();
    expect(skipEffect).not.toHaveBeenCalled();
    expect(publishRealtime).toHaveBeenCalledWith(
      "approval_effect_deferred",
      "approvals",
      expect.objectContaining({
        approvalId: "approval-1",
        actionType: "code_mode.run",
        reason: "code_mode_run_already_claimed",
        resolutionStatus: "pending",
      }),
      expect.objectContaining({
        links: {
          approvalId: "approval-1",
          runId: "code-run-1",
        },
      }),
    );
  });

  it("materializes approved tool actions into linked chat and delegation state", async () => {
    let effectState = createEffect({
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "approval-1",
      status: "running",
    });
    let parentStep: ChatDelegationStepRecord = {
      stepId: "delegation-run-1:worker",
      runId: "delegation-run-1",
      role: "worker",
      label: "Worker",
      status: "running",
      index: 0,
      providerId: "openai",
      model: "gpt-test",
      startedAt: "2026-04-11T00:00:00.000Z",
      childSessionId: "child-session-1",
      childTurnId: "child-turn-1",
      durableRunId: "child-durable-run",
    };
    const childTrace: ChatTurnTraceRecord = {
      turnId: "child-turn-1",
      sessionId: "child-session-1",
      userMessageId: "user-child-1",
      branchKind: "append",
      status: "waiting_for_approval",
      mode: "cowork",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      startedAt: "2026-04-11T00:00:00.000Z",
      toolRuns: [],
      citations: [],
      durable: { runId: "child-durable-run", status: "waiting", checkpointKind: "run_waiting" },
      failure: {
        failureClass: "approval_required",
        message: "Approval required by policy.",
        retryable: true,
        recommendedAction: "retry",
      },
    };
    const parentTrace: ChatTurnTraceRecord = {
      turnId: "parent-turn-1",
      sessionId: "parent-session-1",
      userMessageId: "user-parent-1",
      branchKind: "append",
      status: "waiting_for_approval",
      mode: "cowork",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      startedAt: "2026-04-11T00:00:00.000Z",
      toolRuns: [],
      citations: [],
      durable: { runId: "parent-durable-run", status: "waiting", checkpointKind: "run_waiting" },
      orchestration: {
        runId: "delegation-run-1",
        objective: "Create a deck",
        workflowTemplate: "cowork.plan.work.synthesize",
        status: "running",
        modePolicy: "cowork",
        visibility: "expandable",
        finalSummary: "Waiting",
        routeDecision: {
          workflowTemplate: "cowork.plan.work.synthesize",
          visibility: "expandable",
          intensity: "balanced",
          reviewDepth: "standard",
          parallelism: "sequential",
          selectedRoles: ["worker"],
          selectedProviders: [],
          triggerReason: "test",
        },
        steps: [],
      },
    };
    const completeEffect = vi.fn();
    const markResolved = vi.fn();
    const chatMessagesUpsert = vi.fn();
    const chatToolRunsPatch = vi.fn();
    const chatTurnTracesPatch = vi.fn();
    const durableUpdateRun = vi.fn((input: Record<string, unknown>) => ({
      runId: input.runId,
      status: input.status,
      metadata: input.metadata,
    }));
    const durableCreateCheckpoint = vi.fn();
    const delegationStepPatch = vi.fn((stepId: string, input: Partial<ChatDelegationStepRecord>) => {
      parentStep = { ...parentStep, ...input } as ChatDelegationStepRecord;
      return parentStep;
    });
    const delegationRunPatch = vi.fn();
    const executionPlanPatch = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            get: vi.fn(() => effectState),
            completeEffect,
            failEffect: vi.fn(),
            skipEffect: vi.fn(),
          },
          pendingApprovalActions: {
            find: vi.fn(() => ({
              approvalId: "approval-1",
              actionType: "tool.invoke",
              request: { toolName: "presentations.create" },
              createdAt: "2026-04-11T00:00:00.000Z",
              resolutionStatus: "pending",
            })),
            markResolved,
          },
          chatInlineApprovals: {
            get: vi.fn(() => ({
              approvalId: "approval-1",
              sessionId: "child-session-1",
              turnId: "child-turn-1",
              toolName: "presentations.create",
              status: "pending",
              reason: "Approval required by policy.",
              createdAt: "2026-04-11T00:00:00.000Z",
            })),
            upsert: vi.fn(),
          },
          chatToolRuns: {
            listByTurn: vi.fn(() => [
              {
                toolRunId: "tool-run-1",
                turnId: "child-turn-1",
                sessionId: "child-session-1",
                toolName: "presentations.create",
                status: "approval_required",
                approvalId: "approval-1",
                startedAt: "2026-04-11T00:00:00.000Z",
              },
            ]),
            patch: chatToolRunsPatch,
          },
          chatMessages: { upsert: chatMessagesUpsert },
          chatTurnTraces: {
            get: vi.fn((turnId: string) => (turnId === "child-turn-1" ? childTrace : parentTrace)),
            patch: chatTurnTracesPatch,
            listBySession: vi.fn(() => [parentTrace]),
          },
          durableRuns: {
            getRun: vi.fn((runId: string) => ({ runId, status: "waiting", metadata: {} })),
            updateRun: durableUpdateRun,
            createCheckpoint: durableCreateCheckpoint,
          },
          chatDelegationSteps: {
            listParentsByChildSessionIds: vi.fn(
              () =>
                new Map([
                  [
                    "child-session-1",
                    {
                      parentSessionId: "parent-session-1",
                      runId: "delegation-run-1",
                      stepId: "delegation-run-1:worker",
                      role: "worker",
                      label: "Worker",
                      index: 0,
                    },
                  ],
                ]),
            ),
            get: vi.fn(() => parentStep),
            patch: delegationStepPatch,
            listByRun: vi.fn(() => [parentStep]),
          },
          chatDelegationRuns: {
            get: vi.fn(() => ({
              runId: "delegation-run-1",
              sessionId: "parent-session-1",
              taskId: "chat-orchestration:parent-turn-1",
              objective: "Create a deck",
              roles: ["worker"],
              mode: "sequential",
              status: "running",
              executionPlanId: "plan-1",
              citations: [],
              startedAt: "2026-04-11T00:00:00.000Z",
            })),
            patch: delegationRunPatch,
          },
          chatExecutionPlans: {
            get: vi.fn(() => ({
              planId: "plan-1",
              sessionId: "parent-session-1",
              turnId: "parent-turn-1",
              mode: "cowork",
              planningMode: "off",
              status: "running",
              source: "workflow_template",
              advisoryOnly: false,
              objective: "Create a deck",
              summary: "Worker",
              steps: [
                {
                  stepId: "worker",
                  index: 0,
                  objective: "Create the deck",
                  parallelizable: false,
                  status: "running",
                  childSessionId: "child-session-1",
                  childTurnId: "child-turn-1",
                  durableRunId: "child-durable-run",
                },
              ],
              createdAt: "2026-04-11T00:00:00.000Z",
              updatedAt: "2026-04-11T00:00:00.000Z",
            })),
            patch: executionPlanPatch,
          },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: vi.fn(),
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction: vi.fn(async () => ({
          outcome: "executed",
          policyReason: "approved",
          auditEventId: "audit-1",
          result: {
            title: "Benefits of Daily Walking",
            path: "F:\\code\\personal-ai\\workspace\\goatcitadel_out\\walking.pptx",
            slideCount: 6,
            format: "pptx",
          },
        })),
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
      },
    );
    effectState = {
      ...effectState,
      claimedBy: (service as unknown as { workerId: string }).workerId,
    };

    await (
      service as unknown as {
        handlePendingActionExecute(effect: ApprovalEffectRecord): Promise<void>;
      }
    ).handlePendingActionExecute(effectState);

    expect(markResolved).toHaveBeenCalledWith(
      "approval-1",
      "executed",
      expect.objectContaining({
        outcome: "executed",
        result: expect.objectContaining({ slideCount: 6 }),
      }),
    );
    expect(chatToolRunsPatch).toHaveBeenCalledWith(
      "tool-run-1",
      expect.objectContaining({
        status: "executed",
        result: expect.objectContaining({ format: "pptx" }),
      }),
    );
    expect(chatMessagesUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "child-session-1",
        content: expect.stringContaining("Benefits of Daily Walking"),
      }),
      expect.any(String),
    );
    expect(chatTurnTracesPatch).toHaveBeenCalledWith(
      "child-turn-1",
      expect.objectContaining({
        status: "completed",
        assistantMessageId: "assistant-approved-child-turn-1",
      }),
    );
    expect(delegationStepPatch).toHaveBeenCalledWith(
      "delegation-run-1:worker",
      expect.objectContaining({
        status: "completed",
        childTurnId: "child-turn-1",
      }),
    );
    expect(delegationRunPatch).toHaveBeenCalledWith(
      "delegation-run-1",
      expect.objectContaining({
        status: "completed",
        stitchedOutput: expect.stringContaining("Benefits of Daily Walking"),
      }),
    );
    expect(executionPlanPatch).toHaveBeenCalledWith(
      "plan-1",
      expect.objectContaining({
        status: "completed",
      }),
    );
    expect(durableUpdateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "child-durable-run",
        status: "completed",
      }),
    );
    expect(durableUpdateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "parent-durable-run",
        status: "completed",
      }),
    );
    expect(durableCreateCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "child-durable-run",
        checkpointKind: "run_completed",
      }),
    );
    expect(completeEffect).toHaveBeenCalledWith(
      "effect-1",
      expect.any(String),
      1,
      expect.objectContaining({
        result: expect.objectContaining({ outcome: "executed" }),
      }),
    );
  });

  it("completes remote inbox follow-up effects when the inbox item is missing", async () => {
    const completeEffect = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { failEffect: vi.fn(), completeEffect },
          approvalInbox: {
            get: vi.fn(),
            findByApprovalAndToken: vi.fn(() => undefined),
          },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: vi.fn(),
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
      },
    );

    await (
      service as unknown as {
        handleApprovalInboxFollowUp(effect: ApprovalEffectRecord): Promise<void>;
      }
    ).handleApprovalInboxFollowUp(
      createEffect({
        effectKind: "approval_inbox_follow_up",
        targetKind: "remote_token",
        targetId: "token-1",
        payload: {
          decision: "edit",
          approvalStatus: "unexpected",
          resolvedBy: "operator:test",
        },
      }),
    );

    expect(completeEffect).toHaveBeenCalledWith(
      "effect-1",
      expect.any(String),
      1,
      expect.objectContaining({
        result: {
          tokenId: "token-1",
          inboxItemId: undefined,
          state: "missing",
        },
      }),
    );
  });

  it("falls back from stale inbox ids and persists pending inbox follow-up resolution", async () => {
    const completeEffect = vi.fn();
    const markResolved = vi.fn(() => ({
      inboxItemId: "inbox-live",
      state: "approved",
      approvalStatus: "approved",
    }));
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { failEffect: vi.fn(), completeEffect },
          approvalInbox: {
            get: vi.fn(() => {
              throw new Error("stale inbox id");
            }),
            findByApprovalAndToken: vi.fn(() => ({
              inboxItemId: "inbox-live",
              state: "pending",
              approvalStatus: "pending",
            })),
            markResolved,
          },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: vi.fn(),
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
      },
    );

    await (
      service as unknown as {
        handleApprovalInboxFollowUp(effect: ApprovalEffectRecord): Promise<void>;
      }
    ).handleApprovalInboxFollowUp(
      createEffect({
        effectKind: "approval_inbox_follow_up",
        targetKind: "remote_token",
        targetId: "token-1",
        payload: {
          inboxItemId: "inbox-stale",
          decision: "approve",
          approvalStatus: "approved",
          resolvedBy: "operator:test",
        },
      }),
    );

    expect(markResolved).toHaveBeenCalledWith(
      "inbox-live",
      expect.objectContaining({
        state: "approved",
        approvalStatus: "approved",
        resolvedBy: "operator:test",
      }),
    );
    expect(completeEffect).toHaveBeenCalledWith(
      "effect-1",
      expect.any(String),
      1,
      expect.objectContaining({
        result: {
          inboxItemId: "inbox-live",
          tokenId: "token-1",
          state: "approved",
        },
      }),
    );
  });

  it("enqueues both approval.resolve.after and approval.response.after observer hooks", async () => {
    const enqueueAfterHooks = vi.fn();
    const completeEffect = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { completeEffect, failEffect: vi.fn() },
          approvals: {
            get: vi.fn(
              () =>
                ({
                  approvalId: "approval-1",
                  kind: "shell.exec",
                  riskLevel: "danger",
                  status: "approved",
                  payload: {},
                  preview: {},
                  createdAt: "2026-04-11T00:00:00.000Z",
                  resolvedAt: "2026-04-11T00:01:00.000Z",
                  resolvedBy: "operator",
                  explanationStatus: "not_requested",
                }) satisfies ApprovalRequest,
            ),
          },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: vi.fn(),
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks,
        resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
      },
    );

    await (
      service as unknown as {
        handleApprovalAfterHooks(effect: ApprovalEffectRecord): Promise<void>;
      }
    ).handleApprovalAfterHooks(
      createEffect({
        effectKind: "approval_after_hooks",
        targetKind: "approval",
        targetId: "approval-1",
        payload: {
          decision: "approve",
          resolvedBy: "operator",
          deliveryChannel: "chat",
        },
      }),
    );

    const triggers = enqueueAfterHooks.mock.calls.map(([input]) => input.trigger);
    expect(triggers).toContain("approval.resolve.after");
    expect(triggers).toContain("approval.response.after");

    const responseCall = enqueueAfterHooks.mock.calls.find(([input]) => input.trigger === "approval.response.after");
    expect(responseCall?.[0]).toEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        trigger: "approval.response.after",
        entityType: "approval",
        entityId: "approval-1",
        payload: expect.objectContaining({
          decision: "approve",
          resolvedBy: "operator",
          deliveryChannel: "chat",
        }),
      }),
    );
    expect(completeEffect).toHaveBeenCalledOnce();
  });

  it("fails remote inbox follow-up effects when an already-resolved item disagrees", async () => {
    const failEffect = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { failEffect, completeEffect: vi.fn() },
          approvalInbox: {
            get: vi.fn(() => ({
              inboxItemId: "inbox-1",
              state: "rejected",
              approvalStatus: "rejected",
            })),
            findByApprovalAndToken: vi.fn(),
          },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        backgroundTasks: new Set(),
        wakeDurableRun: vi.fn(),
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
      },
    );

    await (
      service as unknown as {
        handleApprovalInboxFollowUp(effect: ApprovalEffectRecord): Promise<void>;
      }
    ).handleApprovalInboxFollowUp(
      createEffect({
        effectKind: "approval_inbox_follow_up",
        targetKind: "remote_token",
        targetId: "token-1",
        payload: {
          inboxItemId: "inbox-1",
          decision: "approve",
          approvalStatus: "approved",
        },
      }),
    );

    expect(failEffect).toHaveBeenCalledWith(
      "effect-1",
      expect.any(String),
      1,
      expect.objectContaining({
        lastError: "Approval inbox item inbox-1 is already rejected; expected approved.",
        result: expect.objectContaining({
          inboxItemId: "inbox-1",
          tokenId: "token-1",
          observedState: "rejected",
          expectedState: "approved",
          observedApprovalStatus: "rejected",
          expectedApprovalStatus: "approved",
        }),
      }),
    );
  });
});

function createEffect(overrides: Partial<ApprovalEffectRecord>): ApprovalEffectRecord {
  return {
    effectId: "effect-1",
    approvalId: "approval-1",
    effectKind: "approval_after_hooks",
    targetKind: "approval",
    targetId: "approval-1",
    idempotencyKey: "approval-1:approval_after_hooks:approval:approval-1",
    status: "pending",
    attemptCount: 0,
    payload: {},
    result: {},
    version: 1,
    createdAt: "2026-04-11T00:00:00.000Z",
    updatedAt: "2026-04-11T00:00:00.000Z",
    ...overrides,
  };
}
