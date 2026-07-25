import fs from "node:fs/promises";
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
  normalizeCronEndAt,
  normalizeCronJobId,
  normalizeCronJobName,
  normalizeCronSchedule,
} from "./gateway/cron-automation-service.js";
import type { CronJobSpecInput, Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import type { CronSpecMutationOwner } from "./cron-config-generation-owner.js";
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
  readonly storage: Pick<Storage, "cronJobs">;
  readonly cronConfigGenerationOwner: Pick<CronSpecMutationOwner, "reconcileSpec">;
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
    const canonicalAction = BUILT_IN_CRON_ACTIONS.get(normalizedJobId);
    await host.cronConfigGenerationOwner.reconcileSpec({
      jobId: normalizedJobId,
      name: normalizedName,
      action: canonicalAction ?? sanitized.action ?? existing?.action ?? "task",
      actionConfig: sanitized.actionConfig ?? existing?.actionConfig,
      description: sanitized.description ?? existing?.description,
      schedule: normalizedSchedule,
      enabled: sanitized.enabled === undefined ? (existing?.enabled ?? true) : Boolean(sanitized.enabled),
      endAt: normalizedEndAt,
      workdir: sanitized.workdir ?? existing?.workdir,
      contextFrom: sanitized.contextFrom ?? existing?.contextFrom,
    });
  }
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
  workdir?: string;
  contextFrom?: string;
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
    workdir: typeof record.workdir === "string" ? record.workdir : undefined,
    contextFrom: typeof record.contextFrom === "string" ? record.contextFrom : undefined,
  };
}

export async function ensurePrivateBetaBackupCronJob(host: CronJobConfigHost): Promise<void> {
  const existing = host.storage.cronJobs.get(PRIVATE_BETA_BACKUP_JOB_ID);
  await reconcileBuiltIn(host, {
    jobId: PRIVATE_BETA_BACKUP_JOB_ID,
    name: "Private Beta Daily Backup",
    action: "backup",
    description: existing?.description ?? "Create the daily private beta backup and prune retained snapshots.",
    schedule: PRIVATE_BETA_BACKUP_SCHEDULE_LABEL,
    enabled: existing?.enabled ?? true,
    endAt: existing?.endAt,
    workdir: existing?.workdir,
    contextFrom: existing?.contextFrom,
  });
}

export async function ensureMemoryFlushCronJob(host: CronJobConfigHost): Promise<void> {
  const existing = host.storage.cronJobs.get(MEMORY_FLUSH_DAILY_JOB_ID);
  await reconcileBuiltIn(host, {
    jobId: MEMORY_FLUSH_DAILY_JOB_ID,
    name: "Memory Flush Daily",
    action: "memory_flush",
    description: existing?.description ?? "Prune expired memory artifacts and clear old maintenance context.",
    schedule: MEMORY_FLUSH_DAILY_SCHEDULE_LABEL,
    enabled: existing?.enabled ?? true,
    endAt: existing?.endAt,
    workdir: existing?.workdir,
    contextFrom: existing?.contextFrom,
  });
}

export async function ensureMemoryConsolidationCronJob(host: CronJobConfigHost): Promise<void> {
  const existing = host.storage.cronJobs.get(MEMORY_CONSOLIDATION_WEEKLY_JOB_ID);
  await reconcileBuiltIn(host, {
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
    workdir: existing?.workdir,
    contextFrom: existing?.contextFrom,
  });
}

export async function ensureCostReportCronJob(host: CronJobConfigHost): Promise<void> {
  const existing = host.storage.cronJobs.get(COST_REPORT_HOURLY_JOB_ID);
  await reconcileBuiltIn(host, {
    jobId: COST_REPORT_HOURLY_JOB_ID,
    name: "Cost Report Hourly",
    action: "cost_report",
    description: existing?.description ?? "Write the hourly usage and cost rollup report.",
    schedule: COST_REPORT_HOURLY_SCHEDULE_LABEL,
    enabled: existing?.enabled ?? true,
    endAt: existing?.endAt,
    workdir: existing?.workdir,
    contextFrom: existing?.contextFrom,
  });
}

export async function ensureUpdateReviewCronJob(host: CronJobConfigHost): Promise<void> {
  const existing = host.storage.cronJobs.get(UPDATE_REVIEW_DAILY_JOB_ID);
  await reconcileBuiltIn(host, {
    jobId: UPDATE_REVIEW_DAILY_JOB_ID,
    name: "Daily Update Review",
    action: "update_review",
    description: existing?.description ?? "Generate the daily dependency and skill source review report.",
    schedule: UPDATE_REVIEW_DAILY_SCHEDULE_LABEL,
    enabled: existing?.enabled ?? true,
    endAt: existing?.endAt,
    workdir: existing?.workdir,
    contextFrom: existing?.contextFrom,
  });
}

async function reconcileBuiltIn(host: CronJobConfigHost, spec: CronJobSpecInput): Promise<void> {
  await host.cronConfigGenerationOwner.reconcileSpec(spec);
}
