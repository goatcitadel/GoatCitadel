import { describe, expect, it, vi } from "vitest";
import type { DurableRunRecord } from "@goatcitadel/contracts";
import type { ServiceContext } from "./service-context.js";
import { DurableRunService } from "./durable-run-service.js";

describe("DurableRunService", () => {
  it("requeues and resumes recoverable orphaned chat turn runs on worker startup", async () => {
    const runs = new Map<string, DurableRunRecord>([
      ["run-1", createRun("run-1", "running")],
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
    const service = new DurableRunService(
      createContext(runs, checkpoints, timeline) as unknown as ServiceContext,
      {
        backgroundTasks,
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
      },
    );

    service.startWorker();
    await Promise.all([...backgroundTasks]);

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(executeWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      status: "running",
    }));
    expect(runs.get("run-1")?.status).toBe("completed");
    expect(checkpoints.map((item) => item.checkpointKind)).toContain("run_started");
    expect(timeline.map((item) => item.eventType)).toContain("run_started");
  });
});

function createContext(
  runs: Map<string, DurableRunRecord>,
  checkpoints: Array<{ runId: string; checkpointKind: string }>,
  timeline: Array<{ runId: string; eventType: string }>,
) {
  return {
    storage: {
      durableRuns: {
        statusCounts: () => ({}),
        countRuns: () => runs.size,
        listDeadLetters: () => [],
        listRuns: () => [...runs.values()],
        listCheckpoints: () => [],
        getRun: (runId: string) => {
          const run = runs.get(runId);
          if (!run) {
            throw new Error(`Unknown run ${runId}`);
          }
          return run;
        },
        updateRun: (input: {
          runId: string;
          status?: DurableRunRecord["status"];
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
    },
    config: {
      assistant: {
        durable: {
          enabled: true,
        },
      },
    },
    llmService: {},
    policyEngine: {},
    gatewaySql: {
      prepare: (sql: string) => ({
        all: () => {
          if (sql.includes("WHERE status = 'running'")) {
            return [...runs.values()]
              .filter((run) => run.status === "running")
              .map((run) => ({ run_id: run.runId }));
          }
          if (sql.includes("WHERE status = 'queued'")) {
            return [...runs.values()]
              .filter((run) => run.status === "queued")
              .map((run) => ({ run_id: run.runId }));
          }
          return [];
        },
        get: () => {
          if (sql.includes("WHERE status = 'queued'")) {
            const queued = [...runs.values()].find((run) => run.status === "queued");
            return queued ? { run_id: queued.runId } : undefined;
          }
          return undefined;
        },
        run: (params: { runId?: string; eventType?: string } | undefined) => {
          if (sql.includes("INSERT INTO durable_run_events") && params?.runId && params?.eventType) {
            timeline.push({
              runId: params.runId,
              eventType: params.eventType,
            });
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

function createRun(runId: string, status: DurableRunRecord["status"]): DurableRunRecord {
  return {
    runId,
    workflowKey: "chat.turn.execute",
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
    ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
    ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
    ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
    ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
  };
  runs.set(runId, next);
  return next;
}
