import type {
  ApprovalEffectRecord,
  ApprovalObservabilityEnvelope,
  ApprovalRequest,
  ChatDelegationStepRecord,
  ChatTurnTraceRecord,
  DurableWakeResult,
  PendingApprovalAction,
} from "@goatcitadel/contracts";
import { ConflictError, canonicalJsonString } from "@goatcitadel/contracts";
import {
  createSqliteAsyncStorage,
  getRequestAttribution,
  runWithRequestAttribution,
  Storage,
} from "@goatcitadel/storage";
import { describe, expect, it, vi } from "vitest";
import {
  ApprovalEffectsService,
  deriveApprovalResolutionEffectsResult,
} from "./approval-resolution-effects-service.js";
import {
  ExternalSourceKnowledgeEffectServiceError,
  deriveExternalSourceKnowledgeSnapshotApprovalId,
  deriveExternalSourceKnowledgeSnapshotMaterializedIdentities,
} from "./external-source-knowledge-effect-service.js";
import { APPROVAL_OBSERVABILITY_REALTIME_ENVELOPE_KEY } from "./realtime-event-service.js";
import type { ServiceContext } from "./service-context.js";
import {
  buildChatTurnRuntimeAuthoritySeal,
  withChatTurnRuntimeAuthority,
  withChatTurnRuntimeAuthorityCheckpoint,
} from "./chat-durable-runtime-authority.js";
import { markGeneralChatPostCommitPending } from "./chat-durable-run-service.js";
import { DURABLE_RETRY_POLICY_DEFAULT } from "./durable-retry-policy.js";
import {
  computeEffectiveChatTurnRequestMaterialSha256,
  computeFrozenChatTurnAdmissionMaterialSha256,
} from "./session-control-service.js";

const APPROVAL_TEST_POST_COMMIT_ELIGIBILITY = {
  version: 1 as const,
  autonomyEnabledAtParentSettlement: true,
  evalIntegrityTurn: false,
  humanSession: true,
};

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

  it("surfaces a queued linked-turn durable run id before the wake result exists", () => {
    const result = deriveApprovalResolutionEffectsResult([
      createEffect({
        effectKind: "linked_chat_turn_wake",
        targetKind: "chat_turn",
        targetId: "turn-queued",
        status: "pending",
        payload: { runId: "durable-queued" },
        result: {},
      }),
    ]);

    expect(result?.chatTurnResume).toEqual({
      resumed: false,
      turnId: "turn-queued",
      durableRunId: "durable-queued",
      wakeOutcome: undefined,
    });
  });

  it("moves a woken approval-blocked Chat trace to running before dispatch is requested", async () => {
    const effect = createEffect({
      effectKind: "linked_chat_turn_wake",
      targetKind: "chat_turn",
      targetId: "turn-resumed",
      status: "running",
      payload: { runId: "durable-resumed" },
    });
    let trace: ChatTurnTraceRecord = {
      ...createWaitingChildTrace("session-resumed", effect.targetId),
      durable: { runId: "durable-resumed", status: "waiting", checkpointKind: "run_waiting" },
    };
    const patchIfStatus = vi.fn(
      (
        turnId: string,
        expectedStatuses: readonly ChatTurnTraceRecord["status"][],
        patch: { status?: ChatTurnTraceRecord["status"] },
      ) => {
        if (turnId !== trace.turnId || !expectedStatuses.includes(trace.status)) return undefined;
        trace = { ...trace, ...patch };
        return trace;
      },
    );
    const completeEffect = vi.fn(() => ({ ...effect, status: "completed" as const }));
    const requestRunProcessing = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            completeEffect,
            failEffect: vi.fn(),
            skipEffect: vi.fn(),
          },
          chatTurnTraces: {
            get: vi.fn(() => trace),
            patchIfStatus,
          },
          runImmediateTransaction: <T>(work: () => T): T => work(),
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        ...createApprovalEffectDeps(),
        wakeDurableRun: vi.fn(() => ({
          runId: "durable-resumed",
          eventKey: "approval.resolved",
          correlationId: effect.approvalId,
          outcome: "woke" as const,
          run: { runId: "durable-resumed", status: "queued" as const },
        })),
        requestRunProcessing,
      },
    );

    await (
      service as unknown as {
        handleLinkedChatTurnWake(currentEffect: ApprovalEffectRecord): Promise<void>;
      }
    ).handleLinkedChatTurnWake(effect);

    expect(patchIfStatus).toHaveBeenCalledWith(effect.targetId, ["waiting_for_approval"], { status: "running" });
    expect(trace.status).toBe("running");
    expect(completeEffect).toHaveBeenCalledWith(
      effect.effectId,
      expect.any(String),
      effect.version,
      expect.objectContaining({ result: expect.objectContaining({ outcome: "woke" }) }),
    );
    expect(patchIfStatus.mock.invocationCallOrder[0]).toBeLessThan(completeEffect.mock.invocationCallOrder[0]!);
    expect(requestRunProcessing).toHaveBeenCalledWith("durable-resumed");
  });

  it("defers a previously claimed linked Chat wake until approved action settlement commits", async () => {
    const effect = createEffect({
      effectKind: "linked_chat_turn_wake",
      targetKind: "chat_turn",
      targetId: "turn-raced-wake",
      status: "running",
      payload: { runId: "durable-raced-wake" },
    });
    const actionEffect = createEffect({
      effectId: "effect-pending-action-race",
      approvalId: effect.approvalId,
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: effect.approvalId,
      status: "running",
    });
    const deferEffectForRetry = vi.fn(() => ({ ...effect, status: "running" as const }));
    const wakeDurableRun = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            listByApproval: vi.fn(() => [actionEffect, effect]),
            deferEffectForRetry,
            get: vi.fn(() => effect),
          },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        ...createApprovalEffectDeps(),
        wakeDurableRun,
      },
    );

    await (
      service as unknown as {
        handleLinkedChatTurnWake(currentEffect: ApprovalEffectRecord): Promise<void>;
      }
    ).handleLinkedChatTurnWake(effect);

    expect(deferEffectForRetry).toHaveBeenCalledWith(
      effect.effectId,
      expect.any(String),
      effect.version,
      expect.objectContaining({
        lastError: expect.stringContaining("settlement has not committed"),
        result: expect.objectContaining({
          reason: "pending_action_not_settled",
          pendingActionEffectId: actionEffect.effectId,
        }),
      }),
    );
    expect(wakeDurableRun).not.toHaveBeenCalled();
  });

  it("defers a linked Chat wake when a completed tool action is missing continuation evidence", async () => {
    const effect = createEffect({
      effectKind: "linked_chat_turn_wake",
      targetKind: "chat_turn",
      targetId: "turn-missing-continuation-evidence",
      status: "running",
      payload: { runId: "durable-missing-continuation-evidence" },
    });
    const actionEffect = createEffect({
      effectId: "effect-completed-action-missing-evidence",
      approvalId: effect.approvalId,
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: effect.approvalId,
      status: "completed",
    });
    const deferEffectForRetry = vi.fn(() => ({ ...effect, status: "running" as const }));
    const wakeDurableRun = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            listByApproval: vi.fn(() => [actionEffect, effect]),
            deferEffectForRetry,
            get: vi.fn(() => effect),
          },
          pendingApprovalActions: {
            find: vi.fn(() => ({ actionType: "tool.invoke", resolutionStatus: "executed" })),
          },
          chatInlineApprovals: { get: vi.fn(() => undefined) },
          chatToolRuns: { listByTurn: vi.fn(() => []) },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        ...createApprovalEffectDeps(),
        wakeDurableRun,
      },
    );

    await (
      service as unknown as {
        handleLinkedChatTurnWake(currentEffect: ApprovalEffectRecord): Promise<void>;
      }
    ).handleLinkedChatTurnWake(effect);

    expect(deferEffectForRetry).toHaveBeenCalledWith(
      effect.effectId,
      expect.any(String),
      effect.version,
      expect.objectContaining({
        result: expect.objectContaining({
          reason: "approved_action_evidence_incomplete",
          inlineApprovalStatus: "missing",
        }),
      }),
    );
    expect(wakeDurableRun).not.toHaveBeenCalled();
  });

  it("captures attribution and delegates observability allocation to the atomic repository batch", async () => {
    const effect = createEffect({
      effectId: "observability-effect-1",
      approvalId: "approval-1",
      effectKind: "approval_observability",
      targetKind: "approval",
      targetId: "approval-resolved-audit-v1",
      idempotencyKey: "approval-observability:approval-1:approval-resolved-audit-v1",
    });
    const upsertObservabilityBatch = vi.fn(() => [effect]);
    const requestEffectProcessing = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { upsertObservabilityBatch },
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
    service.requestEffectProcessing = requestEffectProcessing;

    const [first] = await runWithRequestAttribution({ actorId: "operator-first", traceId: "trace-first" }, () =>
      service.enqueueObservabilityEffects("approval-1", [
        {
          operationId: "approval-resolved-audit-v1",
          delivery: {
            kind: "audit",
            stream: "approvals",
            payload: { action: "approval.resolved", approvalId: "approval-1" },
          },
        },
      ]),
    );
    const [duplicate] = await runWithRequestAttribution({ actorId: "operator-retry", traceId: "trace-retry" }, () =>
      service.enqueueObservabilityEffects("approval-1", [
        {
          operationId: "approval-resolved-audit-v1",
          delivery: {
            kind: "audit",
            stream: "approvals",
            payload: { action: "approval.resolved", approvalId: "approval-1" },
          },
        },
      ]),
    );

    expect(duplicate?.effectId).toBe(first?.effectId);
    expect(upsertObservabilityBatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        approvalId: "approval-1",
        occurredAt: expect.any(String),
        attribution: { actorId: "operator-first", traceId: "trace-first" },
        items: [
          {
            operationId: "approval-resolved-audit-v1",
            delivery: {
              kind: "audit",
              stream: "approvals",
              payload: { action: "approval.resolved", approvalId: "approval-1" },
            },
          },
        ],
      }),
    );
    expect(upsertObservabilityBatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        approvalId: "approval-1",
        attribution: { actorId: "operator-retry", traceId: "trace-retry" },
      }),
    );
    expect(requestEffectProcessing).toHaveBeenCalledTimes(2);
  });

  it("persists and enforces per-approval observability predecessor order", async () => {
    const persisted = new Map<string, ApprovalEffectRecord>();
    const upsert = vi.fn((input: Record<string, unknown>) => {
      const key = String(input.idempotencyKey);
      const existing = persisted.get(key);
      if (existing) {
        return existing;
      }
      const effect = createEffect({
        effectId: `observability-${persisted.size + 1}`,
        approvalId: String(input.approvalId),
        effectKind: "approval_observability",
        targetKind: "approval",
        targetId: String(input.targetId),
        idempotencyKey: key,
        payload: input.payload as Record<string, unknown>,
      });
      persisted.set(key, effect);
      return effect;
    });
    const upsertObservabilityBatch = vi.fn(
      (input: {
        approvalId: string;
        occurredAt: string;
        attribution?: ApprovalObservabilityEnvelope["attribution"];
        items: Array<{ operationId: string; delivery: ApprovalObservabilityEnvelope["delivery"] }>;
      }) => {
        const latest = [...persisted.values()]
          .map((effect) => effect.payload as unknown as ApprovalObservabilityEnvelope)
          .sort((left, right) => left.orderIndex - right.orderIndex)
          .at(-1);
        let orderIndex = (latest?.orderIndex ?? 0) + 1;
        let predecessorDeliveryId = latest?.deliveryId;
        return input.items.map((item) => {
          const deliveryId = `approval-observability:${input.approvalId}:${item.operationId}`;
          const effect = upsert({
            approvalId: input.approvalId,
            targetId: item.operationId,
            idempotencyKey: deliveryId,
            payload: {
              schemaVersion: "approval_observability.v1",
              deliveryId,
              operationId: item.operationId,
              occurredAt: input.occurredAt,
              orderIndex,
              ...(predecessorDeliveryId ? { predecessorDeliveryId } : {}),
              ...(input.attribution ? { attribution: input.attribution } : {}),
              delivery: item.delivery,
            },
          });
          predecessorDeliveryId = deliveryId;
          orderIndex += 1;
          return effect;
        });
      },
    );
    const append = vi.fn(async () => undefined);
    const deferEffectForRetry = vi.fn(
      (effectId: string, claimedBy: string, _version: number, input: { result: Record<string, unknown> }) => {
        const current = [...persisted.values()].find((effect) => effect.effectId === effectId)!;
        const next = { ...current, claimedBy, result: input.result };
        persisted.set(current.idempotencyKey, next);
        return next;
      },
    );
    const completeEffect = vi.fn((effectId: string) => {
      const current = [...persisted.values()].find((effect) => effect.effectId === effectId)!;
      const next = { ...current, status: "completed" as const };
      persisted.set(current.idempotencyKey, next);
      return next;
    });
    const approvalEffects = {
      upsert,
      upsertObservabilityBatch,
      listByApproval: vi.fn(() => [...persisted.values()]),
      getByIdempotencyKey: vi.fn((key: string) => persisted.get(key)),
      get: vi.fn((effectId: string) => [...persisted.values()].find((effect) => effect.effectId === effectId)!),
      deferEffectForRetry,
      completeEffect,
      failEffect: vi.fn(),
    };
    const service = new ApprovalEffectsService(
      {
        storage: { approvalEffects, audit: { append } },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );
    service.requestEffectProcessing = vi.fn();

    await service.enqueueObservabilityEffects("approval-ordered", [
      {
        operationId: "approval.create.audit",
        delivery: { kind: "audit", stream: "approvals", payload: { event: "approval.create" } },
      },
      {
        operationId: "approval.create.realtime",
        delivery: { kind: "realtime", eventType: "approval_created", source: "approvals", payload: {} },
      },
    ]);
    await service.enqueueObservabilityEffects("approval-ordered", [
      {
        operationId: "approval.resolve.audit",
        delivery: { kind: "audit", stream: "approvals", payload: { event: "approval.resolve" } },
      },
      {
        operationId: "approval.resolve.realtime",
        delivery: { kind: "realtime", eventType: "approval_resolved", source: "approvals", payload: {} },
      },
    ]);

    const ordered = [...persisted.values()].map((effect) => effect.payload as unknown as ApprovalObservabilityEnvelope);
    expect(ordered.map((envelope) => envelope.orderIndex)).toEqual([1, 2, 3, 4]);
    expect(ordered.map((envelope) => envelope.predecessorDeliveryId)).toEqual([
      undefined,
      ordered[0]?.deliveryId,
      ordered[1]?.deliveryId,
      ordered[2]?.deliveryId,
    ]);

    const resolveAuditKey = ordered[2]!.deliveryId;
    const createRealtimeKey = ordered[1]!.deliveryId;
    let resolveAudit = claimEffectForService(service, {
      ...persisted.get(resolveAuditKey)!,
      status: "running",
      attemptCount: 1,
    });
    persisted.set(resolveAuditKey, resolveAudit);
    await (service as unknown as { executeClaimedEffect(effectId: string): Promise<void> }).executeClaimedEffect(
      resolveAudit.effectId,
    );
    expect(append).not.toHaveBeenCalled();
    expect(deferEffectForRetry).toHaveBeenCalledOnce();

    persisted.set(createRealtimeKey, { ...persisted.get(createRealtimeKey)!, status: "completed" });
    resolveAudit = claimEffectForService(service, { ...persisted.get(resolveAuditKey)!, status: "running" });
    persisted.set(resolveAuditKey, resolveAudit);
    await (service as unknown as { executeClaimedEffect(effectId: string): Promise<void> }).executeClaimedEffect(
      resolveAudit.effectId,
    );
    expect(append).toHaveBeenCalledOnce();
    expect(completeEffect).toHaveBeenCalledOnce();
  });

  it("delivers audit and realtime approval observability effects", async () => {
    const append = vi.fn(async () => undefined);
    const completeEffect = vi.fn(() => ({ completed: true }));
    const publishRealtime = vi.fn();
    let effect = createEffect({
      effectKind: "approval_observability",
      targetKind: "approval",
      targetId: "audit-op",
      status: "running",
      attemptCount: 1,
      payload: createObservabilityEnvelope({
        deliveryId: "approval-observability:approval-1:audit-op",
        operationId: "audit-op",
        delivery: {
          kind: "audit",
          stream: "approvals",
          payload: { action: "approval.resolved", approvalId: "approval-1" },
        },
      }),
    });
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { get: vi.fn(() => effect), completeEffect, failEffect: vi.fn() },
          audit: { append },
        },
        publishRealtime,
      } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );
    effect = claimEffectForService(service, effect);
    const execute = service as unknown as { executeClaimedEffect(effectId: string): Promise<void> };

    await execute.executeClaimedEffect(effect.effectId);

    expect(append).toHaveBeenCalledWith(
      "approvals",
      {
        action: "approval.resolved",
        approvalId: "approval-1",
      },
      {
        deliveryId: "approval-observability:approval-1:audit-op",
        occurredAt: "2026-07-10T10:00:00.000Z",
        attribution: { actorId: "operator-1", traceId: "trace-1" },
      },
    );
    expect(completeEffect).toHaveBeenCalledWith(
      effect.effectId,
      expect.any(String),
      effect.version,
      expect.objectContaining({
        result: {
          delivered: true,
          deliveryState: "delivered",
          deliveryKind: "audit",
          deliveryId: "approval-observability:approval-1:audit-op",
          operationId: "audit-op",
          occurredAt: "2026-07-10T10:00:00.000Z",
        },
      }),
    );

    effect = claimEffectForService(
      service,
      createEffect({
        effectId: "effect-realtime",
        effectKind: "approval_observability",
        targetKind: "approval",
        targetId: "realtime-op",
        status: "running",
        attemptCount: 1,
        payload: createObservabilityEnvelope({
          deliveryId: "approval-observability:approval-1:realtime-op",
          operationId: "realtime-op",
          delivery: {
            kind: "realtime",
            eventType: "approval_resolved",
            source: "approvals",
            payload: { approvalId: "approval-1", status: "approved" },
            options: {
              eventClass: "domain_fact",
              eventAuthority: "durable_history",
              links: { approvalId: "approval-1" },
              correlationId: "approval-1",
            },
          },
        }),
      }),
    );
    await execute.executeClaimedEffect(effect.effectId);

    expect(publishRealtime).toHaveBeenCalledWith(
      "approval_resolved",
      "approvals",
      {
        approvalId: "approval-1",
        status: "approved",
        [APPROVAL_OBSERVABILITY_REALTIME_ENVELOPE_KEY]: {
          deliveryId: "approval-observability:approval-1:realtime-op",
          occurredAt: "2026-07-10T10:00:00.000Z",
          attribution: { actorId: "operator-1", traceId: "trace-1" },
        },
      },
      {
        eventClass: "domain_fact",
        eventAuthority: "durable_history",
        links: { approvalId: "approval-1" },
        correlationId: "approval-1",
      },
    );
    expect(completeEffect).toHaveBeenLastCalledWith(
      "effect-realtime",
      expect.any(String),
      effect.version,
      expect.objectContaining({
        result: {
          delivered: true,
          deliveryState: "delivered",
          deliveryKind: "realtime",
          deliveryId: "approval-observability:approval-1:realtime-op",
          operationId: "realtime-op",
          occurredAt: "2026-07-10T10:00:00.000Z",
        },
      }),
    );
  });

  it("keeps observability recoverable through a fourth attempt across worker restarts", async () => {
    const append = vi
      .fn()
      .mockRejectedValueOnce(new Error("audit file busy-1"))
      .mockRejectedValueOnce(new Error("audit file busy-2"))
      .mockRejectedValueOnce(new Error("audit file busy-3"))
      .mockResolvedValueOnce(undefined);
    const failEffect = vi.fn();
    let effect = createEffect({
      effectKind: "approval_observability",
      targetKind: "approval",
      targetId: "audit-op",
      status: "running",
      attemptCount: 0,
      payload: createObservabilityEnvelope({
        deliveryId: "approval-observability:approval-1:audit-op",
        operationId: "audit-op",
        delivery: {
          kind: "audit",
          stream: "approvals",
          payload: { action: "approval.resolved" },
        },
      }),
    });
    const deferEffectForRetry = vi.fn(
      (
        _effectId: string,
        claimedBy: string,
        _version: number,
        input: { result: Record<string, unknown>; lastError: string; retryAt: string; updatedAt: string },
      ) => {
        effect = {
          ...effect,
          claimedBy,
          updatedAt: input.updatedAt,
          leaseExpiresAt: input.retryAt,
          result: input.result,
          lastError: input.lastError,
          version: effect.version + 1,
        };
        return effect;
      },
    );
    const completeEffect = vi.fn(() => {
      effect = { ...effect, status: "completed", claimedBy: undefined, leaseExpiresAt: undefined };
      return effect;
    });
    const storage = {
      approvalEffects: {
        get: vi.fn(() => effect),
        deferEffectForRetry,
        completeEffect,
        failEffect,
      },
      audit: { append },
    };

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const restartedWorker = new ApprovalEffectsService(
        { storage, publishRealtime: vi.fn() } as unknown as ServiceContext,
        createApprovalEffectDeps(),
      );
      effect = claimEffectForService(restartedWorker, {
        ...effect,
        status: "running",
        attemptCount: attempt,
        version: effect.version + 1,
      });
      await (
        restartedWorker as unknown as { executeClaimedEffect(effectId: string): Promise<void> }
      ).executeClaimedEffect(effect.effectId);
    }

    expect(append).toHaveBeenCalledTimes(4);
    expect(deferEffectForRetry).toHaveBeenCalledTimes(3);
    expect(completeEffect).toHaveBeenCalledOnce();
    expect(failEffect).not.toHaveBeenCalled();
    expect(effect.status).toBe("completed");
  });

  it("retries an idempotent delivery when completion acknowledgement is lost", async () => {
    const failEffect = vi.fn();
    const append = vi.fn(async () => undefined);
    let effect = createEffect({
      effectKind: "approval_observability",
      targetKind: "approval",
      targetId: "audit-op",
      status: "running",
      attemptCount: 1,
      payload: createObservabilityEnvelope({
        deliveryId: "approval-observability:approval-1:audit-completion-op",
        operationId: "audit-completion-op",
        delivery: {
          kind: "audit",
          stream: "approvals",
          payload: { action: "approval.resolved" },
        },
      }),
    });
    const completeEffect = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => {
        effect = { ...effect, status: "completed" };
        return effect;
      });
    const deferEffectForRetry = vi.fn(() => effect);
    const storage = {
      approvalEffects: { get: vi.fn(() => effect), completeEffect, deferEffectForRetry, failEffect },
      audit: { append },
    };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const worker = new ApprovalEffectsService(
        { storage, publishRealtime: vi.fn() } as unknown as ServiceContext,
        createApprovalEffectDeps(),
      );
      effect = claimEffectForService(worker, { ...effect, status: "running", attemptCount: attempt });
      await (worker as unknown as { executeClaimedEffect(effectId: string): Promise<void> }).executeClaimedEffect(
        effect.effectId,
      );
    }

    expect(append).toHaveBeenCalledTimes(2);
    expect(deferEffectForRetry).toHaveBeenCalledOnce();
    expect(completeEffect).toHaveBeenCalledTimes(2);
    expect(failEffect).not.toHaveBeenCalled();
  });

  it("drains observability while an action-lane effect is still hung", async () => {
    const action = createEffect({
      effectId: "effect-action-hung",
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "approval-1",
      status: "pending",
    });
    const observability = createEffect({
      effectId: "effect-observability-independent",
      effectKind: "approval_observability",
      targetKind: "approval",
      targetId: "approval.resolve.audit",
      idempotencyKey: "approval-observability:approval-1:approval.resolve.audit",
      status: "pending",
      payload: createObservabilityEnvelope({
        deliveryId: "approval-observability:approval-1:approval.resolve.audit",
        operationId: "approval.resolve.audit",
        delivery: { kind: "audit", stream: "approvals", payload: { event: "approval.resolve" } },
      }),
    });
    const effects = new Map([
      [action.effectId, action],
      [observability.effectId, observability],
    ]);
    let actionClaimed = false;
    let observabilityClaimed = false;
    const append = vi.fn(async () => undefined);
    const completeEffect = vi.fn((effectId: string) => {
      const current = effects.get(effectId)!;
      const next = { ...current, status: "completed" as const };
      effects.set(effectId, next);
      return next;
    });
    const backgroundTasks = new Set<Promise<void>>();
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            claimNextPendingEffect: vi.fn((workerId: string) => {
              if (actionClaimed) {
                return undefined;
              }
              actionClaimed = true;
              const claimed = { ...action, status: "running" as const, claimedBy: workerId, attemptCount: 1 };
              effects.set(action.effectId, claimed);
              return claimed;
            }),
            claimNextPendingObservabilityEffect: vi.fn((workerId: string) => {
              if (observabilityClaimed) {
                return undefined;
              }
              observabilityClaimed = true;
              const claimed = {
                ...observability,
                status: "running" as const,
                claimedBy: workerId,
                attemptCount: 1,
              };
              effects.set(observability.effectId, claimed);
              return claimed;
            }),
            get: vi.fn((effectId: string) => effects.get(effectId)!),
            getByIdempotencyKey: vi.fn(() => undefined),
            completeEffect,
            failEffect: vi.fn(),
            renewEffectLease: vi.fn((effectId: string) => effects.get(effectId)),
            listByApproval: vi.fn(() => [...effects.values()]),
          },
          audit: { append },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      { ...createApprovalEffectDeps(), backgroundTasks },
    );
    let releaseAction!: () => void;
    const actionGate = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    const internal = service as unknown as {
      executeClaimedEffect(effectId: string, signal?: AbortSignal): Promise<void>;
    };
    const executeClaimedEffect = internal.executeClaimedEffect.bind(service);
    internal.executeClaimedEffect = vi.fn((effectId, signal) =>
      effectId === action.effectId ? actionGate : executeClaimedEffect(effectId, signal),
    );

    service.startWorker();
    await vi.waitFor(() => expect(append).toHaveBeenCalledOnce());

    expect(effects.get(action.effectId)?.status).toBe("running");
    expect(completeEffect).toHaveBeenCalledWith(
      observability.effectId,
      expect.any(String),
      expect.any(Number),
      expect.any(Object),
    );
    releaseAction();
    await Promise.all([...backgroundTasks]);
    service.stopWorker();
  });

  it("enqueues the canonical approval effect set without starting the worker before commit", async () => {
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
    const requestEffectProcessing = vi.spyOn(service, "requestEffectProcessing");

    await service.enqueueResolutionEffects(
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
      { deferProcessing: true },
    );

    expect(upsert.mock.calls.map(([input]) => input.effectKind)).toEqual([
      "approval_resolution_signals",
      "pending_action_execute",
      "approval_wait_wake",
      "proactive_run_wake",
      "linked_chat_turn_wake",
      "approval_inbox_follow_up",
      "approval_after_hooks",
    ]);
    expect(requestEffectProcessing).not.toHaveBeenCalled();
  });

  it("enqueues an expired inbox follow-up for every remote token bound to the approval", async () => {
    const upsert = vi.fn((input: Record<string, unknown>) =>
      createEffect({
        effectId: String(input.targetId),
        approvalId: String(input.approvalId),
        effectKind: input.effectKind as ApprovalEffectRecord["effectKind"],
        targetKind: input.targetKind as ApprovalEffectRecord["targetKind"],
        targetId: String(input.targetId),
        payload: (input.payload as Record<string, unknown>) ?? {},
      }),
    );
    const listByApprovalId = vi.fn(() => [
      {
        tokenId: "token-consumed",
        actionType: "approval.resolve" as const,
        approvalId: "approval-1",
        connectorId: "connector-1",
        mutation: {},
        createdAt: "2026-04-11T00:00:00.000Z",
        expiresAt: "2026-04-11T00:10:00.000Z",
        state: "consumed" as const,
        consumedAt: "2026-04-11T00:01:00.000Z",
        consumedBy: "connector:connector-1",
      },
      {
        tokenId: "token-expired",
        actionType: "approval.resolve" as const,
        approvalId: "approval-1",
        connectorId: "connector-2",
        mutation: {},
        createdAt: "2026-04-11T00:00:01.000Z",
        expiresAt: "2026-04-11T00:10:00.000Z",
        state: "expired" as const,
      },
    ]);
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { upsert },
          approvalWaitRuns: { getRunId: vi.fn(() => undefined) },
          pendingApprovalActions: { find: vi.fn(() => undefined) },
          remoteActionTokens: { listByApprovalId },
          approvalInbox: {
            findByApprovalAndToken: vi.fn((approvalId: string, tokenId: string) => ({
              approvalId,
              tokenId,
              inboxItemId: `inbox-${tokenId}`,
            })),
          },
          chatInlineApprovals: { get: vi.fn(() => undefined) },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );

    await service.enqueueResolutionEffects(
      {
        approvalId: "approval-1",
        kind: "shell.exec",
        riskLevel: "danger",
        status: "rejected",
        payload: {},
        preview: {},
        createdAt: "2026-04-11T00:00:00.000Z",
        expiresAt: "2026-04-11T00:01:00.000Z",
        resolvedAt: "2026-04-11T00:02:00.000Z",
        resolvedBy: "system:approval-expiry",
        explanationStatus: "not_requested",
      },
      {
        decision: "reject",
        resolvedBy: "system:approval-expiry",
      },
      { allowExpired: true },
    );

    const followUps = upsert.mock.calls
      .map(([input]) => input)
      .filter((input) => input.effectKind === "approval_inbox_follow_up");
    expect(listByApprovalId).toHaveBeenCalledWith("approval-1");
    expect(followUps).toEqual([
      expect.objectContaining({
        targetId: "token-consumed",
        payload: expect.objectContaining({
          connectorId: "connector-1",
          inboxItemId: "inbox-token-consumed",
          inboxState: "expired",
        }),
      }),
      expect.objectContaining({
        targetId: "token-expired",
        payload: expect.objectContaining({
          connectorId: "connector-2",
          inboxItemId: "inbox-token-expired",
          inboxState: "expired",
        }),
      }),
    ]);
  });

  it("retries post-commit approval resolution signals without duplicating idempotent signal state", async () => {
    const appliedApprovals = new Set<string>();
    let firstAttempt = true;
    const recordApprovalResolutionSignals = vi.fn((approval: ApprovalRequest) => {
      appliedApprovals.add(approval.approvalId);
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error("signal projection unavailable");
      }
    });
    let effect = createEffect({
      effectKind: "approval_resolution_signals",
      targetKind: "approval",
      targetId: "approval-1",
      status: "running",
      attemptCount: 1,
    });
    const deferEffectForRetry = vi.fn(() => effect);
    const completeEffect = vi.fn(() => ({ ...effect, status: "completed" }));
    const storage = {
      approvals: {
        get: vi.fn(() => ({
          approvalId: "approval-1",
          kind: "capability.activate",
          riskLevel: "danger",
          status: "approved",
          payload: {},
          preview: {},
          createdAt: "2026-07-10T10:00:00.000Z",
          explanationStatus: "not_requested",
        })) as () => ApprovalRequest,
      },
      approvalEffects: {
        get: vi.fn(() => effect),
        deferEffectForRetry,
        completeEffect,
      },
    };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const service = new ApprovalEffectsService({ storage, publishRealtime: vi.fn() } as unknown as ServiceContext, {
        ...createApprovalEffectDeps(),
        recordApprovalResolutionSignals,
      });
      effect = claimEffectForService(service, { ...effect, attemptCount: attempt, status: "running" });
      await (service as unknown as { executeClaimedEffect(effectId: string): Promise<void> }).executeClaimedEffect(
        effect.effectId,
      );
    }

    expect(recordApprovalResolutionSignals).toHaveBeenCalledTimes(2);
    expect(appliedApprovals).toEqual(new Set(["approval-1"]));
    expect(deferEffectForRetry).toHaveBeenCalledOnce();
    expect(completeEffect).toHaveBeenCalledOnce();
  });

  it("retries reserved wait-run materialization until the durable run exists", async () => {
    let effect = createEffect({
      effectKind: "approval_wait_materialize" as never,
      targetKind: "durable_run",
      targetId: "reserved-run-1",
      status: "running",
      attemptCount: 1,
    });
    let firstAttempt = true;
    const materializeApprovalWaitRun = vi.fn(() => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error("durable run store unavailable");
      }
      return { runId: "reserved-run-1", status: "waiting" } as never;
    });
    const deferEffectForRetry = vi.fn(() => effect);
    const completeEffect = vi.fn(() => ({ ...effect, status: "completed" }));
    const storage = {
      approvalEffects: {
        get: vi.fn(() => effect),
        deferEffectForRetry,
        completeEffect,
        failEffect: vi.fn(),
      },
    };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const service = new ApprovalEffectsService(
        { storage, publishRealtime: vi.fn() } as unknown as ServiceContext,
        {
          ...createApprovalEffectDeps(),
          materializeApprovalWaitRun,
        } as never,
      );
      effect = claimEffectForService(service, { ...effect, attemptCount: attempt, status: "running" });
      await (service as unknown as { executeClaimedEffect(effectId: string): Promise<void> }).executeClaimedEffect(
        effect.effectId,
      );
    }

    expect(materializeApprovalWaitRun).toHaveBeenCalledTimes(2);
    expect(deferEffectForRetry).toHaveBeenCalledOnce();
    expect(completeEffect).toHaveBeenCalledOnce();
  });

  it("defers an approval wait wake while its reserved durable run is not materialized", async () => {
    const effect = createEffect({
      effectKind: "approval_wait_wake",
      targetKind: "durable_run",
      targetId: "reserved-run-1",
      status: "running",
      attemptCount: 1,
    });
    const wakeDurableRun = vi.fn();
    const deferEffectForRetry = vi.fn(() => effect);
    const storage = {
      durableRuns: {
        getRun: vi.fn(() => {
          throw new Error("Durable run reserved-run-1 not found");
        }),
      },
      approvalEffects: {
        get: vi.fn(() => effect),
        deferEffectForRetry,
      },
    };
    const service = new ApprovalEffectsService({ storage, publishRealtime: vi.fn() } as unknown as ServiceContext, {
      ...createApprovalEffectDeps(),
      wakeDurableRun,
    });
    const claimed = claimEffectForService(service, effect);
    storage.approvalEffects.get = vi.fn(() => claimed);

    await (service as unknown as { executeClaimedEffect(effectId: string): Promise<void> }).executeClaimedEffect(
      effect.effectId,
    );

    expect(wakeDurableRun).not.toHaveBeenCalled();
    expect(deferEffectForRetry).toHaveBeenCalledOnce();
  });

  it("does not wake a linked turn when the turn trace belongs to another session", async () => {
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

    await service.enqueueResolutionEffects(
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
      "approval_resolution_signals",
      "pending_action_execute",
      "approval_after_hooks",
    ]);
  });

  it("enqueues Code Mode recovery effects when the pending action row is missing", async () => {
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

    await service.enqueueResolutionEffects(
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

  it("wakes the child delegated turn and parent orchestration when a child subagent approval resolves", async () => {
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

    await service.enqueueResolutionEffects(
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
    const completeEffect = vi.fn(() => ({ ...effect, status: "completed" as const }));
    const failEffect = vi.fn(() => ({ ...effect, status: "failed" as const }));
    const skipEffect = vi.fn(() => ({ ...effect, status: "skipped" as const }));
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
    const completeEffect = vi.fn(() => ({ ...effect, status: "completed" as const }));
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

  it("does not enqueue orchestration parent wakes across approval workspace boundaries", async () => {
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

    await service.enqueueResolutionEffects(
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

  it("skips enqueueing all effects for expired approvals", async () => {
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

    const result = await service.enqueueResolutionEffects(
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

  it("enqueues Code Mode execution when approval resolved before expiry even if effects run later", async () => {
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

      const result = await service.enqueueResolutionEffects(
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
    const failEffect = vi.fn(() => ({ status: "failed" as const }));
    const skipEffect = vi.fn(() => ({ status: "skipped" as const }));
    const completeEffect = vi.fn(() => ({ status: "completed" as const }));
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
    const completeEffect = vi.fn(() => ({ status: "completed" as const }));
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
    const completeEffect = vi.fn(() => ({ status: "completed" as const }));
    const skipEffect = vi.fn(() => ({ status: "skipped" as const }));
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
    const skipEffect = vi.fn(() => ({ status: "skipped" as const }));
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            failEffect: vi.fn(() => ({ status: "failed" as const })),
            skipEffect,
            completeEffect: vi.fn(() => ({ status: "completed" as const })),
          },
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
    const completeEffect = vi.fn(() => ({ status: "completed" as const }));
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
          chatInlineApprovals: {
            get: vi.fn(() => undefined),
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
        result: {
          outcome: "executed",
          auditEventId: "audit-1",
          result: { ok: true },
        },
      }),
    );
  });

  it("retries Chat materialization from the stored executed result without re-firing the action", async () => {
    const effect = createEffect({
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "approval-1",
    });
    const completeEffect = vi.fn(() => ({ status: "completed" as const }));
    const deferEffectForRetry = vi.fn(() => ({ ...effect, status: "pending" as const }));
    const executeApprovedPendingAction = vi.fn();
    const pendingAction = {
      approvalId: "approval-1",
      actionType: "tool.invoke",
      request: { toolName: "shell.exec", args: { command: "pwd" } },
      createdAt: "2026-04-11T00:00:00.000Z",
      resolutionStatus: "executed",
      result: {
        outcome: "executed",
        auditEventId: "audit-1",
        result: { ok: true },
      },
    } as const;
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            failEffect: vi.fn(),
            skipEffect: vi.fn(),
            completeEffect,
            deferEffectForRetry,
          },
          pendingApprovalActions: { find: vi.fn(() => pendingAction) },
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
    const materialize = vi
      .spyOn(
        service as unknown as {
          materializeExecutedChatApproval(
            currentEffect: ApprovalEffectRecord,
            currentAction: typeof pendingAction,
            result: Record<string, unknown> | undefined,
          ): Promise<void>;
        },
        "materializeExecutedChatApproval",
      )
      .mockImplementationOnce(async () => {
        throw new Error("chat projection unavailable");
      });

    await (
      service as unknown as {
        handlePendingActionExecute(currentEffect: ApprovalEffectRecord): Promise<void>;
      }
    ).handlePendingActionExecute(effect);

    expect(executeApprovedPendingAction).not.toHaveBeenCalled();
    expect(materialize).toHaveBeenCalledWith(effect, pendingAction, pendingAction.result);
    expect(deferEffectForRetry).toHaveBeenCalledWith(
      effect.effectId,
      expect.any(String),
      effect.version,
      expect.objectContaining({ lastError: "chat projection unavailable" }),
    );
    expect(completeEffect).not.toHaveBeenCalled();

    materialize.mockImplementation(async () => {
      completeEffect(effect.effectId, "worker", effect.version, { result: pendingAction.result });
    });
    await (
      service as unknown as {
        handlePendingActionExecute(currentEffect: ApprovalEffectRecord): Promise<void>;
      }
    ).handlePendingActionExecute(effect);

    expect(executeApprovedPendingAction).not.toHaveBeenCalled();
    expect(completeEffect).toHaveBeenCalledWith(
      effect.effectId,
      expect.any(String),
      effect.version,
      expect.objectContaining({ result: pendingAction.result }),
    );
  });

  it("defers Chat approval materialization when the linked durable run cannot be read", async () => {
    const effect = createEffect({
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "approval-1",
      status: "running",
      attemptCount: 1,
    });
    const pendingAction: PendingApprovalAction = {
      approvalId: "approval-1",
      actionType: "tool.invoke",
      request: { toolName: "shell.exec", args: { command: "pwd" } },
      createdAt: "2026-04-11T00:00:00.000Z",
      resolutionStatus: "executed",
    };
    const trace: ChatTurnTraceRecord = {
      turnId: "turn-durable-read-failure",
      sessionId: "session-1",
      userMessageId: "user-1",
      branchKind: "append",
      status: "waiting_for_approval",
      mode: "chat",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      startedAt: "2026-04-11T00:00:00.000Z",
      toolRuns: [],
      citations: [],
      routing: {},
      durable: { runId: "durable-read-failure", status: "waiting", checkpointKind: "run_waiting" },
    };
    const deferEffectForRetry = vi.fn(() => ({ ...effect, status: "pending" as const }));
    const chatMessagesUpsert = vi.fn();
    const chatTurnTracesPatch = vi.fn();
    const publishRealtime = vi.fn();
    const getRun = vi.fn(() => {
      throw new Error("durable run store unavailable");
    });
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { deferEffectForRetry, get: vi.fn() },
          chatInlineApprovals: {
            get: vi.fn(() => ({
              approvalId: "approval-1",
              sessionId: "session-1",
              turnId: trace.turnId,
              toolName: "shell.exec",
              status: "pending",
              reason: "Needs approval",
              createdAt: "2026-04-11T00:00:00.000Z",
            })),
            upsert: vi.fn(),
          },
          chatToolRuns: { listByTurn: vi.fn(() => []) },
          chatMessages: { upsert: chatMessagesUpsert },
          chatTurnTraces: { get: vi.fn(() => trace), patch: chatTurnTracesPatch },
          durableRuns: { getRun },
          runImmediateTransaction: <T>(work: () => T): T => work(),
        },
        publishRealtime,
      } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );

    const materialized = await (
      service as unknown as {
        materializeExecutedChatApprovalOrDefer(
          currentEffect: ApprovalEffectRecord,
          currentAction: PendingApprovalAction,
          result: Record<string, unknown> | undefined,
        ): Promise<boolean>;
      }
    ).materializeExecutedChatApprovalOrDefer(effect, pendingAction, {
      outcome: "executed",
      result: { ok: true },
    });

    expect(materialized).toBe(false);
    expect(getRun).toHaveBeenCalledWith("durable-read-failure");
    expect(chatMessagesUpsert).not.toHaveBeenCalled();
    expect(chatTurnTracesPatch).not.toHaveBeenCalled();
    expect(deferEffectForRetry).toHaveBeenCalledWith(
      effect.effectId,
      expect.any(String),
      effect.version,
      expect.objectContaining({
        lastError: "durable run store unavailable",
        result: expect.objectContaining({ materialized: false }),
      }),
    );
    expect(publishRealtime).not.toHaveBeenCalledWith(
      "chat_thread_updated",
      "chat",
      expect.anything(),
      expect.anything(),
    );
  });

  it("defers Chat approval materialization when the trace cannot be reloaded inside the transaction", async () => {
    const effect = createEffect({
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "approval-1",
      status: "running",
      attemptCount: 1,
    });
    const pendingAction: PendingApprovalAction = {
      approvalId: "approval-1",
      actionType: "tool.invoke",
      request: { toolName: "shell.exec", args: { command: "pwd" } },
      createdAt: "2026-04-11T00:00:00.000Z",
      resolutionStatus: "executed",
    };
    const trace: ChatTurnTraceRecord = {
      turnId: "turn-trace-reread-failure",
      sessionId: "session-1",
      userMessageId: "user-1",
      branchKind: "append",
      status: "waiting_for_approval",
      mode: "chat",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      startedAt: "2026-04-11T00:00:00.000Z",
      toolRuns: [],
      citations: [],
      routing: {},
    };
    const deferEffectForRetry = vi.fn(() => ({ ...effect, status: "pending" as const }));
    const chatMessagesUpsert = vi.fn();
    const chatTurnTracesPatch = vi.fn();
    const getTrace = vi
      .fn()
      .mockReturnValueOnce(trace)
      .mockImplementation(() => {
        throw new Error("trace store unavailable during transaction");
      });
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { deferEffectForRetry, get: vi.fn() },
          chatInlineApprovals: {
            get: vi.fn(() => ({
              approvalId: "approval-1",
              sessionId: "session-1",
              turnId: trace.turnId,
              toolName: "shell.exec",
              status: "pending",
              reason: "Needs approval",
              createdAt: "2026-04-11T00:00:00.000Z",
            })),
            upsert: vi.fn(),
          },
          chatToolRuns: { listByTurn: vi.fn(() => []) },
          chatMessages: { upsert: chatMessagesUpsert },
          chatTurnTraces: { get: getTrace, patch: chatTurnTracesPatch },
          runImmediateTransaction: <T>(work: () => T): T => work(),
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );

    const materialized = await (
      service as unknown as {
        materializeExecutedChatApprovalOrDefer(
          currentEffect: ApprovalEffectRecord,
          currentAction: PendingApprovalAction,
          result: Record<string, unknown> | undefined,
        ): Promise<boolean>;
      }
    ).materializeExecutedChatApprovalOrDefer(effect, pendingAction, {
      outcome: "executed",
      result: { ok: true },
    });

    expect(materialized).toBe(false);
    expect(getTrace).toHaveBeenCalledTimes(2);
    expect(chatMessagesUpsert).not.toHaveBeenCalled();
    expect(chatTurnTracesPatch).not.toHaveBeenCalled();
    expect(deferEffectForRetry).toHaveBeenCalledWith(
      effect.effectId,
      expect.any(String),
      effect.version,
      expect.objectContaining({
        lastError: "trace store unavailable during transaction",
        result: expect.objectContaining({ materialized: false }),
      }),
    );
  });

  it("keeps legacy v1 Chat runs out of the durable approval-resume path", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    const now = "2026-08-06T00:00:00.000Z";
    const runId = "durable-legacy-v1-approval";
    const turnId = "turn-legacy-v1-approval";
    const sessionId = "session-legacy-v1-approval";
    const userMessageId = "user-legacy-v1-approval";
    try {
      const run = createExactWaitingApprovalRun(storage, { runId, sessionId, turnId, userMessageId, now });
      storage.durableRuns.updateRun({
        runId,
        status: "waiting",
        payload: { ...run.payload, version: "chat.turn.execute.v1" },
        expectedVersion: run.version,
      });
      const approvalId = storage.approvals.create({
        kind: "tool.invoke",
        riskLevel: "caution",
        payload: {},
        preview: {},
      }).approvalId;
      const actionEffect = storage.approvalEffects.upsert({
        approvalId,
        effectKind: "pending_action_execute",
        targetKind: "pending_action",
        targetId: approvalId,
        payload: { actionType: "tool.invoke", decision: "approve" },
      });
      storage.approvalEffects.upsert({
        approvalId,
        effectKind: "linked_chat_turn_wake",
        targetKind: "chat_turn",
        targetId: turnId,
        payload: { decision: "approve", runId, turnId },
      });
      const trace = {
        ...createWaitingChildTrace(sessionId, turnId),
        userMessageId,
        assistantMessageId: `assistant-approved-${turnId}`,
        durable: { runId, status: "waiting" as const, checkpointKind: "run_waiting" },
      };
      const service = new ApprovalEffectsService(
        { storage: createSqliteAsyncStorage(storage), publishRealtime: vi.fn() } as unknown as ServiceContext,
        createApprovalEffectDeps(),
      );

      await expect(
        (
          service as unknown as {
            shouldResumeApprovedActionThroughLinkedChatTurn(
              effect: ApprovalEffectRecord,
              currentTrace: ChatTurnTraceRecord,
            ): Promise<boolean>;
          }
        ).shouldResumeApprovedActionThroughLinkedChatTurn(actionEffect, trace),
      ).resolves.toBe(false);
    } finally {
      storage.close();
    }
  });

  it("settles an approved search result without terminalizing the waiting durable Chat turn", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    const now = "2026-08-06T00:00:00.000Z";
    const runId = "durable-approved-search-resume";
    const turnId = "turn-approved-search-resume";
    const sessionId = "session-approved-search-resume";
    const approvalId = storage.approvals.create({
      kind: "tool.invoke",
      riskLevel: "caution",
      payload: {},
      preview: {},
    }).approvalId;
    createExactWaitingApprovalRun(storage, {
      runId,
      sessionId,
      turnId,
      userMessageId: "user-approved-search-resume",
      now,
    });
    storage.chatTurnTraces.create({
      turnId,
      sessionId,
      userMessageId: "user-approved-search-resume",
      assistantMessageId: `assistant-approved-${turnId}`,
      status: "waiting_for_approval",
      mode: "chat",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      durable: { runId, status: "waiting", checkpointKind: "run_waiting" },
      startedAt: now,
    });
    storage.chatInlineApprovals.upsert({
      approvalId,
      sessionId,
      turnId,
      toolName: "browser.search",
      status: "pending",
      reason: "Official-provider search requires approval.",
      createdAt: now,
    });
    storage.chatToolRuns.create({
      toolRunId: "tool-approved-search-resume",
      turnId,
      sessionId,
      toolName: "browser.search",
      status: "approval_required",
      approvalId,
      args: { query: "LaughLab funniest joke research", maxResults: 6 },
      startedAt: now,
    });
    const effect = storage.approvalEffects.upsert({
      approvalId,
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: approvalId,
      payload: { actionType: "tool.invoke", decision: "approve" },
    });
    storage.approvalEffects.upsert({
      approvalId,
      effectKind: "linked_chat_turn_wake",
      targetKind: "chat_turn",
      targetId: turnId,
      payload: { decision: "approve", runId, turnId },
    });
    const requestRunProcessing = vi.fn();
    const wakeDurableRun = vi.fn((wakeRunId: string, event: { eventKey: string; correlationId?: string }) => {
      const current = storage.durableRuns.getRun(wakeRunId);
      const metadata = { ...(current.metadata ?? {}), waitForEvent: null };
      const queued = storage.durableRuns.updateRun({
        runId: wakeRunId,
        status: "queued",
        metadata,
        expectedVersion: current.version,
      });
      return {
        runId: wakeRunId,
        eventKey: event.eventKey,
        correlationId: event.correlationId,
        outcome: "woke" as const,
        run: queued,
      };
    });
    const service = new ApprovalEffectsService(
      { storage: createSqliteAsyncStorage(storage), publishRealtime: vi.fn() } as unknown as ServiceContext,
      {
        ...createApprovalEffectDeps(),
        wakeDurableRun,
        requestRunProcessing,
      },
    );
    const claimNow = new Date();
    const claimedEffect = storage.approvalEffects.claimNextPendingEffect(
      (service as unknown as { workerId: string }).workerId,
      claimNow.toISOString(),
      new Date(claimNow.getTime() + 60_000).toISOString(),
    );
    expect(claimedEffect?.effectId).toBe(effect.effectId);
    const actionRecord = {
      outcome: "executed",
      auditEventId: "audit-approved-search-resume",
      result: {
        results: [
          {
            title: "LaughLab and the science of jokes",
            url: "https://example.test/laughlab",
          },
        ],
      },
    };

    try {
      await (
        service as unknown as {
          materializeExecutedChatApproval(
            currentEffect: ApprovalEffectRecord,
            currentAction: PendingApprovalAction,
            result: Record<string, unknown>,
          ): Promise<void>;
        }
      ).materializeExecutedChatApproval(
        claimedEffect!,
        {
          approvalId,
          actionType: "tool.invoke",
          request: {
            toolName: "browser.search",
            args: { query: "LaughLab funniest joke research", maxResults: 6 },
          },
          createdAt: now,
          resolutionStatus: "executed",
          result: actionRecord,
        },
        actionRecord,
      );

      expect(storage.chatToolRuns.listByTurn(turnId)[0]).toMatchObject({
        status: "executed",
        approvalId,
        result: actionRecord.result,
      });
      expect(storage.chatInlineApprovals.get(approvalId)).toMatchObject({ status: "approved" });
      expect(storage.approvalEffects.get(effect.effectId).status).toBe("completed");
      expect(storage.durableRuns.getRun(runId).status).toBe("waiting");
      expect(storage.durableRuns.listCheckpoints(runId)).toEqual([
        expect.objectContaining({ checkpointKind: "run_waiting" }),
      ]);
      expect(storage.chatTurnTraces.get(turnId)).toMatchObject({
        status: "waiting_for_approval",
        durable: { runId, status: "waiting", checkpointKind: "run_waiting" },
      });
      expect(storage.chatTurnTraces.get(turnId).finishedAt).toBeUndefined();
      expect(storage.chatMessages.get(`assistant-approved-${turnId}`)).toBeUndefined();

      const linkedWake = storage.approvalEffects.claimNextPendingEffect(
        (service as unknown as { workerId: string }).workerId,
        claimNow.toISOString(),
        new Date(claimNow.getTime() + 60_000).toISOString(),
      );
      expect(linkedWake).toMatchObject({ effectKind: "linked_chat_turn_wake", targetId: turnId });
      await (
        service as unknown as {
          handleLinkedChatTurnWake(currentEffect: ApprovalEffectRecord): Promise<void>;
        }
      ).handleLinkedChatTurnWake(linkedWake!);

      expect(storage.durableRuns.getRun(runId).status).toBe("queued");
      expect(storage.chatTurnTraces.get(turnId).status).toBe("running");
      expect(requestRunProcessing).toHaveBeenCalledWith(runId);
      expect(storage.approvalEffects.get(linkedWake!.effectId)).toMatchObject({
        status: "completed",
        result: expect.objectContaining({ outcome: "woke" }),
      });
    } finally {
      storage.close();
    }
  });

  it("rolls back durable completion and assistant materialization when the child trace patch fails", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    const now = "2026-04-11T00:00:00.000Z";
    const runId = "durable-child-atomic";
    const turnId = "child-turn-atomic";
    createExactWaitingApprovalRun(storage, {
      runId,
      sessionId: "child-session-atomic",
      turnId,
      userMessageId: "child-user-atomic",
      now,
    });
    const trace = storage.chatTurnTraces.create({
      turnId,
      sessionId: "child-session-atomic",
      userMessageId: "child-user-atomic",
      assistantMessageId: `assistant-approved-${turnId}`,
      status: "waiting_for_approval",
      mode: "chat",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      durable: { runId, status: "waiting", checkpointKind: "run_waiting" },
      startedAt: now,
    });
    const publishRealtime = vi.fn();
    const service = new ApprovalEffectsService(
      { storage: createSqliteAsyncStorage(storage), publishRealtime } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );
    const tracePatch = vi.spyOn(storage.chatTurnTraces, "patch").mockImplementationOnce(() => {
      throw new Error("child trace patch unavailable");
    });

    try {
      await expect(
        (
          service as unknown as {
            completeChatTurnFromApprovedAction(input: {
              trace: ChatTurnTraceRecord;
              outputText: string;
              now: string;
              approvalId: string;
              actionRecord?: Record<string, unknown>;
            }): Promise<boolean>;
          }
        ).completeChatTurnFromApprovedAction({
          trace,
          outputText: "approved child output",
          now,
          approvalId: "approval-1",
        }),
      ).rejects.toThrow("child trace patch unavailable");

      expect(storage.durableRuns.getRun(runId).status).toBe("waiting");
      expect(storage.durableRuns.listCheckpoints(runId)).toEqual([
        expect.objectContaining({ checkpointKind: "run_waiting" }),
      ]);
      expect(storage.chatMessages.get(`assistant-approved-${turnId}`)).toBeUndefined();
      expect(storage.chatTurnTraces.get(turnId)).toMatchObject({
        status: "waiting_for_approval",
        assistantMessageId: `assistant-approved-${turnId}`,
        durable: { runId, status: "waiting", checkpointKind: "run_waiting" },
      });
      expect(publishRealtime).not.toHaveBeenCalled();
    } finally {
      tracePatch.mockRestore();
      storage.close();
    }
  });

  it("materializes manual-reconciliation approval truth as failed Chat and durable state", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    const now = "2026-04-11T00:00:00.000Z";
    const runId = "durable-approved-unknown";
    const turnId = "turn-approved-unknown";
    const sessionId = "session-approved-unknown";
    const approvalId = storage.approvals.create({
      kind: "tool.invoke",
      riskLevel: "danger",
      payload: {},
      preview: {},
    }).approvalId;
    const parentRunId = "durable-parent-approved-unknown";
    const parentTurnId = "turn-parent-approved-unknown";
    const parentSessionId = "session-parent-approved-unknown";
    const delegationRunId = "delegation-approved-unknown";
    createExactWaitingApprovalRun(storage, {
      runId,
      sessionId,
      turnId,
      userMessageId: "user-approved-unknown",
      now,
    });
    const trace = storage.chatTurnTraces.create({
      turnId,
      sessionId,
      userMessageId: "user-approved-unknown",
      assistantMessageId: `assistant-approved-${turnId}`,
      status: "waiting_for_approval",
      mode: "chat",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      durable: { runId, status: "waiting", checkpointKind: "run_waiting" },
      startedAt: now,
    });
    createExactWaitingApprovalRun(storage, {
      runId: parentRunId,
      sessionId: parentSessionId,
      turnId: parentTurnId,
      userMessageId: "user-parent-approved-unknown",
      now,
    });
    storage.chatDelegationRuns.create({
      runId: delegationRunId,
      sessionId: parentSessionId,
      taskId: `chat-orchestration:${parentTurnId}`,
      objective: "Dispatch approved HTTP action",
      roles: ["worker"],
      mode: "sequential",
      status: "running",
      startedAt: now,
    });
    storage.chatDelegationSteps.create({
      stepId: `${delegationRunId}:worker`,
      runId: delegationRunId,
      role: "worker",
      label: "Worker",
      index: 0,
      status: "running",
      childSessionId: sessionId,
      childTurnId: turnId,
      durableRunId: runId,
      startedAt: now,
    });
    storage.chatTurnTraces.create({
      turnId: parentTurnId,
      sessionId: parentSessionId,
      userMessageId: "user-parent-approved-unknown",
      assistantMessageId: `assistant-approved-${parentTurnId}`,
      status: "waiting_for_approval",
      mode: "cowork",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      durable: { runId: parentRunId, status: "waiting", checkpointKind: "run_waiting" },
      orchestration: {
        runId: delegationRunId,
        objective: "Dispatch approved HTTP action",
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
      startedAt: now,
    });
    storage.chatInlineApprovals.upsert({
      approvalId,
      sessionId,
      turnId,
      toolName: "http.post",
      status: "pending",
      reason: "Approval required by policy.",
      createdAt: now,
    });
    storage.chatToolRuns.create({
      toolRunId: "tool-approved-unknown",
      turnId,
      sessionId,
      toolName: "http.post",
      status: "approval_required",
      approvalId,
      startedAt: now,
    });
    const publishRealtime = vi.fn();
    const service = new ApprovalEffectsService(
      { storage: createSqliteAsyncStorage(storage), publishRealtime } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );
    const pendingEffect = storage.approvalEffects.upsert({
      approvalId,
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: approvalId,
    });
    const claimNow = new Date();
    const claimedEffect = storage.approvalEffects.claimNextPendingEffect(
      (service as unknown as { workerId: string }).workerId,
      claimNow.toISOString(),
      new Date(claimNow.getTime() + 60_000).toISOString(),
    );
    expect(claimedEffect?.effectId).toBe(pendingEffect.effectId);

    try {
      await (
        service as unknown as {
          materializeFailedChatApproval(
            effect: ApprovalEffectRecord,
            pendingAction: PendingApprovalAction,
            actionRecord: Record<string, unknown>,
            failure: { message: string; kind: "manual_reconciliation"; manualReconciliationRequired: true },
          ): Promise<void>;
        }
      ).materializeFailedChatApproval(
        claimedEffect!,
        {
          approvalId,
          actionType: "tool.invoke",
          request: { toolName: "http.post" },
          createdAt: now,
          resolutionStatus: "pending",
        },
        {
          outcome: "executed",
          policyReason: "execution outcome unknown",
          result: {
            status: "failed",
            externalOutcome: "unknown_after_send",
            manualReconciliationRequired: true,
            error: "The remote outcome is unknown after dispatch.",
          },
        },
        {
          message: "The remote outcome is unknown after dispatch.",
          kind: "manual_reconciliation",
          manualReconciliationRequired: true,
        },
      );

      expect(storage.chatToolRuns.listByTurn(turnId)[0]).toMatchObject({
        status: "failed",
        approvalId,
        effectPotential: "unknown",
        effectDisposition: "unknown",
        effectOutcomeKind: "uncertain",
        effectEvidence: { reason: "dispatch_may_have_occurred", refs: [] },
        failureGuidance: expect.stringContaining("Inspect external or runtime state before retry"),
        error: "The remote outcome is unknown after dispatch.",
        result: expect.objectContaining({ manualReconciliationRequired: true }),
      });
      expect(storage.chatTurnTraces.get(turnId)).toMatchObject({
        status: "failed",
        assistantMessageId: `assistant-approved-${turnId}`,
        failure: {
          failureClass: "tool_failed",
          message: "The remote outcome is unknown after dispatch.",
          retryable: false,
        },
        durable: { runId, status: "failed", checkpointKind: "run_failed" },
      });
      expect(storage.chatMessages.get(`assistant-approved-${turnId}`)?.content).toMatch(/manual reconciliation/i);
      expect(storage.chatMessages.get(`assistant-approved-${turnId}`)?.content).not.toMatch(/action completed/i);
      expect(storage.durableRuns.getRun(runId)).toMatchObject({
        status: "failed",
        lastError: "The remote outcome is unknown after dispatch.",
      });
      expect(storage.durableRuns.listCheckpoints(runId)).toEqual([
        expect.objectContaining({ checkpointKind: "run_waiting" }),
        expect.objectContaining({ checkpointKind: "run_failed" }),
      ]);
      expect(storage.chatDelegationSteps.get(`${delegationRunId}:worker`)).toMatchObject({
        status: "failed",
        error: "The remote outcome is unknown after dispatch.",
      });
      expect(storage.chatTurnTraces.get(parentTurnId)).toMatchObject({
        status: "failed",
        durable: { runId: parentRunId, status: "failed", checkpointKind: "run_failed" },
      });
      expect(storage.durableRuns.getRun(parentRunId)).toMatchObject({
        status: "failed",
        lastError: "The remote outcome is unknown after dispatch.",
      });
      expect(trace.status).toBe("waiting_for_approval");
    } finally {
      storage.close();
    }
  });

  it("does not partially rewrite tool approval state when terminal Chat completion wins", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    const now = "2026-04-11T00:00:00.000Z";
    const runId = "durable-terminal-before-failure";
    const turnId = "turn-terminal-before-failure";
    const sessionId = "session-terminal-before-failure";
    const approvalId = storage.approvals.create({
      kind: "tool.invoke",
      riskLevel: "danger",
      payload: {},
      preview: {},
    }).approvalId;
    const assistantMessageId = "assistant-terminal-before-failure";
    storage.durableRuns.createRun({
      runId,
      workflowKey: "chat.turn.execute",
      status: "completed",
      metadata: { outputText: "Canonical completion" },
      startedAt: now,
      finishedAt: now,
      now,
    });
    storage.chatMessages.upsert({
      messageId: assistantMessageId,
      sessionId,
      role: "assistant",
      sourceAuthority: "agent_proposed",
      actorType: "agent",
      actorId: "assistant",
      content: "Canonical completion",
      timestamp: now,
    });
    storage.chatTurnTraces.create({
      turnId,
      sessionId,
      userMessageId: "user-terminal-before-failure",
      assistantMessageId,
      status: "completed",
      mode: "chat",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      completion: { status: "complete", repaired: false, repair: { applied: false } },
      durable: { runId, status: "completed", checkpointKind: "run_completed" },
      startedAt: now,
      finishedAt: now,
    });
    storage.chatInlineApprovals.upsert({
      approvalId,
      sessionId,
      turnId,
      toolName: "http.post",
      status: "pending",
      reason: "Approval required by policy.",
      createdAt: now,
    });
    storage.chatToolRuns.create({
      toolRunId: "tool-terminal-before-failure",
      turnId,
      sessionId,
      toolName: "http.post",
      status: "approval_required",
      approvalId,
      startedAt: now,
    });
    const service = new ApprovalEffectsService(
      { storage: createSqliteAsyncStorage(storage), publishRealtime: vi.fn() } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );
    const pendingEffect = storage.approvalEffects.upsert({
      approvalId,
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: approvalId,
    });
    const claimNow = new Date();
    const claimedEffect = storage.approvalEffects.claimNextPendingEffect(
      (service as unknown as { workerId: string }).workerId,
      claimNow.toISOString(),
      new Date(claimNow.getTime() + 60_000).toISOString(),
    );
    expect(claimedEffect?.effectId).toBe(pendingEffect.effectId);

    try {
      await expect(
        (
          service as unknown as {
            materializeFailedChatApproval(
              effect: ApprovalEffectRecord,
              pendingAction: PendingApprovalAction,
              actionRecord: Record<string, unknown>,
              failure: { message: string; kind: "failed"; manualReconciliationRequired: false },
            ): Promise<void>;
          }
        ).materializeFailedChatApproval(
          claimedEffect!,
          {
            approvalId,
            actionType: "tool.invoke",
            request: { toolName: "http.post" },
            createdAt: now,
            resolutionStatus: "failed",
          },
          { outcome: "blocked", policyReason: "execution error: provider unavailable" },
          {
            message: "execution error: provider unavailable",
            kind: "failed",
            manualReconciliationRequired: false,
          },
        ),
      ).rejects.toThrow(/already completed/i);

      expect(storage.chatToolRuns.listByTurn(turnId)[0]).toMatchObject({
        status: "approval_required",
        error: undefined,
      });
      expect(storage.chatInlineApprovals.get(approvalId)).toMatchObject({ status: "pending" });
      expect(storage.chatTurnTraces.get(turnId)).toMatchObject({ status: "completed", assistantMessageId });
      expect(storage.chatMessages.get(assistantMessageId)?.content).toBe("Canonical completion");
      expect(storage.durableRuns.getRun(runId).status).toBe("completed");
    } finally {
      storage.close();
    }
  });

  it("rolls back durable completion and assistant materialization when the parent trace patch fails", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    const now = "2026-04-11T00:00:00.000Z";
    const runId = "durable-parent-atomic";
    const turnId = "parent-turn-atomic";
    const delegationRunId = "delegation-run-atomic";
    createExactWaitingApprovalRun(storage, {
      runId,
      sessionId: "parent-session-atomic",
      turnId,
      userMessageId: "parent-user-atomic",
      now,
    });
    storage.chatTurnTraces.create({
      turnId,
      sessionId: "parent-session-atomic",
      userMessageId: "parent-user-atomic",
      assistantMessageId: `assistant-approved-${turnId}`,
      status: "waiting_for_approval",
      mode: "cowork",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      durable: { runId, status: "waiting", checkpointKind: "run_waiting" },
      orchestration: {
        runId: delegationRunId,
        objective: "Complete delegated work",
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
      startedAt: now,
    });
    const step: ChatDelegationStepRecord = {
      stepId: `${delegationRunId}:worker`,
      runId: delegationRunId,
      role: "worker",
      label: "Worker",
      status: "completed",
      index: 0,
      providerId: "openai",
      model: "gpt-test",
      startedAt: now,
      finishedAt: now,
      output: "approved parent output",
      summary: "approved parent output",
      citations: [],
    };
    const delegationRunGet = vi.spyOn(storage.chatDelegationRuns, "getForUpdate").mockReturnValue({
      runId: delegationRunId,
      sessionId: "parent-session-atomic",
      taskId: `chat-orchestration:${turnId}`,
      objective: "Complete delegated work",
      roles: ["worker"],
      mode: "sequential",
      status: "running",
      citations: [],
      startedAt: now,
    });
    const delegationRunPatch = vi.spyOn(storage.chatDelegationRuns, "patch").mockImplementation(
      () =>
        ({
          ...delegationRunGet.getMockImplementation()?.(delegationRunId),
          status: "completed",
        }) as never,
    );
    const delegationSteps = vi.spyOn(storage.chatDelegationSteps, "listByRunForUpdate").mockReturnValue([step]);
    const tracePatch = vi.spyOn(storage.chatTurnTraces, "patch").mockImplementationOnce(() => {
      throw new Error("parent trace patch unavailable");
    });
    const publishRealtime = vi.fn();
    const service = new ApprovalEffectsService(
      { storage: createSqliteAsyncStorage(storage), publishRealtime } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );

    try {
      await expect(
        (
          service as unknown as {
            reconcileDelegationRun(
              parentSessionId: string,
              currentRunId: string,
              at: string,
              approvalId: string,
            ): Promise<void>;
          }
        ).reconcileDelegationRun("parent-session-atomic", delegationRunId, now, "approval-1"),
      ).rejects.toThrow("parent trace patch unavailable");

      expect(storage.durableRuns.getRun(runId).status).toBe("waiting");
      expect(storage.durableRuns.listCheckpoints(runId)).toEqual([
        expect.objectContaining({ checkpointKind: "run_waiting" }),
      ]);
      expect(storage.chatMessages.get(`assistant-approved-${turnId}`)).toBeUndefined();
      expect(storage.chatTurnTraces.get(turnId)).toMatchObject({
        status: "waiting_for_approval",
        assistantMessageId: `assistant-approved-${turnId}`,
        durable: { runId, status: "waiting", checkpointKind: "run_waiting" },
      });
      expect(publishRealtime).not.toHaveBeenCalled();
    } finally {
      tracePatch.mockRestore();
      delegationSteps.mockRestore();
      delegationRunPatch.mockRestore();
      delegationRunGet.mockRestore();
      storage.close();
    }
  });

  it("keeps a delegation parent resumable until every persisted dependency-plan step is terminal", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    const now = "2026-04-11T00:00:00.000Z";
    const runId = "durable-parent-fanin";
    const turnId = "parent-turn-fanin";
    const delegationRunId = "delegation-run-fanin";
    createExactWaitingApprovalRun(storage, {
      runId,
      sessionId: "parent-session-fanin",
      turnId,
      userMessageId: "parent-user-fanin",
      now,
    });
    storage.chatTurnTraces.create({
      turnId,
      sessionId: "parent-session-fanin",
      userMessageId: "parent-user-fanin",
      assistantMessageId: `assistant-approved-${turnId}`,
      status: "waiting_for_approval",
      mode: "cowork",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      durable: { runId, status: "waiting", checkpointKind: "run_waiting" },
      orchestration: {
        runId: delegationRunId,
        objective: "Complete A before B",
        workflowTemplate: "cowork.plan.work.synthesize",
        status: "running",
        modePolicy: "cowork",
        visibility: "expandable",
        finalSummary: "Waiting for A approval",
        routeDecision: {
          workflowTemplate: "cowork.plan.work.synthesize",
          visibility: "expandable",
          intensity: "balanced",
          reviewDepth: "standard",
          parallelism: "sequential",
          selectedRoles: ["architect", "qa"],
          selectedProviders: [],
          triggerReason: "test",
        },
        steps: [],
      },
      startedAt: now,
    });
    storage.chatDelegationRuns.create({
      runId: delegationRunId,
      parentRunId: runId,
      sessionId: "parent-session-fanin",
      taskId: "task-fanin",
      objective: "Complete A before B",
      roles: ["architect", "qa"],
      mode: "parallel",
      status: "running",
      citations: [],
      startedAt: now,
    });
    const architect = storage.chatDelegationSteps.create({
      stepId: "step-architect-fanin",
      runId: delegationRunId,
      role: "architect",
      index: 0,
      status: "completed",
      parallelizable: true,
      dependsOnStepIds: [],
      output: "Approved architecture handoff",
      summary: "Architecture approved",
      startedAt: now,
      finishedAt: now,
    });
    const qa = storage.chatDelegationSteps.create({
      stepId: "step-qa-fanin",
      runId: delegationRunId,
      role: "qa",
      index: 1,
      status: "pending",
      parallelizable: false,
      dependsOnStepIds: [architect.stepId],
      startedAt: now,
    });
    const publishRealtime = vi.fn();
    const service = new ApprovalEffectsService(
      { storage: createSqliteAsyncStorage(storage), publishRealtime } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );
    const reconcile = () =>
      (
        service as unknown as {
          reconcileDelegationRun(
            parentSessionId: string,
            currentRunId: string,
            at: string,
            approvalId: string,
          ): Promise<void>;
        }
      ).reconcileDelegationRun("parent-session-fanin", delegationRunId, now, "approval-fanin");

    try {
      await reconcile();

      expect(storage.chatDelegationRuns.get(delegationRunId)).toMatchObject({ status: "running" });
      expect(storage.durableRuns.getRun(runId).status).toBe("waiting");
      expect(storage.chatTurnTraces.get(turnId)).toMatchObject({
        status: "running",
        orchestration: {
          status: "running",
          steps: [
            { stepId: architect.stepId, status: "completed" },
            { stepId: qa.stepId, status: "pending" },
          ],
        },
      });
      expect(storage.chatMessages.get(`assistant-approved-${turnId}`)).toBeUndefined();

      storage.chatDelegationSteps.patch(qa.stepId, {
        status: "completed",
        output: "QA verified the approved architecture",
        summary: "QA complete",
        finishedAt: now,
      });
      await reconcile();

      expect(storage.chatDelegationRuns.get(delegationRunId)).toMatchObject({ status: "completed" });
      expect(storage.durableRuns.getRun(runId).status).toBe("completed");
      expect(storage.chatTurnTraces.get(turnId)).toMatchObject({ status: "completed" });
      expect(storage.chatMessages.get(`assistant-approved-${turnId}`)?.content).toContain(
        "QA verified the approved architecture",
      );
    } finally {
      storage.close();
    }
  });

  it("refuses to seize a receipt-less completed durable run during approval materialization", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    const now = "2026-04-11T00:00:00.000Z";
    const runId = "durable-already-completed";
    const turnId = "turn-already-completed";
    const assistantMessageId = "assistant-canonical";
    storage.durableRuns.createRun({
      runId,
      workflowKey: "chat.turn.execute",
      status: "completed",
      metadata: {
        outputText: "canonical output",
        finalOutput: "canonical output",
        outputSummary: "canonical output",
        finalSummary: "canonical output",
      },
      startedAt: now,
      finishedAt: now,
      now,
    });
    storage.chatMessages.upsert({
      messageId: assistantMessageId,
      sessionId: "session-already-completed",
      role: "assistant",
      sourceAuthority: "agent_proposed",
      actorType: "agent",
      actorId: "assistant",
      content: "canonical output",
      timestamp: now,
    });
    const trace = storage.chatTurnTraces.create({
      turnId,
      sessionId: "session-already-completed",
      userMessageId: "user-already-completed",
      assistantMessageId,
      status: "completed",
      mode: "chat",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      completion: { status: "complete", repaired: false, repair: { applied: false } },
      durable: { runId, status: "completed", checkpointKind: "run_completed" },
      startedAt: now,
      finishedAt: now,
    });
    const service = new ApprovalEffectsService(
      { storage: createSqliteAsyncStorage(storage), publishRealtime: vi.fn() } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );

    try {
      await expect(
        (
          service as unknown as {
            completeChatTurnFromApprovedAction(input: {
              trace: ChatTurnTraceRecord;
              outputText: string;
              now: string;
              approvalId: string;
              actionRecord?: Record<string, unknown>;
            }): Promise<boolean>;
          }
        ).completeChatTurnFromApprovedAction({
          trace,
          outputText: "late approval output",
          now: "2026-04-11T00:00:01.000Z",
          approvalId: "approval-late",
          actionRecord: { result: { ok: true } },
        }),
      ).rejects.toThrow(/completed without an approval materialization receipt/i);

      expect(storage.durableRuns.getRun(runId)).toMatchObject({
        status: "completed",
        metadata: {
          outputText: "canonical output",
          finalOutput: "canonical output",
          outputSummary: "canonical output",
          finalSummary: "canonical output",
        },
      });
      expect(storage.durableRuns.getRun(runId).metadata).not.toHaveProperty("approvalMaterializedPostCommit");
      expect(storage.chatMessages.get(assistantMessageId)?.content).toBe("canonical output");
      expect(storage.chatTurnTraces.get(turnId)).toMatchObject({
        status: "completed",
        assistantMessageId,
        durable: { runId, status: "completed", checkpointKind: "run_completed" },
      });
    } finally {
      storage.close();
    }
  });

  it("rolls back approval completion when cancellation wins after the caller snapshot", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    const now = "2026-04-11T00:00:00.000Z";
    const runId = "durable-cancelled-after-snapshot";
    const turnId = "turn-cancelled-after-snapshot";
    createExactWaitingApprovalRun(storage, {
      runId,
      sessionId: "session-same-receipt-replay",
      turnId,
      userMessageId: "user-same-receipt-replay",
      now,
    });
    const staleWaitingTrace = storage.chatTurnTraces.create({
      turnId,
      sessionId: "session-cancelled-after-snapshot",
      userMessageId: "user-cancelled-after-snapshot",
      status: "waiting_for_approval",
      mode: "chat",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      durable: { runId, status: "waiting", checkpointKind: "run_waiting" },
      startedAt: now,
    });
    storage.chatTurnTraces.patch(turnId, {
      status: "cancelled",
      completion: { status: "interrupted", repaired: false },
      durable: { runId, status: "cancelled", checkpointKind: "run_cancelled" },
      finishedAt: "2026-04-11T00:00:01.000Z",
    });
    const publishRealtime = vi.fn();
    const service = new ApprovalEffectsService(
      { storage: createSqliteAsyncStorage(storage), publishRealtime } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );

    try {
      await expect(
        (
          service as unknown as {
            completeChatTurnFromApprovedAction(input: {
              trace: ChatTurnTraceRecord;
              outputText: string;
              now: string;
              approvalId: string;
              actionRecord?: Record<string, unknown>;
            }): Promise<boolean>;
          }
        ).completeChatTurnFromApprovedAction({
          trace: staleWaitingTrace,
          outputText: "late approval output",
          now: "2026-04-11T00:00:02.000Z",
          approvalId: "approval-cancelled",
        }),
      ).rejects.toThrow(/canonical Chat turn .* is already cancelled/i);

      expect(storage.durableRuns.getRun(runId)).toMatchObject({
        status: "waiting",
        metadata: expect.objectContaining({ chatTurnRuntimeAuthority: expect.any(Object) }),
      });
      expect(storage.durableRuns.listCheckpoints(runId)).toEqual([
        expect.objectContaining({ checkpointKind: "run_waiting" }),
      ]);
      expect(storage.chatMessages.get(`assistant-approved-${turnId}`)).toBeUndefined();
      expect(storage.chatTurnTraces.get(turnId)).toMatchObject({
        status: "cancelled",
        durable: { runId, status: "cancelled", checkpointKind: "run_cancelled" },
      });
      expect(publishRealtime).not.toHaveBeenCalled();
    } finally {
      storage.close();
    }
  });

  it("preserves enriched canonical assistant truth on a same-receipt replay without publishing inside the transaction", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    const now = "2026-04-11T00:00:00.000Z";
    const replayAt = "2026-04-11T00:00:02.000Z";
    const runId = "durable-same-receipt-replay";
    const turnId = "turn-same-receipt-replay";
    createExactWaitingApprovalRun(storage, {
      runId,
      sessionId: "session-same-receipt-replay",
      turnId,
      userMessageId: "user-same-receipt-replay",
      assistantMessageId: `assistant-approved-${turnId}`,
      now,
    });
    const waitingTrace = storage.chatTurnTraces.create({
      turnId,
      sessionId: "session-same-receipt-replay",
      userMessageId: "user-same-receipt-replay",
      assistantMessageId: `assistant-approved-${turnId}`,
      status: "waiting_for_approval",
      mode: "chat",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      durable: { runId, status: "waiting", checkpointKind: "run_waiting" },
      startedAt: now,
    });
    const publishRealtime = vi.fn();
    const service = new ApprovalEffectsService(
      { storage: createSqliteAsyncStorage(storage), publishRealtime } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );
    const complete = (at: string) =>
      (
        service as unknown as {
          completeChatTurnFromApprovedAction(input: {
            trace: ChatTurnTraceRecord;
            outputText: string;
            now: string;
            approvalId: string;
            actionRecord?: Record<string, unknown>;
          }): Promise<ChatTurnTraceRecord | undefined>;
        }
      ).completeChatTurnFromApprovedAction({
        trace: waitingTrace,
        outputText: "approved output",
        now: at,
        approvalId: "approval-same-receipt",
        actionRecord: { result: { ok: true } },
      });

    try {
      expect(await complete(now)).toMatchObject({ turnId, status: "waiting_for_approval" });
      const committedTrace = storage.chatTurnTraces.get(turnId);
      const assistantMessageId = committedTrace.assistantMessageId!;
      storage.chatMessages.upsert({
        messageId: assistantMessageId,
        sessionId: committedTrace.sessionId,
        role: "assistant",
        sourceAuthority: "agent_proposed",
        actorType: "agent",
        actorId: "assistant",
        content: "approved output",
        parts: [{ type: "text", text: "enriched approved output" }],
        timestamp: now,
        tokenInput: 17,
        tokenOutput: 23,
        costUsd: 0.0123,
      });

      expect(await complete(replayAt)).toMatchObject({ turnId, status: "completed" });

      expect(storage.chatMessages.get(assistantMessageId)).toMatchObject({
        content: "approved output",
        parts: [{ type: "text", text: "enriched approved output" }],
        tokenInput: 17,
        tokenOutput: 23,
        costUsd: 0.0123,
      });
      expect(storage.chatTurnTraces.get(turnId)).toMatchObject({
        status: "completed",
        assistantMessageId,
        finishedAt: now,
      });
      expect(publishRealtime).not.toHaveBeenCalled();
    } finally {
      storage.close();
    }
  });

  it("does not seize a running durable run during approval materialization", async () => {
    const runningRun = {
      runId: "durable-cancel-race",
      status: "running",
      version: 4,
      metadata: {},
    };
    const cancelledRun = {
      ...runningRun,
      status: "cancelled",
      version: 5,
    };
    const getRun = vi.fn().mockReturnValueOnce(runningRun).mockReturnValue(cancelledRun);
    const updateRun = vi.fn(() => {
      throw new Error("Durable run durable-cancel-race update conflict");
    });
    const createCheckpoint = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          durableRuns: { getRun, updateRun, createCheckpoint },
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

    await expect(
      (
        service as unknown as {
          completeDurableRunIfPresent(
            runId: string,
            input: { now: string; outputText: string; checkpointState: Record<string, unknown> },
          ): Promise<void>;
        }
      ).completeDurableRunIfPresent("durable-cancel-race", {
        now: "2026-04-11T00:00:00.000Z",
        outputText: "done",
        checkpointState: { status: "completed" },
      }),
    ).resolves.toBe("running");
    expect(updateRun).not.toHaveBeenCalled();
    expect(createCheckpoint).not.toHaveBeenCalled();
  });

  it("records completion and installs a fresh approved-turn post-commit generation atomically", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    const now = "2026-04-11T00:00:00.000Z";
    const runId = "durable-waiting";
    const turnId = "turn-approved";
    const assistantMessageId = `assistant-approved-${turnId}`;
    createExactWaitingApprovalRun(storage, {
      runId,
      sessionId: "session-approved",
      turnId,
      userMessageId: "user-approved",
      assistantMessageId,
      now,
    });
    storage.chatTurnTraces.create({
      turnId,
      sessionId: "session-approved",
      userMessageId: "user-approved",
      assistantMessageId,
      status: "waiting_for_approval",
      mode: "chat",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      durable: { runId, status: "waiting", checkpointKind: "run_waiting" },
      startedAt: now,
    });
    const updateRun = vi.spyOn(storage.durableRuns, "updateRun");
    const createCheckpoint = vi.spyOn(storage.durableRuns, "createCheckpoint");
    const recordDurableTimelineEvent = vi.fn();
    const service = new ApprovalEffectsService(
      { storage: createSqliteAsyncStorage(storage), publishRealtime: vi.fn() } as unknown as ServiceContext,
      {
        ...createApprovalEffectDeps(),
        recordDurableTimelineEvent,
      },
    );
    const complete = (at: string) =>
      (
        service as unknown as {
          completeDurableRunIfPresent(
            currentRunId: string,
            input: {
              now: string;
              outputText: string;
              checkpointState: Record<string, unknown>;
              postCommit: { approvalId: string; turnId: string; traceStatus: ChatTurnTraceRecord["status"] };
            },
          ): Promise<string | undefined>;
        }
      ).completeDurableRunIfPresent(runId, {
        now: at,
        outputText: "approved output",
        checkpointState: { status: "completed", approvalId: "approval-1", turnId },
        postCommit: { approvalId: "approval-1", turnId, traceStatus: "completed" },
      });

    try {
      expect(await complete(now)).toBe("completed");
      const completed = storage.durableRuns.getRun(runId);
      const waitingGeneration = `waiting-generation:${runId}`;
      expect(completed).toMatchObject({
        status: "completed",
        metadata: expect.objectContaining({
          generalChatPostCommitPending: expect.objectContaining({
            version: 1,
            traceStatus: "completed",
            generationId: expect.not.stringMatching(new RegExp(`^${waitingGeneration}$`)),
            completedEffects: [],
          }),
          approvalMaterializedPostCommit: expect.objectContaining({
            version: 1,
            approvalId: "approval-1",
            turnId,
            traceStatus: "completed",
          }),
          chatTurnRuntimeAuthority: expect.objectContaining({
            material: expect.objectContaining({
              transitionKind: "terminal",
              requiredFinalizers: ["general"],
              terminalOutput: expect.objectContaining({
                assistantMessageId,
                outputTextSha256: expect.any(String),
                outputSummarySha256: expect.any(String),
              }),
            }),
          }),
        }),
      });
      expect(completed.metadata?.autonomousChatPostCommitPending).toBeUndefined();
      expect(storage.durableRuns.getLatestCheckpointByKind(runId, "run_completed")?.state).toEqual(
        expect.objectContaining({
          status: "completed",
          approvalId: "approval-1",
          turnId,
          assistantMessageId,
          outputText: "approved output",
          chatTurnRuntimeAuthority: expect.any(Object),
        }),
      );
      expect(recordDurableTimelineEvent).toHaveBeenCalledWith(
        runId,
        "run_completed",
        expect.objectContaining({
          status: "completed",
          approvalId: "approval-1",
          turnId,
          assistantMessageId,
          outputText: "approved output",
        }),
      );

      expect(await complete("2026-04-11T00:00:01.000Z")).toBe("completed");
      expect(updateRun).toHaveBeenCalledTimes(1);
      expect(createCheckpoint).toHaveBeenCalledTimes(1);
      expect(recordDurableTimelineEvent).toHaveBeenCalledTimes(1);
    } finally {
      storage.close();
    }
  });

  it("converges retries from two child approvals on one delegation-parent materialization identity", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    const now = "2026-04-11T00:00:00.000Z";
    const runId = "durable-parent-two-approvals";
    const turnId = "turn-parent-two-approvals";
    const materializationKey = "delegation:delegation-two-approvals:parent:turn-parent-two-approvals";
    createExactWaitingApprovalRun(storage, {
      runId,
      sessionId: "session-parent-two-approvals",
      turnId,
      userMessageId: "user-parent-two-approvals",
      now,
    });
    storage.chatTurnTraces.create({
      turnId,
      sessionId: "session-parent-two-approvals",
      userMessageId: "user-parent-two-approvals",
      assistantMessageId: `assistant-approved-${turnId}`,
      status: "waiting_for_approval",
      mode: "chat",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      durable: { runId, status: "waiting", checkpointKind: "run_waiting" },
      startedAt: now,
    });
    const service = new ApprovalEffectsService(
      { storage: createSqliteAsyncStorage(storage), publishRealtime: vi.fn() } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );
    const completeParent = (approvalId: string, identity: string) =>
      (
        service as unknown as {
          completeDurableRunIfPresent(
            currentRunId: string,
            input: {
              now: string;
              outputText: string;
              checkpointState: Record<string, unknown>;
              postCommit: {
                approvalId: string;
                turnId: string;
                traceStatus: ChatTurnTraceRecord["status"];
                materializationKey: string;
              };
            },
          ): Promise<string | undefined>;
        }
      ).completeDurableRunIfPresent(runId, {
        now,
        outputText: "delegation complete",
        checkpointState: { delegationRunId: "delegation-two-approvals", turnId },
        postCommit: { approvalId, turnId, traceStatus: "completed", materializationKey: identity },
      });

    try {
      expect(await completeParent("approval-child-b", materializationKey)).toBe("completed");
      storage.chatTurnTraces.patch(turnId, {
        status: "completed",
        durable: { runId, status: "completed", checkpointKind: "run_completed" },
        completion: { status: "complete", repaired: false, repair: { applied: false } },
        finishedAt: now,
      });
      const completed = storage.durableRuns.getRun(runId);

      await expect(completeParent("approval-child-a", materializationKey)).resolves.toBe("completed");

      expect(storage.durableRuns.getRun(runId)).toMatchObject({
        version: completed.version,
        metadata: {
          approvalMaterializedPostCommit: expect.objectContaining({
            approvalId: "approval-child-b",
            turnId,
            materializationKey,
          }),
        },
      });
    } finally {
      storage.close();
    }
  });

  it("rejects the same approval provenance for a different delegation-parent aggregate", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    const now = "2026-04-11T00:00:00.000Z";
    const runId = "durable-parent-identity-boundary";
    const turnId = "turn-parent-identity-boundary";
    const materializationKey = "delegation:delegation-one:parent:turn-parent-identity-boundary";
    createExactWaitingApprovalRun(storage, {
      runId,
      sessionId: "session-parent-identity-boundary",
      turnId,
      userMessageId: "user-parent-identity-boundary",
      now,
    });
    storage.chatTurnTraces.create({
      turnId,
      sessionId: "session-parent-identity-boundary",
      userMessageId: "user-parent-identity-boundary",
      assistantMessageId: `assistant-approved-${turnId}`,
      status: "waiting_for_approval",
      mode: "chat",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      durable: { runId, status: "waiting", checkpointKind: "run_waiting" },
      startedAt: now,
    });
    const service = new ApprovalEffectsService(
      { storage: createSqliteAsyncStorage(storage), publishRealtime: vi.fn() } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );
    const completeParent = (identity: string) =>
      (
        service as unknown as {
          completeDurableRunIfPresent(
            currentRunId: string,
            input: {
              now: string;
              outputText: string;
              checkpointState: Record<string, unknown>;
              postCommit: {
                approvalId: string;
                turnId: string;
                traceStatus: ChatTurnTraceRecord["status"];
                materializationKey: string;
              };
            },
          ): Promise<string | undefined>;
        }
      ).completeDurableRunIfPresent(runId, {
        now,
        outputText: "delegation complete",
        checkpointState: { turnId },
        postCommit: {
          approvalId: "approval-child-b",
          turnId,
          traceStatus: "completed",
          materializationKey: identity,
        },
      });

    try {
      expect(await completeParent(materializationKey)).toBe("completed");
      storage.chatTurnTraces.patch(turnId, {
        status: "completed",
        durable: { runId, status: "completed", checkpointKind: "run_completed" },
        completion: { status: "complete", repaired: false, repair: { applied: false } },
        finishedAt: now,
      });

      await expect(
        completeParent("delegation:delegation-unrelated:parent:turn-parent-identity-boundary"),
      ).rejects.toThrow(/different materialization identity/i);
    } finally {
      storage.close();
    }
  });

  it("fails closed when a competing approval wins the durable completion conflict", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    const now = "2026-04-11T00:00:00.000Z";
    const runId = "durable-conflict";
    const turnId = "turn-approved";
    const assistantMessageId = `assistant-approved-${turnId}`;
    createExactWaitingApprovalRun(storage, {
      runId,
      sessionId: "session-conflict",
      turnId,
      userMessageId: "user-conflict",
      assistantMessageId,
      now,
    });
    storage.chatTurnTraces.create({
      turnId,
      sessionId: "session-conflict",
      userMessageId: "user-conflict",
      assistantMessageId,
      status: "waiting_for_approval",
      mode: "chat",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      durable: { runId, status: "waiting", checkpointKind: "run_waiting" },
      startedAt: now,
    });
    const readRun = storage.durableRuns.getRun.bind(storage.durableRuns);
    let conflictWon = false;
    vi.spyOn(storage.durableRuns, "getRun").mockImplementation((currentRunId) => {
      const current = readRun(currentRunId);
      return conflictWon
        ? {
            ...current,
            status: "completed",
            version: current.version + 1,
            metadata: {
              ...(current.metadata ?? {}),
              approvalMaterializedPostCommit: {
                version: 1,
                approvalId: "approval-other",
                turnId: "turn-other",
              },
            },
          }
        : current;
    });
    vi.spyOn(storage.durableRuns, "updateRun").mockImplementation(() => {
      conflictWon = true;
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "lost completion race",
      });
    });
    const service = new ApprovalEffectsService(
      { storage: createSqliteAsyncStorage(storage), publishRealtime: vi.fn() } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );

    try {
      await expect(
        (
          service as unknown as {
            completeDurableRunIfPresent(
              currentRunId: string,
              input: {
                now: string;
                outputText: string;
                checkpointState: Record<string, unknown>;
                postCommit: { approvalId: string; turnId: string; traceStatus: ChatTurnTraceRecord["status"] };
              },
            ): Promise<string | undefined>;
          }
        ).completeDurableRunIfPresent(runId, {
          now,
          outputText: "approved output",
          checkpointState: { status: "completed" },
          postCommit: { approvalId: "approval-1", turnId, traceStatus: "completed" },
        }),
      ).rejects.toThrow(/already materialized by approval approval-other/i);
    } finally {
      storage.close();
    }
  });

  it("leaves running Chat and delegation truth untouched until the durable run parks", async () => {
    const effect = createEffect({
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "approval-1",
    });
    let trace: ChatTurnTraceRecord = {
      turnId: "turn-cancel-race",
      sessionId: "session-1",
      userMessageId: "user-1",
      branchKind: "append",
      status: "waiting_for_approval",
      mode: "chat",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      startedAt: "2026-04-11T00:00:00.000Z",
      toolRuns: [],
      citations: [],
      routing: {},
      durable: { runId: "durable-cancel-race", status: "running" },
    };
    const runningRun = {
      runId: "durable-cancel-race",
      status: "running" as const,
      version: 4,
      metadata: {},
    };
    const cancelledRun = {
      ...runningRun,
      status: "cancelled" as const,
      version: 5,
    };
    let durableRun = runningRun as typeof runningRun | typeof cancelledRun;
    const chatMessagesUpsert = vi.fn();
    const chatTurnTracesPatch = vi.fn();
    const delegationParents = vi.fn(() => new Map());
    const updateRun = vi.fn(() => {
      durableRun = cancelledRun;
      trace = {
        ...trace,
        status: "cancelled",
        completion: { status: "interrupted", repaired: false },
        durable: { ...trace.durable!, status: "cancelled" },
      };
      throw new Error("Durable run durable-cancel-race update conflict");
    });
    const service = new ApprovalEffectsService(
      {
        storage: {
          chatInlineApprovals: {
            get: vi.fn(() => ({
              approvalId: "approval-1",
              sessionId: "session-1",
              turnId: "turn-cancel-race",
              toolName: "shell.exec",
              status: "pending",
              reason: "Needs approval",
              createdAt: "2026-04-11T00:00:00.000Z",
            })),
            upsert: vi.fn(),
          },
          chatToolRuns: {
            listByTurn: vi.fn(() => [
              {
                toolRunId: "tool-run-1",
                turnId: "turn-cancel-race",
                sessionId: "session-1",
                toolName: "shell.exec",
                approvalId: "approval-1",
                status: "approval_required",
              },
            ]),
            patch: vi.fn(),
          },
          chatMessages: { upsert: chatMessagesUpsert },
          chatTurnTraces: {
            get: vi.fn(() => trace),
            patch: chatTurnTracesPatch,
          },
          durableRuns: {
            getRun: vi.fn(() => durableRun),
            updateRun,
            createCheckpoint: vi.fn(),
          },
          chatDelegationSteps: {
            listParentsByChildSessionIds: delegationParents,
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

    await expect(
      (
        service as unknown as {
          materializeExecutedChatApproval(
            currentEffect: ApprovalEffectRecord,
            pendingAction: {
              approvalId: string;
              actionType: string;
              request: Record<string, unknown>;
              createdAt: string;
              resolutionStatus: string;
            },
            result: Record<string, unknown>,
          ): Promise<void>;
        }
      ).materializeExecutedChatApproval(
        effect,
        {
          approvalId: "approval-1",
          actionType: "tool.invoke",
          request: { toolName: "shell.exec", args: { command: "pwd" } },
          createdAt: "2026-04-11T00:00:00.000Z",
          resolutionStatus: "executed",
        },
        { outcome: "executed", result: { ok: true } },
      ),
    ).resolves.toBeUndefined();

    expect(updateRun).not.toHaveBeenCalled();
    expect(trace.status).toBe("waiting_for_approval");
    expect(trace.durable?.status).toBe("running");
    expect(chatMessagesUpsert).not.toHaveBeenCalled();
    expect(chatTurnTracesPatch).not.toHaveBeenCalled();
    expect(delegationParents).not.toHaveBeenCalled();
  });

  it("emits explicit retained-stream metadata when an approval wait wake is skipped", async () => {
    const publishRealtime = vi.fn(async () => undefined);
    const skipEffect = vi.fn(() => ({ status: "skipped" as const }));
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            failEffect: vi.fn(() => ({ status: "failed" as const })),
            skipEffect,
            completeEffect: vi.fn(() => ({ status: "completed" as const })),
          },
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

  it("sets both lane guards synchronously for same-tick requests from different attribution contexts", async () => {
    const backgroundTasks = new Set<Promise<void>>();
    const actionWorkerAttributions: unknown[] = [];
    const observabilityWorkerAttributions: unknown[] = [];
    const claimNextPendingEffect = vi.fn(() => {
      actionWorkerAttributions.push(getRequestAttribution());
      return undefined;
    });
    const claimNextPendingObservabilityEffect = vi.fn(() => {
      observabilityWorkerAttributions.push(getRequestAttribution());
      return undefined;
    });
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            claimNextPendingEffect,
            claimNextPendingObservabilityEffect,
            listByApproval: vi.fn(() => []),
          },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      { ...createApprovalEffectDeps(), backgroundTasks },
    );

    runWithRequestAttribution({ actorId: "operator-a" }, () => service.requestEffectProcessing());
    runWithRequestAttribution({ actorId: "operator-b" }, () => service.requestEffectProcessing());

    expect(backgroundTasks.size).toBe(2);
    await Promise.all([...backgroundTasks]);
    expect(claimNextPendingEffect).toHaveBeenCalledOnce();
    expect(claimNextPendingObservabilityEffect).toHaveBeenCalledOnce();
    expect(actionWorkerAttributions).toEqual([{}]);
    expect(observabilityWorkerAttributions).toEqual([{}]);
    expect(backgroundTasks.size).toBe(0);
    service.stopWorker();
  });

  it("reconciles generic and device approval expiry without one sweep blocking the other", async () => {
    const backgroundTasks = new Set<Promise<void>>();
    const reconcileExpiredApprovals = vi.fn(() => 2);
    const reconcileExpiredDeviceAccessRequests = vi.fn(async () => {
      throw new Error("device expiry sweep failed");
    });
    const reconcileExpiredRemoteActionTokens = vi.fn(() => 3);
    const publishRealtime = vi.fn(async () => undefined);
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            claimNextPendingEffect: vi.fn(() => undefined),
            listByApproval: vi.fn(() => []),
          },
        },
        publishRealtime,
      } as unknown as ServiceContext,
      {
        ...createApprovalEffectDeps(),
        backgroundTasks,
        reconcileExpiredApprovals,
        reconcileExpiredDeviceAccessRequests,
        approvalRemoteTokenSecrets: {
          reconcileExpired: reconcileExpiredRemoteActionTokens,
          deleteById: vi.fn(),
        },
      },
    );

    service.requestEffectProcessing();
    await Promise.all([...backgroundTasks]);

    expect(reconcileExpiredApprovals).toHaveBeenCalledWith(100);
    expect(reconcileExpiredDeviceAccessRequests).toHaveBeenCalledWith(100);
    expect(reconcileExpiredRemoteActionTokens).toHaveBeenCalledWith(100);
    expect(publishRealtime).toHaveBeenCalledWith(
      "approval_effect_worker_failed",
      "approvals",
      expect.objectContaining({ lane: "action", error: "device expiry sweep failed" }),
    );
    service.stopWorker();
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
      const completeEffect = vi.fn(() => ({ status: "completed" as const }));
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

  it("reschedules already-claimed Code Mode effects without terminalizing them when diagnostics fail", async () => {
    let effectState = createEffect({
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "approval-1",
      status: "running",
    });
    const completeEffect = vi.fn(() => ({ status: "completed" as const }));
    const failEffect = vi.fn();
    const skipEffect = vi.fn();
    const deferEffectForRetry = vi.fn(
      (
        _effectId: string,
        _workerId: string,
        _version: number,
        input: { lastError: string; retryAt: string; result: Record<string, unknown> },
      ) => {
        effectState = {
          ...effectState,
          version: effectState.version + 1,
          lastError: input.lastError,
          leaseExpiresAt: input.retryAt,
          result: input.result,
        };
        return effectState;
      },
    );
    const markResolved = vi.fn();
    const publishRealtime = vi.fn(() => {
      throw new Error("retained stream unavailable");
    });
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            get: vi.fn(() => effectState),
            completeEffect,
            failEffect,
            skipEffect,
            deferEffectForRetry,
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
    expect(deferEffectForRetry).toHaveBeenCalledWith(
      "effect-1",
      expect.any(String),
      1,
      expect.objectContaining({
        lastError: expect.stringContaining("claim is still active"),
        retryAt: expect.any(String),
        result: expect.objectContaining({
          actionType: "code_mode.run",
          approvalId: "approval-1",
          runId: "code-run-1",
          reason: "code_mode_run_already_claimed",
          retryDelayMs: 1_000,
        }),
      }),
    );
    expect(effectState).toMatchObject({
      status: "running",
      version: 2,
      lastError: expect.stringContaining("claim is still active"),
    });
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

  it("lets a restarted worker reclaim and complete a deferred Code Mode effect after the retry lease", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    const asyncStorage = createSqliteAsyncStorage(storage);
    const approval = storage.approvals.create({
      kind: "code_mode.run",
      riskLevel: "danger",
      payload: { runId: "code-run-restart-1" },
      preview: {},
    });
    storage.pendingApprovalActions.upsertPending({
      approvalId: approval.approvalId,
      actionType: "code_mode.run",
      request: { runId: "code-run-restart-1" },
    });
    const effect = storage.approvalEffects.upsert({
      approvalId: approval.approvalId,
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: approval.approvalId,
      payload: { actionType: "code_mode.run" },
    });
    const firstExecution = vi.fn(async () => undefined);
    const firstWorker = new ApprovalEffectsService(
      { storage: asyncStorage, publishRealtime: vi.fn() } as unknown as ServiceContext,
      {
        ...createApprovalEffectDeps(),
        executeCodeModePendingApproval: firstExecution,
      },
    );

    try {
      await (
        firstWorker as unknown as {
          drainPendingEffects(): Promise<void>;
        }
      ).drainPendingEffects();

      const deferred = storage.approvalEffects.get(effect.effectId);
      expect(firstExecution).toHaveBeenCalledOnce();
      expect(deferred).toMatchObject({
        status: "running",
        attemptCount: 1,
        claimedBy: expect.any(String),
        lastError: expect.stringContaining("claim is still active"),
        result: expect.objectContaining({
          reason: "code_mode_run_already_claimed",
          retryDelayMs: 1_000,
        }),
      });
      expect(storage.pendingApprovalActions.get(approval.approvalId).resolutionStatus).toBe("pending");

      await new Promise<void>((resolve) => setTimeout(resolve, 1_100));

      const restartedExecution = vi.fn(async () => ({
        outcome: "executed" as const,
        policyReason: "code_mode_run:completed",
        auditEventId: "audit-code-mode-restart-1",
        result: { runId: "code-run-restart-1", status: "completed" },
      }));
      const restartedWorker = new ApprovalEffectsService(
        { storage: asyncStorage, publishRealtime: vi.fn() } as unknown as ServiceContext,
        {
          ...createApprovalEffectDeps(),
          executeCodeModePendingApproval: restartedExecution,
        },
      );

      await (
        restartedWorker as unknown as {
          drainPendingEffects(): Promise<void>;
        }
      ).drainPendingEffects();

      expect(restartedExecution).toHaveBeenCalledOnce();
      expect(storage.pendingApprovalActions.get(approval.approvalId)).toMatchObject({
        resolutionStatus: "executed",
        result: expect.objectContaining({
          outcome: "executed",
          result: expect.objectContaining({ status: "completed" }),
        }),
      });
      expect(storage.approvalEffects.get(effect.effectId)).toMatchObject({
        status: "completed",
        attemptCount: 2,
        claimedBy: undefined,
        leaseExpiresAt: undefined,
      });
    } finally {
      firstWorker.stopWorker();
      storage.close();
    }
  });

  it.each([
    {
      label: "communications failure",
      result: {
        status: "failed",
        deliveryStatus: "not_available",
        error: "Channel connection is disabled.",
      },
      outcome: "executed" as const,
      policyReason: "allowed_via_approval:approval-domain-failure",
      expectedKind: "failed",
    },
    {
      label: "HTTP unknown-after-send",
      result: {
        status: "failed",
        deliveryStatus: "manual_reconciliation_required",
        externalOutcome: "unknown_after_send",
        manualReconciliationRequired: true,
        error: "The remote outcome is unknown after dispatch.",
      },
      outcome: "executed" as const,
      policyReason: "execution outcome unknown",
      expectedKind: "manual_reconciliation",
    },
    {
      label: "post-approval execution block",
      result: undefined,
      outcome: "blocked" as const,
      policyReason: "execution error: provider unavailable",
      expectedKind: "failed",
    },
    {
      label: "blocked unknown external outcome",
      result: {
        status: "failed",
        externalOutcome: "unknown_after_send",
        manualReconciliationRequired: true,
        error: "External runtime outcome is unknown after dispatch.",
      },
      outcome: "blocked" as const,
      policyReason: "manual reconciliation required",
      expectedKind: "manual_reconciliation",
    },
  ])(
    "records an approved $label as failed canonical action truth",
    async ({ result, outcome, policyReason, expectedKind }) => {
      const effect = createEffect({
        approvalId: "approval-domain-failure",
        effectKind: "pending_action_execute",
        targetKind: "pending_action",
        targetId: "approval-domain-failure",
        status: "running",
      });
      const pendingAction: PendingApprovalAction = {
        approvalId: "approval-domain-failure",
        actionType: "tool.invoke",
        request: { toolName: "channel.send" },
        createdAt: "2026-04-11T00:00:00.000Z",
        resolutionStatus: "pending",
      };
      const markResolved = vi.fn();
      const completeEffect = vi.fn(() => ({ status: "completed" as const }));
      const failEffect = vi.fn();
      let claimedEffect = effect;
      const service = new ApprovalEffectsService(
        {
          storage: {
            approvalEffects: {
              get: vi.fn(() => claimedEffect),
              completeEffect,
              failEffect,
              skipEffect: vi.fn(),
            },
            pendingApprovalActions: {
              find: vi.fn(() => pendingAction),
              markResolved,
            },
          },
          publishRealtime: vi.fn(),
        } as unknown as ServiceContext,
        {
          ...createApprovalEffectDeps(),
          executeApprovedPendingAction: vi.fn(async () => ({
            outcome,
            policyReason,
            auditEventId: "audit-domain-failure",
            result,
          })),
        },
      );
      claimedEffect = {
        ...effect,
        claimedBy: (service as unknown as { workerId: string }).workerId,
      };
      const materializeFailed = vi
        .spyOn(
          service as unknown as {
            materializeFailedChatApprovalOrDefer: (...args: unknown[]) => Promise<boolean>;
          },
          "materializeFailedChatApprovalOrDefer",
        )
        .mockImplementation(async () => {
          completeEffect(effect.effectId, "worker", effect.version, { result: {} });
          return true;
        });

      await (
        service as unknown as {
          handlePendingActionExecute(effect: ApprovalEffectRecord): Promise<void>;
        }
      ).handlePendingActionExecute(claimedEffect);

      expect(markResolved).toHaveBeenCalledWith(
        pendingAction.approvalId,
        "failed",
        expect.objectContaining({ outcome, result }),
      );
      expect(materializeFailed).toHaveBeenCalledWith(
        claimedEffect,
        pendingAction,
        expect.objectContaining({ outcome, result }),
        expect.objectContaining({ kind: expectedKind }),
      );
      expect(completeEffect).toHaveBeenCalledOnce();
      expect(failEffect).not.toHaveBeenCalled();
    },
  );

  it("resumes failed Chat materialization from a stored post-approval execution failure", async () => {
    const effect = createEffect({
      approvalId: "approval-stored-failure",
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "approval-stored-failure",
      status: "running",
    });
    const pendingAction: PendingApprovalAction = {
      approvalId: effect.approvalId,
      actionType: "tool.invoke",
      request: { toolName: "channel.send" },
      createdAt: "2026-04-11T00:00:00.000Z",
      resolutionStatus: "failed",
      result: {
        outcome: "blocked",
        policyReason: "execution error: provider unavailable",
        auditEventId: "audit-stored-failure",
      },
    };
    const completeEffect = vi.fn(() => ({ status: "completed" as const }));
    const skipEffect = vi.fn(() => ({ status: "skipped" as const }));
    const executeApprovedPendingAction = vi.fn();
    let claimedEffect = effect;
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            get: vi.fn(() => claimedEffect),
            completeEffect,
            failEffect: vi.fn(),
            skipEffect,
          },
          pendingApprovalActions: {
            find: vi.fn(() => pendingAction),
            markResolved: vi.fn(),
          },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      { ...createApprovalEffectDeps(), executeApprovedPendingAction },
    );
    claimedEffect = { ...effect, claimedBy: (service as unknown as { workerId: string }).workerId };
    const materializeFailed = vi
      .spyOn(
        service as unknown as {
          materializeFailedChatApprovalOrDefer: (...args: unknown[]) => Promise<boolean>;
        },
        "materializeFailedChatApprovalOrDefer",
      )
      .mockImplementation(async () => {
        completeEffect(effect.effectId, "worker", effect.version, { result: {} });
        return true;
      });

    await (
      service as unknown as {
        handlePendingActionExecute(effect: ApprovalEffectRecord): Promise<void>;
      }
    ).handlePendingActionExecute(claimedEffect);

    expect(executeApprovedPendingAction).not.toHaveBeenCalled();
    expect(materializeFailed).toHaveBeenCalledWith(
      claimedEffect,
      pendingAction,
      pendingAction.result,
      expect.objectContaining({ message: "execution error: provider unavailable", kind: "failed" }),
    );
    expect(completeEffect).toHaveBeenCalledOnce();
    expect(skipEffect).not.toHaveBeenCalled();
  });

  it("preserves manual reconciliation when resuming a stored interrupted Code Mode outcome", async () => {
    const effect = createEffect({
      approvalId: "approval-stored-code-mode-interruption",
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "approval-stored-code-mode-interruption",
      status: "running",
    });
    const pendingAction: PendingApprovalAction = {
      approvalId: effect.approvalId,
      actionType: "code_mode.run",
      request: { runId: "code-run-interrupted-1" },
      createdAt: "2026-04-11T00:00:00.000Z",
      resolutionStatus: "failed",
      result: {
        outcome: "failed",
        runId: "code-run-interrupted-1",
        error: "Gateway restarted after the execution boundary.",
        manualReconciliationRequired: true,
        executionRecovery: {
          generation: 1,
          phase: "terminal",
          disposition: "manual_reconciliation",
        },
      },
    };
    const completeEffect = vi.fn(() => ({ status: "completed" as const }));
    let claimedEffect = effect;
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            get: vi.fn(() => claimedEffect),
            completeEffect,
            failEffect: vi.fn(),
            skipEffect: vi.fn(),
          },
          pendingApprovalActions: {
            find: vi.fn(() => pendingAction),
            markResolved: vi.fn(),
          },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );
    claimedEffect = { ...effect, claimedBy: (service as unknown as { workerId: string }).workerId };
    const materializeFailed = vi
      .spyOn(
        service as unknown as {
          materializeFailedChatApprovalOrDefer: (...args: unknown[]) => Promise<boolean>;
        },
        "materializeFailedChatApprovalOrDefer",
      )
      .mockImplementation(async () => {
        completeEffect(effect.effectId, "worker", effect.version, { result: {} });
        return true;
      });

    await (
      service as unknown as {
        handlePendingActionExecute(effect: ApprovalEffectRecord): Promise<void>;
      }
    ).handlePendingActionExecute(claimedEffect);

    expect(materializeFailed).toHaveBeenCalledWith(
      claimedEffect,
      pendingAction,
      pendingAction.result,
      expect.objectContaining({
        message: "Gateway restarted after the execution boundary.",
        kind: "manual_reconciliation",
        manualReconciliationRequired: true,
      }),
    );
    expect(completeEffect).toHaveBeenCalledOnce();
  });

  it("reclassifies the policy-engine executed receipt before materializing a domain failure", async () => {
    const effect = createEffect({
      approvalId: "approval-policy-domain-failure",
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "approval-policy-domain-failure",
      status: "running",
    });
    let pendingAction: PendingApprovalAction = {
      approvalId: effect.approvalId,
      actionType: "tool.invoke",
      request: { toolName: "http.post" },
      createdAt: "2026-04-11T00:00:00.000Z",
      resolutionStatus: "pending",
    };
    const executedResult = {
      outcome: "executed" as const,
      policyReason: "execution outcome unknown",
      auditEventId: "audit-policy-domain-failure",
      result: {
        status: "failed",
        externalOutcome: "unknown_after_send",
        manualReconciliationRequired: true,
        error: "External outcome unknown.",
      },
    };
    const reclassifyExecutedAsFailed = vi.fn(
      (_approvalId: string, _expectedResult: Record<string, unknown>, nextResult: Record<string, unknown>) => {
        pendingAction = { ...pendingAction, resolutionStatus: "failed", result: nextResult };
        return pendingAction;
      },
    );
    const markResolved = vi.fn();
    const completeEffect = vi.fn(() => ({ status: "completed" as const }));
    let claimedEffect = effect;
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            get: vi.fn(() => claimedEffect),
            completeEffect,
            failEffect: vi.fn(),
            skipEffect: vi.fn(),
          },
          pendingApprovalActions: {
            find: vi.fn(() => pendingAction),
            markResolved,
            reclassifyExecutedAsFailed,
          },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        ...createApprovalEffectDeps(),
        executeApprovedPendingAction: vi.fn(async () => {
          pendingAction = { ...pendingAction, resolutionStatus: "executed", result: { ...executedResult } };
          return executedResult;
        }),
      },
    );
    claimedEffect = { ...effect, claimedBy: (service as unknown as { workerId: string }).workerId };
    const materializeFailed = vi
      .spyOn(
        service as unknown as {
          materializeFailedChatApprovalOrDefer: (...args: unknown[]) => Promise<boolean>;
        },
        "materializeFailedChatApprovalOrDefer",
      )
      .mockImplementation(async () => {
        completeEffect(effect.effectId, "worker", effect.version, {
          result: { resolutionStatus: "failed" },
        });
        return true;
      });

    await (
      service as unknown as {
        handlePendingActionExecute(effect: ApprovalEffectRecord): Promise<void>;
      }
    ).handlePendingActionExecute(claimedEffect);

    expect(markResolved).not.toHaveBeenCalled();
    expect(reclassifyExecutedAsFailed).toHaveBeenCalledWith(
      effect.approvalId,
      expect.objectContaining({ outcome: "executed" }),
      expect.objectContaining({ outcome: "executed", actionType: "tool.invoke" }),
    );
    expect(pendingAction.resolutionStatus).toBe("failed");
    expect(materializeFailed).toHaveBeenCalledWith(
      claimedEffect,
      expect.objectContaining({ resolutionStatus: "failed" }),
      expect.objectContaining({ outcome: "executed" }),
      expect.objectContaining({ kind: "manual_reconciliation" }),
    );
    expect(completeEffect).toHaveBeenCalledWith(
      effect.effectId,
      expect.any(String),
      effect.version,
      expect.objectContaining({ result: expect.objectContaining({ resolutionStatus: "failed" }) }),
    );
  });

  it("materializes a stored pre-execution denial that has only a reason", async () => {
    const effect = createEffect({
      approvalId: "approval-pre-execution-denial",
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "approval-pre-execution-denial",
      status: "running",
    });
    let pendingAction: PendingApprovalAction = {
      approvalId: effect.approvalId,
      actionType: "tool.invoke",
      request: { toolName: "fs.write" },
      createdAt: "2026-04-11T00:00:00.000Z",
      resolutionStatus: "pending",
    };
    const completeEffect = vi.fn(() => ({ status: "completed" as const }));
    let claimedEffect = effect;
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: {
            get: vi.fn(() => claimedEffect),
            completeEffect,
            failEffect: vi.fn(),
            skipEffect: vi.fn(),
          },
          pendingApprovalActions: {
            find: vi.fn(() => pendingAction),
            markResolved: vi.fn(),
          },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        ...createApprovalEffectDeps(),
        executeApprovedPendingAction: vi.fn(async () => {
          pendingAction = {
            ...pendingAction,
            resolutionStatus: "failed",
            result: { reason: "Verified approval bypass expired before execution." },
          };
          return undefined;
        }),
      },
    );
    claimedEffect = { ...effect, claimedBy: (service as unknown as { workerId: string }).workerId };
    const materializeFailed = vi
      .spyOn(
        service as unknown as {
          materializeFailedChatApprovalOrDefer: (...args: unknown[]) => Promise<boolean>;
        },
        "materializeFailedChatApprovalOrDefer",
      )
      .mockImplementation(async () => {
        completeEffect(effect.effectId, "worker", effect.version, { result: {} });
        return true;
      });

    await (
      service as unknown as {
        handlePendingActionExecute(effect: ApprovalEffectRecord): Promise<void>;
      }
    ).handlePendingActionExecute(claimedEffect);

    expect(materializeFailed).toHaveBeenCalledWith(
      claimedEffect,
      pendingAction,
      pendingAction.result,
      expect.objectContaining({
        message: "Verified approval bypass expired before execution.",
        kind: "failed",
      }),
    );
    expect(completeEffect).toHaveBeenCalledOnce();
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
    let childTrace: ChatTurnTraceRecord = {
      turnId: "child-turn-1",
      sessionId: "child-session-1",
      userMessageId: "user-child-1",
      assistantMessageId: "assistant-approved-child-turn-1",
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
    let parentTrace: ChatTurnTraceRecord = {
      turnId: "parent-turn-1",
      sessionId: "parent-session-1",
      userMessageId: "user-parent-1",
      assistantMessageId: "assistant-approved-parent-turn-1",
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
    const childDurable = createExactWaitingApprovalFixture({
      runId: "child-durable-run",
      sessionId: childTrace.sessionId,
      turnId: childTrace.turnId,
      userMessageId: childTrace.userMessageId,
      assistantMessageId: childTrace.assistantMessageId!,
      now: childTrace.startedAt,
    });
    const parentDurable = createExactWaitingApprovalFixture({
      runId: "parent-durable-run",
      sessionId: parentTrace.sessionId,
      turnId: parentTrace.turnId,
      userMessageId: parentTrace.userMessageId,
      assistantMessageId: parentTrace.assistantMessageId!,
      now: parentTrace.startedAt,
    });
    const durableState = new Map<string, Record<string, unknown>>([
      [childDurable.run.runId, childDurable.run],
      [parentDurable.run.runId, parentDurable.run],
    ]);
    const durableFixtureByRunId = new Map([
      [childDurable.run.runId, childDurable],
      [parentDurable.run.runId, parentDurable],
    ]);
    const durableFixtureByAdmissionId = new Map([
      [childDurable.admission.admissionId, childDurable],
      [parentDurable.admission.admissionId, parentDurable],
    ]);
    const completeEffect = vi.fn(() => ({ status: "completed" as const }));
    const markResolved = vi.fn();
    const chatMessagesUpsert = vi.fn();
    const chatToolRunsPatch = vi.fn();
    const chatTurnTracesPatch = vi.fn((turnId: string, patch: Partial<ChatTurnTraceRecord>) => {
      if (turnId === childTrace.turnId) {
        childTrace = { ...childTrace, ...patch } as ChatTurnTraceRecord;
        return childTrace;
      }
      parentTrace = { ...parentTrace, ...patch } as ChatTurnTraceRecord;
      return parentTrace;
    });
    const durableUpdateRun = vi.fn((input: Record<string, unknown>) => {
      const runId = String(input.runId);
      const current = durableState.get(runId)!;
      const next = {
        ...current,
        ...input,
        version: Number(current.version) + 1,
      };
      durableState.set(runId, next);
      return next;
    });
    const durableCreateCheckpoint = vi.fn();
    const delegationStepMaterialize = vi.fn((input: Partial<ChatDelegationStepRecord>) => {
      parentStep = { ...parentStep, ...input } as ChatDelegationStepRecord;
      return { outcome: "applied" as const, step: parentStep };
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
            getRun: vi.fn((runId: string) => durableState.get(runId)),
            getLatestCheckpointByKind: vi.fn((runId: string, kind: string) => {
              const fixture = durableFixtureByRunId.get(runId);
              return kind === "run_waiting" ? fixture?.checkpoint : undefined;
            }),
            updateRun: durableUpdateRun,
            createCheckpoint: durableCreateCheckpoint,
          },
          sessionMutationAdmissions: {
            require: vi.fn((admissionId: string) => durableFixtureByAdmissionId.get(admissionId)?.admission),
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
            materializeApprovalOutcome: delegationStepMaterialize,
            listByRunForUpdate: vi.fn(() => [parentStep]),
          },
          chatDelegationRuns: {
            getForUpdate: vi.fn(() => ({
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
        ...createApprovalEffectDeps(),
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
        effectPotential: "unknown",
        effectDisposition: "unknown",
        effectOutcomeKind: "uncertain",
        effectEvidence: expect.objectContaining({
          reason: "completed_without_canonical_effect_receipt",
          refs: [],
        }),
        failureGuidance: expect.stringContaining("Inspect external or runtime state"),
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
    expect(delegationStepMaterialize).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: "delegation-run-1:worker",
        expectedChildSessionId: "child-session-1",
        expectedChildTurnId: "child-turn-1",
        status: "completed",
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
        metadata: expect.objectContaining({
          approvalMaterializedPostCommit: expect.objectContaining({
            approvalId: "approval-1",
            turnId: "parent-turn-1",
            materializationKey: "delegation-parent:delegation-run-1:parent-turn-1",
          }),
        }),
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

  it("does not resurrect a cancelled delegation step from a late approved-child materialization", async () => {
    const cancelledStep: ChatDelegationStepRecord = {
      stepId: "step-cancelled-winner",
      runId: "run-cancelled-winner",
      role: "worker",
      status: "cancelled",
      index: 0,
      summary: "Operator cancelled",
      childSessionId: "child-cancelled-winner",
      childTurnId: "turn-cancelled-winner",
      startedAt: "2026-04-11T00:00:00.000Z",
      finishedAt: "2026-04-11T00:00:01.000Z",
    };
    const materializeApprovalOutcome = vi.fn(() => ({ outcome: "rejected" as const, step: cancelledStep }));
    const delegationRunGet = vi.fn();
    const delegationRunPatch = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          chatDelegationSteps: {
            listParentsByChildSessionIds: vi.fn(
              () =>
                new Map([
                  [
                    "child-cancelled-winner",
                    {
                      parentSessionId: "parent-session",
                      runId: "run-cancelled-winner",
                      stepId: cancelledStep.stepId,
                      role: cancelledStep.role,
                      index: cancelledStep.index,
                    },
                  ],
                ]),
            ),
            listByRunForUpdate: vi.fn(() => [cancelledStep]),
            materializeApprovalOutcome,
          },
          chatDelegationRuns: { getForUpdate: delegationRunGet, patch: delegationRunPatch },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );

    const materialized = await (
      service as unknown as {
        materializeDelegationParentsFromApprovedChild(input: {
          childTrace: ChatTurnTraceRecord;
          outputText: string;
          now: string;
          approvalId: string;
        }): Promise<unknown>;
      }
    ).materializeDelegationParentsFromApprovedChild({
      childTrace: createWaitingChildTrace("child-cancelled-winner", "turn-cancelled-winner"),
      outputText: "Late approved output",
      now: "2026-04-11T00:00:02.000Z",
      approvalId: "approval-late",
    });

    expect(materialized).toBeUndefined();
    expect(materializeApprovalOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: cancelledStep.stepId,
        expectedChildSessionId: "child-cancelled-winner",
        expectedChildTurnId: "turn-cancelled-winner",
        status: "completed",
      }),
    );
    expect(delegationRunGet).toHaveBeenCalledWith("run-cancelled-winner");
    expect(delegationRunPatch).not.toHaveBeenCalled();
    expect(cancelledStep.status).toBe("cancelled");
  });

  it("does not fail a replacement child from a stale approved-child failure", async () => {
    const replacementStep: ChatDelegationStepRecord = {
      stepId: "step-replacement-child",
      runId: "run-replacement-child",
      role: "worker",
      status: "running",
      index: 0,
      childSessionId: "replacement-session",
      childTurnId: "replacement-turn",
      startedAt: "2026-04-11T00:00:00.000Z",
    };
    const materializeApprovalOutcome = vi.fn(() => ({ outcome: "rejected" as const, step: replacementStep }));
    const delegationRunGet = vi.fn();
    const delegationRunPatch = vi.fn();
    const service = new ApprovalEffectsService(
      {
        storage: {
          chatDelegationSteps: {
            listParentsByChildSessionIds: vi.fn(
              () =>
                new Map([
                  [
                    "stale-session",
                    {
                      parentSessionId: "parent-session",
                      runId: "run-replacement-child",
                      stepId: replacementStep.stepId,
                      role: replacementStep.role,
                      index: replacementStep.index,
                    },
                  ],
                ]),
            ),
            listByRunForUpdate: vi.fn(() => [replacementStep]),
            materializeApprovalOutcome,
          },
          chatDelegationRuns: { getForUpdate: delegationRunGet, patch: delegationRunPatch },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );

    const materialized = await (
      service as unknown as {
        materializeDelegationParentsFromFailedChild(input: {
          childTrace: ChatTurnTraceRecord;
          outputText: string;
          now: string;
          approvalId: string;
          failure: {
            kind: "failed";
            message: string;
          };
        }): Promise<unknown>;
      }
    ).materializeDelegationParentsFromFailedChild({
      childTrace: createWaitingChildTrace("stale-session", "stale-turn"),
      outputText: "Late failure",
      now: "2026-04-11T00:00:02.000Z",
      approvalId: "approval-stale",
      failure: { kind: "failed", message: "Late failure" },
    });

    expect(materialized).toBeUndefined();
    expect(materializeApprovalOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: replacementStep.stepId,
        expectedChildSessionId: "stale-session",
        expectedChildTurnId: "stale-turn",
        status: "failed",
      }),
    );
    expect(delegationRunGet).toHaveBeenCalledWith("run-replacement-child");
    expect(delegationRunPatch).not.toHaveBeenCalled();
    expect(replacementStep.childSessionId).toBe("replacement-session");
    expect(replacementStep.childTurnId).toBe("replacement-turn");
  });

  it("locks the delegation parent and stable step set before an approval outcome CAS", async () => {
    const lockOrder: string[] = [];
    let step: ChatDelegationStepRecord = {
      stepId: "step-lock-order",
      runId: "run-lock-order",
      role: "worker",
      status: "running",
      index: 0,
      childSessionId: "child-lock-order",
      childTurnId: "turn-lock-order",
      startedAt: "2026-04-11T00:00:00.000Z",
    };
    const service = new ApprovalEffectsService(
      {
        storage: {
          chatDelegationSteps: {
            listParentsByChildSessionIds: vi.fn(
              () =>
                new Map([
                  [
                    "child-lock-order",
                    {
                      parentSessionId: "parent-lock-order",
                      runId: "run-lock-order",
                      stepId: step.stepId,
                      role: step.role,
                      index: step.index,
                    },
                  ],
                ]),
            ),
            listByRunForUpdate: vi.fn(() => {
              lockOrder.push("step-set");
              return [step];
            }),
            materializeApprovalOutcome: vi.fn((input: { status: "completed" | "failed" }) => {
              lockOrder.push("target-cas");
              step = { ...step, status: input.status };
              return { outcome: "applied" as const, step };
            }),
          },
          chatDelegationRuns: {
            getForUpdate: vi.fn(() => {
              lockOrder.push("parent-run");
              return {
                runId: "run-lock-order",
                sessionId: "parent-lock-order",
                taskId: "task-lock-order",
                objective: "Serialize sibling approvals",
                roles: ["worker"],
                mode: "sequential",
                status: "running",
                citations: [],
                startedAt: "2026-04-11T00:00:00.000Z",
              };
            }),
            patch: vi.fn(),
          },
          chatTurnTraces: { listBySession: vi.fn(() => []) },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      createApprovalEffectDeps(),
    );

    await (
      service as unknown as {
        materializeDelegationParentsFromApprovedChild(input: {
          childTrace: ChatTurnTraceRecord;
          outputText: string;
          now: string;
          approvalId: string;
        }): Promise<unknown>;
      }
    ).materializeDelegationParentsFromApprovedChild({
      childTrace: createWaitingChildTrace("child-lock-order", "turn-lock-order"),
      outputText: "Approved output",
      now: "2026-04-11T00:00:02.000Z",
      approvalId: "approval-lock-order",
    });

    expect(lockOrder.slice(0, 3)).toEqual(["parent-run", "step-set", "target-cas"]);
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

  it("defers a remote-token follow-up until terminal keychain cleanup succeeds", async () => {
    const completeEffect = vi.fn();
    const deferEffectForRetry = vi.fn((_effectId, _workerId, _version, input) =>
      createEffect({
        status: "pending",
        result: input.result,
        lastError: input.lastError,
      }),
    );
    const deleteApprovalRemoteActionTokenSecretById = vi.fn(() => {
      throw new Error("keychain temporarily unavailable");
    });
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { failEffect: vi.fn(), completeEffect, deferEffectForRetry },
          approvalInbox: {
            get: vi.fn(),
            findByApprovalAndToken: vi.fn(() => undefined),
          },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        ...createApprovalEffectDeps(),
        approvalRemoteTokenSecrets: {
          reconcileExpired: vi.fn(),
          deleteById: deleteApprovalRemoteActionTokenSecretById,
        },
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
        targetId: "token-cleanup",
        status: "running",
        payload: { decision: "reject", approvalStatus: "rejected" },
      }),
    );

    expect(deleteApprovalRemoteActionTokenSecretById).toHaveBeenCalledWith("token-cleanup");
    expect(deferEffectForRetry).toHaveBeenCalledWith(
      "effect-1",
      expect.any(String),
      1,
      expect.objectContaining({
        lastError: "keychain temporarily unavailable",
        result: expect.objectContaining({
          deliveryState: "secret_cleanup_retry_scheduled",
          tokenId: "token-cleanup",
        }),
      }),
    );
    expect(completeEffect).not.toHaveBeenCalled();
  });

  it("falls back from stale inbox ids and reconciles pending inbox follow-up resolution", async () => {
    const completeEffect = vi.fn();
    const reconcileResolution = vi.fn(() => ({
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
            reconcileResolution,
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

    expect(reconcileResolution).toHaveBeenCalledWith(
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

  it("repairs same-terminal inbox approval metadata without rewriting terminal state", async () => {
    const completeEffect = vi.fn();
    const reconcileResolution = vi.fn(() => ({
      inboxItemId: "inbox-1",
      state: "expired",
      approvalStatus: "rejected",
      resolvedAt: "2026-04-11T00:00:30.000Z",
      resolvedBy: "system:approval-expiry",
    }));
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { failEffect: vi.fn(), completeEffect },
          approvalInbox: {
            get: vi.fn(() => ({
              inboxItemId: "inbox-1",
              state: "expired",
              approvalStatus: "pending",
              resolvedAt: "2026-04-11T00:00:30.000Z",
            })),
            findByApprovalAndToken: vi.fn(),
            reconcileResolution,
          },
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      createApprovalEffectDeps(),
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
          inboxState: "expired",
          decision: "reject",
          approvalStatus: "rejected",
          resolvedBy: "system:approval-expiry",
        },
      }),
    );

    expect(reconcileResolution).toHaveBeenCalledWith(
      "inbox-1",
      expect.objectContaining({
        state: "expired",
        approvalStatus: "rejected",
        resolvedBy: "system:approval-expiry",
      }),
    );
    expect(completeEffect).toHaveBeenCalledWith(
      "effect-1",
      expect.any(String),
      1,
      expect.objectContaining({
        result: expect.objectContaining({
          inboxItemId: "inbox-1",
          tokenId: "token-1",
          state: "expired",
        }),
      }),
    );
  });

  it("enqueues both approval.resolve.after and approval.response.after observer hooks", async () => {
    const enqueueAfterHooks = vi.fn();
    const completeEffect = vi.fn(() => ({ status: "completed" as const }));
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

  it("defers the approval hook effect when the second trigger cannot materialize", async () => {
    const effect = createEffect({
      effectKind: "approval_after_hooks",
      status: "running",
      attemptCount: 1,
    });
    const enqueueAfterHooks = vi.fn((input: { trigger: string }) => {
      if (input.trigger === "approval.response.after") {
        throw new Error("second trigger storage unavailable");
      }
    });
    const completeEffect = vi.fn();
    const deferEffectForRetry = vi.fn(() => ({ ...effect, status: "pending" as const }));
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { completeEffect, deferEffectForRetry, get: vi.fn() },
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
          runImmediateTransaction: <T>(work: () => T): T => work(),
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        ...createApprovalEffectDeps(),
        enqueueAfterHooks,
      },
    );

    await (
      service as unknown as {
        handleApprovalAfterHooks(current: ApprovalEffectRecord): Promise<void>;
      }
    ).handleApprovalAfterHooks(effect);

    expect(enqueueAfterHooks.mock.calls.map(([input]) => input.trigger)).toEqual([
      "approval.resolve.after",
      "approval.response.after",
    ]);
    expect(completeEffect).not.toHaveBeenCalled();
    expect(deferEffectForRetry).toHaveBeenCalledWith(
      effect.effectId,
      expect.any(String),
      effect.version,
      expect.objectContaining({
        lastError: "second trigger storage unavailable",
        result: expect.objectContaining({ signalKind: "approval_after_hooks" }),
      }),
    );
  });

  it("defers completion lease loss so takeover can replay idempotent hook owners", async () => {
    const effect = createEffect({
      effectKind: "approval_after_hooks",
      status: "running",
      attemptCount: 1,
    });
    const enqueueAfterHooks = vi.fn();
    const completeEffect = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ ...effect, status: "completed" as const });
    const deferEffectForRetry = vi.fn(() => ({ ...effect, status: "pending" as const }));
    const service = new ApprovalEffectsService(
      {
        storage: {
          approvalEffects: { completeEffect, deferEffectForRetry, get: vi.fn() },
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
          runImmediateTransaction: <T>(work: () => T): T => work(),
        },
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext,
      {
        ...createApprovalEffectDeps(),
        enqueueAfterHooks,
      },
    );
    const handle = (
      service as unknown as {
        handleApprovalAfterHooks(current: ApprovalEffectRecord): Promise<void>;
      }
    ).handleApprovalAfterHooks.bind(service);

    await handle(effect);
    expect(deferEffectForRetry).toHaveBeenCalledOnce();
    expect(enqueueAfterHooks).toHaveBeenCalledTimes(2);

    await handle(effect);
    expect(completeEffect).toHaveBeenCalledTimes(2);
    expect(enqueueAfterHooks).toHaveBeenCalledTimes(4);
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
            reconcileResolution: vi.fn(() => ({
              inboxItemId: "inbox-1",
              state: "rejected",
              approvalStatus: "rejected",
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

  it("enqueues and executes the approved external knowledge-snapshot recovery on the C2-deterministic effect identity", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    try {
      const { approval, payload } = createApprovedExternalKnowledgeSnapshotApproval(storage);
      const identities = deriveExternalSourceKnowledgeSnapshotMaterializedIdentities(payload);
      const executor = vi.fn(async () => buildExternalKnowledgeApplyResult(payload, identities));
      const backgroundTasks = new Set<Promise<void>>();
      const service = new ApprovalEffectsService(
        { storage: createSqliteAsyncStorage(storage), publishRealtime: vi.fn() } as unknown as ServiceContext,
        {
          ...createApprovalEffectDeps(),
          backgroundTasks,
          executeApprovedExternalSourceKnowledgeSnapshot: executor,
        },
      );

      const enqueued = await service.enqueueResolutionEffects(approval, {
        decision: "approve",
        resolvedBy: "operator-1",
      });
      const applyEffect = enqueued.find((effect) => effect.effectKind === "external_source_knowledge_snapshot_apply");
      expect(applyEffect).toMatchObject({
        approvalId: approval.approvalId,
        effectKind: "external_source_knowledge_snapshot_apply",
        targetKind: "external_source_import_item",
        targetId: identities.targetId,
        idempotencyKey: identities.effectIdempotencyKey,
        status: "pending",
      });
      // The stored payload bytes must equal canonicalJsonString of the C2
      // effect draft so the materialization's insert-site assert converges on
      // this exact row instead of conflicting.
      const storedPayloadJson = (
        storage.db
          .prepare("SELECT payload_json FROM approval_effects WHERE idempotency_key = ?")
          .get(identities.effectIdempotencyKey) as { payload_json: string }
      ).payload_json;
      expect(storedPayloadJson).toBe(
        canonicalJsonString({
          ...payload,
          linkId: identities.linkId,
          knowledgeDocumentId: identities.knowledgeDocumentId,
        }),
      );

      service.startWorker();
      await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce());
      await Promise.all([...backgroundTasks]);
      service.stopWorker();
      expect(executor).toHaveBeenCalledWith(
        { workspaceId: payload.workspaceId, approvalId: approval.approvalId },
        { actorId: "operator-1", source: "token" },
        expect.any(AbortSignal),
      );
      const settled = storage.approvalEffects.get(applyEffect!.effectId);
      expect(settled.status).toBe("completed");
      expect(settled.result).toMatchObject({
        disposition: "applied",
        linkId: identities.linkId,
        knowledgeDocumentId: identities.knowledgeDocumentId,
        chunkCount: 1,
        normalizedArtifactSha256: payload.normalizedArtifactSha256,
      });

      // A replayed resolution converges on the completed row: same effect id,
      // still completed, no second row, no re-execution.
      const replayed = await service.enqueueResolutionEffects(approval, {
        decision: "approve",
        resolvedBy: "operator-1",
      });
      const replayedApply = replayed.find((effect) => effect.effectKind === "external_source_knowledge_snapshot_apply");
      expect(replayedApply).toMatchObject({ effectId: applyEffect!.effectId, status: "completed" });
      const rowCount = storage.db
        .prepare("SELECT COUNT(*) AS count FROM approval_effects WHERE effect_kind = ?")
        .get("external_source_knowledge_snapshot_apply") as { count: number };
      expect(Number(rowCount.count)).toBe(1);
      service.startWorker();
      await Promise.all([...backgroundTasks]);
      service.stopWorker();
      expect(executor).toHaveBeenCalledOnce();
    } finally {
      storage.close();
    }
  });

  it("fails terminal governance denials closed and defers a live policy denial for bounded retry", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    try {
      const { approval } = createApprovedExternalKnowledgeSnapshotApproval(storage);
      // Expiry (and every other governance denial except policy) is terminal.
      const executor = vi.fn(async () => {
        throw new ExternalSourceKnowledgeEffectServiceError("approval_expired");
      });
      const backgroundTasks = new Set<Promise<void>>();
      const service = new ApprovalEffectsService(
        { storage: createSqliteAsyncStorage(storage), publishRealtime: vi.fn() } as unknown as ServiceContext,
        {
          ...createApprovalEffectDeps(),
          backgroundTasks,
          executeApprovedExternalSourceKnowledgeSnapshot: executor,
        },
      );
      const enqueued = await service.enqueueResolutionEffects(approval, {
        decision: "approve",
        resolvedBy: "operator-1",
      });
      const applyEffect = enqueued.find((effect) => effect.effectKind === "external_source_knowledge_snapshot_apply");
      service.startWorker();
      await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce());
      await Promise.all([...backgroundTasks]);
      service.stopWorker();
      const settled = storage.approvalEffects.get(applyEffect!.effectId);
      expect(settled.status).toBe("failed");
      expect(settled.result).toMatchObject({ errorCode: "approval_expired" });
    } finally {
      storage.close();
    }
  });

  it("defers the external knowledge-snapshot effect for retry while deny-wins policy denies it", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    try {
      const { approval } = createApprovedExternalKnowledgeSnapshotApproval(storage);
      // The C2 design explicitly supports deny-now/re-allow-later, so a policy
      // denial keeps the effect retryable; the approval's own expiry bounds
      // the retry window with a terminal approval_expired failure.
      const executor = vi.fn(async () => {
        throw new ExternalSourceKnowledgeEffectServiceError("policy_denied", "ward_deny");
      });
      const backgroundTasks = new Set<Promise<void>>();
      const service = new ApprovalEffectsService(
        { storage: createSqliteAsyncStorage(storage), publishRealtime: vi.fn() } as unknown as ServiceContext,
        {
          ...createApprovalEffectDeps(),
          backgroundTasks,
          executeApprovedExternalSourceKnowledgeSnapshot: executor,
        },
      );
      const enqueued = await service.enqueueResolutionEffects(approval, {
        decision: "approve",
        resolvedBy: "operator-1",
      });
      const applyEffect = enqueued.find((effect) => effect.effectKind === "external_source_knowledge_snapshot_apply");
      service.startWorker();
      await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce());
      await Promise.all([...backgroundTasks]);
      service.stopWorker();
      const settled = storage.approvalEffects.get(applyEffect!.effectId);
      // Deferred-for-retry: the row keeps its lease until the retry instant
      // and is re-claimable afterwards — it is neither completed nor failed.
      expect(settled.status).toBe("running");
      expect(settled.completedAt).toBeUndefined();
      expect(settled.leaseExpiresAt).toBeTruthy();
      expect(settled.result).toMatchObject({
        deliveryState: "retry_scheduled",
        errorCode: "policy_denied",
        reasonCode: "ward_deny",
        delivered: false,
      });
    } finally {
      storage.close();
    }
  });

  it("enqueues no external knowledge-snapshot effect for a rejected approval", async () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    try {
      const { approvalId } = createExternalKnowledgeSnapshotApprovalRow(storage);
      const rejected = storage.approvals.resolve(approvalId, { decision: "reject", resolvedBy: "operator-1" });
      const service = new ApprovalEffectsService(
        { storage: createSqliteAsyncStorage(storage), publishRealtime: vi.fn() } as unknown as ServiceContext,
        createApprovalEffectDeps(),
      );
      const enqueued = await service.enqueueResolutionEffects(rejected, {
        decision: "reject",
        resolvedBy: "operator-1",
      });
      expect(enqueued.some((effect) => effect.effectKind === "external_source_knowledge_snapshot_apply")).toBe(false);
      const rowCount = storage.db
        .prepare("SELECT COUNT(*) AS count FROM approval_effects WHERE effect_kind = ?")
        .get("external_source_knowledge_snapshot_apply") as { count: number };
      expect(Number(rowCount.count)).toBe(0);
    } finally {
      storage.close();
    }
  });
});

function buildExternalKnowledgeSnapshotPayload() {
  return {
    workspaceId: "default",
    sourceId: "source-1",
    importId: "import-1",
    itemId: "item-1",
    normalizedArtifactSha256: "a".repeat(64),
    rawSha256: "b".repeat(64),
    sessionId: "session-1",
    sessionIncarnationId: "legacy-session-incarnation:session-1",
    attachmentId: "external-attachment-1",
    attachmentRevision: 1,
  };
}

function createExternalKnowledgeSnapshotApprovalRow(storage: Storage) {
  const payload = buildExternalKnowledgeSnapshotPayload();
  const approvalId = deriveExternalSourceKnowledgeSnapshotApprovalId(payload);
  storage.approvals.createDeterministicDetachedWithTtlDuration(
    {
      approvalId,
      kind: "external_source.knowledge_snapshot",
      riskLevel: "danger",
      payload: { ...payload },
      preview: { importId: payload.importId, itemId: payload.itemId },
      linkage: {
        workspaceId: payload.workspaceId,
        sessionId: payload.sessionId,
        operatorId: "operator-1",
        authActorId: "operator-1",
        authActorSource: "token",
      },
    },
    24 * 60 * 60 * 1000,
  );
  return { approvalId, payload };
}

function createApprovedExternalKnowledgeSnapshotApproval(storage: Storage) {
  const { approvalId, payload } = createExternalKnowledgeSnapshotApprovalRow(storage);
  const approval = storage.approvals.resolve(approvalId, { decision: "approve", resolvedBy: "operator-1" });
  return { approval, payload };
}

function buildExternalKnowledgeApplyResult(
  payload: ReturnType<typeof buildExternalKnowledgeSnapshotPayload>,
  identities: ReturnType<typeof deriveExternalSourceKnowledgeSnapshotMaterializedIdentities>,
) {
  return {
    schemaVersion: "goatcitadel.external-source.v1" as const,
    disposition: "created" as const,
    link: {
      schemaVersion: "goatcitadel.external-source.v1" as const,
      linkId: identities.linkId,
      workspaceId: payload.workspaceId,
      sourceId: payload.sourceId,
      importId: payload.importId,
      itemId: payload.itemId,
      normalizedArtifactSha256: payload.normalizedArtifactSha256,
      approvalId: identities.approvalId,
      knowledgeDocumentId: identities.knowledgeDocumentId,
      provenanceSha256: "c".repeat(64),
      createdAt: "2026-07-14T08:09:00.000Z",
    },
    knowledgeDocumentId: identities.knowledgeDocumentId,
    chunkCount: 1,
  };
}

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

function createExactWaitingApprovalFixture(input: {
  runId: string;
  sessionId: string;
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  now: string;
}) {
  const request = { content: `Approval test ${input.turnId}` };
  const requestActor = { actorKind: "operator" as const, actorId: "operator:test" };
  const admissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(request);
  const admission = {
    admissionId: `admission:${input.runId}`,
    admissionKind: "turn_write",
    sessionIncarnationId: `incarnation:${input.sessionId}`,
    workspaceId: "default",
    sessionId: input.sessionId,
    turnId: input.turnId,
    materialSha256: admissionMaterialSha256,
    aggregateRevision: 1,
    controllerGeneration: 1,
    actorKind: requestActor.actorKind,
    actorId: requestActor.actorId,
  };
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId: admission.admissionId,
    sessionIncarnationId: admission.sessionIncarnationId,
    admissionMaterialSha256,
    workspaceId: admission.workspaceId,
    admissionAggregateRevision: admission.aggregateRevision,
    admissionControllerGeneration: admission.controllerGeneration,
    effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(admissionMaterialSha256, request),
    requestActor,
    sessionId: input.sessionId,
    turnId: input.turnId,
    userMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    request,
  };
  const generationId = `waiting-generation:${input.runId}`;
  const waitForEvent = { eventKey: "approval.resolved", correlationId: `approval:${input.turnId}` };
  const authority = buildChatTurnRuntimeAuthoritySeal({
    runId: input.runId,
    turnId: input.turnId,
    transitionKind: "waiting",
    durableStatus: "waiting",
    traceStatus: "waiting_for_approval",
    transitionAt: input.now,
    postCommitGenerationId: generationId,
    postCommitEligibility: APPROVAL_TEST_POST_COMMIT_ELIGIBILITY,
    waitForEvent,
    requiredFinalizers: ["general"],
  });
  const metadata = withChatTurnRuntimeAuthority(
    markGeneralChatPostCommitPending(
      { retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT }, waitForEvent },
      input.now,
      "waiting_for_approval",
      APPROVAL_TEST_POST_COMMIT_ELIGIBILITY,
      generationId,
    ),
    authority,
  );
  return {
    admission,
    run: {
      runId: input.runId,
      workflowKey: "chat.turn.execute",
      status: "waiting",
      version: 1,
      attempt: 0,
      maxAttempts: DURABLE_RETRY_POLICY_DEFAULT.maxAttempts,
      payload,
      metadata,
      createdAt: input.now,
      updatedAt: input.now,
    } as Record<string, unknown> & { runId: string },
    checkpoint: {
      checkpointId: `checkpoint:${input.runId}:waiting`,
      runId: input.runId,
      checkpointKind: "run_waiting",
      state: withChatTurnRuntimeAuthorityCheckpoint({ waitForEvent }, authority),
      createdAt: input.now,
    },
  };
}

function createExactWaitingApprovalRun(
  storage: Storage,
  input: {
    runId: string;
    sessionId: string;
    turnId: string;
    userMessageId: string;
    assistantMessageId?: string;
    now: string;
  },
) {
  const assistantMessageId = input.assistantMessageId ?? `assistant-approved-${input.turnId}`;
  const request = { content: `Approval test ${input.turnId}` };
  const requestActor = { actorKind: "operator" as const, actorId: "operator:test" };
  const lifecycle = storage.chatSessionLifecycles.ensureActive({
    workspaceId: "default",
    sessionId: input.sessionId,
    actorId: requestActor.actorId,
    idempotencyKey: `lifecycle:${input.sessionId}`,
    correlationId: `lifecycle:${input.sessionId}`,
    metadataTimestamp: input.now,
  });
  const admissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(request);
  const admission = storage.sessionMutationAdmissions.admit({
    workspaceId: "default",
    sessionId: input.sessionId,
    expectedSessionIncarnationId: lifecycle.intent.sessionIncarnationId,
    turnId: input.turnId,
    runtimeOwnerId: `approval-test:${input.runId}`,
    admissionKind: "turn_write",
    aggregateRevision: 1,
    controllerGeneration: lifecycle.generation,
    actorKind: requestActor.actorKind,
    actorId: requestActor.actorId,
    operation: "chat_send",
    materialSha256: admissionMaterialSha256,
    idempotencyKey: `admission:${input.runId}`,
    correlationId: `admission:${input.runId}`,
  }).admission;
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId: admission.admissionId,
    sessionIncarnationId: admission.sessionIncarnationId,
    admissionMaterialSha256,
    workspaceId: admission.workspaceId,
    admissionAggregateRevision: admission.aggregateRevision,
    admissionControllerGeneration: admission.controllerGeneration,
    effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(admissionMaterialSha256, request),
    requestActor,
    sessionId: input.sessionId,
    turnId: input.turnId,
    userMessageId: input.userMessageId,
    assistantMessageId,
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    request,
  };
  const generationId = `waiting-generation:${input.runId}`;
  const waitForEvent = { eventKey: "approval.resolved", correlationId: `approval:${input.turnId}` };
  const authority = buildChatTurnRuntimeAuthoritySeal({
    runId: input.runId,
    turnId: input.turnId,
    transitionKind: "waiting",
    durableStatus: "waiting",
    traceStatus: "waiting_for_approval",
    transitionAt: input.now,
    postCommitGenerationId: generationId,
    postCommitEligibility: APPROVAL_TEST_POST_COMMIT_ELIGIBILITY,
    waitForEvent,
    requiredFinalizers: ["general"],
  });
  const pendingMetadata = markGeneralChatPostCommitPending(
    { retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT }, waitForEvent },
    input.now,
    "waiting_for_approval",
    APPROVAL_TEST_POST_COMMIT_ELIGIBILITY,
    generationId,
  );
  const run = storage.durableRuns.createRun({
    runId: input.runId,
    workflowKey: "chat.turn.execute",
    status: "waiting",
    maxAttempts: DURABLE_RETRY_POLICY_DEFAULT.maxAttempts,
    payload,
    metadata: withChatTurnRuntimeAuthority(pendingMetadata, authority),
    now: input.now,
  });
  storage.durableRuns.createCheckpoint({
    runId: input.runId,
    checkpointKind: "run_waiting",
    state: withChatTurnRuntimeAuthorityCheckpoint({ waitForEvent }, authority),
    createdAt: input.now,
  });
  return run;
}

function createApprovalEffectDeps() {
  return {
    backgroundTasks: new Set<Promise<void>>(),
    wakeDurableRun: vi.fn(),
    requestRunProcessing: vi.fn(),
    findProactiveDurableRunIdsForApproval: vi.fn(() => []),
    executeCodeModePendingApproval: vi.fn(),
    executeApprovedPendingAction: vi.fn(),
    enqueueAfterHooks: vi.fn(),
    resolveApprovalHookWorkspaceId: vi.fn(() => "workspace-1"),
    resolvePostCommitEligibility: vi.fn(() => APPROVAL_TEST_POST_COMMIT_ELIGIBILITY),
    recordApprovalResolutionSignals: vi.fn(),
  };
}

function createWaitingChildTrace(sessionId: string, turnId: string): ChatTurnTraceRecord {
  return {
    turnId,
    sessionId,
    userMessageId: `user-${turnId}`,
    branchKind: "append",
    status: "waiting_for_approval",
    mode: "chat",
    webMode: "auto",
    memoryMode: "off",
    thinkingLevel: "standard",
    startedAt: "2026-04-11T00:00:00.000Z",
    toolRuns: [],
    citations: [],
  };
}

function createObservabilityEnvelope(
  input: Pick<ApprovalObservabilityEnvelope, "deliveryId" | "operationId" | "delivery"> &
    Partial<ApprovalObservabilityEnvelope>,
): Record<string, unknown> {
  return {
    schemaVersion: "approval_observability.v1",
    occurredAt: "2026-07-10T10:00:00.000Z",
    orderIndex: 1,
    attribution: { actorId: "operator-1", traceId: "trace-1" },
    ...input,
  };
}

function claimEffectForService(service: ApprovalEffectsService, effect: ApprovalEffectRecord): ApprovalEffectRecord {
  const worker = service as unknown as { workerId: string; observabilityWorkerId: string };
  return {
    ...effect,
    claimedBy: effect.effectKind === "approval_observability" ? worker.observabilityWorkerId : worker.workerId,
  };
}
