import { describe, expect, it, vi } from "vitest";
import type {
  DurableCheckpointRecord,
  DurableDeadLetterRecord,
  DurableRetryRecord,
  DurableRunRecord,
  DurableRunTimelineEvent,
} from "@goatcitadel/contracts";
import type { ServiceContext } from "./service-context.js";
import { deriveDurableRunOperationalState, DurableRunService } from "./durable-run-service.js";

describe("DurableRunService loop23 lifecycle coverage", () => {
  it("derives operator-facing recovery state for dead letters, expired leases, stale heartbeats, and idle runs", () => {
    expect(
      deriveDurableRunOperationalState({
        ...createRun("run-dead", "dead_lettered"),
        lastError: "retry_exhausted:manual_retry",
      }),
    ).toMatchObject({
      workerHealth: "released",
      recoveryState: "retry_budget_exhausted",
      recoverySummary: "retry_exhausted:manual_retry",
    });

    expect(
      deriveDurableRunOperationalState(
        {
          ...createRun("run-expired", "running"),
          leaseOwnerId: "worker-old",
          leaseExpiresAt: "2026-05-14T00:00:00.000Z",
          leaseHeartbeatAt: "2026-05-14T00:00:00.000Z",
        },
        Date.parse("2026-05-14T00:00:01.000Z"),
      ),
    ).toMatchObject({
      workerHealth: "expired_lease",
      recoveryState: "reclaimable",
    });

    expect(
      deriveDurableRunOperationalState(
        {
          ...createRun("run-stale", "running"),
          leaseOwnerId: "worker-stale",
          leaseExpiresAt: "2026-05-14T00:01:00.000Z",
          leaseHeartbeatAt: "2026-05-14T00:00:00.000Z",
        },
        Date.parse("2026-05-14T00:00:11.000Z"),
      ),
    ).toMatchObject({
      workerHealth: "stale_heartbeat",
      recoveryState: "reclaiming",
      recoverySummary: "No heartbeat recorded since 2026-05-14T00:00:00.000Z.",
    });

    expect(deriveDurableRunOperationalState(createRun("run-queued", "queued"))).toMatchObject({
      workerHealth: "idle",
      recoveryState: "none",
    });
  });

  it("reports diagnostics and read APIs from durable storage without mutating runs", () => {
    const run = {
      ...createRun("run-diag", "running"),
      leaseOwnerId: "worker-old",
      leaseExpiresAt: "2020-01-01T00:00:00.000Z",
    };
    const checkpoints: DurableCheckpointRecord[] = [
      {
        checkpointId: "checkpoint-1",
        runId: run.runId,
        checkpointKind: "run_created",
        state: {},
        createdAt: "2026-05-14T00:00:00.000Z",
      },
    ];
    const timeline: DurableRunTimelineEvent[] = [
      {
        eventId: "event-1",
        runId: run.runId,
        eventType: "run_created",
        payload: {},
        createdAt: "2026-05-14T00:00:00.000Z",
      },
    ];
    const deadLetters: DurableDeadLetterRecord[] = [
      {
        deadLetterId: "dead-1",
        runId: "run-dead",
        reason: "retry_exhausted:test",
        payload: {},
        createdAt: "2026-05-14T00:00:00.000Z",
      },
    ];
    const requireFeatureEnabled = vi.fn();
    const context = createContext(new Map([[run.runId, run]]), {
      checkpoints,
      deadLetters,
      timeline,
      requireFeatureEnabled,
      statusCounts: { running: 1, queued: 2, failed: 3, waiting: 4 },
    });
    const service = new DurableRunService(context as unknown as ServiceContext);

    expect(service.getDurableDiagnostics()).toMatchObject({
      enabled: true,
      replayFoundationReady: false,
      runCount: 1,
      runningCount: 1,
      queuedCount: 2,
      waitingCount: 4,
      failedCount: 3,
      deadLetterCount: 1,
      recentRuns: [expect.objectContaining({ runId: "run-diag", workerHealth: "expired_lease" })],
      recentDeadLetters: deadLetters,
    });
    expect(service.listDurableRuns()).toEqual([expect.objectContaining({ runId: "run-diag" })]);
    expect(service.listDurableDeadLetters()).toEqual(deadLetters);
    expect(service.listDurableRunCheckpoints(run.runId)).toEqual(checkpoints);
    expect(service.listDurableRunTimeline(run.runId)).toEqual(timeline);
    expect(service.getDurableRun(run.runId)).toMatchObject({ runId: "run-diag", workerHealth: "expired_lease" });
    expect(requireFeatureEnabled).toHaveBeenCalledWith("durableKernelV1Enabled");
    expect(run.status).toBe("running");
  });

  it("persists pause, resume, and cancel transitions with retained timeline and realtime signals", () => {
    const run = {
      ...createRun("run-lifecycle", "queued"),
      leaseOwnerId: "worker-old",
      leaseExpiresAt: "2026-05-14T00:01:00.000Z",
      leaseHeartbeatAt: "2026-05-14T00:00:00.000Z",
    };
    const terminal = createRun("run-terminal", "completed");
    const timeline: DurableRunTimelineEvent[] = [];
    const checkpoints: DurableCheckpointRecord[] = [];
    const publishRealtime = vi.fn();
    const context = createContext(
      new Map([
        [run.runId, run],
        [terminal.runId, terminal],
      ]),
      {
        checkpoints,
        publishRealtime,
        timeline,
      },
    );
    const service = new DurableRunService(context as unknown as ServiceContext);

    expect(service.pauseDurableRun(run.runId, "operator-1")).toMatchObject({
      status: "paused",
      leaseOwnerId: undefined,
      leaseExpiresAt: undefined,
      leaseHeartbeatAt: undefined,
    });
    expect(service.resumeDurableRun(run.runId, "operator-1")).toMatchObject({ status: "queued" });
    expect(service.cancelDurableRun(run.runId, "operator-1")).toMatchObject({
      status: "cancelled",
      lastError: "cancelled by operator-1",
    });
    expect(() => service.pauseDurableRun(terminal.runId)).toThrow(/already terminal/);

    expect(timeline.map((event) => event.eventType)).toEqual(["run_paused", "run_resumed", "run_cancelled"]);
    expect(checkpoints.map((checkpoint) => checkpoint.checkpointKind)).toEqual(["run_resumed", "run_cancelled"]);
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({ type: "durable_run_cancelled", runId: "run-lifecycle" }),
      expect.objectContaining({ eventAuthority: "retained_stream" }),
    );
  });

  it("wakes waiting runs, preserves mismatches, and returns failed wake diagnostics on version conflicts", () => {
    const waiting = {
      ...createRun("run-wait", "waiting"),
      metadata: {
        waitForEvent: {
          eventKey: "approval.resolved",
          correlationId: "approval-1",
        },
      },
    };
    const conflict = {
      ...createRun("run-conflict", "waiting"),
      metadata: {
        waitForEvent: {
          eventKey: "approval.resolved",
        },
      },
    };
    const runs = new Map([
      [waiting.runId, waiting],
      [conflict.runId, conflict],
    ]);
    const timeline: DurableRunTimelineEvent[] = [];
    const publishRealtime = vi.fn();
    const context = createContext(runs, {
      publishRealtime,
      timeline,
      failUpdateRunIds: new Set(["run-conflict"]),
    });
    const service = new DurableRunService(context as unknown as ServiceContext);

    expect(
      service.wakeDurableRun(waiting.runId, {
        eventKey: "approval.rejected",
        correlationId: "approval-1",
      }),
    ).toMatchObject({
      outcome: "skipped_event_key_mismatch",
      detail: "Wake event key mismatch: expected approval.resolved",
    });
    expect(runs.get(waiting.runId)?.status).toBe("waiting");

    expect(
      service.wakeDurableRun(waiting.runId, {
        eventKey: "approval.resolved",
        correlationId: "approval-1",
        payload: { decision: "approve" },
      }),
    ).toMatchObject({
      outcome: "woke",
      run: expect.objectContaining({ status: "queued" }),
    });
    expect(timeline.map((event) => event.eventType)).toContain("run_woken");
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({ type: "durable_run_woken", runId: "run-wait" }),
      expect.any(Object),
    );

    expect(service.wakeDurableRun(conflict.runId, { eventKey: "approval.resolved" })).toMatchObject({
      outcome: "failed",
      run: expect.objectContaining({ status: "waiting" }),
      detail: "Durable run run-conflict update conflict",
    });
  });

  it("enforces waitForEvent registration: matching key/correlation wakes, stale wakes are rejected", () => {
    // A chat turn parked on approval, keyed to its own approval.
    const approvalWait = {
      ...createRun("run-approval-wait", "waiting"),
      metadata: {
        surface: "chat",
        waitForEvent: { eventKey: "approval.resolved", correlationId: "approval-A" },
      },
    };
    // A run parked WITHOUT any waitForEvent (legacy / other-path park).
    const noRegistration = {
      ...createRun("run-no-registration", "waiting"),
      metadata: { surface: "chat" },
    };
    const runs = new Map([
      [approvalWait.runId, approvalWait],
      [noRegistration.runId, noRegistration],
    ]);
    const context = createContext(runs);
    const service = new DurableRunService(context as unknown as ServiceContext);

    // Cross-type stale wake (wrong eventKey) -> rejected, run stays waiting.
    expect(
      service.wakeDurableRun(approvalWait.runId, { eventKey: "some.other.key", correlationId: "approval-A" }),
    ).toMatchObject({ outcome: "skipped_event_key_mismatch" });
    expect(runs.get(approvalWait.runId)?.status).toBe("waiting");

    // Right key but a DIFFERENT approval's correlationId -> rejected (the premature-resume bug).
    expect(
      service.wakeDurableRun(approvalWait.runId, { eventKey: "approval.resolved", correlationId: "approval-B" }),
    ).toMatchObject({ outcome: "skipped_correlation_mismatch" });
    expect(runs.get(approvalWait.runId)?.status).toBe("waiting");

    // The legit wake (matching key + correlationId) resumes the run.
    expect(
      service.wakeDurableRun(approvalWait.runId, { eventKey: "approval.resolved", correlationId: "approval-A" }),
    ).toMatchObject({ outcome: "woke", run: expect.objectContaining({ status: "queued" }) });
    expect(runs.get(approvalWait.runId)?.status).toBe("queued");

    // Core bug: a run with NO waitForEvent must REJECT a caller-supplied eventKey
    // rather than silently accept any wake.
    expect(
      service.wakeDurableRun(noRegistration.runId, { eventKey: "approval.resolved", correlationId: "whatever" }),
    ).toMatchObject({ outcome: "skipped_event_key_mismatch" });
    expect(runs.get(noRegistration.runId)?.status).toBe("waiting");

    // Back-compat: the same no-registration run is still wakeable by a caller
    // that supplies NO eventKey (the only legitimate keyless path).
    expect(service.wakeDurableRun(noRegistration.runId, { eventKey: "" })).toMatchObject({
      outcome: "woke",
      run: expect.objectContaining({ status: "queued" }),
    });
    expect(runs.get(noRegistration.runId)?.status).toBe("queued");
  });

  it("dead-letters exhausted retries and recovers them with a bounded max-attempt override", async () => {
    const exhausted = {
      ...createRun("run-exhausted", "failed"),
      attemptCount: 1,
      maxAttempts: 1,
      lastError: "provider timeout",
    };
    const deadLetters = new Map<string, DurableDeadLetterRecord>();
    const timeline: DurableRunTimelineEvent[] = [];
    const publishRealtime = vi.fn();
    const backgroundTasks = new Set<Promise<void>>();
    const executeWorkflow = vi.fn(async (run: DurableRunRecord) => {
      updateRun(runs, run.runId, { status: "completed", finishedAt: "2026-05-14T00:00:05.000Z", clearLease: true });
    });
    const runs = new Map([[exhausted.runId, exhausted]]);
    const context = createContext(runs, { deadLetters, publishRealtime, timeline });
    const service = new DurableRunService(context as unknown as ServiceContext, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });

    expect(service.retryDurableRun(exhausted.runId, "manual_retry", "operator-1")).toMatchObject({
      status: "dead_lettered",
      lastError: "retry_exhausted:manual_retry",
    });
    const [deadLetter] = [...deadLetters.values()];
    expect(deadLetter).toMatchObject({ runId: exhausted.runId, reason: "retry_exhausted:manual_retry" });

    const recovered = service.recoverDurableDeadLetter(deadLetter!.deadLetterId, "operator-2", { maxAttempts: 99 });
    await Promise.all([...backgroundTasks]);

    expect(recovered.maxAttempts).toBe(20);
    expect(deadLetters.get(deadLetter!.deadLetterId)).toMatchObject({
      resolvedAt: expect.any(String),
      resolutionNote: "recovered by operator-2, maxAttempts raised to 20",
    });
    expect(executeWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ runId: exhausted.runId, status: "running" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(runs.get(exhausted.runId)?.status).toBe("completed");
    expect(timeline.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "run_dead_lettered",
        "run_retry_budget_exhausted",
        "dead_letter_recovered",
        "run_started",
      ]),
    );
  });
});

function createContext(
  runs: Map<string, DurableRunRecord>,
  options: {
    checkpoints?: DurableCheckpointRecord[];
    deadLetters?: Map<string, DurableDeadLetterRecord> | DurableDeadLetterRecord[];
    failUpdateRunIds?: Set<string>;
    publishRealtime?: (
      eventType: string,
      source: string,
      payload: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => void;
    requireFeatureEnabled?: (flag: string) => void;
    statusCounts?: Record<string, number>;
    timeline?: DurableRunTimelineEvent[];
  } = {},
) {
  const checkpoints = options.checkpoints ?? [];
  const timeline = options.timeline ?? [];
  const retryRecords = new Map<string, DurableRetryRecord[]>();
  const deadLetters =
    options.deadLetters instanceof Map
      ? options.deadLetters
      : new Map((options.deadLetters ?? []).map((entry) => [entry.deadLetterId, entry]));

  return {
    storage: {
      durableRuns: {
        statusCounts: () => options.statusCounts ?? countStatuses(runs),
        countRuns: () => runs.size,
        listDeadLetters: () => [...deadLetters.values()],
        listRuns: (limit = 50) => [...runs.values()].slice(0, limit),
        listRunIdsByStatus: (status: DurableRunRecord["status"]) =>
          [...runs.values()].filter((run) => run.status === status).map((run) => run.runId),
        listPendingLinkedFinalizationRunIds: () => [],
        listPendingAutonomousChatPostCommitRunIds: () => [],
        listCheckpoints: (runId: string, limit = 200) =>
          checkpoints.filter((checkpoint) => checkpoint.runId === runId).slice(0, limit),
        listRetries: (runId: string) => retryRecords.get(runId) ?? [],
        upsertRetry: (input: DurableRetryRecord) => {
          const current = retryRecords.get(input.runId) ?? [];
          retryRecords.set(input.runId, [...current.filter((item) => item.attemptNo !== input.attemptNo), input]);
          return input;
        },
        getRun: (runId: string) => {
          const run = runs.get(runId);
          if (!run) {
            throw new Error(`Unknown run ${runId}`);
          }
          return run;
        },
        getRunForUpdate: (runId: string) => {
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
          now?: string;
        }) => {
          const run = createRun(`run-${runs.size + 1}`, input.status ?? "queued", input.workflowKey);
          const next = {
            ...run,
            attemptCount: input.attemptCount ?? run.attemptCount,
            maxAttempts: input.maxAttempts ?? run.maxAttempts,
            payload: input.payload ?? {},
            metadata: input.metadata ?? {},
            startedAt: input.startedAt,
            createdAt: input.now ?? run.createdAt,
            updatedAt: input.now ?? run.updatedAt,
          };
          runs.set(next.runId, next);
          return next;
        },
        updateRun: (input: RunPatch) => {
          if (options.failUpdateRunIds?.has(input.runId)) {
            throw new Error(`Durable run ${input.runId} update conflict`);
          }
          return updateRun(runs, input.runId, input);
        },
        tryClaimQueuedRun: (input: {
          runId: string;
          workerId: string;
          leaseHeartbeatAt: string;
          leaseExpiresAt: string;
        }) => {
          const current = runs.get(input.runId);
          if (!current || current.status !== "queued") {
            return undefined;
          }
          return updateRun(runs, input.runId, {
            status: "running",
            startedAt: current.startedAt ?? input.leaseHeartbeatAt,
            clearFinishedAt: true,
            clearLastError: true,
            leaseOwnerId: input.workerId,
            leaseHeartbeatAt: input.leaseHeartbeatAt,
            leaseExpiresAt: input.leaseExpiresAt,
            updatedAt: input.leaseHeartbeatAt,
          });
        },
        renewLease: (input: { runId: string; workerId: string; leaseHeartbeatAt: string; leaseExpiresAt: string }) => {
          const current = runs.get(input.runId);
          if (!current || current.leaseOwnerId !== input.workerId) {
            return undefined;
          }
          return updateRun(runs, input.runId, {
            leaseOwnerId: input.workerId,
            leaseHeartbeatAt: input.leaseHeartbeatAt,
            leaseExpiresAt: input.leaseExpiresAt,
            updatedAt: input.leaseHeartbeatAt,
          });
        },
        listExpiredRunningRunIds: (nowIso: string) =>
          [...runs.values()]
            .filter((run) => run.status === "running" && run.leaseExpiresAt && run.leaseExpiresAt <= nowIso)
            .map((run) => run.runId),
        createCheckpoint: (input: Partial<DurableCheckpointRecord> & { runId: string; checkpointKind: string }) => {
          const checkpoint = {
            checkpointId: input.checkpointId ?? `checkpoint-${checkpoints.length + 1}`,
            runId: input.runId,
            checkpointKind: input.checkpointKind,
            state: input.state ?? {},
            createdAt: input.createdAt ?? new Date().toISOString(),
          } as DurableCheckpointRecord;
          checkpoints.push(checkpoint);
          return checkpoint;
        },
        upsertDeadLetter: (input: { runId: string; reason: string; payload?: Record<string, unknown> }) => {
          const entry: DurableDeadLetterRecord = {
            deadLetterId: `dead-${deadLetters.size + 1}`,
            runId: input.runId,
            reason: input.reason,
            payload: input.payload ?? {},
            createdAt: new Date().toISOString(),
          };
          deadLetters.set(entry.deadLetterId, entry);
          return entry;
        },
        getDeadLetterById: (deadLetterId: string) => {
          const entry = deadLetters.get(deadLetterId);
          if (!entry) {
            throw new Error(`Unknown dead letter ${deadLetterId}`);
          }
          return entry;
        },
        resolveDeadLetter: (
          deadLetterId: string,
          input: {
            resolvedAt?: string;
            resolutionNote?: string;
          },
        ) => {
          const entry = deadLetters.get(deadLetterId);
          if (!entry) {
            throw new Error(`Unknown dead letter ${deadLetterId}`);
          }
          const next = {
            ...entry,
            resolvedAt: input.resolvedAt,
            resolutionNote: input.resolutionNote,
          };
          deadLetters.set(deadLetterId, next);
          return next;
        },
      },
      durableRunEvents: {
        append: (input: Partial<DurableRunTimelineEvent> & { runId: string; eventType: string }) => {
          const event = {
            eventId: input.eventId ?? `event-${timeline.length + 1}`,
            runId: input.runId,
            eventType: input.eventType,
            payload: input.payload ?? {},
            stepKey: input.stepKey,
            createdAt: input.createdAt ?? new Date().toISOString(),
          } as DurableRunTimelineEvent;
          timeline.push(event);
          return event;
        },
        listByRun: (runId: string, limit = 300) => timeline.filter((event) => event.runId === runId).slice(0, limit),
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
    publishRealtime: options.publishRealtime ?? (() => undefined),
    requireFeatureEnabled: options.requireFeatureEnabled ?? (() => undefined),
    isFeatureEnabled: () => true,
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId ?? "default",
  };
}

interface RunPatch {
  runId: string;
  status?: DurableRunRecord["status"];
  attemptCount?: number;
  maxAttempts?: number;
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
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    startedAt: "2026-05-14T00:00:00.000Z",
  };
}

function updateRun(runs: Map<string, DurableRunRecord>, runId: string, patch: RunPatch): DurableRunRecord {
  const current = runs.get(runId);
  if (!current) {
    throw new Error(`Unknown run ${runId}`);
  }
  const next = {
    ...current,
    version: (current.version ?? 1) + 1,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.attemptCount !== undefined ? { attemptCount: patch.attemptCount } : {}),
    ...(patch.maxAttempts !== undefined ? { maxAttempts: patch.maxAttempts } : {}),
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

function countStatuses(runs: Map<string, DurableRunRecord>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const run of runs.values()) {
    counts[run.status] = (counts[run.status] ?? 0) + 1;
  }
  return counts;
}
