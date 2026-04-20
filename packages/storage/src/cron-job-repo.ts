import type { CronJobRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

interface CronJobRow {
  job_id: string;
  name: string;
  action: string;
  description: string | null;
  schedule: string;
  enabled: number;
  end_at: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  updated_at: string;
}

export class CronJobRepository {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly deleteStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.upsertStmt = db.prepare(`
      INSERT INTO cron_jobs (
        job_id, name, action, description, schedule, enabled, end_at, last_run_at, next_run_at, updated_at
      ) VALUES (
        @jobId, @name, @action, @description, @schedule, @enabled, @endAt, @lastRunAt, @nextRunAt, @updatedAt
      )
      ON CONFLICT(job_id) DO UPDATE SET
        name = excluded.name,
        action = excluded.action,
        description = excluded.description,
        schedule = excluded.schedule,
        enabled = excluded.enabled,
        end_at = excluded.end_at,
        last_run_at = excluded.last_run_at,
        next_run_at = excluded.next_run_at,
        updated_at = excluded.updated_at
    `);

    this.getStmt = db.prepare("SELECT * FROM cron_jobs WHERE job_id = @jobId");
    this.listStmt = db.prepare("SELECT * FROM cron_jobs ORDER BY job_id ASC");
    this.deleteStmt = db.prepare("DELETE FROM cron_jobs WHERE job_id = @jobId");
  }

  public upsert(job: CronJobRecord, now = new Date().toISOString()): CronJobRecord {
    this.upsertStmt.run({
      jobId: job.jobId,
      name: job.name,
      action: job.action,
      description: job.description ?? null,
      schedule: job.schedule,
      enabled: job.enabled ? 1 : 0,
      endAt: job.endAt ?? null,
      lastRunAt: job.lastRunAt ?? null,
      nextRunAt: job.nextRunAt ?? null,
      updatedAt: now,
    });

    return {
      ...job,
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
    return mapRow(row);
  }

  public list(): CronJobRecord[] {
    const rows = this.listStmt.all();
    assertCronJobRows(rows);
    return rows.map(mapRow);
  }

  public delete(jobId: string): boolean {
    const result = this.deleteStmt.run({ jobId });
    const changes = Number((result as { changes?: number }).changes ?? 0);
    return changes > 0;
  }
}

function mapRow(row: CronJobRow): CronJobRecord {
  return {
    jobId: row.job_id,
    name: row.name,
    action: row.action as CronJobRecord["action"],
    description: row.description ?? undefined,
    schedule: row.schedule,
    enabled: Boolean(row.enabled),
    endAt: row.end_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    nextRunAt: row.next_run_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function cronJobsMatch(existing: CronJobRecord, next: CronJobRecord): boolean {
  return (
    existing.jobId === next.jobId &&
    existing.name === next.name &&
    existing.action === next.action &&
    existing.description === next.description &&
    existing.schedule === next.schedule &&
    existing.enabled === next.enabled &&
    existing.endAt === next.endAt &&
    existing.lastRunAt === next.lastRunAt &&
    existing.nextRunAt === next.nextRunAt
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
    (typeof row.description === "string" || row.description === null) &&
    typeof row.schedule === "string" &&
    typeof row.enabled === "number" &&
    (typeof row.end_at === "string" || row.end_at === null) &&
    (typeof row.last_run_at === "string" || row.last_run_at === null) &&
    (typeof row.next_run_at === "string" || row.next_run_at === null) &&
    typeof row.updated_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
