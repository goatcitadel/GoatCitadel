import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BackupCreateResponse, CronJobRecord } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { logger } from "@goatcitadel/gateway-core";
import type { EvidenceEnvelopeService } from "../evidence-envelope-service.js";
import type { MemoryConsolidationRunSummary } from "../memory-consolidation-service.js";
import type { MemoryLifecycleService } from "../memory-lifecycle-service.js";
import { getZonedDateParts, toDayKeyForTimezone, toHourKeyForTimezone } from "../scheduler-timing.js";
import { toWeekKeyForTimezone } from "../improvement-replay.js";
import { createDailyUpdateReview, renderUpdateReviewMarkdown } from "./update-review.js";
import {
  COST_REPORT_HOURLY_JOB_ID,
  MEMORY_CONSOLIDATION_WEEKLY_JOB_ID,
  MEMORY_FLUSH_DAILY_JOB_ID,
  PRIVATE_BETA_BACKUP_JOB_ID,
  UPDATE_REVIEW_DAILY_JOB_ID,
} from "./cron-job-ids.js";
import {
  computeCronBackoffUntil,
  computeNextCronRunAt,
  isCronJobBackedOff,
  normalizeCronFailureMessage,
} from "./cron-automation-service.js";

/**
 * System cron schedulers (B8a extraction): the five built-in maintenance jobs
 * (private-beta backup, memory flush, memory consolidation, cost report,
 * update review) plus the shared run/record plumbing they ride on. Verbatim
 * moves from GatewayService behind a narrow deps port — the gateway keeps thin
 * call sites (maintenance loop + force-run handlers) and owns the wiring.
 */

const log = logger.child("system-cron-schedulers");

const PRIVATE_BETA_BACKUP_TIME_ZONE = "America/Los_Angeles";
const MEMORY_FLUSH_DAILY_TIME_ZONE = "America/Los_Angeles";
const COST_REPORT_HOURLY_TIME_ZONE = "America/Los_Angeles";
const UPDATE_REVIEW_DAILY_TIME_ZONE = "America/Los_Angeles";
const MEMORY_CONSOLIDATION_TIME_ZONE = "America/Los_Angeles";
const PRIVATE_BETA_BACKUP_DEDUP_SETTING_KEY = "private_beta_backup_last_day_key_v1";
const MEMORY_FLUSH_DAILY_DEDUP_SETTING_KEY = "memory_flush_daily_last_day_key_v1";
const MEMORY_CONSOLIDATION_DEDUP_SETTING_KEY = "memory_consolidation_weekly_last_week_key_v1";
const COST_REPORT_HOURLY_DEDUP_SETTING_KEY = "cost_report_hourly_last_hour_key_v1";
const UPDATE_REVIEW_DAILY_DEDUP_SETTING_KEY = "update_review_daily_last_day_key_v1";
const MEMORY_FLUSH_HISTORY_DAYS = 30;
const MEMORY_FLUSH_EXPIRED_BATCH_LIMIT = 500;
const MEMORY_FLUSH_EXPIRED_SAFETY_LIMIT = 10_000;
const COST_REPORT_LOOKBACK_HOURS = 1;
const COST_REPORT_OUTPUT_DIR = "artifacts/cost-reports";
const UPDATE_REVIEW_OUTPUT_DIR = "artifacts/update-review";

export type SystemCronSchedulerOptions = { force?: boolean; recordCronState?: boolean };

export type SystemCronFeatureFlag =
  | "cronEvidenceV1Enabled"
  | "cronReviewQueueV1Enabled"
  | "memoryConsolidationV1Enabled"
  | "memoryLifecycleAdminV1Enabled"
  | "memoryLifecycleAutoForgetEnabled"
  | "autonomyV1Disabled";

export interface SystemCronSchedulerDeps {
  storage: Pick<Storage, "cronJobs" | "systemSettings" | "memoryContexts" | "memoryQmdRuns" | "costLedger">;
  rootDir: string;
  isFeatureEnabled(flag: SystemCronFeatureFlag): boolean;
  persistCronJobsConfig(): void;
  publishRealtime(eventType: string, source: string, payload?: Record<string, unknown>): void;
  evidenceEnvelopeService?: Pick<EvidenceEnvelopeService, "createEnvelope">;
  recordDevDiagnostic(input: {
    level: "info" | "warn" | "error";
    category: string;
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }): void;
  createBackup(input: { name: string }): Promise<BackupCreateResponse>;
  pruneRetention(options: { dryRun: boolean }): Promise<unknown>;
  runMemoryConsolidation(): Promise<MemoryConsolidationRunSummary>;
  memoryLifecycle: Pick<MemoryLifecycleService, "forgetExpiredActiveMemoryItems" | "inspectExpiredActiveMemoryLedger">;
  recordCronReviewItem(input: {
    jobId: string;
    runId: string;
    severity: "low" | "medium" | "high";
    status: "open" | "resolved";
    summary: Record<string, unknown>;
    diff?: Record<string, unknown>;
  }): void;
}

function shouldRecordSystemCronState(options: SystemCronSchedulerOptions): boolean {
  return options.recordCronState !== false;
}

function computeSystemCronNextRunAt(
  job: CronJobRecord,
  finishedAtIso: string,
  fallbackDelayMs: number,
): string | undefined {
  if (typeof job.schedule === "string" && job.schedule.trim()) {
    const computed = computeNextCronRunAt(job.schedule, new Date(finishedAtIso), job.endAt);
    if (computed) {
      return computed;
    }
  }
  return new Date(new Date(finishedAtIso).getTime() + fallbackDelayMs).toISOString();
}

async function runSystemCronBody<T>(
  deps: SystemCronSchedulerDeps,
  job: CronJobRecord,
  options: SystemCronSchedulerOptions,
  body: (context: { runId: string }) => Promise<T>,
): Promise<T> {
  const runId = randomUUID();
  try {
    return await body({ runId });
  } catch (error) {
    if (shouldRecordSystemCronState(options)) {
      try {
        recordSystemCronRunFailure(deps, job, runId, error, new Date());
      } catch (recordError) {
        log.warn("failed to record system cron failure state", {
          jobId: job.jobId,
          error: recordError instanceof Error ? recordError.message : String(recordError),
        });
      }
    }
    throw error;
  }
}

function recordSystemCronRunSuccess(
  deps: SystemCronSchedulerDeps,
  job: CronJobRecord,
  input: {
    runId: string;
    finishedAtIso: string;
    nextRunAt?: string;
    lastRunOutput?: string;
    summary?: Record<string, unknown>;
  },
): CronJobRecord {
  const evidenceEnvelopeId = recordSystemCronRunEvidence(deps, job, input.runId, "ok", input.finishedAtIso, {
    summary: input.summary,
  });
  const updated: CronJobRecord = {
    ...job,
    lastRunAt: input.finishedAtIso,
    lastRunId: input.runId,
    lastRunStatus: "ok",
    lastRunEvidenceEnvelopeId: evidenceEnvelopeId,
    lastFailureAt: undefined,
    lastFailure: undefined,
    failureCount: 0,
    backoffUntil: undefined,
    nextRunAt: input.nextRunAt,
  };
  if (input.lastRunOutput !== undefined) {
    updated.lastRunOutput = input.lastRunOutput;
  }
  const saved = deps.storage.cronJobs.upsert(updated);
  deps.persistCronJobsConfig();
  return saved;
}

function recordSystemCronRunFailure(
  deps: SystemCronSchedulerDeps,
  job: CronJobRecord,
  runId: string,
  error: unknown,
  failedAt: Date,
): CronJobRecord {
  const failedAtIso = failedAt.toISOString();
  const message = normalizeCronFailureMessage(error);
  const failureCount = Math.max(0, job.failureCount ?? 0) + 1;
  const backoffUntil = computeCronBackoffUntil(failedAt, failureCount);
  const saved = deps.storage.cronJobs.upsert({
    ...job,
    lastRunAt: failedAtIso,
    lastRunId: runId,
    lastRunStatus: "failed",
    lastRunEvidenceEnvelopeId: recordSystemCronRunEvidence(deps, job, runId, "failed", failedAtIso, {
      failureMessage: message,
    }),
    lastFailureAt: failedAtIso,
    lastFailure: {
      message,
      ...(error instanceof Error && error.name ? { code: error.name } : {}),
    },
    failureCount,
    backoffUntil,
    nextRunAt: typeof job.schedule === "string" ? computeNextCronRunAt(job.schedule, failedAt, job.endAt) : undefined,
  });
  deps.persistCronJobsConfig();
  deps.publishRealtime("cron_job_run", "cron", {
    type: "cron_job_run_failed",
    jobId: saved.jobId,
    name: saved.name,
    runId,
    action: saved.action,
    message,
    failureCount,
    backoffUntil,
  });
  return saved;
}

function recordSystemCronRunEvidence(
  deps: SystemCronSchedulerDeps,
  job: CronJobRecord,
  runId: string,
  status: "ok" | "failed",
  finishedAtIso: string,
  details: { summary?: Record<string, unknown>; failureMessage?: string } = {},
): string | undefined {
  const evidenceEnabled = (() => {
    try {
      return deps.isFeatureEnabled("cronEvidenceV1Enabled") === true;
    } catch {
      return false;
    }
  })();
  if (!evidenceEnabled || !deps.evidenceEnvelopeService) {
    return undefined;
  }
  const outputHash = details.summary
    ? createHash("sha256").update(JSON.stringify(details.summary), "utf8").digest("hex")
    : undefined;
  try {
    const envelope = deps.evidenceEnvelopeService.createEnvelope({
      eventKind: "cron_job_executed",
      runId,
      createdAt: finishedAtIso,
      metadata: {
        jobId: job.jobId,
        jobName: job.name,
        action: job.action,
        schedule: job.schedule,
        status,
        systemScheduler: true,
        ...(outputHash ? { outputHash } : {}),
        ...(details.failureMessage ? { failureMessage: details.failureMessage } : {}),
      },
    });
    return envelope.envelopeId;
  } catch (error) {
    try {
      deps.recordDevDiagnostic({
        level: "warn",
        category: "evidence",
        event: "evidence.envelope.failed",
        message: "Failed to record system cron run evidence envelope",
        context: {
          jobId: job.jobId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } catch {
      // Evidence is best-effort and must not fail a scheduler run.
    }
    return undefined;
  }
}

export async function runPrivateBetaBackupSchedulerIfDue(
  deps: SystemCronSchedulerDeps,
  options: SystemCronSchedulerOptions = {},
): Promise<void> {
  const job = deps.storage.cronJobs.get(PRIVATE_BETA_BACKUP_JOB_ID);
  if (!job?.enabled) {
    return;
  }
  const now = new Date();
  if (!options.force && isCronJobBackedOff(job, now)) {
    return;
  }
  if (
    !options.force &&
    !isCronJobDueNow(job, now, {
      defaultHour: 2,
      defaultMinute: 30,
      defaultWeekday: undefined,
      defaultTimeZone: PRIVATE_BETA_BACKUP_TIME_ZONE,
    })
  ) {
    return;
  }
  const dayKey = toDayKeyForTimezone(now, PRIVATE_BETA_BACKUP_TIME_ZONE);
  const lastDayKey = deps.storage.systemSettings.get<string>(PRIVATE_BETA_BACKUP_DEDUP_SETTING_KEY)?.value;
  if (!options.force && dayKey === lastDayKey) {
    return;
  }

  await runSystemCronBody(deps, job, options, async ({ runId }) => {
    const backupName = `private-beta-${dayKey.replaceAll("-", "")}`;
    const backup = await deps.createBackup({ name: backupName });
    await deps.pruneRetention({ dryRun: false });
    deps.storage.systemSettings.set(PRIVATE_BETA_BACKUP_DEDUP_SETTING_KEY, dayKey);

    const finishedAt = new Date().toISOString();
    if (shouldRecordSystemCronState(options)) {
      recordSystemCronRunSuccess(deps, job, {
        runId,
        finishedAtIso: finishedAt,
        nextRunAt: computeSystemCronNextRunAt(job, finishedAt, 24 * 60 * 60 * 1000),
        summary: {
          type: "private_beta_daily_backup",
          backupId: backup.backupId,
          bytes: backup.bytes,
        },
      });
    }
    deps.publishRealtime("backup_created", "system", {
      type: "private_beta_daily_backup",
      backupId: backup.backupId,
      outputPath: backup.outputPath,
      bytes: backup.bytes,
    });
  });
}

export async function runMemoryConsolidationSchedulerIfDue(
  deps: SystemCronSchedulerDeps,
  options: SystemCronSchedulerOptions = {},
): Promise<void> {
  const job = deps.storage.cronJobs.get(MEMORY_CONSOLIDATION_WEEKLY_JOB_ID);
  if (!job?.enabled) {
    return;
  }
  // Both gates are re-checked inside the service too; checking here avoids
  // bookkeeping writes for a run that would immediately no-op.
  if (
    !deps.isFeatureEnabled("memoryConsolidationV1Enabled") ||
    !deps.isFeatureEnabled("memoryLifecycleAdminV1Enabled") ||
    deps.isFeatureEnabled("autonomyV1Disabled")
  ) {
    return;
  }
  const now = new Date();
  if (!options.force && isCronJobBackedOff(job, now)) {
    return;
  }
  if (!options.force) {
    // Weekly: Sundays in the 2 AM hour in the configured timezone.
    const parts = getZonedDateParts(now, MEMORY_CONSOLIDATION_TIME_ZONE);
    if (parts.weekday !== 0 || parts.hour !== 2) {
      return;
    }
  }
  const weekKey = toWeekKeyForTimezone(now, MEMORY_CONSOLIDATION_TIME_ZONE);
  const lastWeekKey = deps.storage.systemSettings.get<string>(MEMORY_CONSOLIDATION_DEDUP_SETTING_KEY)?.value;
  if (!options.force && lastWeekKey === weekKey) {
    return;
  }
  await runSystemCronBody(deps, job, options, async ({ runId }) => {
    const summary = await deps.runMemoryConsolidation();
    if (summary.status !== "completed") {
      return;
    }
    deps.storage.systemSettings.set(MEMORY_CONSOLIDATION_DEDUP_SETTING_KEY, weekKey);
    const finishedAt = new Date().toISOString();
    if (shouldRecordSystemCronState(options)) {
      recordSystemCronRunSuccess(deps, job, {
        runId,
        finishedAtIso: finishedAt,
        lastRunOutput: JSON.stringify(summary),
        nextRunAt: computeSystemCronNextRunAt(job, finishedAt, 7 * 24 * 60 * 60 * 1000),
        summary: { ...summary },
      });
    }
  });
}

export async function runMemoryFlushSchedulerIfDue(
  deps: SystemCronSchedulerDeps,
  options: SystemCronSchedulerOptions = {},
): Promise<void> {
  const job = deps.storage.cronJobs.get(MEMORY_FLUSH_DAILY_JOB_ID);
  if (!job?.enabled) {
    return;
  }
  const now = new Date();
  if (!options.force && isCronJobBackedOff(job, now)) {
    return;
  }
  if (
    !options.force &&
    !isCronJobDueNow(job, now, {
      defaultHour: 3,
      defaultMinute: 0,
      defaultWeekday: undefined,
      defaultTimeZone: MEMORY_FLUSH_DAILY_TIME_ZONE,
    })
  ) {
    return;
  }
  const dayKey = toDayKeyForTimezone(now, MEMORY_FLUSH_DAILY_TIME_ZONE);
  const lastDayKey = deps.storage.systemSettings.get<string>(MEMORY_FLUSH_DAILY_DEDUP_SETTING_KEY)?.value;
  if (!options.force && dayKey === lastDayKey) {
    return;
  }

  await runSystemCronBody(deps, job, options, async ({ runId }) => {
    const nowIso = now.toISOString();
    const cutoffIso = new Date(now.getTime() - MEMORY_FLUSH_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const prunedExpiredContextPacks = deps.storage.memoryContexts.pruneExpired(nowIso);
    const prunedOldContextPacks = deps.storage.memoryContexts.pruneOlderThan(cutoffIso);
    const prunedOldQmdRuns = deps.storage.memoryQmdRuns.pruneOlderThan(cutoffIso);
    const expiredMemoryLedger = deps.isFeatureEnabled("memoryLifecycleAutoForgetEnabled")
      ? forgetExpiredMemoryItemsForFlush(deps, nowIso)
      : inspectExpiredMemoryItemsForFlush(deps, nowIso);

    deps.storage.systemSettings.set(MEMORY_FLUSH_DAILY_DEDUP_SETTING_KEY, dayKey);
    const finishedAt = new Date().toISOString();
    const summary = {
      type: "memory_flush_daily",
      cutoffIso,
      prunedExpiredContextPacks,
      prunedOldContextPacks,
      prunedOldQmdRuns,
      expiredActiveMemoryItemCount: expiredMemoryLedger.expiredActiveCount,
      forgottenExpiredMemoryItemCount: expiredMemoryLedger.forgottenCount,
      retainedPinnedExpiredMemoryItemCount: expiredMemoryLedger.retainedPinnedCount,
      remainingExpiredUnpinnedMemoryItemCount: expiredMemoryLedger.remainingExpiredUnpinnedCount,
      expiredMemoryFlushTruncated: expiredMemoryLedger.truncated,
    };
    if (shouldRecordSystemCronState(options)) {
      recordSystemCronRunSuccess(deps, job, {
        runId,
        finishedAtIso: finishedAt,
        nextRunAt: computeSystemCronNextRunAt(job, finishedAt, 24 * 60 * 60 * 1000),
        summary,
      });
    }
    deps.publishRealtime("cron_job_run", "cron", {
      ...summary,
      jobId: MEMORY_FLUSH_DAILY_JOB_ID,
      expiredMemoryItemCount: expiredMemoryLedger.expiredActiveCount,
      memoryLifecycleAutoForgetEnabled: deps.isFeatureEnabled("memoryLifecycleAutoForgetEnabled"),
      expiredMemoryItemIds: expiredMemoryLedger.forgottenItems.map((item) => item.itemId),
      expiredMemoryNamespacesSample: [...new Set(expiredMemoryLedger.forgottenItems.map((item) => item.namespace))],
      retainedPinnedExpiredMemoryItemIds: expiredMemoryLedger.retainedPinnedItems.map((item) => item.itemId),
      retainedPinnedExpiredMemoryNamespacesSample: [
        ...new Set(expiredMemoryLedger.retainedPinnedItems.map((item) => item.namespace)),
      ],
    });
  });
}

function forgetExpiredMemoryItemsForFlush(
  deps: SystemCronSchedulerDeps,
  nowIso: string,
): {
  expiredActiveCount: number;
  forgottenCount: number;
  retainedPinnedCount: number;
  remainingExpiredUnpinnedCount: number;
  truncated: boolean;
  forgottenItems: ReturnType<MemoryLifecycleService["forgetExpiredActiveMemoryItems"]>["forgottenItems"];
  retainedPinnedItems: ReturnType<MemoryLifecycleService["forgetExpiredActiveMemoryItems"]>["retainedPinnedItems"];
} {
  const forgottenItems: ReturnType<MemoryLifecycleService["forgetExpiredActiveMemoryItems"]>["forgottenItems"] = [];
  while (forgottenItems.length < MEMORY_FLUSH_EXPIRED_SAFETY_LIMIT) {
    const remainingCapacity = MEMORY_FLUSH_EXPIRED_SAFETY_LIMIT - forgottenItems.length;
    const batch = deps.memoryLifecycle.forgetExpiredActiveMemoryItems({
      nowIso,
      limit: Math.min(MEMORY_FLUSH_EXPIRED_BATCH_LIMIT, remainingCapacity),
    });
    forgottenItems.push(...batch.forgottenItems);
    if (batch.forgottenItems.length === 0 || batch.remainingUnpinnedCount === 0) {
      break;
    }
  }
  const ledger = deps.memoryLifecycle.inspectExpiredActiveMemoryLedger({ nowIso });
  return {
    expiredActiveCount: ledger.totalCount + forgottenItems.length,
    forgottenCount: forgottenItems.length,
    retainedPinnedCount: ledger.retainedPinnedCount,
    remainingExpiredUnpinnedCount: ledger.unpinnedCount,
    truncated: ledger.unpinnedCount > 0,
    forgottenItems,
    retainedPinnedItems: ledger.retainedPinnedItems,
  };
}

function inspectExpiredMemoryItemsForFlush(
  deps: SystemCronSchedulerDeps,
  nowIso: string,
): {
  expiredActiveCount: number;
  forgottenCount: number;
  retainedPinnedCount: number;
  remainingExpiredUnpinnedCount: number;
  truncated: boolean;
  forgottenItems: [];
  retainedPinnedItems: ReturnType<MemoryLifecycleService["inspectExpiredActiveMemoryLedger"]>["retainedPinnedItems"];
} {
  const ledger = deps.memoryLifecycle.inspectExpiredActiveMemoryLedger({ nowIso });
  return {
    expiredActiveCount: ledger.totalCount,
    forgottenCount: 0,
    retainedPinnedCount: ledger.retainedPinnedCount,
    remainingExpiredUnpinnedCount: ledger.unpinnedCount,
    truncated: ledger.unpinnedCount > 0,
    forgottenItems: [],
    retainedPinnedItems: ledger.retainedPinnedItems,
  };
}

export async function runCostReportSchedulerIfDue(
  deps: SystemCronSchedulerDeps,
  options: SystemCronSchedulerOptions = {},
): Promise<void> {
  const job = deps.storage.cronJobs.get(COST_REPORT_HOURLY_JOB_ID);
  if (!job?.enabled) {
    return;
  }
  const now = new Date();
  if (!options.force && isCronJobBackedOff(job, now)) {
    return;
  }
  if (
    !options.force &&
    !isCronJobDueNow(job, now, {
      defaultHour: 0,
      defaultMinute: 0,
      defaultWeekday: undefined,
      defaultTimeZone: COST_REPORT_HOURLY_TIME_ZONE,
    })
  ) {
    return;
  }
  const hourKey = toHourKeyForTimezone(now, COST_REPORT_HOURLY_TIME_ZONE);
  const lastHourKey = deps.storage.systemSettings.get<string>(COST_REPORT_HOURLY_DEDUP_SETTING_KEY)?.value;
  if (!options.force && hourKey === lastHourKey) {
    return;
  }

  await runSystemCronBody(deps, job, options, async ({ runId }) => {
    const windowEndIso = now.toISOString();
    const windowStartIso = new Date(now.getTime() - COST_REPORT_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
    const byDay = deps.storage.costLedger.summary("day", windowStartIso, windowEndIso);
    const bySession = deps.storage.costLedger.summary("session", windowStartIso, windowEndIso);
    const byAgent = deps.storage.costLedger.summary("agent", windowStartIso, windowEndIso);
    const byTask = deps.storage.costLedger.summary("task", windowStartIso, windowEndIso);
    const usageAvailability = deps.storage.costLedger.usageAvailability(windowStartIso, windowEndIso);
    const totalCostUsd = byDay.reduce((sum, row) => sum + row.costUsd, 0);
    const totalTokens = byDay.reduce((sum, row) => sum + row.tokenTotal, 0);

    const lines: string[] = [];
    lines.push(`# Cost Report (${COST_REPORT_LOOKBACK_HOURS}h)`);
    lines.push("");
    lines.push(`- Generated: ${windowEndIso}`);
    lines.push(`- Window: ${windowStartIso} -> ${windowEndIso}`);
    lines.push(`- Total cost: $${totalCostUsd.toFixed(6)}`);
    lines.push(`- Total tokens: ${totalTokens}`);
    lines.push(`- Tracked events: ${usageAvailability.trackedEvents}`);
    lines.push(`- Usage unavailable events: ${usageAvailability.unknownEvents}`);
    lines.push(`- Total agent events: ${usageAvailability.totalAgentEvents}`);
    lines.push("");

    const appendSummaryTable = (
      title: string,
      keyLabel: string,
      rows: Array<{
        key: string;
        tokenInput: number;
        tokenOutput: number;
        tokenCachedInput: number;
        tokenTotal: number;
        costUsd: number;
      }>,
    ) => {
      lines.push(`## ${title}`);
      lines.push("");
      if (rows.length === 0) {
        lines.push("_No data in this window._");
        lines.push("");
        return;
      }
      lines.push(`| ${keyLabel} | Token In | Token Out | Cached In | Token Total | Cost USD |`);
      lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
      for (const row of rows) {
        lines.push(
          `| ${row.key || "-"} | ${row.tokenInput} | ${row.tokenOutput} | ${row.tokenCachedInput} | ${row.tokenTotal} | ${row.costUsd.toFixed(6)} |`,
        );
      }
      lines.push("");
    };

    appendSummaryTable("By Session", "Session", bySession.slice(0, 25));
    appendSummaryTable("By Agent", "Agent", byAgent.slice(0, 25));
    appendSummaryTable("By Task", "Task", byTask.slice(0, 25));
    appendSummaryTable("By Day", "Day", byDay.slice(0, 25));

    const reportDir = path.join(deps.rootDir, COST_REPORT_OUTPUT_DIR);
    await fs.mkdir(reportDir, { recursive: true });
    const reportFileName = `cost-report-${hourKey}.md`;
    const outputPath = path.join(reportDir, reportFileName);
    await fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");

    deps.storage.systemSettings.set(COST_REPORT_HOURLY_DEDUP_SETTING_KEY, hourKey);
    const finishedAt = new Date().toISOString();
    const summary = {
      type: "cost_report_hourly",
      outputPath,
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      totalTokens,
      trackedEvents: usageAvailability.trackedEvents,
      unknownEvents: usageAvailability.unknownEvents,
      windowStartIso,
      windowEndIso,
    };
    if (shouldRecordSystemCronState(options)) {
      recordSystemCronRunSuccess(deps, job, {
        runId,
        finishedAtIso: finishedAt,
        nextRunAt: computeSystemCronNextRunAt(job, finishedAt, 60 * 60 * 1000),
        summary,
      });
    }
    deps.publishRealtime("cron_job_run", "cron", {
      ...summary,
      jobId: COST_REPORT_HOURLY_JOB_ID,
    });
  });
}

export async function runUpdateReviewSchedulerIfDue(
  deps: SystemCronSchedulerDeps,
  options: SystemCronSchedulerOptions = {},
): Promise<void> {
  const job = deps.storage.cronJobs.get(UPDATE_REVIEW_DAILY_JOB_ID);
  if (!job?.enabled) {
    return;
  }
  const now = new Date();
  if (!options.force && isCronJobBackedOff(job, now)) {
    return;
  }
  if (
    !options.force &&
    !isCronJobDueNow(job, now, {
      defaultHour: 4,
      defaultMinute: 15,
      defaultWeekday: undefined,
      defaultTimeZone: UPDATE_REVIEW_DAILY_TIME_ZONE,
    })
  ) {
    return;
  }
  const dayKey = toDayKeyForTimezone(now, UPDATE_REVIEW_DAILY_TIME_ZONE);
  const lastDayKey = deps.storage.systemSettings.get<string>(UPDATE_REVIEW_DAILY_DEDUP_SETTING_KEY)?.value;
  if (!options.force && dayKey === lastDayKey) {
    return;
  }

  await runSystemCronBody(deps, job, options, async ({ runId }) => {
    const report = await createDailyUpdateReview(deps.rootDir);
    const reportDir = path.join(deps.rootDir, UPDATE_REVIEW_OUTPUT_DIR);
    await fs.mkdir(reportDir, { recursive: true });
    const reportFileName = `update-review-${dayKey}.md`;
    const outputPath = path.join(reportDir, reportFileName);
    await fs.writeFile(outputPath, `${renderUpdateReviewMarkdown(report)}\n`, "utf8");

    deps.storage.systemSettings.set(UPDATE_REVIEW_DAILY_DEDUP_SETTING_KEY, dayKey);
    const finishedAt = new Date().toISOString();
    const summary = {
      type: "update_review_daily",
      outputPath,
      outdatedDependencyCount: report.summary.outdatedDependencyCount,
      changedSkillSourceCount: report.summary.changedSkillSourceCount,
      warningCount: report.summary.warningCount,
      checkedSkillCount: report.summary.checkedSkillCount,
    };
    if (shouldRecordSystemCronState(options)) {
      recordSystemCronRunSuccess(deps, job, {
        runId,
        finishedAtIso: finishedAt,
        nextRunAt: computeSystemCronNextRunAt(job, finishedAt, 24 * 60 * 60 * 1000),
        summary,
      });
    }

    const hasAlerts =
      report.summary.outdatedDependencyCount > 0 ||
      report.summary.changedSkillSourceCount > 0 ||
      report.summary.warningCount > 0;
    if (deps.isFeatureEnabled("cronReviewQueueV1Enabled")) {
      deps.recordCronReviewItem({
        jobId: UPDATE_REVIEW_DAILY_JOB_ID,
        runId,
        severity: hasAlerts ? "medium" : "low",
        status: hasAlerts ? "open" : "resolved",
        summary: {
          trigger: options.force ? "manual_run" : "scheduler",
          outputPath: path.relative(deps.rootDir, outputPath).replaceAll("\\", "/"),
          outdatedDependencyCount: report.summary.outdatedDependencyCount,
          changedSkillSourceCount: report.summary.changedSkillSourceCount,
          warningCount: report.summary.warningCount,
          checkedSkillCount: report.summary.checkedSkillCount,
        },
        diff: {
          type: "update_review_daily",
          changed: hasAlerts,
          outdatedDependencyCount: report.summary.outdatedDependencyCount,
          changedSkillSourceCount: report.summary.changedSkillSourceCount,
          warningCount: report.summary.warningCount,
        },
      });
    }

    deps.publishRealtime("cron_job_run", "cron", {
      ...summary,
      jobId: UPDATE_REVIEW_DAILY_JOB_ID,
    });
  });
}

function isCronJobDueNow(
  job: CronJobRecord,
  now: Date,
  defaults: {
    defaultMinute: number;
    defaultHour: number;
    defaultWeekday?: number;
    defaultTimeZone: string;
  },
): boolean {
  if (job.endAt) {
    const endAt = Date.parse(job.endAt);
    if (Number.isFinite(endAt) && endAt < now.getTime()) {
      return false;
    }
  }
  const parsed = parseSimpleCronSchedule(job.schedule);
  const minute = parsed?.minute ?? defaults.defaultMinute;
  const hour = parsed?.hour ?? defaults.defaultHour;
  const hourStep = parsed?.hourStep;
  const wildcardMinute = parsed?.wildcardMinute ?? false;
  const wildcardHour = parsed?.wildcardHour ?? false;
  const wildcardWeekday = parsed?.wildcardWeekday ?? false;
  const weekdays = parsed?.weekdays ?? (defaults.defaultWeekday === undefined ? undefined : [defaults.defaultWeekday]);
  const timeZone = parsed?.timeZone ?? defaults.defaultTimeZone;
  const window = getZonedDateParts(now, timeZone);
  if (!wildcardHour) {
    if (hourStep !== undefined) {
      if (window.hour % hourStep !== 0) {
        return false;
      }
    } else if (window.hour !== hour) {
      return false;
    }
  }
  if (!wildcardMinute && (window.minute < minute || window.minute >= minute + 5)) {
    return false;
  }
  if (!wildcardWeekday && weekdays?.length && !weekdays.includes(window.weekday)) {
    return false;
  }
  return true;
}

function parseSimpleCronSchedule(value: string): {
  minute?: number;
  hour?: number;
  hourStep?: number;
  weekdays?: number[];
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
  let hourStep: number | undefined;
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
    if (/^\*\/\d+$/.test(hourRaw)) {
      hourStep = Number.parseInt(hourRaw.slice(2), 10);
      if (!Number.isFinite(hourStep) || hourStep < 1 || hourStep > 23) {
        return null;
      }
    } else if (!/^\d+$/.test(hourRaw)) {
      return null;
    } else {
      hour = Number.parseInt(hourRaw, 10);
      if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
        return null;
      }
    }
  }
  let weekdays: number[] | undefined;
  const wildcardWeekday = dayOfWeekRaw === "*";
  if (!wildcardWeekday) {
    const parsedWeekdays = [...new Set(dayOfWeekRaw.split(",").map((token) => Number.parseInt(token, 10)))];
    if (
      parsedWeekdays.length === 0 ||
      parsedWeekdays.some((weekday) => !Number.isFinite(weekday) || weekday < 0 || weekday > 6)
    ) {
      return null;
    }
    weekdays = parsedWeekdays.sort((left, right) => left - right);
  }
  const timeZone = timezoneParts.length > 0 ? timezoneParts.join(" ") : undefined;
  if (timeZone) {
    try {
      // Validate timezone eagerly so invalid values fail closed at write-time.
      new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    } catch {
      return null;
    }
  }
  return {
    minute,
    hour,
    hourStep,
    weekdays,
    timeZone,
    wildcardMinute,
    wildcardHour,
    wildcardWeekday,
  };
}
