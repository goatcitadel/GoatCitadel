import { randomUUID } from "node:crypto";
import type {
  CronJobRecord,
  CronReviewItem,
  CronRunDiff,
  CronWatchdogCheckId,
  CronWatchdogRunResult,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

export const IMPROVEMENT_WEEKLY_JOB_ID = "self_improvement_weekly_replay";
export const PRIVATE_BETA_BACKUP_JOB_ID = "private_beta_backup_daily";
export const MEMORY_FLUSH_DAILY_JOB_ID = "memory-flush-daily";
export const COST_REPORT_HOURLY_JOB_ID = "cost-report-hourly";
export const UPDATE_REVIEW_DAILY_JOB_ID = "update-review-daily";

interface CronReviewRow {
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
}

interface CronRunSnapshot {
  runId: string;
  jobId: string;
  status: "ok";
  finishedAt?: string;
  output?: string;
}

interface CronRunDiffRow {
  diff_id: string;
  run_id: string;
  previous_run_id: string | null;
  diff_json: string;
  created_at: string;
}

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
  publishRealtime: (eventType: string, source: string, payload?: Record<string, unknown>) => void;
  requireFeatureEnabled: (flag: "cronReviewQueueV1Enabled") => void;
  isFeatureEnabled: (flag: "cronReviewQueueV1Enabled") => boolean;
  runHandlers: {
    task: (
      job: CronJobRecord,
      context?: { contextFrom?: string; contextOutput?: string },
    ) => Promise<{ taskId?: string } | void>;
    improvement: () => Promise<void>;
    backup: () => Promise<void>;
    memoryFlush: () => Promise<void>;
    costReport: () => Promise<void>;
    updateReview: () => Promise<void>;
    watchdog: (job: CronJobRecord) => Promise<CronWatchdogRunResult>;
    noAgent: (input: {
      command: string;
      args?: string[];
      workdir?: string;
      timeoutMs?: number;
    }) => Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;
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
    action?: CronJobRecord["action"];
    description?: string;
    schedule: string;
    enabled?: boolean;
    endAt?: string;
    actionConfig?: unknown;
    workdir?: string;
    contextFrom?: string;
  }): CronJobRecord {
    const jobId = normalizeCronJobId(input.jobId);
    if (this.deps.storage.cronJobs.get(jobId)) {
      throw new Error(`Cron job already exists: ${jobId}`);
    }
    const action = normalizeCronJobAction(input.action);
    const job: CronJobRecord = {
      jobId,
      name: normalizeCronJobName(input.name),
      action,
      actionConfig: normalizeCronJobActionConfig(input.actionConfig, action),
      description: normalizeCronJobDescription(input.description),
      schedule: normalizeCronSchedule(input.schedule),
      enabled: input.enabled ?? true,
      endAt: normalizeCronEndAt(input.endAt),
      lastRunAt: undefined,
      nextRunAt: undefined,
      workdir: normalizeCronWorkdir(input.workdir),
      contextFrom: normalizeCronContextFrom(input.contextFrom),
    };
    if (isScheduledCronAction(job.action)) {
      job.nextRunAt = computeNextCronRunAt(job.schedule, new Date(), job.endAt);
    }
    const saved = this.deps.storage.cronJobs.upsert(job);
    this.deps.persistCronJobsConfig();
    this.deps.publishRealtime("system", "cron", {
      type: "cron_job_created",
      jobId: saved.jobId,
      name: saved.name,
      action: saved.action,
      schedule: saved.schedule,
      enabled: saved.enabled,
    });
    return saved;
  }

  public updateCronJob(
    jobId: string,
    input: {
      name?: string;
      action?: CronJobRecord["action"];
      description?: string;
      schedule?: string;
      enabled?: boolean;
      endAt?: string | null;
      actionConfig?: unknown;
      workdir?: string | null;
      contextFrom?: string | null;
    },
  ): CronJobRecord {
    const current = this.getCronJob(jobId);
    const action = input.action !== undefined ? normalizeCronJobAction(input.action) : current.action;
    const updated: CronJobRecord = {
      ...current,
      name: input.name !== undefined ? normalizeCronJobName(input.name) : current.name,
      action,
      actionConfig:
        input.actionConfig !== undefined
          ? normalizeCronJobActionConfig(input.actionConfig, action)
          : action === current.action
            ? current.actionConfig
            : undefined,
      description:
        input.description !== undefined ? normalizeCronJobDescription(input.description) : current.description,
      schedule: input.schedule !== undefined ? normalizeCronSchedule(input.schedule) : current.schedule,
      enabled: input.enabled ?? current.enabled,
      endAt: input.endAt !== undefined ? normalizeCronEndAt(input.endAt) : current.endAt,
      workdir: input.workdir !== undefined ? normalizeCronWorkdir(input.workdir) : current.workdir,
      contextFrom: input.contextFrom !== undefined ? normalizeCronContextFrom(input.contextFrom) : current.contextFrom,
    };
    if (isScheduledCronAction(updated.action)) {
      updated.nextRunAt = computeNextCronRunAt(updated.schedule, new Date(), updated.endAt);
    }
    const saved = this.deps.storage.cronJobs.upsert(updated);
    this.deps.persistCronJobsConfig();
    this.deps.publishRealtime("system", "cron", {
      type: "cron_job_updated",
      jobId: saved.jobId,
      name: saved.name,
      action: saved.action,
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

  public async runCronJobNow(jobId: string): Promise<{ jobId: string; runId: string; status: "ok" }> {
    const normalizedJobId = normalizeCronJobId(jobId);
    const job = this.getCronJob(normalizedJobId);
    if (!job.enabled) {
      throw new Error(`Cron job is paused: ${normalizedJobId}`);
    }
    if (job.endAt && Date.parse(job.endAt) < Date.now()) {
      throw new Error(`Cron job has ended: ${normalizedJobId}`);
    }
    const runId = randomUUID();
    let runSummary: Record<string, unknown> = { result: "ok" };
    let watchdogReviewRecorded = false;
    if (job.action === "task") {
      const context = this.resolveCronJobContext(job);
      const taskResult = await this.deps.runHandlers.task(job, context);
      const finishedAt = new Date().toISOString();
      const saved = this.deps.storage.cronJobs.upsert(
        {
          ...job,
          lastRunAt: finishedAt,
          lastRunId: runId,
          nextRunAt: computeNextCronRunAt(job.schedule, new Date(finishedAt), job.endAt),
        },
        finishedAt,
      );
      this.deps.persistCronJobsConfig();
      runSummary = {
        ...runSummary,
        action: job.action,
        taskId: taskResult?.taskId,
        nextRunAt: saved.nextRunAt,
        contextFrom: context?.contextFrom,
      };
      this.deps.publishRealtime("cron_job_run", "cron", {
        type: "scheduled_task_created",
        jobId: saved.jobId,
        taskId: taskResult?.taskId,
        name: saved.name,
        contextFrom: context?.contextFrom,
      });
    } else if (job.action === "watchdog") {
      const watchdogResult = await this.deps.runHandlers.watchdog(job);
      const finishedAt = new Date().toISOString();
      const saved = this.deps.storage.cronJobs.upsert(
        {
          ...job,
          lastRunAt: finishedAt,
          lastRunId: runId,
          nextRunAt: computeNextCronRunAt(job.schedule, new Date(finishedAt), job.endAt),
        },
        finishedAt,
      );
      this.deps.persistCronJobsConfig();
      runSummary = {
        ...runSummary,
        action: job.action,
        watchdogStatus: watchdogResult.status,
        checkId: watchdogResult.checkId,
        summary: watchdogResult.summary,
        nextRunAt: saved.nextRunAt,
      };
      if (watchdogResult.status !== "ok") {
        this.deps.publishRealtime("cron_job_run", "cron", {
          type: "watchdog_check_attention_required",
          jobId: saved.jobId,
          name: saved.name,
          checkId: watchdogResult.checkId,
          status: watchdogResult.status,
          summary: watchdogResult.summary,
        });
        if (this.deps.isFeatureEnabled("cronReviewQueueV1Enabled") && shouldRecordWatchdogReview(job, watchdogResult)) {
          this.recordCronReviewItem({
            jobId: normalizedJobId,
            runId: randomUUID(),
            severity: watchdogResult.status === "error" ? "high" : "medium",
            status: "open",
            summary: {
              trigger: "watchdog",
              checkId: watchdogResult.checkId,
              status: watchdogResult.status,
              summary: watchdogResult.summary,
              notifyHomeChannel: watchdogResult.notifyHomeChannel,
              ...(watchdogResult.details ? { details: watchdogResult.details } : {}),
            },
            diff: {
              type: "watchdog",
              changed: false,
            },
          });
          watchdogReviewRecorded = true;
        }
      }
    } else if (job.action === "improvement") {
      await this.deps.runHandlers.improvement();
    } else if (job.action === "backup") {
      await this.deps.runHandlers.backup();
    } else if (job.action === "memory_flush") {
      await this.deps.runHandlers.memoryFlush();
    } else if (job.action === "cost_report") {
      await this.deps.runHandlers.costReport();
    } else if (job.action === "update_review") {
      await this.deps.runHandlers.updateReview();
    } else if (job.action === "no_agent") {
      const noAgentConfig = job.actionConfig?.noAgent;
      if (!noAgentConfig?.command) {
        throw new Error(`no_agent cron job missing command: ${normalizedJobId}`);
      }
      const runResult = await this.deps.runHandlers.noAgent({
        command: noAgentConfig.command,
        args: noAgentConfig.args,
        workdir: job.workdir,
        timeoutMs: noAgentConfig.timeoutMs,
      });
      const finishedAt = new Date().toISOString();
      const stdoutTrimmed = runResult.stdout.replace(/\r?\n$/, "");
      const hasOutput = stdoutTrimmed.length > 0;
      const saved = this.deps.storage.cronJobs.upsert(
        {
          ...job,
          lastRunAt: finishedAt,
          lastRunOutput: hasOutput ? stdoutTrimmed : undefined,
          lastRunId: runId,
          nextRunAt: computeNextCronRunAt(job.schedule, new Date(finishedAt), job.endAt),
        },
        finishedAt,
      );
      this.deps.persistCronJobsConfig();
      runSummary = {
        ...runResult,
        action: job.action,
        runId,
        hasOutput,
        nextRunAt: saved.nextRunAt,
      };
      if (hasOutput) {
        this.deps.publishRealtime("cron_job_run", "cron", {
          type: "cron_no_agent_output",
          jobId: saved.jobId,
          runId,
          output: stdoutTrimmed,
          deliveryChannel: noAgentConfig.deliveryChannel,
        });
      }
    } else {
      throw new Error(`Cron job has no runnable handler: ${normalizedJobId}`);
    }
    if (
      this.deps.isFeatureEnabled("cronReviewQueueV1Enabled") &&
      job.action !== "watchdog" &&
      !watchdogReviewRecorded
    ) {
      this.recordCronReviewItem({
        jobId: normalizedJobId,
        runId: randomUUID(),
        severity: "low",
        status: "resolved",
        summary: {
          trigger: "manual_run",
          ...runSummary,
        },
        diff: { type: "manual_run", changed: false },
      });
    }
    return {
      jobId: normalizedJobId,
      runId,
      status: "ok",
    };
  }

  public async runDueTaskCronJobs(now = new Date()): Promise<void> {
    const jobs = this.deps.storage.cronJobs
      .list()
      .filter((job) => isScheduledCronAction(job.action) && job.enabled && !SYSTEM_CRON_JOB_IDS.has(job.jobId));
    for (const job of jobs) {
      if (!isCronJobActive(job, now)) {
        continue;
      }
      if (!isExplicitCronJobDueNow(job, now)) {
        continue;
      }
      if (didCronJobRunInCurrentWindow(job, now)) {
        continue;
      }
      await this.runCronJobNow(job.jobId);
    }
  }

  public findCronRunById(runId: string): CronRunSnapshot | undefined {
    const normalized = runId.trim();
    if (!normalized) {
      return undefined;
    }
    const match = this.deps.storage.cronJobs.list().find((job) => job.lastRunId === normalized);
    if (!match) {
      return undefined;
    }
    return {
      runId: normalized,
      jobId: match.jobId,
      status: "ok",
      finishedAt: match.lastRunAt,
      output: match.lastRunOutput,
    };
  }

  public listCronReviewQueue(limit = 200): CronReviewItem[] {
    this.deps.requireFeatureEnabled("cronReviewQueueV1Enabled");
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = this.deps.storage.db
      .prepare(
        `
      SELECT item_id, job_id, run_id, severity, status, summary_json, diff_json, created_at, updated_at, resolved_at
      FROM cron_review_items
      ORDER BY updated_at DESC
      LIMIT ?
    `,
      )
      .all(safeLimit) as CronReviewRow[];
    return rows.map((row) => mapCronReviewItemRow(row));
  }

  public retryCronReviewQueueItem(itemId: string): CronReviewItem {
    this.deps.requireFeatureEnabled("cronReviewQueueV1Enabled");
    const existing = this.deps.storage.db
      .prepare(
        `
      SELECT item_id, job_id, run_id, severity, status, summary_json, diff_json, created_at, updated_at, resolved_at
      FROM cron_review_items
      WHERE item_id = ?
    `,
      )
      .get(itemId) as CronReviewRow | undefined;
    if (!existing) {
      throw new Error(`Cron review item not found: ${itemId}`);
    }

    const retriedRunId = randomUUID();
    const now = new Date().toISOString();
    let updated: CronReviewRow | undefined;
    this.deps.storage.db.exec("BEGIN IMMEDIATE");
    try {
      this.deps.storage.db
        .prepare(
          `
        UPDATE cron_review_items
        SET status = 'retrying',
            run_id = @runId,
            updated_at = @updatedAt,
            resolved_at = NULL
        WHERE item_id = @itemId
      `,
        )
        .run({
          itemId,
          runId: retriedRunId,
          updatedAt: now,
        });
      this.deps.storage.db
        .prepare(
          `
        INSERT INTO cron_run_diffs (diff_id, run_id, previous_run_id, diff_json, created_at)
        VALUES (@diffId, @runId, @previousRunId, @diffJson, @createdAt)
      `,
        )
        .run({
          diffId: randomUUID(),
          runId: retriedRunId,
          previousRunId: existing.run_id,
          diffJson: JSON.stringify({ retried: true, previousRunId: existing.run_id }),
          createdAt: now,
        });
      updated = this.deps.storage.db
        .prepare(
          `
        SELECT item_id, job_id, run_id, severity, status, summary_json, diff_json, created_at, updated_at, resolved_at
        FROM cron_review_items
        WHERE item_id = ?
      `,
        )
        .get(itemId) as CronReviewRow | undefined;
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
    const row = this.deps.storage.db
      .prepare(
        `
      SELECT diff_id, run_id, previous_run_id, diff_json, created_at
      FROM cron_run_diffs
      WHERE run_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
      )
      .get(runId) as CronRunDiffRow | undefined;
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

  private resolveCronJobContext(job: CronJobRecord): { contextFrom?: string; contextOutput?: string } | undefined {
    if (!job.contextFrom) {
      return undefined;
    }
    const upstream = this.deps.storage.cronJobs.get(job.contextFrom);
    return {
      contextFrom: job.contextFrom,
      contextOutput: upstream?.lastRunOutput,
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
    this.deps.storage.db
      .prepare(
        `
      INSERT INTO cron_review_items (
        item_id, job_id, run_id, severity, status, summary_json, diff_json, created_at, updated_at, resolved_at
      ) VALUES (
        @itemId, @jobId, @runId, @severity, @status, @summaryJson, @diffJson, @createdAt, @updatedAt, @resolvedAt
      )
    `,
      )
      .run({
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

function mapCronReviewItemRow(row: CronReviewRow): CronReviewItem {
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

export function normalizeCronJobAction(value: CronJobRecord["action"] | undefined): CronJobRecord["action"] {
  return value ?? "task";
}

function normalizeCronJobActionConfig(
  value: unknown,
  action: CronJobRecord["action"],
): CronJobRecord["actionConfig"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const rawValue = value as Record<string, unknown>;
  if (action === "watchdog") {
    const rawWatchdog =
      rawValue.watchdog && typeof rawValue.watchdog === "object" && !Array.isArray(rawValue.watchdog)
        ? (rawValue.watchdog as Record<string, unknown>)
        : {};
    const checkId = normalizeWatchdogCheckId(rawWatchdog.checkId);
    const severityThreshold = rawWatchdog.severityThreshold === "error" ? "error" : "warning";
    return {
      watchdog: {
        checkId,
        severityThreshold,
        notifyHomeChannel: rawWatchdog.notifyHomeChannel === true,
      },
    };
  }
  if (action === "no_agent") {
    const rawNoAgent =
      rawValue.noAgent && typeof rawValue.noAgent === "object" && !Array.isArray(rawValue.noAgent)
        ? (rawValue.noAgent as Record<string, unknown>)
        : undefined;
    if (!rawNoAgent || typeof rawNoAgent.command !== "string" || !rawNoAgent.command.trim()) {
      throw new Error("no_agent cron job requires actionConfig.noAgent.command.");
    }
    const args = Array.isArray(rawNoAgent.args)
      ? rawNoAgent.args.filter((token): token is string => typeof token === "string")
      : undefined;
    const timeoutMs =
      typeof rawNoAgent.timeoutMs === "number" && Number.isFinite(rawNoAgent.timeoutMs) && rawNoAgent.timeoutMs > 0
        ? Math.floor(rawNoAgent.timeoutMs)
        : undefined;
    const rawChannel =
      rawNoAgent.deliveryChannel &&
      typeof rawNoAgent.deliveryChannel === "object" &&
      !Array.isArray(rawNoAgent.deliveryChannel)
        ? (rawNoAgent.deliveryChannel as Record<string, unknown>)
        : undefined;
    const deliveryChannel =
      rawChannel && typeof rawChannel.channelKey === "string"
        ? {
            channelKey: rawChannel.channelKey,
            target: typeof rawChannel.target === "string" ? rawChannel.target : undefined,
          }
        : undefined;
    return {
      noAgent: {
        command: rawNoAgent.command.trim(),
        ...(args ? { args } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
        ...(deliveryChannel ? { deliveryChannel } : {}),
      },
    };
  }
  return undefined;
}

function normalizeWatchdogCheckId(value: unknown): CronWatchdogCheckId {
  if (
    value === "runtime_health" ||
    value === "durable_dead_letters" ||
    value === "channel_delivery_queue" ||
    value === "mcp_posture"
  ) {
    return value;
  }
  return "runtime_health";
}

function isScheduledCronAction(action: CronJobRecord["action"]): boolean {
  return action === "task" || action === "watchdog" || action === "no_agent";
}

function shouldRecordWatchdogReview(job: CronJobRecord, result: CronWatchdogRunResult): boolean {
  const threshold = job.actionConfig?.watchdog?.severityThreshold ?? "warning";
  if (threshold === "error") {
    return result.status === "error";
  }
  return result.status === "warning" || result.status === "error";
}

export function normalizeCronJobDescription(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > 2000) {
    throw new Error("Cron job description must be 2000 characters or less.");
  }
  return normalized;
}

export function normalizeCronEndAt(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error("Cron end date must be a valid ISO date/time.");
  }
  return new Date(parsed).toISOString();
}

export function normalizeCronSchedule(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Cron schedule is required.");
  }
  if (!parseSimpleCronSchedule(normalized)) {
    throw new Error(
      "Cron schedule must look like 'M H * * * [Timezone]', 'M H * * DOW[,DOW] [Timezone]', or 'M */N * * * [Timezone]'.",
    );
  }
  return normalized;
}

export function parseSimpleCronSchedule(value: string): {
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

export function isCronJobActive(job: CronJobRecord, now: Date): boolean {
  if (!job.endAt) {
    return true;
  }
  const parsed = Date.parse(job.endAt);
  return Number.isFinite(parsed) && parsed >= now.getTime();
}

export function isExplicitCronJobDueNow(job: CronJobRecord, now: Date): boolean {
  const parsed = parseSimpleCronSchedule(job.schedule);
  if (!parsed) {
    return false;
  }
  return doesCronScheduleMatch(parsed, now);
}

export function didCronJobRunInCurrentWindow(job: CronJobRecord, now: Date): boolean {
  if (!job.lastRunAt) {
    return false;
  }
  const parsed = parseSimpleCronSchedule(job.schedule);
  if (!parsed) {
    return false;
  }
  const lastRun = new Date(job.lastRunAt);
  if (Number.isNaN(lastRun.getTime())) {
    return false;
  }
  return cronRunWindowKey(parsed, now) === cronRunWindowKey(parsed, lastRun);
}

export function computeNextCronRunAt(schedule: string, from: Date, endAt?: string): string | undefined {
  const parsed = parseSimpleCronSchedule(schedule);
  if (!parsed) {
    return undefined;
  }
  const limit = endAt ? Date.parse(endAt) : undefined;
  for (let offsetMinutes = 1; offsetMinutes <= 60 * 24 * 30; offsetMinutes += 1) {
    const candidate = new Date(from.getTime() + offsetMinutes * 60_000);
    if (limit !== undefined && candidate.getTime() > limit) {
      return undefined;
    }
    if (doesCronScheduleMatch(parsed, candidate)) {
      return candidate.toISOString();
    }
  }
  return undefined;
}

function doesCronScheduleMatch(parsed: NonNullable<ReturnType<typeof parseSimpleCronSchedule>>, date: Date): boolean {
  const timeZone = parsed.timeZone ?? "UTC";
  const window = getZonedDateParts(date, timeZone);
  if (!parsed.wildcardHour) {
    if (parsed.hourStep !== undefined) {
      if (window.hour % parsed.hourStep !== 0) {
        return false;
      }
    } else if (parsed.hour !== undefined && window.hour !== parsed.hour) {
      return false;
    }
  }
  if (!parsed.wildcardMinute) {
    if (parsed.minute === undefined || window.minute < parsed.minute || window.minute >= parsed.minute + 5) {
      return false;
    }
  }
  if (!parsed.wildcardWeekday && parsed.weekdays?.length && !parsed.weekdays.includes(window.weekday)) {
    return false;
  }
  return true;
}

function cronRunWindowKey(parsed: NonNullable<ReturnType<typeof parseSimpleCronSchedule>>, date: Date): string {
  const parts = getZonedDateParts(date, parsed.timeZone ?? "UTC");
  return [parsed.timeZone ?? "UTC", parts.year, parts.month, parts.day, parts.hour, parts.minute].join(":");
}

function getZonedDateParts(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = formatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return {
    year: Number.parseInt(part("year"), 10),
    month: Number.parseInt(part("month"), 10),
    day: Number.parseInt(part("day"), 10),
    hour: Number.parseInt(part("hour"), 10),
    minute: Number.parseInt(part("minute"), 10),
    weekday: weekdayLabelToNumber(part("weekday")),
  };
}

export function normalizeCronWorkdir(value: string | undefined | null): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 1024) {
    throw new Error("Cron workdir must be 1024 characters or less.");
  }
  return trimmed;
}

export function normalizeCronContextFrom(value: string | undefined | null): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  // Validate via existing id rules.
  return normalizeCronJobId(trimmed);
}

function weekdayLabelToNumber(label: string): number {
  switch (label.toLowerCase()) {
    case "sun":
      return 0;
    case "mon":
      return 1;
    case "tue":
      return 2;
    case "wed":
      return 3;
    case "thu":
      return 4;
    case "fri":
      return 5;
    default:
      return 6;
  }
}
