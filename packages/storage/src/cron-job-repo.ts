import type { CronJobRecord } from "@goatcitadel/contracts";
import type { DatabaseSync } from "node:sqlite";

interface CronJobRow {
  job_id: string;
  name: string;
  schedule: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  updated_at: string;
}

export class CronJobRepository {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly deleteStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.upsertStmt = db.prepare(`
      INSERT INTO cron_jobs (
        job_id, name, schedule, enabled, last_run_at, next_run_at, updated_at
      ) VALUES (
        @jobId, @name, @schedule, @enabled, @lastRunAt, @nextRunAt, @updatedAt
      )
      ON CONFLICT(job_id) DO UPDATE SET
        name = excluded.name,
        schedule = excluded.schedule,
        enabled = excluded.enabled,
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
      schedule: job.schedule,
      enabled: job.enabled ? 1 : 0,
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
    const row = this.getStmt.get({ jobId }) as unknown as CronJobRow | undefined;
    if (!row) {
      return undefined;
    }
    return mapRow(row);
  }

  public list(): CronJobRecord[] {
    const rows = this.listStmt.all() as unknown as CronJobRow[];
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
    schedule: row.schedule,
    enabled: Boolean(row.enabled),
    lastRunAt: row.last_run_at ?? undefined,
    nextRunAt: row.next_run_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function cronJobsMatch(existing: CronJobRecord, next: CronJobRecord): boolean {
  return existing.jobId === next.jobId
    && existing.name === next.name
    && existing.schedule === next.schedule
    && existing.enabled === next.enabled
    && existing.lastRunAt === next.lastRunAt
    && existing.nextRunAt === next.nextRunAt;
}
