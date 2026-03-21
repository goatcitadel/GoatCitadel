import { randomUUID } from "node:crypto";
import type {
  DurableCheckpointRecord,
  DurableDeadLetterRecord,
  DurableDiagnosticsResponse,
  DurableRetryPolicy,
  DurableRunCreateRequest,
  DurableRunRecord,
  DurableRunTimelineEvent,
} from "@goatcitadel/contracts";
import type { ServiceContext } from "./service-context.js";

const DURABLE_RETRY_POLICY_DEFAULT: DurableRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 5_000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
};

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Encapsulates all durable-run lifecycle operations previously inlined
 * in GatewayService.
 */
export class DurableRunService {
  private workerActive = false;
  private workerRequested = false;
  private readonly activeRunIds = new Set<string>();

  constructor(
    private readonly ctx: ServiceContext,
    private readonly deps?: {
      backgroundTasks: Set<Promise<void>>;
      executeWorkflow: (run: DurableRunRecord) => Promise<void>;
      isWorkflowRecoverable?: (run: DurableRunRecord) => { recoverable: boolean; reason?: string };
      markWorkflowUnrecoverable?: (run: DurableRunRecord, reason: string) => Promise<void> | void;
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
    const safeLimit = Math.max(1, Math.min(2_000, Math.floor(limit)));
    const rows = this.ctx.gatewaySql.prepare(`
      SELECT event_id, run_id, event_type, step_key, payload_json, created_at
      FROM durable_run_events
      WHERE run_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(runId, safeLimit) as Array<{
      event_id: string;
      run_id: string;
      event_type: DurableRunTimelineEvent["eventType"];
      step_key: string | null;
      payload_json: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      eventId: row.event_id,
      runId: row.run_id,
      eventType: row.event_type,
      stepKey: row.step_key ?? undefined,
      payload: safeJsonParse<Record<string, unknown>>(row.payload_json ?? "", {}),
      createdAt: row.created_at,
    }));
  }

  startWorker(): void {
    if (!this.isDurableFoundationEnabled() || !this.deps) {
      return;
    }
    this.reconcileRecoverableRuns();
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
    let task: Promise<void> | undefined;
    task = (async () => {
      this.workerActive = true;
      try {
        do {
          this.workerRequested = false;
          await this.reconcileRecoverableRuns();
          await this.drainQueuedRuns();
        } while (this.workerRequested);
      } finally {
        this.workerActive = false;
        if (task) {
          this.deps?.backgroundTasks.delete(task);
        }
      }
    })();
    this.deps.backgroundTasks.add(task);
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
    const run = this.ctx.storage.durableRuns.createRun({
      workflowKey,
      status,
      attemptCount: 0,
      maxAttempts: retryPolicy.maxAttempts,
      payload: input.payload ?? {},
      metadata: {
        retryPolicy,
        waitForEvent: input.waitForEvent ?? null,
      },
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
    this.ctx.publishRealtime("system", "durable", {
      type: "durable_run_created",
      runId: run.runId,
      workflowKey: run.workflowKey,
      status: run.status,
    });
    return run;
  }

  pauseDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    const current = this.ctx.storage.durableRuns.getRun(runId);
    if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") {
      throw new Error(`Durable run ${runId} is already terminal (${current.status})`);
    }
    const next = this.ctx.storage.durableRuns.updateRun({
      runId,
      status: "paused",
      startedAt: current.startedAt ?? new Date().toISOString(),
      finishedAt: undefined,
      updatedAt: new Date().toISOString(),
    });
    this.recordDurableTimelineEvent(runId, "run_paused", {
      actorId,
      previousStatus: current.status,
    });
    this.ctx.publishRealtime("system", "durable", {
      type: "durable_run_paused",
      runId,
      actorId,
    });
    return next;
  }

  resumeDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    const current = this.ctx.storage.durableRuns.getRun(runId);
    if (current.status !== "paused" && current.status !== "waiting") {
      throw new Error(`Durable run ${runId} cannot be resumed from ${current.status}`);
    }
    const next = this.ctx.storage.durableRuns.updateRun({
      runId,
      status: "running",
      startedAt: current.startedAt ?? new Date().toISOString(),
      finishedAt: undefined,
      updatedAt: new Date().toISOString(),
      lastError: undefined,
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
    this.ctx.publishRealtime("system", "durable", {
      type: "durable_run_resumed",
      runId,
      actorId,
    });
    return next;
  }

  cancelDurableRun(runId: string, actorId = "operator"): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    const current = this.ctx.storage.durableRuns.getRun(runId);
    if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") {
      throw new Error(`Durable run ${runId} is already terminal (${current.status})`);
    }
    const now = new Date().toISOString();
    const next = this.ctx.storage.durableRuns.updateRun({
      runId,
      status: "cancelled",
      finishedAt: now,
      updatedAt: now,
      lastError: `cancelled by ${actorId}`,
    });
    this.recordDurableTimelineEvent(runId, "run_cancelled", {
      actorId,
      previousStatus: current.status,
    });
    this.ctx.publishRealtime("system", "durable", {
      type: "durable_run_cancelled",
      runId,
      actorId,
    });
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
        lastError: deadLetter.reason,
      });
      this.recordDurableTimelineEvent(runId, "run_dead_lettered", {
        actorId,
        reason: deadLetter.reason,
      });
      this.ctx.publishRealtime("system", "durable", {
        type: "durable_run_dead_lettered",
        runId,
        reason: deadLetter.reason,
      });
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
      lastError: undefined,
    });
    this.ctx.publishRealtime("system", "durable", {
      type: "durable_run_retry_scheduled",
      runId,
      attemptNo,
      nextRetryAt,
    });
    return next;
  }

  wakeDurableRun(
    runId: string,
    event: {
      eventKey: string;
      payload?: Record<string, unknown>;
      correlationId?: string;
    },
  ): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    const current = this.ctx.storage.durableRuns.getRun(runId);
    if (current.status !== "waiting" && current.status !== "paused") {
      throw new Error(`Durable run ${runId} is not waiting/paused`);
    }
    const waitForEvent = ((current.metadata as { waitForEvent?: { eventKey?: string; correlationId?: string } } | undefined)
      ?.waitForEvent ?? {}) as { eventKey?: string; correlationId?: string };
    if (waitForEvent.eventKey && waitForEvent.eventKey !== event.eventKey) {
      throw new Error(`Wake event key mismatch: expected ${waitForEvent.eventKey}`);
    }
    if (waitForEvent.correlationId && waitForEvent.correlationId !== event.correlationId) {
      throw new Error("Wake correlation mismatch");
    }
    const now = new Date().toISOString();
    const next = this.ctx.storage.durableRuns.updateRun({
      runId,
      status: "running",
      updatedAt: now,
      startedAt: current.startedAt ?? now,
      finishedAt: undefined,
      lastError: undefined,
    });
    this.recordDurableTimelineEvent(runId, "run_woken", {
      eventKey: event.eventKey,
      correlationId: event.correlationId,
      payload: event.payload ?? {},
    });
    this.ctx.publishRealtime("system", "durable", {
      type: "durable_run_woken",
      runId,
      eventKey: event.eventKey,
    });
    return next;
  }

  recoverDurableDeadLetter(entryId: string, actorId = "operator"): DurableRunRecord {
    this.ctx.requireFeatureEnabled("durableKernelV1Enabled");
    const row = this.ctx.gatewaySql.prepare(`
      SELECT dead_letter_id, run_id, reason
      FROM durable_dead_letters
      WHERE dead_letter_id = ?
    `).get(entryId) as { dead_letter_id: string; run_id: string; reason: string } | undefined;
    if (!row) {
      throw new Error(`Durable dead-letter entry not found: ${entryId}`);
    }
    this.ctx.gatewaySql.prepare(`
      UPDATE durable_dead_letters
      SET resolved_at = @resolvedAt, resolution_note = @note
      WHERE dead_letter_id = @entryId
    `).run({
      entryId,
      resolvedAt: new Date().toISOString(),
      note: `recovered by ${actorId}`,
    });
    const next = this.ctx.storage.durableRuns.updateRun({
      runId: row.run_id,
      status: "queued",
      updatedAt: new Date().toISOString(),
      finishedAt: undefined,
      lastError: undefined,
    });
    this.recordDurableTimelineEvent(row.run_id, "dead_letter_recovered", {
      actorId,
      deadLetterId: entryId,
    });
    this.ctx.publishRealtime("system", "durable", {
      type: "durable_dead_letter_recovered",
      runId: row.run_id,
      deadLetterId: entryId,
    });
    this.requestRunProcessing(row.run_id);
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
      maxAttempts: Math.max(1, Math.min(20, Math.floor(input?.maxAttempts ?? DURABLE_RETRY_POLICY_DEFAULT.maxAttempts))),
      baseDelayMs: Math.max(100, Math.min(300_000, Math.floor(input?.baseDelayMs ?? DURABLE_RETRY_POLICY_DEFAULT.baseDelayMs))),
      maxDelayMs: Math.max(100, Math.min(900_000, Math.floor(input?.maxDelayMs ?? DURABLE_RETRY_POLICY_DEFAULT.maxDelayMs))),
      backoffMultiplier: Math.max(1, Math.min(8, input?.backoffMultiplier ?? DURABLE_RETRY_POLICY_DEFAULT.backoffMultiplier)),
    };
  }

  computeDurableRetryDelayMs(current: DurableRunRecord, attemptNo: number): number {
    const metadataPolicy = (current.metadata as { retryPolicy?: Partial<DurableRetryPolicy> } | undefined)?.retryPolicy;
    const policy = this.normalizeDurableRetryPolicy(metadataPolicy);
    const raw = policy.baseDelayMs * (policy.backoffMultiplier ** Math.max(0, attemptNo - 1));
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
    this.ctx.gatewaySql.prepare(`
      INSERT INTO durable_run_events (event_id, run_id, event_type, step_key, payload_json, created_at)
      VALUES (@eventId, @runId, @eventType, @stepKey, @payloadJson, @createdAt)
    `).run({
      eventId: event.eventId,
      runId: event.runId,
      eventType: event.eventType,
      stepKey: event.stepKey ?? null,
      payloadJson: JSON.stringify(event.payload ?? {}),
      createdAt: event.createdAt,
    });
    return event;
  }

  private async reconcileRecoverableRuns(): Promise<void> {
    if (!this.deps) {
      return;
    }
    const runningRows = this.ctx.gatewaySql.prepare(`
      SELECT run_id
      FROM durable_runs
      WHERE status = 'running'
      ORDER BY created_at ASC
    `).all() as Array<{ run_id: string }>;

    for (const row of runningRows) {
      if (this.activeRunIds.has(row.run_id)) {
        continue;
      }
      const run = this.ctx.storage.durableRuns.getRun(row.run_id);
      const recoverability = this.deps.isWorkflowRecoverable?.(run) ?? { recoverable: true };
      if (!recoverability.recoverable) {
        await this.failWorkflowRun(run, recoverability.reason ?? "Run could not be recovered after restart.");
        await this.deps.markWorkflowUnrecoverable?.(
          this.ctx.storage.durableRuns.getRun(run.runId),
          recoverability.reason ?? "Run could not be recovered after restart.",
        );
        continue;
      }
      this.ctx.storage.durableRuns.updateRun({
        runId: run.runId,
        status: "queued",
        finishedAt: undefined,
        lastError: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private async drainQueuedRuns(): Promise<void> {
    if (!this.deps) {
      return;
    }
    while (true) {
      const run = this.claimNextQueuedRun();
      if (!run) {
        return;
      }
      this.activeRunIds.add(run.runId);
      try {
        await this.deps.executeWorkflow(run);
      } catch (error) {
        await this.failWorkflowRun(run, error instanceof Error ? error.message : "Durable workflow execution failed.");
      } finally {
        const current = this.ctx.storage.durableRuns.getRun(run.runId);
        if (current.status === "running") {
          await this.failWorkflowRun(current, "Durable workflow exited without marking a terminal or waiting state.");
        }
        this.activeRunIds.delete(run.runId);
      }
    }
  }

  private claimNextQueuedRun(): DurableRunRecord | undefined {
    const rows = this.ctx.gatewaySql.prepare(`
      SELECT run_id
      FROM durable_runs
      WHERE status = 'queued'
      ORDER BY created_at ASC
    `).all() as Array<{ run_id: string }>;
    if (rows.length === 0) {
      return undefined;
    }
    const now = new Date().toISOString();
    const row = rows.find((candidate) => !this.hasFutureRetryGate(candidate.run_id, now));
    if (!row) {
      return undefined;
    }
    const current = this.ctx.storage.durableRuns.getRun(row.run_id);
    const run = this.ctx.storage.durableRuns.updateRun({
      runId: row.run_id,
      status: "running",
      startedAt: current.startedAt ?? now,
      finishedAt: undefined,
      lastError: undefined,
      updatedAt: now,
    });
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
    this.ctx.publishRealtime("system", "durable", {
      type: "durable_run_started",
      runId: run.runId,
      workflowKey: run.workflowKey,
    });
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
    const failed = this.ctx.storage.durableRuns.updateRun({
      runId: run.runId,
      status: "failed",
      finishedAt: now,
      lastError: message,
      updatedAt: now,
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
    this.ctx.publishRealtime("system", "durable", {
      type: "durable_run_failed",
      runId: failed.runId,
      error: message,
    });
  }
}
