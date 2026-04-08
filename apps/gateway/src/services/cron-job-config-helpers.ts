import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { CronJobRecord } from "@goatcitadel/contracts";
import {
  COST_REPORT_HOURLY_JOB_ID,
  MEMORY_FLUSH_DAILY_JOB_ID,
  PRIVATE_BETA_BACKUP_JOB_ID,
  UPDATE_REVIEW_DAILY_JOB_ID,
  normalizeCronJobId,
  normalizeCronJobName,
  normalizeCronSchedule,
} from "./gateway/cron-automation-service.js";
import {
  COST_REPORT_HOURLY_SCHEDULE_LABEL,
  MEMORY_FLUSH_DAILY_SCHEDULE_LABEL,
  PRIVATE_BETA_BACKUP_SCHEDULE_LABEL,
  UPDATE_REVIEW_DAILY_SCHEDULE_LABEL,
  type GatewayService,
} from "./gateway-service.js";

export type CronJobConfigHost = GatewayService;

export function getCronJobsConfigPath(host: CronJobConfigHost): string {
  return path.join(host.config.rootDir, "config", "cron-jobs.json");
}

export async function loadCronJobsFromConfig(host: CronJobConfigHost): Promise<void> {
  const filePath = getCronJobsConfigPath(host);
  let raw: string;

  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as { jobs?: CronJobRecord[] } | CronJobRecord[];
  const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs ?? []);

  host.storage.runImmediateTransaction(() => {
    for (const job of jobs) {
      const normalizedJobId = normalizeCronJobId(job.jobId);
      const existing = host.storage.cronJobs.get(normalizedJobId);
      host.storage.cronJobs.upsertIfChanged({
        ...job,
        jobId: normalizedJobId,
        name: normalizeCronJobName(job.name),
        schedule: normalizeCronSchedule(job.schedule),
        enabled: Boolean(job.enabled),
        lastRunAt: job.lastRunAt ?? existing?.lastRunAt,
        nextRunAt: job.nextRunAt ?? existing?.nextRunAt,
      });
    }
  });
}

export function persistCronJobsConfig(host: CronJobConfigHost): void {
  const filePath = getCronJobsConfigPath(host);
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  const jobs = host.storage.cronJobs.list().map((job) => ({
    jobId: job.jobId,
    name: job.name,
    schedule: job.schedule,
    enabled: job.enabled,
    lastRunAt: job.lastRunAt,
    nextRunAt: job.nextRunAt,
  }));
  fsSync.writeFileSync(filePath, JSON.stringify({ jobs }, null, 2), "utf8");
  host.persistUnifiedConfig();
}

export function ensurePrivateBetaBackupCronJob(host: CronJobConfigHost): void {
  const existing = host.storage.cronJobs.get(PRIVATE_BETA_BACKUP_JOB_ID);
  const now = new Date().toISOString();
  host.storage.cronJobs.upsertIfChanged(
    {
      jobId: PRIVATE_BETA_BACKUP_JOB_ID,
      name: "Private Beta Daily Backup",
      schedule: PRIVATE_BETA_BACKUP_SCHEDULE_LABEL,
      enabled: existing?.enabled ?? true,
      lastRunAt: existing?.lastRunAt,
      nextRunAt: existing?.nextRunAt,
    },
    now,
  );
}

export function ensureMemoryFlushCronJob(host: CronJobConfigHost): void {
  const existing = host.storage.cronJobs.get(MEMORY_FLUSH_DAILY_JOB_ID);
  const now = new Date().toISOString();
  host.storage.cronJobs.upsertIfChanged(
    {
      jobId: MEMORY_FLUSH_DAILY_JOB_ID,
      name: "Memory Flush Daily",
      schedule: MEMORY_FLUSH_DAILY_SCHEDULE_LABEL,
      enabled: existing?.enabled ?? true,
      lastRunAt: existing?.lastRunAt,
      nextRunAt: existing?.nextRunAt,
    },
    now,
  );
}

export function ensureCostReportCronJob(host: CronJobConfigHost): void {
  const existing = host.storage.cronJobs.get(COST_REPORT_HOURLY_JOB_ID);
  const now = new Date().toISOString();
  host.storage.cronJobs.upsertIfChanged(
    {
      jobId: COST_REPORT_HOURLY_JOB_ID,
      name: "Cost Report Hourly",
      schedule: COST_REPORT_HOURLY_SCHEDULE_LABEL,
      enabled: existing?.enabled ?? true,
      lastRunAt: existing?.lastRunAt,
      nextRunAt: existing?.nextRunAt,
    },
    now,
  );
}

export function ensureUpdateReviewCronJob(host: CronJobConfigHost): void {
  const existing = host.storage.cronJobs.get(UPDATE_REVIEW_DAILY_JOB_ID);
  const now = new Date().toISOString();
  host.storage.cronJobs.upsertIfChanged(
    {
      jobId: UPDATE_REVIEW_DAILY_JOB_ID,
      name: "Daily Update Review",
      schedule: UPDATE_REVIEW_DAILY_SCHEDULE_LABEL,
      enabled: existing?.enabled ?? true,
      lastRunAt: existing?.lastRunAt,
      nextRunAt: existing?.nextRunAt,
    },
    now,
  );
}
