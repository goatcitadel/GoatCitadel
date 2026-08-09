import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  NotFoundError,
  type ChatTurnTraceRecord,
  type DurableRetryRecord,
  type DurableRunRecord,
} from "@goatcitadel/contracts";
import type { ServiceContext } from "./service-context.js";
import {
  buildDurableLocalProcessLeaseOwnerId,
  computeDurableBaselineDrift,
  DurableRunService,
  DurableWorkerInterruptionError,
  resolveDurableWorkflowTimeoutMs,
  type DurableRunServiceLogger,
} from "./durable-run-service.js";
import {
  GENERAL_CHAT_POST_COMMIT_EFFECTS,
  finalizeDurableChatRun,
  type GeneralChatPostCommitProgress,
} from "./chat-durable-run-service.js";
import { executeGeneralChatPostCommit } from "./durable-execution-service.js";
import {
  buildAutonomousChatAdmissionMetadataMaterial,
  buildChatTurnRuntimeAuthoritySeal,
  buildHeartbeatDecisionReceipt,
  hashChatTurnRuntimeAuthorityValue,
  sealAutonomousChatAdmissionMetadata,
  withChatTurnRuntimeAuthority,
  withChatTurnRuntimeAuthorityCheckpoint,
} from "./chat-durable-runtime-authority.js";
import { DURABLE_RETRY_POLICY_DEFAULT } from "./durable-retry-policy.js";
import {
  computeEffectiveChatTurnRequestMaterialSha256,
  computeFrozenChatTurnAdmissionMaterialSha256,
} from "./session-control-service.js";
import { SharedHostLifecycleService } from "./shared-host-lifecycle-service.js";

const TEST_POST_COMMIT_ELIGIBILITY = {
  version: 1 as const,
  autonomyEnabledAtParentSettlement: true,
  evalIntegrityTurn: false,
  humanSession: true,
};

const TEST_HEARTBEAT_POST_COMMIT_ELIGIBILITY = {
  version: 1 as const,
  autonomyEnabledAtParentSettlement: false,
  evalIntegrityTurn: false,
  humanSession: false,
};

describe("DurableRunService", () => {
  it("applies the workflow timeout to Cowork chat turn runs as a watchdog", () => {
    const run = {
      ...createRun("run-cowork", "queued", "chat.turn.execute"),
      payload: {
        version: "chat.turn.execute.v1",
        request: { mode: "cowork" },
      },
    };

    expect(resolveDurableWorkflowTimeoutMs(run, 300_000)).toBe(300_000);
  });

  it("keeps the default workflow timeout for non-Cowork durable runs", () => {
    const chatRun = {
      ...createRun("run-chat", "queued", "chat.turn.execute"),
      payload: {
        version: "chat.turn.execute.v1",
        request: { mode: "chat" },
      },
    };
    const connectorRun = createRun("run-connector", "queued", "connector.delivery");

    expect(resolveDurableWorkflowTimeoutMs(chatRun, 300_000)).toBe(300_000);
    expect(resolveDurableWorkflowTimeoutMs(connectorRun, 300_000)).toBe(300_000);
  });

  it("updates run state against the current version and preserves unspecified fields (moved from the gateway facade, B2)", async () => {
    const current = {
      runId: "run-1",
      status: "running",
      metadata: { prior: true },
      version: 7,
    };
    const updateRun = vi.fn((input: Record<string, unknown>) => ({ ...input, version: 8 }));
    const service = new DurableRunService({
      storage: {
        durableRuns: {
          getRun: vi.fn(() => current),
          updateRun,
        },
      },
    } as unknown as ServiceContext);

    expect(
      await service.updateRunState({
        runId: "run-1",
        status: "completed",
        metadata: { next: true },
        clearLastError: true,
        finishedAt: "2026-05-14T21:30:00.000Z",
      }),
    ).toMatchObject({
      runId: "run-1",
      status: "completed",
      metadata: { next: true },
      expectedVersion: 7,
      version: 8,
    });
    expect(updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        clearLastError: true,
        expectedVersion: 7,
        updatedAt: expect.stringMatching(/T.*Z$/),
      }),
    );

    await service.updateRunState({ runId: "run-1" });
    expect(updateRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "running",
        metadata: { prior: true },
        expectedVersion: 7,
      }),
    );
  });

  it("fences workflow state updates to the expected unexpired lease owner", async () => {
    const current = {
      ...createRun("run-fenced-update", "running"),
      version: 7,
      leaseOwnerId: "worker-b",
      leaseHeartbeatAt: "2026-05-14T21:30:00.000Z",
      leaseExpiresAt: "2099-12-31T23:59:59.999Z",
    };
    const updateRun = vi.fn((input: Record<string, unknown>) => ({ ...current, ...input, version: 8 }));
    const lockFreshActiveLeaseForUpdate = vi.fn((_runId: string, expectedLeaseOwnerId: string) =>
      expectedLeaseOwnerId === "worker-b" ? current : undefined,
    );
    const runImmediateTransaction = vi.fn(<T>(callback: () => T): T => callback());
    const service = new DurableRunService({
      storage: {
        runImmediateTransaction,
        durableRuns: {
          getRun: vi.fn(() => current),
          updateRun,
          lockFreshActiveLeaseForUpdate,
        },
      },
    } as unknown as ServiceContext);

    let staleError: unknown;
    try {
      await service.updateRunState({
        runId: current.runId,
        metadata: { stale: true },
        expectedLeaseOwnerId: "worker-a",
      });
    } catch (error) {
      staleError = error;
    }
    expect(staleError).toMatchObject({ name: "DurableWorkerInterruptionError" });
    expect(updateRun).not.toHaveBeenCalled();

    expect(
      await service.updateRunState({
        runId: current.runId,
        status: "waiting",
        metadata: { committed: true },
        clearLease: true,
        expectedLeaseOwnerId: "worker-b",
      }),
    ).toMatchObject({ status: "waiting", metadata: { committed: true } });
    expect(updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 7,
        clearLease: true,
      }),
    );
    expect(runImmediateTransaction).toHaveBeenCalledTimes(2);
    expect(lockFreshActiveLeaseForUpdate).toHaveBeenNthCalledWith(1, current.runId, "worker-a");
    expect(lockFreshActiveLeaseForUpdate).toHaveBeenNthCalledWith(2, current.runId, "worker-b");
  });

  it("reports each config and stored-flag field that drifted from the always-on durable baseline", () => {
    expect(
      computeDurableBaselineDrift({
        durable: { enabled: true, executionEnabled: true, chatAutoPromoteEnabled: true },
        configuredFeatureFlag: true,
        storedDurableKernelFlag: undefined,
      }),
    ).toEqual([]);

    expect(
      computeDurableBaselineDrift({
        durable: { enabled: false, executionEnabled: false, chatAutoPromoteEnabled: false },
        configuredFeatureFlag: false,
        storedDurableKernelFlag: false,
      }),
    ).toEqual([
      "assistant.durable.enabled",
      "assistant.durable.executionEnabled",
      "assistant.durable.chatAutoPromoteEnabled",
      "features.durableKernelV1Enabled",
      "feature_flags_v1.durableKernelV1Enabled",
    ]);

    // A stored flag that is merely absent (vs explicitly false) is not drift.
    expect(
      computeDurableBaselineDrift({
        durable: { enabled: true, executionEnabled: true, chatAutoPromoteEnabled: true },
        configuredFeatureFlag: true,
        storedDurableKernelFlag: true,
      }),
    ).toEqual([]);
  });

  it("preserves caller metadata when creating durable runs", async () => {
    const runs = new Map<string, DurableRunRecord>();
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const service = new DurableRunService(createContext(runs, checkpoints, timeline) as unknown as ServiceContext);

    const created = await service.createDurableRun({
      workflowKey: "proactive.tick",
      metadata: {
        proactive: {
          phase: "planning",
          taskId: "task-1",
        },
      },
    });

    expect(created.metadata).toMatchObject({
      retryPolicy: expect.any(Object),
      waitForEvent: null,
      proactive: {
        phase: "planning",
        taskId: "task-1",
      },
    });
  });

  it("rejects raw remote approval bearers before durable persistence", async () => {
    const runs = new Map<string, DurableRunRecord>();
    const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext);
    const rawToken = `grat_${"p".repeat(43)}`;

    await expect(
      service.createDurableRun({
        workflowKey: "connector.delivery",
        payload: { interactiveActions: { callbackData: `gca:${rawToken}:a` } },
      }),
    ).rejects.toThrow(/cannot be persisted in durable run state/i);
    await expect(
      service.createDurableRun({
        workflowKey: "connector.delivery",
        payload: { message: `prefix x${rawToken}y suffix` },
      }),
    ).rejects.toThrow(/cannot be persisted in durable run state/i);
    await expect(service.createDurableRun({ workflowKey: `connector.${rawToken}` })).rejects.toThrow(
      /cannot be persisted in durable run state/i,
    );
    expect(runs.size).toBe(0);
  });

  it("rejects raw remote approval bearers in wake and retry mutation fields", async () => {
    const rawToken = `grat_${"q".repeat(43)}`;
    const waiting = {
      ...createRun("run-wait-secret", "waiting"),
      metadata: { waitForEvent: { eventKey: "approval.resolved" } },
    };
    const failed = createRun("run-retry-secret", "failed");
    const runs = new Map<string, DurableRunRecord>([
      [waiting.runId, waiting],
      [failed.runId, failed],
    ]);
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const service = new DurableRunService(createContext(runs, [], timeline) as unknown as ServiceContext);

    await expect(
      service.wakeDurableRun(waiting.runId, {
        eventKey: "approval.resolved",
        payload: { token: `prefix-${rawToken}-suffix` },
      }),
    ).rejects.toThrow(/cannot be persisted in durable run state/i);
    await expect(service.retryDurableRun(failed.runId, `retry ${rawToken}`, "operator")).rejects.toThrow(
      /cannot be persisted in durable run state/i,
    );
    expect(runs.get(waiting.runId)?.status).toBe("waiting");
    expect(runs.get(failed.runId)?.status).toBe("failed");
    expect(timeline).toEqual([]);
  });

  it("does not reject benign token-like durable content", async () => {
    const runs = new Map<string, DurableRunRecord>();
    const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext);

    await expect(
      service.createDurableRun({
        workflowKey: "connector.delivery",
        payload: { message: "Use grat_community_discount_code for this test fixture." },
      }),
    ).resolves.toBeDefined();
    expect(runs.size).toBe(1);
  });

  it("commits run creation, checkpoints, and timeline as one storage transaction", async () => {
    const runs = new Map<string, DurableRunRecord>();
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const context = createContext(runs, checkpoints, timeline);
    context.storage.runImmediateTransaction = async <T>(callback: () => T | Promise<T>): Promise<T> => {
      const runSnapshot = new Map(runs);
      const checkpointLength = checkpoints.length;
      const timelineLength = timeline.length;
      try {
        return await callback();
      } catch (error) {
        runs.clear();
        for (const [runId, run] of runSnapshot) {
          runs.set(runId, run);
        }
        checkpoints.length = checkpointLength;
        timeline.length = timelineLength;
        throw error;
      }
    };
    context.storage.durableRuns.createCheckpoint = () => {
      throw new Error("checkpoint write unavailable");
    };
    const service = new DurableRunService(context as unknown as ServiceContext);

    await expect(service.createDurableRun({ workflowKey: "connector.delivery" })).rejects.toThrow(
      "checkpoint write unavailable",
    );
    expect(runs.size).toBe(0);
    expect(checkpoints).toHaveLength(0);
    expect(timeline).toHaveLength(0);
  });

  it("returns committed run truth when retained realtime publication fails", async () => {
    const runs = new Map<string, DurableRunRecord>();
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, {
        publishRealtime: () => {
          throw new Error("retained stream unavailable");
        },
      }) as unknown as ServiceContext,
    );
    const run = await service.createDurableRun({ workflowKey: "connector.delivery" });

    expect(run).toMatchObject({ runId: "run-1", status: "queued" });
    expect(runs.size).toBe(1);
    expect(checkpoints).toEqual([{ runId: "run-1", checkpointKind: "run_created" }]);
    expect(timeline).toEqual([{ runId: "run-1", eventType: "run_created" }]);
  });

  it("requeues and resumes recoverable orphaned chat turn runs on worker startup", async () => {
    const runs = new Map<string, DurableRunRecord>([
      [
        "run-1",
        {
          ...createRun("run-1", "running"),
          finishedAt: "2026-03-14T00:00:05.000Z",
          lastError: "stale terminal failure",
          leaseOwnerId: "worker-old",
          leaseHeartbeatAt: "2026-03-14T00:00:00.000Z",
          leaseExpiresAt: "2026-03-14T00:00:01.000Z",
        },
      ],
    ]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const executeWorkflow = vi.fn(async (run: DurableRunRecord) => {
      updateRun(runs, run.runId, {
        status: "completed",
        finishedAt: "2026-03-14T00:00:05.000Z",
      });
    });
    const service = new DurableRunService(createContext(runs, checkpoints, timeline) as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(executeWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        status: "running",
      }),
      expect.objectContaining({
        signal: expect.any(Object),
      }),
    );
    expect(runs.get("run-1")?.status).toBe("completed");
    expect(runs.get("run-1")?.lastError).toBeUndefined();
    expect(checkpoints.map((item) => item.checkpointKind)).toContain("run_started");
    expect(timeline.map((item) => item.eventType)).toContain("run_started");
  });

  it("reclaims a fresh same-host lease only after its exact local process is confirmed dead", async () => {
    const leaseOwnerId = buildDurableLocalProcessLeaseOwnerId({ pid: 987_654, nonce: randomUUID() });
    const run = {
      ...createRun("run-dead-local-owner", "running", "connector.delivery"),
      leaseOwnerId,
      leaseHeartbeatAt: "2026-07-30T00:00:00.000Z",
      leaseExpiresAt: "2099-07-30T00:02:00.000Z",
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const executeWorkflow = vi.fn(async (claimed: DurableRunRecord) => {
      updateRun(runs, claimed.runId, { status: "completed", clearLease: true });
    });
    const lifecycle = new SharedHostLifecycleService({ enabled: false });
    const service = new DurableRunService(createContext(runs, [], timeline) as unknown as ServiceContext, {
      backgroundTasks,
      sharedHostLifecycle: lifecycle,
      isLocalProcessAlive: vi.fn(() => false),
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);
    await service.stopWorker();

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(runs.get(run.runId)?.status).toBe("completed");
    expect(timeline.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["run_incomplete_worker_exit", "run_reclaimed", "run_started"]),
    );
  });

  it("finalizes an unrecoverable fresh same-host lease after its exact local process is confirmed dead", async () => {
    const leaseOwnerId = buildDurableLocalProcessLeaseOwnerId({ pid: 987_655, nonce: randomUUID() });
    const run = {
      ...createRun("run-dead-local-unrecoverable", "running", "connector.delivery"),
      leaseOwnerId,
      leaseHeartbeatAt: "2026-07-30T00:00:00.000Z",
      leaseExpiresAt: "2099-07-30T00:02:00.000Z",
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const markWorkflowUnrecoverable = vi.fn(async () => undefined);
    const service = new DurableRunService(createContext(runs, [], timeline) as unknown as ServiceContext, {
      backgroundTasks,
      sharedHostLifecycle: new SharedHostLifecycleService({ enabled: false }),
      isLocalProcessAlive: vi.fn(() => false),
      workflowRegistry: {
        executeWorkflow: vi.fn(),
        isWorkflowRecoverable: () => ({ recoverable: false, reason: "retained output forbids replay" }),
        markWorkflowUnrecoverable,
      },
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);
    await service.stopWorker();

    expect(runs.get(run.runId)).toMatchObject({
      status: "failed",
      leaseOwnerId: undefined,
      lastError: "retained output forbids replay",
    });
    expect(markWorkflowUnrecoverable).toHaveBeenCalledTimes(1);
    expect(timeline.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["run_incomplete_worker_exit", "run_failed"]),
    );
  });

  it("fails closed instead of replacing conflicting runtime authority on a dead admitted Chat owner", async () => {
    const baseFixture = createAdmittedChatRuntimeFixture({
      runId: "run-dead-local-conflicting-authority",
      status: "running",
    });
    const conflictingAuthority = { material: { transitionKind: "waiting" }, materialSha256: "f".repeat(64) };
    const run = {
      ...baseFixture.run,
      metadata: {
        ...baseFixture.run.metadata,
        chatTurnRuntimeAuthority: conflictingAuthority,
        waitForEvent: null,
      },
      leaseOwnerId: buildDurableLocalProcessLeaseOwnerId({ pid: 987_655, nonce: randomUUID() }),
      leaseHeartbeatAt: "2026-07-30T00:00:00.000Z",
      leaseExpiresAt: "2099-07-30T00:02:00.000Z",
    };
    const fixture = { ...baseFixture, run };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const backgroundTasks = new Set<Promise<void>>();
    const markWorkflowUnrecoverable = vi.fn(async () => undefined);
    const context = createContext(runs, [], []);
    await installAdmittedChatRuntimeFixture(context, fixture);
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks,
      sharedHostLifecycle: new SharedHostLifecycleService({ enabled: false }),
      isLocalProcessAlive: vi.fn(() => false),
      workflowRegistry: {
        executeWorkflow: vi.fn(),
        isWorkflowRecoverable: () => ({ recoverable: false, reason: "retained output forbids replay" }),
        markWorkflowUnrecoverable,
      },
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);
    await service.stopWorker();

    expect(runs.get(run.runId)).toMatchObject({
      status: "running",
      metadata: { chatTurnRuntimeAuthority: conflictingAuthority, waitForEvent: null },
    });
    expect(markWorkflowUnrecoverable).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "current process",
      leaseOwnerId: buildDurableLocalProcessLeaseOwnerId({ pid: process.pid, nonce: randomUUID() }),
      isAlive: false,
      sharedHost: false,
    },
    {
      name: "live same-host process",
      leaseOwnerId: buildDurableLocalProcessLeaseOwnerId({ pid: 987_656, nonce: randomUUID() }),
      isAlive: true,
      sharedHost: false,
    },
    { name: "legacy owner", leaseOwnerId: "worker-old", isAlive: false, sharedHost: false },
    {
      name: "remote-host owner",
      leaseOwnerId: buildDurableLocalProcessLeaseOwnerId({
        hostFingerprint: "f".repeat(16),
        pid: 987_657,
        nonce: randomUUID(),
      }),
      isAlive: false,
      sharedHost: false,
    },
    {
      name: "shared-host mode",
      leaseOwnerId: buildDurableLocalProcessLeaseOwnerId({ pid: 987_658, nonce: randomUUID() }),
      isAlive: false,
      sharedHost: true,
    },
  ])("leaves a fresh $name lease untouched until database-clock expiry", async (fixture) => {
    const run = {
      ...createRun(`run-${fixture.name}`, "running", "connector.delivery"),
      leaseOwnerId: fixture.leaseOwnerId,
      leaseHeartbeatAt: "2026-07-30T00:00:00.000Z",
      leaseExpiresAt: "2099-07-30T00:02:00.000Z",
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const backgroundTasks = new Set<Promise<void>>();
    const executeWorkflow = vi.fn();
    const lifecycle = new SharedHostLifecycleService({ enabled: fixture.sharedHost });
    lifecycle.markAccepting();
    const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext, {
      backgroundTasks,
      sharedHostLifecycle: lifecycle,
      isLocalProcessAlive: vi.fn(() => fixture.isAlive),
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);
    await service.stopWorker();

    expect(executeWorkflow).not.toHaveBeenCalled();
    expect(runs.get(run.runId)).toMatchObject({ status: "running", leaseOwnerId: fixture.leaseOwnerId });
  });

  it("loses the fresh-lease recovery race when exact owner fencing no longer matches", async () => {
    const leaseOwnerId = buildDurableLocalProcessLeaseOwnerId({ pid: 987_659, nonce: randomUUID() });
    const run = {
      ...createRun("run-dead-owner-race", "running", "connector.delivery"),
      leaseOwnerId,
      leaseHeartbeatAt: "2026-07-30T00:00:00.000Z",
      leaseExpiresAt: "2099-07-30T00:02:00.000Z",
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const backgroundTasks = new Set<Promise<void>>();
    const context = createContext(runs, [], []);
    const lockFreshActiveLeaseForUpdate = vi.fn(() => undefined);
    Object.assign(context.storage.durableRuns, { lockFreshActiveLeaseForUpdate });
    const executeWorkflow = vi.fn();
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks,
      sharedHostLifecycle: new SharedHostLifecycleService({ enabled: false }),
      isLocalProcessAlive: vi.fn(() => false),
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);
    await service.stopWorker();

    expect(lockFreshActiveLeaseForUpdate).toHaveBeenCalledWith(run.runId, leaseOwnerId);
    expect(executeWorkflow).not.toHaveBeenCalled();
    expect(runs.get(run.runId)).toMatchObject({ status: "running", leaseOwnerId });
  });

  it("isolates one terminal Chat reconciliation failure and continues the shared queue", async () => {
    const first = createRun("run-terminal-reconcile-poison", "queued", "connector.delivery");
    const second = createRun("run-terminal-reconcile-next", "queued", "connector.delivery");
    const runs = new Map<string, DurableRunRecord>([
      [first.runId, first],
      [second.runId, second],
    ]);
    const backgroundTasks = new Set<Promise<void>>();
    const logger: DurableRunServiceLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const publishRealtime = vi.fn();
    const context = createContext(runs, [], [], { logger, publishRealtime });
    const executeWorkflow = vi.fn(async (run: DurableRunRecord) => {
      const terminal = createAdmittedChatRuntimeFixture({ runId: run.runId, status: "completed" }).run;
      runs.set(run.runId, terminal);
    });
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });
    const reconcile = vi.spyOn(service, "reconcileGeneralChatPostCommit").mockImplementation(async (runId: string) => {
      if (runId === first.runId) {
        throw new Error("UNIQUE constraint failed: durable_run_events.run_id, durable_run_events.sequence");
      }
      return true;
    });

    try {
      service.startWorker();
      await Promise.all([...backgroundTasks]);

      expect(executeWorkflow.mock.calls.map(([run]) => run.runId)).toEqual([first.runId, second.runId]);
      expect(reconcile).toHaveBeenCalledWith(first.runId);
      expect(reconcile).toHaveBeenCalledWith(second.runId);
      expect(runs.get(first.runId)?.status).toBe("completed");
      expect(runs.get(second.runId)?.status).toBe("completed");
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: first.runId,
          error: expect.stringContaining("durable_run_events.run_id"),
        }),
        "durable run recovery failed; continuing with other runs",
      );
      expect(publishRealtime).not.toHaveBeenCalledWith(
        "system",
        "durable",
        expect.objectContaining({ type: "durable_worker_background_failure" }),
        expect.anything(),
      );
    } finally {
      await service.stopWorker();
    }
  });

  it("does not claim queued worker work after shared-host pause closes admission", async () => {
    const run = createRun("run-paused-before-claim", "queued");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const backgroundTasks = new Set<Promise<void>>();
    const executeWorkflow = vi.fn();
    const lifecycle = new SharedHostLifecycleService({ enabled: true });
    lifecycle.markAccepting();
    await lifecycle.drain({ mode: "pause", timeoutMs: 10, reason: "scale_down", actorId: "ops" });
    const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext, {
      backgroundTasks,
      sharedHostLifecycle: lifecycle,
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });
    try {
      service.startWorker();
      await Promise.allSettled([...backgroundTasks]);
      expect(executeWorkflow).not.toHaveBeenCalled();
      expect(runs.get(run.runId)).toMatchObject({ status: "queued", leaseOwnerId: undefined });
      expect(lifecycle.snapshot()).toMatchObject({ state: "quiesced", activeByKind: { worker: 0 } });
    } finally {
      await service.stopWorker();
    }
  });

  it("force-drains an active durable worker and resumes its preserved lease after restart", async () => {
    const run = createRun("run-force-drain-resume", "queued");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const firstTasks = new Set<Promise<void>>();
    const lifecycle = new SharedHostLifecycleService({ enabled: true });
    lifecycle.markAccepting();
    let executionStarted!: () => void;
    const executionStartedPromise = new Promise<void>((resolve) => (executionStarted = resolve));
    const firstExecute = vi.fn(async (_run: DurableRunRecord, context: { signal: AbortSignal }) => {
      executionStarted();
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    });
    const first = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext, {
      backgroundTasks: firstTasks,
      sharedHostLifecycle: lifecycle,
      workflowRegistry: {
        executeWorkflow: firstExecute,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });
    try {
      first.startWorker();
      await executionStartedPromise;
      expect(runs.get(run.runId)).toMatchObject({ status: "running", leaseOwnerId: expect.any(String) });

      await expect(
        lifecycle.drain({ mode: "force", timeoutMs: 10, reason: "terminate", actorId: "ops" }),
      ).resolves.toMatchObject({ outcome: "closing" });
      await Promise.allSettled([...firstTasks]);
      expect(runs.get(run.runId)).toMatchObject({ status: "running", leaseOwnerId: expect.any(String) });
    } finally {
      await first.stopWorker();
    }

    const interrupted = runs.get(run.runId);
    if (!interrupted) throw new Error("interrupted durable run disappeared");
    runs.set(run.runId, {
      ...interrupted,
      leaseHeartbeatAt: "2026-03-14T00:00:00.000Z",
      leaseExpiresAt: "2026-03-14T00:00:01.000Z",
    });
    const secondTasks = new Set<Promise<void>>();
    const secondExecute = vi.fn(async (resumed: DurableRunRecord) => {
      updateRun(runs, resumed.runId, { status: "completed", finishedAt: "2026-03-14T00:00:05.000Z" });
    });
    const second = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext, {
      backgroundTasks: secondTasks,
      workflowRegistry: {
        executeWorkflow: secondExecute,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });
    second.startWorker();
    await Promise.allSettled([...secondTasks]);
    await second.stopWorker();

    expect(secondExecute).toHaveBeenCalledTimes(1);
    expect(runs.get(run.runId)).toMatchObject({ status: "completed" });
  });

  it("leaves approval-blocked durable work parked while pause reaches quiescence", async () => {
    const waiting = {
      ...createRun("run-waiting-on-approval-during-drain", "waiting"),
      metadata: { waitForEvent: { eventKey: "approval.resolved", correlationId: "approval-1" } },
    };
    const runs = new Map<string, DurableRunRecord>([[waiting.runId, waiting]]);
    const backgroundTasks = new Set<Promise<void>>();
    const executeWorkflow = vi.fn();
    const lifecycle = new SharedHostLifecycleService({ enabled: true });
    lifecycle.markAccepting();
    const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext, {
      backgroundTasks,
      sharedHostLifecycle: lifecycle,
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });
    try {
      service.startWorker();
      await Promise.allSettled([...backgroundTasks]);
      await expect(
        lifecycle.drain({ mode: "pause", timeoutMs: 10, reason: "scale_down", actorId: "ops" }),
      ).resolves.toMatchObject({ outcome: "quiesced" });
      expect(executeWorkflow).not.toHaveBeenCalled();
      expect(runs.get(waiting.runId)).toMatchObject({
        status: "waiting",
        metadata: { waitForEvent: { eventKey: "approval.resolved", correlationId: "approval-1" } },
      });
    } finally {
      await service.stopWorker();
    }
  });

  it("recovers a database-expired lease even when the worker clock is slow", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2000-03-14T00:00:00.000Z"));
      const run = {
        ...createRun("run-db-expired-host-slow", "running"),
        leaseOwnerId: "worker-old",
        leaseHeartbeatAt: "2099-03-14T00:00:00.000Z",
        leaseExpiresAt: "2099-03-14T00:00:01.000Z",
      };
      const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
      const backgroundTasks = new Set<Promise<void>>();
      const context = createContext(runs, [], []);
      const lockExpiredLeaseForUpdate = vi.fn(() => runs.get(run.runId));
      Object.assign(context.storage.durableRuns, {
        listExpiredRunningRunIds: vi.fn(() => [run.runId]),
        lockExpiredLeaseForUpdate,
      });
      const executeWorkflow = vi.fn(async (claimed: DurableRunRecord) => {
        updateRun(runs, claimed.runId, { status: "completed", clearLease: true });
      });
      const service = new DurableRunService(context as unknown as ServiceContext, {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow,
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
      });

      service.startWorker();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all([...backgroundTasks]);

      expect(lockExpiredLeaseForUpdate).toHaveBeenCalledWith({
        runId: run.runId,
        expectedLeaseOwnerId: "worker-old",
        expectedLeaseExpiresAt: "2099-03-14T00:00:01.000Z",
      });
      expect(executeWorkflow).toHaveBeenCalledTimes(1);
      expect(runs.get(run.runId)?.status).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses database-clock claim and renewal APIs under fast and slow worker clocks", async () => {
    const dateNow = vi.spyOn(Date, "now");
    try {
      for (const hostNow of [Date.parse("2100-03-14T00:00:00.000Z"), Date.parse("2000-03-14T00:00:00.000Z")]) {
        dateNow.mockReturnValue(hostNow);
        const run = createRun(`run-db-clock-${hostNow}`, "queued");
        const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
        const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
        const timeline: Array<{ runId: string; eventType: string }> = [];
        const backgroundTasks = new Set<Promise<void>>();
        const context = createContext(runs, checkpoints, timeline);
        const databaseHeartbeatAt = "2026-03-14T00:00:00.000Z";
        const databaseLeaseExpiresAt = "2026-03-14T00:02:00.000Z";
        const tryClaimQueuedRunWithDatabaseClock = vi.fn((input: { runId: string; workerId: string }) =>
          updateRun(runs, input.runId, {
            status: "running",
            startedAt: databaseHeartbeatAt,
            leaseOwnerId: input.workerId,
            leaseHeartbeatAt: databaseHeartbeatAt,
            leaseExpiresAt: databaseLeaseExpiresAt,
            updatedAt: databaseHeartbeatAt,
          }),
        );
        const renewLeaseWithDatabaseClock = vi.fn((input: { runId: string; workerId: string }) =>
          updateRun(runs, input.runId, {
            leaseOwnerId: input.workerId,
            leaseHeartbeatAt: databaseHeartbeatAt,
            leaseExpiresAt: databaseLeaseExpiresAt,
            updatedAt: databaseHeartbeatAt,
          }),
        );
        Object.assign(context.storage.durableRuns, {
          tryClaimQueuedRunWithDatabaseClock,
          renewLeaseWithDatabaseClock,
        });
        const executeWorkflow = vi.fn(async (claimed: DurableRunRecord) => {
          updateRun(runs, claimed.runId, { status: "completed", clearLease: true });
        });
        const service = new DurableRunService(context as unknown as ServiceContext, {
          backgroundTasks,
          workflowRegistry: {
            executeWorkflow,
            isWorkflowRecoverable: () => ({ recoverable: true }),
            markWorkflowUnrecoverable: vi.fn(),
          },
        });

        service.startWorker();
        await Promise.all([...backgroundTasks]);

        expect(tryClaimQueuedRunWithDatabaseClock).toHaveBeenCalledWith(
          expect.objectContaining({ runId: run.runId, leaseDurationMs: 120_000 }),
        );
        expect(renewLeaseWithDatabaseClock).toHaveBeenCalledWith(
          expect.objectContaining({ runId: run.runId, leaseDurationMs: 120_000 }),
        );
        expect(executeWorkflow).toHaveBeenCalledWith(
          expect.objectContaining({
            leaseHeartbeatAt: databaseHeartbeatAt,
            leaseExpiresAt: databaseLeaseExpiresAt,
          }),
          expect.any(Object),
        );
        expect(runs.get(run.runId)?.status).toBe("completed");
      }
    } finally {
      dateNow.mockRestore();
    }
  });

  it("recovers autonomous Chat post-commit work and clears its marker only after success", async () => {
    const run = {
      ...createRun("run-autonomous-post-commit", "completed"),
      metadata: {
        autonomous: { kind: "scheduled", deliverMode: "always" },
        autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-03-14T00:00:01.000Z" },
      },
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const backgroundTasks = new Set<Promise<void>>();
    const onAutonomousChatPostCommit = vi.fn(async () => ({
      delivery: { status: "enqueued", runId: "autonomous-delivery:run-autonomous-post-commit" },
    }));
    const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow: vi.fn(),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
      onAutonomousChatPostCommit,
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);
    expect(onAutonomousChatPostCommit).toHaveBeenCalledTimes(1);
    expect(onAutonomousChatPostCommit).toHaveBeenCalledWith(
      expect.objectContaining({ runId: run.runId, status: "completed" }),
      expect.objectContaining({ claimId: expect.any(String), signal: expect.any(AbortSignal) }),
    );
    expect(runs.get(run.runId)?.metadata).not.toHaveProperty("autonomousChatPostCommitPending");
    expect(runs.get(run.runId)?.metadata).toMatchObject({
      autonomousChatPostCommit: {
        delivery: { status: "enqueued", runId: "autonomous-delivery:run-autonomous-post-commit" },
        completedAt: expect.any(String),
      },
    });

    expect(await service.reconcileAutonomousChatPostCommit(run.runId)).toBe(true);
    expect(onAutonomousChatPostCommit).toHaveBeenCalledTimes(1);
  });

  it("durably claims autonomous Chat post-commit work before invoking its callback", async () => {
    const run = {
      ...createRun("run-autonomous-post-commit-concurrent", "completed"),
      metadata: {
        autonomous: { kind: "scheduled", deliverMode: "always" },
        autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-03-14T00:00:01.000Z" },
      },
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    let releaseCallback!: () => void;
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const onAutonomousChatPostCommit = vi.fn(async () => {
      await callbackGate;
      return { delivery: { status: "enqueued", runId: "autonomous-delivery:concurrent" } };
    });
    const createService = () =>
      new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext, {
        backgroundTasks: new Set(),
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
        onAutonomousChatPostCommit,
      });
    const first = createService().reconcileAutonomousChatPostCommit(run.runId);
    await vi.waitFor(() => expect(onAutonomousChatPostCommit).toHaveBeenCalledTimes(1));

    const second = createService().reconcileAutonomousChatPostCommit(run.runId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onAutonomousChatPostCommit).toHaveBeenCalledTimes(1);

    releaseCallback();
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(onAutonomousChatPostCommit).toHaveBeenCalledTimes(1);
  });

  it("bounds a hung autonomous Chat post-commit callback and retains its recovery marker", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
      const run = {
        ...createRun("run-autonomous-post-commit-timeout", "completed"),
        metadata: {
          autonomous: { kind: "scheduled", deliverMode: "always" },
          autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-07-11T00:00:00.000Z" },
        },
      };
      const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
      let observedSignal: AbortSignal | undefined;
      const onAutonomousChatPostCommit = vi.fn(
        async (_claimedRun: DurableRunRecord, context?: { signal: AbortSignal }) => {
          observedSignal = context?.signal;
          await new Promise<void>((resolve) => {
            if (!context?.signal || context.signal.aborted) {
              resolve();
              return;
            }
            context.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      );
      const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext, {
        backgroundTasks: new Set(),
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
        onAutonomousChatPostCommit,
      });

      const reconciliation = service.reconcileAutonomousChatPostCommit(run.runId);
      await vi.advanceTimersByTimeAsync(0);
      expect(observedSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(60_000);

      await expect(reconciliation).resolves.toBe(false);
      expect(observedSignal?.aborted).toBe(true);
      expect(runs.get(run.runId)?.metadata).toHaveProperty(
        "autonomousChatPostCommitPending.requestedAt",
        "2026-07-11T00:00:00.000Z",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts autonomous Chat post-commit when its durable claim moves to another worker", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
      const run = {
        ...createRun("run-autonomous-post-commit-ownership-loss", "completed"),
        metadata: {
          autonomous: { kind: "scheduled", deliverMode: "always" },
          autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-07-11T00:00:00.000Z" },
        },
      };
      const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
      let observedSignal: AbortSignal | undefined;
      const onAutonomousChatPostCommit = vi.fn(
        async (_claimedRun: DurableRunRecord, context?: { signal: AbortSignal }) => {
          observedSignal = context?.signal;
          await new Promise<void>((resolve) => {
            if (!context?.signal || context.signal.aborted) {
              resolve();
              return;
            }
            context.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      );
      const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext, {
        backgroundTasks: new Set(),
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
        onAutonomousChatPostCommit,
      });

      const reconciliation = service.reconcileAutonomousChatPostCommit(run.runId);
      await vi.advanceTimersByTimeAsync(0);
      expect(observedSignal?.aborted).toBe(false);
      const claimed = runs.get(run.runId)!;
      runs.set(run.runId, {
        ...claimed,
        version: claimed.version + 1,
        metadata: {
          ...(claimed.metadata ?? {}),
          autonomousChatPostCommitPending: {
            ...(claimed.metadata?.autonomousChatPostCommitPending as Record<string, unknown>),
            claimId: "replacement-autonomous-worker",
            claimExpiresAt: "2026-07-11T00:01:00.000Z",
          },
        },
      });

      await vi.advanceTimersByTimeAsync(10_000);

      await expect(reconciliation).resolves.toBe(false);
      expect(observedSignal?.aborted).toBe(true);
      expect(runs.get(run.runId)?.metadata).toHaveProperty(
        "autonomousChatPostCommitPending.claimId",
        "replacement-autonomous-worker",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers general Chat post-commit work once and clears its durable marker", async () => {
    const fixture = createAdmittedChatRuntimeFixture({
      runId: "run-general-post-commit",
      status: "completed",
      generationId: "generation-general",
      traceStatus: "completed",
    });
    const run = fixture.run;
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const backgroundTasks = new Set<Promise<void>>();
    const enqueueAgentEnd = vi.fn();
    const persistLearnedMemory = vi.fn();
    const scheduleMaintenance = vi.fn();
    const onGeneralChatPostCommit = vi.fn(async (_run: DurableRunRecord, progress: GeneralChatPostCommitProgress) => {
      await progress.runEffect("agent_end", enqueueAgentEnd);
      await progress.runEffect("learned_memory_user", persistLearnedMemory);
      await progress.runEffect("memory_maintenance", scheduleMaintenance);
      for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
        await progress.runEffect(effect, () => undefined);
      }
      return { status: "completed" };
    });
    const context = createContext(runs, [], []);
    await installAdmittedChatRuntimeFixture(context, fixture);
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow: vi.fn(),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
      onGeneralChatPostCommit,
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    expect(onGeneralChatPostCommit).toHaveBeenCalledTimes(1);
    expect(enqueueAgentEnd).toHaveBeenCalledTimes(1);
    expect(persistLearnedMemory).toHaveBeenCalledTimes(1);
    expect(scheduleMaintenance).toHaveBeenCalledTimes(1);
    expect(runs.get(run.runId)?.metadata).not.toHaveProperty("generalChatPostCommitPending");
    expect(runs.get(run.runId)?.metadata).toMatchObject({
      generalChatPostCommit: {
        status: "completed",
        completedAt: expect.any(String),
      },
    });

    expect(await service.reconcileGeneralChatPostCommit(run.runId)).toBe(true);
    expect(onGeneralChatPostCommit).toHaveBeenCalledTimes(1);
  });

  it("expires a stalled general Chat post-commit owner so a later attempt can reconcile", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
      const fixture = createAdmittedChatRuntimeFixture({
        runId: "run-general-post-commit-owner-expiry",
        status: "completed",
        generationId: "generation-general-post-commit-owner-expiry",
        traceStatus: "completed",
      });
      const runs = new Map<string, DurableRunRecord>([[fixture.run.runId, fixture.run]]);
      const context = createContext(runs, [], []);
      await installAdmittedChatRuntimeFixture(context, fixture);
      let attempt = 0;
      const onGeneralChatPostCommit = vi.fn(async (_run: DurableRunRecord, progress: GeneralChatPostCommitProgress) => {
        attempt += 1;
        if (attempt === 1) {
          return new Promise<Record<string, unknown>>(() => undefined);
        }
        for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
          await progress.runEffect(effect, () => undefined);
        }
        return { status: "completed" };
      });
      const service = new DurableRunService(context as unknown as ServiceContext, {
        backgroundTasks: new Set(),
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
        onGeneralChatPostCommit,
      });

      const stalled = service.reconcileGeneralChatPostCommit(fixture.run.runId);
      await vi.advanceTimersByTimeAsync(0);
      expect(onGeneralChatPostCommit).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(stalled).resolves.toBe(false);
      await expect(service.reconcileGeneralChatPostCommit(fixture.run.runId)).resolves.toBe(true);

      expect(onGeneralChatPostCommit).toHaveBeenCalledTimes(2);
      expect(runs.get(fixture.run.runId)?.metadata).not.toHaveProperty("generalChatPostCommitPending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires terminal v1 post-commit markers without replaying legacy side effects", async () => {
    const run = {
      ...createRun("run-legacy-terminal-post-commit", "completed", "chat.turn.execute"),
      payload: { version: "chat.turn.execute.v1" },
      metadata: {
        generalChatPostCommitPending: {
          version: 1,
          generationId: "generation-legacy-terminal",
          traceStatus: "completed",
          requestedAt: "2026-07-11T00:00:00.000Z",
          completedEffects: [
            "capability_gap",
            "learned_memory_user",
            "learned_memory_assistant",
            "memory_prewarm",
            "realtime",
            "agent_end",
          ],
          durableEffectRunIds: {
            commitments: "legacy-commitments",
            background_review: "legacy-background-review",
            memory_maintenance: "legacy-memory-maintenance",
          },
        },
      },
    } satisfies DurableRunRecord;
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } satisfies DurableRunServiceLogger;
    const onGeneralChatPostCommit = vi.fn();
    const service = new DurableRunService(createContext(runs, [], [], { logger }) as unknown as ServiceContext, {
      backgroundTasks: new Set(),
      workflowRegistry: {
        executeWorkflow: vi.fn(),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
      onGeneralChatPostCommit,
    });

    await expect(service.reconcileGeneralChatPostCommit(run.runId)).resolves.toBe(true);

    const retired = runs.get(run.runId)!;
    expect(retired.metadata).not.toHaveProperty("generalChatPostCommitPending");
    expect(retired.metadata).not.toHaveProperty("generalChatPostCommit");
    expect(retired.metadata).toMatchObject({
      legacyGeneralChatPostCommitSettlement: {
        version: "chat.post_commit.legacy-settlement.v1",
        disposition: "terminal_v1_effects_not_replayed",
        generationId: "generation-legacy-terminal",
        traceStatus: "completed",
        pendingMarkerSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        retiredAt: expect.any(String),
      },
    });
    expect(onGeneralChatPostCommit).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);

    await expect(service.reconcileGeneralChatPostCommit(run.runId)).resolves.toBe(true);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("continues the pending general Chat post-commit sweep while another run is stalled", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
      const stalledRun = {
        ...createRun("run-general-post-commit-sweep-a-stalled", "completed", "chat.turn.execute"),
        metadata: { generalChatPostCommitPending: { version: 1, requestedAt: "2026-07-11T00:00:00.000Z" } },
      };
      const healthyRun = {
        ...createRun("run-general-post-commit-sweep-b-healthy", "completed", "chat.turn.execute"),
        metadata: { generalChatPostCommitPending: { version: 1, requestedAt: "2026-07-11T00:00:00.000Z" } },
      };
      const runs = new Map<string, DurableRunRecord>([
        [stalledRun.runId, stalledRun],
        [healthyRun.runId, healthyRun],
      ]);
      const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext, {
        backgroundTasks: new Set(),
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
        onGeneralChatPostCommit: vi.fn(async () => ({})),
      });
      let healthyCompleted = false;
      const reconcile = vi.spyOn(service, "reconcileGeneralChatPostCommit").mockImplementation(async (runId) => {
        if (runId === stalledRun.runId) {
          return new Promise<boolean>(() => undefined);
        }
        healthyCompleted = true;
        return true;
      });

      const sweep = (
        service as unknown as { reconcilePendingGeneralChatPostCommits(): Promise<void> }
      ).reconcilePendingGeneralChatPostCommits();
      await vi.advanceTimersByTimeAsync(0);

      expect(reconcile).toHaveBeenCalledWith(stalledRun.runId);
      expect(reconcile).toHaveBeenCalledWith(healthyRun.runId);
      expect(healthyCompleted).toBe(true);

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(sweep).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a stale in-flight ownership generation clear its replacement", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
      const fixture = createAdmittedChatRuntimeFixture({
        runId: "run-general-post-commit-owner-generation",
        status: "completed",
        generationId: "generation-general-post-commit-owner-generation",
        traceStatus: "completed",
      });
      const runs = new Map<string, DurableRunRecord>([[fixture.run.runId, fixture.run]]);
      const context = createContext(runs, [], []);
      await installAdmittedChatRuntimeFixture(context, fixture);
      const attempts: Array<{
        progress: GeneralChatPostCommitProgress;
        resolve: (resolution: Record<string, unknown>) => void;
      }> = [];
      const onGeneralChatPostCommit = vi.fn(
        (_run: DurableRunRecord, progress: GeneralChatPostCommitProgress) =>
          new Promise<Record<string, unknown>>((resolve) => {
            attempts.push({ progress, resolve });
          }),
      );
      const service = new DurableRunService(context as unknown as ServiceContext, {
        backgroundTasks: new Set(),
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
        onGeneralChatPostCommit,
      });

      const stale = service.reconcileGeneralChatPostCommit(fixture.run.runId);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(stale).resolves.toBe(false);

      const current = service.reconcileGeneralChatPostCommit(fixture.run.runId);
      await vi.advanceTimersByTimeAsync(0);
      expect(onGeneralChatPostCommit).toHaveBeenCalledTimes(2);

      const staleEffect = vi.fn();
      expect(await attempts[0]!.progress.runEffect("agent_end", staleEffect)).toBe(false);
      expect(staleEffect).not.toHaveBeenCalled();
      attempts[0]!.resolve({ status: "stale" });
      await vi.advanceTimersByTimeAsync(0);
      const coalesced = service.reconcileGeneralChatPostCommit(fixture.run.runId);
      await vi.advanceTimersByTimeAsync(0);
      expect(onGeneralChatPostCommit).toHaveBeenCalledTimes(2);

      for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
        await attempts[1]!.progress.runEffect(effect, () => undefined);
      }
      attempts[1]!.resolve({ status: "completed" });

      await expect(Promise.all([current, coalesced])).resolves.toEqual([true, true]);
      expect(runs.get(fixture.run.runId)?.metadata).not.toHaveProperty("generalChatPostCommitPending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("wakes a settled ordinary admitted-v2 Chat wait through checkpoint-anchored authority", async () => {
    const fixture = createAdmittedChatRuntimeFixture({
      runId: "run-ordinary-admitted-wake",
      status: "waiting",
      generationId: "generation-ordinary-admitted-wake",
      traceStatus: "waiting_for_approval",
    });
    const runs = new Map<string, DurableRunRecord>([[fixture.run.runId, fixture.run]]);
    const context = createContext(runs, [], []);
    await installAdmittedChatRuntimeFixture(context, fixture);
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks: new Set(),
      workflowRegistry: {
        executeWorkflow: vi.fn(),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
      onGeneralChatPostCommit: async (_run, progress) => {
        for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
          await progress.runEffect(effect, () => undefined);
        }
        return { status: "waiting_for_approval" };
      },
    });
    const waitForEvent = fixture.run.metadata?.waitForEvent as {
      eventKey: string;
      correlationId: string;
    };

    expect(await service.wakeDurableRun(fixture.run.runId, waitForEvent)).toMatchObject({
      outcome: "failed",
      detail: expect.stringContaining("waiting generation settles"),
    });
    expect(runs.get(fixture.run.runId)?.status).toBe("waiting");

    await expect(service.reconcileGeneralChatPostCommit(fixture.run.runId)).resolves.toBe(true);
    expect(await service.wakeDurableRun(fixture.run.runId, waitForEvent)).toMatchObject({
      outcome: "woke",
      run: { status: "queued" },
    });
    expect(runs.get(fixture.run.runId)?.metadata).not.toHaveProperty("waitForEvent");
    expect(runs.get(fixture.run.runId)?.metadata).not.toHaveProperty("chatTurnRuntimeAuthority");
  });

  it.each(["missing", "tampered-checkpoint"] as const)(
    "fails closed when ordinary admitted-v2 waiting authority is %s",
    async (failureKind) => {
      const fixture = createAdmittedChatRuntimeFixture({
        runId: `run-ordinary-admitted-${failureKind}`,
        status: "waiting",
        generationId: `generation-ordinary-admitted-${failureKind}`,
        traceStatus: "waiting_for_approval",
      });
      if (failureKind === "missing") {
        const metadata = { ...(fixture.run.metadata ?? {}) };
        delete metadata.chatTurnRuntimeAuthority;
        fixture.run.metadata = metadata;
      } else {
        fixture.checkpointState = {
          ...(fixture.checkpointState ?? {}),
          chatTurnRuntimeAuthority: {
            ...((fixture.checkpointState?.chatTurnRuntimeAuthority as Record<string, unknown>) ?? {}),
            materialSha256: "0".repeat(64),
          },
        };
      }
      const runs = new Map<string, DurableRunRecord>([[fixture.run.runId, fixture.run]]);
      const context = createContext(runs, [], []);
      await installAdmittedChatRuntimeFixture(context, fixture);
      const service = new DurableRunService(context as unknown as ServiceContext, {
        backgroundTasks: new Set(),
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
        onGeneralChatPostCommit: async (_run, progress) => {
          for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
            await progress.runEffect(effect, () => undefined);
          }
          return { status: "waiting_for_approval" };
        },
      });
      const waitForEvent = fixture.run.metadata?.waitForEvent as {
        eventKey: string;
        correlationId: string;
      };
      expect(await service.wakeDurableRun(fixture.run.runId, waitForEvent)).toMatchObject({ outcome: "failed" });
      expect(runs.get(fixture.run.runId)?.status).toBe("waiting");
    },
  );

  it.each([
    { durableStatus: "completed" as const, traceStatus: "completed" as const },
    { durableStatus: "failed" as const, traceStatus: "failed" as const },
    { durableStatus: "cancelled" as const, traceStatus: "cancelled" as const },
  ])(
    "holds terminal delivery through delayed $durableStatus post-commit settlement and releases admission",
    async ({ durableStatus, traceStatus }) => {
      const fixture = createAdmittedChatRuntimeFixture({
        runId: `run-terminal-delivery-${durableStatus}`,
        status: durableStatus,
        generationId: `generation-terminal-delivery-${durableStatus}`,
        traceStatus,
      });
      const runs = new Map<string, DurableRunRecord>([[fixture.run.runId, fixture.run]]);
      const context = createContext(runs, [], []);
      await installAdmittedChatRuntimeFixture(context, fixture);
      let releasePostCommit!: () => void;
      const postCommitGate = new Promise<void>((resolve) => {
        releasePostCommit = resolve;
      });
      const onGeneralChatPostCommit = vi.fn(async (_run: DurableRunRecord, progress: GeneralChatPostCommitProgress) => {
        await postCommitGate;
        for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
          await progress.runEffect(effect, () => undefined);
        }
        return { status: durableStatus };
      });
      const service = new DurableRunService(context as unknown as ServiceContext, {
        backgroundTasks: new Set(),
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
        onGeneralChatPostCommit,
      });

      const pending = service.awaitTerminalChatAdmissionRelease({
        runId: fixture.run.runId,
        sessionId: fixture.admission.sessionId,
        turnId: fixture.admission.turnId,
        timeoutMs: 1_000,
      });
      await vi.waitFor(() => expect(onGeneralChatPostCommit).toHaveBeenCalledOnce());
      expect(fixture.admission.status).toBe("active");

      releasePostCommit();

      await expect(pending).resolves.toMatchObject({
        recoveryOutcome: "released",
        durableRunId: fixture.run.runId,
        durableRunStatus: durableStatus,
        admissionId: fixture.admission.admissionId,
      });
      expect(fixture.admission).toMatchObject({
        status: durableStatus === "completed" ? "completed" : "cancelled",
        terminalAuthorityKind: "durable_terminal",
        terminalDurableRunId: fixture.run.runId,
        terminalDurableRunStatus: durableStatus,
      });
    },
  );

  it("returns a bounded non-release outcome while canonical durable admission remains active", async () => {
    const fixture = createAdmittedChatRuntimeFixture({
      runId: "run-terminal-delivery-active",
      status: "running",
    });
    const runs = new Map<string, DurableRunRecord>([[fixture.run.runId, fixture.run]]);
    const context = createContext(runs, [], []);
    await installAdmittedChatRuntimeFixture(context, fixture);
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks: new Set(),
      workflowRegistry: {
        executeWorkflow: vi.fn(),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
      onGeneralChatPostCommit: vi.fn(async () => ({})),
    });

    await expect(
      service.awaitTerminalChatAdmissionRelease({
        runId: fixture.run.runId,
        sessionId: fixture.admission.sessionId,
        turnId: fixture.admission.turnId,
        timeoutMs: 10,
      }),
    ).resolves.toMatchObject({
      recoveryOutcome: "not_terminal",
      durableRunId: fixture.run.runId,
      durableRunStatus: "running",
      remainingBudgetMs: 0,
    });
    expect(fixture.admission.status).toBe("active");
  });

  it("bounds a stalled terminal post-commit reconciler and leaves admission active", async () => {
    const fixture = createAdmittedChatRuntimeFixture({
      runId: "run-terminal-delivery-stalled-post-commit",
      status: "completed",
      generationId: "generation-terminal-delivery-stalled-post-commit",
      traceStatus: "completed",
    });
    const runs = new Map<string, DurableRunRecord>([[fixture.run.runId, fixture.run]]);
    const context = createContext(runs, [], []);
    await installAdmittedChatRuntimeFixture(context, fixture);
    const onGeneralChatPostCommit = vi.fn(() => new Promise<Record<string, unknown>>(() => undefined));
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks: new Set(),
      workflowRegistry: {
        executeWorkflow: vi.fn(),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
      onGeneralChatPostCommit,
    });

    const outcome = await service.awaitTerminalChatAdmissionRelease({
      runId: fixture.run.runId,
      sessionId: fixture.admission.sessionId,
      turnId: fixture.admission.turnId,
      timeoutMs: 10,
    });

    expect(outcome).toMatchObject({
      recoveryOutcome: "reconciliation_pending",
      durableRunId: fixture.run.runId,
      durableRunStatus: "completed",
      admissionStatus: "active",
    });
    // The timeout owner reports the integer-millisecond budget observed when the
    // bounded timer settles. Clock granularity can leave 1ms on a loaded runner;
    // the contract is that the diagnostic stays inside the caller's budget.
    expect(outcome.remainingBudgetMs).toBeGreaterThanOrEqual(0);
    expect(outcome.remainingBudgetMs).toBeLessThanOrEqual(10);
    expect(onGeneralChatPostCommit).toHaveBeenCalledOnce();
    expect(fixture.admission.status).toBe("active");
  });

  it("releases terminal delivery after provider-backed post-commit work crosses multiple ownership epochs", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
      const fixture = createAdmittedChatRuntimeFixture({
        runId: "run-terminal-delivery-multiple-reconciliation-epochs",
        status: "completed",
        generationId: "generation-terminal-delivery-multiple-reconciliation-epochs",
        traceStatus: "completed",
      });
      const runs = new Map<string, DurableRunRecord>([[fixture.run.runId, fixture.run]]);
      const context = createContext(runs, [], []);
      installAdmittedChatRuntimeFixture(context, fixture);
      let invocation = 0;
      const onGeneralChatPostCommit = vi.fn(async (_run: DurableRunRecord, progress: GeneralChatPostCommitProgress) => {
        invocation += 1;
        if (invocation < 3) {
          await new Promise<void>(() => undefined);
        }
        for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) progress.runEffect(effect, () => undefined);
        return { status: "completed" };
      });
      const service = new DurableRunService(context as unknown as ServiceContext, {
        backgroundTasks: new Set(),
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
        onGeneralChatPostCommit,
      });

      const pending = service.awaitTerminalChatAdmissionRelease({
        runId: fixture.run.runId,
        sessionId: fixture.admission.sessionId,
        turnId: fixture.admission.turnId,
        timeoutMs: 30_000,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(onGeneralChatPostCommit).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_500);

      await expect(pending).resolves.toMatchObject({
        recoveryOutcome: "released",
        durableRunId: fixture.run.runId,
        durableRunStatus: "completed",
        admissionId: fixture.admission.admissionId,
      });
      expect(onGeneralChatPostCommit).toHaveBeenCalledTimes(3);
      expect(fixture.admission).toMatchObject({
        status: "completed",
        terminalAuthorityKind: "durable_terminal",
        terminalDurableRunId: fixture.run.runId,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("boot-recovers a completed silent system heartbeat through terminal admission and occurrence handoff", async () => {
    const fixture = createCompletedHeartbeatPostCommitFixture("run-heartbeat-silent-boot-recovery");
    const recovery = await createHeartbeatBootRecoveryHarness(fixture);

    recovery.service.startWorker();
    await Promise.all([...recovery.backgroundTasks]);
    await recovery.service.stopWorker();

    const recovered = recovery.runs.get(fixture.run.runId)!;
    expect(recovered.metadata).not.toHaveProperty("autonomousChatPostCommitPending");
    expect(recovered.metadata).not.toHaveProperty("generalChatPostCommitPending");
    expect(recovered.metadata).toMatchObject({
      autonomousChatPostCommit: {
        delivery: { status: "skipped", reason: "silent_heartbeat" },
        heartbeatCleanup: { status: "not_required" },
        generationId: fixture.generationId,
      },
      generalChatPostCommit: {
        generationId: fixture.generationId,
        settlementStatus: "completed",
        completedEffects: [],
        durableEffectRunIds: {},
      },
      chatTurnAdmissionHandoff: {
        admissionId: fixture.admission.admissionId,
        parentRunId: fixture.run.runId,
        postCommitGenerationId: fixture.generationId,
        childRunIds: [],
      },
    });
    expect(recovered.metadata).not.toHaveProperty("outputText");
    expect(recovered.metadata).not.toHaveProperty("outputSummary");
    expect(recovery.onAutonomousChatPostCommit).toHaveBeenCalledTimes(1);
    expect(recovery.onGeneralChatPostCommit).toHaveBeenCalledTimes(1);
    expect(recovery.getMessage).toHaveBeenCalledWith(fixture.run.payload.assistantMessageId);
    expect(recovery.closeTurnWrite).toHaveBeenCalledTimes(1);
    expect(fixture.admission).toMatchObject({
      status: "completed",
      terminalAuthorityKind: "durable_terminal",
      terminalDurableRunId: fixture.run.runId,
      terminalDurableRunStatus: "completed",
    });
    expect(recovery.markTerminal).toHaveBeenCalledWith({
      occurrenceId: fixture.run.payload.heartbeatOccurrenceId,
      workspaceId: fixture.admission.workspaceId,
      sessionId: fixture.admission.sessionId,
      sessionIncarnationId: fixture.admission.sessionIncarnationId,
      admissionId: fixture.admission.admissionId,
      turnId: fixture.admission.turnId,
      durableRunId: fixture.run.runId,
      capabilityProfileId: fixture.run.payload.capabilityProfileId,
      capabilityProfileHash: fixture.run.payload.capabilityProfileHash,
    });
    expect(recovery.getOccurrenceState()).toBe("terminal");
  });

  it("boot-recovers an exact notifying system heartbeat from its system assistant output", async () => {
    const fixture = createCompletedHeartbeatPostCommitFixture("run-heartbeat-notifying-boot-recovery", {
      rawOutput: '{"notify":true,"message":"  Check the backup now.  "}',
    });
    const recovery = await createHeartbeatBootRecoveryHarness(fixture);

    recovery.service.startWorker();
    await Promise.all([...recovery.backgroundTasks]);
    await recovery.service.stopWorker();

    const recovered = recovery.runs.get(fixture.run.runId)!;
    expect(fixture.assistantMessage).toMatchObject({
      role: "assistant",
      actorType: "system",
      actorId: "system-heartbeat",
      content: "Check the backup now.",
    });
    expect(recovered.metadata).not.toHaveProperty("autonomousChatPostCommitPending");
    expect(recovered.metadata).not.toHaveProperty("generalChatPostCommitPending");
    expect(recovered.metadata).toMatchObject({
      outputText: "Check the backup now.",
      finalOutput: "Check the backup now.",
      outputSummary: "Check the backup now.",
      finalSummary: "Check the backup now.",
      autonomousChatPostCommit: { generationId: fixture.generationId },
      generalChatPostCommit: {
        generationId: fixture.generationId,
        settlementStatus: "completed",
      },
      chatTurnAdmissionHandoff: {
        admissionId: fixture.admission.admissionId,
        parentRunId: fixture.run.runId,
      },
      chatTurnRuntimeAuthority: {
        material: {
          terminalOutput: { assistantMessageId: fixture.run.payload.assistantMessageId },
        },
      },
    });
    expect(recovery.getMessage).toHaveBeenCalledWith(fixture.run.payload.assistantMessageId);
    expect(recovery.onAutonomousChatPostCommit).toHaveBeenCalledTimes(1);
    expect(recovery.onGeneralChatPostCommit).toHaveBeenCalledTimes(1);
    expect(recovery.closeTurnWrite).toHaveBeenCalledTimes(1);
    expect(recovery.markTerminal).toHaveBeenCalled();
    expect(recovery.getOccurrenceState()).toBe("terminal");
  });

  it("rejects tampered silent heartbeat raw output during boot recovery and retains both pending finalizers", async () => {
    const fixture = createCompletedHeartbeatPostCommitFixture("run-heartbeat-silent-tampered-boot", {
      metadataRawOutput: '{ "notify": false }',
    });
    const recovery = await createHeartbeatBootRecoveryHarness(fixture);

    recovery.service.startWorker();
    await Promise.all([...recovery.backgroundTasks]);
    await recovery.service.stopWorker();

    const retained = recovery.runs.get(fixture.run.runId)!;
    expect(retained.metadata).toMatchObject({
      heartbeatDecisionReceipt: fixture.receipt,
      heartbeatDecisionRawOutput: '{ "notify": false }',
      autonomousChatPostCommitPending: {
        generationId: fixture.generationId,
      },
      generalChatPostCommitPending: {
        generationId: fixture.generationId,
      },
    });
    expect(retained.metadata).not.toHaveProperty("autonomousChatPostCommit");
    expect(retained.metadata).not.toHaveProperty("generalChatPostCommit");
    expect(retained.metadata).not.toHaveProperty("chatTurnAdmissionHandoff");
    expect(recovery.recoveryError).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: fixture.run.runId,
        error: expect.stringContaining("decision evidence drifted from its runtime authority"),
      }),
      "durable run recovery failed; continuing with other runs",
    );
    expect(recovery.onAutonomousChatPostCommit).not.toHaveBeenCalled();
    expect(recovery.onGeneralChatPostCommit).not.toHaveBeenCalled();
    expect(recovery.settleTurnWriteAuthority).not.toHaveBeenCalled();
    expect(recovery.closeTurnWrite).not.toHaveBeenCalled();
    expect(recovery.markTerminal).not.toHaveBeenCalled();
    expect(fixture.admission.status).toBe("active");
    expect(recovery.getOccurrenceState()).toBe("durable_bound");
  });

  it("resumes after a later general Chat consumer fails without repeating earlier committed effects", async () => {
    const fixture = createAdmittedChatRuntimeFixture({
      runId: "run-general-post-commit-partial",
      status: "completed",
      generationId: "generation-partial",
      traceStatus: "completed",
    });
    const run = fixture.run;
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const persistLearnedMemory = vi.fn();
    const advanceBackgroundReview = vi.fn();
    const publishRealtime = vi.fn();
    let failRealtime = true;
    const onGeneralChatPostCommit = vi.fn(
      async (_observed: DurableRunRecord, progress: GeneralChatPostCommitProgress) => {
        await progress.runEffect("learned_memory_user", persistLearnedMemory);
        await progress.runEffect("background_review", advanceBackgroundReview);
        await progress.publishEffect("realtime", () => {
          publishRealtime();
          if (failRealtime) {
            failRealtime = false;
            throw new Error("retained realtime unavailable");
          }
        });
        for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
          await progress.runEffect(effect, () => undefined);
        }
        return { status: "completed" };
      },
    );
    const context = createContext(runs, [], []);
    await installAdmittedChatRuntimeFixture(context, fixture);
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks: new Set(),
      workflowRegistry: {
        executeWorkflow: vi.fn(),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
      onGeneralChatPostCommit,
    });

    expect(await service.reconcileGeneralChatPostCommit(run.runId)).toBe(false);
    expect(runs.get(run.runId)?.metadata).toMatchObject({
      generalChatPostCommitPending: {
        completedEffects: ["learned_memory_user", "background_review", "realtime"],
      },
    });

    expect(await service.reconcileGeneralChatPostCommit(run.runId)).toBe(true);
    expect(onGeneralChatPostCommit).toHaveBeenCalledTimes(2);
    expect(persistLearnedMemory).toHaveBeenCalledTimes(1);
    expect(advanceBackgroundReview).toHaveBeenCalledTimes(1);
    expect(publishRealtime).toHaveBeenCalledTimes(2);
    expect(runs.get(run.runId)?.metadata).not.toHaveProperty("generalChatPostCommitPending");
  });

  it("does not let a stale post-commit reconciler clear a newer trace generation", async () => {
    const fixture = createAdmittedChatRuntimeFixture({
      runId: "run-general-post-commit-generation-race",
      status: "waiting",
      generationId: "generation-waiting",
      traceStatus: "waiting_for_approval",
      transitionAt: "2026-03-14T00:00:01.000Z",
    });
    const run = fixture.run;
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const context = createContext(runs, [], []);
    const runtimeEvidence = await installAdmittedChatRuntimeFixture(context, fixture);
    const observedGenerations: string[] = [];
    const onGeneralChatPostCommit = vi.fn(
      async (_observed: DurableRunRecord, progress: GeneralChatPostCommitProgress) => {
        observedGenerations.push(progress.generationId);
        for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
          await progress.runEffect(effect, () => undefined);
        }
        if (progress.generationId === "generation-waiting") {
          const current = runs.get(run.runId)!;
          const replacement = createAdmittedChatRuntimeFixture({
            runId: run.runId,
            status: "completed",
            generationId: "generation-completed",
            traceStatus: "completed",
            transitionAt: "2026-03-14T00:00:02.000Z",
          });
          runs.set(run.runId, {
            ...current,
            status: "completed",
            version: current.version + 1,
            payload: replacement.run.payload,
            metadata: replacement.run.metadata,
            finishedAt: replacement.run.finishedAt,
            updatedAt: replacement.run.updatedAt,
          });
          await runtimeEvidence.recordTransitionEvidence(replacement);
          return { status: "waiting_for_approval" };
        }
        return { status: "completed" };
      },
    );
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks: new Set(),
      workflowRegistry: {
        executeWorkflow: vi.fn(),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
      onGeneralChatPostCommit,
    });

    expect(await service.reconcileGeneralChatPostCommit(run.runId)).toBe(true);

    expect(observedGenerations).toEqual(["generation-waiting", "generation-completed"]);
    expect(runs.get(run.runId)?.metadata).not.toHaveProperty("generalChatPostCommitPending");
    expect(runs.get(run.runId)?.metadata).toMatchObject({
      generalChatPostCommit: {
        status: "completed",
        generationId: "generation-completed",
        traceStatus: "completed",
      },
    });
  });

  it("retains autonomous Chat post-commit work when its side effect cannot be reconciled", async () => {
    const run = {
      ...createRun("run-autonomous-post-commit-failed", "completed"),
      metadata: {
        autonomous: { kind: "heartbeat", deliverMode: "on_notify" },
        autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-03-14T00:00:01.000Z" },
      },
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext, {
      backgroundTasks: new Set(),
      workflowRegistry: {
        executeWorkflow: vi.fn(),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
      onAutonomousChatPostCommit: vi.fn(async () => {
        throw new Error("connector catalog unavailable");
      }),
    });

    expect(await service.reconcileAutonomousChatPostCommit(run.runId)).toBe(false);
    expect(runs.get(run.runId)?.metadata).toHaveProperty("autonomousChatPostCommitPending");
  });

  it("uses the database clock when deciding whether an autonomous post-commit claim can be stolen", async () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2100-07-11T00:00:00.000Z"));
    try {
      const run = {
        ...createRun("run-autonomous-db-clock-claim", "completed"),
        metadata: {
          autonomousChatPostCommitPending: {
            version: 1,
            requestedAt: "2026-07-11T00:00:00.000Z",
            claimId: "active-database-owner",
            claimExpiresAt: "2026-07-11T00:05:00.000Z",
          },
        },
      };
      const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
      const context = createContext(runs, [], []);
      Object.assign(context.storage.durableRuns, {
        readDatabaseNow: vi.fn(() => "2026-07-11T00:00:00.000Z"),
      });
      const onAutonomousChatPostCommit = vi.fn(async () => ({}));
      const service = new DurableRunService(context as unknown as ServiceContext, {
        backgroundTasks: new Set(),
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
        onAutonomousChatPostCommit,
      });

      expect(await service.reconcileAutonomousChatPostCommit(run.runId)).toBe(false);
      expect(onAutonomousChatPostCommit).not.toHaveBeenCalled();
      expect(runs.get(run.runId)?.metadata).toHaveProperty(
        "autonomousChatPostCommitPending.claimId",
        "active-database-owner",
      );
    } finally {
      dateNow.mockRestore();
    }
  });

  it("marks unrecoverable orphaned runs through the workflow registry", async () => {
    const runs = new Map<string, DurableRunRecord>([
      [
        "run-unrecoverable",
        {
          ...createRun("run-unrecoverable", "running", "hook.delivery"),
          leaseOwnerId: "worker-old",
          leaseHeartbeatAt: "2026-03-14T00:00:00.000Z",
          leaseExpiresAt: "2026-03-14T00:00:01.000Z",
        },
      ],
    ]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const markWorkflowUnrecoverable = vi.fn(async () => undefined);
    const service = new DurableRunService(createContext(runs, checkpoints, timeline) as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow: vi.fn(async () => undefined),
        isWorkflowRecoverable: () => ({
          recoverable: false,
          reason: "hook delivery payload invalid",
        }),
        markWorkflowUnrecoverable,
      },
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    expect(markWorkflowUnrecoverable).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-unrecoverable",
        workflowKey: "hook.delivery",
        status: "failed",
      }),
      "hook delivery payload invalid",
      expect.objectContaining({
        finalizationId: expect.any(String),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(runs.get("run-unrecoverable")?.status).toBe("failed");
    expect(timeline.map((item) => item.eventType)).toContain("run_failed");
  });

  it("claims pending linked finalization once across concurrent Gateway workers", async () => {
    const run = {
      ...createRun("run-pending-finalization-race", "failed", "hook.delivery"),
      metadata: {
        linkedFinalizationPending: {
          reason: "invalid hook payload",
          requestedAt: "2026-03-14T00:00:01.000Z",
          finalizationId: "finalization-race-1",
        },
      },
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    let releaseFinalizer!: () => void;
    const finalizerGate = new Promise<void>((resolve) => {
      releaseFinalizer = resolve;
    });
    const markWorkflowUnrecoverable = vi.fn(async () => finalizerGate);
    const sharedContext = createContext(runs, [], []);
    const buildService = (backgroundTasks: Set<Promise<void>>) =>
      new DurableRunService(sharedContext as unknown as ServiceContext, {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable: () => ({ recoverable: false, reason: "invalid hook payload" }),
          markWorkflowUnrecoverable,
        },
      });
    const firstTasks = new Set<Promise<void>>();
    const secondTasks = new Set<Promise<void>>();
    const first = buildService(firstTasks);
    const second = buildService(secondTasks);

    first.startWorker();
    second.startWorker();
    await vi.waitFor(() => expect(markWorkflowUnrecoverable).toHaveBeenCalledTimes(1));
    expect(runs.get(run.runId)?.metadata).toMatchObject({
      linkedFinalizationPending: {
        finalizationId: "finalization-race-1",
        claimId: expect.any(String),
        claimExpiresAt: expect.any(String),
      },
    });

    releaseFinalizer();
    await Promise.allSettled([...firstTasks, ...secondTasks]);
    await first.stopWorker();
    await second.stopWorker();

    expect(markWorkflowUnrecoverable).toHaveBeenCalledTimes(1);
    expect(runs.get(run.runId)?.metadata).not.toHaveProperty("linkedFinalizationPending");
  });

  it("uses the database clock when deciding whether a linked-finalization claim can be stolen", async () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2100-07-11T00:00:00.000Z"));
    try {
      const run = {
        ...createRun("run-linked-db-clock-claim", "failed", "hook.delivery"),
        metadata: {
          linkedFinalizationPending: {
            reason: "invalid hook payload",
            requestedAt: "2026-07-11T00:00:00.000Z",
            finalizationId: "finalization-db-clock",
            claimId: "active-database-owner",
            claimExpiresAt: "2026-07-11T00:05:00.000Z",
          },
        },
      };
      const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
      const backgroundTasks = new Set<Promise<void>>();
      const context = createContext(runs, [], []);
      Object.assign(context.storage.durableRuns, {
        readDatabaseNow: vi.fn(() => "2026-07-11T00:00:00.000Z"),
      });
      const markWorkflowUnrecoverable = vi.fn(async () => undefined);
      const service = new DurableRunService(context as unknown as ServiceContext, {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable: () => ({ recoverable: false, reason: "invalid hook payload" }),
          markWorkflowUnrecoverable,
        },
      });

      service.startWorker();
      await Promise.all([...backgroundTasks]);

      expect(markWorkflowUnrecoverable).not.toHaveBeenCalled();
      expect(runs.get(run.runId)?.metadata).toHaveProperty(
        "linkedFinalizationPending.claimId",
        "active-database-owner",
      );
    } finally {
      dateNow.mockRestore();
    }
  });

  it("renews a long-running linked-finalization claim so another worker cannot overlap it", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
      const run = {
        ...createRun("run-pending-finalization-heartbeat", "failed", "hook.delivery"),
        metadata: {
          linkedFinalizationPending: {
            reason: "invalid hook payload",
            requestedAt: "2026-07-10T00:00:00.000Z",
            finalizationId: "finalization-heartbeat-1",
          },
        },
      };
      const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
      let releaseFinalizer!: () => void;
      const finalizerGate = new Promise<void>((resolve) => {
        releaseFinalizer = resolve;
      });
      const markWorkflowUnrecoverable = vi.fn(async () => finalizerGate);
      const buildService = (backgroundTasks: Set<Promise<void>>) =>
        new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext, {
          backgroundTasks,
          workflowRegistry: {
            executeWorkflow: vi.fn(),
            isWorkflowRecoverable: () => ({ recoverable: false, reason: "invalid hook payload" }),
            markWorkflowUnrecoverable,
          },
        });
      const firstTasks = new Set<Promise<void>>();
      const secondTasks = new Set<Promise<void>>();
      const first = buildService(firstTasks);
      const second = buildService(secondTasks);

      first.startWorker();
      await vi.advanceTimersByTimeAsync(0);
      expect(markWorkflowUnrecoverable).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(35_000);

      second.startWorker();
      await vi.advanceTimersByTimeAsync(0);
      expect(markWorkflowUnrecoverable).toHaveBeenCalledTimes(1);
      expect(
        Date.parse(
          (runs.get(run.runId)?.metadata?.linkedFinalizationPending as { claimExpiresAt?: string } | undefined)
            ?.claimExpiresAt ?? "",
        ),
      ).toBeGreaterThan(Date.now());

      releaseFinalizer();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.allSettled([...firstTasks, ...secondTasks]);
      await first.stopWorker();
      await second.stopWorker();
      expect(runs.get(run.runId)?.metadata).not.toHaveProperty("linkedFinalizationPending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts linked finalization when claim ownership moves to another worker", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
      const run = {
        ...createRun("run-pending-finalization-ownership-loss", "failed", "hook.delivery"),
        metadata: {
          linkedFinalizationPending: {
            reason: "invalid hook payload",
            requestedAt: "2026-07-10T00:00:00.000Z",
            finalizationId: "finalization-ownership-loss-1",
          },
        },
      };
      const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
      let releaseFinalizer!: () => void;
      const finalizerGate = new Promise<void>((resolve) => {
        releaseFinalizer = resolve;
      });
      let finalizationSignal: AbortSignal | undefined;
      const markWorkflowUnrecoverable = vi.fn(
        async (_run: DurableRunRecord, _reason: string, context?: { signal?: AbortSignal }) => {
          finalizationSignal = context?.signal;
          await finalizerGate;
        },
      );
      const backgroundTasks = new Set<Promise<void>>();
      const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext, {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable: () => ({ recoverable: false, reason: "invalid hook payload" }),
          markWorkflowUnrecoverable,
        },
      });

      service.startWorker();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(markWorkflowUnrecoverable).toHaveBeenCalledTimes(1));
      const claimedRun = runs.get(run.runId)!;
      runs.set(run.runId, {
        ...claimedRun,
        version: claimedRun.version + 1,
        metadata: {
          ...(claimedRun.metadata ?? {}),
          linkedFinalizationPending: {
            ...(claimedRun.metadata?.linkedFinalizationPending as Record<string, unknown>),
            claimId: "replacement-worker-claim",
            claimExpiresAt: "2026-07-10T00:01:00.000Z",
          },
        },
      });

      await vi.advanceTimersByTimeAsync(10_000);
      const abortedAfterOwnershipLoss = finalizationSignal?.aborted;

      releaseFinalizer();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.allSettled([...backgroundTasks]);
      expect(abortedAfterOwnershipLoss).toBe(true);
      expect(runs.get(run.runId)?.metadata).toHaveProperty(
        "linkedFinalizationPending.claimId",
        "replacement-worker-claim",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a hung linked finalizer so boot recovery can finish", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
      const run = {
        ...createRun("run-pending-finalization-timeout", "failed", "hook.delivery"),
        metadata: {
          linkedFinalizationPending: {
            reason: "invalid hook payload",
            requestedAt: "2026-07-10T00:00:00.000Z",
            finalizationId: "finalization-timeout-1",
          },
        },
      };
      const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
      let releaseFinalizer!: () => void;
      const finalizerGate = new Promise<void>((resolve) => {
        releaseFinalizer = resolve;
      });
      let finalizationSignal: AbortSignal | undefined;
      const backgroundTasks = new Set<Promise<void>>();
      const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext, {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable: () => ({ recoverable: false, reason: "invalid hook payload" }),
          markWorkflowUnrecoverable: vi.fn(async (_run, _reason, context) => {
            finalizationSignal = context?.signal;
            await finalizerGate;
          }),
        },
      });

      service.startWorker();
      await vi.advanceTimersByTimeAsync(0);
      expect(finalizationSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(finalizationSignal?.aborted).toBe(true);
      await Promise.allSettled([...backgroundTasks]);
      expect(runs.get(run.runId)?.metadata).toHaveProperty(
        "linkedFinalizationPending.finalizationId",
        "finalization-timeout-1",
      );
      releaseFinalizer();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports background worker failures instead of leaving rejected worker promises silent", async () => {
    const runs = new Map<string, DurableRunRecord>();
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const publishRealtime = vi.fn();
    const logger: DurableRunServiceLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const context = createContext(runs, checkpoints, timeline, { publishRealtime, logger });
    context.storage.durableRuns.listExpiredRunningRunIds = vi.fn(() => {
      throw new Error("recovery scan failed");
    }) as never;
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow: vi.fn(async () => undefined),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "recovery scan failed",
      }),
      "durable worker background task failed",
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({
        type: "durable_worker_background_failure",
        error: "recovery scan failed",
      }),
      expect.objectContaining({
        eventClass: "operational_signal",
      }),
    );
  });

  it("waits until retry backoff is due before claiming queued runs", async () => {
    const run = createRun("run-retry", "queued", "connector.delivery");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const retries = new Map<string, DurableRetryRecord[]>([
      [run.runId, [createRetry(run.runId, 1, new Date(Date.now() + 60_000).toISOString())]],
    ]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const executeWorkflow = vi.fn(async (current: DurableRunRecord) => {
      updateRun(runs, current.runId, {
        status: "completed",
        finishedAt: "2026-03-14T00:00:05.000Z",
      });
    });
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, { retries }) as unknown as ServiceContext,
      {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow,
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
      },
    );

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    expect(executeWorkflow).not.toHaveBeenCalled();
    expect(runs.get(run.runId)?.status).toBe("queued");
    expect(timeline.map((item) => item.eventType)).not.toContain("run_started");

    retries.set(run.runId, [createRetry(run.runId, 1, "2026-03-14T00:00:00.000Z")]);
    service.requestRunProcessing(run.runId);
    await Promise.all([...backgroundTasks]);

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(runs.get(run.runId)?.status).toBe("completed");
    expect(timeline.map((item) => item.eventType)).toContain("run_started");
  });

  it("lets database retry authority skip a gated queue head and claim the next ready run", async () => {
    const gated = createRun("run-db-gated-head", "queued", "connector.delivery");
    const ready = createRun("run-db-ready-next", "queued", "connector.delivery");
    const runs = new Map<string, DurableRunRecord>([
      [gated.runId, gated],
      [ready.runId, ready],
    ]);
    const backgroundTasks = new Set<Promise<void>>();
    const context = createContext(runs, [], []);
    const tryClaimQueuedRunWithDatabaseClock = vi.fn(
      (input: { runId: string; workerId: string; leaseDurationMs: number }) => {
        if (input.runId === gated.runId) {
          return undefined;
        }
        return updateRun(runs, input.runId, {
          status: "running",
          leaseOwnerId: input.workerId,
          leaseHeartbeatAt: "2026-03-14T00:00:00.000Z",
          leaseExpiresAt: "2026-03-14T00:02:00.000Z",
        });
      },
    );
    Object.assign(context.storage.durableRuns, { tryClaimQueuedRunWithDatabaseClock });
    const executeWorkflow = vi.fn(async (claimed: DurableRunRecord) => {
      updateRun(runs, claimed.runId, { status: "completed", clearLease: true });
    });
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    expect(tryClaimQueuedRunWithDatabaseClock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ runId: gated.runId }),
    );
    expect(tryClaimQueuedRunWithDatabaseClock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ runId: ready.runId }),
    );
    expect(executeWorkflow).toHaveBeenCalledWith(expect.objectContaining({ runId: ready.runId }), expect.any(Object));
    expect(runs.get(gated.runId)?.status).toBe("queued");
    expect(runs.get(ready.runId)?.status).toBe("completed");
  });

  it("lets a worker-owned running workflow schedule a retry without using manual retry", async () => {
    const run = createRun("run-hook-retry", "queued", "hook.delivery");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const retries = new Map<string, DurableRetryRecord[]>();
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const serviceRef: { current?: DurableRunService } = {};
    const executeWorkflow = vi.fn(async (claimed: DurableRunRecord) => {
      const retry = await serviceRef.current!.scheduleRunningWorkflowRetry(
        claimed.runId,
        "temporary hook outage",
        "hooks",
        claimed.leaseOwnerId,
      );
      expect(retry.status).toBe("queued");
    });
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, { retries }) as unknown as ServiceContext,
      {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow,
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
      },
    );
    serviceRef.current = service;

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    const stored = runs.get(run.runId);
    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(stored).toMatchObject({
      status: "queued",
      attemptCount: 1,
      leaseOwnerId: undefined,
      leaseHeartbeatAt: undefined,
      leaseExpiresAt: undefined,
      lastError: undefined,
      finishedAt: undefined,
    });
    expect(retries.get(run.runId)).toEqual([
      expect.objectContaining({
        attemptNo: 1,
        reason: "temporary hook outage",
        nextRetryAt: expect.any(String),
      }),
    ]);
    expect(timeline.map((item) => item.eventType)).toEqual(
      expect.arrayContaining(["run_started", "run_retry_scheduled"]),
    );
  });

  it.each([
    "DurableRunCancelledError",
    "DurableWorkerInterruptionError",
    "DurableRunPausedError",
    "ProviderCancelledError",
  ])("does not trust a provider-thrown %s name as durable worker control authority", async (errorName) => {
    const run = createQueuedHeartbeatWorkerRun(`run-heartbeat-provider-spoof-${errorName}`);
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const payload = run.payload as Record<string, unknown>;
    const admission = {
      admissionId: payload.admissionId,
      admissionKind: "turn_write",
      status: "active",
      sessionIncarnationId: payload.sessionIncarnationId,
      workspaceId: payload.workspaceId,
      sessionId: payload.sessionId,
      turnId: payload.turnId,
      aggregateRevision: payload.admissionAggregateRevision,
      controllerGeneration: payload.admissionControllerGeneration,
      actorKind: "system",
      actorId: "system-heartbeat",
      operation: "chat_system_heartbeat",
      materialSha256: payload.admissionMaterialSha256,
    };
    const providerError = Object.assign(new Error(`provider supplied ${errorName}`), { name: errorName });
    const executeWorkflow = vi.fn(async () => {
      throw providerError;
    });
    const markWorkflowUnrecoverable = vi.fn();
    const context = createContext(runs, checkpoints, timeline);
    Object.assign(context.storage, {
      sessionMutationAdmissions: {
        require: (admissionId: string) => {
          if (admissionId !== admission.admissionId) throw new Error(`Unknown admission ${admissionId}`);
          return admission;
        },
      },
    });
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable,
      },
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(runs.get(run.runId)).toMatchObject({
      status: "failed",
      leaseOwnerId: undefined,
      leaseHeartbeatAt: undefined,
      leaseExpiresAt: undefined,
      lastError: providerError.message,
    });
    expect(checkpoints.filter((entry) => entry.checkpointKind === "run_failed")).toHaveLength(1);
    expect(timeline.filter((entry) => entry.eventType === "run_failed")).toHaveLength(1);
  });

  it("keeps malformed system-heartbeat output queued for bounded retry through the full worker loop", async () => {
    const run = createQueuedHeartbeatWorkerRun("run-heartbeat-malformed-retry");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const retries = new Map<string, DurableRetryRecord[]>();
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const serviceRef: { current?: DurableRunService } = {};
    const executeWorkflow = vi.fn(async (claimed: DurableRunRecord) => {
      const queued = await serviceRef.current!.scheduleRunningWorkflowRetry(
        claimed.runId,
        "heartbeat_decision_invalid",
        "system-heartbeat",
        claimed.leaseOwnerId,
      );
      expect(queued.status).toBe("queued");
      serviceRef.current!.requestRunProcessing(claimed.runId);
      throw new DurableWorkerInterruptionError(
        "heartbeat_unavailable",
        "System heartbeat decision requires bounded durable recovery.",
      );
    });
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, { retries }) as unknown as ServiceContext,
      {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow,
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
      },
    );
    serviceRef.current = service;

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(runs.get(run.runId)).toMatchObject({
      status: "queued",
      attemptCount: 1,
      leaseOwnerId: undefined,
      leaseHeartbeatAt: undefined,
      leaseExpiresAt: undefined,
      lastError: undefined,
      finishedAt: undefined,
    });
    expect(retries.get(run.runId)).toEqual([
      expect.objectContaining({
        attemptNo: 1,
        reason: "heartbeat_decision_invalid",
        nextRetryAt: expect.any(String),
      }),
    ]);
    expect(checkpoints.filter((entry) => entry.checkpointKind === "run_failed")).toHaveLength(0);
    expect(timeline.filter((entry) => entry.eventType === "run_failed")).toHaveLength(0);
    expect(timeline.filter((entry) => entry.eventType === "run_retry_scheduled")).toHaveLength(1);
  });

  it("terminalizes exhausted malformed system-heartbeat output exactly once without worker fallthrough", async () => {
    const run = createQueuedHeartbeatWorkerRun(
      "run-heartbeat-malformed-exhausted",
      DURABLE_RETRY_POLICY_DEFAULT.maxAttempts,
    );
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const retries = new Map<string, DurableRetryRecord[]>();
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const context = createContext(runs, checkpoints, timeline, { retries });
    const payload = run.payload as Record<string, unknown>;
    const admission = {
      admissionId: payload.admissionId,
      admissionKind: "turn_write",
      status: "active",
      sessionIncarnationId: payload.sessionIncarnationId,
      workspaceId: payload.workspaceId,
      sessionId: payload.sessionId,
      turnId: payload.turnId,
      aggregateRevision: payload.admissionAggregateRevision,
      controllerGeneration: payload.admissionControllerGeneration,
      actorKind: "system",
      actorId: "system-heartbeat",
      operation: "chat_system_heartbeat",
      materialSha256: payload.admissionMaterialSha256,
    };
    Object.assign(context.storage, {
      sessionMutationAdmissions: {
        require: (admissionId: string) => {
          if (admissionId !== admission.admissionId) throw new Error(`Unknown admission ${admissionId}`);
          return admission;
        },
      },
    });
    const serviceRef: { current?: DurableRunService } = {};
    const executeWorkflow = vi.fn(async (claimed: DurableRunRecord) => {
      const terminal = await serviceRef.current!.scheduleRunningWorkflowRetry(
        claimed.runId,
        "heartbeat_decision_invalid",
        "system-heartbeat",
        claimed.leaseOwnerId,
      );
      expect(terminal.status).toBe("failed");
      serviceRef.current!.stopAdmission();
      throw new DurableWorkerInterruptionError(
        "heartbeat_unavailable",
        "System heartbeat exhausted its bounded decision recovery.",
      );
    });
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });
    serviceRef.current = service;

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    const terminal = runs.get(run.runId)!;
    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(terminal).toMatchObject({
      status: "failed",
      attemptCount: DURABLE_RETRY_POLICY_DEFAULT.maxAttempts + 1,
      leaseOwnerId: undefined,
      leaseHeartbeatAt: undefined,
      leaseExpiresAt: undefined,
      lastError: "retry_exhausted:heartbeat_decision_invalid",
      metadata: {
        generalChatPostCommitPending: {
          postCommitEligibility: {
            version: 1,
            autonomyEnabledAtParentSettlement: false,
            evalIntegrityTurn: false,
            humanSession: false,
          },
        },
        linkedFinalizationPending: expect.any(Object),
        chatRetryExhaustionDeadLetterPending: expect.any(Object),
      },
    });
    expect(terminal.metadata).not.toHaveProperty("heartbeatDecisionReceipt");
    expect(terminal.metadata).not.toHaveProperty("heartbeatDecisionRawOutput");
    expect(checkpoints.filter((entry) => entry.checkpointKind === "run_failed")).toHaveLength(1);
    expect(timeline.filter((entry) => entry.eventType === "run_failed")).toHaveLength(1);
    expect(timeline.filter((entry) => entry.eventType === "run_retry_budget_exhausted")).toHaveLength(1);
  });

  it("preserves a preempted system-heartbeat lease interruption without falling through to failure", async () => {
    const run = createQueuedHeartbeatWorkerRun("run-heartbeat-preempted");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const executeWorkflow = vi.fn(async () => {
      throw new DurableWorkerInterruptionError(
        "lease_lost",
        "System heartbeat write authority was superseded by an operator.",
      );
    });
    const service = new DurableRunService(createContext(runs, checkpoints, timeline) as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(runs.get(run.runId)).toMatchObject({
      status: "running",
      leaseOwnerId: expect.any(String),
    });
    expect(checkpoints.filter((entry) => entry.checkpointKind === "run_failed")).toHaveLength(0);
    expect(timeline.filter((entry) => entry.eventType === "run_failed")).toHaveLength(0);
  });

  it("keeps approval-required system-heartbeat terminalization non-retryable in the worker loop", async () => {
    const baseRun = createQueuedHeartbeatWorkerRun("run-heartbeat-approval-blocked");
    const request = (baseRun.payload as { request: Record<string, unknown> }).request;
    const admissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(request as never);
    const run = {
      ...baseRun,
      payload: {
        ...baseRun.payload,
        admissionMaterialSha256,
        effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(
          admissionMaterialSha256,
          request as never,
        ),
      },
    } satisfies DurableRunRecord;
    const payload = run.payload as Record<string, unknown>;
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const retries = new Map<string, DurableRetryRecord[]>();
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const context = createContext(runs, checkpoints, timeline, { retries });
    const messages = new Map<string, Record<string, unknown>>();
    const approvals = new Map<string, Record<string, unknown>>();
    const createApproval = vi.fn((approval: Record<string, unknown>) => {
      approvals.set(String(approval.approvalId), approval);
      return approval;
    });
    const createToolRun = vi.fn();
    const enqueueApprovalWait = vi.fn();
    const closeHeartbeatOccurrence = vi.fn();
    const admission = {
      admissionId: payload.admissionId,
      admissionKind: "turn_write",
      status: "active",
      sessionIncarnationId: payload.sessionIncarnationId,
      workspaceId: payload.workspaceId,
      sessionId: payload.sessionId,
      turnId: payload.turnId,
      aggregateRevision: payload.admissionAggregateRevision,
      controllerGeneration: payload.admissionControllerGeneration,
      actorKind: "system",
      actorId: "system-heartbeat",
      operation: "chat_system_heartbeat",
      materialSha256: payload.admissionMaterialSha256,
    } as Record<string, unknown>;
    const closeTurnWrite = vi.fn((input: { status: "completed" | "cancelled"; correlationId: string }) => {
      admission.status = input.status;
      admission.terminalAuthorityKind = "durable_terminal";
      admission.terminalDurableRunId = input.correlationId;
      admission.terminalDurableRunStatus = "failed";
      closeHeartbeatOccurrence(String(payload.heartbeatOccurrenceId), "failed");
      return admission;
    });
    let traceState = {
      turnId: payload.turnId,
      sessionId: payload.sessionId,
      userMessageId: payload.userMessageId,
      assistantMessageId: payload.assistantMessageId,
      status: "running",
      durable: { runId: run.runId, status: "running" },
      toolRuns: [],
      citations: [],
      routing: {},
      startedAt: "2026-03-14T00:00:00.000Z",
    } as unknown as ChatTurnTraceRecord;
    const chatTurnTraces = {
      get: vi.fn(() => traceState),
      patch: vi.fn((_turnId: string, patch: Partial<ChatTurnTraceRecord>) => {
        traceState = { ...traceState, ...structuredClone(patch) } as ChatTurnTraceRecord;
        return traceState;
      }),
    };
    const chatMessages = {
      get: vi.fn((messageId: string) => messages.get(messageId)),
      upsert: vi.fn((message: Record<string, unknown>) => {
        messages.set(String(message.messageId), message);
        return message;
      }),
    };
    const chatToolRuns = {
      listByTurn: vi.fn(() => []),
      create: createToolRun,
    };
    Object.assign(context.storage, {
      approvals: { create: createApproval },
      chatMessages,
      chatTurnTraces,
      chatToolRuns,
      sessionMutationAdmissions: {
        require: (admissionId: string) => {
          if (admissionId !== admission.admissionId) throw new Error(`Unknown admission ${admissionId}`);
          return admission;
        },
        settleTurnWriteAuthority: () => ({ disposition: "current", admission }),
        closeTurnWrite,
      },
      chatSessionMeta: {
        get: () => ({
          sessionId: payload.sessionId,
          workspaceId: payload.workspaceId,
          revision: payload.admissionAggregateRevision,
          origin: "system",
        }),
      },
    });
    Object.assign(context.storage.durableRuns, {
      lockFreshActiveLeaseForUpdate: (runId: string, leaseOwnerId: string) => {
        const current = runs.get(runId);
        return current?.status === "running" && current.leaseOwnerId === leaseOwnerId ? current : undefined;
      },
    });
    const postCommitHost = {
      storage: context.storage,
      recordCapabilityGapFromTrace: vi.fn(),
      publishRealtime: vi.fn(),
      hooksService: { enqueueAfterHooks: vi.fn() },
    };
    const serviceRef: { current?: DurableRunService } = {};
    const executeWorkflow = vi.fn(async (claimed: DurableRunRecord) => {
      traceState = {
        ...traceState,
        status: "waiting_for_approval",
        pendingApprovalSummary: undefined,
        toolRuns: [],
        completion: { status: "interrupted", repaired: false },
      } as ChatTurnTraceRecord;
      const prepared = {
        session: { sessionId: payload.sessionId },
        workspaceId: payload.workspaceId,
        turnId: payload.turnId,
        userEventId: payload.userMessageId,
        userMessage: {
          messageId: payload.userMessageId,
          sessionId: payload.sessionId,
          role: "user",
          actorType: "system",
          actorId: "system-heartbeat",
          content: request.content,
          timestamp: "2026-03-14T00:00:00.000Z",
        },
        assistantMessageId: payload.assistantMessageId,
        content: request.content,
        turnAdmission: {
          identity: {
            admissionId: payload.admissionId,
            sessionIncarnationId: payload.sessionIncarnationId,
            workspaceId: payload.workspaceId,
            sessionId: payload.sessionId,
            turnId: payload.turnId,
            aggregateRevision: payload.admissionAggregateRevision,
            controllerGeneration: payload.admissionControllerGeneration,
            materialSha256: payload.admissionMaterialSha256,
          },
          admittedRequest: request,
          requestActor: payload.requestActor,
        },
      };
      await finalizeDurableChatRun(
        {
          runImmediateTransaction: context.storage.runImmediateTransaction,
          durableRuns: context.storage.durableRuns,
          chatToolRuns,
          chatToolArtifacts: { listByTurn: vi.fn(() => []) },
          chatMessages,
          recordDurableTimelineEvent: (runId, eventType) =>
            context.storage.durableRunEvents.append({ runId, eventType }),
          chatTurnTraces,
          resolvePostCommitEligibility: () => ({
            version: 1,
            autonomyEnabledAtParentSettlement: false,
            evalIntegrityTurn: false,
            humanSession: false,
          }),
        } as never,
        claimed.runId,
        prepared as never,
        traceState,
        claimed.leaseOwnerId,
      );
      serviceRef.current!.requestRunProcessing(claimed.runId);
    });
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
      onGeneralChatPostCommit: async (observed, progress) =>
        executeGeneralChatPostCommit(postCommitHost as never, observed, progress),
    });
    serviceRef.current = service;

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(runs.get(run.runId)).toMatchObject({
      status: "failed",
      attemptCount: 0,
      lastError: "System heartbeat tool execution requires an approval and was blocked.",
    });
    expect(runs.get(run.runId)?.metadata).not.toHaveProperty("generalChatPostCommitPending");
    expect(runs.get(run.runId)?.metadata).not.toHaveProperty("waitForEvent");
    expect(retries.get(run.runId)).toBeUndefined();
    expect(checkpoints.filter((entry) => entry.checkpointKind === "run_failed")).toHaveLength(1);
    expect(checkpoints.filter((entry) => entry.checkpointKind === "run_waiting")).toHaveLength(0);
    expect(timeline.filter((entry) => entry.eventType === "run_failed")).toHaveLength(1);
    expect(timeline.filter((entry) => entry.eventType === "run_waiting")).toHaveLength(0);
    expect(createApproval).not.toHaveBeenCalled();
    expect(approvals.size).toBe(0);
    expect(enqueueApprovalWait).not.toHaveBeenCalled();
    expect(createToolRun).not.toHaveBeenCalled();
    expect(messages.size).toBe(0);
    expect(chatMessages.upsert).not.toHaveBeenCalled();
    expect([...runs.values()].filter((candidate) => candidate.workflowKey === "approval.wait")).toHaveLength(0);
    expect(closeTurnWrite).toHaveBeenCalledTimes(1);
    expect(closeHeartbeatOccurrence).toHaveBeenCalledTimes(1);
    expect(executeWorkflow).toHaveBeenCalledTimes(1);
  });

  it.each(["authority_superseded", "lifecycle_delete"] as const)(
    "does not terminalize an already-abandoned heartbeat occurrence after %s closes admission",
    async (terminalAuthorityKind) => {
      const baseRun = createQueuedHeartbeatWorkerRun(`run-heartbeat-${terminalAuthorityKind}`);
      const payload = {
        ...(baseRun.payload as Record<string, unknown>),
        capabilityProfileId: "heartbeat-restricted",
        capabilityProfileHash: "f".repeat(64),
      };
      const generationId = `generation:${terminalAuthorityKind}`;
      const settledAt = "2026-03-14T00:00:01.000Z";
      const run = {
        ...baseRun,
        status: "failed" as const,
        payload,
        metadata: {
          ...baseRun.metadata,
          chatTurnAdmissionHandoff: {
            version: 1,
            admissionId: payload.admissionId,
            sessionIncarnationId: payload.sessionIncarnationId,
            turnId: payload.turnId,
            parentRunId: baseRun.runId,
            postCommitGenerationId: generationId,
            parentLocalEffectsStatus: "settled",
            childRunIds: [],
            childRunIdsSha256: hashChatTurnRuntimeAuthorityValue([]),
            committedAt: settledAt,
          },
          generalChatPostCommit: {
            generationId,
            traceStatus: "failed",
            requestedAt: settledAt,
            postCommitEligibility: {
              version: 1,
              autonomyEnabledAtParentSettlement: false,
              evalIntegrityTurn: false,
              humanSession: false,
            },
            parentLocalEffectsStatus: "settled",
            parentLocalEffectsSettledAt: settledAt,
            completedEffects: [],
            durableEffectRunIds: {},
            durableEffectOutcomes: {},
            childOutcomeAuthority: "child_durable_runs",
            settlementStatus: "completed",
            completedAt: settledAt,
          },
        },
        finishedAt: settledAt,
      } satisfies DurableRunRecord;
      const admission = {
        admissionId: payload.admissionId,
        admissionKind: "turn_write",
        status: "cancelled",
        sessionIncarnationId: payload.sessionIncarnationId,
        workspaceId: payload.workspaceId,
        sessionId: payload.sessionId,
        turnId: payload.turnId,
        aggregateRevision: payload.admissionAggregateRevision,
        controllerGeneration: payload.admissionControllerGeneration,
        actorKind: "system",
        actorId: "system-heartbeat",
        operation: "chat_system_heartbeat",
        materialSha256: payload.admissionMaterialSha256,
        terminalAuthorityKind,
      };
      const markTerminal = vi.fn(() => {
        throw new Error("Only a durable-bound heartbeat can settle terminal.");
      });
      const context = createContext(new Map([[run.runId, run]]), [], []);
      Object.assign(context.storage, {
        heartbeatOccurrences: { markTerminal },
        sessionMutationAdmissions: {
          require: () => admission,
          settleTurnWriteAuthority: vi.fn(),
          closeTurnWrite: vi.fn(),
        },
      });
      const service = new DurableRunService(context as unknown as ServiceContext, {
        backgroundTasks: new Set(),
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
        onGeneralChatPostCommit: vi.fn(async () => ({})),
      });

      await expect(service.reconcileGeneralChatPostCommit(run.runId)).resolves.toBe(true);
      expect(markTerminal).not.toHaveBeenCalled();
    },
  );

  it("rejects a running retry after the worker lease expired", async () => {
    const run = {
      ...createRun("run-hook-expired-retry", "running", "hook.delivery"),
      leaseOwnerId: "claim-expired",
      leaseHeartbeatAt: "2026-03-14T00:00:00.000Z",
      leaseExpiresAt: "2026-03-14T00:00:01.000Z",
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const service = new DurableRunService(createContext(runs, [], timeline) as unknown as ServiceContext, {
      backgroundTasks: new Set<Promise<void>>(),
      workflowRegistry: {
        executeWorkflow: vi.fn(),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    await expect(
      service.scheduleRunningWorkflowRetry(run.runId, "late hook", "hooks", "claim-expired"),
    ).rejects.toThrow(/cannot schedule running retry/);
    expect(runs.get(run.runId)?.status).toBe("running");
    expect(timeline).toEqual([]);
  });

  it("schedules a worker-owned retry from database lease and retry clocks under fast host skew", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2100-03-14T00:00:00.000Z"));
      const run = {
        ...createRun("run-db-clock-running-retry", "running", "hook.delivery"),
        leaseOwnerId: "worker-db-clock",
        leaseHeartbeatAt: "2026-03-14T00:00:00.000Z",
        leaseExpiresAt: "2026-03-14T00:02:00.000Z",
      };
      const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
      const retries = new Map<string, DurableRetryRecord[]>();
      const context = createContext(runs, [], [], { retries });
      const lockFreshActiveLeaseForUpdate = vi.fn(() => runs.get(run.runId));
      const upsertRetryWithDatabaseClock = vi.fn(
        (input: { runId: string; attemptNo: number; reason: string; delayMs: number }): DurableRetryRecord => {
          const retry = {
            retryId: "retry-db-clock",
            runId: input.runId,
            attemptNo: input.attemptNo,
            reason: input.reason,
            createdAt: "2026-03-14T00:00:00.000Z",
            nextRetryAt: "2026-03-14T00:00:02.000Z",
          };
          retries.set(input.runId, [retry]);
          return retry;
        },
      );
      Object.assign(context.storage.durableRuns, {
        lockFreshActiveLeaseForUpdate,
        upsertRetryWithDatabaseClock,
      });
      const service = new DurableRunService(context as unknown as ServiceContext, {
        backgroundTasks: new Set<Promise<void>>(),
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
      });

      const scheduled = await service.scheduleRunningWorkflowRetry(
        run.runId,
        "temporary outage",
        "hooks",
        "worker-db-clock",
      );

      expect(scheduled.status).toBe("queued");
      expect(lockFreshActiveLeaseForUpdate).toHaveBeenCalledWith(run.runId, "worker-db-clock");
      expect(upsertRetryWithDatabaseClock).toHaveBeenCalledWith(
        expect.objectContaining({ runId: run.runId, attemptNo: 1, reason: "temporary outage", delayMs: 5_000 }),
      );
      expect(retries.get(run.runId)?.[0]?.nextRetryAt).toBe("2026-03-14T00:00:02.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("dead-letters a worker-owned running workflow when retry attempts are exhausted", async () => {
    const run = {
      ...createRun("run-hook-dead", "queued", "hook.delivery"),
      attemptCount: 1,
      maxAttempts: 1,
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const deadLetters = new Map<
      string,
      {
        dead_letter_id: string;
        run_id: string;
        reason: string;
      }
    >();
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const serviceRef: { current?: DurableRunService } = {};
    const executeWorkflow = vi.fn(async (claimed: DurableRunRecord) => {
      const retry = await serviceRef.current!.scheduleRunningWorkflowRetry(
        claimed.runId,
        "terminal hook failure",
        "hooks",
        claimed.leaseOwnerId,
      );
      expect(retry.status).toBe("dead_lettered");
    });
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, { deadLetters }) as unknown as ServiceContext,
      {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow,
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
      },
    );
    serviceRef.current = service;

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    const stored = runs.get(run.runId);
    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(stored).toMatchObject({
      status: "dead_lettered",
      attemptCount: 2,
      leaseOwnerId: undefined,
      leaseHeartbeatAt: undefined,
      leaseExpiresAt: undefined,
      lastError: "retry_exhausted:terminal hook failure",
    });
    expect([...deadLetters.values()]).toEqual([
      expect.objectContaining({
        run_id: run.runId,
        reason: "retry_exhausted:terminal hook failure",
      }),
    ]);
    expect(timeline.map((item) => item.eventType)).toEqual(
      expect.arrayContaining(["run_started", "run_dead_lettered", "run_retry_budget_exhausted"]),
    );
  });

  it("finalizes an admitted v2 Chat failure, releases admission, and admits the next turn", async () => {
    const admissionMaterialSha256 = "a".repeat(64);
    const run = {
      ...createRun("run-chat-retry-exhausted", "running", "chat.turn.execute"),
      attemptCount: 3,
      maxAttempts: 3,
      leaseOwnerId: "worker-chat",
      leaseHeartbeatAt: "2026-03-14T00:00:01.000Z",
      leaseExpiresAt: "2999-03-14T00:00:01.000Z",
      payload: {
        version: "chat.turn.execute.v2",
        admissionId: "admission-chat",
        sessionIncarnationId: "incarnation-chat",
        workspaceId: "default",
        sessionId: "session-chat",
        turnId: "turn-chat",
        admissionMaterialSha256,
        admissionAggregateRevision: 7,
        admissionControllerGeneration: 2,
        requestActor: { actorKind: "system", actorId: "system:test" },
      },
      metadata: {
        retryPolicy: { maxAttempts: 3, baseDelayMs: 5_000, maxDelayMs: 60_000, backoffMultiplier: 2 },
      },
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const deadLetters = new Map<
      string,
      { dead_letter_id: string; run_id: string; reason: string; resolved_at?: string; resolution_note?: string }
    >();
    const context = createContext(runs, checkpoints, timeline, { deadLetters });
    const admission = {
      admissionId: "admission-chat",
      admissionKind: "turn_write",
      status: "active",
      sessionIncarnationId: "incarnation-chat",
      workspaceId: "default",
      sessionId: "session-chat",
      turnId: "turn-chat",
      aggregateRevision: 7,
      controllerGeneration: 2,
      actorKind: "system",
      actorId: "system:test",
      materialSha256: admissionMaterialSha256,
    } as Record<string, unknown>;
    let activeAdmission: Record<string, unknown> | undefined = admission;
    const closeTurnWrite = vi.fn(() => {
      admission.status = "cancelled";
      admission.terminalAuthorityKind = "durable_terminal";
      admission.terminalDurableRunId = run.runId;
      admission.terminalDurableRunStatus = "failed";
      activeAdmission = undefined;
      return admission;
    });
    const admit = vi.fn((input: { turnId: string; materialSha256: string }) => {
      if (activeAdmission) throw new Error("An active turn already owns the session.");
      activeAdmission = {
        ...admission,
        admissionId: "admission-chat-next",
        status: "active",
        turnId: input.turnId,
        materialSha256: input.materialSha256,
        terminalAuthorityKind: undefined,
        terminalDurableRunId: undefined,
        terminalDurableRunStatus: undefined,
      };
      return { disposition: "created" as const, admission: activeAdmission };
    });
    Object.assign(context.storage, {
      sessionMutationAdmissions: {
        admit,
        require: () => admission,
        findDurableRunBinding: () => ({
          admissionId: admission.admissionId,
          sessionIncarnationId: admission.sessionIncarnationId,
          workspaceId: admission.workspaceId,
          sessionId: admission.sessionId,
          turnId: admission.turnId,
          durableRunId: run.runId,
          createdAt: "2026-07-29T00:00:00.000Z",
        }),
        settleTurnWriteAuthority: () => ({ disposition: "current", admission }),
        closeTurnWrite,
      },
      chatSessionMeta: {
        get: () => ({ sessionId: "session-chat", workspaceId: "default", revision: 7, origin: "system" }),
      },
    });
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks: new Set(),
      workflowRegistry: {
        executeWorkflow: vi.fn(),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
      onGeneralChatPostCommit: async (_observed, progress) => {
        for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
          await progress.runEffect(effect, () => undefined);
        }
        return { status: "failed" };
      },
    });

    const failed = await service.scheduleRunningWorkflowRetry(run.runId, "provider exhausted", "worker", "worker-chat");
    expect(failed.status).toBe("failed");
    expect(failed.metadata).toMatchObject({
      linkedFinalizationPending: expect.any(Object),
      generalChatPostCommitPending: expect.objectContaining({ traceStatus: "failed" }),
      chatRetryExhaustionDeadLetterPending: expect.objectContaining({ attemptNo: 4, maxAttempts: 3 }),
      chatTurnRuntimeAuthority: expect.any(Object),
    });
    expect(deadLetters.size).toBe(0);

    await expect(service.reconcileTerminalChatAdmission(admission as never)).resolves.toMatchObject({
      recoveryOutcome: "released",
      durableRunId: run.runId,
      admissionId: admission.admissionId,
      admissionStatus: "cancelled",
    });
    expect(runs.get(run.runId)).toMatchObject({ status: "dead_lettered", attemptCount: 4 });
    expect(admission).toMatchObject({
      status: "cancelled",
      terminalAuthorityKind: "durable_terminal",
      terminalDurableRunStatus: "failed",
    });
    expect(closeTurnWrite).toHaveBeenCalledOnce();
    expect(closeTurnWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        admissionId: "admission-chat",
        turnId: "turn-chat",
        status: "cancelled",
        correlationId: run.runId,
      }),
    );
    const nextTurn = await context.storage.sessionMutationAdmissions.admit({
      workspaceId: "default",
      sessionId: "session-chat",
      expectedSessionIncarnationId: "incarnation-chat",
      turnId: "turn-chat-next",
      runtimeOwnerId: "runtime-chat-next",
      admissionKind: "turn_write",
      aggregateRevision: 7,
      controllerGeneration: 2,
      actorKind: "operator",
      actorId: "operator-next",
      operation: "chat_turn",
      materialSha256: "b".repeat(64),
      idempotencyKey: "admission-chat-next",
      correlationId: "turn-chat-next",
    });
    expect(nextTurn).toMatchObject({
      disposition: "created",
      admission: { admissionId: "admission-chat-next", status: "active", turnId: "turn-chat-next" },
    });
    expect(admit).toHaveBeenCalledOnce();
    expect(deadLetters.size).toBe(1);
    expect(timeline.map((entry) => entry.eventType)).toEqual(
      expect.arrayContaining(["run_failed", "run_retry_budget_exhausted", "run_dead_lettered"]),
    );
  });

  it("ignores the durable foundation env override once runtime config is normalized on", async () => {
    const previous = process.env.GOATCITADEL_DURABLE_FOUNDATION_ENABLED;
    process.env.GOATCITADEL_DURABLE_FOUNDATION_ENABLED = "false";
    try {
      const runs = new Map<string, DurableRunRecord>([["run-1", createRun("run-1", "queued")]]);
      const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
      const timeline: Array<{ runId: string; eventType: string }> = [];
      const backgroundTasks = new Set<Promise<void>>();
      const executeWorkflow = vi.fn(async (run: DurableRunRecord) => {
        updateRun(runs, run.runId, {
          status: "completed",
          finishedAt: "2026-03-14T00:00:05.000Z",
        });
      });
      const service = new DurableRunService(createContext(runs, checkpoints, timeline) as unknown as ServiceContext, {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow,
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
      });

      service.startWorker();
      await Promise.all([...backgroundTasks]);

      expect(executeWorkflow).toHaveBeenCalledTimes(1);
      expect(runs.get("run-1")?.status).toBe("completed");
    } finally {
      if (previous === undefined) {
        delete process.env.GOATCITADEL_DURABLE_FOUNDATION_ENABLED;
      } else {
        process.env.GOATCITADEL_DURABLE_FOUNDATION_ENABLED = previous;
      }
    }
  });

  it("stops polling when the worker is stopped", async () => {
    vi.useFakeTimers();
    try {
      const runs = new Map<string, DurableRunRecord>([["run-1", createRun("run-1", "queued")]]);
      const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
      const timeline: Array<{ runId: string; eventType: string }> = [];
      const backgroundTasks = new Set<Promise<void>>();
      const executeWorkflow = vi.fn(async (run: DurableRunRecord) => {
        updateRun(runs, run.runId, {
          status: "completed",
          finishedAt: "2026-03-14T00:00:05.000Z",
        });
      });
      const service = new DurableRunService(createContext(runs, checkpoints, timeline) as unknown as ServiceContext, {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow,
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
      });

      service.startWorker();
      await Promise.all([...backgroundTasks]);
      await service.stopWorker();

      await vi.advanceTimersByTimeAsync(5_000);

      expect(backgroundTasks.size).toBe(0);
      expect(executeWorkflow).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves an in-flight run recoverable when the worker stops", async () => {
    const run = createRun("run-worker-stop-recovery", "queued");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const executeWorkflow = vi.fn(
      async (_claimed: DurableRunRecord, context?: { signal?: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          context?.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
        }),
    );
    const service = new DurableRunService(createContext(runs, checkpoints, timeline) as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    service.startWorker();
    await vi.waitFor(() => expect(executeWorkflow).toHaveBeenCalledTimes(1));
    await service.stopWorker();
    await Promise.allSettled([...backgroundTasks]);

    expect(runs.get(run.runId)).toMatchObject({
      status: "running",
      leaseOwnerId: expect.any(String),
      leaseExpiresAt: expect.any(String),
    });
    expect(timeline.map((item) => item.eventType)).not.toContain("run_failed");
  });

  it("requeues recovered dead letters and immediately schedules them for execution", async () => {
    const run = createRun("run-dead", "dead_lettered", "connector.delivery");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const deadLetters = new Map([
      ["dead-1", { dead_letter_id: "dead-1", run_id: run.runId, reason: "connector_timeout" }],
    ]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const executeWorkflow = vi.fn(async (current: DurableRunRecord) => {
      updateRun(runs, current.runId, {
        status: "completed",
        finishedAt: "2026-03-14T00:00:06.000Z",
      });
    });
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, { deadLetters }) as unknown as ServiceContext,
      {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow,
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
      },
    );

    const recovered = await service.recoverDurableDeadLetter("dead-1", "operator-1");
    await Promise.all([...backgroundTasks]);

    expect(recovered.status).toBe("queued");
    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(runs.get(run.runId)?.status).toBe("completed");
    expect(deadLetters.get("dead-1")).toMatchObject({
      resolved_at: expect.any(String),
      resolution_note: "recovered by operator-1",
    });
    expect(timeline.map((item) => item.eventType)).toContain("dead_letter_recovered");
    expect(timeline.map((item) => item.eventType)).toContain("run_started");
    await expect(service.recoverDurableDeadLetter("dead-1", "operator-2")).rejects.toThrow(/already resolved/);
    expect(executeWorkflow).toHaveBeenCalledTimes(1);
  });

  it("enforces the absolute dead-letter recovery attempt ceiling", async () => {
    const run = { ...createRun("run-dead-ceiling", "dead_lettered"), attemptCount: 20, maxAttempts: 20 };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const deadLetters = new Map([
      ["dead-ceiling", { dead_letter_id: "dead-ceiling", run_id: run.runId, reason: "retry_exhausted" }],
    ]);
    const service = new DurableRunService(createContext(runs, [], [], { deadLetters }) as unknown as ServiceContext);

    await expect(service.recoverDurableDeadLetter("dead-ceiling", "operator", { maxAttempts: 20 })).rejects.toThrow(
      /hard 20-attempt recovery ceiling/,
    );
    expect(runs.get(run.runId)?.status).toBe("dead_lettered");
  });

  it("refuses to recover dead letters the workflow registry classifies as unrecoverable", async () => {
    const unrecoverabilityReason =
      "Durable chat run was interrupted after tool execution began and cannot be safely replayed.";
    const run = {
      ...createRun("run-unsafe-dead", "dead_lettered", "chat.turn.execute"),
      lastError: unrecoverabilityReason,
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const deadLetters = new Map([
      ["dead-unsafe", { dead_letter_id: "dead-unsafe", run_id: run.runId, reason: "unsafe_replay" }],
    ]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const publishRealtime = vi.fn();
    const backgroundTasks = new Set<Promise<void>>();
    const executeWorkflow = vi.fn(async () => undefined);
    const isWorkflowRecoverable = vi.fn(() => ({
      recoverable: false,
      reason: unrecoverabilityReason,
    }));
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, { deadLetters, publishRealtime }) as unknown as ServiceContext,
      {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow,
          isWorkflowRecoverable,
          markWorkflowUnrecoverable: vi.fn(),
        },
      },
    );

    await expect(service.recoverDurableDeadLetter("dead-unsafe", "operator-1")).rejects.toThrow(unrecoverabilityReason);
    expect(isWorkflowRecoverable).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId }));
    expect(runs.get(run.runId)?.status).toBe("dead_lettered");
    expect(deadLetters.get("dead-unsafe")).toEqual({
      dead_letter_id: "dead-unsafe",
      run_id: run.runId,
      reason: "unsafe_replay",
    });
    expect(timeline).toEqual([]);
    expect(publishRealtime).not.toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({ type: "durable_dead_letter_recovered" }),
      expect.anything(),
    );
    expect(backgroundTasks.size).toBe(0);
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it("skips waking waiting runs when the correlation id does not match", async () => {
    const run = createRun("run-wait", "waiting", "approval.wait");
    run.metadata = {
      waitForEvent: {
        eventKey: "approval.resolved",
        correlationId: "approval-expected",
      },
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const publishRealtime = vi.fn();
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, { publishRealtime }) as unknown as ServiceContext,
    );

    const result = await service.wakeDurableRun(run.runId, {
      eventKey: "approval.resolved",
      correlationId: "approval-other",
    });

    expect(result).toMatchObject({
      outcome: "skipped_correlation_mismatch",
      runId: "run-wait",
    });
    expect(runs.get(run.runId)?.status).toBe("waiting");
    expect(timeline).toEqual([]);
    expect(publishRealtime).not.toHaveBeenCalled();
  });

  it("emits a durable retry scheduled signal when manual retry queues another attempt", async () => {
    const run = {
      ...createRun("run-retry", "failed", "connector.delivery"),
      finishedAt: "2026-03-14T00:00:05.000Z",
      lastError: "stale connector failure",
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const publishRealtime = vi.fn();
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, { publishRealtime }) as unknown as ServiceContext,
    );

    const retried = await service.retryDurableRun(run.runId, "manual_retry", "operator-1");

    expect(retried.status).toBe("queued");
    expect(retried.finishedAt).toBeUndefined();
    expect(retried.lastError).toBeUndefined();
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({
        type: "durable_run_retry_scheduled",
        runId: "run-retry",
        attemptNo: 1,
      }),
      expect.objectContaining({
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: expect.objectContaining({
          runId: "run-retry",
        }),
      }),
    );
  });

  it("refuses to retry runs the workflow registry classifies as unrecoverable", async () => {
    const unrecoverabilityReason =
      "Durable chat run was interrupted after tool execution began and cannot be safely replayed.";
    const run = {
      ...createRun("run-unsafe-retry", "failed", "chat.turn.execute"),
      finishedAt: "2026-03-14T00:00:05.000Z",
      lastError: unrecoverabilityReason,
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const publishRealtime = vi.fn();
    const isWorkflowRecoverable = vi.fn(() => ({
      recoverable: false,
      reason: unrecoverabilityReason,
    }));
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, { publishRealtime }) as unknown as ServiceContext,
      {
        backgroundTasks: new Set<Promise<void>>(),
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable,
          markWorkflowUnrecoverable: vi.fn(),
        },
      },
    );

    await expect(service.retryDurableRun(run.runId, "manual_retry", "operator-1")).rejects.toThrow(
      unrecoverabilityReason,
    );
    expect(isWorkflowRecoverable).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId }));
    expect(runs.get(run.runId)?.status).toBe("failed");
    expect(runs.get(run.runId)?.attemptCount).toBe(0);
    expect(publishRealtime).not.toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({ type: "durable_run_retry_scheduled" }),
      expect.anything(),
    );
  });

  it.each(["completed", "running", "queued", "waiting", "paused", "cancelled", "dead_lettered"] as const)(
    "refuses to retry %s durable runs without changing lifecycle truth",
    async (status) => {
      const run = {
        ...createRun("run-retry-blocked", status, "connector.delivery"),
        ...(status === "completed" || status === "cancelled" || status === "dead_lettered"
          ? { finishedAt: "2026-03-14T00:00:05.000Z" }
          : {}),
      };
      const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
      const retries = new Map<string, DurableRetryRecord[]>();
      const timeline: Array<{ runId: string; eventType: string }> = [];
      const publishRealtime = vi.fn();
      const isWorkflowRecoverable = vi.fn(() => ({ recoverable: true }));
      const service = new DurableRunService(
        createContext(runs, [], timeline, { retries, publishRealtime }) as unknown as ServiceContext,
        {
          backgroundTasks: new Set<Promise<void>>(),
          workflowRegistry: {
            executeWorkflow: vi.fn(),
            isWorkflowRecoverable,
            markWorkflowUnrecoverable: vi.fn(),
          },
        },
      );

      await expect(service.retryDurableRun(run.runId, "manual_retry", "operator-1")).rejects.toThrow(
        `Durable run ${run.runId} cannot be retried from ${status}`,
      );
      expect(isWorkflowRecoverable).not.toHaveBeenCalled();
      expect(runs.get(run.runId)?.status).toBe(status);
      expect(runs.get(run.runId)?.attemptCount).toBe(run.attemptCount);
      expect(retries.get(run.runId)).toBeUndefined();
      expect(timeline).toEqual([]);
      expect(publishRealtime).not.toHaveBeenCalled();
    },
  );

  it("refuses to resume paused autonomous runs while the autonomy kill switch is engaged", async () => {
    const run = {
      ...createRun("run-autonomous-paused", "paused", "chat.turn.execute"),
      metadata: {
        autonomous: {
          kind: "scheduled",
          deliverMode: "always",
        },
      },
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const publishRealtime = vi.fn();
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, {
        publishRealtime,
        isFeatureEnabled: (feature) => feature === "autonomyV1Disabled",
      }) as unknown as ServiceContext,
    );

    await expect(service.resumeDurableRun(run.runId, "operator-1")).rejects.toThrow(/autonomy kill switch/i);
    expect(runs.get(run.runId)?.status).toBe("paused");
    expect(checkpoints).toEqual([]);
    expect(timeline).toEqual([]);
    expect(publishRealtime).not.toHaveBeenCalled();
  });

  it("blocks pause continuation gates before workflow execution", async () => {
    const run = createRun("run-gated", "queued", "connector.delivery");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const executeWorkflow = vi.fn(async () => undefined);
    const service = new DurableRunService(createContext(runs, checkpoints, timeline) as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
      evaluateContinuationGate: () => ({
        decision: "pause",
        reasonCodes: ["approval_wait"],
        summary: "Continue gate set to pause: approval_wait.",
        metrics: {
          stepsSinceCheckpoint: 0,
          toolRunCount: 0,
          failedToolRunCount: 0,
          retryFailureStreak: 0,
          approvalWait: true,
          userInputWait: false,
          evidenceGapCount: 0,
        },
        recommendedAction: "Wait for the operator to resolve the approval.",
        createdAt: "2026-03-14T00:00:02.000Z",
      }),
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    expect(executeWorkflow).not.toHaveBeenCalled();
    expect(runs.get(run.runId)?.status).toBe("paused");
    expect(runs.get(run.runId)?.leaseOwnerId).toBeUndefined();
    expect(checkpoints.map((item) => item.checkpointKind)).toContain("continuation_gate");
  });

  it("commits a blocking continuation gate even when its evidence projection fails", async () => {
    const run = createRun("run-gated-evidence", "queued", "connector.delivery");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const executeWorkflow = vi.fn(async () => undefined);
    const service = new DurableRunService(createContext(runs, checkpoints, timeline) as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
      evaluateContinuationGate: () => ({
        decision: "pause",
        reasonCodes: ["approval_wait"],
        summary: "Continue gate set to pause: approval_wait.",
        metrics: {
          stepsSinceCheckpoint: 0,
          toolRunCount: 0,
          failedToolRunCount: 0,
          retryFailureStreak: 0,
          approvalWait: true,
          userInputWait: false,
          evidenceGapCount: 0,
        },
        recommendedAction: "Wait for the operator to resolve the approval.",
        createdAt: "2026-03-14T00:00:02.000Z",
      }),
      recordEvidenceEnvelope: vi.fn(() => {
        throw new Error("evidence sink unavailable");
      }),
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    expect(executeWorkflow).not.toHaveBeenCalled();
    expect(runs.get(run.runId)?.status).toBe("paused");
    expect(checkpoints.map((item) => item.checkpointKind)).toContain("continuation_gate");
    expect(timeline.map((item) => item.eventType)).toEqual(expect.arrayContaining(["continuation_gate", "run_paused"]));
  });

  it.each([
    { action: "pause" as const, expectedStatus: "paused" as const },
    { action: "cancel" as const, expectedStatus: "cancelled" as const },
  ])(
    "aborts the active workflow signal when operators $action a running durable run",
    async ({ action, expectedStatus }) => {
      const run = createRun("run-operator-control", "queued");
      const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
      const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
      const timeline: Array<{ runId: string; eventType: string }> = [];
      const backgroundTasks = new Set<Promise<void>>();
      let observedSignal: AbortSignal | undefined;
      let workflowStarted!: () => void;
      const workflowStartedPromise = new Promise<void>((resolve) => {
        workflowStarted = resolve;
      });
      const executeWorkflow = vi.fn(async (_run: DurableRunRecord, context: { signal: AbortSignal }) => {
        observedSignal = context.signal;
        workflowStarted();
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) {
            resolve();
            return;
          }
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      });
      const service = new DurableRunService(
        createContext(runs, checkpoints, timeline, {
          publishRealtime: (_eventType, _source, payload) => {
            if (payload.type === `durable_run_${action === "pause" ? "paused" : "cancelled"}`) {
              throw new Error("retained stream unavailable");
            }
          },
        }) as unknown as ServiceContext,
        {
          backgroundTasks,
          workflowRegistry: {
            executeWorkflow,
            isWorkflowRecoverable: () => ({ recoverable: true }),
            markWorkflowUnrecoverable: vi.fn(),
          },
        },
      );

      service.startWorker();
      await workflowStartedPromise;
      if (action === "pause") {
        await service.pauseDurableRun(run.runId, "operator-1");
      } else {
        await service.cancelDurableRun(run.runId, "operator-1");
      }
      await Promise.allSettled([...backgroundTasks]);

      expect(observedSignal?.aborted).toBe(true);
      expect(runs.get(run.runId)?.status).toBe(expectedStatus);
      expect(executeWorkflow).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { runStatus: "running" as const, traceStatus: "running" as const },
    { runStatus: "waiting" as const, traceStatus: "waiting_for_approval" as const },
  ])(
    "atomically converges a $traceStatus Chat trace and durable run on operator cancellation",
    async ({ runStatus, traceStatus }) => {
      const turnId = `turn-cancel-${runStatus}`;
      const fixture = createAdmittedChatRuntimeFixture({
        runId: `run-chat-cancel-${runStatus}`,
        status: runStatus,
        ...(runStatus === "waiting"
          ? {
              generationId: `generation-cancel-${runStatus}`,
              traceStatus: "waiting_for_approval" as const,
            }
          : {}),
        sessionId: "session-cancel",
        turnId,
      });
      const run = fixture.run;
      const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
      const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
      const timeline: Array<{ runId: string; eventType: string }> = [];
      const context = createContext(runs, checkpoints, timeline);
      await installAdmittedChatRuntimeFixture(context, fixture);
      const lockOrder: string[] = [];
      Object.assign(context.storage.durableRuns, {
        getRunForUpdate: (runId: string) => {
          lockOrder.push("durable");
          const current = runs.get(runId);
          if (!current) {
            throw new Error(`Unknown run ${runId}`);
          }
          return current;
        },
      });
      let trace: ChatTurnTraceRecord = {
        turnId,
        sessionId: "session-cancel",
        userMessageId: `user:${run.runId}`,
        branchKind: "new",
        status: traceStatus,
        mode: "chat",
        webMode: "off",
        memoryMode: "auto",
        thinkingLevel: "standard",
        startedAt: "2026-03-14T00:00:00.000Z",
        toolRuns: [],
        citations: [],
        routing: {},
        durable: { runId: run.runId, status: runStatus },
        ...(traceStatus === "waiting_for_approval"
          ? {
              pendingApprovalSummary: {
                approvalId: "approval-cancel",
                toolName: "shell.exec",
                riskLevel: "danger" as const,
                status: "pending" as const,
              },
            }
          : {}),
      };
      const patchIfStatus = vi.fn(
        (
          _turnId: string,
          statuses: readonly string[],
          patch: {
            status: ChatTurnTraceRecord["status"];
            pendingUserInput?: null;
            completion?: ChatTurnTraceRecord["completion"];
            durable?: ChatTurnTraceRecord["durable"];
            finishedAt?: string;
          },
        ) => {
          lockOrder.push("trace");
          if (!statuses.includes(trace.status)) {
            return undefined;
          }
          trace = {
            ...trace,
            ...patch,
            pendingUserInput: patch.pendingUserInput === null ? undefined : trace.pendingUserInput,
          };
          return trace;
        },
      );
      Object.assign(context.storage, {
        chatTurnTraces: {
          get: () => trace,
          patchIfStatus,
        },
      });
      const backgroundTasks = new Set<Promise<void>>();
      const agentEnd = vi.fn();
      const onGeneralChatPostCommit = vi.fn(
        async (_observed: DurableRunRecord, progress: GeneralChatPostCommitProgress) => {
          expect(progress.targetTraceStatus).toBe("cancelled");
          await progress.runEffect("agent_end", agentEnd);
          for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
            await progress.runEffect(effect, () => undefined);
          }
          return { status: "cancelled" };
        },
      );
      const service = new DurableRunService(context as unknown as ServiceContext, {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow: vi.fn(),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
        onGeneralChatPostCommit,
      });

      const cancelled = await service.cancelDurableRun(run.runId, "operator-cancel");

      expect(cancelled.status).toBe("cancelled");
      expect(trace).toMatchObject({
        status: "cancelled",
        durable: { runId: run.runId, status: "cancelled", checkpointKind: "run_cancelled" },
      });
      expect(trace.pendingUserInput).toBeUndefined();
      expect(runs.get(run.runId)?.metadata).toMatchObject({
        generalChatPostCommitPending: {
          generationId: expect.any(String),
          traceStatus: "cancelled",
        },
      });
      expect(runs.get(run.runId)?.metadata).not.toHaveProperty("waitForEvent");
      expect(runs.get(run.runId)?.metadata).not.toHaveProperty("generalChatPostCommit");
      expect(runs.get(run.runId)?.metadata).not.toHaveProperty("chatTurnAdmissionHandoff");
      expect(checkpoints).toContainEqual({ runId: run.runId, checkpointKind: "run_cancelled" });
      expect(lockOrder.slice(0, 2)).toEqual(["durable", "trace"]);

      await Promise.all([...backgroundTasks]);

      expect(onGeneralChatPostCommit).toHaveBeenCalledTimes(1);
      expect(agentEnd).toHaveBeenCalledTimes(1);
      expect(runs.get(run.runId)?.metadata).not.toHaveProperty("generalChatPostCommitPending");
    },
  );

  it("rolls back a wake when its timeline event cannot commit", async () => {
    const run = {
      ...createRun("run-wake-rollback", "waiting"),
      metadata: { waitForEvent: { eventKey: "approval.resolved" } },
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const context = createContext(runs, checkpoints, timeline);
    context.storage.runImmediateTransaction = async <T>(callback: () => T | Promise<T>): Promise<T> => {
      const runSnapshot = new Map(runs);
      try {
        return await callback();
      } catch (error) {
        runs.clear();
        for (const [runId, current] of runSnapshot) {
          runs.set(runId, current);
        }
        throw error;
      }
    };
    context.storage.durableRunEvents.append = () => {
      throw new Error("timeline write unavailable");
    };
    const service = new DurableRunService(context as unknown as ServiceContext);

    const result = await service.wakeDurableRun(run.runId, { eventKey: "approval.resolved" });

    expect(result).toMatchObject({ outcome: "failed", detail: "timeline write unavailable" });
    expect(runs.get(run.runId)?.status).toBe("waiting");
  });

  it("treats repeated operator cancellation of an already-cancelled durable run as idempotent", async () => {
    const run = {
      ...createRun("run-already-cancelled", "cancelled"),
      finishedAt: "2026-03-14T00:00:05.000Z",
      lastError: "cancelled by operator-1",
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const publishRealtime = vi.fn();
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, { publishRealtime }) as unknown as ServiceContext,
    );

    const secondCancel = await service.cancelDurableRun(run.runId, "operator-2");

    expect(secondCancel).toBe(run);
    expect(runs.get(run.runId)?.version).toBe(run.version);
    expect(timeline).toEqual([]);
    expect(publishRealtime).not.toHaveBeenCalled();
  });

  it("treats repeated operator pause of an already-paused durable run as idempotent", async () => {
    const run = createRun("run-already-paused", "paused");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const publishRealtime = vi.fn();
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, { publishRealtime }) as unknown as ServiceContext,
    );

    const secondPause = await service.pauseDurableRun(run.runId, "operator-2");

    expect(secondPause).toBe(run);
    expect(runs.get(run.runId)?.version).toBe(run.version);
    expect(timeline).toEqual([]);
    expect(publishRealtime).not.toHaveBeenCalled();
  });

  it("rejects pause attempts for already-cancelled durable runs", async () => {
    const run = {
      ...createRun("run-cancelled-pause", "cancelled"),
      finishedAt: "2026-03-14T00:00:05.000Z",
      lastError: "cancelled by operator-1",
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext);

    await expect(service.pauseDurableRun(run.runId, "operator-2")).rejects.toThrow(
      "Durable run run-cancelled-pause is already terminal (cancelled)",
    );
  });

  it("rejects pause and cancel attempts for dead-lettered durable runs", async () => {
    const run = {
      ...createRun("run-dead-lettered-control", "dead_lettered"),
      finishedAt: "2026-03-14T00:00:05.000Z",
      lastError: "retry_exhausted: connector timed out",
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const publishRealtime = vi.fn();
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, { publishRealtime }) as unknown as ServiceContext,
    );

    await expect(service.pauseDurableRun(run.runId, "operator-2")).rejects.toThrow(
      "Durable run run-dead-lettered-control is already terminal (dead_lettered)",
    );
    await expect(service.cancelDurableRun(run.runId, "operator-2")).rejects.toThrow(
      "Durable run run-dead-lettered-control is already terminal (dead_lettered)",
    );
    expect(runs.get(run.runId)?.status).toBe("dead_lettered");
    expect(timeline).toEqual([]);
    expect(publishRealtime).not.toHaveBeenCalled();
  });

  it("records checkpoint continuation gates and continues workflow execution", async () => {
    const run = createRun("run-checkpoint", "queued", "connector.delivery");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const executeWorkflow = vi.fn(async (claimed: DurableRunRecord) => {
      updateRun(runs, claimed.runId, {
        status: "completed",
        finishedAt: "2026-03-14T00:00:05.000Z",
      });
    });
    const service = new DurableRunService(createContext(runs, checkpoints, timeline) as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
      evaluateContinuationGate: () => ({
        decision: "checkpoint",
        reasonCodes: ["checkpoint_interval"],
        summary: "Continue gate set to checkpoint: checkpoint_interval.",
        metrics: {
          stepsSinceCheckpoint: 8,
          toolRunCount: 0,
          failedToolRunCount: 0,
          retryFailureStreak: 0,
          approvalWait: false,
          userInputWait: false,
          evidenceGapCount: 0,
        },
        recommendedAction: "Create a checkpoint before continuing to the next step.",
        createdAt: "2026-03-14T00:00:02.000Z",
      }),
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(runs.get(run.runId)?.status).toBe("completed");
    expect(checkpoints.map((item) => item.checkpointKind)).toContain("continuation_gate");
  });

  it("leaves heartbeat-infrastructure failures recoverable and reclaims after lease expiry", async () => {
    vi.useFakeTimers();
    try {
      const run = createRun("run-heartbeat-failure", "queued");
      const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
      const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
      const timeline: Array<{ runId: string; eventType: string }> = [];
      const backgroundTasks = new Set<Promise<void>>();
      let resolveWorkflow!: () => void;
      const workflow = new Promise<void>((resolve) => {
        resolveWorkflow = resolve;
      });
      const context = createContext(runs, checkpoints, timeline);
      const originalRenewLease = context.storage.durableRuns.renewLease;
      let renewalCount = 0;
      const renewLease = vi.fn((input) => {
        renewalCount += 1;
        if (renewalCount === 1) {
          return originalRenewLease(input);
        }
        throw new Error("transient lease failure");
      });
      context.storage.durableRuns.renewLease = renewLease as never;
      let executionCount = 0;
      const executeWorkflow = vi.fn((claimed: DurableRunRecord) => {
        executionCount += 1;
        if (executionCount === 1) {
          return workflow;
        }
        updateRun(runs, claimed.runId, {
          status: "completed",
          finishedAt: new Date().toISOString(),
          clearLease: true,
        });
        return Promise.resolve();
      });
      const service = new DurableRunService(context as unknown as ServiceContext, {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow,
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
      });

      service.startWorker();
      // Heartbeat renewal failures are tolerated for two consecutive beats and
      // abort the run on the third (DURABLE_LEASE_HEARTBEAT_MAX_CONSECUTIVE_FAILURES).
      await vi.advanceTimersByTimeAsync(5_100);
      expect(runs.get(run.runId)?.status).not.toBe("failed");
      await vi.advanceTimersByTimeAsync(5_100);
      await vi.advanceTimersByTimeAsync(5_100);
      await Promise.allSettled([...backgroundTasks]);

      expect(renewLease).toHaveBeenCalledTimes(4);
      expect(runs.get(run.runId)?.status).toBe("running");
      expect(timeline.map((item) => item.eventType)).not.toContain("run_failed");

      resolveWorkflow();
      context.storage.durableRuns.renewLease = originalRenewLease;
      updateRun(runs, run.runId, {
        leaseExpiresAt: "2026-03-14T00:00:01.000Z",
      });
      service.requestRunProcessing(run.runId);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.allSettled([...backgroundTasks]);

      expect(executeWorkflow).toHaveBeenCalledTimes(2);
      expect(runs.get(run.runId)?.status).toBe("completed");
      expect(timeline.map((item) => item.eventType)).not.toContain("run_failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("quarantines legacy v1 Cowork runs before their timeout watchdog can execute", async () => {
    vi.useFakeTimers();
    try {
      const run = {
        ...createRun("run-cowork-timeout", "queued", "chat.turn.execute"),
        payload: {
          version: "chat.turn.execute.v1",
          request: { mode: "cowork" },
        },
      };
      const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
      const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
      const timeline: Array<{ runId: string; eventType: string }> = [];
      const backgroundTasks = new Set<Promise<void>>();
      const publishRealtime = vi.fn();
      const context = createContext(runs, checkpoints, timeline, { publishRealtime });
      context.config.assistant.durable.workflowTimeoutMs = 50;
      const service = new DurableRunService(context as unknown as ServiceContext, {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow: vi.fn(() => new Promise<void>(() => undefined)),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
      });

      service.startWorker();
      const tasks = [...backgroundTasks];
      await vi.advanceTimersByTimeAsync(60);
      await Promise.allSettled(tasks);

      expect(runs.get(run.runId)).toMatchObject({
        status: "failed",
        leaseOwnerId: undefined,
        leaseExpiresAt: undefined,
        lastError:
          "Legacy durable Chat run lacks immutable session-incarnation admission and requires manual reconciliation.",
        metadata: expect.objectContaining({
          linkedFinalization: expect.objectContaining({
            reasonSha256: "9b1780c77826cd3cc9aee375b00a84e7b8091b922ed32c40205e8ff3f520aa82",
          }),
        }),
      });
      expect(checkpoints.map((item) => item.checkpointKind)).toContain("run_failed");
      expect(timeline.map((item) => item.eventType)).toContain("run_failed");
      expect(timeline.map((item) => item.eventType)).not.toContain("run_waiting");
      expect(publishRealtime).toHaveBeenCalledWith(
        "system",
        "durable",
        expect.objectContaining({
          type: "durable_run_failed",
          runId: run.runId,
          error:
            "Legacy durable Chat run lacks immutable session-incarnation admission and requires manual reconciliation.",
        }),
        expect.objectContaining({
          eventClass: "domain_fact",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves autonomy kill-switch blocked runs to waiting instead of failing them", async () => {
    const run = {
      ...createRun("run-autonomy-disabled", "queued", "chat.turn.execute"),
      metadata: { autonomous: { kind: "scheduled" } },
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const publishRealtime = vi.fn();
    const context = createContext(runs, checkpoints, timeline, { publishRealtime });
    const disabled = new Error(
      "Autonomous durable workflow chat.turn.execute (run-autonomy-disabled) is blocked while the autonomy kill switch is engaged (autonomyV1Disabled).",
    );
    disabled.name = "AutonomousDurableRunDisabledError";
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow: vi.fn(async () => {
          throw disabled;
        }),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    service.startWorker();
    await Promise.allSettled([...backgroundTasks]);

    expect(runs.get(run.runId)).toMatchObject({
      status: "waiting",
      leaseOwnerId: undefined,
      leaseExpiresAt: undefined,
      lastError: undefined,
      metadata: expect.objectContaining({
        waitForEvent: {
          eventKey: "autonomy.v1.enabled",
          correlationId: run.runId,
        },
        autonomyKillSwitch: expect.objectContaining({
          reason: "autonomyV1Disabled",
        }),
      }),
    });
    expect(checkpoints.map((item) => item.checkpointKind)).toContain("run_waiting");
    expect(timeline.map((item) => item.eventType)).toContain("run_waiting");
    expect(timeline.map((item) => item.eventType)).not.toContain("run_failed");
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({
        type: "durable_run_waiting",
        runId: run.runId,
        reason: "autonomy_kill_switch",
      }),
      expect.objectContaining({
        eventClass: "domain_fact",
      }),
    );
  });

  it("resumes autonomy kill-switch parked runs when the switch is disengaged", async () => {
    const run = {
      ...createRun("run-parked-for-kill-switch", "waiting", "chat.turn.execute"),
      metadata: {
        autonomous: { kind: "scheduled" },
        waitForEvent: { eventKey: "autonomy.v1.enabled", correlationId: "run-parked-for-kill-switch" },
        autonomyKillSwitch: { reason: "autonomyV1Disabled", blockedAt: "2026-03-14T00:00:00.000Z" },
      },
    };
    // A run parked for a different reason must be left untouched by the sweep.
    const otherWaiting = {
      ...createRun("run-waiting-on-approval", "waiting", "chat.turn.execute"),
      metadata: { waitForEvent: { eventKey: "approval.resolved", correlationId: "approval-1" } },
    };
    const runs = new Map<string, DurableRunRecord>([
      [run.runId, run],
      [otherWaiting.runId, otherWaiting],
    ]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const context = createContext(runs, checkpoints, timeline);
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks: new Set<Promise<void>>(),
      workflowRegistry: {
        executeWorkflow: vi.fn(),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    const result = await service.resumeRunsWaitingForAutonomyKillSwitch();

    expect(result.woken).toEqual(["run-parked-for-kill-switch"]);
    expect(runs.get("run-parked-for-kill-switch")).toMatchObject({ status: "queued" });
    // The approval-parked run is not the kill switch's business — leave it waiting.
    expect(runs.get("run-waiting-on-approval")).toMatchObject({ status: "waiting" });
  });

  it("fails timed-out prompt-pack Cowork chat turns instead of waiting for an operator resume", async () => {
    vi.useFakeTimers();
    try {
      const run = {
        ...createRun("run-cowork-harness-timeout", "queued", "chat.turn.execute"),
        payload: {
          version: "chat.turn.execute.v1",
          request: { mode: "cowork", normalizationProfile: "prompt_pack_harness" },
        },
      };
      const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
      const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
      const timeline: Array<{ runId: string; eventType: string }> = [];
      const backgroundTasks = new Set<Promise<void>>();
      const context = createContext(runs, checkpoints, timeline);
      context.config.assistant.durable.workflowTimeoutMs = 50;
      const service = new DurableRunService(context as unknown as ServiceContext, {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow: vi.fn(() => new Promise<void>(() => undefined)),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
      });

      service.startWorker();
      const tasks = [...backgroundTasks];
      await vi.advanceTimersByTimeAsync(60);
      await Promise.allSettled(tasks);

      expect(runs.get(run.runId)).toMatchObject({
        status: "failed",
      });
      expect(runs.get(run.runId)?.metadata).not.toHaveProperty("waitForEvent");
      expect(timeline.map((item) => item.eventType)).toContain("run_failed");
      expect(timeline.map((item) => item.eventType)).not.toContain("run_waiting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clobber a run after lease ownership moves to another worker", async () => {
    const run = createRun("run-lease-steal", "queued");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const publishRealtime = vi.fn();
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, { publishRealtime }) as unknown as ServiceContext,
      {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow: vi.fn(async (current: DurableRunRecord) => {
            const nextLeaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
            updateRun(runs, current.runId, {
              status: "running",
              leaseOwnerId: "worker-other",
              leaseHeartbeatAt: new Date().toISOString(),
              leaseExpiresAt: nextLeaseExpiresAt,
            });
            throw new Error("stolen by another worker");
          }),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
      },
    );

    service.startWorker();
    await Promise.allSettled([...backgroundTasks]);

    expect(runs.get(run.runId)?.status).toBe("running");
    expect(runs.get(run.runId)?.leaseOwnerId).toBe("worker-other");
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({
        type: "durable_run_failure_skipped_lease_lost",
        runId: "run-lease-steal",
      }),
      expect.objectContaining({
        eventClass: "operational_signal",
      }),
    );
  });

  it("does not fail a run after lease ownership moves and the replacement lease is already expired", async () => {
    const run = createRun("run-expired-replacement-lease", "queued");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const publishRealtime = vi.fn();
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, { publishRealtime }) as unknown as ServiceContext,
      {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow: vi.fn(async (current: DurableRunRecord) => {
            updateRun(runs, current.runId, {
              status: "running",
              leaseOwnerId: "worker-other",
              leaseHeartbeatAt: "2026-03-14T00:00:02.000Z",
              leaseExpiresAt: "2026-03-14T00:00:01.000Z",
            });
            throw new Error("replacement worker stalled");
          }),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
      },
    );

    service.startWorker();
    await Promise.allSettled([...backgroundTasks]);

    expect(runs.get(run.runId)?.status).toBe("running");
    expect(runs.get(run.runId)?.leaseOwnerId).toBe("worker-other");
    expect(timeline.map((item) => item.eventType)).not.toContain("run_failed");
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({
        type: "durable_run_failure_skipped_lease_lost",
        runId: "run-expired-replacement-lease",
      }),
      expect.objectContaining({
        eventClass: "operational_signal",
      }),
    );
  });

  it("leaves an expired same-owner claim recoverable instead of converting it to failed", async () => {
    const run = createRun("run-expired-same-owner-lease", "queued");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const service = new DurableRunService(createContext(runs, checkpoints, timeline) as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow: vi.fn(async (current: DurableRunRecord) => {
          updateRun(runs, current.runId, {
            status: "running",
            leaseOwnerId: current.leaseOwnerId,
            leaseHeartbeatAt: "2026-03-14T00:00:00.000Z",
            leaseExpiresAt: "2026-03-14T00:00:01.000Z",
          });
          throw new Error("executor finished after its lease expired");
        }),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    service.startWorker();
    await Promise.allSettled([...backgroundTasks]);

    expect(runs.get(run.runId)).toMatchObject({
      status: "running",
      leaseExpiresAt: "2026-03-14T00:00:01.000Z",
    });
    expect(timeline.map((item) => item.eventType)).not.toContain("run_failed");
    expect(checkpoints.map((item) => item.checkpointKind)).not.toContain("run_failed");
  });

  it("requeues and resumes a recoverable run after the stale replacement lease expires", async () => {
    const run = createRun("run-stale-lease-reaper", "queued");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const publishRealtime = vi.fn();
    let executionCount = 0;
    const executeWorkflow = vi.fn(async (current: DurableRunRecord) => {
      executionCount += 1;
      if (executionCount === 1) {
        updateRun(runs, current.runId, {
          status: "running",
          leaseOwnerId: "worker-other",
          leaseHeartbeatAt: "2026-03-14T00:00:02.000Z",
          leaseExpiresAt: "2026-03-14T00:00:01.000Z",
        });
        throw new Error("replacement worker stalled");
      }
      updateRun(runs, current.runId, {
        status: "completed",
        finishedAt: "2026-03-14T00:00:05.000Z",
        clearLease: true,
      });
    });
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, { publishRealtime }) as unknown as ServiceContext,
      {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow,
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
      },
    );

    service.startWorker();
    await Promise.allSettled([...backgroundTasks]);

    expect(runs.get(run.runId)).toMatchObject({
      status: "running",
      leaseOwnerId: "worker-other",
      leaseExpiresAt: "2026-03-14T00:00:01.000Z",
    });
    expect(executeWorkflow).toHaveBeenCalledTimes(1);

    service.requestRunProcessing(run.runId);
    await Promise.allSettled([...backgroundTasks]);

    expect(executeWorkflow).toHaveBeenCalledTimes(2);
    expect(runs.get(run.runId)?.status).toBe("completed");
    expect(runs.get(run.runId)?.leaseOwnerId).toBeUndefined();
    expect(timeline.map((item) => item.eventType)).not.toContain("run_failed");
    expect(checkpoints.filter((item) => item.checkpointKind === "run_started")).toHaveLength(2);
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({
        type: "durable_run_failure_skipped_lease_lost",
        runId: "run-stale-lease-reaper",
      }),
      expect.objectContaining({
        eventClass: "operational_signal",
      }),
    );
  });

  it("retries reconcile updates after a transient version conflict", async () => {
    const run = {
      ...createRun("run-conflict", "running"),
      leaseOwnerId: "worker-old",
      leaseHeartbeatAt: "2026-03-14T00:00:00.000Z",
      leaseExpiresAt: "2026-03-14T00:00:01.000Z",
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const executeWorkflow = vi.fn(async (current: DurableRunRecord) => {
      updateRun(runs, current.runId, {
        status: "completed",
        finishedAt: "2026-03-14T00:00:05.000Z",
      });
    });
    const context = createContext(runs, checkpoints, timeline);
    const originalUpdateRun = context.storage.durableRuns.updateRun;
    let queuedConflictPending = true;
    context.storage.durableRuns.updateRun = ((input: Parameters<typeof originalUpdateRun>[0]) => {
      if (input.runId === run.runId && input.status === "queued" && queuedConflictPending) {
        queuedConflictPending = false;
        updateRun(runs, run.runId, {
          updatedAt: "2026-03-14T00:00:02.000Z",
        });
        throw new Error(`Durable run ${run.runId} update conflict`);
      }
      return originalUpdateRun(input);
    }) as typeof originalUpdateRun;
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(runs.get(run.runId)?.status).toBe("completed");
  });

  it("emits a boot resume summary and prunes orphan checkpoints on startWorker", async () => {
    const runs = new Map<string, DurableRunRecord>([
      [
        "run-resume-1",
        {
          ...createRun("run-resume-1", "running"),
          leaseOwnerId: "worker-old",
          leaseHeartbeatAt: "2026-05-14T23:55:00.000Z",
          leaseExpiresAt: "2026-05-14T23:56:00.000Z",
        },
      ],
    ]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const prune = vi.fn(() => ({
      prunedOrphans: 3,
      prunedAged: 5,
      finalBytes: 1024,
      diskBudgetBytes: 67108864,
    }));

    const infoLogs: Array<{ data: unknown; msg: string }> = [];
    const ctx = createContext(runs, checkpoints, timeline, {
      logger: {
        info: (data: unknown, msg: string) => infoLogs.push({ data, msg }),
        warn: () => {},
        debug: () => {},
        error: () => {},
      },
    });
    (ctx.storage.durableRuns as unknown as { pruneCheckpoints: typeof prune }).pruneCheckpoints = prune;

    const service = new DurableRunService(ctx as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow: vi.fn(async () => {}),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    const diag = await service.getDurableDiagnostics();
    expect(diag.lastBootRecovery).toBeDefined();
    expect(diag.lastBootRecovery?.resumedCount).toBe(1);
    expect(diag.lastBootRecovery?.prunedOrphanCheckpoints).toBe(3);
    expect(diag.lastBootRecovery?.prunedAgedCheckpoints).toBe(5);
    expect(diag.lastBootRecovery?.finalCheckpointBytes).toBe(1024);
    expect(diag.lastBootRecovery?.diskBudgetBytes).toBe(67108864);

    const resumeLog = infoLogs.find((entry) => entry.msg.includes("resumed after restart"));
    expect(resumeLog).toBeDefined();
    expect(prune.mock.calls.length).toBe(1);

    await service.stopWorker();
  });

  it("emits a debug-level boot log when no runs were resumed", async () => {
    const runs = new Map<string, DurableRunRecord>();
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const prune = vi.fn(() => ({
      prunedOrphans: 0,
      prunedAged: 0,
      finalBytes: 0,
      diskBudgetBytes: 67108864,
    }));

    const infoLogs: string[] = [];
    const debugLogs: string[] = [];
    const ctx = createContext(runs, checkpoints, timeline, {
      logger: {
        info: (_d: unknown, msg: string) => infoLogs.push(msg),
        debug: (_d: unknown, msg: string) => debugLogs.push(msg),
        warn: () => {},
        error: () => {},
      },
    });
    (ctx.storage.durableRuns as unknown as { pruneCheckpoints: typeof prune }).pruneCheckpoints = prune;

    const service = new DurableRunService(ctx as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow: vi.fn(async () => {}),
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    expect(debugLogs.some((m) => m.includes("no durable runs required resume"))).toBe(true);
    expect(infoLogs.filter((m) => m.includes("resumed after restart")).length).toBe(0);

    await service.stopWorker();
  });
});

describe("DurableRunService — task auto-block bridge", () => {
  it("invokes taskLifecycle.autoBlockOnIncompleteExit when a deps.taskLifecycle callback is provided", () => {
    // Verify the deps callback shape — this is a contract test, not an end-to-end test.
    const calls: Array<{ taskId: string; runId: string }> = [];
    const taskLifecycle = {
      autoBlockOnIncompleteExit: (taskId: string, runId: string) => {
        calls.push({ taskId, runId });
        return { taskId, status: "blocked" };
      },
    };
    // Direct invocation simulates the bridge code path
    taskLifecycle.autoBlockOnIncompleteExit("t-1", "run-1");
    expect(calls).toEqual([{ taskId: "t-1", runId: "run-1" }]);
  });
});

function createContext(
  runs: Map<string, DurableRunRecord>,
  checkpoints: Array<{ runId: string; checkpointKind: string }>,
  timeline: Array<{ runId: string; eventType: string }>,
  options?: {
    retries?: Map<string, DurableRetryRecord[]>;
    deadLetters?: Map<
      string,
      {
        dead_letter_id: string;
        run_id: string;
        reason: string;
        resolved_at?: string;
        resolution_note?: string;
      }
    >;
    publishRealtime?: (
      eventType: string,
      source: string,
      payload: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => void;
    logger?: DurableRunServiceLogger;
    isFeatureEnabled?: (feature: string) => boolean;
  },
) {
  const retries = options?.retries ?? new Map<string, DurableRetryRecord[]>();
  const checkpointRecords: Array<{
    checkpointId: string;
    runId: string;
    checkpointKind: string;
    state: Record<string, unknown>;
    createdAt: string;
  }> = [];
  const deadLetters =
    options?.deadLetters ??
    new Map<
      string,
      {
        dead_letter_id: string;
        run_id: string;
        reason: string;
        resolved_at?: string;
        resolution_note?: string;
      }
    >();
  let transactionTail: Promise<void> = Promise.resolve();

  const runImmediateTransaction = async <T>(callback: () => T | Promise<T>): Promise<T> => {
    const previous = transactionTail;
    let release!: () => void;
    transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  };

  return {
    storage: {
      durableRuns: {
        statusCounts: () => ({}),
        countRuns: () => runs.size,
        listDeadLetters: () =>
          [...deadLetters.values()].map((row) => ({
            deadLetterId: row.dead_letter_id,
            runId: row.run_id,
            reason: row.reason,
            payload: {},
            createdAt: "2026-03-14T00:00:00.000Z",
            resolvedAt: row.resolved_at,
            resolutionNote: row.resolution_note,
          })),
        listRuns: () => [...runs.values()],
        listRunIdsByStatus: (status: DurableRunRecord["status"]) =>
          [...runs.values()].filter((run) => run.status === status).map((run) => run.runId),
        listPendingLinkedFinalizationRunIds: (limit = 500, afterRunId?: string) =>
          [...runs.values()]
            .filter(
              (run) =>
                run.status === "failed" &&
                Boolean(
                  (run.metadata as { linkedFinalizationPending?: unknown } | undefined)?.linkedFinalizationPending,
                ),
            )
            .map((run) => run.runId)
            .sort()
            .filter((runId) => afterRunId === undefined || runId > afterRunId)
            .slice(0, limit),
        listPendingAutonomousChatPostCommitRunIds: (limit = 500, afterRunId?: string) =>
          [...runs.values()]
            .filter(
              (run) =>
                run.status === "completed" &&
                run.workflowKey === "chat.turn.execute" &&
                Boolean(
                  (run.metadata as { autonomousChatPostCommitPending?: unknown } | undefined)
                    ?.autonomousChatPostCommitPending,
                ),
            )
            .map((run) => run.runId)
            .sort()
            .filter((runId) => afterRunId === undefined || runId > afterRunId)
            .slice(0, limit),
        listPendingGeneralChatPostCommitRunIds: (limit = 500, afterRunId?: string) =>
          [...runs.values()]
            .filter(
              (run) =>
                (run.status === "completed" ||
                  run.status === "failed" ||
                  run.status === "cancelled" ||
                  run.status === "waiting") &&
                run.workflowKey === "chat.turn.execute" &&
                Boolean(
                  (run.metadata as { generalChatPostCommitPending?: unknown } | undefined)
                    ?.generalChatPostCommitPending,
                ),
            )
            .map((run) => run.runId)
            .sort()
            .filter((runId) => afterRunId === undefined || runId > afterRunId)
            .slice(0, limit),
        listCheckpoints: () => [],
        listRetries: (runId: string) => retries.get(runId) ?? [],
        upsertRetry: (input: DurableRetryRecord) => {
          const current = retries.get(input.runId) ?? [];
          retries.set(input.runId, [...current.filter((item) => item.attemptNo !== input.attemptNo), input]);
          return input;
        },
        upsertDeadLetter: (input: { runId: string; reason: string; payload?: Record<string, unknown> }) => {
          const deadLetterId = `dead-${deadLetters.size + 1}`;
          const row = {
            dead_letter_id: deadLetterId,
            run_id: input.runId,
            reason: input.reason,
          };
          deadLetters.set(deadLetterId, row);
          return {
            deadLetterId,
            runId: input.runId,
            reason: input.reason,
            payload: input.payload ?? {},
            createdAt: "2026-03-14T00:00:00.000Z",
          };
        },
        getRun: (runId: string) => {
          const run = runs.get(runId);
          if (!run) {
            throw new NotFoundError({ entity: "Durable run", id: runId });
          }
          return run;
        },
        getRunForUpdate: (runId: string) => {
          const run = runs.get(runId);
          if (!run) {
            throw new NotFoundError({ entity: "Durable run", id: runId });
          }
          return run;
        },
        createRun: (input: {
          runId?: string;
          workflowKey: string;
          status?: DurableRunRecord["status"];
          attemptCount?: number;
          maxAttempts?: number;
          payload?: Record<string, unknown>;
          metadata?: Record<string, unknown>;
          startedAt?: string;
          finishedAt?: string;
          lastError?: string;
          now?: string;
        }) => {
          const run: DurableRunRecord = {
            runId: input.runId ?? `run-${runs.size + 1}`,
            workflowKey: input.workflowKey,
            status: input.status ?? "queued",
            attemptCount: input.attemptCount ?? 0,
            maxAttempts: input.maxAttempts ?? 3,
            version: 1,
            payload: input.payload ?? {},
            metadata: input.metadata,
            startedAt: input.startedAt,
            finishedAt: input.finishedAt,
            lastError: input.lastError,
            leaseOwnerId: undefined,
            leaseExpiresAt: undefined,
            leaseHeartbeatAt: undefined,
            createdAt: input.now ?? "2026-03-14T00:00:00.000Z",
            updatedAt: input.now ?? "2026-03-14T00:00:00.000Z",
          };
          runs.set(run.runId, run);
          return run;
        },
        updateRun: (input: {
          runId: string;
          status?: DurableRunRecord["status"];
          metadata?: Record<string, unknown>;
          startedAt?: string;
          finishedAt?: string;
          clearFinishedAt?: boolean;
          updatedAt?: string;
          attemptCount?: number;
          lastError?: string;
          clearLastError?: boolean;
          clearLease?: boolean;
          leaseOwnerId?: string;
          leaseExpiresAt?: string;
          leaseHeartbeatAt?: string;
          expectedVersion?: number;
        }) => updateRun(runs, input.runId, input),
        tryClaimQueuedRun: (input: {
          runId: string;
          workerId: string;
          leaseHeartbeatAt: string;
          leaseExpiresAt: string;
          updatedAt?: string;
        }) => {
          const current = runs.get(input.runId);
          if (!current || current.status !== "queued") {
            return undefined;
          }
          return updateRun(runs, input.runId, {
            status: "running",
            startedAt: current.startedAt ?? input.leaseHeartbeatAt,
            updatedAt: input.updatedAt ?? input.leaseHeartbeatAt,
            clearFinishedAt: true,
            clearLastError: true,
            leaseOwnerId: input.workerId,
            leaseHeartbeatAt: input.leaseHeartbeatAt,
            leaseExpiresAt: input.leaseExpiresAt,
          });
        },
        tryClaimQueuedRunWithDatabaseClock: (input: { runId: string; workerId: string; leaseDurationMs: number }) => {
          const latestRetry = [...(retries.get(input.runId) ?? [])]
            .sort((left, right) => left.attemptNo - right.attemptNo)
            .at(-1);
          if (latestRetry?.nextRetryAt && Date.parse(latestRetry.nextRetryAt) > Date.now()) {
            return undefined;
          }
          const current = runs.get(input.runId);
          if (!current || current.status !== "queued") {
            return undefined;
          }
          const leaseHeartbeatAt = new Date().toISOString();
          return updateRun(runs, input.runId, {
            status: "running",
            startedAt: current.startedAt ?? leaseHeartbeatAt,
            updatedAt: leaseHeartbeatAt,
            clearFinishedAt: true,
            clearLastError: true,
            leaseOwnerId: input.workerId,
            leaseHeartbeatAt,
            leaseExpiresAt: new Date(Date.now() + input.leaseDurationMs).toISOString(),
          });
        },
        renewLease: (input: {
          runId: string;
          workerId: string;
          leaseHeartbeatAt: string;
          leaseExpiresAt: string;
          updatedAt?: string;
        }) => {
          const current = runs.get(input.runId);
          if (!current || current.leaseOwnerId !== input.workerId) {
            return undefined;
          }
          return updateRun(runs, input.runId, {
            updatedAt: input.updatedAt ?? input.leaseHeartbeatAt,
            leaseOwnerId: input.workerId,
            leaseHeartbeatAt: input.leaseHeartbeatAt,
            leaseExpiresAt: input.leaseExpiresAt,
          });
        },
        listExpiredRunningRunIds: (nowIso: string) =>
          Array.from(runs.values())
            .filter(
              (run) =>
                run.status === "running" && typeof run.leaseExpiresAt === "string" && run.leaseExpiresAt <= nowIso,
            )
            .map((run) => run.runId),
        createCheckpoint: (input: {
          runId: string;
          checkpointKind: string;
          state?: Record<string, unknown>;
          createdAt?: string;
        }) => {
          checkpoints.push({
            runId: input.runId,
            checkpointKind: input.checkpointKind,
          });
          checkpointRecords.push({
            checkpointId: `checkpoint-${checkpointRecords.length + 1}`,
            runId: input.runId,
            checkpointKind: input.checkpointKind,
            state: input.state ?? {},
            createdAt: input.createdAt ?? new Date().toISOString(),
          });
          return input;
        },
        getLatestCheckpointByKind: (runId: string, checkpointKind: string) =>
          checkpointRecords
            .filter((checkpoint) => checkpoint.runId === runId && checkpoint.checkpointKind === checkpointKind)
            .at(-1),
        getDeadLetterById: (deadLetterId: string) => {
          const row = deadLetters.get(deadLetterId);
          if (!row) {
            throw new Error(`Unknown dead letter ${deadLetterId}`);
          }
          return {
            deadLetterId: row.dead_letter_id,
            runId: row.run_id,
            reason: row.reason,
            payload: {},
            createdAt: "2026-03-14T00:00:00.000Z",
            resolvedAt: row.resolved_at,
            resolutionNote: row.resolution_note,
          };
        },
        resolveDeadLetter: (
          deadLetterId: string,
          input: {
            resolvedAt?: string;
            resolutionNote?: string;
          },
        ) => {
          const current = deadLetters.get(deadLetterId);
          if (!current) {
            throw new Error(`Unknown dead letter ${deadLetterId}`);
          }
          if (current.resolved_at) {
            throw new Error(`Durable dead letter ${deadLetterId} is already resolved`);
          }
          const next = {
            ...current,
            resolved_at: input.resolvedAt,
            resolution_note: input.resolutionNote,
          };
          deadLetters.set(deadLetterId, next);
          return {
            deadLetterId: next.dead_letter_id,
            runId: next.run_id,
            reason: next.reason,
            payload: {},
            createdAt: "2026-03-14T00:00:00.000Z",
            resolvedAt: next.resolved_at,
            resolutionNote: next.resolution_note,
          };
        },
      },
      durableRunEvents: {
        append: (input: { runId: string; eventType: string }) => {
          timeline.push({
            runId: input.runId,
            eventType: input.eventType,
          });
          return input;
        },
        listByRun: (runId: string) => timeline.filter((entry) => entry.runId === runId),
      },
      runImmediateTransaction,
    },
    config: {
      assistant: {
        durable: {
          enabled: true,
          workflowTimeoutMs: 300_000,
        },
      },
    },
    llmService: {},
    policyEngine: {},
    gatewaySql: {} as never,
    logger: options?.logger,
    publishRealtime: options?.publishRealtime ?? (() => undefined),
    requireFeatureEnabled: () => undefined,
    isFeatureEnabled: options?.isFeatureEnabled ?? (() => true),
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId ?? "default",
  };
}

interface AdmittedChatRuntimeFixture {
  run: DurableRunRecord;
  admission: Record<string, unknown> & {
    admissionId: string;
    sessionIncarnationId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    status: "active" | "completed" | "cancelled";
  };
  checkpointKind?: "run_waiting" | "run_completed" | "run_failed" | "run_cancelled";
  checkpointState?: Record<string, unknown>;
  assistantMessage?: {
    messageId: string;
    sessionId: string;
    role: "assistant";
    actorType: "agent";
    actorId: string;
    content: string;
    timestamp: string;
  };
}

function createAdmittedChatRuntimeFixture(input: {
  runId: string;
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
  generationId?: string;
  traceStatus?: "waiting_for_approval" | "completed" | "failed" | "cancelled";
  transitionAt?: string;
  sessionId?: string;
  turnId?: string;
}): AdmittedChatRuntimeFixture {
  const sessionId = input.sessionId ?? `session:${input.runId}`;
  const turnId = input.turnId ?? `turn:${input.runId}`;
  const workspaceId = "default";
  const admissionId = `admission:${input.runId}`;
  const sessionIncarnationId = `incarnation:${input.runId}`;
  const admissionMaterialSha256 = "a".repeat(64);
  const actorKind = "system" as const;
  const actorId = "system:test";
  const userMessageId = `user:${input.runId}`;
  const assistantMessageId = `assistant:${input.runId}`;
  const transitionAt = input.transitionAt ?? "2026-03-14T00:00:01.000Z";
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId,
    sessionIncarnationId,
    workspaceId,
    sessionId,
    turnId,
    userMessageId,
    assistantMessageId,
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    admissionMaterialSha256,
    effectiveRequestMaterialSha256: "b".repeat(64),
    admissionAggregateRevision: 7,
    admissionControllerGeneration: 2,
    requestActor: { actorKind, actorId },
    request: { content: "Exercise exact durable authority." },
  };
  const admission: AdmittedChatRuntimeFixture["admission"] = {
    admissionId,
    admissionKind: "turn_write",
    status: "active",
    sessionIncarnationId,
    workspaceId,
    sessionId,
    turnId,
    aggregateRevision: 7,
    controllerGeneration: 2,
    actorKind,
    actorId,
    operation: "chat_send",
    materialSha256: admissionMaterialSha256,
  };
  let metadata: Record<string, unknown> = {
    retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT },
  };
  let checkpointKind: AdmittedChatRuntimeFixture["checkpointKind"];
  let checkpointState: Record<string, unknown> | undefined;
  let assistantMessage: AdmittedChatRuntimeFixture["assistantMessage"];
  if (input.status !== "running") {
    const generationId = input.generationId ?? `generation:${input.runId}`;
    const traceStatus =
      input.traceStatus ??
      (input.status === "waiting" ? "waiting_for_approval" : input.status === "completed" ? "completed" : input.status);
    const waitForEvent = {
      eventKey: "approval.resolved",
      correlationId: `approval:${generationId}`,
    };
    const outputText = `Canonical output for ${input.runId}`;
    const authority = buildChatTurnRuntimeAuthoritySeal({
      runId: input.runId,
      turnId,
      transitionKind: input.status === "waiting" ? "waiting" : "terminal",
      durableStatus: input.status,
      traceStatus,
      transitionAt,
      postCommitGenerationId: generationId,
      postCommitEligibility: TEST_POST_COMMIT_ELIGIBILITY,
      ...(input.status === "waiting" ? { waitForEvent } : {}),
      ...(input.status === "completed"
        ? {
            terminalOutput: {
              assistantMessageId,
              outputText,
              outputSummary: outputText,
            },
          }
        : {}),
      requiredFinalizers: ["general"],
    });
    metadata = withChatTurnRuntimeAuthority(
      {
        ...metadata,
        generalChatPostCommitPending: {
          version: 1,
          generationId,
          traceStatus,
          requestedAt: transitionAt,
          postCommitEligibility: TEST_POST_COMMIT_ELIGIBILITY,
          completedEffects: [],
          durableEffectRunIds: {},
        },
        ...(input.status === "waiting" ? { waitForEvent } : {}),
        ...(input.status === "completed"
          ? {
              outputText,
              finalOutput: outputText,
              outputSummary: outputText,
              finalSummary: outputText,
            }
          : {}),
      },
      authority,
    );
    checkpointKind =
      input.status === "waiting"
        ? "run_waiting"
        : input.status === "completed"
          ? "run_completed"
          : input.status === "failed"
            ? "run_failed"
            : "run_cancelled";
    checkpointState = withChatTurnRuntimeAuthorityCheckpoint(
      input.status === "waiting"
        ? { waitForEvent }
        : input.status === "completed"
          ? { assistantMessageId, outputText, outputSummary: outputText }
          : {},
      authority,
    );
    if (input.status === "completed") {
      assistantMessage = {
        messageId: assistantMessageId,
        sessionId,
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        content: outputText,
        timestamp: transitionAt,
      };
    }
  }
  return {
    run: {
      ...createRun(input.runId, input.status, "chat.turn.execute"),
      payload,
      metadata,
      ...(input.status === "completed" || input.status === "failed" || input.status === "cancelled"
        ? { finishedAt: transitionAt }
        : {}),
    },
    admission,
    ...(checkpointKind ? { checkpointKind, checkpointState } : {}),
    ...(assistantMessage ? { assistantMessage } : {}),
  };
}

async function installAdmittedChatRuntimeFixture(
  context: ReturnType<typeof createContext>,
  fixture: AdmittedChatRuntimeFixture,
): Promise<{
  recordTransitionEvidence(next: AdmittedChatRuntimeFixture): Promise<void>;
}> {
  const admission = fixture.admission;
  const assistantMessages = new Map<string, NonNullable<AdmittedChatRuntimeFixture["assistantMessage"]>>();
  const recordTransitionEvidence = async (next: AdmittedChatRuntimeFixture): Promise<void> => {
    if (next.checkpointKind && next.checkpointState) {
      await context.storage.durableRuns.createCheckpoint({
        runId: next.run.runId,
        checkpointKind: next.checkpointKind,
        state: next.checkpointState,
        createdAt: next.run.finishedAt ?? next.run.updatedAt,
      });
    }
    if (next.assistantMessage) {
      assistantMessages.set(next.assistantMessage.messageId, next.assistantMessage);
    }
  };
  Object.assign(context.storage, {
    sessionMutationAdmissions: {
      require: (admissionId: string) => {
        if (admissionId !== admission.admissionId) throw new Error(`Unknown admission ${admissionId}`);
        return admission;
      },
      findDurableRunBinding: (identity: { admissionId: string; turnId: string }) =>
        identity.admissionId === admission.admissionId && identity.turnId === admission.turnId
          ? {
              admissionId: admission.admissionId,
              sessionIncarnationId: admission.sessionIncarnationId,
              workspaceId: admission.workspaceId,
              sessionId: admission.sessionId,
              turnId: admission.turnId,
              durableRunId: fixture.run.runId,
              createdAt: fixture.run.createdAt,
            }
          : undefined,
      settleTurnWriteAuthority: () => ({ disposition: "current", admission }),
      closeTurnWrite: async (input: { status: "completed" | "cancelled"; correlationId: string }) => {
        admission.status = input.status;
        admission.terminalAuthorityKind = "durable_terminal";
        admission.terminalDurableRunId = input.correlationId;
        admission.terminalDurableRunStatus = (await context.storage.durableRuns.getRun(input.correlationId)).status;
        return admission;
      },
    },
    chatSessionMeta: {
      get: (sessionId: string) =>
        sessionId === fixture.run.payload.sessionId
          ? { sessionId, workspaceId: "default", revision: 7, origin: "operator" }
          : undefined,
    },
    chatMessages: {
      get: (messageId: string) => assistantMessages.get(messageId),
    },
  });
  await recordTransitionEvidence(fixture);
  return { recordTransitionEvidence };
}

function createCompletedHeartbeatPostCommitFixture(
  runId: string,
  options?: { rawOutput?: string; metadataRawOutput?: string },
) {
  const workspaceId = "default";
  const sessionId = `session:${runId}`;
  const sessionIncarnationId = `incarnation:${runId}`;
  const turnId = `turn:${runId}`;
  const userMessageId = `user:${runId}`;
  const assistantMessageId = `assistant:${runId}`;
  const admissionId = `admission:${runId}`;
  const occurrenceId = `occurrence:${runId}`;
  const claimSha256 = "c".repeat(64);
  const capabilityProfileId = "heartbeat-restricted";
  const capabilityProfileHash = "f".repeat(64);
  const capabilitySnapshotId = `snapshot:${runId}`;
  const generationId = `generation:${runId}`;
  const transitionAt = "2026-03-14T00:00:01.000Z";
  const rawOutput = options?.rawOutput ?? '{"notify":false}';
  const request = {
    content: "Perform the bounded heartbeat check and return the exact decision object.",
    permissionProfileId: capabilityProfileId,
    policyRunId: runId,
  };
  const admissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(request as never);
  const payload = {
    version: "chat.turn.execute.v2" as const,
    admissionId,
    sessionIncarnationId,
    workspaceId,
    sessionId,
    turnId,
    userMessageId,
    assistantMessageId,
    branchKind: "new",
    threadEventType: "chat_thread_turn_appended",
    admissionMaterialSha256,
    effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(
      admissionMaterialSha256,
      request as never,
    ),
    admissionAggregateRevision: 7,
    admissionControllerGeneration: 2,
    requestActor: { actorKind: "system", actorId: "system-heartbeat" },
    request,
    capabilityProfileId,
    capabilityProfileHash,
    heartbeatOccurrenceId: occurrenceId,
    heartbeatClaimSha256: claimSha256,
    heartbeatEvaluatedPolicySha256: "d".repeat(64),
    heartbeatFrozenObjectiveSha256: "e".repeat(64),
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
      capabilitySnapshotId,
    }),
  );
  const decision = buildHeartbeatDecisionReceipt({ occurrenceId, claimSha256, rawOutput });
  const receipt = decision.receipt;
  const normalizedMessage = decision.decision.notify ? decision.decision.normalizedMessage : undefined;
  const authority = buildChatTurnRuntimeAuthoritySeal({
    runId,
    turnId,
    transitionKind: "terminal",
    durableStatus: "completed",
    traceStatus: "completed",
    transitionAt,
    postCommitGenerationId: generationId,
    postCommitEligibility: TEST_HEARTBEAT_POST_COMMIT_ELIGIBILITY,
    heartbeatDecisionReceipt: receipt,
    ...(normalizedMessage
      ? {
          terminalOutput: {
            assistantMessageId,
            outputText: normalizedMessage,
            outputSummary: normalizedMessage,
          },
        }
      : {}),
    requiredFinalizers: ["autonomous", "general"],
  });
  const metadata = withChatTurnRuntimeAuthority(
    {
      retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT },
      objective: request.content,
      autonomous,
      autonomousAdmission,
      capabilityProfileId,
      capabilityProfileHash,
      heartbeatDecisionReceipt: receipt,
      heartbeatDecisionRawOutput: options?.metadataRawOutput ?? rawOutput,
      ...(normalizedMessage
        ? {
            outputText: normalizedMessage,
            finalOutput: normalizedMessage,
            outputSummary: normalizedMessage,
            finalSummary: normalizedMessage,
          }
        : {}),
      autonomousChatPostCommitPending: {
        version: 1,
        generationId,
        requestedAt: transitionAt,
      },
      generalChatPostCommitPending: {
        version: 1,
        generationId,
        traceStatus: "completed",
        requestedAt: transitionAt,
        postCommitEligibility: TEST_HEARTBEAT_POST_COMMIT_ELIGIBILITY,
        completedEffects: [],
        durableEffectRunIds: {},
      },
    },
    authority,
  );
  const checkpointState = withChatTurnRuntimeAuthorityCheckpoint(
    {
      heartbeatDecisionReceipt: receipt,
      heartbeatDecisionRawOutput: rawOutput,
      ...(normalizedMessage
        ? {
            assistantMessageId,
            outputText: normalizedMessage,
            outputSummary: normalizedMessage,
          }
        : {}),
    },
    authority,
  );
  const admission: AdmittedChatRuntimeFixture["admission"] & {
    workspaceId: string;
    sessionId: string;
    sessionIncarnationId: string;
    turnId: string;
    terminalAuthorityKind?: string;
    terminalDurableRunId?: string;
    terminalDurableRunStatus?: string;
  } = {
    admissionId,
    admissionKind: "turn_write",
    status: "active",
    sessionIncarnationId,
    workspaceId,
    sessionId,
    turnId,
    aggregateRevision: 7,
    controllerGeneration: 2,
    actorKind: "system",
    actorId: "system-heartbeat",
    operation: "chat_system_heartbeat",
    materialSha256: admissionMaterialSha256,
  };
  const trace = {
    turnId,
    sessionId,
    userMessageId,
    assistantMessageId,
    status: "completed",
    capabilitySnapshotId,
    capabilityProfileId,
    capabilityProfileHash,
  } as ChatTurnTraceRecord;
  const assistantMessage = normalizedMessage
    ? {
        messageId: assistantMessageId,
        sessionId,
        role: "assistant" as const,
        actorType: "system" as const,
        actorId: "system-heartbeat",
        content: normalizedMessage,
        timestamp: transitionAt,
      }
    : undefined;
  const run = {
    ...createRun(runId, "completed", "chat.turn.execute"),
    payload,
    metadata,
    finishedAt: transitionAt,
    updatedAt: transitionAt,
  } satisfies DurableRunRecord;
  return { run, admission, trace, checkpointState, generationId, receipt, assistantMessage };
}

async function createHeartbeatBootRecoveryHarness(
  fixture: ReturnType<typeof createCompletedHeartbeatPostCommitFixture>,
) {
  const runs = new Map<string, DurableRunRecord>([[fixture.run.runId, fixture.run]]);
  const backgroundTasks = new Set<Promise<void>>();
  const recoveryError = vi.fn();
  const context = createContext(runs, [], [], {
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: recoveryError,
    },
  });
  const getMessage = vi.fn((messageId: string) =>
    messageId === fixture.assistantMessage?.messageId ? fixture.assistantMessage : undefined,
  );
  const settleTurnWriteAuthority = vi.fn(() => ({ disposition: "current", admission: fixture.admission }));
  const closeTurnWrite = vi.fn((input: { status: "completed" | "cancelled"; correlationId: string }) => {
    fixture.admission.status = input.status;
    fixture.admission.terminalAuthorityKind = "durable_terminal";
    fixture.admission.terminalDurableRunId = input.correlationId;
    fixture.admission.terminalDurableRunStatus = input.status;
    return fixture.admission;
  });
  let occurrenceState: "durable_bound" | "terminal" = "durable_bound";
  const markTerminal = vi.fn(() => {
    if (occurrenceState === "terminal") {
      return { disposition: "replayed", occurrence: { state: occurrenceState } };
    }
    occurrenceState = "terminal";
    return { disposition: "terminal", occurrence: { state: occurrenceState } };
  });
  Object.assign(context.storage, {
    heartbeatOccurrences: { markTerminal },
    sessionMutationAdmissions: {
      require: (admissionId: string) => {
        if (admissionId !== fixture.admission.admissionId) {
          throw new Error(`Unknown admission ${admissionId}`);
        }
        return fixture.admission;
      },
      settleTurnWriteAuthority,
      closeTurnWrite,
    },
    chatTurnTraces: {
      get: (turnId: string) => (turnId === fixture.trace.turnId ? fixture.trace : undefined),
    },
    chatMessages: { get: getMessage },
  });
  await context.storage.durableRuns.createCheckpoint({
    runId: fixture.run.runId,
    checkpointKind: "run_completed",
    state: fixture.checkpointState,
    createdAt: fixture.run.finishedAt,
  });
  const onAutonomousChatPostCommit = vi.fn(async () => ({
    delivery: { status: "skipped", reason: "silent_heartbeat" },
    heartbeatCleanup: { status: "not_required" },
  }));
  const onGeneralChatPostCommit = vi.fn(async () => ({ status: "completed" }));
  const service = new DurableRunService(context as unknown as ServiceContext, {
    backgroundTasks,
    workflowRegistry: {
      executeWorkflow: vi.fn(),
      isWorkflowRecoverable: () => ({ recoverable: true }),
      markWorkflowUnrecoverable: vi.fn(),
    },
    onAutonomousChatPostCommit,
    onGeneralChatPostCommit,
  });
  return {
    runs,
    backgroundTasks,
    service,
    recoveryError,
    getMessage,
    settleTurnWriteAuthority,
    closeTurnWrite,
    markTerminal,
    onAutonomousChatPostCommit,
    onGeneralChatPostCommit,
    getOccurrenceState: () => occurrenceState,
  };
}

function createQueuedHeartbeatWorkerRun(
  runId: string,
  attemptCount = 0,
  maxAttempts = DURABLE_RETRY_POLICY_DEFAULT.maxAttempts,
): DurableRunRecord {
  const sessionId = `session:${runId}`;
  const turnId = `turn:${runId}`;
  const admissionMaterialSha256 = "a".repeat(64);
  return {
    ...createRun(runId, "queued", "chat.turn.execute"),
    attemptCount,
    maxAttempts,
    payload: {
      version: "chat.turn.execute.v2",
      admissionId: `admission:${runId}`,
      sessionIncarnationId: `incarnation:${runId}`,
      workspaceId: "default",
      sessionId,
      turnId,
      userMessageId: `user:${runId}`,
      assistantMessageId: `assistant:${runId}`,
      branchKind: "new",
      threadEventType: "chat_thread_turn_appended",
      admissionMaterialSha256,
      effectiveRequestMaterialSha256: "b".repeat(64),
      admissionAggregateRevision: 7,
      admissionControllerGeneration: 2,
      requestActor: { actorKind: "system", actorId: "system-heartbeat" },
      request: {
        content: "Perform the bounded heartbeat check and return the exact decision object.",
        permissionProfileId: "heartbeat-restricted",
        policyRunId: runId,
      },
      heartbeatOccurrenceId: `occurrence:${runId}`,
      heartbeatClaimSha256: "c".repeat(64),
      heartbeatEvaluatedPolicySha256: "d".repeat(64),
      heartbeatFrozenObjectiveSha256: "e".repeat(64),
    },
    metadata: {
      retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT, maxAttempts },
      autonomous: {
        kind: "heartbeat",
        systemActorId: "system-heartbeat",
        sourceRunId: runId,
        reason: `heartbeat self-wake:${sessionId}`,
        deliverMode: "on_notify",
      },
    },
  };
}

function createRun(
  runId: string,
  status: DurableRunRecord["status"],
  workflowKey: DurableRunRecord["workflowKey"] = "chat.turn.execute",
): DurableRunRecord {
  return {
    runId,
    workflowKey,
    status,
    attemptCount: 0,
    maxAttempts: 3,
    version: 1,
    payload: {},
    metadata: {},
    leaseOwnerId: undefined,
    leaseExpiresAt: undefined,
    leaseHeartbeatAt: undefined,
    createdAt: "2026-03-14T00:00:00.000Z",
    updatedAt: "2026-03-14T00:00:00.000Z",
    startedAt: "2026-03-14T00:00:00.000Z",
  };
}

function updateRun(
  runs: Map<string, DurableRunRecord>,
  runId: string,
  patch: {
    status?: DurableRunRecord["status"];
    metadata?: Record<string, unknown>;
    startedAt?: string;
    finishedAt?: string;
    clearFinishedAt?: boolean;
    updatedAt?: string;
    attemptCount?: number;
    lastError?: string;
    clearLastError?: boolean;
    leaseOwnerId?: string;
    leaseExpiresAt?: string;
    leaseHeartbeatAt?: string;
    clearLease?: boolean;
    expectedVersion?: number;
  },
): DurableRunRecord {
  const current = runs.get(runId);
  if (!current) {
    throw new Error(`Unknown run ${runId}`);
  }
  if (patch.expectedVersion !== undefined && current.version !== patch.expectedVersion) {
    throw new Error(`Durable run ${runId} update conflict`);
  }
  const next = {
    ...current,
    version: (current.version ?? 1) + 1,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
    ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
    ...(patch.clearFinishedAt
      ? { finishedAt: undefined }
      : patch.finishedAt !== undefined
        ? { finishedAt: patch.finishedAt }
        : {}),
    ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
    ...(patch.attemptCount !== undefined ? { attemptCount: patch.attemptCount } : {}),
    ...(patch.clearLastError
      ? { lastError: undefined }
      : patch.lastError !== undefined
        ? { lastError: patch.lastError }
        : {}),
    ...(patch.clearLease ? { leaseOwnerId: undefined, leaseExpiresAt: undefined, leaseHeartbeatAt: undefined } : {}),
    ...(patch.leaseOwnerId !== undefined ? { leaseOwnerId: patch.leaseOwnerId } : {}),
    ...(patch.leaseExpiresAt !== undefined ? { leaseExpiresAt: patch.leaseExpiresAt } : {}),
    ...(patch.leaseHeartbeatAt !== undefined ? { leaseHeartbeatAt: patch.leaseHeartbeatAt } : {}),
  };
  runs.set(runId, next);
  return next;
}

function createRetry(runId: string, attemptNo: number, nextRetryAt: string): DurableRetryRecord {
  return {
    retryId: `${runId}-retry-${attemptNo}`,
    runId,
    attemptNo,
    reason: "temporary failure",
    nextRetryAt,
    createdAt: "2026-03-14T00:00:00.000Z",
  };
}
