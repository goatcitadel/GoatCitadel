/* eslint-disable max-lines -- Cron automation keeps scheduling, run lookup, failure metadata, and operator actions co-located while gateway ownership is still centralized. */
import { createHash, randomUUID } from "node:crypto";
import {
  isCronRunTerminalStatus,
  NotFoundError,
  redactSecretText,
  type CronJobRecord,
  type CronReviewItem,
  type CronRunDiff,
  type CronRunExecutionToken,
  type CronRunRecord,
  type CronRunTerminalStatus,
  type DurableRunRecord,
  type CronWatchdogCheckId,
  type CronWatchdogRunResult,
} from "@goatcitadel/contracts";
import type { EvidenceEnvelopeCreateRequest } from "../evidence-envelope-service.js";
import type { CronSpecMutationOwner } from "../cron-config-generation-owner.js";
import type { Storage } from "@goatcitadel/storage";
import {
  SharedHostAdmissionClosedError,
  type SharedHostLifecycleAdmissionPort,
} from "../shared-host-lifecycle-service.js";
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

const PROTECTED_BUILTIN_CRON_JOB_IDS = new Set([
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
  /** Stable occurrence timestamp supplied by the due scheduler. */
  scheduledFor?: string;
  /** Optional caller-owned idempotency key for this occurrence. */
  admissionKey?: string;
}

export interface CronRunResult {
  jobId: string;
  runId: string;
  status: "ok" | "pending";
  force?: boolean;
  childDurableRunId?: string;
  childDurableStatus?: string;
  childTurnId?: string;
  profilePosture?: string;
}

export interface CronDueRunItem {
  jobId: string;
  status: "ran" | "pending" | "failed" | "backoff";
  runId?: string;
  error?: string;
  failureCount?: number;
  backoffUntil?: string;
}

export interface CronDueRunSummary {
  checkedAt: string;
  dueCount: number;
  ranCount: number;
  pendingCount: number;
  failedCount: number;
  backoffCount: number;
  items: CronDueRunItem[];
}

export interface CronSettlementRecoverySummary {
  checkedAt: string;
  checkedCount: number;
  launchedCount: number;
  advancedCount: number;
  settledCount: number;
  reconciliationCount: number;
  staleCount: number;
  errors: Array<{ runId: string; error: string }>;
}

export interface CronAutomationServiceDeps {
  storage: Storage;
  specOwner: CronSpecMutationOwner;
  publishRealtime: (eventType: string, source: string, payload?: Record<string, unknown>) => void;
  requireFeatureEnabled: (flag: "cronReviewQueueV1Enabled") => void;
  isFeatureEnabled: (flag: "cronReviewQueueV1Enabled" | "cronEvidenceV1Enabled") => boolean;
  /**
   * Records a signed evidence envelope for a completed/failed cron run.
   * Optional and best-effort: envelope failure must never fail the run
   * (the gateway wiring wraps createEnvelope in a diagnostic try/catch).
   */
  recordEvidenceEnvelope?: (input: EvidenceEnvelopeCreateRequest) => { envelopeId: string } | undefined;
  sharedHostLifecycle?: SharedHostLifecycleAdmissionPort;
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
  private readonly agentTurnAdmissionsInFlight = new Map<string, Promise<CronRunResult>>();

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

  public async createCronJob(input: {
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
  }): Promise<CronJobRecord> {
    const jobId = normalizeCronJobId(input.jobId);
    if (this.deps.storage.cronJobs.get(jobId)) {
      throw new Error(`Cron job already exists: ${jobId}`);
    }
    const action = normalizeCronJobAction(input.action);
    assertCronActionMutationAllowed(action, "create");
    const job: CronJobRecord = {
      jobId,
      revision: 1,
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
    const saved = await this.deps.specOwner.createSpec(job, {
      nextRunAt: job.nextRunAt ?? null,
    });
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

  public async updateCronJob(
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
    expectedRevision: number,
  ): Promise<CronJobRecord> {
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
    };
    if (isScheduledCronAction(updated.action)) {
      updated.nextRunAt = computeNextCronRunAt(updated.schedule, new Date(), updated.endAt);
    }
    const saved = await this.deps.specOwner.updateSpec(updated, expectedRevision, {
      nextRunAt: updated.nextRunAt ?? null,
    });
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

  public setCronJobEnabled(jobId: string, enabled: boolean, expectedRevision: number): Promise<CronJobRecord> {
    return this.updateCronJob(jobId, { enabled }, expectedRevision);
  }

  public async deleteCronJob(jobId: string, expectedRevision: number): Promise<{ deleted: boolean; jobId: string }> {
    const normalizedJobId = normalizeCronJobId(jobId);
    if (PROTECTED_BUILTIN_CRON_JOB_IDS.has(normalizedJobId)) {
      throw new Error(`System cron job cannot be deleted: ${normalizedJobId}`);
    }
    const deleted = await this.deps.specOwner.deleteSpec(normalizedJobId, expectedRevision);
    if (deleted) {
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
    const lifecycleAdmission = this.deps.sharedHostLifecycle?.tryReserve(
      "cron",
      `cron:${normalizedJobId}:${options.admissionKey?.trim() || randomUUID()}`,
    );
    if (lifecycleAdmission && !lifecycleAdmission.admitted) {
      throw new SharedHostAdmissionClosedError(lifecycleAdmission.state, lifecycleAdmission.reason);
    }
    try {
      if (job.action === "agent_turn") {
        return this.runCanonicalAgentTurnCronJob(job, options);
      }
      const canonical = this.beginCanonicalInlineCronRun(job, options);
      if (canonical.outcome === "existing") return canonical.result;
      const { runId, token } = canonical;
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
            mergeCronJobRuntimeTelemetry: (runtimeJobId, patch, updatedAt) =>
              this.deps.storage.cronJobs.mergeRuntimeTelemetry(runtimeJobId, patch, updatedAt),
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
        const evidenceEnvelopeId = this.finalizeCronRunEvidenceOnSuccess(normalizedJobId, runId, runSummary);
        const terminal = this.deps.storage.cronRuns.terminalize(token, {
          status: "completed",
          outcome: { result: "ok", action: job.action },
          ...(evidenceEnvelopeId ? { evidenceEnvelopeId } : {}),
        });
        if (!terminal) throw new Error(`Canonical cron run ${runId} lost ownership before success settlement.`);
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
        const failed = this.recordCronRunFailure(latest, runId, error, new Date(), options);
        const evidenceEnvelopeId =
          typeof failed.lastRunEvidenceEnvelopeId === "string" ? failed.lastRunEvidenceEnvelopeId : undefined;
        const settled = this.deps.storage.cronRuns.terminalize(token, {
          status: "failed",
          failure: { message: normalizeCronFailureMessage(error) },
          ...(evidenceEnvelopeId ? { evidenceEnvelopeId } : {}),
        });
        if (!settled) {
          throw new Error(`Canonical cron run ${runId} lost ownership before failure settlement.`, { cause: error });
        }
        throw error;
      }
    } finally {
      if (lifecycleAdmission?.admitted) lifecycleAdmission.reservation.release();
    }
  }

  private beginCanonicalInlineCronRun(
    job: CronJobRecord,
    options: CronRunOptions,
  ):
    | { outcome: "admitted"; runId: string; token: CronRunExecutionToken }
    | { outcome: "existing"; result: CronRunResult } {
    const requestedRunId = randomUUID();
    const trigger = options.force === true ? "forced" : options.reason === "scheduled_due" ? "scheduled_due" : "manual";
    const scheduledFor = normalizeCronOccurrenceTimestamp(options.scheduledFor ?? new Date().toISOString());
    const admissionKey =
      options.admissionKey?.trim() ||
      (trigger === "scheduled_due" ? `scheduled:${scheduledFor}` : `${trigger}:${requestedRunId}`);
    const admission = this.deps.storage.cronRuns.beginAdmission({
      runId: requestedRunId,
      jobId: job.jobId,
      admissionKey,
      scheduledFor,
      trigger,
    });
    if (admission.outcome === "blocked") {
      return { outcome: "existing", result: this.toCanonicalCronRunResult(admission.activeRun) };
    }
    if (admission.outcome === "duplicate") {
      return { outcome: "existing", result: this.toCanonicalCronRunResult(admission.run) };
    }
    const token = toCronRunExecutionToken(admission.run);
    const admitted = this.deps.storage.cronRuns.admitInlineExecution(token);
    if (!admitted) throw new Error(`Canonical cron run ${admission.run.runId} lost ownership before inline admission.`);
    return { outcome: "admitted", runId: admission.run.runId, token };
  }

  private async runCanonicalAgentTurnCronJob(job: CronJobRecord, options: CronRunOptions): Promise<CronRunResult> {
    const requestedRunId = randomUUID();
    const trigger = options.force === true ? "forced" : options.reason === "scheduled_due" ? "scheduled_due" : "manual";
    const scheduledFor = normalizeCronOccurrenceTimestamp(options.scheduledFor ?? new Date().toISOString());
    const admissionKey =
      options.admissionKey?.trim() ||
      (trigger === "scheduled_due" ? `scheduled:${scheduledFor}` : `${trigger}:${requestedRunId}`);
    const admission = this.deps.storage.cronRuns.beginAdmission({
      runId: requestedRunId,
      jobId: job.jobId,
      admissionKey,
      scheduledFor,
      trigger,
    });
    if (admission.outcome === "blocked") {
      return this.toCanonicalCronRunResult(admission.activeRun);
    }
    if (isCronRunTerminalStatus(admission.run.status)) {
      return this.toCanonicalCronRunResult(admission.run);
    }
    return this.processCanonicalAgentTurnCronRun(admission.run);
  }

  /**
   * Startup/maintenance reconciliation for canonically admitted cron
   * occurrences. Agent turns resume through their durable child. Inline work
   * is never replayed after a process loss because its side-effect outcome is
   * ambiguous; it is held for explicit reconciliation instead.
   */
  public async recoverPendingAgentTurnCronRuns(limit = 100): Promise<CronSettlementRecoverySummary> {
    const summary: CronSettlementRecoverySummary = {
      checkedAt: new Date().toISOString(),
      checkedCount: 0,
      launchedCount: 0,
      advancedCount: 0,
      settledCount: 0,
      reconciliationCount: 0,
      staleCount: 0,
      errors: [],
    };
    const cronRuns = this.deps.storage.cronRuns;
    if (!cronRuns) {
      return summary;
    }
    const lifecycleAdmission = this.deps.sharedHostLifecycle?.tryReserve("cron", `cron-recovery:${randomUUID()}`);
    if (lifecycleAdmission && !lifecycleAdmission.admitted) {
      summary.errors.push({ runId: "shared-host-admission", error: lifecycleAdmission.reason });
      return summary;
    }
    try {
      const pending = cronRuns.listPendingSettlement(limit);
      for (const observed of pending) {
        summary.checkedCount += 1;
        const beforeStatus = observed.status;
        const beforePhase = observed.phase;
        try {
          if (observed.action !== "agent_turn") {
            const reconciled = cronRuns.requireReconciliation(toCronRunExecutionToken(observed), {
              reason:
                "Gateway restarted after canonical inline cron admission; the side-effect outcome is unknown and will not be replayed automatically.",
              error: "restart_after_inline_admission",
            });
            if (reconciled?.status === "manual_reconciliation_required") {
              summary.settledCount += 1;
              summary.reconciliationCount += 1;
            } else {
              summary.staleCount += 1;
            }
            continue;
          }
          await this.processCanonicalAgentTurnCronRun(observed);
          const current = this.deps.storage.cronRuns.get(observed.runId);
          if (!current) {
            summary.staleCount += 1;
            continue;
          }
          if (beforeStatus === "admitting") {
            summary.launchedCount += 1;
          }
          if (isCronRunTerminalStatus(current.status)) {
            summary.settledCount += 1;
            if (current.status === "manual_reconciliation_required") {
              summary.reconciliationCount += 1;
            }
          } else if (current.status !== beforeStatus || current.phase !== beforePhase) {
            summary.advancedCount += 1;
          }
        } catch (error) {
          summary.errors.push({ runId: observed.runId, error: normalizeCronFailureMessage(error) });
        }
      }
      return summary;
    } finally {
      if (lifecycleAdmission?.admitted) lifecycleAdmission.reservation.release();
    }
  }

  private processCanonicalAgentTurnCronRun(run: CronRunRecord): Promise<CronRunResult> {
    const existing = this.agentTurnAdmissionsInFlight.get(run.runId);
    if (existing) {
      return existing;
    }
    const task = this.processCanonicalAgentTurnCronRunOwned(run).finally(() => {
      if (this.agentTurnAdmissionsInFlight.get(run.runId) === task) {
        this.agentTurnAdmissionsInFlight.delete(run.runId);
      }
    });
    this.agentTurnAdmissionsInFlight.set(run.runId, task);
    return task;
  }

  private async processCanonicalAgentTurnCronRunOwned(observed: CronRunRecord): Promise<CronRunResult> {
    const current = this.deps.storage.cronRuns.get(observed.runId);
    if (!current) {
      throw new Error(`Canonical cron run disappeared before processing: ${observed.runId}`);
    }
    if (isCronRunTerminalStatus(current.status)) {
      return this.toCanonicalCronRunResult(current);
    }
    if (current.action !== "agent_turn") {
      throw new Error(`Canonical cron run ${current.runId} is not an agent_turn occurrence.`);
    }
    if (current.status !== "admitting") {
      return this.reconcileCanonicalAgentTurnChild(current);
    }

    let job: CronJobRecord;
    try {
      job = this.buildCanonicalAgentTurnSnapshotJob(current);
    } catch (error) {
      return this.settleCanonicalAgentTurnCronRun(current, "manual_reconciliation_required", {
        failureMessage: normalizeCronFailureMessage(error),
        reconciliationReason: "The admitted cron action snapshot is invalid and cannot be replayed safely.",
      });
    }
    const token = toCronRunExecutionToken(current);
    if (
      !this.recordCanonicalCronPendingTelemetry(current, {
        action: "agent_turn",
        runId: current.runId,
        status: "admitting",
        executionGeneration: current.executionGeneration,
      })
    ) {
      throw new Error(`Cron run ${current.runId} lost execution ownership before child launch.`);
    }
    const admittedSummary = await runAgentTurnCronJob({
      job,
      normalizedJobId: current.jobId,
      runId: current.runId,
      cronRun: token,
      runHandler: this.deps.runHandlers.agentTurn,
      attachDeterministicChild: (executionToken, linkage, attachedAt) =>
        this.deps.storage.cronRuns.attachDeterministicChild(executionToken, linkage, attachedAt),
      publishRealtime: this.deps.publishRealtime,
    });
    if (admittedSummary.mode === "inbox") {
      return this.settleCanonicalAgentTurnCronRun(current, "completed", { outcome: admittedSummary });
    }
    const attached = this.deps.storage.cronRuns.get(current.runId);
    if (!attached || isCronRunTerminalStatus(attached.status)) {
      return attached ? this.toCanonicalCronRunResult(attached) : this.toCanonicalCronRunResult(current);
    }
    this.recordCanonicalCronPendingTelemetry(attached, admittedSummary);
    const reconciled = await this.reconcileCanonicalAgentTurnChild(attached);
    return {
      ...reconciled,
      ...(readString(admittedSummary.profilePosture)
        ? { profilePosture: readString(admittedSummary.profilePosture) }
        : {}),
    };
  }

  private buildCanonicalAgentTurnSnapshotJob(run: CronRunRecord): CronJobRecord {
    const liveJob = this.deps.storage.cronJobs.get(run.jobId);
    if (!liveJob) {
      throw new Error(`Cron job ${run.jobId} no longer exists.`);
    }
    const snapshotAction = readString(run.actionSnapshot.action);
    const snapshotConfig = readRecord(run.actionSnapshot.actionConfig);
    if (snapshotAction !== "agent_turn" || !snapshotConfig) {
      throw new Error(`Cron run ${run.runId} does not contain a valid agent_turn action snapshot.`);
    }
    return {
      ...liveJob,
      action: "agent_turn",
      actionConfig: normalizeAgentTurnCronActionConfig(snapshotConfig),
    };
  }

  private async reconcileCanonicalAgentTurnChild(observed: CronRunRecord): Promise<CronRunResult> {
    let current = this.deps.storage.cronRuns.get(observed.runId);
    if (!current) {
      throw new Error(`Canonical cron run disappeared during settlement: ${observed.runId}`);
    }
    if (isCronRunTerminalStatus(current.status)) {
      return this.toCanonicalCronRunResult(current);
    }
    const childRunId = current.childDurableRunId;
    if (!childRunId) {
      return this.settleCanonicalAgentTurnCronRun(current, "manual_reconciliation_required", {
        failureMessage: "The admitted cron run has no deterministic durable child linkage.",
        reconciliationReason: "Durable child linkage is missing after cron admission.",
      });
    }
    const child = this.readDurableRun(childRunId);
    if (!child) {
      return this.settleCanonicalAgentTurnCronRun(current, "manual_reconciliation_required", {
        failureMessage: `Durable child ${childRunId} is missing.`,
        reconciliationReason: "The linked durable Chat child cannot be found.",
      });
    }
    const ownershipError = validateCanonicalCronDurableChild(current, child);
    if (ownershipError) {
      return this.settleCanonicalAgentTurnCronRun(current, "manual_reconciliation_required", {
        failureMessage: ownershipError,
        reconciliationReason: "The linked durable child is owned by a different cron admission.",
      });
    }

    if (
      child.status === "queued" ||
      child.status === "running" ||
      child.status === "waiting" ||
      child.status === "paused"
    ) {
      const targetStatus = child.status === "queued" ? "admitted" : child.status === "running" ? "running" : "waiting";
      const advanced = this.deps.storage.cronRuns.advancePhase(toCronRunExecutionToken(current), {
        status: targetStatus,
        phase: current.phase,
      });
      return this.toCanonicalCronRunResult(advanced ?? current);
    }
    if (child.status === "failed" || child.status === "cancelled" || child.status === "dead_lettered") {
      return this.settleCanonicalAgentTurnCronRun(current, child.status, {
        failureMessage: child.lastError ?? `Durable Chat child settled as ${child.status}.`,
        outcome: buildCanonicalChildOutcome(current, child),
      });
    }

    const metadata = child.metadata ?? {};
    if (metadata.autonomousChatPostCommitPending || metadata.generalChatPostCommitPending) {
      const advanced = this.deps.storage.cronRuns.advancePhase(toCronRunExecutionToken(current), {
        status: "running",
        phase: "autonomous_post_commit",
      });
      return this.toCanonicalCronRunResult(advanced ?? current);
    }
    const autonomousPostCommit = readRecord(metadata.autonomousChatPostCommit);
    const delivery = readRecord(autonomousPostCommit?.delivery);
    if (delivery?.status === "skipped") {
      return this.settleCanonicalAgentTurnCronRun(current, "completed", {
        outcome: {
          ...buildCanonicalChildOutcome(current, child),
          deliveryStatus: "skipped",
          deliveryReason: readString(delivery.reason),
        },
      });
    }
    const deliveryRunId = delivery?.status === "enqueued" ? readString(delivery.runId) : undefined;
    if (!deliveryRunId) {
      return this.settleCanonicalAgentTurnCronRun(current, "manual_reconciliation_required", {
        failureMessage: "The completed Chat child has no canonical autonomous delivery receipt.",
        reconciliationReason: "Autonomous post-commit delivery truth is missing or malformed.",
      });
    }
    current =
      this.deps.storage.cronRuns.advancePhase(toCronRunExecutionToken(current), {
        status: "running",
        phase: "delivery",
        linkage: { deliveryRunId },
      }) ?? current;
    const deliveryRun = this.readDurableRun(deliveryRunId);
    if (!deliveryRun) {
      return this.settleCanonicalAgentTurnCronRun(current, "manual_reconciliation_required", {
        failureMessage: `Delivery durable run ${deliveryRunId} is missing.`,
        reconciliationReason: "The autonomous delivery receipt references a missing durable run.",
      });
    }
    const deliveryOwnershipError = validateCanonicalCronDeliveryChild(child, deliveryRun);
    if (deliveryOwnershipError) {
      return this.settleCanonicalAgentTurnCronRun(current, "manual_reconciliation_required", {
        failureMessage: deliveryOwnershipError,
        reconciliationReason: "The linked delivery durable run is owned by a different handoff.",
      });
    }
    if (
      deliveryRun.status === "queued" ||
      deliveryRun.status === "running" ||
      deliveryRun.status === "waiting" ||
      deliveryRun.status === "paused"
    ) {
      const targetStatus =
        deliveryRun.status === "queued" ? "admitted" : deliveryRun.status === "running" ? "running" : "waiting";
      const advanced = this.deps.storage.cronRuns.advancePhase(toCronRunExecutionToken(current), {
        status: targetStatus,
        phase: "delivery",
      });
      return this.toCanonicalCronRunResult(advanced ?? current);
    }
    if (deliveryRun.status === "completed") {
      return this.settleCanonicalAgentTurnCronRun(current, "completed", {
        outcome: {
          ...buildCanonicalChildOutcome(current, child),
          deliveryRunId,
          deliveryStatus: "completed",
        },
      });
    }
    if (
      hasAmbiguousExternalDeliveryOutcome(deliveryRun, this.deps.storage.durableRuns.listCheckpoints(deliveryRunId))
    ) {
      return this.settleCanonicalAgentTurnCronRun(current, "manual_reconciliation_required", {
        failureMessage: deliveryRun.lastError ?? "Delivery may have crossed the external provider boundary.",
        reconciliationReason: "Delivery has an unknown external outcome and must not be retried automatically.",
      });
    }
    return this.settleCanonicalAgentTurnCronRun(current, deliveryRun.status, {
      failureMessage: deliveryRun.lastError ?? `Delivery child settled as ${deliveryRun.status}.`,
      outcome: {
        ...buildCanonicalChildOutcome(current, child),
        deliveryRunId,
        deliveryStatus: deliveryRun.status,
      },
    });
  }

  private settleCanonicalAgentTurnCronRun(
    observed: CronRunRecord,
    status: CronRunTerminalStatus,
    details: {
      outcome?: Record<string, unknown>;
      failureMessage?: string;
      reconciliationReason?: string;
    } = {},
  ): CronRunResult {
    const current = this.deps.storage.cronRuns.get(observed.runId);
    if (!current) {
      return this.toCanonicalCronRunResult(observed);
    }
    if (isCronRunTerminalStatus(current.status)) {
      return this.toCanonicalCronRunResult(current);
    }
    const token = toCronRunExecutionToken(current);
    const fenced = this.deps.storage.cronRuns.advancePhase(token, {
      status: current.status,
      phase: current.phase,
    });
    if (!fenced) {
      return this.toCanonicalCronRunResult(current);
    }
    const job = this.deps.storage.cronJobs.get(current.jobId);
    if (!job) {
      return this.toCanonicalCronRunResult(current);
    }
    const settledAt = new Date().toISOString();
    const summary = details.outcome ?? {
      action: current.action,
      runId: current.runId,
      canonicalStatus: status,
      childDurableRunId: current.childDurableRunId,
      deliveryRunId: current.deliveryRunId,
    };
    const evidenceEnvelopeId = this.recordCronRunEvidence(
      job,
      current.runId,
      status === "completed" ? "ok" : "failed",
      settledAt,
      status === "completed"
        ? { summary }
        : { summary, failureMessage: details.failureMessage ?? `Cron run settled as ${status}.` },
    );
    const terminal = this.deps.storage.cronRuns.terminalize(token, {
      status,
      outcome: summary,
      ...(status === "completed"
        ? {}
        : { failure: { message: details.failureMessage ?? `Cron run settled as ${status}.` } }),
      ...(status === "manual_reconciliation_required"
        ? {
            reconciliationReason:
              details.reconciliationReason ?? "Canonical cron settlement requires operator reconciliation.",
          }
        : {}),
      ...(evidenceEnvelopeId ? { evidenceEnvelopeId } : {}),
      now: settledAt,
    });
    if (!terminal) {
      return this.toCanonicalCronRunResult(current);
    }
    this.recordCanonicalCronTerminalTelemetry(job, terminal, summary, details.failureMessage, settledAt);
    if (this.deps.isFeatureEnabled("cronReviewQueueV1Enabled")) {
      const warning = readCronReviewWarning(summary);
      this.recordCronReviewItem({
        jobId: terminal.jobId,
        runId: terminal.runId,
        severity: warning ? "medium" : "low",
        status: warning ? "open" : "resolved",
        summary: warning
          ? { trigger: "agent_turn_profile_warning", ...summary, warning }
          : { trigger: "canonical_agent_turn_settlement", ...summary },
        diff: { type: warning ? "agent_turn_profile_warning" : "canonical_agent_turn_settlement", changed: false },
      });
    }
    this.deps.publishRealtime("cron_job_run", "cron", {
      type: status === "completed" ? "cron_agent_turn_completed" : "cron_agent_turn_terminal",
      jobId: terminal.jobId,
      runId: terminal.runId,
      executionGeneration: terminal.executionGeneration,
      status: terminal.status,
      childDurableRunId: terminal.childDurableRunId,
      deliveryRunId: terminal.deliveryRunId,
      evidenceEnvelopeId: terminal.evidenceEnvelopeId,
      reconciliationReason: terminal.reconciliationReason,
    });
    return this.toCanonicalCronRunResult(terminal);
  }

  private recordCanonicalCronPendingTelemetry(run: CronRunRecord, summary: Record<string, unknown>): boolean {
    const job = this.deps.storage.cronJobs.get(run.jobId);
    if (!job) {
      return false;
    }
    return Boolean(
      this.deps.storage.cronJobs.mergeRuntimeTelemetryForExecutionGeneration(run.jobId, run.executionGeneration, {
        lastRunAt: null,
        lastRunId: run.runId,
        lastRunStatus: null,
        lastRunOutput: JSON.stringify(summary),
        lastRunEvidenceEnvelopeId: null,
        nextRunAt: computeNextCronRunAfterOccurrence(job, run.scheduledFor) ?? null,
      }),
    );
  }

  private recordCanonicalCronTerminalTelemetry(
    job: CronJobRecord,
    run: CronRunRecord,
    summary: Record<string, unknown>,
    failureMessage: string | undefined,
    settledAt: string,
  ): void {
    const succeeded = run.status === "completed";
    const failureCount = succeeded ? 0 : Math.max(0, job.failureCount ?? 0) + 1;
    this.deps.storage.cronJobs.mergeRuntimeTelemetryForExecutionGeneration(
      job.jobId,
      run.executionGeneration,
      {
        lastRunAt: settledAt,
        lastRunId: run.runId,
        lastRunStatus: succeeded ? "ok" : "failed",
        lastRunOutput: JSON.stringify(summary),
        lastRunEvidenceEnvelopeId: run.evidenceEnvelopeId ?? null,
        lastFailureAt: succeeded ? null : settledAt,
        lastFailure: succeeded
          ? null
          : { message: failureMessage ?? `Cron run settled as ${run.status}.`, code: run.status },
        failureCount,
        backoffUntil: succeeded ? null : computeCronBackoffUntil(new Date(settledAt), failureCount),
        nextRunAt: computeNextCronRunAfterOccurrence(job, run.scheduledFor) ?? null,
      },
      settledAt,
    );
  }

  private readDurableRun(runId: string): DurableRunRecord | undefined {
    try {
      return this.deps.storage.durableRuns.getRun(runId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return undefined;
      }
      throw error;
    }
  }

  private toCanonicalCronRunResult(run: CronRunRecord): CronRunResult {
    return {
      jobId: run.jobId,
      runId: run.runId,
      status: run.status === "completed" ? "ok" : "pending",
      ...(run.childDurableRunId ? { childDurableRunId: run.childDurableRunId } : {}),
      ...(run.childTurnId ? { childTurnId: run.childTurnId } : {}),
      ...(run.childDurableRunId ? { childDurableStatus: this.readDurableRun(run.childDurableRunId)?.status } : {}),
    };
  }

  public async runDueTaskCronJobs(now = new Date()): Promise<CronDueRunSummary> {
    // Restart reconciliation is an explicit startup phase. Running it inside
    // every cadence sweep can misclassify an inline occurrence that is still
    // active in this process as a crash-ambiguous orphan when two sweep calls
    // overlap.
    const summary: CronDueRunSummary = {
      checkedAt: now.toISOString(),
      dueCount: 0,
      ranCount: 0,
      pendingCount: 0,
      failedCount: 0,
      backoffCount: 0,
      items: [],
    };
    const jobs = this.deps.storage.cronJobs
      .list()
      .filter(
        (job) => isScheduledCronAction(job.action) && isCronActionEnabledForScheduledRun(job.action) && job.enabled,
      );
    for (const job of jobs) {
      if (job.activeRunId) {
        continue;
      }
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
        const scheduledFor = computeCronOccurrenceScheduledFor(job, now);
        const result = await this.runCronJobNow(job.jobId, {
          reason: "scheduled_due",
          scheduledFor,
          admissionKey: `scheduled:${scheduledFor}`,
        });
        if (result.status === "pending") {
          summary.pendingCount += 1;
          summary.items.push({ jobId: job.jobId, status: "pending", runId: result.runId });
        } else {
          summary.ranCount += 1;
          summary.items.push({ jobId: job.jobId, status: "ran", runId: result.runId });
        }
      } catch (error) {
        if (error instanceof SharedHostAdmissionClosedError) {
          summary.pendingCount += 1;
          summary.items.push({ jobId: job.jobId, status: "pending" });
          continue;
        }
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
    const canonical = this.deps.storage.cronRuns?.get(normalized);
    if (canonical) {
      const latestJobTelemetry = this.deps.storage.cronJobs.get(canonical.jobId);
      const matchingTelemetry = latestJobTelemetry?.lastRunId === canonical.runId ? latestJobTelemetry : undefined;
      const childDurableStatus = canonical.childDurableRunId
        ? this.readDurableRun(canonical.childDurableRunId)?.status
        : undefined;
      const failureMessage = readString(canonical.failure?.message);
      return {
        runId: canonical.runId,
        jobId: canonical.jobId,
        status: !isCronRunTerminalStatus(canonical.status)
          ? "unknown"
          : canonical.status === "completed"
            ? "ok"
            : "failed",
        finishedAt: canonical.settledAt,
        output:
          matchingTelemetry?.lastRunOutput ??
          JSON.stringify({
            status: canonical.status,
            phase: canonical.phase,
            executionGeneration: canonical.executionGeneration,
            linkage: {
              childSessionId: canonical.childSessionId,
              childMessageId: canonical.childMessageId,
              childTurnId: canonical.childTurnId,
              childAssistantMessageId: canonical.childAssistantMessageId,
              childDurableRunId: canonical.childDurableRunId,
              deliveryRunId: canonical.deliveryRunId,
            },
            outcome: canonical.outcome,
            failure: canonical.failure,
            reconciliationReason: canonical.reconciliationReason,
          }),
        ...(canonical.childDurableRunId ? { childDurableRunId: canonical.childDurableRunId } : {}),
        ...(childDurableStatus ? { childDurableStatus } : {}),
        ...(canonical.childTurnId ? { childTurnId: canonical.childTurnId } : {}),
        evidenceEnvelopeId: canonical.evidenceEnvelopeId,
        ...(matchingTelemetry?.lastFailure
          ? { failure: matchingTelemetry.lastFailure }
          : failureMessage
            ? { failure: { message: failureMessage, code: canonical.status } }
            : {}),
        failureCount: matchingTelemetry?.failureCount,
        backoffUntil: matchingTelemetry?.backoffUntil,
      };
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
    const saved = this.deps.storage.cronJobs.mergeRuntimeTelemetry(
      job.jobId,
      {
        lastRunAt: finishedAt,
        lastRunId: runId,
        lastRunStatus: "ok",
        lastRunEvidenceEnvelopeId: null,
        lastFailureAt: null,
        lastFailure: null,
        failureCount: 0,
        backoffUntil: null,
        nextRunAt: computeNextCronRunAt(job.schedule, new Date(finishedAt), job.endAt) ?? null,
      },
      finishedAt,
    );
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
  private finalizeCronRunEvidenceOnSuccess(
    jobId: string,
    runId: string,
    summary: Record<string, unknown>,
  ): string | undefined {
    if (!this.deps.recordEvidenceEnvelope || !this.deps.isFeatureEnabled("cronEvidenceV1Enabled")) {
      return undefined;
    }
    const job = this.deps.storage.cronJobs.get(jobId);
    if (!job) {
      return undefined;
    }
    const finishedAtIso = new Date().toISOString();
    const envelopeId = this.recordCronRunEvidence(job, runId, "ok", finishedAtIso, { summary });
    if (!envelopeId) {
      return undefined;
    }
    this.deps.storage.cronJobs.mergeRuntimeTelemetry(
      job.jobId,
      { lastRunEvidenceEnvelopeId: envelopeId },
      finishedAtIso,
    );
    return envelopeId;
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
    const saved = this.deps.storage.cronJobs.mergeRuntimeTelemetry(
      job.jobId,
      {
        lastRunAt: failedAtIso,
        lastRunId: runId,
        lastRunStatus: "failed",
        lastRunEvidenceEnvelopeId: evidenceEnvelopeId ?? null,
        lastFailureAt: failedAtIso,
        lastFailure: {
          message,
          ...(error instanceof Error && error.name ? { code: error.name } : {}),
        },
        failureCount,
        backoffUntil,
        nextRunAt: computeNextCronRunAt(job.schedule, failedAt, job.endAt) ?? null,
      },
      failedAtIso,
    );
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

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizeCronOccurrenceTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("Cron occurrence timestamp must be a valid ISO date/time.");
  }
  return new Date(parsed).toISOString();
}

function toCronRunExecutionToken(run: CronRunRecord): CronRunExecutionToken {
  return {
    runId: run.runId,
    jobId: run.jobId,
    executionGeneration: run.executionGeneration,
  };
}

function validateCanonicalCronDurableChild(run: CronRunRecord, child: DurableRunRecord): string | undefined {
  const metadata = child.metadata ?? {};
  const payloadAdmission = readRecord(child.payload.cronAdmission);
  const metadataAdmission = readRecord(metadata.cronAdmission);
  if (
    child.runId !== run.childDurableRunId ||
    child.workflowKey !== "chat.turn.execute" ||
    metadata.cronRunId !== run.runId ||
    metadata.cronJobId !== run.jobId ||
    metadata.cronExecutionGeneration !== run.executionGeneration ||
    payloadAdmission?.cronRunId !== run.runId ||
    payloadAdmission?.jobId !== run.jobId ||
    payloadAdmission?.executionGeneration !== run.executionGeneration ||
    metadataAdmission?.cronRunId !== run.runId ||
    metadataAdmission?.jobId !== run.jobId ||
    metadataAdmission?.executionGeneration !== run.executionGeneration
  ) {
    return `Durable child ${child.runId} does not match canonical cron owner ${run.jobId}/${run.runId}/${run.executionGeneration}.`;
  }
  return undefined;
}

function buildCanonicalChildOutcome(run: CronRunRecord, child: DurableRunRecord): Record<string, unknown> {
  const autonomous = readRecord(child.metadata?.autonomous);
  return {
    action: run.action,
    runId: run.runId,
    canonicalStatus: child.status,
    childDurableRunId: child.runId,
    childSessionId: run.childSessionId,
    childMessageId: run.childMessageId,
    childTurnId: run.childTurnId,
    childAssistantMessageId: run.childAssistantMessageId,
    profilePosture: readString(autonomous?.profilePosture),
  };
}

function validateCanonicalCronDeliveryChild(parent: DurableRunRecord, delivery: DurableRunRecord): string | undefined {
  if (
    delivery.workflowKey !== "connector.delivery" ||
    delivery.metadata?.deliveryKind !== "autonomous.assistant_message" ||
    delivery.metadata?.sourceRunId !== parent.runId ||
    delivery.payload.runId !== parent.runId
  ) {
    return `Delivery child ${delivery.runId} does not match autonomous Chat parent ${parent.runId}.`;
  }
  return undefined;
}

function hasAmbiguousExternalDeliveryOutcome(
  run: DurableRunRecord,
  checkpoints: Array<{ state: Record<string, unknown> }>,
): boolean {
  const evidence = [run.lastError ?? "", ...checkpoints.slice(-5).map((checkpoint) => JSON.stringify(checkpoint.state))]
    .join(" ")
    .toLowerCase();
  return [
    "unknown_after_send",
    "unknown external outcome",
    "unknown_external_outcome",
    "manual_reconciliation_required",
    "manual reconciliation",
    "may have crossed",
  ].some((marker) => evidence.includes(marker));
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

export function computeCronBackoffUntil(failedAt: Date, failureCount: number): string {
  const exponent = Math.max(0, Math.min(10, failureCount - 1));
  const delayMs = Math.min(CRON_BACKOFF_MAX_MS, CRON_BACKOFF_BASE_MS * 2 ** exponent);
  return new Date(failedAt.getTime() + delayMs).toISOString();
}

export function normalizeCronFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/\s+/g, " ").trim() || "Cron job failed.";
  const redacted = redactSecretText(normalized).value;
  return redacted.length > CRON_FAILURE_MESSAGE_MAX_LENGTH
    ? `${redacted.slice(0, CRON_FAILURE_MESSAGE_MAX_LENGTH - 3)}...`
    : redacted;
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

function computeCronOccurrenceScheduledFor(job: CronJobRecord, observedAt: Date): string {
  const parsed = parseSimpleCronSchedule(job.schedule);
  const occurrence = new Date(observedAt);
  occurrence.setUTCSeconds(0, 0);
  if (parsed && !parsed.wildcardMinute && parsed.minute !== undefined) {
    const local = getZonedDateParts(observedAt, parsed.timeZone ?? "UTC");
    const minutesIntoWindow = Math.max(0, local.minute - parsed.minute);
    occurrence.setTime(occurrence.getTime() - minutesIntoWindow * 60_000);
  }
  return occurrence.toISOString();
}

function computeNextCronRunAfterOccurrence(job: CronJobRecord, scheduledFor: string): string | undefined {
  const parsed = parseSimpleCronSchedule(job.schedule);
  const occurrenceMs = Date.parse(scheduledFor);
  if (!parsed || !Number.isFinite(occurrenceMs)) {
    return undefined;
  }
  // Fixed-minute schedules match a five-minute due window. Start the search at
  // its final minute so nextRunAt cannot point back into the occurrence that
  // was just admitted; wildcard-minute schedules intentionally advance once
  // per minute and therefore need no window offset.
  const windowOffsetMs = parsed.wildcardMinute ? 0 : 4 * 60_000;
  return computeNextCronRunAt(job.schedule, new Date(occurrenceMs + windowOffsetMs), job.endAt);
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
