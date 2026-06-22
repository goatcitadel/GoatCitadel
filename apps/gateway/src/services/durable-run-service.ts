/* eslint-disable max-lines -- Durable run lifecycle service intentionally centralizes lease, recovery, timeline, and diagnostics behavior. */
import { randomUUID } from "node:crypto";
import type {
  DurableCheckpointRecord,
  ContinuationGateDecision,
  DurableDeadLetterRecord,
  DurableDiagnosticsResponse,
  RealtimeEvent,
  DurableRetryPolicy,
  DurableRunCreateRequest,
  DurableRunRecord,
  DurableRunTimelineEvent,
  DurableWakeResult,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import type { DurableWorkflowExecutorRegistry } from "./durable-execution-service.js";
import type { EvidenceEnvelopeCreateRequest } from "./evidence-envelope-service.js";

export interface DurableRunServiceContext {
  readonly config: GatewayRuntimeConfig;
  readonly storage: Storage;
  readonly logger?: DurableRunServiceLogger;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
  requireFeatureEnabled(flag: keyof RuntimeSettings["features"]): void;
}

export interface DurableRunServiceLogger {
  info(data: unknown, msg: string): void;
  debug(data: unknown, msg: string): void;
  warn(data: unknown, msg: string): void;
  error(data: unknown, msg: string): void;
}

const DURABLE_RETRY_POLICY_DEFAULT: DurableRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 5_000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
};
// The lease must survive sustained event-loop starvation: a single native
// browser navigation or repo-wide search can stall the loop for 60-90s on a
// loaded workstation, and a 15s TTL caused the reaper to fail healthy runs at
// checkpoint run_started while their turns completed normally.
const DURABLE_LEASE_TTL_MS = 120_000;
const DURABLE_WORKER_POLL_MIN_MS = 750;
const DURABLE_WORKER_POLL_JITTER_MS = 500;
const DURABLE_LEASE_HEARTBEAT_MS = 5_000;
// Transient lease-renewal errors (storage contention, CAS retry exhaustion)
// should not abort an in-flight run; only repeated consecutive failures may.
const DURABLE_LEASE_HEARTBEAT_MAX_CONSECUTIVE_FAILURES = 3;
const DURABLE_EVENT_LOOP_LAG_WARN_MS = 1_000;
const DURABLE_EVENT_LOOP_LAG_PAUSE_MS = 2_000;
const DURABLE_CHECKPOINT_KEEP_PER_RUN_DEFAULT = 50;
const DURABLE_CHECKPOINT_DISK_BUDGET_BYTES_DEFAULT = 64 * 1024 * 1024;
const COWORK_WORKFLOW_TIMEOUT_RESUME_EVENT = "cowork.turn.operator_resume";

class DurableWorkflowTimeoutError extends Error {
  public constructor(
    public readonly runId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Durable workflow ${runId} exceeded ${timeoutMs}ms execution timeout.`);
    this.name = "DurableWorkflowTimeoutError";
  }
}

function buildDurableRealtimeOptions(runId: string): Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links"> {
  return {
    eventClass: "domain_fact",
    eventAuthority: "retained_stream",
    links: { runId },
  };
}

export function deriveDurableRunOperationalState(run: DurableRunRecord, nowMs = Date.now()): DurableRunRecord {
  const leaseExpiresAtMs = run.leaseExpiresAt ? Date.parse(run.leaseExpiresAt) : Number.NaN;
  const heartbeatAtMs = run.leaseHeartbeatAt ? Date.parse(run.leaseHeartbeatAt) : Number.NaN;
  const leaseExpired = Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs <= nowMs;
  const heartbeatStale =
    run.status === "running" &&
    Number.isFinite(heartbeatAtMs) &&
    nowMs - heartbeatAtMs > DURABLE_LEASE_HEARTBEAT_MS * 2;
  if (run.status === "dead_lettered") {
    return {
      ...run,
      workerHealth: "released",
      recoveryState: run.lastError?.startsWith("retry_exhausted:") ? "retry_budget_exhausted" : "dead_lettered",
      recoverySummary: run.lastError ?? "Run is in the durable dead-letter queue.",
    };
  }
  if (run.lastError?.startsWith("retry_exhausted:")) {
    return {
      ...run,
      workerHealth: "released",
      recoveryState: "retry_budget_exhausted",
      recoverySummary: run.lastError,
    };
  }
  if (/exited without marking/i.test(run.lastError ?? "")) {
    return {
      ...run,
      workerHealth: "released",
      recoveryState: "incomplete_worker_exit",
      recoverySummary: run.lastError,
    };
  }
  if (run.status === "running" && leaseExpired) {
    return {
      ...run,
      workerHealth: "expired_lease",
      recoveryState: "reclaimable",
      recoverySummary: `Lease expired at ${run.leaseExpiresAt}; the run can be reclaimed by a worker.`,
    };
  }
  if (heartbeatStale) {
    return {
      ...run,
      workerHealth: "stale_heartbeat",
      recoveryState: "reclaiming",
      recoverySummary: `No heartbeat recorded since ${run.leaseHeartbeatAt}.`,
    };
  }
  if (run.status === "running") {
    return {
      ...run,
      workerHealth: "active",
      recoveryState: "none",
      recoverySummary: run.leaseOwnerId ? `Lease held by worker ${run.leaseOwnerId}.` : undefined,
    };
  }
  return {
    ...run,
    workerHealth: run.status === "queued" || run.status === "waiting" ? "idle" : "released",
    recoveryState: "none",
    recoverySummary: undefined,
  };
}

/**
 * Encapsulates all durable-run lifecycle operations previously inlined
 * in GatewayService.
 */
export class DurableRunService {
  private workerActive = false;
  private workerRequested = false;
  private workerStopped = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly workerId = randomUUID();
  private readonly activeRunAbortControllers = new Map<string, AbortController>();
  private lastEventLoopLagMs = 0;
  private lastEventLoopLagAt: string | undefined;
  private leaseAcquisitionPausedUntilMs = 0;
  private lastBootRecovery: DurableDiagnosticsResponse["lastBootRecovery"];

  constructor(
    private readonly ctx: DurableRunServiceContext,
    private readonly deps?: {
      backgroundTasks: Set<Promise<void>>;
      workflowRegistry: Pick<
        DurableWorkflowExecutorRegistry,
        "executeWorkflow" | "isWorkflowRecoverable" | "markWorkflowUnrecoverable"
      >;
      onRunFailed?: (run: DurableRunRecord, message: string) => Promise<void> | void;
      evaluateContinuationGate?: (run: DurableRunRecord) => ContinuationGateDecision | undefined;
      recordEvidenceEnvelope?: (input: EvidenceEnvelopeCreateRequest) => void;
      taskLifecycle?: {
        autoBlockOnIncompleteExit(taskId: string, runId: string): unknown;
      };
    },
  ) {}

  // ── queries ──────────────────────────────────────────────────────

  getDurableDiagnostics(): DurableDiagnosticsResponse {
    const statusCounts = this.ctx.storage.durableRuns.statusCounts();
    const durableFoundationReady = this.isDurableFoundationEnabled() && Boolean(this.deps?.workflowRegistry);
    return {
      enabled: this.isDurableFoundationEnabled(),
      replayFoundationReady: durableFoundationReady,
      runCount: this.ctx.storage.durableRuns.countRuns(),
      queuedCount: statusCounts.queued ?? 0,
      runningCount: statusCounts.running ?? 0,
      waitingCount: statusCounts.waiting ?? 0,
      failedCount: statusCounts.failed ?? 0,
      deadLetterCount: this.ctx.storage.durableRuns.listDeadLetters(1000).length,
      recentRuns: this.ctx.storage.durableRuns.listRuns(25).map((run) => deriveDurableRunOperationalState(run)),
      recentDeadLetters: this.ctx.storage.durableRuns.listDeadLetters(25),
      ...(this.lastEventLoopLagAt
        ? {
            eventLoopLag: {
              lastMs: this.lastEventLoopLagMs,
              lastObservedAt: this.lastEventLoopLagAt,
              ...(this.leaseAcquisitionPausedUntilMs > Date.now()
                ? { leaseAcquisitionPausedUntil: new Date(this.leaseAcquisitionPausedUntilMs).toISOString() }
                : {}),
            },
          }
        : {}),
      ...(this.lastBootRecovery ? { lastBootRecovery: this.lastBootRecovery } : {}),
      generatedAt: new Date().toISOString(),
    };
  }

  listDurableRuns(limit = 50): DurableRunRecord[] {
    return this.ctx.storage.durableRuns.listRuns(limit).map((run) => deriveDurableRunOperationalState(run));
  }

  listDurableDeadLetters(limit = 50): DurableDeadLetterRecord[] {
    return this.ctx.storage.durableRuns.listDeadLetters(limit);
  }

  listDurableRunCheckpoints(runId: string, limit = 200): DurableCheckpointRecord[] {
    return this.ctx.storage.durableRuns.listCheckpoints(runId, limit);
  }

  getDurableRun(runId: string): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    return deriveDurableRunOperationalState(this.ctx.storage.durableRuns.getRun(runId));
  }

  listDurableRunTimeline(runId: string, limit = 300): DurableRunTimelineEvent[] {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    return this.ctx.storage.durableRunEvents.listByRun(runId, limit);
  }

  startWorker(): void {
    if (!this.isDurableFoundationEnabled() || !this.deps) {
      return;
    }
    this.workerStopped = false;
    const backgroundTasks = this.deps.backgroundTasks;
    const bootTask = this.performBootRecovery().catch((error) => {
      this.reportWorkerBackgroundFailure("boot_recovery", error);
    });
    backgroundTasks.add(bootTask);
    void bootTask.finally(() => {
      backgroundTasks.delete(bootTask);
    });
    this.ensurePollLoop();
    this.requestRunProcessing();
  }

  private async performBootRecovery(): Promise<void> {
    if (!this.deps) {
      return;
    }
    const log = this.resolveLogger();
    const resumedCount = await this.reconcileRecoverableRuns();
    const pruneConfig = resolveCheckpointPruneConfig();
    const durableRunsRepo = this.ctx.storage.durableRuns as unknown as {
      pruneCheckpoints?: (input: { keepPerRun: number; diskBudgetBytes: number }) => {
        prunedOrphans: number;
        prunedAged: number;
        finalBytes: number;
        diskBudgetBytes: number;
      };
    };
    const pruneSummary = durableRunsRepo.pruneCheckpoints?.(pruneConfig) ?? {
      prunedOrphans: 0,
      prunedAged: 0,
      finalBytes: 0,
      diskBudgetBytes: pruneConfig.diskBudgetBytes,
    };
    this.lastBootRecovery = {
      observedAt: new Date().toISOString(),
      resumedCount,
      prunedOrphanCheckpoints: pruneSummary.prunedOrphans,
      prunedAgedCheckpoints: pruneSummary.prunedAged,
      finalCheckpointBytes: pruneSummary.finalBytes,
      diskBudgetBytes: pruneSummary.diskBudgetBytes,
    };
    if (resumedCount > 0) {
      log.info(
        {
          resumedCount,
          prunedOrphanCheckpoints: pruneSummary.prunedOrphans,
          prunedAgedCheckpoints: pruneSummary.prunedAged,
          finalCheckpointBytes: pruneSummary.finalBytes,
          diskBudgetBytes: pruneSummary.diskBudgetBytes,
        },
        "durable runs resumed after restart",
      );
    } else {
      log.debug(
        {
          prunedOrphanCheckpoints: pruneSummary.prunedOrphans,
          prunedAgedCheckpoints: pruneSummary.prunedAged,
          finalCheckpointBytes: pruneSummary.finalBytes,
          diskBudgetBytes: pruneSummary.diskBudgetBytes,
        },
        "no durable runs required resume after restart",
      );
    }
  }

  private resolveLogger(): DurableRunServiceLogger {
    if (this.ctx.logger) {
      return this.ctx.logger;
    }
    return {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  private reportWorkerBackgroundFailure(stage: "boot_recovery" | "run_processing", error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.resolveLogger().error(
      {
        stage,
        error: message,
      },
      "durable worker background task failed",
    );
    this.ctx.publishRealtime(
      "system",
      "durable",
      {
        type: "durable_worker_background_failure",
        stage,
        error: message,
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
      },
    );
  }

  stopWorker(): void {
    this.workerStopped = true;
    this.workerRequested = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const [runId, controller] of this.activeRunAbortControllers) {
      controller.abort(new Error(`Durable worker ${this.workerId} stopped while ${runId} was running.`));
    }
    this.activeRunAbortControllers.clear();
  }

  requestRunProcessing(_runId?: string): void {
    if (!this.isDurableFoundationEnabled() || !this.deps || this.workerStopped) {
      return;
    }
    this.workerRequested = true;
    if (this.workerActive) {
      return;
    }
    const backgroundTasks = this.deps.backgroundTasks;
    const task = Promise.resolve()
      .then(async () => {
        this.workerActive = true;
        try {
          do {
            this.workerRequested = false;
            await this.reconcileRecoverableRuns();
            await this.drainQueuedRuns();
          } while (this.workerRequested && !this.workerStopped);
        } finally {
          this.workerActive = false;
        }
      })
      .catch((error) => {
        this.reportWorkerBackgroundFailure("run_processing", error);
      })
      .finally(() => {
        backgroundTasks.delete(task);
      });
    backgroundTasks.add(task);
  }

  // ── mutations ────────────────────────────────────────────────────

  createDurableRun(input: DurableRunCreateRequest): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    const workflowKey = input.workflowKey.trim();
    if (!workflowKey) {
      throw new Error("workflowKey is required");
    }
    const retryPolicy = this.normalizeDurableRetryPolicy(input.retryPolicy);
    const now = new Date().toISOString();
    const status: DurableRunRecord["status"] = input.waitForEvent ? "waiting" : "queued";
    const metadata = {
      ...(input.metadata ?? {}),
      retryPolicy,
      waitForEvent: input.waitForEvent ?? null,
    };
    const run = this.ctx.storage.durableRuns.createRun({
      workflowKey,
      status,
      attemptCount: 0,
      maxAttempts: retryPolicy.maxAttempts,
      payload: input.payload ?? {},
      metadata,
      startedAt: status === "queued" ? undefined : now,
      now,
    });
    this.ctx.storage.durableRuns.createCheckpoint({
      runId: run.runId,
      checkpointKind: "run_created",
      state: {
        workflowKey: run.workflowKey,
        status: run.status,
      },
      createdAt: now,
    });
    this.recordDurableTimelineEvent(run.runId, "run_created", {
      workflowKey: run.workflowKey,
      status: run.status,
    });
    if (status === "waiting") {
      this.ctx.storage.durableRuns.createCheckpoint({
        runId: run.runId,
        checkpointKind: "run_waiting",
        state: {
          waitForEvent: input.waitForEvent ?? null,
        },
      });
      this.recordDurableTimelineEvent(run.runId, "run_waiting", {
        waitForEvent: input.waitForEvent ?? null,
      });
    }
    this.ctx.publishRealtime(
      "system",
      "durable",
      {
        type: "durable_run_created",
        runId: run.runId,
        workflowKey: run.workflowKey,
        status: run.status,
      },
      buildDurableRealtimeOptions(run.runId),
    );
    return run;
  }

  pauseDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    const current = this.ctx.storage.durableRuns.getRun(runId);
    if (current.status === "paused") {
      return current;
    }
    if (
      current.status === "completed" ||
      current.status === "failed" ||
      current.status === "cancelled" ||
      current.status === "dead_lettered"
    ) {
      throw new Error(`Durable run ${runId} is already terminal (${current.status})`);
    }
    let next!: DurableRunRecord;
    this.ctx.storage.runImmediateTransaction(() => {
      next = this.ctx.storage.durableRuns.updateRun({
        runId,
        status: "paused",
        startedAt: current.startedAt ?? new Date().toISOString(),
        clearFinishedAt: true,
        clearLastError: true,
        clearLease: true,
        updatedAt: new Date().toISOString(),
        expectedVersion: current.version,
      });
      this.recordDurableTimelineEvent(runId, "run_paused", {
        actorId,
        previousStatus: current.status,
      });
    });
    this.ctx.publishRealtime(
      "system",
      "durable",
      {
        type: "durable_run_paused",
        runId,
        actorId,
      },
      buildDurableRealtimeOptions(runId),
    );
    this.abortActiveRun(runId, `Durable run ${runId} paused by ${actorId}.`);
    return next;
  }

  resumeDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    const current = this.ctx.storage.durableRuns.getRun(runId);
    if (current.status !== "paused") {
      throw new Error(`Durable run ${runId} cannot be resumed from ${current.status}`);
    }
    let next!: DurableRunRecord;
    this.ctx.storage.runImmediateTransaction(() => {
      next = this.ctx.storage.durableRuns.updateRun({
        runId,
        status: "queued",
        startedAt: current.startedAt ?? new Date().toISOString(),
        clearFinishedAt: true,
        clearLease: true,
        updatedAt: new Date().toISOString(),
        clearLastError: true,
        expectedVersion: current.version,
      });
      this.ctx.storage.durableRuns.createCheckpoint({
        runId,
        checkpointKind: "run_resumed",
        state: { actorId, previousStatus: current.status },
      });
      this.recordDurableTimelineEvent(runId, "run_resumed", {
        actorId,
        previousStatus: current.status,
      });
    });
    this.ctx.publishRealtime(
      "system",
      "durable",
      {
        type: "durable_run_resumed",
        runId,
        actorId,
      },
      buildDurableRealtimeOptions(runId),
    );
    return next;
  }

  cancelDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    const current = this.ctx.storage.durableRuns.getRun(runId);
    if (current.status === "cancelled") {
      return current;
    }
    if (current.status === "completed" || current.status === "failed" || current.status === "dead_lettered") {
      throw new Error(`Durable run ${runId} is already terminal (${current.status})`);
    }
    const now = new Date().toISOString();
    let next!: DurableRunRecord;
    this.ctx.storage.runImmediateTransaction(() => {
      next = this.ctx.storage.durableRuns.updateRun({
        runId,
        status: "cancelled",
        finishedAt: now,
        clearLease: true,
        updatedAt: now,
        lastError: `cancelled by ${actorId}`,
        expectedVersion: current.version,
      });
      this.recordDurableTimelineEvent(runId, "run_cancelled", {
        actorId,
        previousStatus: current.status,
      });
    });
    this.ctx.publishRealtime(
      "system",
      "durable",
      {
        type: "durable_run_cancelled",
        runId,
        actorId,
      },
      buildDurableRealtimeOptions(runId),
    );
    this.abortActiveRun(runId, `Durable run ${runId} cancelled by ${actorId}.`);
    return next;
  }

  retryDurableRun(runId: string, reason = "manual_retry", actorId = "operator"): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    const current = this.ctx.storage.durableRuns.getRun(runId);
    if (current.status !== "failed") {
      throw new Error(`Durable run ${runId} cannot be retried from ${current.status}`);
    }
    const recoverability = this.deps?.workflowRegistry.isWorkflowRecoverable(current);
    if (recoverability && !recoverability.recoverable) {
      throw new Error(recoverability.reason ?? `Durable run ${runId} cannot be safely retried.`);
    }
    return this.scheduleDurableRunRetry(current, reason, actorId);
  }

  scheduleRunningWorkflowRetry(runId: string, reason = "workflow_retry", actorId = "worker"): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    const current = this.ctx.storage.durableRuns.getRun(runId);
    if (current.status !== "running" || current.leaseOwnerId !== this.workerId) {
      throw new Error(`Durable run ${runId} cannot schedule running retry from ${current.status}`);
    }
    const recoverability = this.deps?.workflowRegistry.isWorkflowRecoverable(current);
    if (recoverability && !recoverability.recoverable) {
      throw new Error(recoverability.reason ?? `Durable run ${runId} cannot be safely retried.`);
    }
    return this.scheduleDurableRunRetry(current, reason, actorId);
  }

  private scheduleDurableRunRetry(current: DurableRunRecord, reason: string, actorId: string): DurableRunRecord {
    const runId = current.runId;
    const attemptNo = current.attemptCount + 1;
    if (attemptNo > current.maxAttempts) {
      const now = new Date().toISOString();
      let deadLetterReason = `retry_exhausted:${reason}`;
      let deadLettered!: DurableRunRecord;
      this.ctx.storage.runImmediateTransaction(() => {
        const deadLetter = this.ctx.storage.durableRuns.upsertDeadLetter({
          runId,
          reason: deadLetterReason,
          payload: {
            actorId,
            attemptNo,
            maxAttempts: current.maxAttempts,
          },
        });
        deadLetterReason = deadLetter.reason;
        deadLettered = this.ctx.storage.durableRuns.updateRun({
          runId,
          status: "dead_lettered",
          attemptCount: attemptNo,
          updatedAt: now,
          finishedAt: now,
          clearLease: true,
          lastError: deadLetter.reason,
          expectedVersion: current.version,
        });
        this.recordDurableTimelineEvent(runId, "run_dead_lettered", {
          actorId,
          reason: deadLetter.reason,
        });
        this.recordDurableTimelineEvent(runId, "run_retry_budget_exhausted", {
          actorId,
          reason: deadLetter.reason,
          attemptNo,
          maxAttempts: current.maxAttempts,
        });
      });
      this.ctx.publishRealtime(
        "system",
        "durable",
        {
          type: "durable_run_dead_lettered",
          runId,
          reason: deadLetterReason,
        },
        buildDurableRealtimeOptions(runId),
      );
      return deadLettered;
    }
    const delayMs = this.computeDurableRetryDelayMs(current, attemptNo);
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    let next!: DurableRunRecord;
    this.ctx.storage.runImmediateTransaction(() => {
      this.ctx.storage.durableRuns.upsertRetry({
        runId,
        attemptNo,
        reason,
        nextRetryAt,
      });
      this.recordDurableTimelineEvent(runId, "run_retry_scheduled", {
        actorId,
        reason,
        nextRetryAt,
        attemptNo,
      });
      next = this.ctx.storage.durableRuns.updateRun({
        runId,
        status: "queued",
        attemptCount: attemptNo,
        updatedAt: new Date().toISOString(),
        clearFinishedAt: true,
        clearLease: true,
        clearLastError: true,
        expectedVersion: current.version,
      });
    });
    this.ctx.publishRealtime(
      "system",
      "durable",
      {
        type: "durable_run_retry_scheduled",
        runId,
        attemptNo,
        nextRetryAt,
      },
      buildDurableRealtimeOptions(runId),
    );
    return next;
  }

  wakeDurableRun(
    runId: string,
    event: {
      eventKey: string;
      payload?: Record<string, unknown>;
      correlationId?: string;
    },
  ): DurableWakeResult {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    const current = this.ctx.storage.durableRuns.getRun(runId);
    if (current.status === "paused") {
      return {
        runId,
        eventKey: event.eventKey,
        correlationId: event.correlationId,
        outcome: "skipped_paused",
        run: current,
        detail: `Durable run ${runId} is operator-paused.`,
      };
    }
    if (current.status !== "waiting") {
      return {
        runId,
        eventKey: event.eventKey,
        correlationId: event.correlationId,
        outcome: "skipped_not_waiting",
        run: current,
        detail: `Durable run ${runId} is ${current.status}.`,
      };
    }
    const waitForEvent = ((
      current.metadata as { waitForEvent?: { eventKey?: string; correlationId?: string } } | undefined
    )?.waitForEvent ?? {}) as { eventKey?: string; correlationId?: string };
    if (waitForEvent.eventKey && waitForEvent.eventKey !== event.eventKey) {
      return {
        runId,
        eventKey: event.eventKey,
        correlationId: event.correlationId,
        outcome: "skipped_event_key_mismatch",
        run: current,
        detail: `Wake event key mismatch: expected ${waitForEvent.eventKey}`,
      };
    }
    if (waitForEvent.correlationId && waitForEvent.correlationId !== event.correlationId) {
      return {
        runId,
        eventKey: event.eventKey,
        correlationId: event.correlationId,
        outcome: "skipped_correlation_mismatch",
        run: current,
        detail: "Wake correlation mismatch",
      };
    }
    const now = new Date().toISOString();
    let next!: DurableRunRecord;
    try {
      next = this.ctx.storage.durableRuns.updateRun({
        runId,
        status: "queued",
        updatedAt: now,
        startedAt: current.startedAt ?? now,
        clearFinishedAt: true,
        clearLease: true,
        clearLastError: true,
        expectedVersion: current.version,
      });
    } catch (error) {
      return {
        runId,
        eventKey: event.eventKey,
        correlationId: event.correlationId,
        outcome: "failed",
        run: this.ctx.storage.durableRuns.getRun(runId),
        detail: error instanceof Error ? error.message : "Wake failed",
      };
    }
    this.recordDurableTimelineEvent(runId, "run_woken", {
      eventKey: event.eventKey,
      correlationId: event.correlationId,
      payload: event.payload ?? {},
    });
    this.ctx.publishRealtime(
      "system",
      "durable",
      {
        type: "durable_run_woken",
        runId,
        eventKey: event.eventKey,
      },
      buildDurableRealtimeOptions(runId),
    );
    return {
      runId,
      eventKey: event.eventKey,
      correlationId: event.correlationId,
      outcome: "woke",
      run: next,
    };
  }

  recoverDurableDeadLetter(
    entryId: string,
    actorId = "operator",
    options?: { maxAttempts?: number },
  ): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    const deadLetter = this.ctx.storage.durableRuns.getDeadLetterById(entryId);
    const current = this.ctx.storage.durableRuns.getRun(deadLetter.runId);
    const recoverability = this.deps?.workflowRegistry.isWorkflowRecoverable(current);
    if (recoverability && !recoverability.recoverable) {
      throw new Error(recoverability.reason ?? `Durable run ${deadLetter.runId} cannot be safely recovered.`);
    }
    const newMaxAttempts = options?.maxAttempts
      ? Math.max(current.attemptCount + 1, Math.min(20, Math.floor(options.maxAttempts)))
      : undefined;
    let next!: DurableRunRecord;
    this.ctx.storage.runImmediateTransaction(() => {
      this.ctx.storage.durableRuns.resolveDeadLetter(entryId, {
        resolvedAt: new Date().toISOString(),
        resolutionNote: `recovered by ${actorId}${newMaxAttempts ? `, maxAttempts raised to ${newMaxAttempts}` : ""}`,
      });
      next = this.ctx.storage.durableRuns.updateRun({
        runId: deadLetter.runId,
        status: "queued",
        updatedAt: new Date().toISOString(),
        clearFinishedAt: true,
        clearLease: true,
        clearLastError: true,
        ...(newMaxAttempts ? { maxAttempts: newMaxAttempts } : {}),
        expectedVersion: current.version,
      });
      this.recordDurableTimelineEvent(deadLetter.runId, "dead_letter_recovered", {
        actorId,
        deadLetterId: entryId,
        ...(newMaxAttempts ? { maxAttemptsOverride: newMaxAttempts } : {}),
      });
    });
    this.ctx.publishRealtime(
      "system",
      "durable",
      {
        type: "durable_dead_letter_recovered",
        runId: deadLetter.runId,
        deadLetterId: entryId,
      },
      buildDurableRealtimeOptions(deadLetter.runId),
    );
    this.requestRunProcessing(deadLetter.runId);
    return next;
  }

  // ── helpers (previously private on GatewayService) ───────────────

  isDurableFoundationEnabled(): boolean {
    return this.ctx.config.assistant.durable.enabled;
  }

  normalizeDurableRetryPolicy(input: Partial<DurableRetryPolicy> | undefined): DurableRetryPolicy {
    return {
      maxAttempts: Math.max(
        1,
        Math.min(20, Math.floor(input?.maxAttempts ?? DURABLE_RETRY_POLICY_DEFAULT.maxAttempts)),
      ),
      baseDelayMs: Math.max(
        100,
        Math.min(300_000, Math.floor(input?.baseDelayMs ?? DURABLE_RETRY_POLICY_DEFAULT.baseDelayMs)),
      ),
      maxDelayMs: Math.max(
        100,
        Math.min(900_000, Math.floor(input?.maxDelayMs ?? DURABLE_RETRY_POLICY_DEFAULT.maxDelayMs)),
      ),
      backoffMultiplier: Math.max(
        1,
        Math.min(8, input?.backoffMultiplier ?? DURABLE_RETRY_POLICY_DEFAULT.backoffMultiplier),
      ),
    };
  }

  computeDurableRetryDelayMs(current: DurableRunRecord, attemptNo: number): number {
    const metadataPolicy = (current.metadata as { retryPolicy?: Partial<DurableRetryPolicy> } | undefined)?.retryPolicy;
    const policy = this.normalizeDurableRetryPolicy(metadataPolicy);
    const raw = policy.baseDelayMs * policy.backoffMultiplier ** Math.max(0, attemptNo - 1);
    return Math.max(100, Math.min(policy.maxDelayMs, Math.floor(raw)));
  }

  recordDurableTimelineEvent(
    runId: string,
    eventType: DurableRunTimelineEvent["eventType"],
    payload?: Record<string, unknown>,
    stepKey?: string,
  ): DurableRunTimelineEvent {
    const event: DurableRunTimelineEvent = {
      eventId: randomUUID(),
      runId,
      eventType,
      stepKey: stepKey?.trim() || undefined,
      payload: payload ?? {},
      createdAt: new Date().toISOString(),
    };
    return this.ctx.storage.durableRunEvents.append(event);
  }

  private async reconcileRecoverableRuns(): Promise<number> {
    if (!this.deps) {
      return 0;
    }
    let reclaimedCount = 0;
    const runningRunIds = this.ctx.storage.durableRuns.listExpiredRunningRunIds(new Date().toISOString());
    for (const runId of runningRunIds) {
      const run = this.ctx.storage.durableRuns.getRun(runId);
      this.recordDurableTimelineEvent(run.runId, "run_lease_expired", {
        leaseOwnerId: run.leaseOwnerId,
        leaseExpiresAt: run.leaseExpiresAt,
      });
      const recoverability = this.deps.workflowRegistry.isWorkflowRecoverable(run);
      if (!recoverability.recoverable) {
        await this.failExpiredOrphanedWorkflowRun(
          run,
          recoverability.reason ?? "Run could not be recovered after restart.",
        );
        await this.deps.workflowRegistry.markWorkflowUnrecoverable(
          this.ctx.storage.durableRuns.getRun(run.runId),
          recoverability.reason ?? "Run could not be recovered after restart.",
        );
        continue;
      }
      const reclaimed = this.retryDurableRunUpdate(run.runId, (current) =>
        this.ctx.storage.durableRuns.updateRun({
          runId: current.runId,
          status: "queued",
          clearFinishedAt: true,
          clearLease: true,
          clearLastError: true,
          updatedAt: new Date().toISOString(),
          expectedVersion: current.version,
        }),
      );
      this.recordDurableTimelineEvent(reclaimed.runId, "run_reclaimed", {
        previousLeaseOwnerId: run.leaseOwnerId,
        previousLeaseExpiresAt: run.leaseExpiresAt,
      });
      reclaimedCount += 1;
    }
    return reclaimedCount;
  }

  private async drainQueuedRuns(): Promise<void> {
    if (!this.deps) {
      return;
    }
    const deps = this.deps;
    while (true) {
      if (this.isLeaseAcquisitionPaused()) {
        return;
      }
      const run = this.claimNextQueuedRun();
      if (!run) {
        return;
      }
      const gateDecision = deps.evaluateContinuationGate?.(run);
      if (gateDecision && gateDecision.decision !== "continue") {
        this.recordContinuationGateDecision(run, gateDecision, deps);
        if (this.shouldBlockContinuationGateDecision(gateDecision)) {
          this.blockRunForContinuationGate(run, gateDecision);
          continue;
        }
      }
      try {
        const timeoutMs = resolveDurableWorkflowTimeoutMs(run, this.ctx.config.assistant.durable.workflowTimeoutMs);
        await this.executeWithLeaseHeartbeat(run, ({ signal, controller }) =>
          timeoutMs === undefined
            ? deps.workflowRegistry.executeWorkflow(run, { signal })
            : this.executeWithTimeout(
                () => deps.workflowRegistry.executeWorkflow(run, { signal }),
                timeoutMs,
                run.runId,
                controller,
              ),
        );
      } catch (error) {
        if (isDurableWorkflowTimeoutError(error) && isCoworkDurableChatTurnRun(run)) {
          await this.markCoworkRunWaitingForOperator(run, error);
        } else {
          await this.failWorkflowRun(
            run,
            error instanceof Error ? error.message : "Durable workflow execution failed.",
          );
        }
      } finally {
        const current = this.ctx.storage.durableRuns.getRun(run.runId);
        if (current.status === "running") {
          this.recordDurableTimelineEvent(current.runId, "run_incomplete_worker_exit", {
            leaseOwnerId: current.leaseOwnerId,
            leaseExpiresAt: current.leaseExpiresAt,
          });
          await this.failWorkflowRun(current, "Durable workflow exited without marking a terminal or waiting state.");
          const taskId = typeof current.payload?.taskId === "string" ? current.payload.taskId : undefined;
          if (taskId && this.deps?.taskLifecycle) {
            try {
              this.deps.taskLifecycle.autoBlockOnIncompleteExit(taskId, current.runId);
            } catch (error) {
              this.ctx.publishRealtime(
                "system",
                "durable",
                {
                  kind: "task_auto_block_failed",
                  runId: current.runId,
                  taskId,
                  error: error instanceof Error ? error.message : String(error),
                },
                buildDurableRealtimeOptions(current.runId),
              );
            }
          }
        }
      }
    }
  }

  private recordContinuationGateDecision(
    run: DurableRunRecord,
    gateDecision: ContinuationGateDecision,
    deps: NonNullable<typeof this.deps>,
  ): void {
    this.ctx.storage.durableRuns.createCheckpoint({
      runId: run.runId,
      checkpointKind: "continuation_gate",
      state: { continuationGate: gateDecision },
      createdAt: gateDecision.createdAt,
    });
    this.recordDurableTimelineEvent(run.runId, "continuation_gate", {
      decision: gateDecision.decision,
      reasonCodes: gateDecision.reasonCodes,
      recommendedAction: gateDecision.recommendedAction,
    });
    this.ctx.publishRealtime(
      "system",
      "durable",
      {
        type: "durable_continuation_gate",
        runId: run.runId,
        decision: gateDecision.decision,
        reasonCodes: gateDecision.reasonCodes,
        recommendedAction: gateDecision.recommendedAction,
      },
      buildDurableRealtimeOptions(run.runId),
    );
    deps.recordEvidenceEnvelope?.({
      eventKind: "continuation_gate",
      runId: run.runId,
      metadata: {
        workflowKey: run.workflowKey,
        decision: gateDecision.decision,
        reasonCodes: gateDecision.reasonCodes,
        recommendedAction: gateDecision.recommendedAction,
      },
    });
  }

  private shouldBlockContinuationGateDecision(gateDecision: ContinuationGateDecision): boolean {
    return (
      gateDecision.decision === "pause" || gateDecision.decision === "throttle" || gateDecision.decision === "stop"
    );
  }

  private blockRunForContinuationGate(run: DurableRunRecord, gateDecision: ContinuationGateDecision): DurableRunRecord {
    const now = new Date().toISOString();
    const status = gateDecision.decision === "stop" ? "cancelled" : "paused";
    const blocked = this.ctx.storage.durableRuns.updateRun({
      runId: run.runId,
      status,
      updatedAt: now,
      ...(status === "cancelled" ? { finishedAt: now } : { clearFinishedAt: true }),
      clearLease: true,
      clearLastError: true,
      expectedVersion: run.version,
    });
    const eventType = status === "cancelled" ? "run_cancelled" : "run_paused";
    this.recordDurableTimelineEvent(run.runId, eventType, {
      actorId: "continuation_gate",
      previousStatus: run.status,
      decision: gateDecision.decision,
      reasonCodes: gateDecision.reasonCodes,
    });
    this.ctx.publishRealtime(
      "system",
      "durable",
      {
        type: status === "cancelled" ? "durable_run_cancelled" : "durable_run_paused",
        runId: run.runId,
        actorId: "continuation_gate",
        decision: gateDecision.decision,
      },
      buildDurableRealtimeOptions(run.runId),
    );
    return blocked;
  }

  private executeWithTimeout<T>(
    execute: () => Promise<T>,
    timeoutMs: number,
    runId: string,
    controller: AbortController,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new DurableWorkflowTimeoutError(runId, timeoutMs);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
      execute().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private async markCoworkRunWaitingForOperator(
    run: DurableRunRecord,
    error: DurableWorkflowTimeoutError,
  ): Promise<void> {
    const now = new Date().toISOString();
    const waitForEvent = {
      eventKey: COWORK_WORKFLOW_TIMEOUT_RESUME_EVENT,
      correlationId: run.runId,
    };
    const checkpointState = {
      workflowKey: run.workflowKey,
      reason: "cowork_workflow_timeout",
      message: error.message,
      timeoutMs: error.timeoutMs,
      waitForEvent,
    };
    const waiting = this.retryDurableRunUpdate(run.runId, (current) => {
      if (this.isTerminalRunStatus(current.status)) {
        return current;
      }
      if (current.status !== "running" || current.leaseOwnerId !== this.workerId) {
        return current;
      }
      let next!: DurableRunRecord;
      this.ctx.storage.runImmediateTransaction(() => {
        next = this.ctx.storage.durableRuns.updateRun({
          runId: current.runId,
          status: "waiting",
          clearFinishedAt: true,
          clearLease: true,
          clearLastError: true,
          updatedAt: now,
          metadata: {
            ...current.metadata,
            waitForEvent,
            coworkWatchdog: {
              reason: "workflow_timeout",
              timedOutAt: now,
              timeoutMs: error.timeoutMs,
              message: error.message,
            },
          },
          expectedVersion: current.version,
        });
        this.ctx.storage.durableRuns.createCheckpoint({
          runId: next.runId,
          checkpointKind: "run_waiting",
          state: checkpointState,
          createdAt: now,
        });
        this.recordDurableTimelineEvent(next.runId, "run_waiting", checkpointState);
      });
      return next;
    });
    if (waiting.status !== "waiting") {
      return;
    }
    this.ctx.publishRealtime(
      "system",
      "durable",
      {
        type: "durable_run_waiting",
        runId: waiting.runId,
        reason: "cowork_workflow_timeout",
        waitForEvent,
      },
      buildDurableRealtimeOptions(waiting.runId),
    );
  }

  private abortActiveRun(runId: string, reason: string): void {
    const controller = this.activeRunAbortControllers.get(runId);
    if (!controller || controller.signal.aborted) {
      return;
    }
    controller.abort(new Error(reason));
  }

  private async executeWithLeaseHeartbeat<T>(
    run: DurableRunRecord,
    execute: (context: { signal: AbortSignal; controller: AbortController }) => Promise<T>,
  ): Promise<T> {
    let active = true;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectHeartbeatFailure!: (error: Error) => void;
    const controller = new AbortController();
    this.activeRunAbortControllers.set(run.runId, controller);
    const heartbeatFailure = new Promise<never>((_, reject) => {
      rejectHeartbeatFailure = reject;
    });
    const scheduleHeartbeat = () => {
      const expectedAtMs = Date.now() + DURABLE_LEASE_HEARTBEAT_MS;
      heartbeatTimer = setTimeout(() => void heartbeat(expectedAtMs), DURABLE_LEASE_HEARTBEAT_MS);
    };
    let consecutiveHeartbeatFailures = 0;
    let lastSuccessfulRenewalMs = Date.now();
    const heartbeatToleranceExhausted = (): boolean =>
      consecutiveHeartbeatFailures >= DURABLE_LEASE_HEARTBEAT_MAX_CONSECUTIVE_FAILURES ||
      // Wall-clock bound: regardless of attempt count, once the lease could
      // have expired from another worker's perspective we must stop executing
      // or risk a double-run after the reaper reclaims it.
      Date.now() - lastSuccessfulRenewalMs >= DURABLE_LEASE_TTL_MS;
    const heartbeat = async (expectedAtMs: number) => {
      if (!active) {
        return;
      }
      this.recordEventLoopLag(Date.now() - expectedAtMs, run.runId);
      let current: DurableRunRecord;
      try {
        current = this.ctx.storage.durableRuns.getRun(run.runId);
      } catch (error) {
        consecutiveHeartbeatFailures += 1;
        if (!heartbeatToleranceExhausted()) {
          scheduleHeartbeat();
          return;
        }
        active = false;
        controller.abort(error instanceof Error ? error : new Error(String(error)));
        rejectHeartbeatFailure(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (current.status !== "running" || current.leaseOwnerId !== this.workerId) {
        // Definitive ownership loss is not retryable: another worker (or the
        // reaper) owns the run now, so executing further would double-run it.
        active = false;
        const error = new Error(`Durable run ${run.runId} lease ownership moved to another worker.`);
        controller.abort(error);
        rejectHeartbeatFailure(error);
        return;
      }
      const now = new Date().toISOString();
      try {
        const renewed = this.ctx.storage.durableRuns.renewLease({
          runId: run.runId,
          workerId: this.workerId,
          leaseHeartbeatAt: now,
          leaseExpiresAt: new Date(Date.now() + DURABLE_LEASE_TTL_MS).toISOString(),
          updatedAt: now,
        });
        if (!renewed) {
          // A clean false/undefined from renewLease is a definitive CAS loss
          // (another worker holds the lease) — abort immediately, no strikes.
          active = false;
          const error = new Error(`Durable run ${run.runId} lease renewal lost ownership.`);
          controller.abort(error);
          rejectHeartbeatFailure(error);
          return;
        }
        consecutiveHeartbeatFailures = 0;
        lastSuccessfulRenewalMs = Date.now();
      } catch (error) {
        consecutiveHeartbeatFailures += 1;
        if (!heartbeatToleranceExhausted()) {
          scheduleHeartbeat();
          return;
        }
        active = false;
        controller.abort(error instanceof Error ? error : new Error(String(error)));
        rejectHeartbeatFailure(
          error instanceof Error ? error : new Error(`Durable run ${run.runId} lease heartbeat failed.`),
        );
        return;
      }
      scheduleHeartbeat();
    };

    scheduleHeartbeat();
    try {
      return await Promise.race([execute({ signal: controller.signal, controller }), heartbeatFailure]);
    } finally {
      active = false;
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
      }
      this.activeRunAbortControllers.delete(run.runId);
    }
  }

  private recordEventLoopLag(lagMs: number, runId: string): void {
    const boundedLagMs = Math.max(0, Math.floor(lagMs));
    this.lastEventLoopLagMs = boundedLagMs;
    this.lastEventLoopLagAt = new Date().toISOString();
    if (boundedLagMs < DURABLE_EVENT_LOOP_LAG_WARN_MS) {
      return;
    }
    if (boundedLagMs >= DURABLE_EVENT_LOOP_LAG_PAUSE_MS) {
      this.leaseAcquisitionPausedUntilMs = Math.max(
        this.leaseAcquisitionPausedUntilMs,
        Date.now() + Math.min(30_000, Math.max(5_000, boundedLagMs)),
      );
    }
    this.recordDurableTimelineEvent(runId, "worker_event_loop_lag", {
      lagMs: boundedLagMs,
      thresholdMs: DURABLE_EVENT_LOOP_LAG_WARN_MS,
      leaseAcquisitionPausedUntil:
        this.leaseAcquisitionPausedUntilMs > Date.now()
          ? new Date(this.leaseAcquisitionPausedUntilMs).toISOString()
          : undefined,
    });
    this.ctx.publishRealtime(
      "system",
      "durable",
      {
        type: "durable_worker_event_loop_lag",
        runId,
        lagMs: boundedLagMs,
        leaseAcquisitionPausedUntil:
          this.leaseAcquisitionPausedUntilMs > Date.now()
            ? new Date(this.leaseAcquisitionPausedUntilMs).toISOString()
            : undefined,
      },
      buildDurableRealtimeOptions(runId),
    );
  }

  private isLeaseAcquisitionPaused(): boolean {
    return this.leaseAcquisitionPausedUntilMs > Date.now();
  }

  private claimNextQueuedRun(): DurableRunRecord | undefined {
    const queuedRunIds = this.ctx.storage.durableRuns.listRunIdsByStatus("queued");
    if (queuedRunIds.length === 0) {
      return undefined;
    }
    const now = new Date().toISOString();
    const runId = queuedRunIds.find((candidate) => !this.hasFutureRetryGate(candidate, now));
    if (!runId) {
      return undefined;
    }
    const leaseExpiresAt = new Date(Date.now() + DURABLE_LEASE_TTL_MS).toISOString();
    const run = this.ctx.storage.durableRuns.tryClaimQueuedRun({
      runId,
      workerId: this.workerId,
      leaseHeartbeatAt: now,
      leaseExpiresAt,
      updatedAt: now,
    });
    if (!run) {
      return undefined;
    }
    this.ctx.storage.durableRuns.createCheckpoint({
      runId: run.runId,
      checkpointKind: "run_started",
      state: {
        workflowKey: run.workflowKey,
        status: run.status,
      },
      createdAt: now,
    });
    this.recordDurableTimelineEvent(run.runId, "run_started", {
      workflowKey: run.workflowKey,
      status: run.status,
    });
    this.ctx.publishRealtime(
      "system",
      "durable",
      {
        type: "durable_run_started",
        runId: run.runId,
        workflowKey: run.workflowKey,
      },
      buildDurableRealtimeOptions(run.runId),
    );
    return run;
  }

  private hasFutureRetryGate(runId: string, nowIso: string): boolean {
    const latestRetry = this.ctx.storage.durableRuns.listRetries(runId, 100).at(-1);
    if (!latestRetry?.nextRetryAt) {
      return false;
    }
    const nextRetryAt = Date.parse(latestRetry.nextRetryAt);
    const now = Date.parse(nowIso);
    if (!Number.isFinite(nextRetryAt) || !Number.isFinite(now)) {
      return false;
    }
    return nextRetryAt > now;
  }

  private async failWorkflowRun(run: DurableRunRecord, message: string): Promise<void> {
    const now = new Date().toISOString();
    const failed = this.retryDurableRunUpdate(run.runId, (current) => {
      if (this.isTerminalRunStatus(current.status)) {
        return current;
      }
      if (current.status !== "running" || current.leaseOwnerId !== this.workerId) {
        return current;
      }
      return this.persistFailedRun(current, message, now);
    });
    if (failed.status !== "failed") {
      if (failed.leaseOwnerId !== this.workerId) {
        this.ctx.publishRealtime(
          "system",
          "durable",
          {
            type: "durable_run_failure_skipped_lease_lost",
            runId: failed.runId,
            error: message,
            status: failed.status,
            leaseOwnerId: failed.leaseOwnerId,
          },
          {
            eventClass: "operational_signal",
            eventAuthority: "retained_stream",
            links: { runId: failed.runId },
          },
        );
      }
      return;
    }
    this.ctx.publishRealtime(
      "system",
      "durable",
      {
        type: "durable_run_failed",
        runId: failed.runId,
        error: message,
      },
      buildDurableRealtimeOptions(failed.runId),
    );
    await this.deps?.onRunFailed?.(failed, message);
  }

  private async failExpiredOrphanedWorkflowRun(run: DurableRunRecord, message: string): Promise<void> {
    const now = new Date().toISOString();
    const failed = this.retryDurableRunUpdate(run.runId, (current) => {
      if (this.isTerminalRunStatus(current.status)) {
        return current;
      }
      if (current.status !== "running" || !this.isLeaseExpiredAt(current, now)) {
        return current;
      }
      return this.persistFailedRun(current, message, now);
    });
    if (failed.status !== "failed") {
      return;
    }
    this.ctx.publishRealtime(
      "system",
      "durable",
      {
        type: "durable_run_failed",
        runId: failed.runId,
        error: message,
      },
      buildDurableRealtimeOptions(failed.runId),
    );
    await this.deps?.onRunFailed?.(failed, message);
  }

  private persistFailedRun(current: DurableRunRecord, message: string, now: string): DurableRunRecord {
    let next!: DurableRunRecord;
    this.ctx.storage.runImmediateTransaction(() => {
      next = this.ctx.storage.durableRuns.updateRun({
        runId: current.runId,
        status: "failed",
        finishedAt: now,
        clearLease: true,
        lastError: message,
        updatedAt: now,
        expectedVersion: current.version,
      });
      this.ctx.storage.durableRuns.createCheckpoint({
        runId: next.runId,
        checkpointKind: "run_failed",
        state: {
          workflowKey: next.workflowKey,
          error: message,
        },
        createdAt: now,
      });
      this.recordDurableTimelineEvent(next.runId, "run_failed", {
        workflowKey: next.workflowKey,
        error: message,
      });
    });
    return next;
  }

  private isLeaseExpiredAt(run: DurableRunRecord, nowIso: string): boolean {
    return (
      typeof run.leaseExpiresAt === "string" &&
      Number.isFinite(Date.parse(run.leaseExpiresAt)) &&
      Date.parse(run.leaseExpiresAt) <= Date.parse(nowIso)
    );
  }

  private isTerminalRunStatus(status: DurableRunRecord["status"]): boolean {
    return status === "completed" || status === "failed" || status === "cancelled" || status === "dead_lettered";
  }

  private retryDurableRunUpdate(
    runId: string,
    update: (current: DurableRunRecord) => DurableRunRecord,
    maxAttempts = 3,
  ): DurableRunRecord {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const current = this.ctx.storage.durableRuns.getRun(runId);
      try {
        return update(current);
      } catch (error) {
        if (!isDurableRunUpdateConflict(error) || attempt === maxAttempts - 1) {
          throw error;
        }
        lastError = error;
      }
    }
    this.ctx.publishRealtime(
      "durable_run_update_conflict_exhausted",
      "durable",
      {
        runId,
        attempts: maxAttempts,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          runId,
        },
      },
    );
    throw lastError instanceof Error ? lastError : new Error(`Durable run ${runId} update conflict`);
  }

  private ensurePollLoop(): void {
    if (this.pollTimer || this.workerStopped) {
      return;
    }
    const scheduleNext = () => {
      if (this.workerStopped) {
        return;
      }
      const jitter = Math.floor(Math.random() * DURABLE_WORKER_POLL_JITTER_MS);
      this.pollTimer = setTimeout(() => {
        this.pollTimer = undefined;
        if (this.workerStopped) {
          return;
        }
        this.requestRunProcessing();
        scheduleNext();
      }, DURABLE_WORKER_POLL_MIN_MS + jitter);
    };
    scheduleNext();
  }
}

export function resolveDurableWorkflowTimeoutMs(_run: DurableRunRecord, defaultTimeoutMs: number): number | undefined {
  return defaultTimeoutMs;
}

function isDurableWorkflowTimeoutError(error: unknown): error is DurableWorkflowTimeoutError {
  return error instanceof DurableWorkflowTimeoutError;
}

function isCoworkDurableChatTurnRun(run: DurableRunRecord): boolean {
  if (run.workflowKey !== "chat.turn.execute") {
    return false;
  }
  const payload = run.payload as
    | {
        version?: unknown;
        request?: {
          mode?: unknown;
        };
      }
    | undefined;
  return payload?.version === "chat.turn.execute.v1" && payload.request?.mode === "cowork";
}

function isDurableRunUpdateConflict(error: unknown): boolean {
  return error instanceof Error && /durable run .* update conflict/i.test(error.message);
}

function resolveCheckpointPruneConfig(): { keepPerRun: number; diskBudgetBytes: number } {
  const keepRaw = process.env.GOATCITADEL_DURABLE_CHECKPOINT_KEEP_PER_RUN?.trim();
  const budgetRaw = process.env.GOATCITADEL_DURABLE_CHECKPOINT_DISK_BUDGET_BYTES?.trim();
  const keepParsed = keepRaw ? Number.parseInt(keepRaw, 10) : Number.NaN;
  const budgetParsed = budgetRaw ? Number.parseInt(budgetRaw, 10) : Number.NaN;
  return {
    keepPerRun: Number.isFinite(keepParsed) && keepParsed > 0 ? keepParsed : DURABLE_CHECKPOINT_KEEP_PER_RUN_DEFAULT,
    diskBudgetBytes:
      Number.isFinite(budgetParsed) && budgetParsed >= 0 ? budgetParsed : DURABLE_CHECKPOINT_DISK_BUDGET_BYTES_DEFAULT,
  };
}
