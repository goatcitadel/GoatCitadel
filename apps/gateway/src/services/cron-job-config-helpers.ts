import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { CronJobRecord } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import {
  COST_REPORT_HOURLY_JOB_ID,
  MEMORY_FLUSH_DAILY_JOB_ID,
  PRIVATE_BETA_BACKUP_JOB_ID,
  UPDATE_REVIEW_DAILY_JOB_ID,
  computeNextCronRunAt,
  normalizeCronEndAt,
  normalizeCronJobId,
  normalizeCronJobName,
  normalizeCronSchedule,
} from "./gateway/cron-automation-service.js";
import type { Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import {
  COST_REPORT_HOURLY_SCHEDULE_LABEL,
  MEMORY_FLUSH_DAILY_SCHEDULE_LABEL,
  PRIVATE_BETA_BACKUP_SCHEDULE_LABEL,
  UPDATE_REVIEW_DAILY_SCHEDULE_LABEL,
} from "./cron-job-schedule-labels.js";
import { describeMalformedCronRow, isPlainRecord, isValidCronRow } from "./cron-row-validation.js";

const log = logger.child("cron-job-config-helpers");

export interface CronJobConfigHost {
  readonly config: Pick<GatewayRuntimeConfig, "rootDir">;
  readonly storage: Pick<Storage, "cronJobs" | "runImmediateTransaction">;
  persistUnifiedConfig(): void;
}

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

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log.warn("cron-jobs.json is not valid JSON — skipping load", {
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const jobsArray: unknown = Array.isArray(parsed) ? parsed : isPlainRecord(parsed) ? parsed.jobs : undefined;
  if (!Array.isArray(jobsArray)) {
    log.warn("cron-jobs.json has no jobs array — skipping load", { path: filePath });
    return;
  }

  host.storage.runImmediateTransaction(() => {
    for (let index = 0; index < jobsArray.length; index += 1) {
      const candidate = jobsArray[index];
      const sanitized = sanitizeCronJobRow(candidate);
      if (!sanitized) {
        log.warn("dropping malformed cron job row", {
          path: filePath,
          index,
          reason: describeMalformedCronRow(candidate),
        });
        continue;
      }
      let normalizedJobId: string;
      let normalizedName: string;
      let normalizedSchedule: string;
      try {
        normalizedJobId = normalizeCronJobId(sanitized.jobId);
        normalizedName = normalizeCronJobName(sanitized.name);
        normalizedSchedule = normalizeCronSchedule(sanitized.schedule);
      } catch (error) {
        log.warn("dropping cron job row with invalid jobId/name/schedule", {
          path: filePath,
          index,
          jobId: sanitized.jobId,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const existing = host.storage.cronJobs.get(normalizedJobId);
      let normalizedEndAt: string | undefined;
      try {
        normalizedEndAt = normalizeCronEndAt(sanitized.endAt ?? existing?.endAt);
      } catch (error) {
        log.warn("dropping cron job row with invalid endAt", {
          path: filePath,
          index,
          jobId: normalizedJobId,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const persistedNext = sanitized.nextRunAt ?? existing?.nextRunAt;
      const repairedNext = repairCronNextRunAt(normalizedSchedule, persistedNext, normalizedEndAt, Date.now());
      if (repairedNext && repairedNext !== persistedNext) {
        log.info("repaired stale nextRunAt", {
          jobId: normalizedJobId,
          schedule: normalizedSchedule,
          persistedNextRunAt: persistedNext,
          repairedNextRunAt: repairedNext,
        });
      }
      host.storage.cronJobs.upsertIfChanged({
        ...sanitized,
        jobId: normalizedJobId,
        name: normalizedName,
        action: sanitized.action ?? existing?.action ?? "task",
        actionConfig: sanitized.actionConfig ?? existing?.actionConfig,
        description: sanitized.description ?? existing?.description,
        schedule: normalizedSchedule,
        enabled: Boolean(sanitized.enabled),
        endAt: normalizedEndAt,
        lastRunAt: sanitized.lastRunAt ?? existing?.lastRunAt,
        nextRunAt: repairedNext,
      });
    }
  });
}

interface SanitizedCronJobRow {
  jobId: string;
  name: string;
  schedule: string;
  action?: CronJobRecord["action"];
  actionConfig?: CronJobRecord["actionConfig"];
  description?: string;
  enabled?: unknown;
  endAt?: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

function sanitizeCronJobRow(input: unknown): SanitizedCronJobRow | null {
  if (!isValidCronRow(input)) {
    return null;
  }
  // isValidCronRow narrows to { jobId, name, schedule } but we also need the
  // ancillary fields, so coerce back to a record after the narrowing check.
  const record = input as Record<string, unknown> & { jobId: string; name: string; schedule: string };
  return {
    jobId: record.jobId.trim(),
    name: record.name.trim(),
    schedule: record.schedule.trim(),
    action: typeof record.action === "string" ? (record.action as CronJobRecord["action"]) : undefined,
    actionConfig: (record.actionConfig as CronJobRecord["actionConfig"]) ?? undefined,
    description: typeof record.description === "string" ? record.description : undefined,
    enabled: record.enabled,
    endAt: typeof record.endAt === "string" ? record.endAt : undefined,
    lastRunAt: typeof record.lastRunAt === "string" ? record.lastRunAt : undefined,
    nextRunAt: typeof record.nextRunAt === "string" ? record.nextRunAt : undefined,
  };
}

function repairCronNextRunAt(
  schedule: string,
  persistedNextRunAt: string | undefined,
  endAt: string | undefined,
  nowMs: number,
): string | undefined {
  if (!persistedNextRunAt) {
    return computeNextCronRunAt(schedule, new Date(nowMs), endAt);
  }
  const persisted = Date.parse(persistedNextRunAt);
  if (!Number.isFinite(persisted)) {
    return computeNextCronRunAt(schedule, new Date(nowMs), endAt);
  }
  // Recompute when the persisted nextRunAt is in the past — it would otherwise
  // either fire on the next tick (harmless but noisy) or stay stuck if the
  // schedule's timezone shifted. Future values are preserved verbatim.
  if (persisted <= nowMs) {
    return computeNextCronRunAt(schedule, new Date(nowMs), endAt);
  }
  return persistedNextRunAt;
}

export function persistCronJobsConfig(host: CronJobConfigHost): void {
  const filePath = getCronJobsConfigPath(host);
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  const jobs = host.storage.cronJobs.list().map((job) => ({
    jobId: job.jobId,
    name: job.name,
    action: job.action,
    actionConfig: job.actionConfig,
    description: job.description,
    schedule: job.schedule,
    enabled: job.enabled,
    endAt: job.endAt,
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
      action: "backup",
      description: existing?.description ?? "Create the daily private beta backup and prune retained snapshots.",
      schedule: PRIVATE_BETA_BACKUP_SCHEDULE_LABEL,
      enabled: existing?.enabled ?? true,
      endAt: existing?.endAt,
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
      action: "memory_flush",
      description: existing?.description ?? "Prune expired memory artifacts and clear old maintenance context.",
      schedule: MEMORY_FLUSH_DAILY_SCHEDULE_LABEL,
      enabled: existing?.enabled ?? true,
      endAt: existing?.endAt,
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
      action: "cost_report",
      description: existing?.description ?? "Write the hourly usage and cost rollup report.",
      schedule: COST_REPORT_HOURLY_SCHEDULE_LABEL,
      enabled: existing?.enabled ?? true,
      endAt: existing?.endAt,
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
      action: "update_review",
      description: existing?.description ?? "Generate the daily dependency and skill source review report.",
      schedule: UPDATE_REVIEW_DAILY_SCHEDULE_LABEL,
      enabled: existing?.enabled ?? true,
      endAt: existing?.endAt,
      lastRunAt: existing?.lastRunAt,
      nextRunAt: existing?.nextRunAt,
    },
    now,
  );
}
