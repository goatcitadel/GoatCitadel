import type {
  ApprovalEffectRecord,
  ApprovalObservabilityEnvelope,
  ApprovalRequest,
  ChatDelegationStepRecord,
  ChatTurnTraceRecord,
  DurableWakeResult,
} from "@goatcitadel/contracts";
import { getRequestAttribution, runWithRequestAttribution } from "@goatcitadel/storage";
import { describe, expect, it, vi } from "vitest";
import {
  ApprovalEffectsService,
  deriveApprovalResolutionEffectsResult,
} from "./approval-resolution-effects-service.js";
import { APPROVAL_OBSERVABILITY_REALTIME_ENVELOPE_KEY } from "./realtime-event-service.js";
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

  it("captures attribution and delegates observability allocation to the atomic repository batch", () => {
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

    const [first] = runWithRequestAttribution({ actorId: "operator-first", traceId: "trace-first" }, () =>
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
    const [duplicate] = runWithRequestAttribution({ actorId: "operator-retry", traceId: "trace-retry" }, () =>
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

    service.enqueueObservabilityEffects("approval-ordered", [
      {
        operationId: "approval.create.audit",
        delivery: { kind: "audit", stream: "approvals", payload: { event: "approval.create" } },
      },
      {
        operationId: "approval.create.realtime",
        delivery: { kind: "realtime", eventType: "approval_created", source: "approvals", payload: {} },
      },
    ]);
    service.enqueueObservabilityEffects("approval-ordered", [
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
      "approval_resolution_signals",
      "pending_action_execute",
      "approval_wait_wake",
      "proactive_run_wake",
      "linked_chat_turn_wake",
      "approval_inbox_follow_up",
      "approval_after_hooks",
    ]);
  });

  it("enqueues an expired inbox follow-up for every remote token bound to the approval", () => {
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

    service.enqueueResolutionEffects(
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
      "approval_resolution_signals",
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
        result: expect.objectContaining({
          actionType: "tool.invoke",
          resolutionStatus: "executed",
        }),
      }),
    );
  });

  it("retries Chat materialization from the stored executed result without re-firing the action", async () => {
    const effect = createEffect({
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "approval-1",
    });
    const completeEffect = vi.fn();
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
          ): void;
        },
        "materializeExecutedChatApproval",
      )
      .mockImplementationOnce(() => {
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

    materialize.mockImplementation(() => undefined);
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
      expect.objectContaining({
        result: expect.objectContaining({
          resolutionStatus: "executed",
          result: pendingAction.result,
        }),
      }),
    );
  });

  it("does not seize a running durable run during approval materialization", () => {
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

    expect(() =>
      (
        service as unknown as {
          completeDurableRunIfPresent(
            runId: string,
            input: { now: string; outputText: string; checkpointState: Record<string, unknown> },
          ): void;
        }
      ).completeDurableRunIfPresent("durable-cancel-race", {
        now: "2026-04-11T00:00:00.000Z",
        outputText: "done",
        checkpointState: { status: "completed" },
      }),
    ).not.toThrow();
    expect(updateRun).not.toHaveBeenCalled();
    expect(createCheckpoint).not.toHaveBeenCalled();
  });

  it("records the run_completed timeline inside approval materialization completion", () => {
    let durableRun = {
      runId: "durable-waiting",
      status: "waiting" as const,
      version: 4,
      metadata: {},
    };
    const updateRun = vi.fn((input: Record<string, unknown>) => {
      durableRun = { ...durableRun, ...input, status: "completed", version: 5 } as typeof durableRun;
      return durableRun;
    });
    const createCheckpoint = vi.fn();
    const recordDurableTimelineEvent = vi.fn();
    const runImmediateTransaction = vi.fn(<T>(work: () => T): T => work());
    const service = new ApprovalEffectsService(
      {
        storage: {
          durableRuns: {
            getRun: vi.fn(() => durableRun),
            updateRun,
            createCheckpoint,
          },
          runImmediateTransaction,
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
        recordDurableTimelineEvent,
      },
    );

    const result = (
      service as unknown as {
        completeDurableRunIfPresent(
          runId: string,
          input: { now: string; outputText: string; checkpointState: Record<string, unknown> },
        ): string | undefined;
      }
    ).completeDurableRunIfPresent("durable-waiting", {
      now: "2026-04-11T00:00:00.000Z",
      outputText: "approved output",
      checkpointState: { status: "completed", approvalId: "approval-1" },
    });

    expect(result).toBe("completed");
    expect(runImmediateTransaction).toHaveBeenCalledTimes(1);
    expect(createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "durable-waiting", checkpointKind: "run_completed" }),
    );
    expect(recordDurableTimelineEvent).toHaveBeenCalledWith("durable-waiting", "run_completed", {
      status: "completed",
      approvalId: "approval-1",
    });
  });

  it("leaves running Chat and delegation truth untouched until the durable run parks", () => {
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

    expect(() =>
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
          ): void;
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
    ).not.toThrow();

    expect(updateRun).not.toHaveBeenCalled();
    expect(trace.status).toBe("waiting_for_approval");
    expect(trace.durable?.status).toBe("running");
    expect(chatMessagesUpsert).not.toHaveBeenCalled();
    expect(chatTurnTracesPatch).not.toHaveBeenCalled();
    expect(delegationParents).not.toHaveBeenCalled();
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
    const publishRealtime = vi.fn();
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
    recordApprovalResolutionSignals: vi.fn(),
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
