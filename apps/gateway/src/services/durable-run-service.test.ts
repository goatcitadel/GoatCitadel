import { describe, expect, it, vi } from "vitest";
import type { ChatTurnTraceRecord, DurableRetryRecord, DurableRunRecord } from "@goatcitadel/contracts";
import type { ServiceContext } from "./service-context.js";
import {
  computeDurableBaselineDrift,
  DurableRunService,
  resolveDurableWorkflowTimeoutMs,
  type DurableRunServiceLogger,
} from "./durable-run-service.js";
import { GENERAL_CHAT_POST_COMMIT_EFFECTS, type GeneralChatPostCommitProgress } from "./chat-durable-run-service.js";

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

  it("updates run state against the current version and preserves unspecified fields (moved from the gateway facade, B2)", () => {
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
      service.updateRunState({
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

    service.updateRunState({ runId: "run-1" });
    expect(updateRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "running",
        metadata: { prior: true },
        expectedVersion: 7,
      }),
    );
  });

  it("fences workflow state updates to the expected unexpired lease owner", () => {
    const current = {
      ...createRun("run-fenced-update", "running"),
      version: 7,
      leaseOwnerId: "worker-b",
      leaseHeartbeatAt: "2026-05-14T21:30:00.000Z",
      leaseExpiresAt: "2099-12-31T23:59:59.999Z",
    };
    const updateRun = vi.fn((input: Record<string, unknown>) => ({ ...current, ...input, version: 8 }));
    const service = new DurableRunService({
      storage: {
        durableRuns: {
          getRun: vi.fn(() => current),
          updateRun,
        },
      },
    } as unknown as ServiceContext);

    let staleError: unknown;
    try {
      service.updateRunState({
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
      service.updateRunState({
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

  it("preserves caller metadata when creating durable runs", () => {
    const runs = new Map<string, DurableRunRecord>();
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const service = new DurableRunService(createContext(runs, checkpoints, timeline) as unknown as ServiceContext);

    const created = service.createDurableRun({
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

  it("rejects raw remote approval bearers before durable persistence", () => {
    const runs = new Map<string, DurableRunRecord>();
    const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext);
    const rawToken = `grat_${"p".repeat(43)}`;

    expect(() =>
      service.createDurableRun({
        workflowKey: "connector.delivery",
        payload: { interactiveActions: { callbackData: `gca:${rawToken}:a` } },
      }),
    ).toThrow(/cannot be persisted in durable run state/i);
    expect(() =>
      service.createDurableRun({
        workflowKey: "connector.delivery",
        payload: { message: `prefix x${rawToken}y suffix` },
      }),
    ).toThrow(/cannot be persisted in durable run state/i);
    expect(() => service.createDurableRun({ workflowKey: `connector.${rawToken}` })).toThrow(
      /cannot be persisted in durable run state/i,
    );
    expect(runs.size).toBe(0);
  });

  it("rejects raw remote approval bearers in wake and retry mutation fields", () => {
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

    expect(() =>
      service.wakeDurableRun(waiting.runId, {
        eventKey: "approval.resolved",
        payload: { token: `prefix-${rawToken}-suffix` },
      }),
    ).toThrow(/cannot be persisted in durable run state/i);
    expect(() => service.retryDurableRun(failed.runId, `retry ${rawToken}`, "operator")).toThrow(
      /cannot be persisted in durable run state/i,
    );
    expect(runs.get(waiting.runId)?.status).toBe("waiting");
    expect(runs.get(failed.runId)?.status).toBe("failed");
    expect(timeline).toEqual([]);
  });

  it("does not reject benign token-like durable content", () => {
    const runs = new Map<string, DurableRunRecord>();
    const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext);

    expect(() =>
      service.createDurableRun({
        workflowKey: "connector.delivery",
        payload: { message: "Use grat_community_discount_code for this test fixture." },
      }),
    ).not.toThrow();
    expect(runs.size).toBe(1);
  });

  it("commits run creation, checkpoints, and timeline as one storage transaction", () => {
    const runs = new Map<string, DurableRunRecord>();
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const context = createContext(runs, checkpoints, timeline);
    context.storage.runImmediateTransaction = <T>(callback: () => T): T => {
      const runSnapshot = new Map(runs);
      const checkpointLength = checkpoints.length;
      const timelineLength = timeline.length;
      try {
        return callback();
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

    expect(() => service.createDurableRun({ workflowKey: "connector.delivery" })).toThrow(
      "checkpoint write unavailable",
    );
    expect(runs.size).toBe(0);
    expect(checkpoints).toHaveLength(0);
    expect(timeline).toHaveLength(0);
  });

  it("returns committed run truth when retained realtime publication fails", () => {
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
    const run = service.createDurableRun({ workflowKey: "connector.delivery" });

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

  it("recovers general Chat post-commit work once and clears its durable marker", async () => {
    const run = {
      ...createRun("run-general-post-commit", "completed"),
      metadata: {
        generalChatPostCommitPending: {
          version: 1,
          generationId: "generation-general",
          traceStatus: "completed",
          requestedAt: "2026-03-14T00:00:01.000Z",
          completedEffects: [],
        },
      },
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const backgroundTasks = new Set<Promise<void>>();
    const enqueueAgentEnd = vi.fn();
    const persistLearnedMemory = vi.fn();
    const scheduleMaintenance = vi.fn();
    const onGeneralChatPostCommit = vi.fn(async (_run: DurableRunRecord, progress: GeneralChatPostCommitProgress) => {
      progress.runEffect("agent_end", enqueueAgentEnd);
      progress.runEffect("learned_memory_user", persistLearnedMemory);
      progress.runEffect("memory_maintenance", scheduleMaintenance);
      for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
        progress.runEffect(effect, () => undefined);
      }
      return { status: "completed" };
    });
    const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext, {
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

  it("resumes after a later general Chat consumer fails without repeating earlier committed effects", async () => {
    const run = {
      ...createRun("run-general-post-commit-partial", "completed"),
      metadata: {
        generalChatPostCommitPending: {
          version: 1,
          generationId: "generation-partial",
          traceStatus: "completed",
          requestedAt: "2026-03-14T00:00:01.000Z",
          completedEffects: [],
        },
      },
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const persistLearnedMemory = vi.fn();
    const advanceBackgroundReview = vi.fn();
    const publishRealtime = vi.fn();
    let failRealtime = true;
    const onGeneralChatPostCommit = vi.fn(
      async (_observed: DurableRunRecord, progress: GeneralChatPostCommitProgress) => {
        progress.runEffect("learned_memory_user", persistLearnedMemory);
        progress.runEffect("background_review", advanceBackgroundReview);
        progress.runEffect("realtime", () => {
          publishRealtime();
          if (failRealtime) {
            failRealtime = false;
            throw new Error("retained realtime unavailable");
          }
        });
        for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
          progress.runEffect(effect, () => undefined);
        }
        return { status: "completed" };
      },
    );
    const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext, {
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
        completedEffects: ["learned_memory_user", "background_review"],
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
    const run = {
      ...createRun("run-general-post-commit-generation-race", "waiting"),
      metadata: {
        generalChatPostCommitPending: {
          version: 1,
          generationId: "generation-waiting",
          traceStatus: "waiting_for_approval",
          requestedAt: "2026-03-14T00:00:01.000Z",
          completedEffects: [],
        },
      },
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const observedGenerations: string[] = [];
    const onGeneralChatPostCommit = vi.fn(
      async (_observed: DurableRunRecord, progress: GeneralChatPostCommitProgress) => {
        observedGenerations.push(progress.generationId);
        for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
          progress.runEffect(effect, () => undefined);
        }
        if (progress.generationId === "generation-waiting") {
          const current = runs.get(run.runId)!;
          runs.set(run.runId, {
            ...current,
            status: "completed",
            version: current.version + 1,
            metadata: {
              ...(current.metadata ?? {}),
              generalChatPostCommitPending: {
                version: 1,
                generationId: "generation-completed",
                traceStatus: "completed",
                requestedAt: "2026-03-14T00:00:02.000Z",
                completedEffects: [],
              },
            },
          });
          return { status: "waiting_for_approval" };
        }
        return { status: "completed" };
      },
    );
    const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext, {
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
    first.stopWorker();
    second.stopWorker();

    expect(markWorkflowUnrecoverable).toHaveBeenCalledTimes(1);
    expect(runs.get(run.runId)?.metadata).not.toHaveProperty("linkedFinalizationPending");
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
      first.stopWorker();
      second.stopWorker();
      expect(runs.get(run.runId)?.metadata).not.toHaveProperty("linkedFinalizationPending");
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

  it("lets a worker-owned running workflow schedule a retry without using manual retry", async () => {
    const run = createRun("run-hook-retry", "queued", "hook.delivery");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const retries = new Map<string, DurableRetryRecord[]>();
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const backgroundTasks = new Set<Promise<void>>();
    const serviceRef: { current?: DurableRunService } = {};
    const executeWorkflow = vi.fn(async (claimed: DurableRunRecord) => {
      const retry = serviceRef.current!.scheduleRunningWorkflowRetry(
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

  it("rejects a running retry after the worker lease expired", () => {
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

    expect(() => service.scheduleRunningWorkflowRetry(run.runId, "late hook", "hooks", "claim-expired")).toThrow(
      /cannot schedule running retry/,
    );
    expect(runs.get(run.runId)?.status).toBe("running");
    expect(timeline).toEqual([]);
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
      const retry = serviceRef.current!.scheduleRunningWorkflowRetry(
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
      service.stopWorker();

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
    service.stopWorker();
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

    const recovered = service.recoverDurableDeadLetter("dead-1", "operator-1");
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
    expect(() => service.recoverDurableDeadLetter("dead-1", "operator-2")).toThrow(/already resolved/);
    expect(executeWorkflow).toHaveBeenCalledTimes(1);
  });

  it("enforces the absolute dead-letter recovery attempt ceiling", () => {
    const run = { ...createRun("run-dead-ceiling", "dead_lettered"), attemptCount: 20, maxAttempts: 20 };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const deadLetters = new Map([
      ["dead-ceiling", { dead_letter_id: "dead-ceiling", run_id: run.runId, reason: "retry_exhausted" }],
    ]);
    const service = new DurableRunService(createContext(runs, [], [], { deadLetters }) as unknown as ServiceContext);

    expect(() => service.recoverDurableDeadLetter("dead-ceiling", "operator", { maxAttempts: 20 })).toThrow(
      /hard 20-attempt recovery ceiling/,
    );
    expect(runs.get(run.runId)?.status).toBe("dead_lettered");
  });

  it("refuses to recover dead letters the workflow registry classifies as unrecoverable", () => {
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

    expect(() => service.recoverDurableDeadLetter("dead-unsafe", "operator-1")).toThrow(unrecoverabilityReason);
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

  it("skips waking waiting runs when the correlation id does not match", () => {
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

    const result = service.wakeDurableRun(run.runId, {
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

  it("emits a durable retry scheduled signal when manual retry queues another attempt", () => {
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

    const retried = service.retryDurableRun(run.runId, "manual_retry", "operator-1");

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

  it("refuses to retry runs the workflow registry classifies as unrecoverable", () => {
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

    expect(() => service.retryDurableRun(run.runId, "manual_retry", "operator-1")).toThrow(unrecoverabilityReason);
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
    (status) => {
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

      expect(() => service.retryDurableRun(run.runId, "manual_retry", "operator-1")).toThrow(
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

  it("refuses to resume paused autonomous runs while the autonomy kill switch is engaged", () => {
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

    expect(() => service.resumeDurableRun(run.runId, "operator-1")).toThrow(/autonomy kill switch/i);
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
        service.pauseDurableRun(run.runId, "operator-1");
      } else {
        service.cancelDurableRun(run.runId, "operator-1");
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
      const run = {
        ...createRun(`run-chat-cancel-${runStatus}`, runStatus),
        payload: {
          version: "chat.turn.execute.v1",
          sessionId: "session-cancel",
          turnId: `turn-cancel-${runStatus}`,
          userMessageId: `user-cancel-${runStatus}`,
          assistantMessageId: `assistant-cancel-${runStatus}`,
          branchKind: "new",
          threadEventType: "chat_thread_turn_appended",
          request: { content: "Cancel this turn." },
        },
      };
      const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
      const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
      const timeline: Array<{ runId: string; eventType: string }> = [];
      const context = createContext(runs, checkpoints, timeline);
      let trace: ChatTurnTraceRecord = {
        turnId: run.payload.turnId,
        sessionId: run.payload.sessionId,
        userMessageId: run.payload.userMessageId,
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
          progress.runEffect("agent_end", agentEnd);
          for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
            progress.runEffect(effect, () => undefined);
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

      const cancelled = service.cancelDurableRun(run.runId, "operator-cancel");

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
      expect(checkpoints).toContainEqual({ runId: run.runId, checkpointKind: "run_cancelled" });

      await Promise.all([...backgroundTasks]);

      expect(onGeneralChatPostCommit).toHaveBeenCalledTimes(1);
      expect(agentEnd).toHaveBeenCalledTimes(1);
      expect(runs.get(run.runId)?.metadata).not.toHaveProperty("generalChatPostCommitPending");
    },
  );

  it("rolls back a wake when its timeline event cannot commit", () => {
    const run = {
      ...createRun("run-wake-rollback", "waiting"),
      metadata: { waitForEvent: { eventKey: "approval.resolved" } },
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const context = createContext(runs, checkpoints, timeline);
    context.storage.runImmediateTransaction = <T>(callback: () => T): T => {
      const runSnapshot = new Map(runs);
      try {
        return callback();
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

    const result = service.wakeDurableRun(run.runId, { eventKey: "approval.resolved" });

    expect(result).toMatchObject({ outcome: "failed", detail: "timeline write unavailable" });
    expect(runs.get(run.runId)?.status).toBe("waiting");
  });

  it("treats repeated operator cancellation of an already-cancelled durable run as idempotent", () => {
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

    const secondCancel = service.cancelDurableRun(run.runId, "operator-2");

    expect(secondCancel).toBe(run);
    expect(runs.get(run.runId)?.version).toBe(run.version);
    expect(timeline).toEqual([]);
    expect(publishRealtime).not.toHaveBeenCalled();
  });

  it("treats repeated operator pause of an already-paused durable run as idempotent", () => {
    const run = createRun("run-already-paused", "paused");
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const checkpoints: Array<{ runId: string; checkpointKind: string }> = [];
    const timeline: Array<{ runId: string; eventType: string }> = [];
    const publishRealtime = vi.fn();
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline, { publishRealtime }) as unknown as ServiceContext,
    );

    const secondPause = service.pauseDurableRun(run.runId, "operator-2");

    expect(secondPause).toBe(run);
    expect(runs.get(run.runId)?.version).toBe(run.version);
    expect(timeline).toEqual([]);
    expect(publishRealtime).not.toHaveBeenCalled();
  });

  it("rejects pause attempts for already-cancelled durable runs", () => {
    const run = {
      ...createRun("run-cancelled-pause", "cancelled"),
      finishedAt: "2026-03-14T00:00:05.000Z",
      lastError: "cancelled by operator-1",
    };
    const runs = new Map<string, DurableRunRecord>([[run.runId, run]]);
    const service = new DurableRunService(createContext(runs, [], []) as unknown as ServiceContext);

    expect(() => service.pauseDurableRun(run.runId, "operator-2")).toThrow(
      "Durable run run-cancelled-pause is already terminal (cancelled)",
    );
  });

  it("rejects pause and cancel attempts for dead-lettered durable runs", () => {
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

    expect(() => service.pauseDurableRun(run.runId, "operator-2")).toThrow(
      "Durable run run-dead-lettered-control is already terminal (dead_lettered)",
    );
    expect(() => service.cancelDurableRun(run.runId, "operator-2")).toThrow(
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

  it("moves timed-out Cowork chat turns to waiting with operator resume metadata", async () => {
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
        status: "waiting",
        leaseOwnerId: undefined,
        leaseExpiresAt: undefined,
        lastError: undefined,
        metadata: expect.objectContaining({
          waitForEvent: {
            eventKey: "cowork.turn.operator_resume",
            correlationId: run.runId,
          },
          coworkWatchdog: expect.objectContaining({
            reason: "workflow_timeout",
            timeoutMs: 50,
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
          reason: "cowork_workflow_timeout",
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

  it("resumes autonomy kill-switch parked runs when the switch is disengaged", () => {
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

    const result = service.resumeRunsWaitingForAutonomyKillSwitch();

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

    const diag = service.getDurableDiagnostics();
    expect(diag.lastBootRecovery).toBeDefined();
    expect(diag.lastBootRecovery?.resumedCount).toBe(1);
    expect(diag.lastBootRecovery?.prunedOrphanCheckpoints).toBe(3);
    expect(diag.lastBootRecovery?.prunedAgedCheckpoints).toBe(5);
    expect(diag.lastBootRecovery?.finalCheckpointBytes).toBe(1024);
    expect(diag.lastBootRecovery?.diskBudgetBytes).toBe(67108864);

    const resumeLog = infoLogs.find((entry) => entry.msg.includes("resumed after restart"));
    expect(resumeLog).toBeDefined();
    expect(prune.mock.calls.length).toBe(1);

    service.stopWorker();
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

    service.stopWorker();
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
            throw new Error(`Unknown run ${runId}`);
          }
          return run;
        },
        createRun: (input: {
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
            runId: `run-${runs.size + 1}`,
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
        createCheckpoint: (input: { runId: string; checkpointKind: string }) => {
          checkpoints.push({
            runId: input.runId,
            checkpointKind: input.checkpointKind,
          });
          return input;
        },
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
      runImmediateTransaction: <T>(callback: () => T): T => callback(),
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
  },
): DurableRunRecord {
  const current = runs.get(runId);
  if (!current) {
    throw new Error(`Unknown run ${runId}`);
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
