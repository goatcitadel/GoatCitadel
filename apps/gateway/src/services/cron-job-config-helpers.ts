import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { CronJobRecord } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import {
  COST_REPORT_HOURLY_JOB_ID,
  IMPROVEMENT_WEEKLY_JOB_ID,
  MEMORY_CONSOLIDATION_WEEKLY_JOB_ID,
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
  MEMORY_CONSOLIDATION_WEEKLY_SCHEDULE_LABEL,
  MEMORY_FLUSH_DAILY_SCHEDULE_LABEL,
  PRIVATE_BETA_BACKUP_SCHEDULE_LABEL,
  UPDATE_REVIEW_DAILY_SCHEDULE_LABEL,
} from "./cron-job-schedule-labels.js";
import { describeMalformedCronRow, isPlainRecord, isValidCronRow } from "./cron-row-validation.js";

const log = logger.child("cron-job-config-helpers");
const BUILT_IN_CRON_ACTIONS = new Map<string, CronJobRecord["action"]>([
  [IMPROVEMENT_WEEKLY_JOB_ID, "improvement"],
  [PRIVATE_BETA_BACKUP_JOB_ID, "backup"],
  [MEMORY_FLUSH_DAILY_JOB_ID, "memory_flush"],
  [MEMORY_CONSOLIDATION_WEEKLY_JOB_ID, "memory_consolidation"],
  [COST_REPORT_HOURLY_JOB_ID, "cost_report"],
  [UPDATE_REVIEW_DAILY_JOB_ID, "update_review"],
]);

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
      const canonicalAction = BUILT_IN_CRON_ACTIONS.get(normalizedJobId);
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
        action: canonicalAction ?? sanitized.action ?? existing?.action ?? "task",
        actionConfig: sanitized.actionConfig ?? existing?.actionConfig,
        description: sanitized.description ?? existing?.description,
        schedule: normalizedSchedule,
        enabled: Boolean(sanitized.enabled),
        endAt: normalizedEndAt,
        lastRunAt: sanitized.lastRunAt ?? existing?.lastRunAt,
        nextRunAt: repairedNext,
        workdir: sanitized.workdir ?? existing?.workdir,
        contextFrom: sanitized.contextFrom ?? existing?.contextFrom,
        lastRunOutput: sanitized.lastRunOutput ?? existing?.lastRunOutput,
        lastRunId: sanitized.lastRunId ?? existing?.lastRunId,
        lastRunStatus: sanitized.lastRunStatus ?? existing?.lastRunStatus,
        lastFailureAt: sanitized.lastFailureAt ?? existing?.lastFailureAt,
        lastFailure: sanitized.lastFailure ?? existing?.lastFailure,
        failureCount: sanitized.failureCount ?? existing?.failureCount,
        backoffUntil: sanitized.backoffUntil ?? existing?.backoffUntil,
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
  workdir?: string;
  contextFrom?: string;
  lastRunOutput?: string;
  lastRunId?: string;
  lastRunStatus?: CronJobRecord["lastRunStatus"];
  lastFailureAt?: string;
  lastFailure?: CronJobRecord["lastFailure"];
  failureCount?: number;
  backoffUntil?: string;
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
    workdir: typeof record.workdir === "string" ? record.workdir : undefined,
    contextFrom: typeof record.contextFrom === "string" ? record.contextFrom : undefined,
    lastRunOutput: typeof record.lastRunOutput === "string" ? record.lastRunOutput : undefined,
    lastRunId: typeof record.lastRunId === "string" ? record.lastRunId : undefined,
    lastRunStatus:
      record.lastRunStatus === "ok" || record.lastRunStatus === "failed" ? record.lastRunStatus : undefined,
    lastFailureAt: typeof record.lastFailureAt === "string" ? record.lastFailureAt : undefined,
    lastFailure: sanitizeCronLastFailure(record.lastFailure),
    failureCount:
      typeof record.failureCount === "number" && Number.isFinite(record.failureCount) && record.failureCount >= 0
        ? Math.floor(record.failureCount)
        : undefined,
    backoffUntil: typeof record.backoffUntil === "string" ? record.backoffUntil : undefined,
  };
}

function sanitizeCronLastFailure(value: unknown): CronJobRecord["lastFailure"] | undefined {
  if (!isPlainRecord(value) || typeof value.message !== "string") {
    return undefined;
  }
  return {
    message: value.message,
    code: typeof value.code === "string" ? value.code : undefined,
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
    workdir: job.workdir,
    contextFrom: job.contextFrom,
    lastRunOutput: job.lastRunOutput,
    lastRunId: job.lastRunId,
    lastRunStatus: job.lastRunStatus,
    lastFailureAt: job.lastFailureAt,
    lastFailure: job.lastFailure,
    failureCount: job.failureCount,
    backoffUntil: job.backoffUntil,
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
      workdir: existing?.workdir,
      contextFrom: existing?.contextFrom,
      lastRunOutput: existing?.lastRunOutput,
      lastRunId: existing?.lastRunId,
      lastRunStatus: existing?.lastRunStatus,
      lastFailureAt: existing?.lastFailureAt,
      lastFailure: existing?.lastFailure,
      failureCount: existing?.failureCount,
      backoffUntil: existing?.backoffUntil,
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
      workdir: existing?.workdir,
      contextFrom: existing?.contextFrom,
      lastRunOutput: existing?.lastRunOutput,
      lastRunId: existing?.lastRunId,
      lastRunStatus: existing?.lastRunStatus,
      lastFailureAt: existing?.lastFailureAt,
      lastFailure: existing?.lastFailure,
      failureCount: existing?.failureCount,
      backoffUntil: existing?.backoffUntil,
    },
    now,
  );
}

export function ensureMemoryConsolidationCronJob(host: CronJobConfigHost): void {
  const existing = host.storage.cronJobs.get(MEMORY_CONSOLIDATION_WEEKLY_JOB_ID);
  const now = new Date().toISOString();
  host.storage.cronJobs.upsertIfChanged(
    {
      jobId: MEMORY_CONSOLIDATION_WEEKLY_JOB_ID,
      name: "Memory Consolidation Weekly",
      action: "memory_consolidation",
      description:
        existing?.description ??
        "Propose memory candidates from recent run traces (approval-gated; requires memoryConsolidationV1Enabled).",
      schedule: MEMORY_CONSOLIDATION_WEEKLY_SCHEDULE_LABEL,
      // Seeded DISABLED, unlike the other system jobs: consolidation is
      // opt-in twice over (job.enabled AND the feature flag).
      enabled: existing?.enabled ?? false,
      endAt: existing?.endAt,
      lastRunAt: existing?.lastRunAt,
      nextRunAt: existing?.nextRunAt,
      workdir: existing?.workdir,
      contextFrom: existing?.contextFrom,
      lastRunOutput: existing?.lastRunOutput,
      lastRunId: existing?.lastRunId,
      lastRunStatus: existing?.lastRunStatus,
      lastFailureAt: existing?.lastFailureAt,
      lastFailure: existing?.lastFailure,
      failureCount: existing?.failureCount,
      backoffUntil: existing?.backoffUntil,
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
      workdir: existing?.workdir,
      contextFrom: existing?.contextFrom,
      lastRunOutput: existing?.lastRunOutput,
      lastRunId: existing?.lastRunId,
      lastRunStatus: existing?.lastRunStatus,
      lastFailureAt: existing?.lastFailureAt,
      lastFailure: existing?.lastFailure,
      failureCount: existing?.failureCount,
      backoffUntil: existing?.backoffUntil,
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
      workdir: existing?.workdir,
      contextFrom: existing?.contextFrom,
      lastRunOutput: existing?.lastRunOutput,
      lastRunId: existing?.lastRunId,
      lastRunStatus: existing?.lastRunStatus,
      lastFailureAt: existing?.lastFailureAt,
      lastFailure: existing?.lastFailure,
      failureCount: existing?.failureCount,
      backoffUntil: existing?.backoffUntil,
    },
    now,
  );
}
