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
    const runs = new Map<string, DurableRunRecord>([["run-1", createRun("run-1", "running")]]);
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
      executeWorkflow,
      isWorkflowRecoverable: () => ({ recoverable: true }),
    });

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(executeWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        status: "running",
      }),
    );
    expect(runs.get("run-1")?.status).toBe("completed");
    expect(checkpoints.map((item) => item.checkpointKind)).toContain("run_started");
    expect(timeline.map((item) => item.eventType)).toContain("run_started");
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
        executeWorkflow,
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
        executeWorkflow,
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
        listCheckpoints: () => [],
        listRetries: (runId: string) => retries.get(runId) ?? [],
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
            payload: input.payload ?? {},
            metadata: input.metadata,
            startedAt: input.startedAt,
            finishedAt: input.finishedAt,
            lastError: input.lastError,
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
          updatedAt?: string;
          lastError?: string;
        }) => updateRun(runs, input.runId, input),
        createCheckpoint: (input: { runId: string; checkpointKind: string }) => {
          checkpoints.push({
            runId: input.runId,
            checkpointKind: input.checkpointKind,
          });
          return input;
        },
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
    gatewaySql: {
      prepare: (sql: string) => ({
        all: () => {
          if (sql.includes("WHERE status = 'running'")) {
            return [...runs.values()].filter((run) => run.status === "running").map((run) => ({ run_id: run.runId }));
          }
          if (sql.includes("WHERE status = 'queued'")) {
            return [...runs.values()].filter((run) => run.status === "queued").map((run) => ({ run_id: run.runId }));
          }
          return [];
        },
        get: (arg?: string) => {
          if (sql.includes("FROM durable_dead_letters") && sql.includes("WHERE dead_letter_id = ?")) {
            return arg ? deadLetters.get(arg) : undefined;
          }
          return undefined;
        },
        run: (
          params:
            | {
                runId?: string;
                eventType?: string;
                entryId?: string;
                resolvedAt?: string;
                note?: string;
              }
            | undefined,
        ) => {
          if (sql.includes("INSERT INTO durable_run_events") && params?.runId && params?.eventType) {
            timeline.push({
              runId: params.runId,
              eventType: params.eventType,
            });
          }
          if (sql.includes("UPDATE durable_dead_letters") && params?.entryId) {
            const current = deadLetters.get(params.entryId);
            if (current) {
              deadLetters.set(params.entryId, {
                ...current,
                resolved_at: params.resolvedAt,
                resolution_note: params.note,
              });
            }
          }
          return { changes: 1 };
        },
      }),
    },
    publishRealtime: () => undefined,
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
    payload: {},
    metadata: {},
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
    updatedAt?: string;
    lastError?: string;
  },
): DurableRunRecord {
  const current = runs.get(runId);
  if (!current) {
    throw new Error(`Unknown run ${runId}`);
  }
  const next = {
    ...current,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
    ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
    ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
    ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
    ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
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
