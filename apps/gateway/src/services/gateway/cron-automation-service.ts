import { randomUUID } from "node:crypto";
import type { CronJobRecord, CronReviewItem, CronRunDiff } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

export const IMPROVEMENT_WEEKLY_JOB_ID = "self_improvement_weekly_replay";
export const PRIVATE_BETA_BACKUP_JOB_ID = "private_beta_backup_daily";
export const MEMORY_FLUSH_DAILY_JOB_ID = "memory-flush-daily";
export const COST_REPORT_HOURLY_JOB_ID = "cost-report-hourly";
export const UPDATE_REVIEW_DAILY_JOB_ID = "update-review-daily";

const SYSTEM_CRON_JOB_IDS = new Set([
  IMPROVEMENT_WEEKLY_JOB_ID,
  PRIVATE_BETA_BACKUP_JOB_ID,
  MEMORY_FLUSH_DAILY_JOB_ID,
  COST_REPORT_HOURLY_JOB_ID,
  UPDATE_REVIEW_DAILY_JOB_ID,
]);

export interface CronAutomationServiceDeps {
  storage: Storage;
  persistCronJobsConfig: () => void;
  publishRealtime: (
    eventType: string,
    source: string,
    payload?: Record<string, unknown>,
  ) => void;
  requireFeatureEnabled: (flag: "cronReviewQueueV1Enabled") => void;
  isFeatureEnabled: (flag: "cronReviewQueueV1Enabled") => boolean;
  runHandlers: {
    improvement: () => Promise<void>;
    backup: () => Promise<void>;
    memoryFlush: () => Promise<void>;
    costReport: () => Promise<void>;
    updateReview: () => Promise<void>;
  };
}

export class CronAutomationService {
  public constructor(private readonly deps: CronAutomationServiceDeps) {}

  public listCronJobs(): CronJobRecord[] {
    return this.deps.storage.cronJobs.list();
  }

  public getCronJob(jobId: string): CronJobRecord {
    const normalizedJobId = normalizeCronJobId(jobId);
    const job = this.deps.storage.cronJobs.get(normalizedJobId);
    if (!job) {
      throw new Error(`Cron job not found: ${normalizedJobId}`);
    }
    return job;
  }

  public createCronJob(input: {
    jobId: string;
    name: string;
    schedule: string;
    enabled?: boolean;
  }): CronJobRecord {
    const jobId = normalizeCronJobId(input.jobId);
    if (this.deps.storage.cronJobs.get(jobId)) {
      throw new Error(`Cron job already exists: ${jobId}`);
    }
    const job: CronJobRecord = {
      jobId,
      name: normalizeCronJobName(input.name),
      schedule: normalizeCronSchedule(input.schedule),
      enabled: input.enabled ?? true,
      lastRunAt: undefined,
      nextRunAt: undefined,
    };
    const saved = this.deps.storage.cronJobs.upsert(job);
    this.deps.persistCronJobsConfig();
    this.deps.publishRealtime("system", "cron", {
      type: "cron_job_created",
      jobId: saved.jobId,
      name: saved.name,
      schedule: saved.schedule,
      enabled: saved.enabled,
    });
    return saved;
  }

  public updateCronJob(jobId: string, input: {
    name?: string;
    schedule?: string;
    enabled?: boolean;
  }): CronJobRecord {
    const current = this.getCronJob(jobId);
    const updated: CronJobRecord = {
      ...current,
      name: input.name !== undefined ? normalizeCronJobName(input.name) : current.name,
      schedule: input.schedule !== undefined ? normalizeCronSchedule(input.schedule) : current.schedule,
      enabled: input.enabled ?? current.enabled,
    };
    const saved = this.deps.storage.cronJobs.upsert(updated);
    this.deps.persistCronJobsConfig();
    this.deps.publishRealtime("system", "cron", {
      type: "cron_job_updated",
      jobId: saved.jobId,
      name: saved.name,
      schedule: saved.schedule,
      enabled: saved.enabled,
    });
    return saved;
  }

  public setCronJobEnabled(jobId: string, enabled: boolean): CronJobRecord {
    return this.updateCronJob(jobId, { enabled });
  }

  public deleteCronJob(jobId: string): { deleted: boolean; jobId: string } {
    const normalizedJobId = normalizeCronJobId(jobId);
    if (SYSTEM_CRON_JOB_IDS.has(normalizedJobId)) {
      throw new Error(`System cron job cannot be deleted: ${normalizedJobId}`);
    }
    const deleted = this.deps.storage.cronJobs.delete(normalizedJobId);
    if (deleted) {
      this.deps.persistCronJobsConfig();
      this.deps.publishRealtime("system", "cron", {
        type: "cron_job_deleted",
        jobId: normalizedJobId,
      });
    }
    return {
      deleted,
      jobId: normalizedJobId,
    };
  }

  public async runCronJobNow(jobId: string): Promise<{ jobId: string; status: "ok" }> {
    const normalizedJobId = normalizeCronJobId(jobId);
    const job = this.getCronJob(normalizedJobId);
    if (!job.enabled) {
      throw new Error(`Cron job is paused: ${normalizedJobId}`);
    }
    if (normalizedJobId === IMPROVEMENT_WEEKLY_JOB_ID) {
      await this.deps.runHandlers.improvement();
    } else if (normalizedJobId === PRIVATE_BETA_BACKUP_JOB_ID) {
      await this.deps.runHandlers.backup();
    } else if (normalizedJobId === MEMORY_FLUSH_DAILY_JOB_ID) {
      await this.deps.runHandlers.memoryFlush();
    } else if (normalizedJobId === COST_REPORT_HOURLY_JOB_ID) {
      await this.deps.runHandlers.costReport();
    } else if (normalizedJobId === UPDATE_REVIEW_DAILY_JOB_ID) {
      await this.deps.runHandlers.updateReview();
    } else {
      throw new Error(`Cron job has no runnable handler: ${normalizedJobId}`);
    }
    if (this.deps.isFeatureEnabled("cronReviewQueueV1Enabled")) {
      this.recordCronReviewItem({
        jobId: normalizedJobId,
        runId: randomUUID(),
        severity: "low",
        status: "resolved",
        summary: {
          trigger: "manual_run",
          result: "ok",
        },
        diff: {
          type: "manual_run",
          changed: false,
        },
      });
    }
    return {
      jobId: normalizedJobId,
      status: "ok",
    };
  }

  public listCronReviewQueue(limit = 200): CronReviewItem[] {
    this.deps.requireFeatureEnabled("cronReviewQueueV1Enabled");
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = this.deps.storage.db.prepare(`
      SELECT item_id, job_id, run_id, severity, status, summary_json, diff_json, created_at, updated_at, resolved_at
      FROM cron_review_items
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(safeLimit) as Array<{
      item_id: string;
      job_id: string;
      run_id: string;
      severity: CronReviewItem["severity"];
      status: CronReviewItem["status"];
      summary_json: string;
      diff_json: string | null;
      created_at: string;
      updated_at: string;
      resolved_at: string | null;
    }>;
    return rows.map((row) => mapCronReviewItemRow(row));
  }

  public retryCronReviewQueueItem(itemId: string): CronReviewItem {
    this.deps.requireFeatureEnabled("cronReviewQueueV1Enabled");
    const existing = this.deps.storage.db.prepare(`
      SELECT item_id, job_id, run_id, severity, status, summary_json, diff_json, created_at, updated_at, resolved_at
      FROM cron_review_items
      WHERE item_id = ?
    `).get(itemId) as {
      item_id: string;
      job_id: string;
      run_id: string;
      severity: CronReviewItem["severity"];
      status: CronReviewItem["status"];
      summary_json: string;
      diff_json: string | null;
      created_at: string;
      updated_at: string;
      resolved_at: string | null;
    } | undefined;
    if (!existing) {
      throw new Error(`Cron review item not found: ${itemId}`);
    }

    const retriedRunId = randomUUID();
    const now = new Date().toISOString();
    let updated: {
      item_id: string;
      job_id: string;
      run_id: string;
      severity: CronReviewItem["severity"];
      status: CronReviewItem["status"];
      summary_json: string;
      diff_json: string | null;
      created_at: string;
      updated_at: string;
      resolved_at: string | null;
    } | undefined;
    this.deps.storage.db.exec("BEGIN IMMEDIATE");
    try {
      this.deps.storage.db.prepare(`
        UPDATE cron_review_items
        SET status = 'retrying',
            run_id = @runId,
            updated_at = @updatedAt,
            resolved_at = NULL
        WHERE item_id = @itemId
      `).run({
        itemId,
        runId: retriedRunId,
        updatedAt: now,
      });
      this.deps.storage.db.prepare(`
        INSERT INTO cron_run_diffs (diff_id, run_id, previous_run_id, diff_json, created_at)
        VALUES (@diffId, @runId, @previousRunId, @diffJson, @createdAt)
      `).run({
        diffId: randomUUID(),
        runId: retriedRunId,
        previousRunId: existing.run_id,
        diffJson: JSON.stringify({
          retried: true,
          previousRunId: existing.run_id,
        }),
        createdAt: now,
      });
      updated = this.deps.storage.db.prepare(`
        SELECT item_id, job_id, run_id, severity, status, summary_json, diff_json, created_at, updated_at, resolved_at
        FROM cron_review_items
        WHERE item_id = ?
      `).get(itemId) as {
        item_id: string;
        job_id: string;
        run_id: string;
        severity: CronReviewItem["severity"];
        status: CronReviewItem["status"];
        summary_json: string;
        diff_json: string | null;
        created_at: string;
        updated_at: string;
        resolved_at: string | null;
      } | undefined;
      this.deps.storage.db.exec("COMMIT");
    } catch (error) {
      this.deps.storage.db.exec("ROLLBACK");
      throw error;
    }
    if (!updated) {
      throw new Error("Cron review item retry update failed.");
    }
    const mapped = mapCronReviewItemRow(updated);
    this.deps.publishRealtime("system", "cron", {
      type: "cron_review_item_retried",
      itemId,
      jobId: mapped.jobId,
      runId: mapped.runId,
    });
    return mapped;
  }

  public getCronRunDiff(runId: string): CronRunDiff {
    this.deps.requireFeatureEnabled("cronReviewQueueV1Enabled");
    const row = this.deps.storage.db.prepare(`
      SELECT diff_id, run_id, previous_run_id, diff_json, created_at
      FROM cron_run_diffs
      WHERE run_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(runId) as {
      diff_id: string;
      run_id: string;
      previous_run_id: string | null;
      diff_json: string;
      created_at: string;
    } | undefined;
    if (!row) {
      throw new Error(`Cron run diff not found for run ${runId}`);
    }
    return {
      diffId: row.diff_id,
      runId: row.run_id,
      previousRunId: row.previous_run_id ?? undefined,
      diff: parseJsonRecord(row.diff_json),
      createdAt: row.created_at,
    };
  }

  public recordCronReviewItem(input: {
    jobId: string;
    runId: string;
    severity: CronReviewItem["severity"];
    status: CronReviewItem["status"];
    summary: Record<string, unknown>;
    diff?: Record<string, unknown>;
  }): void {
    this.deps.storage.db.prepare(`
      INSERT INTO cron_review_items (
        item_id, job_id, run_id, severity, status, summary_json, diff_json, created_at, updated_at, resolved_at
      ) VALUES (
        @itemId, @jobId, @runId, @severity, @status, @summaryJson, @diffJson, @createdAt, @updatedAt, @resolvedAt
      )
    `).run({
      itemId: randomUUID(),
      jobId: normalizeCronJobId(input.jobId),
      runId: input.runId,
      severity: input.severity,
      status: input.status,
      summaryJson: JSON.stringify(input.summary),
      diffJson: input.diff ? JSON.stringify(input.diff) : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resolvedAt: input.status === "resolved" ? new Date().toISOString() : null,
    });
  }
}

function mapCronReviewItemRow(row: {
  item_id: string;
  job_id: string;
  run_id: string;
  severity: CronReviewItem["severity"];
  status: CronReviewItem["status"];
  summary_json: string;
  diff_json: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}): CronReviewItem {
  return {
    itemId: row.item_id,
    jobId: row.job_id,
    runId: row.run_id,
    severity: row.severity,
    status: row.status,
    summary: parseJsonRecord(row.summary_json),
    diff: row.diff_json ? parseJsonRecord(row.diff_json) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function normalizeCronJobId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(normalized)) {
    throw new Error("Cron job id must be 3-64 chars and only include lowercase letters, numbers, '_' or '-'.");
  }
  return normalized;
}

export function normalizeCronJobName(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Cron job name is required.");
  }
  if (normalized.length > 120) {
    throw new Error("Cron job name must be 120 characters or less.");
  }
  return normalized;
}

export function normalizeCronSchedule(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Cron schedule is required.");
  }
  if (!parseSimpleCronSchedule(normalized)) {
    throw new Error("Cron schedule must look like 'M H * * * [Timezone]' or 'M H * * DOW [Timezone]'.");
  }
  return normalized;
}

function parseSimpleCronSchedule(value: string): {
  minute?: number;
  hour?: number;
  weekday?: number;
  timeZone?: string;
  wildcardMinute: boolean;
  wildcardHour: boolean;
  wildcardWeekday: boolean;
} | null {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 5) {
    return null;
  }
  const minuteRaw = tokens[0];
  const hourRaw = tokens[1];
  const dayOfMonthRaw = tokens[2];
  const monthRaw = tokens[3];
  const dayOfWeekRaw = tokens[4];
  const timezoneParts = tokens.slice(5);
  if (!minuteRaw || !hourRaw || !dayOfMonthRaw || !monthRaw || !dayOfWeekRaw) {
    return null;
  }
  if (dayOfMonthRaw !== "*" || monthRaw !== "*") {
    return null;
  }
  let minute: number | undefined;
  let hour: number | undefined;
  const wildcardMinute = minuteRaw === "*";
  const wildcardHour = hourRaw === "*";
  if (!wildcardMinute) {
    if (!/^\d+$/.test(minuteRaw)) {
      return null;
    }
    minute = Number.parseInt(minuteRaw, 10);
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) {
      return null;
    }
  }
  if (!wildcardHour) {
    if (!/^\d+$/.test(hourRaw)) {
      return null;
    }
    hour = Number.parseInt(hourRaw, 10);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
      return null;
    }
  }
  let weekday: number | undefined;
  const wildcardWeekday = dayOfWeekRaw === "*";
  if (!wildcardWeekday) {
    if (!/^\d+$/.test(dayOfWeekRaw)) {
      return null;
    }
    const parsedWeekday = Number.parseInt(dayOfWeekRaw, 10);
    if (!Number.isFinite(parsedWeekday) || parsedWeekday < 0 || parsedWeekday > 6) {
      return null;
    }
    weekday = parsedWeekday;
  }
  const timeZone = timezoneParts.length > 0 ? timezoneParts.join(" ") : undefined;
  if (timeZone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    } catch {
      return null;
    }
  }
  return {
    minute,
    hour,
    weekday,
    timeZone,
    wildcardMinute,
    wildcardHour,
    wildcardWeekday,
  };
}
