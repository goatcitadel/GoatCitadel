import type { ApprovalEffectRecord, ApprovalRequest, DurableWakeResult } from "@goatcitadel/contracts";
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
      "approval_wait_wake",
      "proactive_run_wake",
      "linked_chat_turn_wake",
      "pending_action_execute",
      "approval_inbox_follow_up",
      "approval_after_hooks",
    ]);
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

    expect(failEffect).toHaveBeenCalledOnce();
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
      const failEffect = vi.fn((_effectId: string, _workerId: string, _version: number, input: { lastError: string }) => {
        effectState = {
          ...effectState,
          status: "failed",
          lastError: input.lastError,
        };
        return effectState;
      });
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
