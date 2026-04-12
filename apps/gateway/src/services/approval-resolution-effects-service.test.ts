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
