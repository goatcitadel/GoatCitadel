import { describe, expect, it, vi } from "vitest";
import type { DurableRetryRecord, DurableRunRecord } from "@goatcitadel/contracts";
import type { ServiceContext } from "./service-context.js";
import { DurableRunService } from "./durable-run-service.js";

describe("DurableRunService", () => {
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
      const service = new DurableRunService(createContext(runs, checkpoints, timeline) as unknown as ServiceContext, {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow,
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
      });

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

  it("fails the run when lease heartbeat renewal throws", async () => {
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
      const renewLease = vi.fn(() => {
        throw new Error("transient lease failure");
      });
      context.storage.durableRuns.renewLease = renewLease as never;
      const service = new DurableRunService(context as unknown as ServiceContext, {
        backgroundTasks,
        workflowRegistry: {
          executeWorkflow: vi.fn(() => workflow),
          isWorkflowRecoverable: () => ({ recoverable: true }),
          markWorkflowUnrecoverable: vi.fn(),
        },
      });

      service.startWorker();
      await vi.advanceTimersByTimeAsync(5_100);
      await Promise.allSettled([...backgroundTasks]);
      resolveWorkflow();

      expect(renewLease).toHaveBeenCalled();
      expect(runs.get(run.runId)?.status).toBe("failed");
      expect(timeline.map((item) => item.eventType)).toContain("run_failed");
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
        listDeadLetters: () => [],
        listRuns: () => [...runs.values()],
        listRunIdsByStatus: (status: DurableRunRecord["status"]) =>
          [...runs.values()].filter((run) => run.status === status).map((run) => run.runId),
        listCheckpoints: () => [],
        listRetries: (runId: string) => retries.get(runId) ?? [],
        upsertRetry: (input: DurableRetryRecord) => {
          const current = retries.get(input.runId) ?? [];
          retries.set(input.runId, [...current.filter((item) => item.attemptNo !== input.attemptNo), input]);
          return input;
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
    publishRealtime: options?.publishRealtime ?? (() => undefined),
    requireFeatureEnabled: () => undefined,
    isFeatureEnabled: () => true,
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
