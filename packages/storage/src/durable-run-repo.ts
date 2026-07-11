import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  DurableCheckpointRecord,
  DurableDeadLetterRecord,
  DurableRetryRecord,
  DurableRunRecord,
  DurableRunStatus,
} from "@goatcitadel/contracts";
import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";
import { loadAndSanitize, type QuarantineEntry } from "./load-and-sanitize.js";
import { parseJsonObject } from "./state-validators.js";
import {
  toCountRow,
  toDurableCheckpointRows,
  toDurableDeadLetterRow,
  toDurableDeadLetterRows,
  toDurableRetryRows,
  toDurableRunRow,
  toDurableRunRows,
  type DurableDeadLetterRow,
  type DurableRunRow,
} from "./durable-run-row-codec.js";

export interface PruneCheckpointsResult {
  prunedOrphans: number;
  prunedAged: number;
  finalBytes: number;
  diskBudgetBytes: number;
}

export interface DurableRunRepositoryOptions {
  quarantine?: { record: (entry: QuarantineEntry) => unknown };
  logger?: { warn: (data: unknown, msg: string) => void };
}

export class DurableRunRepository {
  private readonly insertRunStmt;
  private readonly getRunStmt;
  private readonly lockActiveLeaseForUpdateStmt;
  private readonly getRunsByIdsStmtCache = new Map<number, ReturnType<DatabaseClient["prepare"]>>();
  private readonly updateRunStmt;
  private readonly listRunsStmt;
  private readonly listRunIdsByStatusStmt;
  private readonly listPendingLinkedFinalizationRunIdsStmt;
  private readonly listPendingAutonomousChatPostCommitRunIdsStmt;
  private readonly listPendingGeneralChatPostCommitRunIdsStmt;
  private readonly listExpiredRunningRunIdsStmt;
  private readonly countRunsStmt;
  private readonly statusCountsStmt;
  private readonly insertCheckpointStmt;
  private readonly listCheckpointsStmt;
  private readonly upsertRetryStmt;
  private readonly listRetriesStmt;
  private readonly upsertDeadLetterStmt;
  private readonly listDeadLettersStmt;
  private readonly getDeadLetterByRunStmt;
  private readonly getDeadLetterByIdStmt;
  private readonly resolveDeadLetterStmt;

  public constructor(
    private readonly db: DatabaseClient,
    private readonly options: DurableRunRepositoryOptions = {},
  ) {
    this.insertRunStmt = db.prepare(`
      INSERT INTO durable_runs (
        run_id, workflow_key, status, attempt_count, max_attempts,
        payload_json, metadata_json, started_at, finished_at, last_error,
        lease_owner_id, lease_expires_at, lease_heartbeat_at, version, created_at, updated_at
      ) VALUES (
        @runId, @workflowKey, @status, @attemptCount, @maxAttempts,
        @payloadJson, @metadataJson, @startedAt, @finishedAt, @lastError,
        @leaseOwnerId, @leaseExpiresAt, @leaseHeartbeatAt, @version, @createdAt, @updatedAt
      )
    `);
    this.getRunStmt = db.prepare("SELECT * FROM durable_runs WHERE run_id = ?");
    this.lockActiveLeaseForUpdateStmt = db.prepare(`
      SELECT *
      FROM durable_runs
      WHERE run_id = @runId
        AND status = 'running'
        AND lease_owner_id = @expectedLeaseOwnerId
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > @now
      ${db.dialect === "postgres" ? "FOR UPDATE" : ""}
    `);
    this.updateRunStmt = db.prepare(`
      UPDATE durable_runs
      SET
        status = @status,
        attempt_count = @attemptCount,
        max_attempts = @maxAttempts,
        payload_json = @payloadJson,
        metadata_json = @metadataJson,
        started_at = @startedAt,
        finished_at = @finishedAt,
        last_error = @lastError,
        lease_owner_id = @leaseOwnerId,
        lease_expires_at = @leaseExpiresAt,
        lease_heartbeat_at = @leaseHeartbeatAt,
        version = @nextVersion,
        updated_at = @updatedAt
      WHERE run_id = @runId
        AND version = @expectedVersion
    `);
    this.listRunsStmt = db.prepare(`
      SELECT * FROM durable_runs
      ORDER BY created_at DESC
      LIMIT ?
    `);
    this.listRunIdsByStatusStmt = db.prepare(`
      SELECT run_id
      FROM durable_runs
      WHERE status = ?
      ORDER BY created_at ASC
      LIMIT ?
    `);
    this.listPendingLinkedFinalizationRunIdsStmt = db.prepare(`
      SELECT run_id
      FROM durable_runs
      WHERE status = 'failed'
        AND metadata_json LIKE '%"linkedFinalizationPending":%'
        AND (@afterRunId IS NULL OR run_id > @afterRunId)
      ORDER BY run_id ASC
      LIMIT @limit
    `);
    this.listPendingAutonomousChatPostCommitRunIdsStmt = db.prepare(`
      SELECT run_id
      FROM durable_runs
      WHERE status = 'completed'
        AND workflow_key = 'chat.turn.execute'
        AND metadata_json LIKE '%"autonomousChatPostCommitPending":%'
        AND (@afterRunId IS NULL OR run_id > @afterRunId)
      ORDER BY run_id ASC
      LIMIT @limit
    `);
    this.listPendingGeneralChatPostCommitRunIdsStmt = db.prepare(`
      SELECT run_id
      FROM durable_runs
      WHERE status IN ('completed', 'failed', 'cancelled', 'waiting')
        AND workflow_key = 'chat.turn.execute'
        AND metadata_json LIKE '%"generalChatPostCommitPending":%'
        AND (@afterRunId IS NULL OR run_id > @afterRunId)
      ORDER BY run_id ASC
      LIMIT @limit
    `);
    this.listExpiredRunningRunIdsStmt = db.prepare(`
      SELECT run_id
      FROM durable_runs
      WHERE status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
      ORDER BY updated_at ASC, run_id ASC
      LIMIT ?
    `);
    this.countRunsStmt = db.prepare("SELECT COUNT(1) AS count FROM durable_runs");
    this.statusCountsStmt = db.prepare(`
      SELECT status, COUNT(1) AS count
      FROM durable_runs
      GROUP BY status
    `);
    this.insertCheckpointStmt = db.prepare(`
      INSERT INTO durable_checkpoints (
        checkpoint_id, run_id, checkpoint_kind, state_json, created_at
      ) VALUES (
        @checkpointId, @runId, @checkpointKind, @stateJson, @createdAt
      )
    `);
    this.listCheckpointsStmt = db.prepare(`
      SELECT * FROM durable_checkpoints
      WHERE run_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `);
    this.upsertRetryStmt = db.prepare(`
      INSERT INTO durable_retries (
        retry_id, run_id, attempt_no, reason, next_retry_at, created_at
      ) VALUES (
        @retryId, @runId, @attemptNo, @reason, @nextRetryAt, @createdAt
      )
      ON CONFLICT(run_id, attempt_no) DO UPDATE SET
        reason = excluded.reason,
        next_retry_at = excluded.next_retry_at
    `);
    this.listRetriesStmt = db.prepare(`
      SELECT * FROM durable_retries
      WHERE run_id = ?
      ORDER BY attempt_no ASC
      LIMIT ?
    `);
    this.upsertDeadLetterStmt = db.prepare(`
      INSERT INTO durable_dead_letters (
        dead_letter_id, run_id, reason, payload_json, created_at, resolved_at, resolution_note
      ) VALUES (
        @deadLetterId, @runId, @reason, @payloadJson, @createdAt, @resolvedAt, @resolutionNote
      )
      ON CONFLICT(run_id) DO UPDATE SET
        reason = excluded.reason,
        payload_json = excluded.payload_json,
        resolved_at = excluded.resolved_at,
        resolution_note = excluded.resolution_note
    `);
    this.listDeadLettersStmt = db.prepare(`
      SELECT * FROM durable_dead_letters
      ORDER BY created_at DESC
      LIMIT ?
    `);
    this.getDeadLetterByRunStmt = db.prepare(`
      SELECT * FROM durable_dead_letters
      WHERE run_id = ?
      LIMIT 1
    `);
    this.getDeadLetterByIdStmt = db.prepare(`
      SELECT * FROM durable_dead_letters
      WHERE dead_letter_id = ?
      LIMIT 1
    `);
    this.resolveDeadLetterStmt = db.prepare(`
      UPDATE durable_dead_letters
      SET resolved_at = @resolvedAt,
          resolution_note = @resolutionNote
      WHERE dead_letter_id = @deadLetterId
        AND resolved_at IS NULL
    `);
  }

  public createRun(input: {
    runId?: string;
    workflowKey: string;
    status?: DurableRunStatus;
    attemptCount?: number;
    maxAttempts?: number;
    payload?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    startedAt?: string;
    finishedAt?: string;
    lastError?: string;
    leaseOwnerId?: string;
    leaseExpiresAt?: string;
    leaseHeartbeatAt?: string;
    version?: number;
    now?: string;
  }): DurableRunRecord {
    const now = input.now ?? new Date().toISOString();
    const run: DurableRunRecord = {
      runId: input.runId ?? randomUUID(),
      workflowKey: input.workflowKey.trim(),
      status: input.status ?? "queued",
      attemptCount: Math.max(0, Math.floor(input.attemptCount ?? 0)),
      maxAttempts: Math.max(1, Math.floor(input.maxAttempts ?? 3)),
      version: Math.max(1, Math.floor(input.version ?? 1)),
      payload: normalizeObject(input.payload),
      metadata: normalizeOptionalObject(input.metadata),
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      lastError: input.lastError?.trim() || undefined,
      leaseOwnerId: input.leaseOwnerId?.trim() || undefined,
      leaseExpiresAt: input.leaseExpiresAt,
      leaseHeartbeatAt: input.leaseHeartbeatAt,
      createdAt: now,
      updatedAt: now,
    };
    if (!run.workflowKey) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "workflowKey" });
    }
    this.insertRunStmt.run({
      runId: run.runId,
      workflowKey: run.workflowKey,
      status: run.status,
      attemptCount: run.attemptCount,
      maxAttempts: run.maxAttempts,
      payloadJson: JSON.stringify(run.payload),
      metadataJson: run.metadata ? JSON.stringify(run.metadata) : null,
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt ?? null,
      lastError: run.lastError ?? null,
      leaseOwnerId: run.leaseOwnerId ?? null,
      leaseExpiresAt: run.leaseExpiresAt ?? null,
      leaseHeartbeatAt: run.leaseHeartbeatAt ?? null,
      version: run.version,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    });
    return this.getRun(run.runId);
  }

  public getRun(runId: string): DurableRunRecord {
    const row = toDurableRunRow(this.getRunStmt.get(runId));
    if (!row) {
      throw new NotFoundError({ entity: "Durable run", id: runId });
    }
    return this.mapRunRow(row);
  }

  /**
   * Locks and returns a run only while the caller still owns its active lease.
   * Callers must invoke this method inside a storage transaction. PostgreSQL
   * takes an explicit row lock; SQLite's BEGIN IMMEDIATE transaction provides
   * the corresponding write serialization before this predicate is evaluated.
   */
  public lockActiveLeaseForUpdate(
    runId: string,
    expectedLeaseOwnerId: string,
    now: string,
  ): DurableRunRecord | undefined {
    const row = toDurableRunRow(
      this.lockActiveLeaseForUpdateStmt.get({
        runId,
        expectedLeaseOwnerId,
        now,
      }),
    );
    return row ? this.mapRunRow(row) : undefined;
  }

  public getRunsByIds(runIds: Array<string | undefined>): Map<string, DurableRunRecord> {
    const uniqueRunIds = [
      ...new Set(runIds.map((item) => item?.trim()).filter((item): item is string => Boolean(item))),
    ];
    const byRunId = new Map<string, DurableRunRecord>();
    if (uniqueRunIds.length === 0) {
      return byRunId;
    }

    for (let index = 0; index < uniqueRunIds.length; index += 400) {
      const batch = uniqueRunIds.slice(index, index + 400);
      const stmt = this.getGetRunsByIdsStmt(batch.length);
      const rows = toDurableRunRows(stmt.all(...batch));
      for (const row of rows) {
        const record = this.mapRunRow(row);
        byRunId.set(record.runId, record);
      }
    }

    return byRunId;
  }

  private getGetRunsByIdsStmt(size: number) {
    const cached = this.getRunsByIdsStmtCache.get(size);
    if (cached) {
      return cached;
    }
    const placeholders = new Array(size).fill("?").join(", ");
    const stmt = this.db.prepare(`SELECT * FROM durable_runs WHERE run_id IN (${placeholders})`);
    this.getRunsByIdsStmtCache.set(size, stmt);
    return stmt;
  }

  public updateRun(input: {
    runId: string;
    status: DurableRunStatus;
    attemptCount?: number;
    maxAttempts?: number;
    payload?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    startedAt?: string;
    finishedAt?: string;
    clearFinishedAt?: boolean;
    lastError?: string;
    clearLastError?: boolean;
    leaseOwnerId?: string;
    leaseExpiresAt?: string;
    leaseHeartbeatAt?: string;
    clearLease?: boolean;
    updatedAt?: string;
    expectedVersion?: number;
  }): DurableRunRecord {
    const current = this.getRun(input.runId);
    const next = this.buildNextRun(current, input);
    const result = this.updateRunStmt.run({
      runId: next.runId,
      status: next.status,
      attemptCount: next.attemptCount,
      maxAttempts: next.maxAttempts,
      payloadJson: JSON.stringify(next.payload),
      metadataJson: next.metadata ? JSON.stringify(next.metadata) : null,
      startedAt: next.startedAt ?? null,
      finishedAt: next.finishedAt ?? null,
      lastError: next.lastError ?? null,
      leaseOwnerId: next.leaseOwnerId ?? null,
      leaseExpiresAt: next.leaseExpiresAt ?? null,
      leaseHeartbeatAt: next.leaseHeartbeatAt ?? null,
      nextVersion: next.version,
      expectedVersion: input.expectedVersion ?? current.version,
      updatedAt: next.updatedAt,
    });
    if ((result.changes ?? 0) < 1) {
      throw new Error(`Durable run ${input.runId} update conflict`);
    }
    return this.getRun(next.runId);
  }

  public tryClaimQueuedRun(input: {
    runId: string;
    workerId: string;
    leaseHeartbeatAt: string;
    leaseExpiresAt: string;
    updatedAt?: string;
  }): DurableRunRecord | undefined {
    const current = this.getRun(input.runId);
    if (current.status !== "queued") {
      return undefined;
    }
    const next = this.buildNextRun(current, {
      runId: input.runId,
      status: "running",
      startedAt: current.startedAt ?? input.leaseHeartbeatAt,
      clearFinishedAt: true,
      clearLastError: true,
      leaseOwnerId: input.workerId,
      leaseHeartbeatAt: input.leaseHeartbeatAt,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.updatedAt ?? input.leaseHeartbeatAt,
    });
    const result = this.updateRunStmt.run({
      runId: next.runId,
      status: next.status,
      attemptCount: next.attemptCount,
      maxAttempts: next.maxAttempts,
      payloadJson: JSON.stringify(next.payload),
      metadataJson: next.metadata ? JSON.stringify(next.metadata) : null,
      startedAt: next.startedAt ?? null,
      finishedAt: next.finishedAt ?? null,
      lastError: next.lastError ?? null,
      leaseOwnerId: next.leaseOwnerId ?? null,
      leaseExpiresAt: next.leaseExpiresAt ?? null,
      leaseHeartbeatAt: next.leaseHeartbeatAt ?? null,
      nextVersion: next.version,
      expectedVersion: current.version,
      updatedAt: next.updatedAt,
    });
    return (result.changes ?? 0) > 0 ? this.getRun(input.runId) : undefined;
  }

  public renewLease(input: {
    runId: string;
    workerId: string;
    leaseHeartbeatAt: string;
    leaseExpiresAt: string;
    updatedAt?: string;
  }): DurableRunRecord | undefined {
    const current = this.getRun(input.runId);
    if (current.status !== "running" || current.leaseOwnerId !== input.workerId) {
      return undefined;
    }
    return this.updateRun({
      runId: input.runId,
      status: current.status,
      leaseOwnerId: input.workerId,
      leaseHeartbeatAt: input.leaseHeartbeatAt,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.updatedAt ?? input.leaseHeartbeatAt,
      expectedVersion: current.version,
    });
  }

  public releaseLease(runId: string, workerId: string, updatedAt?: string): DurableRunRecord | undefined {
    const current = this.getRun(runId);
    if (current.leaseOwnerId !== workerId) {
      return undefined;
    }
    return this.updateRun({
      runId,
      status: current.status,
      clearLease: true,
      updatedAt: updatedAt ?? new Date().toISOString(),
      expectedVersion: current.version,
    });
  }

  public listRuns(limit = 25): DurableRunRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = toDurableRunRows(this.listRunsStmt.all(safeLimit));
    return rows.map((row) => this.mapRunRow(row));
  }

  public listRunIdsByStatus(status: DurableRunStatus, limit = 500): string[] {
    const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
    const rows = this.listRunIdsByStatusStmt.all(status, safeLimit) as Array<{ run_id: string }>;
    return rows.map((row) => row.run_id);
  }

  public listPendingLinkedFinalizationRunIds(limit = 500, afterRunId?: string): string[] {
    const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
    const rows = this.listPendingLinkedFinalizationRunIdsStmt.all({
      afterRunId: afterRunId ?? null,
      limit: safeLimit,
    }) as Array<{ run_id: string }>;
    return rows.map((row) => row.run_id);
  }

  public listPendingAutonomousChatPostCommitRunIds(limit = 500, afterRunId?: string): string[] {
    const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
    const rows = this.listPendingAutonomousChatPostCommitRunIdsStmt.all({
      afterRunId: afterRunId ?? null,
      limit: safeLimit,
    }) as Array<{ run_id: string }>;
    return rows.map((row) => row.run_id);
  }

  public listPendingGeneralChatPostCommitRunIds(limit = 500, afterRunId?: string): string[] {
    const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
    const rows = this.listPendingGeneralChatPostCommitRunIdsStmt.all({
      afterRunId: afterRunId ?? null,
      limit: safeLimit,
    }) as Array<{ run_id: string }>;
    return rows.map((row) => row.run_id);
  }

  public listExpiredRunningRunIds(nowIso: string, limit = 500): string[] {
    const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
    const rows = this.listExpiredRunningRunIdsStmt.all(nowIso, safeLimit) as Array<{ run_id: string }>;
    return rows.map((row) => row.run_id);
  }

  public countRuns(): number {
    const row = toCountRow(this.countRunsStmt.get());
    return Number(row?.count ?? 0);
  }

  public statusCounts(): Partial<Record<DurableRunStatus, number>> {
    const rows = this.statusCountsStmt.all() as Array<{ status: DurableRunStatus; count: number }>;
    const counts: Partial<Record<DurableRunStatus, number>> = {};
    for (const row of rows) {
      counts[row.status] = Number(row.count ?? 0);
    }
    return counts;
  }

  public createCheckpoint(input: {
    checkpointId?: string;
    runId: string;
    checkpointKind: DurableCheckpointRecord["checkpointKind"];
    state?: Record<string, unknown>;
    createdAt?: string;
  }): DurableCheckpointRecord {
    const checkpoint: DurableCheckpointRecord = {
      checkpointId: input.checkpointId ?? randomUUID(),
      runId: input.runId,
      checkpointKind: input.checkpointKind,
      state: normalizeObject(input.state),
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.insertCheckpointStmt.run({
      checkpointId: checkpoint.checkpointId,
      runId: checkpoint.runId,
      checkpointKind: checkpoint.checkpointKind,
      stateJson: JSON.stringify(checkpoint.state),
      createdAt: checkpoint.createdAt,
    });
    return checkpoint;
  }

  public listCheckpoints(runId: string, limit = 200): DurableCheckpointRecord[] {
    const safeLimit = Math.max(1, Math.min(2_000, Math.floor(limit)));
    const rows = toDurableCheckpointRows(this.listCheckpointsStmt.all(runId, safeLimit));
    return rows.map((row) => ({
      checkpointId: row.checkpoint_id,
      runId: row.run_id,
      checkpointKind: row.checkpoint_kind,
      state: loadAndSanitize(
        row.state_json,
        {
          store: "durable_checkpoint.state",
          rowId: row.checkpoint_id,
          parse: parseJsonObject,
          onQuarantine: this.options.quarantine ? (e) => this.options.quarantine!.record(e) : undefined,
          log: this.options.logger,
        },
        {},
      ) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  public upsertRetry(input: {
    retryId?: string;
    runId: string;
    attemptNo: number;
    reason: string;
    nextRetryAt?: string;
    createdAt?: string;
  }): DurableRetryRecord {
    const record: DurableRetryRecord = {
      retryId: input.retryId ?? randomUUID(),
      runId: input.runId,
      attemptNo: Math.max(1, Math.floor(input.attemptNo)),
      reason: input.reason.trim(),
      nextRetryAt: input.nextRetryAt,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    if (!record.reason) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "reason" });
    }
    this.upsertRetryStmt.run({
      retryId: record.retryId,
      runId: record.runId,
      attemptNo: record.attemptNo,
      reason: record.reason,
      nextRetryAt: record.nextRetryAt ?? null,
      createdAt: record.createdAt,
    });
    const rows = this.listRetries(record.runId);
    return rows[rows.length - 1] ?? record;
  }

  public listRetries(runId: string, limit = 100): DurableRetryRecord[] {
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = toDurableRetryRows(this.listRetriesStmt.all(runId, safeLimit));
    return rows.map((row) => ({
      retryId: row.retry_id,
      runId: row.run_id,
      attemptNo: row.attempt_no,
      reason: row.reason,
      nextRetryAt: row.next_retry_at ?? undefined,
      createdAt: row.created_at,
    }));
  }

  public upsertDeadLetter(input: {
    deadLetterId?: string;
    runId: string;
    reason: string;
    payload?: Record<string, unknown>;
    createdAt?: string;
    resolvedAt?: string;
    resolutionNote?: string;
  }): DurableDeadLetterRecord {
    const record: DurableDeadLetterRecord = {
      deadLetterId: input.deadLetterId ?? randomUUID(),
      runId: input.runId,
      reason: input.reason.trim(),
      payload: normalizeObject(input.payload),
      createdAt: input.createdAt ?? new Date().toISOString(),
      resolvedAt: input.resolvedAt,
      resolutionNote: input.resolutionNote?.trim() || undefined,
    };
    if (!record.reason) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "reason" });
    }
    this.upsertDeadLetterStmt.run({
      deadLetterId: record.deadLetterId,
      runId: record.runId,
      reason: record.reason,
      payloadJson: JSON.stringify(record.payload),
      createdAt: record.createdAt,
      resolvedAt: record.resolvedAt ?? null,
      resolutionNote: record.resolutionNote ?? null,
    });
    const updated = this.getDeadLetterByRun(record.runId);
    return updated ?? record;
  }

  public listDeadLetters(limit = 100): DurableDeadLetterRecord[] {
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = toDurableDeadLetterRows(this.listDeadLettersStmt.all(safeLimit));
    return rows.map((row) => ({
      deadLetterId: row.dead_letter_id,
      runId: row.run_id,
      reason: row.reason,
      payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
      createdAt: row.created_at,
      resolvedAt: row.resolved_at ?? undefined,
      resolutionNote: row.resolution_note ?? undefined,
    }));
  }

  public getDeadLetterByRun(runId: string): DurableDeadLetterRecord | undefined {
    const row = toDurableDeadLetterRow(this.getDeadLetterByRunStmt.get(runId));
    if (!row) {
      return undefined;
    }
    return mapDeadLetterRow(row);
  }

  public getDeadLetterById(deadLetterId: string): DurableDeadLetterRecord {
    const row = toDurableDeadLetterRow(this.getDeadLetterByIdStmt.get(deadLetterId));
    if (!row) {
      throw new NotFoundError({ entity: "Durable dead letter", id: deadLetterId });
    }
    return mapDeadLetterRow(row);
  }

  public resolveDeadLetter(
    deadLetterId: string,
    input: {
      resolvedAt?: string;
      resolutionNote?: string;
    } = {},
  ): DurableDeadLetterRecord {
    const existing = this.getDeadLetterById(deadLetterId);
    const result = this.resolveDeadLetterStmt.run({
      deadLetterId,
      resolvedAt: input.resolvedAt ?? new Date().toISOString(),
      resolutionNote: input.resolutionNote?.trim() || null,
    });
    if (Number(result.changes ?? 0) !== 1) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `Durable dead letter ${deadLetterId} is already resolved`,
      });
    }
    return this.getDeadLetterById(existing.deadLetterId);
  }

  public pruneCheckpoints(input: { keepPerRun: number; diskBudgetBytes: number }): PruneCheckpointsResult {
    const keepPerRun = Math.max(1, Math.floor(input.keepPerRun));
    const diskBudgetBytes = Math.max(0, Math.floor(input.diskBudgetBytes));

    const orphanRows = this.db
      .prepare(
        `
        SELECT cp.checkpoint_id AS checkpointId
        FROM durable_checkpoints cp
        LEFT JOIN durable_runs r ON r.run_id = cp.run_id
        WHERE r.run_id IS NULL
      `,
      )
      .all() as Array<{ checkpointId: string }>;

    const deleteByIdStmt = this.db.prepare("DELETE FROM durable_checkpoints WHERE checkpoint_id = ?");
    let prunedOrphans = 0;
    for (const row of orphanRows) {
      const result = deleteByIdStmt.run(row.checkpointId);
      prunedOrphans += Number(result.changes ?? 0);
    }

    const terminalCheckpoints = this.db
      .prepare(
        `
        SELECT cp.checkpoint_id AS checkpointId,
               cp.run_id AS runId,
               cp.state_json AS stateJson,
               cp.created_at AS createdAt
        FROM durable_checkpoints cp
        INNER JOIN durable_runs r ON r.run_id = cp.run_id
        WHERE r.status IN ('completed', 'failed', 'cancelled', 'dead_lettered')
        ORDER BY cp.run_id ASC, cp.created_at ASC, cp.checkpoint_id ASC
      `,
      )
      .all() as Array<{ checkpointId: string; runId: string; stateJson: string; createdAt: string }>;

    const perRunBuckets = new Map<
      string,
      Array<{ checkpointId: string; runId: string; stateJson: string; createdAt: string }>
    >();
    for (const row of terminalCheckpoints) {
      const bucket = perRunBuckets.get(row.runId) ?? [];
      bucket.push(row);
      perRunBuckets.set(row.runId, bucket);
    }

    let prunedAged = 0;
    const survivingTerminal: Array<{ checkpointId: string; runId: string; stateJson: string; createdAt: string }> = [];
    for (const bucket of perRunBuckets.values()) {
      const overflow = Math.max(0, bucket.length - keepPerRun);
      for (const victim of bucket.slice(0, overflow)) {
        const result = deleteByIdStmt.run(victim.checkpointId);
        prunedAged += Number(result.changes ?? 0);
      }
      for (const survivor of bucket.slice(overflow)) {
        survivingTerminal.push(survivor);
      }
    }

    let runningBytes = this.measureCheckpointBytes();
    if (runningBytes > diskBudgetBytes) {
      survivingTerminal.sort((l, r) =>
        l.createdAt === r.createdAt
          ? l.checkpointId.localeCompare(r.checkpointId)
          : l.createdAt.localeCompare(r.createdAt),
      );
      for (const victim of survivingTerminal) {
        if (runningBytes <= diskBudgetBytes) {
          break;
        }
        const victimBytes = byteLength(victim.stateJson);
        const result = deleteByIdStmt.run(victim.checkpointId);
        const changes = Number(result.changes ?? 0);
        if (changes > 0) {
          prunedAged += changes;
          runningBytes -= victimBytes;
        }
      }
    }

    return {
      prunedOrphans,
      prunedAged,
      finalBytes: this.measureCheckpointBytes(),
      diskBudgetBytes,
    };
  }

  private measureCheckpointBytes(): number {
    const byteCountSql =
      this.db.dialect === "postgres"
        ? "SELECT COALESCE(SUM(OCTET_LENGTH(state_json)), 0) AS bytes FROM durable_checkpoints"
        : "SELECT COALESCE(SUM(LENGTH(CAST(state_json AS BLOB))), 0) AS bytes FROM durable_checkpoints";
    const row = this.db.prepare(byteCountSql).get() as { bytes: number | bigint } | undefined;
    return Number(row?.bytes ?? 0);
  }

  private mapRunRow(row: DurableRunRow): DurableRunRecord {
    return {
      runId: row.run_id,
      workflowKey: row.workflow_key,
      status: row.status,
      attemptCount: Number(row.attempt_count ?? 0),
      maxAttempts: Number(row.max_attempts ?? 0),
      version: Number(row.version ?? 1),
      payload: loadAndSanitize(
        row.payload_json,
        {
          store: "durable_run.payload",
          rowId: row.run_id,
          parse: parseJsonObject,
          onQuarantine: this.options.quarantine ? (e) => this.options.quarantine!.record(e) : undefined,
          log: this.options.logger,
        },
        {},
      ) as Record<string, unknown>,
      metadata: row.metadata_json
        ? (loadAndSanitize(
            row.metadata_json,
            {
              store: "durable_run.metadata",
              rowId: row.run_id,
              parse: parseJsonObject,
              onQuarantine: this.options.quarantine ? (e) => this.options.quarantine!.record(e) : undefined,
              log: this.options.logger,
            },
            undefined,
          ) as Record<string, unknown> | undefined)
        : undefined,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
      lastError: row.last_error ?? undefined,
      leaseOwnerId: row.lease_owner_id ?? undefined,
      leaseExpiresAt: row.lease_expires_at ?? undefined,
      leaseHeartbeatAt: row.lease_heartbeat_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private buildNextRun(
    current: DurableRunRecord,
    input: {
      runId: string;
      status: DurableRunStatus;
      attemptCount?: number;
      maxAttempts?: number;
      payload?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      startedAt?: string;
      finishedAt?: string;
      clearFinishedAt?: boolean;
      lastError?: string;
      clearLastError?: boolean;
      leaseOwnerId?: string;
      leaseExpiresAt?: string;
      leaseHeartbeatAt?: string;
      clearLease?: boolean;
      updatedAt?: string;
    },
  ): DurableRunRecord {
    const clearLease = input.clearLease ?? false;
    return {
      ...current,
      status: input.status,
      attemptCount:
        input.attemptCount !== undefined ? Math.max(0, Math.floor(input.attemptCount)) : current.attemptCount,
      maxAttempts: input.maxAttempts !== undefined ? Math.max(1, Math.floor(input.maxAttempts)) : current.maxAttempts,
      payload: input.payload !== undefined ? normalizeObject(input.payload) : current.payload,
      metadata: input.metadata !== undefined ? normalizeOptionalObject(input.metadata) : current.metadata,
      startedAt: input.startedAt !== undefined ? input.startedAt : current.startedAt,
      finishedAt: input.clearFinishedAt
        ? undefined
        : input.finishedAt !== undefined
          ? input.finishedAt
          : current.finishedAt,
      lastError: input.clearLastError
        ? undefined
        : input.lastError !== undefined
          ? input.lastError?.trim() || undefined
          : current.lastError,
      leaseOwnerId: clearLease
        ? undefined
        : input.leaseOwnerId !== undefined
          ? input.leaseOwnerId
          : current.leaseOwnerId,
      leaseExpiresAt: clearLease
        ? undefined
        : input.leaseExpiresAt !== undefined
          ? input.leaseExpiresAt
          : current.leaseExpiresAt,
      leaseHeartbeatAt: clearLease
        ? undefined
        : input.leaseHeartbeatAt !== undefined
          ? input.leaseHeartbeatAt
          : current.leaseHeartbeatAt,
      version: current.version + 1,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    };
  }
}

function mapDeadLetterRow(row: DurableDeadLetterRow): DurableDeadLetterRecord {
  return {
    deadLetterId: row.dead_letter_id,
    runId: row.run_id,
    reason: row.reason,
    payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolutionNote: row.resolution_note ?? undefined,
  };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function normalizeObject(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeOptionalObject(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value;
}
