import type { CronJobRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { loadAndSanitize, type QuarantineEntry } from "./load-and-sanitize.js";
import { parseJsonObject } from "./state-validators.js";

export interface CronJobRepositoryOptions {
  quarantine?: { record: (entry: QuarantineEntry) => unknown };
  logger?: { warn: (data: unknown, msg: string) => void };
}

interface CronJobRow {
  job_id: string;
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

export class CronJobRepository {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly listByCitadelStmt;
  private readonly deleteStmt;

  public constructor(
    private readonly db: DatabaseClient,
    private readonly options: CronJobRepositoryOptions = {},
  ) {
    this.upsertStmt = db.prepare(`
      INSERT INTO cron_jobs (
        job_id, name, action, action_config_json, description, schedule, enabled, end_at, last_run_at, next_run_at, workdir, context_from, last_run_output, last_run_id, last_run_status, last_run_evidence_envelope_id, last_failure_at, last_failure_json, failure_count, backoff_until, updated_at
      ) VALUES (
        @jobId, @name, @action, @actionConfigJson, @description, @schedule, @enabled, @endAt, @lastRunAt, @nextRunAt, @workdir, @contextFrom, @lastRunOutput, @lastRunId, @lastRunStatus, @lastRunEvidenceEnvelopeId, @lastFailureAt, @lastFailureJson, @failureCount, @backoffUntil, @updatedAt
      )
      ON CONFLICT(job_id) DO UPDATE SET
        name = excluded.name,
        action = excluded.action,
        action_config_json = excluded.action_config_json,
        description = excluded.description,
        schedule = excluded.schedule,
        enabled = excluded.enabled,
        end_at = excluded.end_at,
        last_run_at = excluded.last_run_at,
        next_run_at = excluded.next_run_at,
        workdir = excluded.workdir,
        context_from = excluded.context_from,
        last_run_output = excluded.last_run_output,
        last_run_id = excluded.last_run_id,
        last_run_status = excluded.last_run_status,
        last_run_evidence_envelope_id = excluded.last_run_evidence_envelope_id,
        last_failure_at = excluded.last_failure_at,
        last_failure_json = excluded.last_failure_json,
        failure_count = excluded.failure_count,
        backoff_until = excluded.backoff_until,
        updated_at = excluded.updated_at
    `);

    this.getStmt = db.prepare("SELECT * FROM cron_jobs WHERE job_id = @jobId");
    this.listStmt = db.prepare("SELECT * FROM cron_jobs ORDER BY job_id ASC");
    this.listByCitadelStmt = db.prepare(
      "SELECT * FROM cron_jobs WHERE citadel_id = @citadelId OR citadel_id IS NULL ORDER BY job_id ASC",
    );
    this.deleteStmt = db.prepare("DELETE FROM cron_jobs WHERE job_id = @jobId");
  }

  public upsert(job: CronJobRecord, now = new Date().toISOString()): CronJobRecord {
    this.upsertStmt.run({
      jobId: job.jobId,
      name: job.name,
      action: job.action,
      actionConfigJson: job.actionConfig ? JSON.stringify(job.actionConfig) : null,
      description: job.description ?? null,
      schedule: job.schedule,
      enabled: job.enabled ? 1 : 0,
      endAt: job.endAt ?? null,
      lastRunAt: job.lastRunAt ?? null,
      nextRunAt: job.nextRunAt ?? null,
      workdir: job.workdir ?? null,
      contextFrom: job.contextFrom ?? null,
      lastRunOutput: job.lastRunOutput ?? null,
      lastRunId: job.lastRunId ?? null,
      lastRunStatus: job.lastRunStatus ?? null,
      lastRunEvidenceEnvelopeId: job.lastRunEvidenceEnvelopeId ?? null,
      lastFailureAt: job.lastFailureAt ?? null,
      lastFailureJson: job.lastFailure ? JSON.stringify(job.lastFailure) : null,
      failureCount: job.failureCount ?? null,
      backoffUntil: job.backoffUntil ?? null,
      updatedAt: now,
    });

    return {
      ...job,
      workdir: job.workdir ?? undefined,
      contextFrom: job.contextFrom ?? undefined,
      lastRunOutput: job.lastRunOutput ?? undefined,
      lastRunId: job.lastRunId ?? undefined,
      lastRunStatus: job.lastRunStatus ?? undefined,
      lastRunEvidenceEnvelopeId: job.lastRunEvidenceEnvelopeId ?? undefined,
      lastFailureAt: job.lastFailureAt ?? undefined,
      ...(job.lastFailure ? { lastFailure: job.lastFailure } : {}),
      failureCount: job.failureCount ?? undefined,
      backoffUntil: job.backoffUntil ?? undefined,
      updatedAt: now,
    };
  }

  public upsertIfChanged(job: CronJobRecord, now = new Date().toISOString()): CronJobRecord {
    const existing = this.get(job.jobId);
    if (existing && cronJobsMatch(existing, job)) {
      return existing;
    }
    return this.upsert(job, now);
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
    const result = this.deleteStmt.run({ jobId });
    const changes = Number((result as { changes?: number }).changes ?? 0);
    return changes > 0;
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
    if (key !== rightKeys[i]) {
      return false;
    }
    if (!deepEqualCanonical(leftRecord[key], rightRecord[key])) {
      return false;
    }
  }

  return true;
}

function cronJobsMatch(existing: CronJobRecord, next: CronJobRecord): boolean {
  return (
    existing.jobId === next.jobId &&
    existing.name === next.name &&
    existing.action === next.action &&
    deepEqualCanonical(existing.actionConfig ?? {}, next.actionConfig ?? {}) &&
    existing.description === next.description &&
    existing.schedule === next.schedule &&
    existing.enabled === next.enabled &&
    existing.endAt === next.endAt &&
    existing.lastRunAt === next.lastRunAt &&
    existing.nextRunAt === next.nextRunAt &&
    existing.workdir === next.workdir &&
    existing.contextFrom === next.contextFrom &&
    existing.lastRunOutput === next.lastRunOutput &&
    existing.lastRunId === next.lastRunId &&
    existing.lastRunStatus === next.lastRunStatus &&
    existing.lastRunEvidenceEnvelopeId === next.lastRunEvidenceEnvelopeId &&
    existing.lastFailureAt === next.lastFailureAt &&
    deepEqualCanonical(existing.lastFailure ?? {}, next.lastFailure ?? {}) &&
    existing.failureCount === next.failureCount &&
    existing.backoffUntil === next.backoffUntil
  );
}

function assertCronJobRows(rows: unknown[]): asserts rows is CronJobRow[] {
  for (const row of rows) {
    assertCronJobRow(row);
  }
}

function assertCronJobRow(row: unknown): asserts row is CronJobRow {
  if (!isCronJobRow(row)) {
    throw new TypeError("cron_jobs query returned an unexpected row shape");
  }
}

function isCronJobRow(row: unknown): row is CronJobRow {
  if (!isRecord(row)) {
    return false;
  }
  return (
    typeof row.job_id === "string" &&
    typeof row.name === "string" &&
    typeof row.action === "string" &&
    (typeof row.action_config_json === "string" || row.action_config_json === null) &&
    (typeof row.description === "string" || row.description === null) &&
    typeof row.schedule === "string" &&
    typeof row.enabled === "number" &&
    (typeof row.end_at === "string" || row.end_at === null) &&
    (typeof row.last_run_at === "string" || row.last_run_at === null) &&
    (typeof row.next_run_at === "string" || row.next_run_at === null) &&
    (typeof row.workdir === "string" || row.workdir === null) &&
    (typeof row.context_from === "string" || row.context_from === null) &&
    (typeof row.last_run_output === "string" || row.last_run_output === null) &&
    (typeof row.last_run_id === "string" || row.last_run_id === null) &&
    (typeof row.last_run_status === "string" || row.last_run_status === null) &&
    (typeof row.last_run_evidence_envelope_id === "string" || row.last_run_evidence_envelope_id === null) &&
    (typeof row.last_failure_at === "string" || row.last_failure_at === null) &&
    (typeof row.last_failure_json === "string" || row.last_failure_json === null) &&
    (typeof row.failure_count === "number" || row.failure_count === null) &&
    (typeof row.backoff_until === "string" || row.backoff_until === null) &&
    typeof row.updated_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
