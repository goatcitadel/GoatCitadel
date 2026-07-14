import type { CronJobRecord } from "@goatcitadel/contracts";
import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { loadAndSanitize, type QuarantineEntry } from "./load-and-sanitize.js";
import { parseJsonObject } from "./state-validators.js";

export interface CronJobRepositoryOptions {
  quarantine?: { record: (entry: QuarantineEntry) => unknown };
  logger?: { warn: (data: unknown, msg: string) => void };
}

interface CronJobRow {
  job_id: string;
  revision: number;
  execution_generation: number;
  active_run_id: string | null;
  name: string;
  action: string;
  action_config_json: string | null;
  description: string | null;
  schedule: string;
  enabled: number;
  end_at: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  workdir: string | null;
  context_from: string | null;
  last_run_output: string | null;
  last_run_id: string | null;
  last_run_status: string | null;
  last_run_evidence_envelope_id: string | null;
  last_failure_at: string | null;
  last_failure_json: string | null;
  failure_count: number | null;
  backoff_until: string | null;
  updated_at: string;
}

export type CronJobSpecInput = Pick<
  CronJobRecord,
  | "jobId"
  | "name"
  | "action"
  | "actionConfig"
  | "description"
  | "schedule"
  | "enabled"
  | "endAt"
  | "workdir"
  | "contextFrom"
>;

export interface CronJobSpecPatch {
  name?: string;
  action?: CronJobRecord["action"];
  actionConfig?: CronJobRecord["actionConfig"] | null;
  description?: string | null;
  schedule?: string;
  enabled?: boolean;
  endAt?: string | null;
  workdir?: string | null;
  contextFrom?: string | null;
}

export interface CronJobRuntimeTelemetryPatch {
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastRunOutput?: string | null;
  lastRunId?: string | null;
  lastRunStatus?: CronJobRecord["lastRunStatus"] | null;
  lastRunEvidenceEnvelopeId?: string | null;
  lastFailureAt?: string | null;
  lastFailure?: CronJobRecord["lastFailure"] | null;
  failureCount?: number | null;
  backoffUntil?: string | null;
}

export type CronJobUpsertInput = Omit<CronJobRecord, "revision"> & { revision?: number };

export class CronJobRepository {
  private readonly insertStmt;
  private readonly specFenceStmt;
  private readonly specUpdateStmt;
  private readonly telemetryMergeStmt;
  private readonly generationTelemetryMergeStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly listByCitadelStmt;
  private readonly deleteStmt;

  public constructor(
    private readonly db: DatabaseClient,
    private readonly options: CronJobRepositoryOptions = {},
  ) {
    this.insertStmt = db.prepare(`
      INSERT INTO cron_jobs (
        job_id, revision, name, action, action_config_json, description, schedule, enabled, end_at, last_run_at, next_run_at, workdir, context_from, last_run_output, last_run_id, last_run_status, last_run_evidence_envelope_id, last_failure_at, last_failure_json, failure_count, backoff_until, updated_at
      ) VALUES (
        @jobId, 1, @name, @action, @actionConfigJson, @description, @schedule, @enabled, @endAt, @lastRunAt, @nextRunAt, @workdir, @contextFrom, @lastRunOutput, @lastRunId, @lastRunStatus, @lastRunEvidenceEnvelopeId, @lastFailureAt, @lastFailureJson, @failureCount, @backoffUntil, @updatedAt
      )
      ON CONFLICT(job_id) DO NOTHING
    `);
    this.specFenceStmt = db.prepare(`
      UPDATE cron_jobs
      SET revision = revision
      WHERE job_id = @jobId
        AND revision = @expectedRevision
    `);
    this.specUpdateStmt = db.prepare(`
      UPDATE cron_jobs
      SET revision = revision + 1,
          name = @name,
          action = @action,
          action_config_json = @actionConfigJson,
          description = @description,
          schedule = @schedule,
          enabled = @enabled,
          end_at = @endAt,
          workdir = @workdir,
          context_from = @contextFrom,
          updated_at = @updatedAt
      WHERE job_id = @jobId
        AND revision = @expectedRevision
    `);
    this.telemetryMergeStmt = db.prepare(`
      UPDATE cron_jobs
      SET last_run_at = CASE WHEN @writeLastRunAt = 1 THEN @lastRunAt ELSE last_run_at END,
          next_run_at = CASE WHEN @writeNextRunAt = 1 THEN @nextRunAt ELSE next_run_at END,
          last_run_output = CASE WHEN @writeLastRunOutput = 1 THEN @lastRunOutput ELSE last_run_output END,
          last_run_id = CASE WHEN @writeLastRunId = 1 THEN @lastRunId ELSE last_run_id END,
          last_run_status = CASE WHEN @writeLastRunStatus = 1 THEN @lastRunStatus ELSE last_run_status END,
          last_run_evidence_envelope_id = CASE
            WHEN @writeLastRunEvidenceEnvelopeId = 1 THEN @lastRunEvidenceEnvelopeId
            ELSE last_run_evidence_envelope_id
          END,
          last_failure_at = CASE WHEN @writeLastFailureAt = 1 THEN @lastFailureAt ELSE last_failure_at END,
          last_failure_json = CASE WHEN @writeLastFailure = 1 THEN @lastFailureJson ELSE last_failure_json END,
          failure_count = CASE WHEN @writeFailureCount = 1 THEN @failureCount ELSE failure_count END,
          backoff_until = CASE WHEN @writeBackoffUntil = 1 THEN @backoffUntil ELSE backoff_until END,
          updated_at = @updatedAt
      WHERE job_id = @jobId
    `);
    this.generationTelemetryMergeStmt = db.prepare(`
      UPDATE cron_jobs
      SET last_run_at = CASE WHEN @writeLastRunAt = 1 THEN @lastRunAt ELSE last_run_at END,
          next_run_at = CASE WHEN @writeNextRunAt = 1 THEN @nextRunAt ELSE next_run_at END,
          last_run_output = CASE WHEN @writeLastRunOutput = 1 THEN @lastRunOutput ELSE last_run_output END,
          last_run_id = CASE WHEN @writeLastRunId = 1 THEN @lastRunId ELSE last_run_id END,
          last_run_status = CASE WHEN @writeLastRunStatus = 1 THEN @lastRunStatus ELSE last_run_status END,
          last_run_evidence_envelope_id = CASE
            WHEN @writeLastRunEvidenceEnvelopeId = 1 THEN @lastRunEvidenceEnvelopeId
            ELSE last_run_evidence_envelope_id
          END,
          last_failure_at = CASE WHEN @writeLastFailureAt = 1 THEN @lastFailureAt ELSE last_failure_at END,
          last_failure_json = CASE WHEN @writeLastFailure = 1 THEN @lastFailureJson ELSE last_failure_json END,
          failure_count = CASE WHEN @writeFailureCount = 1 THEN @failureCount ELSE failure_count END,
          backoff_until = CASE WHEN @writeBackoffUntil = 1 THEN @backoffUntil ELSE backoff_until END,
          updated_at = @updatedAt
      WHERE job_id = @jobId
        AND execution_generation = @expectedExecutionGeneration
    `);

    this.getStmt = db.prepare("SELECT * FROM cron_jobs WHERE job_id = @jobId");
    this.listStmt = db.prepare("SELECT * FROM cron_jobs ORDER BY job_id ASC");
    this.listByCitadelStmt = db.prepare(
      "SELECT * FROM cron_jobs WHERE citadel_id = @citadelId OR citadel_id IS NULL ORDER BY job_id ASC",
    );
    this.deleteStmt = db.prepare("DELETE FROM cron_jobs WHERE job_id = @jobId");
  }

  public createSpec(job: CronJobSpecInput, now = new Date().toISOString()): CronJobRecord {
    const jobId = normalizeJobId(job.jobId);
    return this.db.transaction("immediate", () => {
      const inserted = this.insertStmt.run(toInsertParams(projectCronJobSpec({ ...job, jobId }), now));
      if (inserted.changes === 0) {
        this.throwWriteConflict(jobId, 0);
      }
      return this.require(jobId);
    });
  }

  public updateSpecWithRevision(
    jobId: string,
    patch: CronJobSpecPatch,
    expectedRevision: number,
    now = new Date().toISOString(),
  ): CronJobRecord {
    const normalizedJobId = normalizeJobId(jobId);
    validateExpectedRevision(expectedRevision);
    return this.db.transaction("immediate", () => {
      this.fenceSpec(normalizedJobId, expectedRevision);
      const current = this.require(normalizedJobId);
      const next = applySpecPatch(current, patch);
      if (cronJobSpecsMatch(current, next)) {
        return current;
      }
      const updated = this.specUpdateStmt.run({
        ...toSpecParams(next),
        jobId: normalizedJobId,
        expectedRevision,
        updatedAt: now,
      });
      if (updated.changes === 0) {
        this.throwWriteConflict(normalizedJobId, expectedRevision);
      }
      return this.require(normalizedJobId);
    });
  }

  public deleteWithRevision(jobId: string, expectedRevision: number): boolean {
    const normalizedJobId = normalizeJobId(jobId);
    validateExpectedRevision(expectedRevision);
    return this.db.transaction("immediate", () => {
      this.fenceSpec(normalizedJobId, expectedRevision);
      return Number(this.deleteStmt.run({ jobId: normalizedJobId }).changes ?? 0) > 0;
    });
  }

  public mergeRuntimeTelemetry(
    jobId: string,
    patch: CronJobRuntimeTelemetryPatch,
    now = new Date().toISOString(),
  ): CronJobRecord {
    const normalizedJobId = normalizeJobId(jobId);
    return this.db.transaction("immediate", () => {
      const current = this.get(normalizedJobId);
      if (!current) {
        throw new NotFoundError({ entity: "Cron job", id: normalizedJobId });
      }
      if (!hasRuntimeTelemetryFields(patch)) {
        return current;
      }
      this.telemetryMergeStmt.run(toTelemetryParams(normalizedJobId, patch, now));
      return this.require(normalizedJobId);
    });
  }

  /**
   * Merge compatibility telemetry only while the caller still owns the exact
   * cron execution generation. This prevents a late terminal write from an
   * older run from overwriting telemetry for a newly admitted occurrence.
   */
  public mergeRuntimeTelemetryForExecutionGeneration(
    jobId: string,
    expectedExecutionGeneration: number,
    patch: CronJobRuntimeTelemetryPatch,
    now = new Date().toISOString(),
  ): CronJobRecord | undefined {
    const normalizedJobId = normalizeJobId(jobId);
    const normalizedGeneration = normalizeExecutionGeneration(expectedExecutionGeneration);
    return this.db.transaction("immediate", () => {
      const current = this.get(normalizedJobId);
      if (!current) {
        throw new NotFoundError({ entity: "Cron job", id: normalizedJobId });
      }
      if (current.executionGeneration !== normalizedGeneration) {
        return undefined;
      }
      if (!hasRuntimeTelemetryFields(patch)) {
        return current;
      }
      const merged = this.generationTelemetryMergeStmt.run({
        ...toTelemetryParams(normalizedJobId, patch, now),
        expectedExecutionGeneration: normalizedGeneration,
      });
      return merged.changes > 0 ? this.require(normalizedJobId) : undefined;
    });
  }

  /**
   * Startup/built-in reconciliation owns only the job specification. Existing
   * runtime telemetry is retained and revision advances only for a real spec change.
   */
  public reconcileSpec(job: CronJobUpsertInput, now = new Date().toISOString()): CronJobRecord {
    const jobId = normalizeJobId(job.jobId);
    return this.db.transaction("immediate", () => {
      const current = this.get(jobId);
      if (!current) {
        const inserted = this.insertStmt.run(toInsertParams({ ...job, jobId }, now));
        if (inserted.changes === 0) {
          this.throwWriteConflict(jobId, 0);
        }
        return this.require(jobId);
      }
      return this.updateSpecWithRevision(jobId, toFullSpecPatch(job), current.revision, now);
    });
  }

  /** Compatibility API for operator/service callers while routes adopt explicit revisions. */
  public upsert(job: CronJobUpsertInput, now = new Date().toISOString()): CronJobRecord {
    const jobId = normalizeJobId(job.jobId);
    return this.db.transaction("immediate", () => {
      const current = this.get(jobId);
      let saved: CronJobRecord;
      if (!current) {
        const inserted = this.insertStmt.run(toInsertParams({ ...job, jobId }, now));
        if (inserted.changes === 0) {
          this.throwWriteConflict(jobId, 0);
        }
        saved = this.require(jobId);
      } else {
        saved = this.updateSpecWithRevision(jobId, toFullSpecPatch(job), current.revision, now);
        const telemetry = telemetryPatchFromRecord(job);
        if (hasRuntimeTelemetryFields(telemetry)) {
          saved = this.mergeRuntimeTelemetry(jobId, telemetry, now);
        }
      }
      return saved;
    });
  }

  public upsertIfChanged(job: CronJobUpsertInput, now = new Date().toISOString()): CronJobRecord {
    return this.reconcileSpec(job, now);
  }

  public get(jobId: string): CronJobRecord | undefined {
    const row = this.getStmt.get({ jobId });
    if (!row) {
      return undefined;
    }
    assertCronJobRow(row);
    return this.mapRow(row);
  }

  public list(): CronJobRecord[] {
    const rows = this.listStmt.all();
    assertCronJobRows(rows);
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * List cron jobs visible to a Citadel: jobs scoped to that Citadel plus global
   * (unscoped) jobs.
   * TODO: Enforce Watchtower access control once a real citadel scope is threaded
   * through scheduling.
   */
  public listByCitadel(citadelId: string): CronJobRecord[] {
    const rows = this.listByCitadelStmt.all({ citadelId });
    assertCronJobRows(rows);
    return rows.map((row) => this.mapRow(row));
  }

  public delete(jobId: string): boolean {
    const existing = this.get(jobId);
    return existing ? this.deleteWithRevision(jobId, existing.revision) : false;
  }

  private require(jobId: string): CronJobRecord {
    const record = this.get(jobId);
    if (!record) {
      throw new NotFoundError({ entity: "Cron job", id: jobId });
    }
    return record;
  }

  private fenceSpec(jobId: string, expectedRevision: number): void {
    const fenced = this.specFenceStmt.run({ jobId, expectedRevision });
    if (fenced.changes === 0) {
      this.throwWriteConflict(jobId, expectedRevision);
    }
  }

  private throwWriteConflict(jobId: string, expectedRevision: number): never {
    const current = this.get(jobId);
    if (!current) {
      throw new NotFoundError({ entity: "Cron job", id: jobId });
    }
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `cron_job ${jobId} changed since revision ${expectedRevision}`,
      details: {
        resourceKind: "cron_job",
        resourceId: jobId,
        expectedRevision,
        currentRevision: current.revision,
      },
    });
  }

  private mapRow(row: CronJobRow): CronJobRecord {
    const actionConfig = loadAndSanitize(
      row.action_config_json,
      {
        store: "cron_job.action_config",
        rowId: row.job_id,
        parse: parseJsonObject,
        onQuarantine: this.options.quarantine ? (e) => this.options.quarantine!.record(e) : undefined,
        log: this.options.logger,
      },
      undefined,
    ) as CronJobRecord["actionConfig"] | undefined;
    const lastFailure = loadAndSanitize(
      row.last_failure_json,
      {
        store: "cron_job.last_failure",
        rowId: row.job_id,
        parse: parseCronLastFailure,
        onQuarantine: this.options.quarantine ? (e) => this.options.quarantine!.record(e) : undefined,
        log: this.options.logger,
      },
      undefined,
    );
    return {
      jobId: row.job_id,
      revision: normalizeRevision(row.revision),
      executionGeneration: normalizeExecutionGeneration(row.execution_generation),
      activeRunId: row.active_run_id ?? undefined,
      name: row.name,
      action: row.action as CronJobRecord["action"],
      ...(actionConfig ? { actionConfig } : {}),
      description: row.description ?? undefined,
      schedule: row.schedule,
      enabled: Boolean(row.enabled),
      endAt: row.end_at ?? undefined,
      lastRunAt: row.last_run_at ?? undefined,
      nextRunAt: row.next_run_at ?? undefined,
      workdir: row.workdir ?? undefined,
      contextFrom: row.context_from ?? undefined,
      lastRunOutput: row.last_run_output ?? undefined,
      lastRunId: row.last_run_id ?? undefined,
      lastRunStatus: row.last_run_status === "ok" || row.last_run_status === "failed" ? row.last_run_status : undefined,
      lastRunEvidenceEnvelopeId: row.last_run_evidence_envelope_id ?? undefined,
      lastFailureAt: row.last_failure_at ?? undefined,
      ...(lastFailure ? { lastFailure } : {}),
      failureCount: row.failure_count ?? undefined,
      backoffUntil: row.backoff_until ?? undefined,
      updatedAt: row.updated_at,
    };
  }
}

function parseCronLastFailure(value: unknown): {
  success: boolean;
  data?: CronJobRecord["lastFailure"];
  error?: { message: string };
} {
  if (!isRecord(value) || typeof value.message !== "string") {
    return { success: false, error: { message: "expected cron failure object with message" } };
  }
  if (value.code !== undefined && typeof value.code !== "string") {
    return { success: false, error: { message: "code: expected string" } };
  }
  return {
    success: true,
    data: {
      message: value.message,
      code: value.code,
    },
  };
}

function normalizeJobId(jobId: string): string {
  const normalized = jobId.trim();
  if (!normalized) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "jobId" });
  }
  return normalized;
}

function validateExpectedRevision(expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new ValidationError({ field: "expectedRevision" });
  }
}

function normalizeRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`cron_jobs revision must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function normalizeExecutionGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`cron_jobs execution_generation must be a non-negative integer, got ${String(value)}`);
  }
  return value;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function applySpecPatch(current: CronJobRecord, patch: CronJobSpecPatch): CronJobRecord {
  return {
    ...current,
    name: patch.name ?? current.name,
    action: patch.action ?? current.action,
    actionConfig: hasOwn(patch, "actionConfig") ? (patch.actionConfig ?? undefined) : current.actionConfig,
    description: hasOwn(patch, "description") ? (patch.description ?? undefined) : current.description,
    schedule: patch.schedule ?? current.schedule,
    enabled: patch.enabled ?? current.enabled,
    endAt: hasOwn(patch, "endAt") ? (patch.endAt ?? undefined) : current.endAt,
    workdir: hasOwn(patch, "workdir") ? (patch.workdir ?? undefined) : current.workdir,
    contextFrom: hasOwn(patch, "contextFrom") ? (patch.contextFrom ?? undefined) : current.contextFrom,
  };
}

function toFullSpecPatch(job: CronJobSpecInput): CronJobSpecPatch {
  return {
    name: job.name,
    action: job.action,
    actionConfig: job.actionConfig ?? null,
    description: job.description ?? null,
    schedule: job.schedule,
    enabled: job.enabled,
    endAt: job.endAt ?? null,
    workdir: job.workdir ?? null,
    contextFrom: job.contextFrom ?? null,
  };
}

function projectCronJobSpec(job: CronJobSpecInput): CronJobSpecInput {
  return {
    jobId: job.jobId,
    name: job.name,
    action: job.action,
    actionConfig: job.actionConfig,
    description: job.description,
    schedule: job.schedule,
    enabled: job.enabled,
    endAt: job.endAt,
    workdir: job.workdir,
    contextFrom: job.contextFrom,
  };
}

function toSpecParams(job: CronJobSpecInput): Record<string, unknown> {
  return {
    name: job.name,
    action: job.action,
    actionConfigJson: job.actionConfig ? JSON.stringify(job.actionConfig) : null,
    description: job.description ?? null,
    schedule: job.schedule,
    enabled: job.enabled ? 1 : 0,
    endAt: job.endAt ?? null,
    workdir: job.workdir ?? null,
    contextFrom: job.contextFrom ?? null,
  };
}

function toInsertParams(
  job: CronJobSpecInput & Partial<CronJobRuntimeTelemetryPatch>,
  now: string,
): Record<string, unknown> {
  return {
    jobId: job.jobId,
    ...toSpecParams(job),
    lastRunAt: job.lastRunAt ?? null,
    nextRunAt: job.nextRunAt ?? null,
    lastRunOutput: job.lastRunOutput ?? null,
    lastRunId: job.lastRunId ?? null,
    lastRunStatus: job.lastRunStatus ?? null,
    lastRunEvidenceEnvelopeId: job.lastRunEvidenceEnvelopeId ?? null,
    lastFailureAt: job.lastFailureAt ?? null,
    lastFailureJson: job.lastFailure ? JSON.stringify(job.lastFailure) : null,
    failureCount: job.failureCount ?? null,
    backoffUntil: job.backoffUntil ?? null,
    updatedAt: now,
  };
}

const RUNTIME_TELEMETRY_FIELDS = [
  "lastRunAt",
  "nextRunAt",
  "lastRunOutput",
  "lastRunId",
  "lastRunStatus",
  "lastRunEvidenceEnvelopeId",
  "lastFailureAt",
  "lastFailure",
  "failureCount",
  "backoffUntil",
] as const satisfies ReadonlyArray<keyof CronJobRuntimeTelemetryPatch>;

function hasRuntimeTelemetryFields(patch: CronJobRuntimeTelemetryPatch): boolean {
  return RUNTIME_TELEMETRY_FIELDS.some((field) => hasOwn(patch, field));
}

function telemetryPatchFromRecord(job: CronJobUpsertInput): CronJobRuntimeTelemetryPatch {
  const patch: CronJobRuntimeTelemetryPatch = {};
  for (const field of RUNTIME_TELEMETRY_FIELDS) {
    if (hasOwn(job, field)) {
      const value = job[field];
      (patch as Record<string, unknown>)[field] = value ?? null;
    }
  }
  return patch;
}

function toTelemetryParams(jobId: string, patch: CronJobRuntimeTelemetryPatch, now: string): Record<string, unknown> {
  return {
    jobId,
    writeLastRunAt: hasOwn(patch, "lastRunAt") ? 1 : 0,
    lastRunAt: patch.lastRunAt ?? null,
    writeNextRunAt: hasOwn(patch, "nextRunAt") ? 1 : 0,
    nextRunAt: patch.nextRunAt ?? null,
    writeLastRunOutput: hasOwn(patch, "lastRunOutput") ? 1 : 0,
    lastRunOutput: patch.lastRunOutput ?? null,
    writeLastRunId: hasOwn(patch, "lastRunId") ? 1 : 0,
    lastRunId: patch.lastRunId ?? null,
    writeLastRunStatus: hasOwn(patch, "lastRunStatus") ? 1 : 0,
    lastRunStatus: patch.lastRunStatus ?? null,
    writeLastRunEvidenceEnvelopeId: hasOwn(patch, "lastRunEvidenceEnvelopeId") ? 1 : 0,
    lastRunEvidenceEnvelopeId: patch.lastRunEvidenceEnvelopeId ?? null,
    writeLastFailureAt: hasOwn(patch, "lastFailureAt") ? 1 : 0,
    lastFailureAt: patch.lastFailureAt ?? null,
    writeLastFailure: hasOwn(patch, "lastFailure") ? 1 : 0,
    lastFailureJson: patch.lastFailure ? JSON.stringify(patch.lastFailure) : null,
    writeFailureCount: hasOwn(patch, "failureCount") ? 1 : 0,
    failureCount: patch.failureCount ?? null,
    writeBackoffUntil: hasOwn(patch, "backoffUntil") ? 1 : 0,
    backoffUntil: patch.backoffUntil ?? null,
    updatedAt: now,
  };
}

function deepEqualCanonical(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (left === null || right === null) {
    return left === right;
  }

  if (typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let i = 0; i < left.length; i += 1) {
      if (!deepEqualCanonical(left[i], right[i])) {
        return false;
      }
    }
    return true;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (let i = 0; i < leftKeys.length; i += 1) {
    const key = leftKeys[i];
    if (key === undefined || key !== rightKeys[i]) {
      return false;
    }
    if (!deepEqualCanonical(leftRecord[key], rightRecord[key])) {
      return false;
    }
  }

  return true;
}

function cronJobSpecsMatch(existing: CronJobRecord, next: CronJobSpecInput): boolean {
  return (
    existing.jobId === next.jobId &&
    existing.name === next.name &&
    existing.action === next.action &&
    deepEqualCanonical(existing.actionConfig ?? {}, next.actionConfig ?? {}) &&
    existing.description === next.description &&
    existing.schedule === next.schedule &&
    existing.enabled === next.enabled &&
    existing.endAt === next.endAt &&
    existing.workdir === next.workdir &&
    existing.contextFrom === next.contextFrom
  );
}

function assertCronJobRows(rows: unknown[]): asserts rows is CronJobRow[] {
  for (const row of rows) {
    assertCronJobRow(row);
  }
}

const CRON_JOB_ROW_COLUMNS: ReadonlyArray<
  readonly [keyof CronJobRow & string, "string" | "string | null" | "number" | "number | null"]
> = [
  ["job_id", "string"],
  ["revision", "number"],
  ["execution_generation", "number"],
  ["active_run_id", "string | null"],
  ["name", "string"],
  ["action", "string"],
  ["action_config_json", "string | null"],
  ["description", "string | null"],
  ["schedule", "string"],
  ["enabled", "number"],
  ["end_at", "string | null"],
  ["last_run_at", "string | null"],
  ["next_run_at", "string | null"],
  ["workdir", "string | null"],
  ["context_from", "string | null"],
  ["last_run_output", "string | null"],
  ["last_run_id", "string | null"],
  ["last_run_status", "string | null"],
  ["last_run_evidence_envelope_id", "string | null"],
  ["last_failure_at", "string | null"],
  ["last_failure_json", "string | null"],
  ["failure_count", "number | null"],
  ["backoff_until", "string | null"],
  ["updated_at", "string"],
];

function cronJobRowColumnIssue(
  row: Record<string, unknown>,
  column: string,
  kind: "string" | "string | null" | "number" | "number | null",
): string | undefined {
  const value = row[column];
  const primitive = kind.startsWith("string") ? "string" : "number";
  const nullable = kind.endsWith("| null");
  if (typeof value === primitive || (nullable && value === null)) {
    return undefined;
  }
  return `${column}: expected ${kind}, got ${value === null ? "null" : typeof value}`;
}

function describeCronJobRowIssues(row: unknown): string {
  if (!isRecord(row)) {
    return `expected a row object, got ${row === null ? "null" : typeof row}`;
  }
  return CRON_JOB_ROW_COLUMNS.map(([column, kind]) => cronJobRowColumnIssue(row, column, kind))
    .filter((issue): issue is string => issue !== undefined)
    .join("; ");
}

function assertCronJobRow(row: unknown): asserts row is CronJobRow {
  if (!isCronJobRow(row)) {
    throw new TypeError(`cron_jobs query returned an unexpected row shape (${describeCronJobRowIssues(row)})`);
  }
}

function isCronJobRow(row: unknown): row is CronJobRow {
  return (
    isRecord(row) &&
    CRON_JOB_ROW_COLUMNS.every(([column, kind]) => cronJobRowColumnIssue(row, column, kind) === undefined)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
