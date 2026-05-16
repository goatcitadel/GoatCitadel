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

  const jobsArray: unknown = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.jobs : undefined;
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
          reason: describeMalformedRow(candidate),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (!isRecord(input)) {
    return null;
  }
  const jobId = typeof input.jobId === "string" ? input.jobId.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const schedule = typeof input.schedule === "string" ? input.schedule.trim() : "";
  if (!jobId || !name || !schedule) {
    return null;
  }
  return {
    jobId,
    name,
    schedule,
    action: typeof input.action === "string" ? (input.action as CronJobRecord["action"]) : undefined,
    actionConfig: (input.actionConfig as CronJobRecord["actionConfig"]) ?? undefined,
    description: typeof input.description === "string" ? input.description : undefined,
    enabled: input.enabled,
    endAt: typeof input.endAt === "string" ? input.endAt : undefined,
    lastRunAt: typeof input.lastRunAt === "string" ? input.lastRunAt : undefined,
    nextRunAt: typeof input.nextRunAt === "string" ? input.nextRunAt : undefined,
  };
}

function describeMalformedRow(candidate: unknown): string {
  if (candidate === null) {
    return "row is null";
  }
  if (typeof candidate !== "object") {
    return `row is ${typeof candidate}, not object`;
  }
  if (Array.isArray(candidate)) {
    return "row is array, not object";
  }
  const record = candidate as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof record.jobId !== "string" || record.jobId.trim() === "") {
    issues.push("missing or empty jobId");
  }
  if (typeof record.name !== "string" || record.name.trim() === "") {
    issues.push("missing or empty name");
  }
  if (typeof record.schedule !== "string" || record.schedule.trim() === "") {
    issues.push("missing or empty schedule");
  }
  return issues.length > 0 ? issues.join(", ") : "row failed validation";
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
