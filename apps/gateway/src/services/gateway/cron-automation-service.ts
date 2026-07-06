/* eslint-disable max-lines -- Cron automation keeps scheduling, run lookup, failure metadata, and operator actions co-located while gateway ownership is still centralized. */
import { createHash, randomUUID } from "node:crypto";
import type {
  CronJobRecord,
  CronReviewItem,
  CronRunDiff,
  CronWatchdogCheckId,
  CronWatchdogRunResult,
} from "@goatcitadel/contracts";
import type { EvidenceEnvelopeCreateRequest } from "../evidence-envelope-service.js";
import type { Storage } from "@goatcitadel/storage";
import {
  type AgentTurnCronRunHandler,
  normalizeAgentTurnCronActionConfig,
  runAgentTurnCronJob,
} from "./cron-agent-turn-support.js";
import {
  assertCronActionMutationAllowed,
  isCronActionEnabledForScheduledRun,
  normalizeNoAgentCronActionConfig,
  runNoAgentCronJob,
} from "./cron-no-agent-support.js";
import {
  COST_REPORT_HOURLY_JOB_ID,
  IMPROVEMENT_WEEKLY_JOB_ID,
  MEMORY_CONSOLIDATION_WEEKLY_JOB_ID,
  MEMORY_FLUSH_DAILY_JOB_ID,
  PRIVATE_BETA_BACKUP_JOB_ID,
  UPDATE_REVIEW_DAILY_JOB_ID,
} from "./cron-job-ids.js";

export {
  buildNoAgentCronDisabledMessage,
  EXPERIMENTAL_NO_AGENT_CRON_ENV,
  isExperimentalNoAgentCronEnabled,
} from "./cron-no-agent-support.js";

export {
  COST_REPORT_HOURLY_JOB_ID,
  IMPROVEMENT_WEEKLY_JOB_ID,
  MEMORY_CONSOLIDATION_WEEKLY_JOB_ID,
  MEMORY_FLUSH_DAILY_JOB_ID,
  PRIVATE_BETA_BACKUP_JOB_ID,
  UPDATE_REVIEW_DAILY_JOB_ID,
} from "./cron-job-ids.js";

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

export interface CronRunSnapshot {
  runId: string;
  jobId: string;
  status: "ok" | "failed" | "unknown";
  finishedAt?: string;
  output?: string;
  childDurableRunId?: string;
  childDurableStatus?: string;
  childTurnId?: string;
  profilePosture?: string;
  /** Signed evidence envelope for this run (present when cronEvidenceV1Enabled). */
  evidenceEnvelopeId?: string;
  failure?: CronJobRecord["lastFailure"];
  failureCount?: number;
  backoffUntil?: string;
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
  MEMORY_CONSOLIDATION_WEEKLY_JOB_ID,
  COST_REPORT_HOURLY_JOB_ID,
  UPDATE_REVIEW_DAILY_JOB_ID,
]);

const CRON_FAILURE_MESSAGE_MAX_LENGTH = 500;
const CRON_BACKOFF_BASE_MS = 60_000;
const CRON_BACKOFF_MAX_MS = 60 * 60_000;

export interface CronRunOptions {
  force?: boolean;
  reason?: string;
}

export interface CronRunResult {
  jobId: string;
  runId: string;
  status: "ok";
  force?: boolean;
  childDurableRunId?: string;
  childDurableStatus?: string;
  childTurnId?: string;
  profilePosture?: string;
}

export interface CronDueRunItem {
  jobId: string;
  status: "ran" | "failed" | "backoff";
  runId?: string;
  error?: string;
  failureCount?: number;
  backoffUntil?: string;
}

export interface CronDueRunSummary {
  checkedAt: string;
  dueCount: number;
  ranCount: number;
  failedCount: number;
  backoffCount: number;
  items: CronDueRunItem[];
}

export interface CronAutomationServiceDeps {
  storage: Storage;
  persistCronJobsConfig: () => void;
  publishRealtime: (eventType: string, source: string, payload?: Record<string, unknown>) => void;
  requireFeatureEnabled: (flag: "cronReviewQueueV1Enabled") => void;
  isFeatureEnabled: (flag: "cronReviewQueueV1Enabled" | "cronEvidenceV1Enabled") => boolean;
  /**
   * Records a signed evidence envelope for a completed/failed cron run.
   * Optional and best-effort: envelope failure must never fail the run
   * (the gateway wiring wraps createEnvelope in a diagnostic try/catch).
   */
  recordEvidenceEnvelope?: (input: EvidenceEnvelopeCreateRequest) => { envelopeId: string } | undefined;
  runHandlers: {
    task: (
      job: CronJobRecord,
      context?: { contextFrom?: string; contextOutput?: string },
    ) => Promise<{ taskId?: string } | void>;
    improvement: () => Promise<void>;
    backup: () => Promise<void>;
    memoryFlush: () => Promise<void>;
    memoryConsolidation: () => Promise<void>;
    costReport: () => Promise<void>;
    updateReview: () => Promise<void>;
    curator: () => Promise<void>;
    watchdog: (job: CronJobRecord) => Promise<CronWatchdogRunResult>;
    noAgent: (input: {
      command: string;
      args?: string[];
      workdir?: string;
      timeoutMs?: number;
    }) => Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;
    agentTurn: AgentTurnCronRunHandler;
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
    lastRunOutput?: string;
    lastRunId?: string;
  }): CronJobRecord {
    const jobId = normalizeCronJobId(input.jobId);
    if (this.deps.storage.cronJobs.get(jobId)) {
      throw new Error(`Cron job already exists: ${jobId}`);
    }
    const action = normalizeCronJobAction(input.action);
    assertCronActionMutationAllowed(action, "create");
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
      lastRunOutput: normalizeCronLastRunOutput(input.lastRunOutput),
      lastRunId: normalizeCronLastRunId(input.lastRunId),
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
      lastRunOutput?: string | null;
      lastRunId?: string | null;
    },
  ): CronJobRecord {
    const current = this.getCronJob(jobId);
    const action = input.action !== undefined ? normalizeCronJobAction(input.action) : current.action;
    assertCronActionMutationAllowed(action, "update", current, input);
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
      lastRunOutput:
        input.lastRunOutput !== undefined ? normalizeCronLastRunOutput(input.lastRunOutput) : current.lastRunOutput,
      lastRunId: input.lastRunId !== undefined ? normalizeCronLastRunId(input.lastRunId) : current.lastRunId,
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

  public async runCronJobNow(jobId: string, options: CronRunOptions = {}): Promise<CronRunResult> {
    const normalizedJobId = normalizeCronJobId(jobId);
    const job = this.getCronJob(normalizedJobId);
    const force = options.force === true;
    if (!force && !job.enabled) {
      throw new Error(`Cron job is paused: ${normalizedJobId}`);
    }
    if (!force && job.endAt && Date.parse(job.endAt) < Date.now()) {
      throw new Error(`Cron job has ended: ${normalizedJobId}`);
    }
    if (!force && isCronJobBackedOff(job, new Date())) {
      throw new Error(`Cron job is in backoff until ${job.backoffUntil}: ${normalizedJobId}`);
    }
    const runId = randomUUID();
    let runSummary: Record<string, unknown> = { result: "ok" };
    let watchdogReviewRecorded = false;
    try {
      if (job.action === "task") {
        const context = this.resolveCronJobContext(job);
        const taskResult = await this.deps.runHandlers.task(job, context);
        const finishedAt = new Date().toISOString();
        const saved = this.recordCronRunSuccess(job, runId, finishedAt);
        runSummary = {
          ...runSummary,
          action: job.action,
          taskId: taskResult?.taskId,
          nextRunAt: saved.nextRunAt,
          contextFrom: context?.contextFrom,
          force,
          reason: options.reason,
        };
        this.deps.publishRealtime("cron_job_run", "cron", {
          type: "scheduled_task_created",
          jobId: saved.jobId,
          taskId: taskResult?.taskId,
          name: saved.name,
          contextFrom: context?.contextFrom,
          force,
        });
      } else if (job.action === "watchdog") {
        const watchdogResult = await this.deps.runHandlers.watchdog(job);
        const finishedAt = new Date().toISOString();
        const saved = this.recordCronRunSuccess(job, runId, finishedAt);
        runSummary = {
          ...runSummary,
          action: job.action,
          watchdogStatus: watchdogResult.status,
          checkId: watchdogResult.checkId,
          summary: watchdogResult.summary,
          nextRunAt: saved.nextRunAt,
          force,
          reason: options.reason,
        };
        if (watchdogResult.status !== "ok") {
          this.deps.publishRealtime("cron_job_run", "cron", {
            type: "watchdog_check_attention_required",
            jobId: saved.jobId,
            name: saved.name,
            checkId: watchdogResult.checkId,
            status: watchdogResult.status,
            summary: watchdogResult.summary,
            force,
          });
          if (
            this.deps.isFeatureEnabled("cronReviewQueueV1Enabled") &&
            shouldRecordWatchdogReview(job, watchdogResult)
          ) {
            this.recordCronReviewItem({
              jobId: normalizedJobId,
              runId,
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
        const finishedAt = new Date().toISOString();
        const saved = this.recordCronRunSuccess(job, runId, finishedAt);
        runSummary = { ...runSummary, action: job.action, nextRunAt: saved.nextRunAt, force, reason: options.reason };
      } else if (job.action === "backup") {
        await this.deps.runHandlers.backup();
        const finishedAt = new Date().toISOString();
        const saved = this.recordCronRunSuccess(job, runId, finishedAt);
        runSummary = { ...runSummary, action: job.action, nextRunAt: saved.nextRunAt, force, reason: options.reason };
      } else if (job.action === "memory_flush") {
        await this.deps.runHandlers.memoryFlush();
        const finishedAt = new Date().toISOString();
        const saved = this.recordCronRunSuccess(job, runId, finishedAt);
        runSummary = { ...runSummary, action: job.action, nextRunAt: saved.nextRunAt, force, reason: options.reason };
      } else if (job.action === "memory_consolidation") {
        await this.deps.runHandlers.memoryConsolidation();
        const finishedAt = new Date().toISOString();
        const saved = this.recordCronRunSuccess(job, runId, finishedAt);
        runSummary = { ...runSummary, action: job.action, nextRunAt: saved.nextRunAt, force, reason: options.reason };
      } else if (job.action === "cost_report") {
        await this.deps.runHandlers.costReport();
        const finishedAt = new Date().toISOString();
        const saved = this.recordCronRunSuccess(job, runId, finishedAt);
        runSummary = { ...runSummary, action: job.action, nextRunAt: saved.nextRunAt, force, reason: options.reason };
      } else if (job.action === "update_review") {
        await this.deps.runHandlers.updateReview();
        const finishedAt = new Date().toISOString();
        const saved = this.recordCronRunSuccess(job, runId, finishedAt);
        runSummary = { ...runSummary, action: job.action, nextRunAt: saved.nextRunAt, force, reason: options.reason };
      } else if (job.action === "curator") {
        await this.deps.runHandlers.curator();
        const finishedAt = new Date().toISOString();
        const saved = this.recordCronRunSuccess(job, runId, finishedAt);
        runSummary = {
          ...runSummary,
          action: job.action,
          nextRunAt: saved.nextRunAt,
          force,
          reason: options.reason,
        };
      } else if (job.action === "no_agent") {
        runSummary = await runNoAgentCronJob({
          job,
          normalizedJobId,
          runId,
          runHandler: this.deps.runHandlers.noAgent,
          upsertCronJob: (updatedJob: CronJobRecord, updatedAt: string) =>
            this.deps.storage.cronJobs.upsert(updatedJob, updatedAt),
          persistCronJobsConfig: this.deps.persistCronJobsConfig,
          publishRealtime: this.deps.publishRealtime,
          computeNextCronRunAt,
        });
        runSummary = { ...runSummary, force, reason: options.reason };
      } else if (job.action === "agent_turn") {
        runSummary = await runAgentTurnCronJob({
          job,
          normalizedJobId,
          runId,
          runHandler: this.deps.runHandlers.agentTurn,
          upsertCronJob: (updatedJob: CronJobRecord, updatedAt: string) =>
            this.deps.storage.cronJobs.upsert(updatedJob, updatedAt),
          persistCronJobsConfig: this.deps.persistCronJobsConfig,
          publishRealtime: this.deps.publishRealtime,
          computeNextCronRunAt,
        });
        runSummary = { ...runSummary, force, reason: options.reason };
      } else {
        throw new Error(`Cron job has no runnable handler: ${normalizedJobId}`);
      }
      if (
        this.deps.isFeatureEnabled("cronReviewQueueV1Enabled") &&
        job.action !== "watchdog" &&
        !watchdogReviewRecorded
      ) {
        const warning = readCronReviewWarning(runSummary);
        if (warning) {
          this.recordCronReviewItem({
            jobId: normalizedJobId,
            runId,
            severity: "medium",
            status: "open",
            summary: {
              trigger: "agent_turn_profile_warning",
              ...runSummary,
              warning,
            },
            diff: { type: "agent_turn_profile_warning", changed: false },
          });
          watchdogReviewRecorded = true;
        }
      }
      if (
        this.deps.isFeatureEnabled("cronReviewQueueV1Enabled") &&
        job.action !== "watchdog" &&
        !watchdogReviewRecorded
      ) {
        this.recordCronReviewItem({
          jobId: normalizedJobId,
          runId,
          severity: "low",
          status: "resolved",
          summary: {
            trigger: force ? "force_run" : "manual_run",
            ...runSummary,
          },
          diff: { type: "manual_run", changed: false },
        });
      }
      this.finalizeCronRunEvidenceOnSuccess(normalizedJobId, runId, runSummary);
      const childRun = this.resolveCronChildRunSummary(runSummary);
      return {
        jobId: normalizedJobId,
        runId,
        status: "ok",
        ...(force ? { force: true } : {}),
        ...childRun,
      };
    } catch (error) {
      const latest = this.deps.storage.cronJobs.get(normalizedJobId) ?? job;
      this.recordCronRunFailure(latest, runId, error, new Date(), options);
      throw error;
    }
  }

  public async runDueTaskCronJobs(now = new Date()): Promise<CronDueRunSummary> {
    const summary: CronDueRunSummary = {
      checkedAt: now.toISOString(),
      dueCount: 0,
      ranCount: 0,
      failedCount: 0,
      backoffCount: 0,
      items: [],
    };
    const jobs = this.deps.storage.cronJobs
      .list()
      .filter(
        (job) =>
          isScheduledCronAction(job.action) &&
          isCronActionEnabledForScheduledRun(job.action) &&
          job.enabled &&
          !SYSTEM_CRON_JOB_IDS.has(job.jobId),
      );
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
      summary.dueCount += 1;
      if (isCronJobBackedOff(job, now)) {
        summary.backoffCount += 1;
        summary.items.push({
          jobId: job.jobId,
          status: "backoff",
          failureCount: job.failureCount,
          backoffUntil: job.backoffUntil,
        });
        continue;
      }
      try {
        const result = await this.runCronJobNow(job.jobId, { reason: "scheduled_due" });
        summary.ranCount += 1;
        summary.items.push({ jobId: job.jobId, status: "ran", runId: result.runId });
      } catch (error) {
        const latest = this.deps.storage.cronJobs.get(job.jobId) ?? job;
        summary.failedCount += 1;
        summary.items.push({
          jobId: job.jobId,
          status: "failed",
          error: normalizeCronFailureMessage(error),
          failureCount: latest.failureCount,
          backoffUntil: latest.backoffUntil,
          runId: latest.lastRunId,
        });
      }
    }
    return summary;
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
    const summary = parseJsonRecord(match.lastRunOutput ?? "{}");
    const childRun = this.resolveCronChildRunSummary(summary);
    return {
      runId: normalized,
      jobId: match.jobId,
      status: match.lastRunStatus ?? "unknown",
      finishedAt: match.lastRunAt,
      output: match.lastRunOutput,
      ...childRun,
      evidenceEnvelopeId: match.lastRunEvidenceEnvelopeId,
      failure: match.lastFailure,
      failureCount: match.failureCount,
      backoffUntil: match.backoffUntil,
    };
  }

  private resolveCronChildRunSummary(summary: Record<string, unknown>): {
    childDurableRunId?: string;
    childDurableStatus?: string;
    childTurnId?: string;
    profilePosture?: string;
  } {
    const childDurableRunId = readString(summary.childDurableRunId) ?? readString(summary.durableRunId);
    const childTurnId = readString(summary.childTurnId) ?? readString(summary.turnId);
    const profilePosture = readString(summary.profilePosture);
    let childDurableStatus: string | undefined;
    if (childDurableRunId) {
      try {
        childDurableStatus = this.deps.storage.durableRuns.getRun(childDurableRunId)?.status;
      } catch {
        childDurableStatus = undefined;
      }
    }
    return {
      ...(childDurableRunId ? { childDurableRunId } : {}),
      ...(childDurableStatus ? { childDurableStatus } : {}),
      ...(childTurnId ? { childTurnId } : {}),
      ...(profilePosture ? { profilePosture } : {}),
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
    // Raw "BEGIN IMMEDIATE" is sqlite-only syntax; the helper picks the
    // driver-appropriate transaction statements on Postgres deployments.
    const updated = this.deps.storage.runImmediateTransaction(() => {
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
      return this.deps.storage.db
        .prepare(
          `
        SELECT item_id, job_id, run_id, severity, status, summary_json, diff_json, created_at, updated_at, resolved_at
        FROM cron_review_items
        WHERE item_id = ?
      `,
        )
        .get(itemId) as CronReviewRow | undefined;
    });
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

  private recordCronRunSuccess(job: CronJobRecord, runId: string, finishedAt: string): CronJobRecord {
    const saved = this.deps.storage.cronJobs.upsert(
      {
        ...job,
        lastRunAt: finishedAt,
        lastRunId: runId,
        lastRunStatus: "ok",
        lastRunEvidenceEnvelopeId: undefined,
        lastFailureAt: undefined,
        lastFailure: undefined,
        failureCount: 0,
        backoffUntil: undefined,
        nextRunAt: computeNextCronRunAt(job.schedule, new Date(finishedAt), job.endAt),
      },
      finishedAt,
    );
    this.deps.persistCronJobsConfig();
    return saved;
  }

  /**
   * Emits a signed `cron_job_executed` evidence envelope for a run. Gated on
   * cronEvidenceV1Enabled; returns the envelope id to pin on the job record.
   * The run summary is referenced by hash, not embedded, so envelope size
   * stays bounded and secrets in output never enter the evidence chain.
   */
  private recordCronRunEvidence(
    job: CronJobRecord,
    runId: string,
    status: "ok" | "failed",
    finishedAtIso: string,
    details: { summary?: Record<string, unknown>; failureMessage?: string } = {},
  ): string | undefined {
    const record = this.deps.recordEvidenceEnvelope;
    if (!record || !this.deps.isFeatureEnabled("cronEvidenceV1Enabled")) {
      return undefined;
    }
    const outputHash = details.summary
      ? createHash("sha256").update(JSON.stringify(details.summary), "utf8").digest("hex")
      : undefined;
    const envelope = record({
      eventKind: "cron_job_executed",
      runId,
      createdAt: finishedAtIso,
      metadata: {
        jobId: job.jobId,
        jobName: job.name,
        action: job.action,
        schedule: job.schedule,
        status,
        ...(outputHash ? { outputHash } : {}),
        ...(details.failureMessage ? { failureMessage: details.failureMessage } : {}),
      },
    });
    return envelope?.envelopeId;
  }

  /**
   * Pins the success evidence envelope on the job record after every action
   * branch (including agent_turn/no_agent, which persist their own run state
   * outside recordCronRunSuccess). Best-effort by construction: the envelope
   * callback never throws (gateway wiring) and a missing job is a no-op.
   */
  private finalizeCronRunEvidenceOnSuccess(jobId: string, runId: string, summary: Record<string, unknown>): void {
    if (!this.deps.recordEvidenceEnvelope || !this.deps.isFeatureEnabled("cronEvidenceV1Enabled")) {
      return;
    }
    const job = this.deps.storage.cronJobs.get(jobId);
    if (!job) {
      return;
    }
    const finishedAtIso = new Date().toISOString();
    const envelopeId = this.recordCronRunEvidence(job, runId, "ok", finishedAtIso, { summary });
    if (!envelopeId) {
      return;
    }
    this.deps.storage.cronJobs.upsert({ ...job, lastRunEvidenceEnvelopeId: envelopeId }, finishedAtIso);
    this.deps.persistCronJobsConfig();
  }

  private recordCronRunFailure(
    job: CronJobRecord,
    runId: string,
    error: unknown,
    failedAt: Date,
    options: CronRunOptions,
  ): CronJobRecord {
    const failedAtIso = failedAt.toISOString();
    const message = normalizeCronFailureMessage(error);
    const failureCount = Math.max(0, job.failureCount ?? 0) + 1;
    const backoffUntil = computeCronBackoffUntil(failedAt, failureCount);
    const evidenceEnvelopeId = this.recordCronRunEvidence(job, runId, "failed", failedAtIso, {
      failureMessage: message,
    });
    const saved = this.deps.storage.cronJobs.upsert(
      {
        ...job,
        lastRunAt: failedAtIso,
        lastRunId: runId,
        lastRunStatus: "failed",
        lastRunEvidenceEnvelopeId: evidenceEnvelopeId,
        lastFailureAt: failedAtIso,
        lastFailure: {
          message,
          ...(error instanceof Error && error.name ? { code: error.name } : {}),
        },
        failureCount,
        backoffUntil,
        nextRunAt: computeNextCronRunAt(job.schedule, failedAt, job.endAt),
      },
      failedAtIso,
    );
    this.deps.persistCronJobsConfig();
    this.deps.publishRealtime("cron_job_run", "cron", {
      type: "cron_job_run_failed",
      jobId: saved.jobId,
      name: saved.name,
      runId,
      action: saved.action,
      message,
      failureCount,
      backoffUntil,
      force: options.force === true,
      reason: options.reason,
    });
    return saved;
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readCronReviewWarning(summary: Record<string, unknown>): string | undefined {
  if (summary.cronReviewWarning !== true) {
    return undefined;
  }
  return readString(summary.profileWarning) ?? "Cron run accepted but recorded a scheduler review warning.";
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

function normalizeCronLastRunOutput(value: string | null | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  return value;
}

function normalizeCronLastRunId(value: string | null | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
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
    return normalizeNoAgentCronActionConfig(rawValue);
  }
  if (action === "agent_turn") {
    return normalizeAgentTurnCronActionConfig(rawValue);
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
  return (
    action === "task" ||
    action === "watchdog" ||
    action === "curator" ||
    action === "no_agent" ||
    action === "agent_turn"
  );
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

export function isCronJobBackedOff(job: CronJobRecord, now: Date): boolean {
  if (!job.backoffUntil) {
    return false;
  }
  const parsed = Date.parse(job.backoffUntil);
  return Number.isFinite(parsed) && parsed > now.getTime();
}

function computeCronBackoffUntil(failedAt: Date, failureCount: number): string {
  const exponent = Math.max(0, Math.min(10, failureCount - 1));
  const delayMs = Math.min(CRON_BACKOFF_MAX_MS, CRON_BACKOFF_BASE_MS * 2 ** exponent);
  return new Date(failedAt.getTime() + delayMs).toISOString();
}

function normalizeCronFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/\s+/g, " ").trim() || "Cron job failed.";
  return normalized.length > CRON_FAILURE_MESSAGE_MAX_LENGTH
    ? `${normalized.slice(0, CRON_FAILURE_MESSAGE_MAX_LENGTH - 3)}...`
    : normalized;
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
  const hour = parsed.hour !== undefined ? parsed.hour : parts.hour;
  const minute = parsed.wildcardMinute ? parts.minute : (parsed.minute ?? parts.minute);
  return [parsed.timeZone ?? "UTC", parts.year, parts.month, parts.day, hour, minute].join(":");
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
