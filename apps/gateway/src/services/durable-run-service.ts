import { randomUUID } from "node:crypto";
import type {
  DurableCheckpointRecord,
  DurableDeadLetterRecord,
  DurableDiagnosticsResponse,
  RealtimeEvent,
  DurableRetryPolicy,
  DurableRunCreateRequest,
  DurableRunRecord,
  DurableRunTimelineEvent,
  DurableWakeResult,
} from "@goatcitadel/contracts";
import type { ServiceContext } from "./service-context.js";
import type { DurableWorkflowExecutorRegistry } from "./durable-execution-service.js";

export type DurableRunServiceContext = Pick<
  ServiceContext,
  "config" | "storage" | "publishRealtime" | "requireFeatureEnabled"
>;

const DURABLE_RETRY_POLICY_DEFAULT: DurableRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 5_000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
};
const DURABLE_LEASE_TTL_MS = 15_000;
const DURABLE_WORKER_POLL_MIN_MS = 750;
const DURABLE_WORKER_POLL_JITTER_MS = 500;
const DURABLE_LEASE_HEARTBEAT_MS = 5_000;

function buildDurableRealtimeOptions(runId: string): Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links"> {
  return {
    eventClass: "domain_fact",
    eventAuthority: "retained_stream",
    links: { runId },
  };
}

/**
 * Encapsulates all durable-run lifecycle operations previously inlined
 * in GatewayService.
 */
export class DurableRunService {
  private workerActive = false;
  private workerRequested = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly workerId = randomUUID();

  constructor(
    private readonly ctx: DurableRunServiceContext,
    private readonly deps?: {
      backgroundTasks: Set<Promise<void>>;
      workflowRegistry: Pick<
        DurableWorkflowExecutorRegistry,
        "executeWorkflow" | "isWorkflowRecoverable" | "markWorkflowUnrecoverable"
      >;
      onRunFailed?: (run: DurableRunRecord, message: string) => Promise<void> | void;
    },
  ) {}

  // ── queries ──────────────────────────────────────────────────────

  getDurableDiagnostics(): DurableDiagnosticsResponse {
    const statusCounts = this.ctx.storage.durableRuns.statusCounts();
    return {
      enabled: this.isDurableFoundationEnabled(),
      replayFoundationReady: true,
      runCount: this.ctx.storage.durableRuns.countRuns(),
      queuedCount: statusCounts.queued ?? 0,
      runningCount: statusCounts.running ?? 0,
      waitingCount: statusCounts.waiting ?? 0,
      failedCount: statusCounts.failed ?? 0,
      deadLetterCount: this.ctx.storage.durableRuns.listDeadLetters(1000).length,
      recentRuns: this.ctx.storage.durableRuns.listRuns(25),
      recentDeadLetters: this.ctx.storage.durableRuns.listDeadLetters(25),
      generatedAt: new Date().toISOString(),
    };
  }

  listDurableRuns(limit = 50): DurableRunRecord[] {
    return this.ctx.storage.durableRuns.listRuns(limit);
  }

  listDurableDeadLetters(limit = 50): DurableDeadLetterRecord[] {
    return this.ctx.storage.durableRuns.listDeadLetters(limit);
  }

  listDurableRunCheckpoints(runId: string, limit = 200): DurableCheckpointRecord[] {
    return this.ctx.storage.durableRuns.listCheckpoints(runId, limit);
  }

  getDurableRun(runId: string): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    return this.ctx.storage.durableRuns.getRun(runId);
  }

  listDurableRunTimeline(runId: string, limit = 300): DurableRunTimelineEvent[] {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    return this.ctx.storage.durableRunEvents.listByRun(runId, limit);
  }

  startWorker(): void {
    if (!this.isDurableFoundationEnabled() || !this.deps) {
      return;
    }
    this.reconcileRecoverableRuns();
    this.ensurePollLoop();
    this.requestRunProcessing();
  }

  requestRunProcessing(_runId?: string): void {
    if (!this.isDurableFoundationEnabled() || !this.deps) {
      return;
    }
    this.workerRequested = true;
    if (this.workerActive) {
      return;
    }
    const backgroundTasks = this.deps.backgroundTasks;
    const task = Promise.resolve().then(async () => {
      this.workerActive = true;
      try {
        do {
          this.workerRequested = false;
          await this.reconcileRecoverableRuns();
          await this.drainQueuedRuns();
        } while (this.workerRequested);
      } finally {
        this.workerActive = false;
        backgroundTasks.delete(task);
      }
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
    if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") {
      throw new Error(`Durable run ${runId} is already terminal (${current.status})`);
    }
    let next!: DurableRunRecord;
    this.ctx.storage.runImmediateTransaction(() => {
      next = this.ctx.storage.durableRuns.updateRun({
        runId,
        status: "paused",
        startedAt: current.startedAt ?? new Date().toISOString(),
        finishedAt: undefined,
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
        finishedAt: undefined,
        clearLease: true,
        updatedAt: new Date().toISOString(),
        lastError: undefined,
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
    if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") {
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
    return next;
  }

  retryDurableRun(runId: string, reason = "manual_retry", actorId = "operator"): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    const current = this.ctx.storage.durableRuns.getRun(runId);
    const attemptNo = current.attemptCount + 1;
    if (attemptNo > current.maxAttempts) {
      const deadLetter = this.ctx.storage.durableRuns.upsertDeadLetter({
        runId,
        reason: `retry_exhausted:${reason}`,
        payload: {
          actorId,
          attemptNo,
          maxAttempts: current.maxAttempts,
        },
      });
      const deadLettered = this.ctx.storage.durableRuns.updateRun({
        runId,
        status: "dead_lettered",
        attemptCount: attemptNo,
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        clearLease: true,
        lastError: deadLetter.reason,
        expectedVersion: current.version,
      });
      this.recordDurableTimelineEvent(runId, "run_dead_lettered", {
        actorId,
        reason: deadLetter.reason,
      });
      this.ctx.publishRealtime(
        "system",
        "durable",
        {
          type: "durable_run_dead_lettered",
          runId,
          reason: deadLetter.reason,
        },
        buildDurableRealtimeOptions(runId),
      );
      return deadLettered;
    }
    const delayMs = this.computeDurableRetryDelayMs(current, attemptNo);
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
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
    const next = this.ctx.storage.durableRuns.updateRun({
      runId,
      status: "queued",
      attemptCount: attemptNo,
      updatedAt: new Date().toISOString(),
      finishedAt: undefined,
      clearLease: true,
      lastError: undefined,
      expectedVersion: current.version,
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
        finishedAt: undefined,
        clearLease: true,
        lastError: undefined,
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
        finishedAt: undefined,
        clearLease: true,
        lastError: undefined,
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
    const fromEnv = process.env.GOATCITADEL_DURABLE_FOUNDATION_ENABLED?.trim().toLowerCase();
    if (fromEnv) {
      return fromEnv === "1" || fromEnv === "true" || fromEnv === "yes" || fromEnv === "on";
    }
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

  private async reconcileRecoverableRuns(): Promise<void> {
    if (!this.deps) {
      return;
    }
    const runningRunIds = this.ctx.storage.durableRuns.listExpiredRunningRunIds(new Date().toISOString());
    for (const runId of runningRunIds) {
      const run = this.ctx.storage.durableRuns.getRun(runId);
      const recoverability = this.deps.workflowRegistry.isWorkflowRecoverable(run);
      if (!recoverability.recoverable) {
        await this.failWorkflowRun(run, recoverability.reason ?? "Run could not be recovered after restart.");
        await this.deps.workflowRegistry.markWorkflowUnrecoverable(
          this.ctx.storage.durableRuns.getRun(run.runId),
          recoverability.reason ?? "Run could not be recovered after restart.",
        );
        continue;
      }
      this.ctx.storage.durableRuns.updateRun({
        runId: run.runId,
        status: "queued",
        finishedAt: undefined,
        clearLease: true,
        lastError: undefined,
        updatedAt: new Date().toISOString(),
        expectedVersion: run.version,
      });
    }
  }

  private async drainQueuedRuns(): Promise<void> {
    if (!this.deps) {
      return;
    }
    const deps = this.deps;
    const timeoutMs = this.ctx.config.assistant.durable.workflowTimeoutMs;
    while (true) {
      const run = this.claimNextQueuedRun();
      if (!run) {
        return;
      }
      try {
        await this.executeWithLeaseHeartbeat(run, () =>
          this.executeWithTimeout(deps.workflowRegistry.executeWorkflow(run), timeoutMs, run.runId),
        );
      } catch (error) {
        await this.failWorkflowRun(run, error instanceof Error ? error.message : "Durable workflow execution failed.");
      } finally {
        const current = this.ctx.storage.durableRuns.getRun(run.runId);
        if (current.status === "running") {
          await this.failWorkflowRun(current, "Durable workflow exited without marking a terminal or waiting state.");
        }
      }
    }
  }

  private executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number, runId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Durable workflow ${runId} exceeded ${timeoutMs}ms execution timeout.`));
      }, timeoutMs);
      promise.then(
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

  private async executeWithLeaseHeartbeat<T>(run: DurableRunRecord, execute: () => Promise<T>): Promise<T> {
    let active = true;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    const heartbeat = async () => {
      if (!active) {
        return;
      }
      const current = this.ctx.storage.durableRuns.getRun(run.runId);
      if (current.status !== "running" || current.leaseOwnerId !== this.workerId) {
        return;
      }
      const now = new Date().toISOString();
      try {
        this.ctx.storage.durableRuns.renewLease({
          runId: run.runId,
          workerId: this.workerId,
          leaseHeartbeatAt: now,
          leaseExpiresAt: new Date(Date.now() + DURABLE_LEASE_TTL_MS).toISOString(),
          updatedAt: now,
        });
      } catch {
        return;
      }
      heartbeatTimer = setTimeout(() => void heartbeat(), DURABLE_LEASE_HEARTBEAT_MS);
    };

    heartbeatTimer = setTimeout(() => void heartbeat(), DURABLE_LEASE_HEARTBEAT_MS);
    try {
      return await execute();
    } finally {
      active = false;
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
      }
    }
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
    let failed!: DurableRunRecord;
    this.ctx.storage.runImmediateTransaction(() => {
      failed = this.ctx.storage.durableRuns.updateRun({
        runId: run.runId,
        status: "failed",
        finishedAt: now,
        clearLease: true,
        lastError: message,
        updatedAt: now,
        expectedVersion: run.version,
      });
      this.ctx.storage.durableRuns.createCheckpoint({
        runId: failed.runId,
        checkpointKind: "run_failed",
        state: {
          workflowKey: failed.workflowKey,
          error: message,
        },
        createdAt: now,
      });
      this.recordDurableTimelineEvent(failed.runId, "run_failed", {
        workflowKey: failed.workflowKey,
        error: message,
      });
    });
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

  private ensurePollLoop(): void {
    if (this.pollTimer) {
      return;
    }
    const scheduleNext = () => {
      const jitter = Math.floor(Math.random() * DURABLE_WORKER_POLL_JITTER_MS);
      this.pollTimer = setTimeout(() => {
        this.pollTimer = undefined;
        this.requestRunProcessing();
        scheduleNext();
      }, DURABLE_WORKER_POLL_MIN_MS + jitter);
    };
    scheduleNext();
  }
}
