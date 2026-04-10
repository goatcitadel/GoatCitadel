import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  DurableCheckpointRecord,
  DurableDeadLetterRecord,
  DurableRetryRecord,
  DurableRunRecord,
  DurableRunStatus,
} from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface DurableRunRow {
  run_id: string;
  workflow_key: string;
  status: DurableRunStatus;
  attempt_count: number;
  max_attempts: number;
  payload_json: string;
  metadata_json: string | null;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface DurableCheckpointRow {
  checkpoint_id: string;
  run_id: string;
  checkpoint_kind: DurableCheckpointRecord["checkpointKind"];
  state_json: string;
  created_at: string;
}

interface DurableRetryRow {
  retry_id: string;
  run_id: string;
  attempt_no: number;
  reason: string;
  next_retry_at: string | null;
  created_at: string;
}

interface DurableDeadLetterRow {
  dead_letter_id: string;
  run_id: string;
  reason: string;
  payload_json: string;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

export class DurableRunRepository {
  private readonly insertRunStmt;
  private readonly getRunStmt;
  private readonly updateRunStmt;
  private readonly listRunsStmt;
  private readonly listRunIdsByStatusStmt;
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

  public constructor(private readonly db: DatabaseClient) {
    this.insertRunStmt = db.prepare(`
      INSERT INTO durable_runs (
        run_id, workflow_key, status, attempt_count, max_attempts,
        payload_json, metadata_json, started_at, finished_at, last_error, created_at, updated_at
      ) VALUES (
        @runId, @workflowKey, @status, @attemptCount, @maxAttempts,
        @payloadJson, @metadataJson, @startedAt, @finishedAt, @lastError, @createdAt, @updatedAt
      )
    `);
    this.getRunStmt = db.prepare("SELECT * FROM durable_runs WHERE run_id = ?");
    this.updateRunStmt = db.prepare(`
      UPDATE durable_runs
      SET
        status = @status,
        attempt_count = @attemptCount,
        max_attempts = @maxAttempts,
        metadata_json = @metadataJson,
        started_at = @startedAt,
        finished_at = @finishedAt,
        last_error = @lastError,
        updated_at = @updatedAt
      WHERE run_id = @runId
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
    now?: string;
  }): DurableRunRecord {
    const now = input.now ?? new Date().toISOString();
    const run: DurableRunRecord = {
      runId: input.runId ?? randomUUID(),
      workflowKey: input.workflowKey.trim(),
      status: input.status ?? "queued",
      attemptCount: Math.max(0, Math.floor(input.attemptCount ?? 0)),
      maxAttempts: Math.max(1, Math.floor(input.maxAttempts ?? 3)),
      payload: normalizeObject(input.payload),
      metadata: normalizeOptionalObject(input.metadata),
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      lastError: input.lastError?.trim() || undefined,
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
    return mapRunRow(row);
  }

  public updateRun(input: {
    runId: string;
    status: DurableRunStatus;
    attemptCount?: number;
    maxAttempts?: number;
    metadata?: Record<string, unknown>;
    startedAt?: string;
    finishedAt?: string;
    lastError?: string;
    updatedAt?: string;
  }): DurableRunRecord {
    const current = this.getRun(input.runId);
    const next: DurableRunRecord = {
      ...current,
      status: input.status,
      attemptCount:
        input.attemptCount !== undefined ? Math.max(0, Math.floor(input.attemptCount)) : current.attemptCount,
      maxAttempts: input.maxAttempts !== undefined ? Math.max(1, Math.floor(input.maxAttempts)) : current.maxAttempts,
      metadata: input.metadata !== undefined ? normalizeOptionalObject(input.metadata) : current.metadata,
      startedAt: input.startedAt !== undefined ? input.startedAt : current.startedAt,
      finishedAt: input.finishedAt !== undefined ? input.finishedAt : current.finishedAt,
      lastError: input.lastError !== undefined ? input.lastError?.trim() || undefined : current.lastError,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    };
    this.updateRunStmt.run({
      runId: next.runId,
      status: next.status,
      attemptCount: next.attemptCount,
      maxAttempts: next.maxAttempts,
      metadataJson: next.metadata ? JSON.stringify(next.metadata) : null,
      startedAt: next.startedAt ?? null,
      finishedAt: next.finishedAt ?? null,
      lastError: next.lastError ?? null,
      updatedAt: next.updatedAt,
    });
    return this.getRun(next.runId);
  }

  public listRuns(limit = 25): DurableRunRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = toDurableRunRows(this.listRunsStmt.all(safeLimit));
    return rows.map(mapRunRow);
  }

  public listRunIdsByStatus(status: DurableRunStatus, limit = 500): string[] {
    const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
    const rows = this.listRunIdsByStatusStmt.all(status, safeLimit) as Array<{ run_id: string }>;
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
      state: safeJsonParse<Record<string, unknown>>(row.state_json, {}),
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
    this.resolveDeadLetterStmt.run({
      deadLetterId,
      resolvedAt: input.resolvedAt ?? new Date().toISOString(),
      resolutionNote: input.resolutionNote?.trim() || null,
    });
    return this.getDeadLetterById(existing.deadLetterId);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDurableRunRow(value: unknown): value is DurableRunRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.run_id === "string" &&
    typeof value.workflow_key === "string" &&
    typeof value.status === "string" &&
    typeof value.attempt_count === "number" &&
    typeof value.max_attempts === "number" &&
    typeof value.payload_json === "string" &&
    (typeof value.metadata_json === "string" || value.metadata_json === null) &&
    (typeof value.started_at === "string" || value.started_at === null) &&
    (typeof value.finished_at === "string" || value.finished_at === null) &&
    (typeof value.last_error === "string" || value.last_error === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isDurableCheckpointRow(value: unknown): value is DurableCheckpointRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.checkpoint_id === "string" &&
    typeof value.run_id === "string" &&
    typeof value.checkpoint_kind === "string" &&
    typeof value.state_json === "string" &&
    typeof value.created_at === "string"
  );
}

function isDurableRetryRow(value: unknown): value is DurableRetryRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.retry_id === "string" &&
    typeof value.run_id === "string" &&
    typeof value.attempt_no === "number" &&
    typeof value.reason === "string" &&
    (typeof value.next_retry_at === "string" || value.next_retry_at === null) &&
    typeof value.created_at === "string"
  );
}

function isDurableDeadLetterRow(value: unknown): value is DurableDeadLetterRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.dead_letter_id === "string" &&
    typeof value.run_id === "string" &&
    typeof value.reason === "string" &&
    typeof value.payload_json === "string" &&
    typeof value.created_at === "string" &&
    (typeof value.resolved_at === "string" || value.resolved_at === null) &&
    (typeof value.resolution_note === "string" || value.resolution_note === null)
  );
}

function toDurableRunRow(value: unknown): DurableRunRow | undefined {
  return isDurableRunRow(value) ? value : undefined;
}

function toDurableRunRows(value: unknown): DurableRunRow[] {
  return Array.isArray(value) ? value.filter(isDurableRunRow) : [];
}

function toDurableCheckpointRows(value: unknown): DurableCheckpointRow[] {
  return Array.isArray(value) ? value.filter(isDurableCheckpointRow) : [];
}

function toDurableRetryRows(value: unknown): DurableRetryRow[] {
  return Array.isArray(value) ? value.filter(isDurableRetryRow) : [];
}

function toDurableDeadLetterRow(value: unknown): DurableDeadLetterRow | undefined {
  return isDurableDeadLetterRow(value) ? value : undefined;
}

function toDurableDeadLetterRows(value: unknown): DurableDeadLetterRow[] {
  return Array.isArray(value) ? value.filter(isDurableDeadLetterRow) : [];
}

function toCountRow(value: unknown): { count?: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.count === "number" || value.count === undefined
    ? { count: value.count as number | undefined }
    : undefined;
}

function parseRecordJson(raw: string): Record<string, unknown> {
  const parsed = safeJsonParse<unknown>(raw, {});
  return isRecord(parsed) ? parsed : {};
}

function mapRunRow(row: DurableRunRow): DurableRunRecord {
  return {
    runId: row.run_id,
    workflowKey: row.workflow_key,
    status: row.status,
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? 0),
    payload: parseRecordJson(row.payload_json),
    metadata: row.metadata_json ? parseRecordJson(row.metadata_json) : undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
