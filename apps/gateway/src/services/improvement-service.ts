/* eslint-disable @typescript-eslint/no-unused-vars, max-lines */
import { createHash, randomUUID } from "node:crypto";
import { clampInt } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";

const log = logger.child("improvement-service");
import type {
  CapabilityGapCauseClass,
  CapabilityGapEventRecord,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatMemoryMode,
  ChatMode,
  ChatThinkingLevel,
  ChatTurnTraceRecord,
  ChatWebMode,
  DecisionAutoTuneRecord,
  DecisionReplayCauseClass,
  DecisionReplayFindingRecord,
  DecisionReplayItemModelScores,
  DecisionReplayItemRecord,
  DecisionReplayItemRuleScores,
  DecisionReplayRunRecord,
  RepairCandidateRecord,
  RepairValidationStatus,
  ReplayDiffSummary,
  ReplayOverrideDraft,
  ReplayOverrideStep,
  TranscriptEvent,
  WeeklyImprovementReportRecord,
} from "@goatcitadel/contracts";
import type { ServiceContext } from "./service-context.js";

// ── constants ────────────────────────────────────────────────────────
const IMPROVEMENT_WEEKLY_TIME_ZONE = "America/Los_Angeles";
const IMPROVEMENT_WEEKLY_SCHEDULE_LABEL = "0 2 * * 0 America/Los_Angeles";
const IMPROVEMENT_WEEKLY_SAMPLE_SIZE = 500;
const IMPROVEMENT_JUDGE_SAMPLE_LIMIT = 120;
const IMPROVEMENT_JUDGE_TIMEOUT_MS = 15_000;
const IMPROVEMENT_SCHEDULER_INTERVAL_MS = 60_000;
const IMPROVEMENT_WEEKLY_DEDUP_SETTING_KEY = "improvement_weekly_last_week_key_v1";
const IMPROVEMENT_TUNE_KEY_BLOCKER_TEMPLATE = "improvement_tune_blocker_template_v1";
const IMPROVEMENT_TUNE_KEY_RETRY_THRESHOLD = "improvement_tune_retry_threshold_v1";
const IMPROVEMENT_TUNE_KEY_LIVE_INTENT = "improvement_tune_live_intent_threshold_v1";
const IMPROVEMENT_TUNE_KEY_REFUSAL_STYLE = "improvement_tune_refusal_style_v1";
const IMPROVEMENT_RUN_STATUS_VALUES = new Set(["queued", "running", "completed", "failed"]);
const IMPROVEMENT_CAUSE_CLASSES = new Set<DecisionReplayCauseClass>([
  "false_refusal_tone",
  "weak_blocker_explanation",
  "tool_mismatch",
  "retrieval_miss",
  "incomplete_retry_repair",
  "other",
]);
const CAPABILITY_GAP_CAUSE_CLASSES = new Set<CapabilityGapCauseClass>([
  "tool_exists_but_not_in_profile",
  "tool_requires_approval_but_not_exposed",
  "skill_missing",
  "provider_tool_mismatch",
  "retryable_network_failure",
  "policy_denied_by_config",
  "missing_required_tool_evidence",
  "routing_profile_mismatch",
]);
const REPAIR_VALIDATION_STATUSES = new Set<RepairValidationStatus>([
  "not_started",
  "queued",
  "running",
  "needs_review",
  "passed",
  "failed",
]);

// ── helper types ─────────────────────────────────────────────────────
interface ImprovementReplayTriggerInput {
  sampleSize?: number;
}

interface DecisionReplayCandidate {
  decisionType: "chat_turn" | "tool_run";
  sessionId?: string;
  turnId?: string;
  toolRunId?: string;
  status: string;
  occurredAt: string;
  model?: string;
  mode?: ChatMode;
  webMode?: ChatWebMode;
  memoryMode?: ChatMemoryMode;
  thinkingLevel?: ChatThinkingLevel;
  routing?: ChatTurnTraceRecord["routing"];
  retrieval?: ChatTurnTraceRecord["retrieval"];
  reflection?: ChatTurnTraceRecord["reflection"];
  toolName?: string;
  error?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  userMessageId?: string;
  assistantMessageId?: string;
}

interface ReplayScoredItemResult {
  item: DecisionReplayItemRecord;
  judgeUsed: boolean;
}

interface CapabilityGapEventUpsertInput {
  sessionId: string;
  turnId?: string;
  runId?: string;
  causeClass: CapabilityGapCauseClass;
  failureClass?: string;
  promptExcerpt?: string;
  promptRef?: string;
  requestedTool?: string;
  toolFamily?: string;
  toolProfile?: string;
  policyReason?: string;
  providerId?: string;
  model?: string;
  configArea?: string;
  suggestedRepairClass?: string;
  confidence?: number;
  recoveryOptions?: string[];
}

interface RepairCandidateValidationUpdateInput {
  status: RepairValidationStatus;
  summary?: string;
}

interface CapabilityGapEventRow {
  event_id: string;
  session_id: string;
  turn_id: string | null;
  run_id: string | null;
  cause_class: string;
  failure_class: string | null;
  prompt_excerpt: string | null;
  prompt_ref: string | null;
  requested_tool: string | null;
  tool_family: string | null;
  tool_profile: string | null;
  policy_reason: string | null;
  provider_id: string | null;
  model: string | null;
  config_area: string | null;
  suggested_repair_class: string | null;
  confidence: number;
  repeat_count: number;
  recovery_options_json: string;
  replay_run_id: string | null;
  replay_status: string | null;
  repair_candidate_id: string | null;
  created_at: string;
  updated_at: string;
}

interface RepairCandidateRow {
  candidate_id: string;
  fingerprint: string;
  cause_class: string;
  title: string;
  summary: string;
  requested_tool: string | null;
  tool_profile: string | null;
  provider_id: string | null;
  config_area: string | null;
  suggested_patch: string | null;
  replay_run_id: string | null;
  validation_status: string;
  validation_summary: string | null;
  event_count: number;
  confidence: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

/**
 * Callbacks needed from GatewayService.
 */
export interface ImprovementServiceCallbacks {
  createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  getPromptRunnerModelDefaults(): { providerId?: string; model?: string };
  readTranscriptOrEmpty(sessionId: string): Promise<TranscriptEvent[]>;
  retryChatTurn(
    sessionId: string,
    turnId: string,
    overrides: Partial<ChatSendMessageRequest>,
  ): Promise<ChatSendMessageResponse>;
  readonly backgroundTasks: Set<Promise<void>>;
  closing: boolean;
}

// ── shared utility helpers ───────────────────────────────────────────

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function clampProbability(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return 0.5;
  return Math.max(0, Math.min(1, num));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function extractCompletionText(response: ChatCompletionResponse): string {
  if (!response?.choices?.length) return "";
  const choice = response.choices[0];
  return (choice as { message?: { content?: string } })?.message?.content ?? "";
}

function parseLooseJsonRecord(raw: string): Record<string, unknown> | undefined {
  try {
    const trimmed = raw.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end < 0) return undefined;
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function truncateForModelJudge(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + "... [truncated]";
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Encapsulates all self-improvement, decision replay, auto-tune, and weekly
 * report logic previously inlined in GatewayService.
 */
export class ImprovementService {
  private scheduler?: ReturnType<typeof setInterval>;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly callbacks: ImprovementServiceCallbacks,
  ) {
    this.ensureCapabilityGapTables();
  }

  // ── scheduler lifecycle ──────────────────────────────────────────

  startScheduler(): void {
    if (this.scheduler) {
      return;
    }
    this.scheduler = setInterval(() => {
      const task = this.runSchedulerTick().catch((error) => {
        log.error("scheduler tick failed", { error: error instanceof Error ? error.message : String(error) });
        this.ctx.publishRealtime("system", "improvement", {
          type: "improvement_scheduler_error",
          message: (error as Error).message,
        });
      });
      this.callbacks.backgroundTasks.add(task);
      task.finally(() => this.callbacks.backgroundTasks.delete(task));
    }, IMPROVEMENT_SCHEDULER_INTERVAL_MS);
  }

  stopScheduler(): void {
    if (this.scheduler) {
      clearInterval(this.scheduler);
      this.scheduler = undefined;
    }
  }

  private async runSchedulerTick(): Promise<void> {
    if (this.callbacks.closing) {
      return;
    }
    await this.runWeeklyImprovementSchedulerIfDue();
  }

  // ── public API ───────────────────────────────────────────────────

  async runWeeklyImprovementSchedulerIfDue(options: { force?: boolean } = {}): Promise<void> {
    const job = this.ctx.storage.cronJobs.get("improvement_weekly");
    if (!job?.enabled) {
      return;
    }
    const now = new Date();
    if (!options.force) {
      // Simple time-based check: only run on Sundays at 2 AM in the configured timezone
      const parts = getZonedDateParts(now, IMPROVEMENT_WEEKLY_TIME_ZONE);
      if (parts.weekday !== 0 || parts.hour !== 2) {
        return;
      }
    }
    const weekKey = toWeekKeyForTimezone(now, IMPROVEMENT_WEEKLY_TIME_ZONE);
    const lastWeekKey = this.ctx.storage.systemSettings.get<string>(IMPROVEMENT_WEEKLY_DEDUP_SETTING_KEY)?.value;
    if (!options.force && lastWeekKey === weekKey) {
      return;
    }
    await this.runDecisionReplayAudit({
      triggerMode: options.force ? "manual" : "scheduled",
      sampleSize: IMPROVEMENT_WEEKLY_SAMPLE_SIZE,
    });
    this.ctx.storage.systemSettings.set(IMPROVEMENT_WEEKLY_DEDUP_SETTING_KEY, weekKey);
    const finishedAt = new Date().toISOString();
    this.ctx.storage.cronJobs.upsert(
      {
        ...job,
        lastRunAt: finishedAt,
        nextRunAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      finishedAt,
    );
  }

  ensureWeeklyImprovementCronJob(): void {
    const existing = this.ctx.storage.cronJobs.get("improvement_weekly");
    const now = new Date().toISOString();
    this.ctx.storage.cronJobs.upsertIfChanged(
      {
        jobId: "improvement_weekly",
        name: "Self-Improvement Weekly Replay",
        schedule: IMPROVEMENT_WEEKLY_SCHEDULE_LABEL,
        enabled: existing?.enabled ?? true,
        lastRunAt: existing?.lastRunAt,
        nextRunAt: existing?.nextRunAt,
      },
      now,
    );
  }

  markInterruptedDecisionReplayRuns(): void {
    const running = this.ctx.gatewaySql
      .prepare(
        `
      SELECT run_id
      FROM decision_replay_runs
      WHERE status = 'running'
    `,
      )
      .all() as Array<{ run_id: string }>;
    if (running.length === 0) {
      return;
    }
    const finishedAt = new Date().toISOString();
    this.ctx.gatewaySql
      .prepare(
        `
      UPDATE decision_replay_runs
      SET status = 'failed',
          error_text = COALESCE(error_text, 'Replay interrupted before completion (service restarted).'),
          finished_at = @finishedAt
      WHERE status = 'running'
    `,
      )
      .run({ finishedAt });
    this.ctx.publishRealtime("system", "improvement", {
      type: "improvement_replay_interrupted_runs_recovered",
      recoveredCount: running.length,
      finishedAt,
    });
  }

  listImprovementReports(limit = 24): WeeklyImprovementReportRecord[] {
    const rows = this.ctx.gatewaySql
      .prepare(
        `
      SELECT *
      FROM improvement_reports
      ORDER BY week_end DESC, created_at DESC
      LIMIT ?
    `,
      )
      .all(Math.max(1, Math.min(limit, 260))) as Array<{
      report_id: string;
      run_id: string;
      week_start: string;
      week_end: string;
      summary_json: string;
      top_findings_json: string;
      applied_tunes_json: string;
      queued_tunes_json: string;
      week_over_week_json: string;
      previous_report_id: string | null;
      created_at: string;
    }>;
    return rows.map((row) => mapImprovementReportRow(row));
  }

  listDecisionReplayRuns(limit = 24): DecisionReplayRunRecord[] {
    const rows = this.ctx.gatewaySql
      .prepare(
        `
      SELECT *
      FROM decision_replay_runs
      ORDER BY started_at DESC
      LIMIT ?
    `,
      )
      .all(Math.max(1, Math.min(limit, 300))) as Array<{
      run_id: string;
      trigger_mode: "scheduled" | "manual";
      sample_size: number;
      window_start: string;
      window_end: string;
      status: string;
      report_id: string | null;
      total_candidates: number;
      total_scored: number;
      likely_wrong_count: number;
      model_judged_count: number;
      started_at: string;
      finished_at: string | null;
      error_text: string | null;
    }>;
    return rows.map((row) => mapDecisionReplayRunRow(row));
  }

  listCapabilityGapEvents(limit = 100): CapabilityGapEventRecord[] {
    this.ensureCapabilityGapTables();
    const rows = toCapabilityGapEventRows(
      this.ctx.gatewaySql
        .prepare(
          `
      SELECT *
      FROM capability_gap_events
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `,
        )
        .all(Math.max(1, Math.min(limit, 500))),
    );
    return rows.map((row) => mapCapabilityGapEventRow(row));
  }

  listRepairCandidates(limit = 60): RepairCandidateRecord[] {
    this.ensureCapabilityGapTables();
    const rows = toRepairCandidateRows(
      this.ctx.gatewaySql
        .prepare(
          `
      SELECT *
      FROM repair_candidates
      ORDER BY last_seen_at DESC, updated_at DESC
      LIMIT ?
    `,
        )
        .all(Math.max(1, Math.min(limit, 300))),
    );
    return rows.map((row) => mapRepairCandidateRow(row));
  }

  updateRepairCandidateValidation(
    candidateId: string,
    input: RepairCandidateValidationUpdateInput,
  ): RepairCandidateRecord {
    this.ensureCapabilityGapTables();
    const existing = toRepairCandidateRow(
      this.ctx.gatewaySql
        .prepare(
          `
      SELECT *
      FROM repair_candidates
      WHERE candidate_id = ?
      LIMIT 1
    `,
        )
        .get(candidateId),
    );
    if (!existing) {
      throw new Error(`Repair candidate not found: ${candidateId}`);
    }
    const now = new Date().toISOString();
    const normalizedStatus = REPAIR_VALIDATION_STATUSES.has(input.status) ? input.status : "not_started";
    const normalizedSummary = input.summary?.trim() || null;
    this.ctx.gatewaySql
      .prepare(
        `
      UPDATE repair_candidates
      SET validation_status = @validationStatus,
          validation_summary = @validationSummary,
          updated_at = @updatedAt
      WHERE candidate_id = @candidateId
    `,
      )
      .run({
        validationStatus: normalizedStatus,
        validationSummary: normalizedSummary,
        updatedAt: now,
        candidateId,
      });
    const row = toRepairCandidateRow(
      this.ctx.gatewaySql
        .prepare(
          `
      SELECT *
      FROM repair_candidates
      WHERE candidate_id = ?
    `,
        )
        .get(candidateId),
    );
    if (!row) {
      throw new Error(`Repair candidate not found after update: ${candidateId}`);
    }
    return mapRepairCandidateRow(row);
  }

  recordCapabilityGapEvent(input: CapabilityGapEventUpsertInput): CapabilityGapEventRecord {
    this.ensureCapabilityGapTables();
    const now = new Date().toISOString();
    const normalizedCauseClass = CAPABILITY_GAP_CAUSE_CLASSES.has(input.causeClass)
      ? input.causeClass
      : "policy_denied_by_config";
    const normalizedRecoveryOptions = normalizeRecoveryOptions(input.recoveryOptions);
    const confidence = clamp01(input.confidence ?? 0.65);
    const fingerprint = buildCapabilityGapFingerprint({
      causeClass: normalizedCauseClass,
      requestedTool: input.requestedTool,
      toolProfile: input.toolProfile,
      providerId: input.providerId,
    });
    const existing = toCapabilityGapEventRow(
      this.ctx.gatewaySql
        .prepare(
          `
      SELECT *
      FROM capability_gap_events
      WHERE fingerprint = ?
      LIMIT 1
    `,
        )
        .get(fingerprint),
    );
    const eventId = existing?.event_id ?? randomUUID();
    const repeatCount = (existing?.repeat_count ?? 0) + 1;
    const recoveryOptionsJson = JSON.stringify(normalizedRecoveryOptions);

    this.ctx.gatewaySql
      .prepare(
        `
      INSERT INTO capability_gap_events (
        event_id,
        fingerprint,
        session_id,
        turn_id,
        run_id,
        cause_class,
        failure_class,
        prompt_excerpt,
        prompt_ref,
        requested_tool,
        tool_family,
        tool_profile,
        policy_reason,
        provider_id,
        model,
        config_area,
        suggested_repair_class,
        confidence,
        repeat_count,
        recovery_options_json,
        replay_run_id,
        replay_status,
        repair_candidate_id,
        created_at,
        updated_at
      ) VALUES (
        @eventId,
        @fingerprint,
        @sessionId,
        @turnId,
        @runId,
        @causeClass,
        @failureClass,
        @promptExcerpt,
        @promptRef,
        @requestedTool,
        @toolFamily,
        @toolProfile,
        @policyReason,
        @providerId,
        @model,
        @configArea,
        @suggestedRepairClass,
        @confidence,
        @repeatCount,
        @recoveryOptionsJson,
        @replayRunId,
        @replayStatus,
        @repairCandidateId,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(event_id) DO UPDATE SET
        session_id = excluded.session_id,
        turn_id = COALESCE(excluded.turn_id, capability_gap_events.turn_id),
        run_id = COALESCE(excluded.run_id, capability_gap_events.run_id),
        failure_class = COALESCE(excluded.failure_class, capability_gap_events.failure_class),
        prompt_excerpt = COALESCE(excluded.prompt_excerpt, capability_gap_events.prompt_excerpt),
        prompt_ref = COALESCE(excluded.prompt_ref, capability_gap_events.prompt_ref),
        requested_tool = COALESCE(excluded.requested_tool, capability_gap_events.requested_tool),
        tool_family = COALESCE(excluded.tool_family, capability_gap_events.tool_family),
        tool_profile = COALESCE(excluded.tool_profile, capability_gap_events.tool_profile),
        policy_reason = COALESCE(excluded.policy_reason, capability_gap_events.policy_reason),
        provider_id = COALESCE(excluded.provider_id, capability_gap_events.provider_id),
        model = COALESCE(excluded.model, capability_gap_events.model),
        config_area = COALESCE(excluded.config_area, capability_gap_events.config_area),
        suggested_repair_class = COALESCE(excluded.suggested_repair_class, capability_gap_events.suggested_repair_class),
        confidence = CASE
          WHEN excluded.confidence > capability_gap_events.confidence THEN excluded.confidence
          ELSE capability_gap_events.confidence
        END,
        repeat_count = excluded.repeat_count,
        recovery_options_json = excluded.recovery_options_json,
        updated_at = excluded.updated_at
    `,
      )
      .run({
        eventId,
        fingerprint,
        sessionId: input.sessionId,
        turnId: input.turnId ?? null,
        runId: input.runId ?? null,
        causeClass: normalizedCauseClass,
        failureClass: input.failureClass ?? null,
        promptExcerpt: input.promptExcerpt ?? null,
        promptRef: input.promptRef ?? null,
        requestedTool: input.requestedTool ?? null,
        toolFamily: input.toolFamily ?? null,
        toolProfile: input.toolProfile ?? null,
        policyReason: input.policyReason ?? null,
        providerId: input.providerId ?? null,
        model: input.model ?? null,
        configArea: input.configArea ?? null,
        suggestedRepairClass: input.suggestedRepairClass ?? null,
        confidence,
        repeatCount,
        recoveryOptionsJson,
        replayRunId: existing?.replay_run_id ?? null,
        replayStatus: existing?.replay_status ?? "not_run",
        repairCandidateId: existing?.repair_candidate_id ?? null,
        createdAt: existing?.created_at ?? now,
        updatedAt: now,
      });

    const candidate =
      repeatCount >= 2
        ? this.upsertRepairCandidate({
            causeClass: normalizedCauseClass,
            requestedTool: input.requestedTool,
            toolProfile: input.toolProfile,
            providerId: input.providerId,
            configArea: input.configArea,
            confidence,
            eventCount: repeatCount,
          })
        : undefined;
    if (candidate) {
      this.ctx.gatewaySql
        .prepare(
          `
        UPDATE capability_gap_events
        SET repair_candidate_id = ?,
            updated_at = ?
        WHERE event_id = ?
      `,
        )
        .run(candidate.candidateId, now, eventId);
    }
    const row = toCapabilityGapEventRow(
      this.ctx.gatewaySql
        .prepare(
          `
      SELECT *
      FROM capability_gap_events
      WHERE event_id = ?
    `,
        )
        .get(eventId),
    );
    if (!row) {
      throw new Error(`Capability gap event not found after upsert: ${eventId}`);
    }
    return mapCapabilityGapEventRow(row);
  }

  getImprovementReport(reportId: string): WeeklyImprovementReportRecord {
    const row = this.ctx.gatewaySql
      .prepare(
        `
      SELECT *
      FROM improvement_reports
      WHERE report_id = ?
    `,
      )
      .get(reportId) as
      | {
          report_id: string;
          run_id: string;
          week_start: string;
          week_end: string;
          summary_json: string;
          top_findings_json: string;
          applied_tunes_json: string;
          queued_tunes_json: string;
          week_over_week_json: string;
          previous_report_id: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) {
      throw new Error(`Improvement report ${reportId} not found`);
    }
    return mapImprovementReportRow(row);
  }

  getDecisionReplayRun(runId: string): {
    run: DecisionReplayRunRecord;
    items: DecisionReplayItemRecord[];
    findings: DecisionReplayFindingRecord[];
    autoTunes: DecisionAutoTuneRecord[];
    report?: WeeklyImprovementReportRecord;
  } {
    const run = this.readDecisionReplayRun(runId);
    const items = this.listDecisionReplayItems(runId, 1500);
    const findings = this.listDecisionReplayFindings(runId, 300);
    const autoTunes = this.listDecisionAutoTunes(runId, 300);
    const report = run.reportId ? this.getImprovementReport(run.reportId) : undefined;
    return { run, items, findings, autoTunes, report };
  }

  async runImprovementReplayManually(input: ImprovementReplayTriggerInput = {}): Promise<{
    run: DecisionReplayRunRecord;
    report?: WeeklyImprovementReportRecord;
  }> {
    return this.runDecisionReplayAudit({
      triggerMode: "manual",
      sampleSize: clampInt(input.sampleSize, IMPROVEMENT_WEEKLY_SAMPLE_SIZE, 50, 2000),
    });
  }

  approveDecisionAutoTune(tuneId: string): DecisionAutoTuneRecord {
    const tune = this.readDecisionAutoTune(tuneId);
    if (tune.status === "applied") {
      return tune;
    }
    if (tune.status !== "queued") {
      throw new Error(`Auto-tune ${tuneId} is ${tune.status} and cannot be approved.`);
    }
    if (tune.riskLevel !== "low") {
      throw new Error(`Auto-tune ${tuneId} is ${tune.riskLevel} risk and requires manual code review.`);
    }
    return this.applyDecisionAutoTune(tuneId, "manual");
  }

  revertDecisionAutoTune(tuneId: string): DecisionAutoTuneRecord {
    const tune = this.readDecisionAutoTune(tuneId);
    if (tune.status !== "applied") {
      throw new Error(`Auto-tune ${tuneId} is ${tune.status} and cannot be reverted.`);
    }
    const snapshot = tune.snapshot ?? {};
    const settingKey = typeof snapshot.settingKey === "string" ? snapshot.settingKey : undefined;
    if (!settingKey) {
      throw new Error(`Auto-tune ${tuneId} does not contain a rollback snapshot.`);
    }
    const previousValue = snapshot.previousValue;
    if (previousValue === undefined) {
      this.ctx.storage.systemSettings.set(settingKey, null);
    } else {
      this.ctx.storage.systemSettings.set(settingKey, previousValue);
    }
    const revertedAt = new Date().toISOString();
    this.ctx.gatewaySql
      .prepare(
        `
      UPDATE decision_autotunes
      SET status = 'reverted', reverted_at = @revertedAt, result_json = @resultJson
      WHERE tune_id = @tuneId
    `,
      )
      .run({
        tuneId,
        revertedAt,
        resultJson: JSON.stringify({
          revertedBy: "operator",
          restoredSetting: settingKey,
        }),
      });
    this.ctx.publishRealtime("improvement_autotune_reverted", "improvement", {
      tuneId,
      settingKey,
      revertedAt,
    });
    return this.readDecisionAutoTune(tuneId);
  }

  createReplayOverrideDraft(
    sourceRunId: string,
    overrides: ReplayOverrideStep[] = [],
    _links?: { capabilityGapEventId?: string; repairCandidateId?: string },
  ): ReplayOverrideDraft {
    this.ctx.requireFeatureEnabled("replayOverridesV1Enabled");
    const now = new Date().toISOString();
    const replayRunId = randomUUID();
    const normalized = this.normalizeReplayOverrides(overrides);
    this.ctx.gatewaySql
      .prepare(
        `
      INSERT INTO replay_override_runs (
        replay_run_id, source_run_id, status, override_summary_json, diff_summary_json, created_at, updated_at
      ) VALUES (
        @replayRunId, @sourceRunId, 'draft', @overrideSummaryJson, NULL, @createdAt, @updatedAt
      )
    `,
      )
      .run({
        replayRunId,
        sourceRunId,
        overrideSummaryJson: JSON.stringify({
          count: normalized.length,
          stepKeys: normalized.map((item) => item.stepKey),
        }),
        createdAt: now,
        updatedAt: now,
      });
    this.replaceReplayOverrideSteps(replayRunId, normalized);
    return {
      replayRunId,
      sourceRunId,
      status: "draft",
      overrides: normalized,
      createdAt: now,
      updatedAt: now,
    };
  }

  executeReplayOverride(
    sourceRunId: string,
    overrides: ReplayOverrideStep[] = [],
    links?: { capabilityGapEventId?: string; repairCandidateId?: string },
  ): ReplayOverrideDraft {
    this.ctx.requireFeatureEnabled("replayOverridesV1Enabled");
    const draft = this.createReplayOverrideDraft(sourceRunId, overrides, links);
    const runningAt = new Date().toISOString();
    this.ctx.gatewaySql
      .prepare(
        `
      UPDATE replay_override_runs
      SET status = 'running', updated_at = @updatedAt
      WHERE replay_run_id = @replayRunId
    `,
      )
      .run({
        replayRunId: draft.replayRunId,
        updatedAt: runningAt,
      });

    const summary = this.computeReplayDiffSummary(sourceRunId, draft.replayRunId, draft.overrides);
    const finishedAt = new Date().toISOString();
    this.ctx.gatewaySql
      .prepare(
        `
      UPDATE replay_override_runs
      SET status = 'completed',
          diff_summary_json = @diffSummaryJson,
          updated_at = @updatedAt
      WHERE replay_run_id = @replayRunId
    `,
      )
      .run({
        replayRunId: draft.replayRunId,
        diffSummaryJson: JSON.stringify(summary),
        updatedAt: finishedAt,
      });
    this.ctx.publishRealtime("system", "improvement", {
      type: "replay_override_completed",
      replayRunId: draft.replayRunId,
      sourceRunId,
    });
    return {
      ...draft,
      status: "completed",
      updatedAt: finishedAt,
      finishedAt,
    };
  }

  getReplayDiffSummary(replayRunId: string): ReplayDiffSummary {
    this.ctx.requireFeatureEnabled("replayOverridesV1Enabled");
    const row = this.ctx.gatewaySql
      .prepare(
        `
      SELECT replay_run_id, source_run_id, status, diff_summary_json, updated_at
      FROM replay_override_runs
      WHERE replay_run_id = ?
    `,
      )
      .get(replayRunId) as
      | {
          replay_run_id: string;
          source_run_id: string;
          status: ReplayOverrideDraft["status"];
          diff_summary_json: string | null;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      throw new Error(`Replay override run not found: ${replayRunId}`);
    }
    const parsed = safeJsonParse<Record<string, unknown>>(row.diff_summary_json ?? "", {});
    return {
      replayRunId: row.replay_run_id,
      sourceRunId: row.source_run_id,
      status: row.status === "failed" ? "failed" : "completed",
      summary: {
        latencyDeltaMs: Number.isFinite(Number(parsed.latencyDeltaMs)) ? Number(parsed.latencyDeltaMs) : 0,
        inputTokensDelta: Number.isFinite(Number(parsed.inputTokensDelta)) ? Number(parsed.inputTokensDelta) : 0,
        outputTokensDelta: Number.isFinite(Number(parsed.outputTokensDelta)) ? Number(parsed.outputTokensDelta) : 0,
        cachedInputTokensDelta: Number.isFinite(Number(parsed.cachedInputTokensDelta))
          ? Number(parsed.cachedInputTokensDelta)
          : 0,
        costUsdDelta: Number.isFinite(Number(parsed.costUsdDelta)) ? Number(parsed.costUsdDelta) : 0,
        errorChanged: Boolean(parsed.errorChanged),
      },
      comparedAt: row.updated_at,
    };
  }

  // ── private helpers ──────────────────────────────────────────────

  private normalizeReplayOverrides(overrides: ReplayOverrideStep[]): ReplayOverrideStep[] {
    const normalized: ReplayOverrideStep[] = [];
    for (const item of overrides ?? []) {
      const stepKey = item.stepKey?.trim();
      if (!stepKey) continue;
      normalized.push({ stepKey, overrideKind: item.overrideKind, override: item.override ?? {} });
    }
    return normalized;
  }

  private replaceReplayOverrideSteps(replayRunId: string, overrides: ReplayOverrideStep[]): void {
    this.ctx.gatewaySql.prepare("DELETE FROM replay_override_steps WHERE replay_run_id = ?").run(replayRunId);
    const insert = this.ctx.gatewaySql.prepare(`
      INSERT INTO replay_override_steps (step_id, replay_run_id, step_key, override_type, override_payload_json, created_at)
      VALUES (@stepId, @replayRunId, @stepKey, @overrideType, @overridePayloadJson, @createdAt)
    `);
    const now = new Date().toISOString();
    for (const override of overrides) {
      insert.run({
        stepId: randomUUID(),
        replayRunId,
        stepKey: override.stepKey,
        overrideType: override.overrideKind,
        overridePayloadJson: JSON.stringify(override.override ?? {}),
        createdAt: now,
      });
    }
  }

  private computeReplayDiffSummary(
    sourceRunId: string,
    replayRunId: string,
    overrides: ReplayOverrideStep[],
  ): ReplayDiffSummary["summary"] {
    void sourceRunId;
    void replayRunId;
    return {
      latencyDeltaMs: 0,
      inputTokensDelta: 0,
      outputTokensDelta: 0,
      cachedInputTokensDelta: 0,
      costUsdDelta: Number(overrides.length) * 0,
      errorChanged: false,
    };
  }

  private upsertRepairCandidate(input: {
    causeClass: CapabilityGapCauseClass;
    requestedTool?: string;
    toolProfile?: string;
    providerId?: string;
    configArea?: string;
    confidence: number;
    eventCount: number;
  }): RepairCandidateRecord {
    const now = new Date().toISOString();
    const fingerprint = buildCapabilityGapFingerprint(input);
    const existing = this.ctx.gatewaySql
      .prepare(
        `
      SELECT *
      FROM repair_candidates
      WHERE fingerprint = ?
      LIMIT 1
    `,
      )
      .get(fingerprint) as RepairCandidateRow | undefined;
    const candidateId = existing?.candidate_id ?? randomUUID();
    const title = buildRepairCandidateTitle(input.causeClass, input.requestedTool);
    const summary = buildRepairCandidateSummary(input);
    const suggestedPatch = buildSuggestedRepairPatch(input);

    this.ctx.gatewaySql
      .prepare(
        `
      INSERT INTO repair_candidates (
        candidate_id,
        fingerprint,
        cause_class,
        title,
        summary,
        requested_tool,
        tool_profile,
        provider_id,
        config_area,
        suggested_patch,
        replay_run_id,
        validation_status,
        validation_summary,
        event_count,
        confidence,
        created_at,
        updated_at,
        last_seen_at
      ) VALUES (
        @candidateId,
        @fingerprint,
        @causeClass,
        @title,
        @summary,
        @requestedTool,
        @toolProfile,
        @providerId,
        @configArea,
        @suggestedPatch,
        @replayRunId,
        @validationStatus,
        @validationSummary,
        @eventCount,
        @confidence,
        @createdAt,
        @updatedAt,
        @lastSeenAt
      )
      ON CONFLICT(candidate_id) DO UPDATE SET
        requested_tool = COALESCE(excluded.requested_tool, repair_candidates.requested_tool),
        tool_profile = COALESCE(excluded.tool_profile, repair_candidates.tool_profile),
        provider_id = COALESCE(excluded.provider_id, repair_candidates.provider_id),
        config_area = COALESCE(excluded.config_area, repair_candidates.config_area),
        suggested_patch = COALESCE(excluded.suggested_patch, repair_candidates.suggested_patch),
        title = excluded.title,
        summary = excluded.summary,
        event_count = excluded.event_count,
        confidence = CASE
          WHEN excluded.confidence > repair_candidates.confidence THEN excluded.confidence
          ELSE repair_candidates.confidence
        END,
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at
    `,
      )
      .run({
        candidateId,
        fingerprint,
        causeClass: input.causeClass,
        title,
        summary,
        requestedTool: input.requestedTool ?? null,
        toolProfile: input.toolProfile ?? null,
        providerId: input.providerId ?? null,
        configArea: input.configArea ?? null,
        suggestedPatch: suggestedPatch ?? null,
        replayRunId: existing?.replay_run_id ?? null,
        validationStatus: existing?.validation_status ?? "not_started",
        validationSummary: existing?.validation_summary ?? null,
        eventCount: Math.max(1, input.eventCount),
        confidence: clamp01(input.confidence),
        createdAt: existing?.created_at ?? now,
        updatedAt: now,
        lastSeenAt: now,
      });

    const row = toRepairCandidateRow(
      this.ctx.gatewaySql
        .prepare(
          `
      SELECT *
      FROM repair_candidates
      WHERE candidate_id = ?
    `,
        )
        .get(candidateId),
    );
    if (!row) {
      throw new Error(`Repair candidate not found after upsert: ${candidateId}`);
    }
    return mapRepairCandidateRow(row);
  }

  private ensureCapabilityGapTables(): void {
    this.ctx.gatewaySql.exec(`
      CREATE TABLE IF NOT EXISTS capability_gap_events (
        event_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        run_id TEXT,
        cause_class TEXT NOT NULL,
        failure_class TEXT,
        prompt_excerpt TEXT,
        prompt_ref TEXT,
        requested_tool TEXT,
        tool_family TEXT,
        tool_profile TEXT,
        policy_reason TEXT,
        provider_id TEXT,
        model TEXT,
        config_area TEXT,
        suggested_repair_class TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        repeat_count INTEGER NOT NULL DEFAULT 1,
        recovery_options_json TEXT NOT NULL DEFAULT '[]',
        replay_run_id TEXT,
        replay_status TEXT NOT NULL DEFAULT 'not_run',
        repair_candidate_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_gap_events_fingerprint
        ON capability_gap_events(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_capability_gap_events_updated
        ON capability_gap_events(updated_at DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_capability_gap_events_cause
        ON capability_gap_events(cause_class, updated_at DESC);
      CREATE TABLE IF NOT EXISTS repair_candidates (
        candidate_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        cause_class TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        requested_tool TEXT,
        tool_profile TEXT,
        provider_id TEXT,
        config_area TEXT,
        suggested_patch TEXT,
        replay_run_id TEXT,
        validation_status TEXT NOT NULL DEFAULT 'not_started',
        validation_summary TEXT,
        event_count INTEGER NOT NULL DEFAULT 1,
        confidence REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_candidates_fingerprint
        ON repair_candidates(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_repair_candidates_last_seen
        ON repair_candidates(last_seen_at DESC, updated_at DESC);
    `);
  }

  private readDecisionReplayRun(runId: string): DecisionReplayRunRecord {
    const row = this.ctx.gatewaySql
      .prepare(
        `
      SELECT * FROM decision_replay_runs WHERE run_id = ?
    `,
      )
      .get(runId) as
      | {
          run_id: string;
          trigger_mode: "scheduled" | "manual";
          sample_size: number;
          window_start: string;
          window_end: string;
          status: string;
          report_id: string | null;
          total_candidates: number;
          total_scored: number;
          likely_wrong_count: number;
          model_judged_count: number;
          started_at: string;
          finished_at: string | null;
          error_text: string | null;
        }
      | undefined;
    if (!row) {
      throw new Error(`Decision replay run ${runId} not found`);
    }
    return mapDecisionReplayRunRow(row);
  }

  private listDecisionReplayItems(runId: string, limit = 500): DecisionReplayItemRecord[] {
    const rows = this.ctx.gatewaySql
      .prepare(
        `
      SELECT * FROM decision_replay_items WHERE run_id = ?
      ORDER BY wrongness_probability DESC, occurred_at DESC LIMIT ?
    `,
      )
      .all(runId, Math.max(1, Math.min(limit, 5000))) as Array<{
      item_id: string;
      run_id: string;
      decision_type: "chat_turn" | "tool_run";
      session_id: string | null;
      turn_id: string | null;
      tool_run_id: string | null;
      occurred_at: string;
      wrongness_probability: number;
      label: DecisionReplayItemRecord["label"];
      cause_class: string;
      cluster_key: string;
      rule_scores_json: string;
      model_scores_json: string | null;
      evidence_json: string;
      summary_text: string | null;
      input_excerpt: string | null;
      output_excerpt: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      itemId: row.item_id,
      runId: row.run_id,
      decisionType: row.decision_type,
      sessionId: row.session_id ?? undefined,
      turnId: row.turn_id ?? undefined,
      toolRunId: row.tool_run_id ?? undefined,
      occurredAt: row.occurred_at,
      wrongnessProbability: Number(row.wrongness_probability),
      label: row.label,
      causeClass: normalizeDecisionReplayCauseClass(row.cause_class),
      clusterKey: row.cluster_key,
      ruleScores: safeJsonParse<DecisionReplayItemRuleScores>(row.rule_scores_json, {
        honesty: 0.5,
        blockerQuality: 0.5,
        retryQuality: 0.5,
        toolEvidence: 0.5,
        actionability: 0.5,
      }),
      modelScores: row.model_scores_json
        ? safeJsonParse<DecisionReplayItemModelScores | undefined>(row.model_scores_json, undefined)
        : undefined,
      evidence: safeJsonParse<string[]>(row.evidence_json, []),
      summary: row.summary_text ?? undefined,
      inputExcerpt: row.input_excerpt ?? undefined,
      outputExcerpt: row.output_excerpt ?? undefined,
      createdAt: row.created_at,
    }));
  }

  private listDecisionReplayFindings(runId: string, limit = 100): DecisionReplayFindingRecord[] {
    const rows = this.ctx.gatewaySql
      .prepare(
        `
      SELECT * FROM decision_replay_findings WHERE run_id = ?
      ORDER BY is_duplicate ASC, recurrence_count DESC, avg_wrongness DESC LIMIT ?
    `,
      )
      .all(runId, Math.max(1, Math.min(limit, 1000))) as Array<{
      finding_id: string;
      run_id: string;
      fingerprint: string;
      cause_class: string;
      cluster_key: string;
      severity: "low" | "medium" | "high";
      recurrence_count: number;
      impacted_sessions: number;
      impacted_turns: number;
      avg_wrongness: number;
      title: string;
      summary: string;
      recommendation: string | null;
      is_duplicate: number;
      duplicate_of_fingerprint: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      findingId: row.finding_id,
      runId: row.run_id,
      fingerprint: row.fingerprint,
      causeClass: normalizeDecisionReplayCauseClass(row.cause_class),
      clusterKey: row.cluster_key,
      severity: row.severity,
      recurrenceCount: row.recurrence_count,
      impactedSessions: row.impacted_sessions,
      impactedTurns: row.impacted_turns,
      avgWrongness: row.avg_wrongness,
      title: row.title,
      summary: row.summary,
      recommendation: row.recommendation ?? undefined,
      isDuplicate: Boolean(row.is_duplicate),
      duplicateOfFingerprint: row.duplicate_of_fingerprint ?? undefined,
      createdAt: row.created_at,
    }));
  }

  private listDecisionAutoTunes(runId: string, limit = 100): DecisionAutoTuneRecord[] {
    const rows = this.ctx.gatewaySql
      .prepare(
        `
      SELECT * FROM decision_autotunes WHERE run_id = ?
      ORDER BY created_at DESC LIMIT ?
    `,
      )
      .all(runId, Math.max(1, Math.min(limit, 1000))) as Array<{
      tune_id: string;
      run_id: string;
      finding_id: string | null;
      tune_class: DecisionAutoTuneRecord["tuneClass"];
      risk_level: DecisionAutoTuneRecord["riskLevel"];
      status: DecisionAutoTuneRecord["status"];
      description: string;
      patch_json: string;
      snapshot_json: string | null;
      result_json: string | null;
      created_at: string;
      applied_at: string | null;
      reverted_at: string | null;
    }>;
    return rows.map((row) => mapDecisionAutoTuneRow(row));
  }

  private readDecisionAutoTune(tuneId: string): DecisionAutoTuneRecord {
    const row = this.ctx.gatewaySql
      .prepare(
        `
      SELECT * FROM decision_autotunes WHERE tune_id = ?
    `,
      )
      .get(tuneId) as
      | {
          tune_id: string;
          run_id: string;
          finding_id: string | null;
          tune_class: DecisionAutoTuneRecord["tuneClass"];
          risk_level: DecisionAutoTuneRecord["riskLevel"];
          status: DecisionAutoTuneRecord["status"];
          description: string;
          patch_json: string;
          snapshot_json: string | null;
          result_json: string | null;
          created_at: string;
          applied_at: string | null;
          reverted_at: string | null;
        }
      | undefined;
    if (!row) {
      throw new Error(`Auto-tune ${tuneId} not found`);
    }
    return mapDecisionAutoTuneRow(row);
  }

  private applyDecisionAutoTune(tuneId: string, mode: "auto" | "manual"): DecisionAutoTuneRecord {
    const tune = this.readDecisionAutoTune(tuneId);
    if (tune.riskLevel !== "low") {
      throw new Error(`Auto-tune ${tuneId} is ${tune.riskLevel} risk and cannot auto-apply.`);
    }
    const settingKey = typeof tune.patch.settingKey === "string" ? tune.patch.settingKey : undefined;
    if (!settingKey) {
      throw new Error(`Auto-tune ${tuneId} is missing settingKey patch data.`);
    }
    const nextValue = tune.patch.nextValue;
    this.ctx.storage.systemSettings.set(settingKey, nextValue);
    const appliedAt = new Date().toISOString();
    this.ctx.gatewaySql
      .prepare(
        `
      UPDATE decision_autotunes
      SET status = 'applied', applied_at = @appliedAt, result_json = @resultJson
      WHERE tune_id = @tuneId
    `,
      )
      .run({
        tuneId,
        appliedAt,
        resultJson: JSON.stringify({ appliedBy: mode, settingKey, nextValue }),
      });
    this.ctx.publishRealtime("improvement_autotune_applied", "improvement", {
      tuneId,
      settingKey,
      mode,
    });
    return this.readDecisionAutoTune(tuneId);
  }

  private async runDecisionReplayAudit(input: { triggerMode: "scheduled" | "manual"; sampleSize: number }): Promise<{
    run: DecisionReplayRunRecord;
    report?: WeeklyImprovementReportRecord;
  }> {
    const startedAt = new Date();
    const windowEnd = startedAt.toISOString();
    const windowStart = new Date(startedAt.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const runId = randomUUID();
    this.ctx.gatewaySql
      .prepare(
        `
      INSERT INTO decision_replay_runs (
        run_id, trigger_mode, sample_size, window_start, window_end, status,
        total_candidates, total_scored, likely_wrong_count, model_judged_count, started_at
      ) VALUES (
        @runId, @triggerMode, @sampleSize, @windowStart, @windowEnd, 'running',
        0, 0, 0, 0, @startedAt
      )
    `,
      )
      .run({
        runId,
        triggerMode: input.triggerMode,
        sampleSize: input.sampleSize,
        windowStart,
        windowEnd,
        startedAt: startedAt.toISOString(),
      });
    this.ctx.publishRealtime("improvement_replay_started", "improvement", {
      runId,
      triggerMode: input.triggerMode,
      sampleSize: input.sampleSize,
      windowStart,
      windowEnd,
    });

    try {
      const candidates = await this.selectDecisionReplayCandidates(windowStart, windowEnd, input.sampleSize);
      const sample = sampleDecisionReplayCandidates(candidates, input.sampleSize);
      this.ctx.gatewaySql
        .prepare(
          `
        UPDATE decision_replay_runs SET total_candidates = @totalCandidates WHERE run_id = @runId
      `,
        )
        .run({ runId, totalCandidates: candidates.length });

      const scored = await this.scoreDecisionReplayCandidates(runId, sample, {
        onProgress: (progress) => {
          this.ctx.gatewaySql
            .prepare(
              `
            UPDATE decision_replay_runs
            SET total_scored = @totalScored, model_judged_count = @modelJudgedCount
            WHERE run_id = @runId
          `,
            )
            .run({ runId, totalScored: progress.totalScored, modelJudgedCount: progress.modelJudgedCount });
          if (progress.totalScored % 20 === 0 || progress.totalScored === sample.length) {
            this.ctx.publishRealtime("improvement_replay_progress", "improvement", {
              runId,
              totalScored: progress.totalScored,
              totalCandidates: candidates.length,
              modelJudgedCount: progress.modelJudgedCount,
            });
          }
        },
      });
      const items = scored.map((entry) => entry.item);
      this.insertDecisionReplayItems(items);
      const findings = this.buildDecisionReplayFindings(runId, items);
      const dedupedFindings = this.tagDuplicateDecisionReplayFindings(findings);
      this.insertDecisionReplayFindings(dedupedFindings);
      const plannedTunes = this.planDecisionAutoTunes(runId, dedupedFindings);
      const appliedAutoTunes: DecisionAutoTuneRecord[] = [];
      const queuedRecommendations: DecisionAutoTuneRecord[] = [];
      for (const planned of plannedTunes) {
        this.insertDecisionAutoTune(planned);
        if (planned.riskLevel === "low") {
          appliedAutoTunes.push(this.applyDecisionAutoTune(planned.tuneId, "auto"));
        } else {
          queuedRecommendations.push(planned);
        }
      }
      const report = this.createWeeklyImprovementReport({
        runId,
        windowStart,
        windowEnd,
        items,
        findings: dedupedFindings,
        appliedAutoTunes,
        queuedRecommendations,
      });
      this.markDecisionReplayRunCompleted({
        runId,
        reportId: report.reportId,
        totalCandidates: candidates.length,
        totalScored: items.length,
        likelyWrongCount: items.filter((item) => item.label === "likely_wrong").length,
        modelJudgedCount: scored.filter((entry) => entry.judgeUsed).length,
      });
      this.persistDecisionReplayDedup(dedupedFindings, report.reportId);
      this.ctx.publishRealtime("improvement_replay_completed", "improvement", {
        runId,
        reportId: report.reportId,
        sampledDecisions: items.length,
        likelyWrongCount: items.filter((item) => item.label === "likely_wrong").length,
        appliedAutoTunes: appliedAutoTunes.length,
        queuedRecommendations: queuedRecommendations.length,
      });
      return { run: this.readDecisionReplayRun(runId), report };
    } catch (error) {
      const finishedAt = new Date().toISOString();
      this.ctx.gatewaySql
        .prepare(
          `
        UPDATE decision_replay_runs
        SET status = 'failed', error_text = @errorText, finished_at = @finishedAt
        WHERE run_id = @runId
      `,
        )
        .run({ runId, errorText: (error as Error).message, finishedAt });
      this.ctx.publishRealtime("improvement_replay_failed", "improvement", {
        runId,
        message: (error as Error).message,
      });
      throw error;
    }
  }

  // The following methods are large and contain the core scoring/planning logic.
  // They are included here to keep the service self-contained.

  private async selectDecisionReplayCandidates(
    windowStart: string,
    windowEnd: string,
    sampleSize: number,
  ): Promise<DecisionReplayCandidate[]> {
    const fetchLimit = Math.max(1000, Math.min(sampleSize * 8, 6000));
    const turnRows = this.ctx.gatewaySql
      .prepare(
        `
      SELECT turn_id, session_id, user_message_id, assistant_message_id, status, mode, model,
             web_mode, memory_mode, thinking_level, routing_json, retrieval_json, reflection_json,
             started_at, finished_at
      FROM chat_turn_traces
      WHERE started_at >= @windowStart AND started_at <= @windowEnd
      ORDER BY started_at DESC LIMIT @limit
    `,
      )
      .all({ windowStart, windowEnd, limit: fetchLimit }) as Array<Record<string, unknown>>;

    const toolRows = this.ctx.gatewaySql
      .prepare(
        `
      SELECT tool_run_id, turn_id, session_id, tool_name, status, error, args_json, result_json, started_at
      FROM chat_tool_runs
      WHERE started_at >= @windowStart AND started_at <= @windowEnd
      ORDER BY started_at DESC LIMIT @limit
    `,
      )
      .all({ windowStart, windowEnd, limit: fetchLimit }) as Array<Record<string, unknown>>;

    const turns: DecisionReplayCandidate[] = turnRows.map((row: Record<string, unknown>) => ({
      decisionType: "chat_turn" as const,
      sessionId: row.session_id as string,
      turnId: row.turn_id as string,
      status: row.status as string,
      occurredAt: (row.finished_at ?? row.started_at) as string,
      model: (row.model as string) ?? undefined,
      mode: row.mode as ChatMode,
      webMode: row.web_mode as ChatWebMode,
      memoryMode: row.memory_mode as ChatMemoryMode,
      thinkingLevel: row.thinking_level as ChatThinkingLevel,
      routing: safeJsonParse<ChatTurnTraceRecord["routing"]>(row.routing_json as string, {}),
      retrieval: safeJsonParse<ChatTurnTraceRecord["retrieval"] | undefined>(
        (row.retrieval_json as string) ?? "",
        undefined,
      ),
      reflection: safeJsonParse<ChatTurnTraceRecord["reflection"] | undefined>(
        (row.reflection_json as string) ?? "",
        undefined,
      ),
      userMessageId: row.user_message_id as string,
      assistantMessageId: (row.assistant_message_id as string) ?? undefined,
    }));
    const tools: DecisionReplayCandidate[] = toolRows.map((row: Record<string, unknown>) => ({
      decisionType: "tool_run" as const,
      sessionId: row.session_id as string,
      turnId: row.turn_id as string,
      toolRunId: row.tool_run_id as string,
      status: row.status as string,
      occurredAt: row.started_at as string,
      toolName: row.tool_name as string,
      error: (row.error as string) ?? undefined,
      args: row.args_json ? safeJsonParse<Record<string, unknown>>(row.args_json as string, {}) : undefined,
      result: row.result_json ? safeJsonParse<Record<string, unknown>>(row.result_json as string, {}) : undefined,
    }));
    return [...turns, ...tools].sort((l, r) => Date.parse(r.occurredAt) - Date.parse(l.occurredAt));
  }

  private async scoreDecisionReplayCandidates(
    runId: string,
    candidates: DecisionReplayCandidate[],
    options?: { onProgress?: (p: { totalScored: number; modelJudgedCount: number }) => void },
  ): Promise<ReplayScoredItemResult[]> {
    const byTurn = new Map<string, DecisionReplayCandidate[]>();
    for (const c of candidates) {
      if (!c.turnId) continue;
      const list = byTurn.get(c.turnId) ?? [];
      list.push(c);
      byTurn.set(c.turnId, list);
    }
    const messageCache = new Map<string, Map<string, string>>();
    const results: ReplayScoredItemResult[] = [];
    let modelJudgeCount = 0;
    for (const candidate of candidates) {
      const excerpts = await this.buildDecisionReplayExcerpts(candidate, messageCache);
      const turnTools = candidate.turnId
        ? (byTurn.get(candidate.turnId) ?? []).filter((i) => i.decisionType === "tool_run")
        : [];
      const ruleEval = evaluateDecisionReplayRuleScores(candidate, turnTools);
      let modelScores: DecisionReplayItemModelScores | undefined;
      let judgeUsed = false;
      if (
        modelJudgeCount < IMPROVEMENT_JUDGE_SAMPLE_LIMIT &&
        (candidate.decisionType === "chat_turn" || candidate.status === "failed")
      ) {
        modelScores = await this.judgeDecisionReplayCandidate(candidate, excerpts, ruleEval.scores);
        if (modelScores) {
          judgeUsed = true;
          modelJudgeCount += 1;
        }
      }
      const wrongnessProbability = computeDecisionWrongnessProbability(candidate, ruleEval.scores, modelScores);
      const causeClass = inferDecisionReplayCauseClass(candidate, ruleEval.scores, wrongnessProbability);
      const clusterKey = `${causeClass}:${candidate.decisionType}:${candidate.toolName ?? candidate.status}`.slice(
        0,
        140,
      );
      const label: DecisionReplayItemRecord["label"] =
        wrongnessProbability >= 0.68 ? "likely_wrong" : wrongnessProbability >= 0.45 ? "uncertain" : "ok";
      const evidence = [...ruleEval.signals];
      if (judgeUsed) evidence.push("model_judged");
      if (candidate.toolName) evidence.push(`tool:${candidate.toolName}`);
      results.push({
        item: {
          itemId: randomUUID(),
          runId,
          decisionType: candidate.decisionType,
          sessionId: candidate.sessionId,
          turnId: candidate.turnId,
          toolRunId: candidate.toolRunId,
          occurredAt: candidate.occurredAt,
          wrongnessProbability,
          label,
          causeClass,
          clusterKey,
          ruleScores: ruleEval.scores,
          modelScores,
          evidence,
          summary: buildDecisionReplayItemSummary(candidate, causeClass),
          inputExcerpt: excerpts.inputExcerpt,
          outputExcerpt: excerpts.outputExcerpt,
          createdAt: new Date().toISOString(),
        },
        judgeUsed,
      });
      options?.onProgress?.({ totalScored: results.length, modelJudgedCount: modelJudgeCount });
    }
    return results;
  }

  private async buildDecisionReplayExcerpts(
    candidate: DecisionReplayCandidate,
    messageCache: Map<string, Map<string, string>>,
  ): Promise<{ inputExcerpt?: string; outputExcerpt?: string }> {
    if (candidate.decisionType === "tool_run") {
      return {
        inputExcerpt: truncateForModelJudge(candidate.args ? JSON.stringify(candidate.args, null, 2) : "", 1800),
        outputExcerpt: truncateForModelJudge(
          candidate.error ?? (candidate.result ? JSON.stringify(candidate.result, null, 2) : ""),
          1800,
        ),
      };
    }
    if (!candidate.sessionId) return {};
    let sessionMessages = messageCache.get(candidate.sessionId);
    if (!sessionMessages) {
      const map = new Map<string, string>();
      const transcript = await this.callbacks.readTranscriptOrEmpty(candidate.sessionId);
      for (const event of transcript) {
        if ((event.type === "message.user" || event.type === "message.assistant") && event.eventId) {
          const payload = event.payload as { message?: { content?: unknown } };
          const content = typeof payload.message?.content === "string" ? payload.message.content : "";
          map.set(event.eventId, content);
        }
      }
      messageCache.set(candidate.sessionId, map);
      sessionMessages = map;
    }
    return {
      inputExcerpt: candidate.userMessageId
        ? truncateForModelJudge(sessionMessages.get(candidate.userMessageId) ?? "", 2200)
        : undefined,
      outputExcerpt: candidate.assistantMessageId
        ? truncateForModelJudge(sessionMessages.get(candidate.assistantMessageId) ?? "", 2500)
        : undefined,
    };
  }

  private async judgeDecisionReplayCandidate(
    candidate: DecisionReplayCandidate,
    excerpts: { inputExcerpt?: string; outputExcerpt?: string },
    ruleScores: DecisionReplayItemRuleScores,
  ): Promise<DecisionReplayItemModelScores | undefined> {
    const defaults = this.callbacks.getPromptRunnerModelDefaults();
    if (!defaults.providerId || !defaults.model) return undefined;
    const prompt = [
      "You are grading one agent decision replay item.",
      "Return JSON only with keys: correctnessLikelihood, missedToolProbability, betterResponsePotential, rationale.",
      "Each probability must be a number between 0 and 1.",
      `Decision type: ${candidate.decisionType}`,
      `Decision status: ${candidate.status}`,
      `Tool: ${candidate.toolName ?? "n/a"}`,
      `Rule score snapshot: ${JSON.stringify(ruleScores)}`,
      "",
      "Input excerpt:",
      excerpts.inputExcerpt ?? "(none)",
      "",
      "Output excerpt:",
      excerpts.outputExcerpt ?? "(none)",
    ].join("\n");
    try {
      const completion = await withTimeout(
        this.callbacks.createChatCompletion({
          providerId: defaults.providerId,
          model: defaults.model,
          messages: [
            { role: "system", content: "Grade strictly. JSON only." },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          max_tokens: 220,
        }),
        IMPROVEMENT_JUDGE_TIMEOUT_MS,
        `Decision replay judge timed out after ${IMPROVEMENT_JUDGE_TIMEOUT_MS}ms`,
      );
      const payload = parseLooseJsonRecord(extractCompletionText(completion));
      if (!payload) return undefined;
      return {
        correctnessLikelihood: clampProbability(payload.correctnessLikelihood),
        missedToolProbability: clampProbability(payload.missedToolProbability),
        betterResponsePotential: clampProbability(payload.betterResponsePotential),
        rationale: typeof payload.rationale === "string" ? payload.rationale.slice(0, 500) : undefined,
      };
    } catch {
      return undefined;
    }
  }

  private insertDecisionReplayItems(items: DecisionReplayItemRecord[]): void {
    const insert = this.ctx.gatewaySql.prepare(`
      INSERT INTO decision_replay_items (
        item_id, run_id, decision_type, session_id, turn_id, tool_run_id, occurred_at,
        wrongness_probability, label, cause_class, cluster_key, rule_scores_json, model_scores_json,
        evidence_json, summary_text, input_excerpt, output_excerpt, created_at
      ) VALUES (
        @itemId, @runId, @decisionType, @sessionId, @turnId, @toolRunId, @occurredAt,
        @wrongnessProbability, @label, @causeClass, @clusterKey, @ruleScoresJson, @modelScoresJson,
        @evidenceJson, @summaryText, @inputExcerpt, @outputExcerpt, @createdAt
      )
    `);
    this.ctx.gatewaySql.exec("BEGIN IMMEDIATE");
    try {
      for (const item of items) {
        insert.run({
          itemId: item.itemId,
          runId: item.runId,
          decisionType: item.decisionType,
          sessionId: item.sessionId ?? null,
          turnId: item.turnId ?? null,
          toolRunId: item.toolRunId ?? null,
          occurredAt: item.occurredAt,
          wrongnessProbability: item.wrongnessProbability,
          label: item.label,
          causeClass: item.causeClass,
          clusterKey: item.clusterKey,
          ruleScoresJson: JSON.stringify(item.ruleScores),
          modelScoresJson: item.modelScores ? JSON.stringify(item.modelScores) : null,
          evidenceJson: JSON.stringify(item.evidence),
          summaryText: item.summary ?? null,
          inputExcerpt: item.inputExcerpt ?? null,
          outputExcerpt: item.outputExcerpt ?? null,
          createdAt: item.createdAt,
        });
      }
      this.ctx.gatewaySql.exec("COMMIT");
    } catch (error) {
      this.ctx.gatewaySql.exec("ROLLBACK");
      throw error;
    }
  }

  private buildDecisionReplayFindings(runId: string, items: DecisionReplayItemRecord[]): DecisionReplayFindingRecord[] {
    const relevant = items.filter((item) => item.label !== "ok");
    const grouped = new Map<string, DecisionReplayItemRecord[]>();
    for (const item of relevant) {
      const list = grouped.get(item.clusterKey) ?? [];
      list.push(item);
      grouped.set(item.clusterKey, list);
    }
    const findings: DecisionReplayFindingRecord[] = [];
    for (const [clusterKey, group] of grouped.entries()) {
      if (group.length === 0) continue;
      const causeClass = group[0]?.causeClass ?? "other";
      const avgWrongness = group.reduce((sum, i) => sum + i.wrongnessProbability, 0) / group.length;
      const severity: DecisionReplayFindingRecord["severity"] =
        group.length >= 8 || avgWrongness >= 0.78
          ? "high"
          : group.length >= 4 || avgWrongness >= 0.62
            ? "medium"
            : "low";
      const fingerprint = createHash("sha1")
        .update(`${causeClass}|${clusterKey}|${group[0]?.summary ?? ""}`)
        .digest("hex");
      findings.push({
        findingId: randomUUID(),
        runId,
        fingerprint,
        causeClass,
        clusterKey,
        severity,
        recurrenceCount: group.length,
        impactedSessions: new Set(group.map((i) => i.sessionId).filter(Boolean)).size,
        impactedTurns: new Set(group.map((i) => i.turnId).filter(Boolean)).size,
        avgWrongness: Number(avgWrongness.toFixed(4)),
        title: titleForDecisionReplayCause(causeClass),
        summary: summarizeDecisionReplayFinding(group),
        recommendation: recommendationForDecisionReplayCause(causeClass),
        isDuplicate: false,
        createdAt: new Date().toISOString(),
      });
    }
    return findings.sort(
      (l, r) =>
        severityRank(r.severity) - severityRank(l.severity) ||
        r.recurrenceCount - l.recurrenceCount ||
        r.avgWrongness - l.avgWrongness,
    );
  }

  private tagDuplicateDecisionReplayFindings(findings: DecisionReplayFindingRecord[]): DecisionReplayFindingRecord[] {
    if (findings.length === 0) return findings;
    const stmt = this.ctx.gatewaySql.prepare(`SELECT fingerprint FROM decision_replay_dedup WHERE fingerprint = ?`);
    return findings.map((f) => {
      const existing = stmt.get(f.fingerprint) as { fingerprint: string } | undefined;
      return existing ? { ...f, isDuplicate: true, duplicateOfFingerprint: existing.fingerprint } : f;
    });
  }

  private insertDecisionReplayFindings(findings: DecisionReplayFindingRecord[]): void {
    const insert = this.ctx.gatewaySql.prepare(`
      INSERT INTO decision_replay_findings (
        finding_id, run_id, fingerprint, cause_class, cluster_key, severity, recurrence_count,
        impacted_sessions, impacted_turns, avg_wrongness, title, summary, recommendation,
        is_duplicate, duplicate_of_fingerprint, created_at
      ) VALUES (
        @findingId, @runId, @fingerprint, @causeClass, @clusterKey, @severity, @recurrenceCount,
        @impactedSessions, @impactedTurns, @avgWrongness, @title, @summary, @recommendation,
        @isDuplicate, @duplicateOfFingerprint, @createdAt
      )
    `);
    this.ctx.gatewaySql.exec("BEGIN IMMEDIATE");
    try {
      for (const f of findings) {
        insert.run({
          findingId: f.findingId,
          runId: f.runId,
          fingerprint: f.fingerprint,
          causeClass: f.causeClass,
          clusterKey: f.clusterKey,
          severity: f.severity,
          recurrenceCount: f.recurrenceCount,
          impactedSessions: f.impactedSessions,
          impactedTurns: f.impactedTurns,
          avgWrongness: f.avgWrongness,
          title: f.title,
          summary: f.summary,
          recommendation: f.recommendation ?? null,
          isDuplicate: f.isDuplicate ? 1 : 0,
          duplicateOfFingerprint: f.duplicateOfFingerprint ?? null,
          createdAt: f.createdAt,
        });
      }
      this.ctx.gatewaySql.exec("COMMIT");
    } catch (error) {
      this.ctx.gatewaySql.exec("ROLLBACK");
      throw error;
    }
  }

  private planDecisionAutoTunes(runId: string, findings: DecisionReplayFindingRecord[]): DecisionAutoTuneRecord[] {
    const plans: DecisionAutoTuneRecord[] = [];
    for (const f of findings) {
      if (f.isDuplicate) continue;
      if (f.causeClass === "weak_blocker_explanation" && f.recurrenceCount >= 3) {
        const current = this.ctx.storage.systemSettings.get<number>(IMPROVEMENT_TUNE_KEY_BLOCKER_TEMPLATE)?.value ?? 1;
        plans.push({
          tuneId: randomUUID(),
          runId,
          findingId: f.findingId,
          tuneClass: "prompt_contract",
          riskLevel: "low",
          status: "queued",
          description: "Increase blocker template strictness to improve blocker specificity.",
          patch: { settingKey: IMPROVEMENT_TUNE_KEY_BLOCKER_TEMPLATE, nextValue: Math.min(10, current + 1) },
          snapshot: { settingKey: IMPROVEMENT_TUNE_KEY_BLOCKER_TEMPLATE, previousValue: current },
          createdAt: new Date().toISOString(),
        });
      } else if (f.causeClass === "incomplete_retry_repair" && f.recurrenceCount >= 3) {
        const current = this.ctx.storage.systemSettings.get<number>(IMPROVEMENT_TUNE_KEY_RETRY_THRESHOLD)?.value ?? 1;
        plans.push({
          tuneId: randomUUID(),
          runId,
          findingId: f.findingId,
          tuneClass: "threshold",
          riskLevel: "low",
          status: "queued",
          description: "Lower retry trigger threshold so failed turns attempt one repair more often.",
          patch: { settingKey: IMPROVEMENT_TUNE_KEY_RETRY_THRESHOLD, nextValue: Math.max(0, current - 1) },
          snapshot: { settingKey: IMPROVEMENT_TUNE_KEY_RETRY_THRESHOLD, previousValue: current },
          createdAt: new Date().toISOString(),
        });
      } else if (
        (f.causeClass === "retrieval_miss" || f.causeClass === "false_refusal_tone") &&
        f.recurrenceCount >= 3
      ) {
        const current = this.ctx.storage.systemSettings.get<number>(IMPROVEMENT_TUNE_KEY_LIVE_INTENT)?.value ?? 0.6;
        plans.push({
          tuneId: randomUUID(),
          runId,
          findingId: f.findingId,
          tuneClass: "threshold",
          riskLevel: "low",
          status: "queued",
          description: "Raise live-data intent sensitivity so web retrieval is triggered more reliably.",
          patch: {
            settingKey: IMPROVEMENT_TUNE_KEY_LIVE_INTENT,
            nextValue: Number(Math.min(0.95, current + 0.05).toFixed(2)),
          },
          snapshot: { settingKey: IMPROVEMENT_TUNE_KEY_LIVE_INTENT, previousValue: current },
          createdAt: new Date().toISOString(),
        });
      } else if (f.causeClass === "tool_mismatch" && f.recurrenceCount >= 4) {
        plans.push({
          tuneId: randomUUID(),
          runId,
          findingId: f.findingId,
          tuneClass: "ranking_weight",
          riskLevel: "medium",
          status: "queued",
          description: "Review tool routing weights for this cluster before auto-applying.",
          patch: { settingKey: "improvement_tune_tool_routing_weights_v1", suggestedDelta: 1 },
          createdAt: new Date().toISOString(),
        });
      }
    }
    return plans.slice(0, 12);
  }

  private insertDecisionAutoTune(tune: DecisionAutoTuneRecord): void {
    this.ctx.gatewaySql
      .prepare(
        `
      INSERT INTO decision_autotunes (
        tune_id, run_id, finding_id, tune_class, risk_level, status, description,
        patch_json, snapshot_json, result_json, created_at, applied_at, reverted_at
      ) VALUES (
        @tuneId, @runId, @findingId, @tuneClass, @riskLevel, @status, @description,
        @patchJson, @snapshotJson, NULL, @createdAt, @appliedAt, @revertedAt
      )
    `,
      )
      .run({
        tuneId: tune.tuneId,
        runId: tune.runId,
        findingId: tune.findingId ?? null,
        tuneClass: tune.tuneClass,
        riskLevel: tune.riskLevel,
        status: tune.status,
        description: tune.description,
        patchJson: JSON.stringify(tune.patch),
        snapshotJson: tune.snapshot ? JSON.stringify(tune.snapshot) : null,
        createdAt: tune.createdAt,
        appliedAt: tune.appliedAt ?? null,
        revertedAt: tune.revertedAt ?? null,
      });
  }

  private createWeeklyImprovementReport(input: {
    runId: string;
    windowStart: string;
    windowEnd: string;
    items: DecisionReplayItemRecord[];
    findings: DecisionReplayFindingRecord[];
    appliedAutoTunes: DecisionAutoTuneRecord[];
    queuedRecommendations: DecisionAutoTuneRecord[];
  }): WeeklyImprovementReportRecord {
    const currentCounts = new Map<DecisionReplayCauseClass, number>();
    for (const item of input.items) {
      if (item.label === "ok") continue;
      currentCounts.set(item.causeClass, (currentCounts.get(item.causeClass) ?? 0) + 1);
    }
    const topCauseClasses = Array.from(currentCounts.entries())
      .sort((l, r) => r[1] - l[1])
      .slice(0, 6)
      .map(([causeClass, count]) => ({ causeClass, count }));
    const previous = this.ctx.gatewaySql
      .prepare(
        `
      SELECT * FROM improvement_reports ORDER BY week_end DESC, created_at DESC LIMIT 1
    `,
      )
      .get() as { report_id: string; summary_json: string } | undefined;
    const previousSummary = previous
      ? safeJsonParse<WeeklyImprovementReportRecord["summary"]>(previous.summary_json, {
          sampledDecisions: 0,
          likelyWrongCount: 0,
          wrongnessRate: 0,
          topCauseClasses: [],
          duplicateSuppressedCount: 0,
          improvedCount: 0,
          regressedCount: 0,
        })
      : undefined;
    const previousCounts = new Map<DecisionReplayCauseClass, number>(
      (previousSummary?.topCauseClasses ?? []).map((e) => [e.causeClass, e.count]),
    );
    const weekOverWeek = compareDecisionCauseCounts(currentCounts, previousCounts);
    const report: WeeklyImprovementReportRecord = {
      reportId: randomUUID(),
      runId: input.runId,
      weekStart: input.windowStart,
      weekEnd: input.windowEnd,
      summary: {
        sampledDecisions: input.items.length,
        likelyWrongCount: input.items.filter((i) => i.label === "likely_wrong").length,
        wrongnessRate:
          input.items.length > 0
            ? Number((input.items.reduce((s, i) => s + i.wrongnessProbability, 0) / input.items.length).toFixed(4))
            : 0,
        topCauseClasses,
        duplicateSuppressedCount: input.findings.filter((f) => f.isDuplicate).length,
        improvedCount: weekOverWeek.improved.length,
        regressedCount: weekOverWeek.regressed.length,
      },
      topFindings: input.findings.filter((f) => !f.isDuplicate).slice(0, 10),
      appliedAutoTunes: input.appliedAutoTunes,
      queuedRecommendations: input.queuedRecommendations,
      weekOverWeek,
      previousReportId: previous?.report_id,
      createdAt: new Date().toISOString(),
    };
    this.ctx.gatewaySql
      .prepare(
        `
      INSERT INTO improvement_reports (
        report_id, run_id, week_start, week_end, summary_json, top_findings_json,
        applied_tunes_json, queued_tunes_json, week_over_week_json, previous_report_id, created_at
      ) VALUES (
        @reportId, @runId, @weekStart, @weekEnd, @summaryJson, @topFindingsJson,
        @appliedTunesJson, @queuedTunesJson, @weekOverWeekJson, @previousReportId, @createdAt
      )
    `,
      )
      .run({
        reportId: report.reportId,
        runId: report.runId,
        weekStart: report.weekStart,
        weekEnd: report.weekEnd,
        summaryJson: JSON.stringify(report.summary),
        topFindingsJson: JSON.stringify(report.topFindings),
        appliedTunesJson: JSON.stringify(report.appliedAutoTunes),
        queuedTunesJson: JSON.stringify(report.queuedRecommendations),
        weekOverWeekJson: JSON.stringify(report.weekOverWeek),
        previousReportId: report.previousReportId ?? null,
        createdAt: report.createdAt,
      });
    return report;
  }

  private markDecisionReplayRunCompleted(input: {
    runId: string;
    reportId: string;
    totalCandidates: number;
    totalScored: number;
    likelyWrongCount: number;
    modelJudgedCount: number;
  }): void {
    this.ctx.gatewaySql
      .prepare(
        `
      UPDATE decision_replay_runs SET
        status = 'completed', report_id = @reportId,
        total_candidates = @totalCandidates, total_scored = @totalScored,
        likely_wrong_count = @likelyWrongCount, model_judged_count = @modelJudgedCount,
        finished_at = @finishedAt
      WHERE run_id = @runId
    `,
      )
      .run({ ...input, finishedAt: new Date().toISOString() });
  }

  private persistDecisionReplayDedup(findings: DecisionReplayFindingRecord[], reportId: string): void {
    const upsert = this.ctx.gatewaySql.prepare(`
      INSERT INTO decision_replay_dedup (fingerprint, last_seen_report_id, last_seen_at, occurrence_count, last_summary_hash)
      VALUES (@fingerprint, @reportId, @lastSeenAt, 1, @summaryHash)
      ON CONFLICT(fingerprint) DO UPDATE SET
        last_seen_report_id = excluded.last_seen_report_id, last_seen_at = excluded.last_seen_at,
        occurrence_count = decision_replay_dedup.occurrence_count + 1,
        last_summary_hash = excluded.last_summary_hash
    `);
    for (const f of findings) {
      upsert.run({
        fingerprint: f.fingerprint,
        reportId,
        lastSeenAt: new Date().toISOString(),
        summaryHash: createHash("sha1").update(f.summary).digest("hex"),
      });
    }
  }
}

// ── free-standing helpers ────────────────────────────────────────────

function mapDecisionReplayRunRow(row: {
  run_id: string;
  trigger_mode: "scheduled" | "manual";
  sample_size: number;
  window_start: string;
  window_end: string;
  status: string;
  report_id: string | null;
  total_candidates: number;
  total_scored: number;
  likely_wrong_count: number;
  model_judged_count: number;
  started_at: string;
  finished_at: string | null;
  error_text: string | null;
}): DecisionReplayRunRecord {
  return {
    runId: row.run_id,
    triggerMode: row.trigger_mode,
    sampleSize: row.sample_size,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    status: IMPROVEMENT_RUN_STATUS_VALUES.has(row.status)
      ? (row.status as DecisionReplayRunRecord["status"])
      : "failed",
    reportId: row.report_id ?? undefined,
    totalCandidates: row.total_candidates,
    totalScored: row.total_scored,
    likelyWrongCount: row.likely_wrong_count,
    modelJudgedCount: row.model_judged_count,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    error: row.error_text ?? undefined,
  };
}

function mapDecisionAutoTuneRow(row: {
  tune_id: string;
  run_id: string;
  finding_id: string | null;
  tune_class: DecisionAutoTuneRecord["tuneClass"];
  risk_level: DecisionAutoTuneRecord["riskLevel"];
  status: DecisionAutoTuneRecord["status"];
  description: string;
  patch_json: string;
  snapshot_json: string | null;
  result_json: string | null;
  created_at: string;
  applied_at: string | null;
  reverted_at: string | null;
}): DecisionAutoTuneRecord {
  return {
    tuneId: row.tune_id,
    runId: row.run_id,
    findingId: row.finding_id ?? undefined,
    tuneClass: row.tune_class,
    riskLevel: row.risk_level,
    status: row.status,
    description: row.description,
    patch: safeJsonParse<Record<string, unknown>>(row.patch_json, {}),
    snapshot: row.snapshot_json ? safeJsonParse<Record<string, unknown>>(row.snapshot_json, {}) : undefined,
    result: row.result_json ? safeJsonParse<Record<string, unknown>>(row.result_json, {}) : undefined,
    createdAt: row.created_at,
    appliedAt: row.applied_at ?? undefined,
    revertedAt: row.reverted_at ?? undefined,
  };
}

function mapImprovementReportRow(row: {
  report_id: string;
  run_id: string;
  week_start: string;
  week_end: string;
  summary_json: string;
  top_findings_json: string;
  applied_tunes_json: string;
  queued_tunes_json: string;
  week_over_week_json: string;
  previous_report_id: string | null;
  created_at: string;
}): WeeklyImprovementReportRecord {
  return {
    reportId: row.report_id,
    runId: row.run_id,
    weekStart: row.week_start,
    weekEnd: row.week_end,
    summary: safeJsonParse<WeeklyImprovementReportRecord["summary"]>(row.summary_json, {
      sampledDecisions: 0,
      likelyWrongCount: 0,
      wrongnessRate: 0,
      topCauseClasses: [],
      duplicateSuppressedCount: 0,
      improvedCount: 0,
      regressedCount: 0,
    }),
    topFindings: safeJsonParse<DecisionReplayFindingRecord[]>(row.top_findings_json, []),
    appliedAutoTunes: safeJsonParse<DecisionAutoTuneRecord[]>(row.applied_tunes_json, []),
    queuedRecommendations: safeJsonParse<DecisionAutoTuneRecord[]>(row.queued_tunes_json, []),
    weekOverWeek: safeJsonParse<WeeklyImprovementReportRecord["weekOverWeek"]>(row.week_over_week_json, {
      improved: [],
      regressed: [],
      unchanged: [],
    }),
    previousReportId: row.previous_report_id ?? undefined,
    createdAt: row.created_at,
  };
}

function mapCapabilityGapEventRow(row: CapabilityGapEventRow): CapabilityGapEventRecord {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    turnId: row.turn_id ?? undefined,
    runId: row.run_id ?? undefined,
    causeClass: CAPABILITY_GAP_CAUSE_CLASSES.has(row.cause_class as CapabilityGapCauseClass)
      ? (row.cause_class as CapabilityGapCauseClass)
      : "policy_denied_by_config",
    failureClass: row.failure_class ?? undefined,
    promptExcerpt: row.prompt_excerpt ?? undefined,
    promptRef: row.prompt_ref ?? undefined,
    requestedTool: row.requested_tool ?? undefined,
    toolFamily: row.tool_family ?? undefined,
    toolProfile: row.tool_profile ?? undefined,
    policyReason: row.policy_reason ?? undefined,
    providerId: row.provider_id ?? undefined,
    model: row.model ?? undefined,
    configArea: row.config_area ?? undefined,
    suggestedRepairClass: row.suggested_repair_class ?? undefined,
    confidence: clamp01(row.confidence),
    repeatCount: Math.max(1, row.repeat_count),
    recoveryOptions: normalizeRecoveryOptions(safeJsonParse<string[]>(row.recovery_options_json, [])),
    replayRunId: row.replay_run_id ?? undefined,
    replayStatus: normalizeReplayStatus(row.replay_status),
    repairCandidateId: row.repair_candidate_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRepairCandidateRow(row: RepairCandidateRow): RepairCandidateRecord {
  return {
    candidateId: row.candidate_id,
    fingerprint: row.fingerprint,
    causeClass: CAPABILITY_GAP_CAUSE_CLASSES.has(row.cause_class as CapabilityGapCauseClass)
      ? (row.cause_class as CapabilityGapCauseClass)
      : "policy_denied_by_config",
    title: row.title,
    summary: row.summary,
    requestedTool: row.requested_tool ?? undefined,
    toolProfile: row.tool_profile ?? undefined,
    providerId: row.provider_id ?? undefined,
    configArea: row.config_area ?? undefined,
    suggestedPatch: row.suggested_patch ?? undefined,
    replayRunId: row.replay_run_id ?? undefined,
    validationStatus: normalizeRepairValidationStatus(row.validation_status),
    validationSummary: row.validation_summary ?? undefined,
    eventCount: Math.max(1, row.event_count),
    confidence: clamp01(row.confidence),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

function normalizeRecoveryOptions(values: string[] | undefined): CapabilityGapEventRecord["recoveryOptions"] {
  const allowed = new Set<CapabilityGapEventRecord["recoveryOptions"][number]>([
    "temporary_session_allow",
    "switch_tool_profile",
    "request_approval",
    "install_skill",
    "reroute_provider",
    "retry_once",
    "replay_failed_turn",
    "patch_config",
  ]);
  return [
    ...new Set(
      (values ?? []).filter((value): value is CapabilityGapEventRecord["recoveryOptions"][number] =>
        allowed.has(value as CapabilityGapEventRecord["recoveryOptions"][number]),
      ),
    ),
  ];
}

function normalizeReplayStatus(value: string | null | undefined): CapabilityGapEventRecord["replayStatus"] {
  if (value === "queued" || value === "running" || value === "completed" || value === "failed") {
    return value;
  }
  return "not_run";
}

function normalizeRepairValidationStatus(value: string | null | undefined): RepairCandidateRecord["validationStatus"] {
  if (
    value === "not_started" ||
    value === "queued" ||
    value === "running" ||
    value === "needs_review" ||
    value === "passed" ||
    value === "failed"
  ) {
    return value;
  }
  return "not_started";
}

function buildCapabilityGapFingerprint(input: {
  causeClass: CapabilityGapCauseClass;
  requestedTool?: string;
  toolProfile?: string;
  providerId?: string;
}): string {
  return [
    input.causeClass,
    input.requestedTool?.trim().toLowerCase() ?? "",
    input.toolProfile?.trim().toLowerCase() ?? "",
    input.providerId?.trim().toLowerCase() ?? "",
  ].join("|");
}

function buildRepairCandidateTitle(causeClass: CapabilityGapCauseClass, requestedTool?: string): string {
  const toolLabel = requestedTool ? ` for ${requestedTool}` : "";
  switch (causeClass) {
    case "tool_exists_but_not_in_profile":
      return `Tool profile mismatch${toolLabel}`;
    case "tool_requires_approval_but_not_exposed":
      return `Approval path missing${toolLabel}`;
    case "skill_missing":
      return `Missing skill capability${toolLabel}`;
    case "provider_tool_mismatch":
      return `Provider/tool mismatch${toolLabel}`;
    case "retryable_network_failure":
      return `Retryable network failure${toolLabel}`;
    case "missing_required_tool_evidence":
      return `Missing tool evidence${toolLabel}`;
    case "routing_profile_mismatch":
      return `Routing/profile mismatch${toolLabel}`;
    case "policy_denied_by_config":
    default:
      return `Config policy block${toolLabel}`;
  }
}

function buildRepairCandidateSummary(input: {
  causeClass: CapabilityGapCauseClass;
  requestedTool?: string;
  toolProfile?: string;
  providerId?: string;
  configArea?: string;
  eventCount: number;
}): string {
  const fragments = [
    `${input.eventCount} recurring event${input.eventCount === 1 ? "" : "s"} detected`,
    input.requestedTool ? `tool ${input.requestedTool}` : undefined,
    input.toolProfile ? `profile ${input.toolProfile}` : undefined,
    input.providerId ? `provider ${input.providerId}` : undefined,
    input.configArea ? `config ${input.configArea}` : undefined,
  ].filter(Boolean);
  return `${fragments.join(" · ")}. Validate with replay before apply.`;
}

function toCapabilityGapEventRow(value: unknown): CapabilityGapEventRow | undefined {
  return isCapabilityGapEventRow(value) ? value : undefined;
}

function toCapabilityGapEventRows(value: unknown): CapabilityGapEventRow[] {
  return Array.isArray(value) ? value.filter(isCapabilityGapEventRow) : [];
}

function toRepairCandidateRow(value: unknown): RepairCandidateRow | undefined {
  return isRepairCandidateRow(value) ? value : undefined;
}

function toRepairCandidateRows(value: unknown): RepairCandidateRow[] {
  return Array.isArray(value) ? value.filter(isRepairCandidateRow) : [];
}

function isCapabilityGapEventRow(value: unknown): value is CapabilityGapEventRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.event_id === "string" &&
    typeof value.session_id === "string" &&
    (typeof value.turn_id === "string" || value.turn_id === null) &&
    (typeof value.run_id === "string" || value.run_id === null) &&
    typeof value.cause_class === "string" &&
    (typeof value.failure_class === "string" || value.failure_class === null) &&
    (typeof value.prompt_excerpt === "string" || value.prompt_excerpt === null) &&
    (typeof value.prompt_ref === "string" || value.prompt_ref === null) &&
    (typeof value.requested_tool === "string" || value.requested_tool === null) &&
    (typeof value.tool_family === "string" || value.tool_family === null) &&
    (typeof value.tool_profile === "string" || value.tool_profile === null) &&
    (typeof value.policy_reason === "string" || value.policy_reason === null) &&
    (typeof value.provider_id === "string" || value.provider_id === null) &&
    (typeof value.model === "string" || value.model === null) &&
    (typeof value.config_area === "string" || value.config_area === null) &&
    (typeof value.suggested_repair_class === "string" || value.suggested_repair_class === null) &&
    typeof value.confidence === "number" &&
    typeof value.repeat_count === "number" &&
    typeof value.recovery_options_json === "string" &&
    (typeof value.replay_run_id === "string" || value.replay_run_id === null) &&
    (typeof value.replay_status === "string" || value.replay_status === null) &&
    (typeof value.repair_candidate_id === "string" || value.repair_candidate_id === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isRepairCandidateRow(value: unknown): value is RepairCandidateRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.candidate_id === "string" &&
    typeof value.fingerprint === "string" &&
    typeof value.cause_class === "string" &&
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    (typeof value.requested_tool === "string" || value.requested_tool === null) &&
    (typeof value.tool_profile === "string" || value.tool_profile === null) &&
    (typeof value.provider_id === "string" || value.provider_id === null) &&
    (typeof value.config_area === "string" || value.config_area === null) &&
    (typeof value.suggested_patch === "string" || value.suggested_patch === null) &&
    (typeof value.replay_run_id === "string" || value.replay_run_id === null) &&
    typeof value.validation_status === "string" &&
    (typeof value.validation_summary === "string" || value.validation_summary === null) &&
    typeof value.event_count === "number" &&
    typeof value.confidence === "number" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    typeof value.last_seen_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildSuggestedRepairPatch(input: {
  causeClass: CapabilityGapCauseClass;
  requestedTool?: string;
  toolProfile?: string;
  configArea?: string;
}): string | undefined {
  if (!input.configArea) {
    return undefined;
  }
  switch (input.causeClass) {
    case "tool_exists_but_not_in_profile":
      return `Review ${input.configArea} and allow ${input.requestedTool ?? "the blocked tool"} in profile ${input.toolProfile ?? "current"}.`;
    case "tool_requires_approval_but_not_exposed":
      return `Review ${input.configArea} and expose an approval-required path for ${input.requestedTool ?? "the blocked tool"}.`;
    case "skill_missing":
      return `Review ${input.configArea} and add an installable source or workflow for the missing skill capability.`;
    default:
      return `Review ${input.configArea} for the minimal config-only repair.`;
  }
}

function normalizeDecisionReplayCauseClass(value: string): DecisionReplayCauseClass {
  return IMPROVEMENT_CAUSE_CLASSES.has(value as DecisionReplayCauseClass)
    ? (value as DecisionReplayCauseClass)
    : "other";
}

function sampleDecisionReplayCandidates(
  candidates: DecisionReplayCandidate[],
  sampleSize: number,
): DecisionReplayCandidate[] {
  const cap = Math.max(1, Math.min(sampleSize, candidates.length));
  const critical = candidates.filter(
    (c) => c.status === "failed" || c.status === "blocked" || c.status === "approval_required",
  );
  const normal = candidates.filter((c) => !critical.includes(c));
  const criticalTarget = Math.min(critical.length, Math.max(1, Math.floor(cap * 0.45)));
  const selected = [...critical.slice(0, criticalTarget), ...normal.slice(0, cap - criticalTarget)];
  if (selected.length < cap) {
    for (const c of [...critical.slice(criticalTarget), ...normal.slice(cap - criticalTarget)]) {
      if (selected.length >= cap) break;
      if (!selected.includes(c)) selected.push(c);
    }
  }
  return selected.slice(0, cap);
}

function evaluateDecisionReplayRuleScores(
  candidate: DecisionReplayCandidate,
  turnTools: DecisionReplayCandidate[],
): { scores: DecisionReplayItemRuleScores; signals: string[] } {
  const signals: string[] = [];
  let honesty = 0.7,
    blockerQuality = 0.7,
    retryQuality = 0.7,
    toolEvidence = 0.65,
    actionability = 0.7;
  if (candidate.decisionType === "chat_turn") {
    const executedTools = turnTools.filter((i) => i.status === "executed");
    const failedTools = turnTools.filter((i) => i.status === "failed");
    const blockedTools = turnTools.filter((i) => i.status === "blocked" || i.status === "approval_required");
    if (candidate.status === "failed") {
      blockerQuality = 0.38;
      actionability = 0.35;
      signals.push("chat_turn_failed");
      if (failedTools.length > 0) {
        blockerQuality = 0.56;
        signals.push("failed_tools_present");
      }
    } else if (candidate.status === "approval_required") {
      blockerQuality = 0.82;
      actionability = 0.62;
      signals.push("approval_required_gate");
    }
    if ((candidate.routing?.liveDataIntent ?? false) && !(candidate.retrieval?.l2Used ?? false)) {
      honesty = 0.48;
      toolEvidence = Math.min(toolEvidence, 0.42);
      signals.push("live_data_without_l2");
    }
    if (executedTools.length > 0) {
      toolEvidence = 0.88;
      honesty = Math.max(honesty, 0.82);
      signals.push("tool_execution_evidence");
    } else if (
      (candidate.routing?.liveDataIntent ?? false) ||
      candidate.webMode === "quick" ||
      candidate.webMode === "deep"
    ) {
      toolEvidence = 0.44;
      signals.push("web_intent_without_execution");
    }
    const attemptedRepair = (candidate.reflection?.attemptCount ?? 0) > 0;
    if ((candidate.status === "failed" || failedTools.length > 0) && !attemptedRepair) {
      retryQuality = 0.32;
      signals.push("missing_reflection_retry");
    } else if (attemptedRepair) {
      retryQuality = 0.86;
      signals.push("reflection_retry_attempted");
    }
    if (blockedTools.length > 0 && blockerQuality < 0.7) {
      blockerQuality = 0.74;
      signals.push("blocked_with_reason");
    }
  } else {
    const status = candidate.status;
    if (status === "executed") {
      toolEvidence = 0.9;
      blockerQuality = 0.8;
      actionability = 0.8;
      signals.push("tool_executed");
    } else if (status === "failed") {
      honesty = 0.58;
      blockerQuality = candidate.error?.trim().length ? 0.62 : 0.34;
      retryQuality = 0.35;
      toolEvidence = 0.45;
      actionability = 0.42;
      signals.push("tool_failed");
    } else if (status === "blocked" || status === "approval_required") {
      blockerQuality = candidate.error?.trim().length ? 0.78 : 0.5;
      actionability = 0.55;
      signals.push("tool_blocked_or_approval");
    }
  }
  return {
    scores: {
      honesty: clampProbability(honesty) as number,
      blockerQuality: clampProbability(blockerQuality) as number,
      retryQuality: clampProbability(retryQuality) as number,
      toolEvidence: clampProbability(toolEvidence) as number,
      actionability: clampProbability(actionability) as number,
    },
    signals,
  };
}

function computeDecisionWrongnessProbability(
  candidate: DecisionReplayCandidate,
  ruleScores: DecisionReplayItemRuleScores,
  modelScores?: DecisionReplayItemModelScores,
): number {
  const ruleQuality =
    ruleScores.honesty * 0.28 +
    ruleScores.blockerQuality * 0.2 +
    ruleScores.retryQuality * 0.2 +
    ruleScores.toolEvidence * 0.2 +
    ruleScores.actionability * 0.12;
  let ruleWrongness = 1 - ruleQuality;
  if (candidate.status === "failed") ruleWrongness += 0.18;
  else if (candidate.status === "blocked") ruleWrongness += 0.08;
  else if (candidate.status === "approval_required") ruleWrongness += 0.05;
  ruleWrongness = clampProbability(ruleWrongness) as number;
  if (!modelScores) return ruleWrongness;
  const modelWrongness =
    (1 - modelScores.correctnessLikelihood) * 0.55 +
    modelScores.missedToolProbability * 0.3 +
    modelScores.betterResponsePotential * 0.15;
  return clampProbability(ruleWrongness * 0.55 + modelWrongness * 0.45) as number;
}

function inferDecisionReplayCauseClass(
  candidate: DecisionReplayCandidate,
  ruleScores: DecisionReplayItemRuleScores,
  wrongnessProbability: number,
): DecisionReplayCauseClass {
  if (wrongnessProbability < 0.45) return "other";
  if (candidate.decisionType === "chat_turn") {
    if ((candidate.routing?.liveDataIntent ?? false) && !(candidate.retrieval?.l2Used ?? false)) {
      return candidate.status === "completed" ? "false_refusal_tone" : "retrieval_miss";
    }
    if (candidate.status === "failed" && ruleScores.blockerQuality < 0.5) return "weak_blocker_explanation";
    if ((candidate.status === "failed" || candidate.status === "approval_required") && ruleScores.retryQuality < 0.45)
      return "incomplete_retry_repair";
    if (ruleScores.toolEvidence < 0.45) return "tool_mismatch";
    return "other";
  }
  if ((candidate.status === "blocked" || candidate.status === "approval_required") && ruleScores.blockerQuality < 0.66)
    return "weak_blocker_explanation";
  if (candidate.status === "failed" && ruleScores.retryQuality < 0.5) return "incomplete_retry_repair";
  if (candidate.status === "failed" && ruleScores.toolEvidence < 0.6) return "tool_mismatch";
  return "other";
}

function buildDecisionReplayItemSummary(
  candidate: DecisionReplayCandidate,
  causeClass: DecisionReplayCauseClass,
): string {
  return candidate.decisionType === "chat_turn"
    ? `Chat turn ${candidate.turnId ?? "unknown"} was tagged ${causeClass} (${candidate.status}).`
    : `Tool ${candidate.toolName ?? "unknown"} run ${candidate.toolRunId ?? "unknown"} was tagged ${causeClass} (${candidate.status}).`;
}

function titleForDecisionReplayCause(c: DecisionReplayCauseClass): string {
  if (c === "false_refusal_tone") return "False Refusal Tone";
  if (c === "weak_blocker_explanation") return "Weak Blocker Explanations";
  if (c === "tool_mismatch") return "Tool Selection Mismatch";
  if (c === "retrieval_miss") return "Retrieval Misses";
  if (c === "incomplete_retry_repair") return "Incomplete Retry/Repair";
  return "Other Replay Issues";
}

function recommendationForDecisionReplayCause(c: DecisionReplayCauseClass): string {
  if (c === "false_refusal_tone")
    return "Tighten refusal wording contract and require explicit tool-attempt summary before refusal.";
  if (c === "weak_blocker_explanation")
    return "Improve blocker template with concrete cause, failing step, and next-step fallback fields.";
  if (c === "tool_mismatch")
    return "Re-rank tool selection heuristics and add tie-break preference for higher-evidence tools.";
  if (c === "retrieval_miss") return "Raise live-data intent sensitivity and escalate layered retrieval earlier.";
  if (c === "incomplete_retry_repair")
    return "Trigger one alternate-strategy retry for failed turns before final response.";
  return "Review trace samples and add targeted heuristics for this cluster.";
}

function summarizeDecisionReplayFinding(group: DecisionReplayItemRecord[]): string {
  const example = group[0];
  if (!example) return "No sample data available.";
  return [
    `Observed ${group.length} similar items.`,
    `Example: ${example.summary ?? `${example.decisionType} ${example.turnId ?? example.toolRunId ?? "unknown"}`}`,
    `Average wrongness: ${(group.reduce((s, i) => s + i.wrongnessProbability, 0) / group.length).toFixed(2)}.`,
  ].join(" ");
}

function severityRank(severity: DecisionReplayFindingRecord["severity"]): number {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}

function compareDecisionCauseCounts(
  current: Map<DecisionReplayCauseClass, number>,
  previous: Map<DecisionReplayCauseClass, number>,
): WeeklyImprovementReportRecord["weekOverWeek"] {
  const keys = new Set<DecisionReplayCauseClass>([...current.keys(), ...previous.keys()]);
  const improved: string[] = [],
    regressed: string[] = [],
    unchanged: string[] = [];
  for (const key of keys) {
    const c = current.get(key) ?? 0,
      p = previous.get(key) ?? 0;
    if (c < p) improved.push(`${key}: ${p} -> ${c}`);
    else if (c > p) regressed.push(`${key}: ${p} -> ${c}`);
    else unchanged.push(`${key}: ${c}`);
  }
  return { improved, regressed, unchanged };
}

function getZonedDateParts(date: Date, timeZone: string): { weekday: number; hour: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const read = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const wd = read("weekday").toLowerCase();
  const weekday = wd.startsWith("sun")
    ? 0
    : wd.startsWith("mon")
      ? 1
      : wd.startsWith("tue")
        ? 2
        : wd.startsWith("wed")
          ? 3
          : wd.startsWith("thu")
            ? 4
            : wd.startsWith("fri")
              ? 5
              : 6;
  return { weekday, hour: Number.parseInt(read("hour"), 10) };
}

function toWeekKeyForTimezone(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dateStr = formatter.format(date);
  const d = new Date(dateStr);
  const dayOfWeek = d.getDay();
  const diff = d.getDate() - dayOfWeek;
  const weekStart = new Date(d.setDate(diff));
  return `${weekStart.getFullYear()}-W${String(Math.ceil(weekStart.getDate() / 7)).padStart(2, "0")}`;
}
