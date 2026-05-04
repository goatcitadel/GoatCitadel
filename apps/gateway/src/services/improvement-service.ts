/* eslint-disable @typescript-eslint/no-unused-vars, max-lines */
import { createHash, randomUUID } from "node:crypto";
import {
  clampInt,
  type ApprovalCreateInput,
  type ApprovalRequest,
  type DurableRunRecord,
  type RealtimeEvent,
} from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import type { Storage } from "@goatcitadel/storage";

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
  ImprovementActivationRecord,
  ImprovementActorType,
  ImprovementCandidateDetailResponse,
  ImprovementCandidateKind,
  ImprovementCandidateRecord,
  ImprovementCandidateRevisionRecord,
  ImprovementCandidateStatus,
  ImprovementEvaluationKind,
  ImprovementEvaluationRecord,
  ImprovementEvidenceRef,
  ImprovementRef,
  ImprovementSignalClass,
  ImprovementSignalOrigin,
  ImprovementSignalOutcome,
  ImprovementSignalRecord,
  ImprovementSignalSeverity,
  ImprovementStrategyTag,
  ImprovementAttemptManifestSummary,
  RepairCandidateRecord,
  RepairValidationStatus,
  ReplayDiffSummary,
  ReplayOverrideDraft,
  ReplayOverrideStep,
  TranscriptEvent,
  WeeklyImprovementProposalDraftRecord,
  WeeklyImprovementReportRecord,
  WeeklyImprovementSpecialistSuggestionRecord,
} from "@goatcitadel/contracts";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";

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
const IMPROVEMENT_REPAIR_POLICY_CONFIG_SETTING_KEY = "improvement_repair_policy_config_v1";
const IMPROVEMENT_ROUTING_POLICY_CONFIG_SETTING_KEY = "improvement_routing_policy_config_v1";
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
const IMPROVEMENT_SIGNAL_ORIGINS = new Set<ImprovementSignalOrigin>([
  "runtime",
  "human",
  "evaluation",
  "improvement_internal",
]);
const IMPROVEMENT_SIGNAL_CLASSES = new Set<ImprovementSignalClass>(["runtime", "approval", "evaluation"]);
const IMPROVEMENT_SIGNAL_OUTCOMES = new Set<ImprovementSignalOutcome>(["positive", "negative", "neutral"]);
const IMPROVEMENT_SIGNAL_SEVERITIES = new Set<ImprovementSignalSeverity>(["low", "medium", "high"]);
const IMPROVEMENT_CANDIDATE_KINDS = new Set<ImprovementCandidateKind>(["repair_policy", "routing_policy"]);
const IMPROVEMENT_CANDIDATE_OPEN_STATUSES = new Set<ImprovementCandidateStatus>([
  "proposed",
  "evaluating",
  "ready_for_approval",
  "approval_pending",
  "approved",
]);
const IMPROVEMENT_WATCH_SIGNAL_TARGET = 20;
const IMPROVEMENT_SIGNAL_SCHEMA_VERSION = "1.1.1";
const IMPROVEMENT_EVALUATOR_VERSION = "improvement-ledger-v1.1.1";
const IMPROVEMENT_SIGNAL_METADATA_MAX_BYTES = 4 * 1024;
const IMPROVEMENT_SIGNAL_EVIDENCE_REF_LIMIT = 8;

export interface ImprovementServiceContext {
  readonly storage: Pick<Storage, "approvals" | "chatTurnTraces" | "cronJobs" | "systemSettings">;
  readonly gatewaySql: Storage["gatewaySql"];
  isFeatureEnabled(flag: keyof RuntimeSettings["features"]): boolean;
  requireFeatureEnabled(flag: keyof RuntimeSettings["features"]): void;
  normalizeWorkspaceId(workspaceId?: string): string;
  publishRealtime(
    channel: string,
    topic: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
}
const IMPROVEMENT_SUPPRESSION_MS = 7 * 24 * 60 * 60 * 1000;
const IMPROVEMENT_WATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

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

interface ImprovementSignalInput {
  sourceService: string;
  sourceType: string;
  sourceId: string;
  sourceEventId: string;
  idempotencyKey: string;
  workspaceId: string;
  occurredAt?: string;
  recordedAt?: string;
  origin: ImprovementSignalOrigin;
  signalClass: ImprovementSignalClass;
  signalKind: string;
  outcome: ImprovementSignalOutcome;
  fingerprint: string;
  sessionId?: string;
  turnId?: string;
  durableRunId?: string;
  approvalId?: string;
  taskId?: string;
  toolName?: string;
  capabilityId?: string;
  memoryItemId?: string;
  severity?: ImprovementSignalSeverity;
  costDeltaUsd?: number;
  latencyDeltaMs?: number;
  scoreDelta?: number;
  evidenceRefs?: ImprovementEvidenceRef[];
  metadata?: Record<string, unknown>;
}

interface ImprovementSignalRow {
  signal_id: string;
  schema_version: string;
  source_service: string;
  source_type: string;
  source_id: string;
  source_event_id: string;
  idempotency_key: string;
  workspace_id: string;
  occurred_at: string;
  recorded_at: string;
  origin: string;
  signal_class: string;
  signal_kind: string;
  outcome: string;
  fingerprint: string;
  session_id: string | null;
  turn_id: string | null;
  durable_run_id: string | null;
  approval_id: string | null;
  task_id: string | null;
  tool_name: string | null;
  capability_id: string | null;
  memory_item_id: string | null;
  severity: string | null;
  cost_delta_usd: number | null;
  latency_delta_ms: number | null;
  score_delta: number | null;
  evidence_refs_json: string;
  metadata_json: string | null;
  created_at: string;
}

interface ImprovementCandidateRow {
  candidate_id: string;
  workspace_id: string;
  kind: string;
  status: string;
  target_key: string;
  fingerprint: string;
  summary: string;
  current_revision_id: string | null;
  supporting_signal_count: number;
  negative_signal_count: number;
  severity: string | null;
  suppression_until: string | null;
  latest_signal_at: string | null;
  aggregate_json: string;
  created_at: string;
  updated_at: string;
  created_by_actor_id: string | null;
  created_by_actor_type: string | null;
  updated_by_actor_id: string | null;
  updated_by_actor_type: string | null;
}

interface ImprovementCandidateRevisionRow {
  revision_id: string;
  candidate_id: string;
  candidate_ref_json: string;
  change_hash: string;
  created_at: string;
  created_by_actor_id: string;
  created_by_actor_type: string;
}

interface ImprovementEvaluationRow {
  evaluation_id: string;
  candidate_id: string;
  revision_id: string;
  status: string;
  baseline_ref_json: string;
  candidate_ref_json: string;
  evaluator_kind: string;
  evaluator_version: string;
  dataset_or_pack_ref_json: string | null;
  change_hash: string;
  metrics_json: string;
  result_summary: string;
  created_at: string;
  completed_at: string | null;
  created_by_actor_id: string;
  created_by_actor_type: string;
  completed_by_actor_id: string | null;
  completed_by_actor_type: string | null;
}

interface ImprovementActivationRow {
  activation_id: string;
  candidate_id: string;
  revision_id: string;
  approval_id: string;
  status: string;
  scope: string;
  activation_target_json: string;
  pre_activation_snapshot_json: string;
  applied_change_hash: string;
  watch_status: string;
  watch_started_at: string | null;
  watch_ends_at: string | null;
  watch_signal_target: number;
  watch_signal_count: number;
  regression_count: number;
  created_at: string;
  updated_at: string;
  requested_by_actor_id: string;
  requested_by_actor_type: string;
  approved_by_actor_id: string | null;
  approved_by_actor_type: string | null;
  paused_by_actor_id: string | null;
  paused_by_actor_type: string | null;
  rolled_back_by_actor_id: string | null;
  rolled_back_by_actor_type: string | null;
  stable_at: string | null;
  paused_at: string | null;
  rolled_back_at: string | null;
  failure_reason: string | null;
}

/**
 * Callbacks needed from GatewayService.
 */
export interface ImprovementServiceCallbacks {
  createApproval(input: ApprovalCreateInput): Promise<ApprovalRequest>;
  captureRepairPolicySnapshot(targetKey: string): ImprovementRef;
  applyRepairPolicyCandidate(targetKey: string, revisionRef: ImprovementRef): ImprovementRef;
  restoreRepairPolicySnapshot(snapshotRef: ImprovementRef): void;
  captureRoutingPolicySnapshot(targetKey: string): ImprovementRef;
  applyRoutingPolicyCandidate(targetKey: string, revisionRef: ImprovementRef): ImprovementRef;
  restoreRoutingPolicySnapshot(snapshotRef: ImprovementRef): void;
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
    private readonly ctx: ImprovementServiceContext,
    private readonly callbacks: ImprovementServiceCallbacks,
  ) {
    this.ensureCapabilityGapTables();
    this.ensureImprovementLedgerTables();
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
    this.reconcilePendingActivationApprovals();
    this.reconcileActiveWatchWindows();
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
        action: "improvement",
        description: existing?.description ?? "Run the weekly self-improvement replay cycle.",
        schedule: IMPROVEMENT_WEEKLY_SCHEDULE_LABEL,
        enabled: existing?.enabled ?? true,
        endAt: existing?.endAt,
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
    return rows.map((row) => this.enrichWeeklyImprovementReport(mapImprovementReportRow(row)));
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

  listImprovementSignals(limit = 100, workspaceId?: string): ImprovementSignalRecord[] {
    this.ensureImprovementLedgerTables();
    const normalizedWorkspaceId = workspaceId?.trim();
    const sql = normalizedWorkspaceId
      ? `
          SELECT *
          FROM improvement_signals
          WHERE workspace_id = @workspaceId
          ORDER BY recorded_at DESC, signal_id DESC
          LIMIT @limit
        `
      : `
          SELECT *
          FROM improvement_signals
          ORDER BY recorded_at DESC, signal_id DESC
          LIMIT @limit
        `;
    const rows = toImprovementSignalRows(
      normalizedWorkspaceId
        ? this.ctx.gatewaySql.prepare(sql).all({
            workspaceId: normalizedWorkspaceId,
            limit: Math.max(1, Math.min(limit, 500)),
          })
        : this.ctx.gatewaySql.prepare(sql).all({
            limit: Math.max(1, Math.min(limit, 500)),
          }),
    );
    return rows.map((row) => mapImprovementSignalRow(row));
  }

  getImprovementSignal(signalId: string): ImprovementSignalRecord {
    this.ensureImprovementLedgerTables();
    const row = toImprovementSignalRow(
      this.ctx.gatewaySql
        .prepare(
          `
        SELECT *
        FROM improvement_signals
        WHERE signal_id = ?
        LIMIT 1
      `,
        )
        .get(signalId),
    );
    if (!row) {
      throw new Error(`Improvement signal not found: ${signalId}`);
    }
    return mapImprovementSignalRow(row);
  }

  listImprovementCandidates(limit = 100, workspaceId?: string): ImprovementCandidateRecord[] {
    this.ensureImprovementLedgerTables();
    const normalizedWorkspaceId = workspaceId?.trim();
    const sql = normalizedWorkspaceId
      ? `
          SELECT *
          FROM improvement_candidates
          WHERE workspace_id = @workspaceId
          ORDER BY updated_at DESC, candidate_id DESC
          LIMIT @limit
        `
      : `
          SELECT *
          FROM improvement_candidates
          ORDER BY updated_at DESC, candidate_id DESC
          LIMIT @limit
        `;
    const rows = toImprovementCandidateRows(
      normalizedWorkspaceId
        ? this.ctx.gatewaySql.prepare(sql).all({
            workspaceId: normalizedWorkspaceId,
            limit: Math.max(1, Math.min(limit, 300)),
          })
        : this.ctx.gatewaySql.prepare(sql).all({
            limit: Math.max(1, Math.min(limit, 300)),
          }),
    );
    return rows.map((row) => this.reconcileActivationWatchStatus(mapImprovementCandidateRow(row)));
  }

  getImprovementCandidateDetail(candidateId: string): ImprovementCandidateDetailResponse {
    this.ensureImprovementLedgerTables();
    const candidate = this.readImprovementCandidate(candidateId);
    const latestActivation = this.readLatestActivation(candidateId);
    const reconciledActivation = latestActivation ? this.maybeAdvanceActivation(latestActivation) : undefined;
    const supportingSignals = this.listSignalsForCandidate(candidateId);
    return {
      candidate: this.readImprovementCandidate(candidateId),
      currentRevision: this.readCurrentRevision(candidateId),
      supportingSignals,
      latestEvaluation: this.readLatestEvaluation(candidateId),
      latestActivation: reconciledActivation,
      attemptManifestSummary: this.normalizeAttemptManifests(supportingSignals),
    };
  }

  getImprovementActivation(activationId: string): ImprovementActivationRecord {
    this.ensureImprovementLedgerTables();
    return this.maybeAdvanceActivation(this.readImprovementActivation(activationId));
  }

  recordDurableRunCompletionSignal(input: {
    run: DurableRunRecord;
    checkpointState?: Record<string, unknown>;
  }): ImprovementSignalRecord | undefined {
    if (!this.ctx.isFeatureEnabled("improvementLedgerV1Enabled")) {
      return undefined;
    }
    const workspaceId = this.resolveWorkspaceIdFromDurableRun(input.run, input.checkpointState);
    return this.recordImprovementSignal({
      sourceService: "durable-run-service",
      sourceType: "durable_run",
      sourceId: input.run.runId,
      sourceEventId: `${input.run.runId}:completed:${input.run.updatedAt}`,
      idempotencyKey: `${input.run.runId}:completed:${input.run.updatedAt}`,
      workspaceId,
      occurredAt: input.run.finishedAt ?? input.run.updatedAt,
      origin: "runtime",
      signalClass: "runtime",
      signalKind: "durable_run_completed",
      outcome: "positive",
      fingerprint: buildImprovementFingerprint(["durable", workspaceId, input.run.workflowKey, "completed"]),
      durableRunId: input.run.runId,
      sessionId: asOptionalString(input.run.payload.sessionId),
      turnId: asOptionalString(input.run.payload.turnId),
      evidenceRefs: [
        {
          refType: "durable_run",
          refId: input.run.runId,
          hash: hashJson(input.checkpointState ?? {}),
        },
      ],
      metadata: {
        workflowKey: input.run.workflowKey,
        payload: input.run.payload,
        checkpointState: input.checkpointState ?? {},
      },
    });
  }

  recordDurableRunFailureSignal(input: {
    run: DurableRunRecord;
    message: string;
  }): ImprovementSignalRecord | undefined {
    if (!this.ctx.isFeatureEnabled("improvementLedgerV1Enabled")) {
      return undefined;
    }
    const workspaceId = this.resolveWorkspaceIdFromDurableRun(input.run);
    return this.recordImprovementSignal({
      sourceService: "durable-run-service",
      sourceType: "durable_run",
      sourceId: input.run.runId,
      sourceEventId: `${input.run.runId}:failed:${input.run.updatedAt}`,
      idempotencyKey: `${input.run.runId}:failed:${input.run.updatedAt}`,
      workspaceId,
      occurredAt: input.run.finishedAt ?? input.run.updatedAt,
      origin: "runtime",
      signalClass: "runtime",
      signalKind: "durable_run_failed",
      outcome: "negative",
      severity: "medium",
      fingerprint: buildImprovementFingerprint(["durable", workspaceId, input.run.workflowKey, "failed"]),
      durableRunId: input.run.runId,
      sessionId: asOptionalString(input.run.payload.sessionId),
      turnId: asOptionalString(input.run.payload.turnId),
      evidenceRefs: [
        {
          refType: "durable_run",
          refId: input.run.runId,
          hash: hashJson({ lastError: input.message }),
        },
      ],
      metadata: {
        workflowKey: input.run.workflowKey,
        payload: input.run.payload,
        lastError: input.message,
      },
    });
  }

  recordFocusedToolFailureSignal(input: {
    workspaceId?: string;
    sessionId: string;
    turnId?: string;
    durableRunId?: string;
    toolName: string;
    providerId?: string;
    model?: string;
    failureClass: string;
    operationPhase: string;
    policyReason?: string;
  }): ImprovementSignalRecord | undefined {
    if (!this.ctx.isFeatureEnabled("improvementLedgerV1Enabled")) {
      return undefined;
    }
    const workspaceId = this.ctx.normalizeWorkspaceId(input.workspaceId);
    return this.recordImprovementSignal({
      sourceService: "chat-runtime",
      sourceType: "tool_provider_failure",
      sourceId: input.turnId?.trim() || input.durableRunId?.trim() || input.sessionId,
      sourceEventId: [
        input.sessionId,
        input.turnId,
        input.durableRunId,
        input.toolName,
        input.failureClass,
        input.operationPhase,
      ]
        .filter(Boolean)
        .join(":"),
      idempotencyKey: [
        "tool-provider-failure",
        workspaceId,
        input.sessionId,
        input.turnId,
        input.durableRunId,
        input.toolName,
        input.providerId,
        input.model,
        input.failureClass,
        input.operationPhase,
      ]
        .filter(Boolean)
        .join(":"),
      workspaceId,
      origin: "runtime",
      signalClass: "runtime",
      signalKind: "tool_provider_failure",
      outcome: "negative",
      severity: "medium",
      fingerprint: this.buildRepairPolicyFingerprint({
        workspaceId,
        toolName: input.toolName,
        providerId: input.providerId,
        model: input.model,
        failureClass: input.failureClass,
        operationPhase: input.operationPhase,
      }),
      sessionId: input.sessionId,
      turnId: input.turnId,
      durableRunId: input.durableRunId,
      toolName: input.toolName,
      evidenceRefs: input.durableRunId
        ? [
            {
              refType: "durable_run",
              refId: input.durableRunId,
            },
          ]
        : [],
      metadata: {
        providerId: input.providerId,
        model: input.model,
        failureClass: input.failureClass,
        operationPhase: input.operationPhase,
        policyReason: input.policyReason,
      },
    });
  }

  recordApprovalResolutionSignal(approval: ApprovalRequest): ImprovementSignalRecord | undefined {
    if (!this.ctx.isFeatureEnabled("improvementLedgerV1Enabled")) {
      return undefined;
    }
    return this.recordImprovementSignal({
      sourceService: "gatehouse",
      sourceType: "approval",
      sourceId: approval.approvalId,
      sourceEventId: `${approval.approvalId}:${approval.status}:${approval.resolvedAt ?? approval.createdAt}`,
      idempotencyKey: `${approval.approvalId}:${approval.status}:${approval.resolvedAt ?? approval.createdAt}`,
      workspaceId: this.ctx.normalizeWorkspaceId(approval.linkage?.workspaceId),
      occurredAt: approval.resolvedAt ?? approval.createdAt,
      origin: "human",
      signalClass: "approval",
      signalKind: "approval_resolution",
      outcome: approval.status === "approved" ? "positive" : approval.status === "pending" ? "neutral" : "negative",
      fingerprint: buildImprovementFingerprint(["approval", approval.kind, approval.approvalId, approval.status]),
      sessionId: approval.linkage?.sessionId,
      turnId: approval.linkage?.turnId,
      durableRunId: approval.linkage?.durableRunId,
      approvalId: approval.approvalId,
      taskId: approval.linkage?.taskId,
      toolName: approval.linkage?.toolName,
      evidenceRefs: [
        {
          refType: "approval",
          refId: approval.approvalId,
          hash: hashJson({
            status: approval.status,
            payload: approval.payload,
            preview: approval.preview,
          }),
        },
      ],
      metadata: {
        approvalKind: approval.kind,
        riskLevel: approval.riskLevel,
        status: approval.status,
      },
    });
  }

  recordPromptLabBenchmarkCompletionSignal(input: {
    benchmarkRunId: string;
    packId: string;
    providerId: string;
    model: string;
    weightedScore?: number;
    passRate?: number;
    runFailures?: number;
    failureSignal?: string;
  }): ImprovementSignalRecord | undefined {
    if (!this.ctx.isFeatureEnabled("improvementLedgerV1Enabled")) {
      return undefined;
    }
    const workspaceId = this.ctx.normalizeWorkspaceId("prompt-lab");
    const targetKey = `${input.packId}:${input.providerId}:${input.model}`;
    const causeClass = input.runFailures && input.runFailures > 0 ? "benchmark_failures" : "benchmark_score";
    const outcome: ImprovementSignalOutcome =
      (input.runFailures ?? 0) > 0 || (input.passRate ?? 1) < 0.8 ? "negative" : "positive";
    return this.recordImprovementSignal({
      sourceService: "prompt-pack-service",
      sourceType: "prompt_pack_benchmark",
      sourceId: input.benchmarkRunId,
      sourceEventId: `${input.benchmarkRunId}:${input.providerId}:${input.model}`,
      idempotencyKey: `${input.benchmarkRunId}:${input.providerId}:${input.model}`,
      workspaceId,
      origin: "evaluation",
      signalClass: "evaluation",
      signalKind: "prompt_lab_benchmark_completed",
      outcome,
      severity: outcome === "negative" ? "medium" : "low",
      fingerprint: this.buildRoutingPolicyFingerprint({
        workspaceId,
        causeClass,
        targetKey,
        providerId: input.providerId,
        model: input.model,
      }),
      scoreDelta: input.weightedScore,
      evidenceRefs: [
        {
          refType: "prompt_pack_benchmark",
          refId: input.benchmarkRunId,
        },
      ],
      metadata: {
        packId: input.packId,
        targetKey,
        causeClass,
        providerId: input.providerId,
        model: input.model,
        passRate: input.passRate,
        runFailures: input.runFailures,
        failureSignal: input.failureSignal,
      },
    });
  }

  recordPromptLabRegressionCompletionSignal(input: {
    regressionRunId: string;
    packId: string;
    baselineRef?: string;
    scoreDelta: number;
    passDelta: number;
    latencyDeltaMs: number;
    capability: string;
  }): ImprovementSignalRecord | undefined {
    if (!this.ctx.isFeatureEnabled("improvementLedgerV1Enabled")) {
      return undefined;
    }
    const workspaceId = this.ctx.normalizeWorkspaceId("prompt-lab");
    const targetKey = `${input.packId}:${input.capability}`;
    const negative = input.scoreDelta < 0 || input.passDelta < 0;
    return this.recordImprovementSignal({
      sourceService: "prompt-pack-service",
      sourceType: "prompt_pack_regression",
      sourceId: input.regressionRunId,
      sourceEventId: `${input.regressionRunId}:${input.capability}`,
      idempotencyKey: `${input.regressionRunId}:${input.capability}`,
      workspaceId,
      origin: "evaluation",
      signalClass: "evaluation",
      signalKind: "prompt_lab_regression_completed",
      outcome: negative ? "negative" : "neutral",
      severity: negative ? "high" : "low",
      fingerprint: this.buildRoutingPolicyFingerprint({
        workspaceId,
        causeClass: input.capability,
        targetKey,
        providerId: undefined,
        model: undefined,
      }),
      scoreDelta: input.scoreDelta,
      latencyDeltaMs: input.latencyDeltaMs,
      evidenceRefs: [
        {
          refType: "prompt_pack_run",
          refId: input.regressionRunId,
        },
      ],
      metadata: {
        packId: input.packId,
        targetKey,
        causeClass: input.capability,
        baselineRef: input.baselineRef,
        passDelta: input.passDelta,
      },
    });
  }

  async requestImprovementActivation(candidateId: string, actorId = "operator"): Promise<ImprovementActivationRecord> {
    this.ctx.requireFeatureEnabled("improvementActivationV1Enabled");
    this.ensureImprovementLedgerTables();
    const candidate = this.readImprovementCandidate(candidateId);
    const revision = this.readCurrentRevision(candidateId);
    const evaluation = this.readLatestEvaluation(candidateId);
    if (!revision || !evaluation) {
      throw new Error(`Candidate ${candidateId} is missing a current revision or evaluation.`);
    }
    if (candidate.status !== "ready_for_approval" && candidate.status !== "approved") {
      throw new Error(`Candidate ${candidateId} is not ready for activation approval.`);
    }
    if (candidate.currentRevisionId !== evaluation.revisionId || revision.changeHash !== evaluation.changeHash) {
      this.updateCandidateStatus(candidateId, "evaluating", actorId, "operator");
      throw new Error(`Candidate ${candidateId} drifted since evaluation and must be re-evaluated.`);
    }
    const activationTarget = this.buildActivationTargetRef(candidate, revision);
    const preActivationSnapshot = this.captureActivationSnapshot(candidate.kind, candidate.targetKey);
    const approval = await this.callbacks.createApproval({
      kind: "improvement_activation",
      riskLevel: candidate.kind === "routing_policy" ? "caution" : "safe",
      payload: {
        candidateId,
        revisionId: revision.revisionId,
        targetKey: candidate.targetKey,
        kind: candidate.kind,
        activationTarget,
        appliedChangeHash: revision.changeHash,
      },
      preview: {
        candidateId,
        revisionId: revision.revisionId,
        summary: candidate.summary,
        targetKey: candidate.targetKey,
        kind: candidate.kind,
      },
      linkage: {
        workspaceId: candidate.workspaceId,
        actionType: "improvement_activation",
      },
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    const now = new Date().toISOString();
    const activationId = randomUUID();
    this.ctx.gatewaySql
      .prepare(
        `
        INSERT INTO improvement_activations (
          activation_id, candidate_id, revision_id, approval_id, status, scope,
          activation_target_json, pre_activation_snapshot_json, applied_change_hash,
          watch_status, watch_signal_target, watch_signal_count, regression_count,
          created_at, updated_at, requested_by_actor_id, requested_by_actor_type
        ) VALUES (
          @activationId, @candidateId, @revisionId, @approvalId, 'pending', 'workspace',
          @activationTargetJson, @preActivationSnapshotJson, @appliedChangeHash,
          'watching', @watchSignalTarget, 0, 0,
          @createdAt, @updatedAt, @requestedByActorId, @requestedByActorType
        )
      `,
      )
      .run({
        activationId,
        candidateId,
        revisionId: revision.revisionId,
        approvalId: approval.approvalId,
        activationTargetJson: JSON.stringify(activationTarget),
        preActivationSnapshotJson: JSON.stringify(preActivationSnapshot),
        appliedChangeHash: revision.changeHash,
        watchSignalTarget: IMPROVEMENT_WATCH_SIGNAL_TARGET,
        createdAt: now,
        updatedAt: now,
        requestedByActorId: actorId,
        requestedByActorType: "operator",
      });
    this.updateCandidateStatus(candidateId, "approval_pending", actorId, "operator");
    const activation = this.readImprovementActivation(activationId);
    this.emitLifecycleAuditSignal("activation_requested", {
      candidateId,
      revisionId: revision.revisionId,
      activationId,
      approvalId: approval.approvalId,
      workspaceId: candidate.workspaceId,
      fingerprint: candidate.fingerprint,
      targetKey: candidate.targetKey,
      status: activation.status,
      watchStatus: activation.watchStatus,
    });
    return activation;
  }

  handleActivationApprovalResolution(approval: ApprovalRequest): ImprovementActivationRecord | undefined {
    if (
      !this.ctx.isFeatureEnabled("improvementActivationV1Enabled") ||
      approval.kind !== "improvement_activation" ||
      approval.status === "pending"
    ) {
      return undefined;
    }
    this.ensureImprovementLedgerTables();
    const pendingActivation = this.readPendingActivationByApprovalId(approval.approvalId);
    if (!pendingActivation) {
      return undefined;
    }

    const candidate = this.readImprovementCandidate(pendingActivation.candidateId);
    const revision = this.readCurrentRevision(candidate.candidateId);
    const evaluation = this.readLatestEvaluation(candidate.candidateId);
    const actorId = approval.resolvedBy ?? "approval";

    if (approval.status === "rejected" || approval.status === "edited") {
      this.applyCandidateSuppression(candidate.candidateId);
      return this.markActivationFailed(pendingActivation.activationId, `approval_${approval.status}`, {
        approvalId: approval.approvalId,
        actorId,
        actorType: "approval",
        candidateId: candidate.candidateId,
        revisionId: pendingActivation.revisionId,
        workspaceId: candidate.workspaceId,
        fingerprint: candidate.fingerprint,
        targetKey: candidate.targetKey,
      });
    }

    const drifted =
      !revision ||
      !evaluation ||
      candidate.currentRevisionId !== evaluation.revisionId ||
      evaluation.revisionId !== pendingActivation.revisionId ||
      revision.revisionId !== pendingActivation.revisionId ||
      evaluation.changeHash !== revision.changeHash ||
      pendingActivation.appliedChangeHash !== revision.changeHash;
    if (drifted) {
      this.updateCandidateStatus(candidate.candidateId, "evaluating", actorId, "approval");
      return this.markActivationFailed(pendingActivation.activationId, "candidate_drift", {
        approvalId: approval.approvalId,
        actorId,
        actorType: "approval",
        candidateId: candidate.candidateId,
        revisionId: pendingActivation.revisionId,
        workspaceId: candidate.workspaceId,
        fingerprint: candidate.fingerprint,
        targetKey: candidate.targetKey,
      });
    }

    try {
      return this.applyApprovedActivation(pendingActivation, approval);
    } catch (error) {
      return this.markActivationFailed(
        pendingActivation.activationId,
        error instanceof Error ? error.message : String(error),
        {
          approvalId: approval.approvalId,
          actorId,
          actorType: "approval",
          candidateId: candidate.candidateId,
          revisionId: pendingActivation.revisionId,
          workspaceId: candidate.workspaceId,
          fingerprint: candidate.fingerprint,
          targetKey: candidate.targetKey,
        },
      );
    }
  }

  pauseImprovementActivation(activationId: string, actorId = "operator"): ImprovementActivationRecord {
    this.ctx.requireFeatureEnabled("improvementActivationV1Enabled");
    this.ensureImprovementLedgerTables();
    const activation = this.maybeAdvanceActivation(this.readImprovementActivation(activationId));
    return this.restoreActivationSnapshot(activation, "paused", actorId, "operator");
  }

  rollbackImprovementActivation(activationId: string, actorId = "operator"): ImprovementActivationRecord {
    this.ctx.requireFeatureEnabled("improvementActivationV1Enabled");
    this.ensureImprovementLedgerTables();
    const activation = this.maybeAdvanceActivation(this.readImprovementActivation(activationId));
    const restored = this.restoreActivationSnapshot(activation, "rolled_back", actorId, "operator");
    this.applyCandidateSuppression(restored.candidateId);
    return restored;
  }

  private recordImprovementSignal(input: ImprovementSignalInput): ImprovementSignalRecord | undefined {
    this.ensureImprovementLedgerTables();
    const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs);
    const metadata = clampMetadataBytes(input.metadata);
    const existing = toImprovementSignalRow(
      this.ctx.gatewaySql
        .prepare(
          `
          SELECT *
          FROM improvement_signals
          WHERE source_service = @sourceService
            AND idempotency_key = @idempotencyKey
          LIMIT 1
        `,
        )
        .get({
          sourceService: input.sourceService,
          idempotencyKey: input.idempotencyKey,
        }),
    );
    if (existing) {
      return mapImprovementSignalRow(existing);
    }
    const now = new Date().toISOString();
    const signalId = randomUUID();
    this.ctx.gatewaySql
      .prepare(
        `
        INSERT INTO improvement_signals (
          signal_id, schema_version, source_service, source_type, source_id, source_event_id,
          idempotency_key, workspace_id, occurred_at, recorded_at, origin, signal_class,
          signal_kind, outcome, fingerprint, session_id, turn_id, durable_run_id,
          approval_id, task_id, tool_name, capability_id, memory_item_id, severity,
          cost_delta_usd, latency_delta_ms, score_delta, evidence_refs_json, metadata_json, created_at
        ) VALUES (
          @signalId, @schemaVersion, @sourceService, @sourceType, @sourceId, @sourceEventId,
          @idempotencyKey, @workspaceId, @occurredAt, @recordedAt, @origin, @signalClass,
          @signalKind, @outcome, @fingerprint, @sessionId, @turnId, @durableRunId,
          @approvalId, @taskId, @toolName, @capabilityId, @memoryItemId, @severity,
          @costDeltaUsd, @latencyDeltaMs, @scoreDelta, @evidenceRefsJson, @metadataJson, @createdAt
        )
      `,
      )
      .run({
        signalId,
        schemaVersion: IMPROVEMENT_SIGNAL_SCHEMA_VERSION,
        sourceService: input.sourceService,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceEventId: input.sourceEventId,
        idempotencyKey: input.idempotencyKey,
        workspaceId: this.ctx.normalizeWorkspaceId(input.workspaceId),
        occurredAt: input.occurredAt ?? now,
        recordedAt: input.recordedAt ?? now,
        origin: IMPROVEMENT_SIGNAL_ORIGINS.has(input.origin) ? input.origin : "runtime",
        signalClass: IMPROVEMENT_SIGNAL_CLASSES.has(input.signalClass) ? input.signalClass : "runtime",
        signalKind: input.signalKind.trim(),
        outcome: IMPROVEMENT_SIGNAL_OUTCOMES.has(input.outcome) ? input.outcome : "neutral",
        fingerprint: input.fingerprint.trim(),
        sessionId: input.sessionId?.trim() || null,
        turnId: input.turnId?.trim() || null,
        durableRunId: input.durableRunId?.trim() || null,
        approvalId: input.approvalId?.trim() || null,
        taskId: input.taskId?.trim() || null,
        toolName: input.toolName?.trim() || null,
        capabilityId: input.capabilityId?.trim() || null,
        memoryItemId: input.memoryItemId?.trim() || null,
        severity: input.severity && IMPROVEMENT_SIGNAL_SEVERITIES.has(input.severity) ? input.severity : null,
        costDeltaUsd: typeof input.costDeltaUsd === "number" ? input.costDeltaUsd : null,
        latencyDeltaMs: typeof input.latencyDeltaMs === "number" ? input.latencyDeltaMs : null,
        scoreDelta: typeof input.scoreDelta === "number" ? input.scoreDelta : null,
        evidenceRefsJson: JSON.stringify(evidenceRefs),
        metadataJson: metadata ? JSON.stringify(metadata) : null,
        createdAt: now,
      });
    const signal = this.getImprovementSignal(signalId);
    this.applySignalToWatchWindows(signal);
    this.maybeSynthesizeCandidate(signal);
    return signal;
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
    return this.enrichWeeklyImprovementReport(mapImprovementReportRow(row));
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

  private enrichWeeklyImprovementReport(report: WeeklyImprovementReportRecord): WeeklyImprovementReportRecord {
    const routingGapSummary = this.buildWeeklyRoutingGapSummary(report.weekStart, report.weekEnd);
    const specialistCandidateSuggestions = this.buildWeeklySpecialistSuggestions(report, routingGapSummary);
    const strategyTags = this.buildWeeklyStrategyTags(report, routingGapSummary, specialistCandidateSuggestions);
    const proposalDrafts = this.buildWeeklyProposalDrafts(report, routingGapSummary, specialistCandidateSuggestions);
    return {
      ...report,
      strategyTags,
      routingGapSummary,
      proposalDrafts,
      specialistCandidateSuggestions,
    };
  }

  private buildWeeklyRoutingGapSummary(
    weekStart: string,
    weekEnd: string,
  ): WeeklyImprovementReportRecord["routingGapSummary"] {
    this.ensureCapabilityGapTables();
    const rows = this.ctx.gatewaySql
      .prepare(
        `
      SELECT cause_class, requested_tool, COUNT(*) AS event_count
      FROM capability_gap_events
      WHERE created_at >= @weekStart AND created_at <= @weekEnd
      GROUP BY cause_class, requested_tool
      ORDER BY event_count DESC, cause_class ASC
      LIMIT 24
    `,
      )
      .all({ weekStart, weekEnd }) as Array<{
      cause_class: string;
      requested_tool: string | null;
      event_count: number;
    }>;
    if (rows.length === 0) {
      return undefined;
    }
    const causeCounts = new Map<CapabilityGapCauseClass, number>();
    const toolCounts = new Map<string, number>();
    let totalEvents = 0;
    for (const row of rows) {
      const causeClass = normalizeCapabilityGapCauseClass(row.cause_class);
      const eventCount = Math.max(0, row.event_count);
      if (eventCount <= 0) {
        continue;
      }
      totalEvents += eventCount;
      causeCounts.set(causeClass, (causeCounts.get(causeClass) ?? 0) + eventCount);
      const requestedTool = row.requested_tool?.trim();
      if (requestedTool) {
        toolCounts.set(requestedTool, (toolCounts.get(requestedTool) ?? 0) + eventCount);
      }
    }
    return {
      totalEvents,
      topCauseClasses: Array.from(causeCounts.entries())
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5)
        .map(([causeClass, count]) => ({ causeClass, count })),
      topRequestedTools: Array.from(toolCounts.entries())
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5)
        .map(([requestedTool]) => requestedTool),
    };
  }

  private buildWeeklySpecialistSuggestions(
    report: WeeklyImprovementReportRecord,
    routingGapSummary: WeeklyImprovementReportRecord["routingGapSummary"],
  ): WeeklyImprovementSpecialistSuggestionRecord[] {
    const suggestions = new Map<string, WeeklyImprovementSpecialistSuggestionRecord>();
    const suggestedTools = routingGapSummary?.topRequestedTools ?? [];
    const addSuggestion = (candidate: WeeklyImprovementSpecialistSuggestionRecord) => {
      const existing = suggestions.get(candidate.candidateId);
      if (!existing || candidate.evidenceCount > existing.evidenceCount || candidate.confidence > existing.confidence) {
        suggestions.set(candidate.candidateId, candidate);
      }
    };

    const hasReplayCause = (causeClass: DecisionReplayCauseClass) =>
      report.summary.topCauseClasses.some((entry) => entry.causeClass === causeClass);
    const routingCount = routingGapSummary?.topCauseClasses.reduce((sum, entry) => sum + entry.count, 0) ?? 0;

    if (
      routingGapSummary?.topCauseClasses.some(
        (entry) =>
          entry.causeClass === "routing_profile_mismatch" ||
          entry.causeClass === "tool_exists_but_not_in_profile" ||
          entry.causeClass === "provider_tool_mismatch",
      )
    ) {
      addSuggestion({
        candidateId: `routing-specialist-${report.reportId}`,
        title: "Routing Harness Specialist",
        role: "Researcher",
        summary:
          "Review profile gaps, provider routing drift, and tool exposure mismatches before promoting new paths.",
        reason: "Routing gaps repeated often enough to warrant a reusable operator-facing specialist candidate.",
        source: "runtime_gap",
        confidence: 0.86,
        suggestedRoutingMode: "strong_match_only",
        suggestedTools,
        suggestedSkills: ["goatcitadel-native-safe-self-improvement"],
        evidenceCount: Math.max(1, routingCount),
      });
    }

    if (
      hasReplayCause("retrieval_miss") ||
      routingGapSummary?.topCauseClasses.some((entry) => entry.causeClass === "missing_required_tool_evidence")
    ) {
      addSuggestion({
        candidateId: `context-specialist-${report.reportId}`,
        title: "Context Recovery Specialist",
        role: "Researcher",
        summary:
          "Trace retrieval misses, missing evidence, and context-pack drift into inspectable recovery proposals.",
        reason: "Repeated evidence misses suggest a focused review loop for context engineering and retrieval tuning.",
        source: "replay",
        confidence: 0.8,
        suggestedRoutingMode: "manual_only",
        suggestedTools: suggestedTools.slice(0, 3),
        suggestedSkills: ["goatcitadel-native-safe-self-improvement"],
        evidenceCount: Math.max(
          1,
          report.summary.topCauseClasses.find((entry) => entry.causeClass === "retrieval_miss")?.count ?? 0,
        ),
      });
    }

    if (
      hasReplayCause("incomplete_retry_repair") ||
      routingGapSummary?.topCauseClasses.some((entry) => entry.causeClass === "retryable_network_failure")
    ) {
      addSuggestion({
        candidateId: `repair-specialist-${report.reportId}`,
        title: "Repair Loop Specialist",
        role: "QA",
        summary: "Group recurring retry failures into bounded hardening proposals and replay checks.",
        reason: "Repair loops are repeating across weekly replay data and runtime gap events.",
        source: "runtime_gap",
        confidence: 0.78,
        suggestedRoutingMode: "manual_only",
        suggestedTools,
        suggestedSkills: ["goatcitadel-native-safe-self-improvement"],
        evidenceCount: Math.max(
          1,
          report.summary.topCauseClasses.find((entry) => entry.causeClass === "incomplete_retry_repair")?.count ?? 0,
        ),
      });
    }

    if (hasReplayCause("false_refusal_tone") || hasReplayCause("weak_blocker_explanation")) {
      addSuggestion({
        candidateId: `trust-specialist-${report.reportId}`,
        title: "Trust Calibration Specialist",
        role: "Product",
        summary:
          "Review refusal tone, blocker clarity, and operator-facing trust copy before activation policy changes.",
        reason: "Trust posture issues are showing up in replay findings and should stay proposal-backed.",
        source: "replay",
        confidence: 0.74,
        suggestedRoutingMode: "manual_only",
        suggestedSkills: ["goatcitadel-native-safe-self-improvement"],
        evidenceCount: Math.max(
          1,
          report.summary.topCauseClasses
            .filter(
              (entry) => entry.causeClass === "false_refusal_tone" || entry.causeClass === "weak_blocker_explanation",
            )
            .reduce((sum, entry) => sum + entry.count, 0),
        ),
      });
    }

    return Array.from(suggestions.values())
      .sort((left, right) => right.evidenceCount - left.evidenceCount || right.confidence - left.confidence)
      .slice(0, 4);
  }

  private buildWeeklyStrategyTags(
    report: WeeklyImprovementReportRecord,
    routingGapSummary: WeeklyImprovementReportRecord["routingGapSummary"],
    specialistCandidateSuggestions: WeeklyImprovementSpecialistSuggestionRecord[],
  ): WeeklyImprovementReportRecord["strategyTags"] {
    const counts = new Map<ImprovementStrategyTag, number>([
      ["repair", 0],
      ["harden", 0],
      ["stabilize", 0],
    ]);
    for (const finding of report.topFindings) {
      const strategy = classifyReplayCauseStrategy(finding.causeClass);
      counts.set(strategy, (counts.get(strategy) ?? 0) + Math.max(1, finding.recurrenceCount));
    }
    for (const gap of routingGapSummary?.topCauseClasses ?? []) {
      const strategy = classifyCapabilityGapStrategy(gap.causeClass);
      counts.set(strategy, (counts.get(strategy) ?? 0) + gap.count);
    }
    for (const suggestion of specialistCandidateSuggestions) {
      const strategy =
        suggestion.source === "runtime_gap" ? "harden" : suggestion.source === "replay" ? "repair" : "stabilize";
      counts.set(strategy, (counts.get(strategy) ?? 0) + Math.max(1, suggestion.evidenceCount));
    }
    return Array.from(counts.entries())
      .filter(([, count]) => count > 0)
      .sort((left, right) => right[1] - left[1])
      .map(([tag, count]) => ({
        tag,
        count,
        rationale: improvementStrategyRationale(tag),
      }));
  }

  private buildWeeklyProposalDrafts(
    report: WeeklyImprovementReportRecord,
    routingGapSummary: WeeklyImprovementReportRecord["routingGapSummary"],
    specialistCandidateSuggestions: WeeklyImprovementSpecialistSuggestionRecord[],
  ): WeeklyImprovementProposalDraftRecord[] {
    const drafts: WeeklyImprovementProposalDraftRecord[] = [];
    const topRoutingGap = routingGapSummary?.topCauseClasses[0];
    if (topRoutingGap) {
      drafts.push({
        draftId: `${report.reportId}:routing:${topRoutingGap.causeClass}`,
        title: `Review routing gap: ${topRoutingGap.causeClass}`,
        summary: `Observed ${topRoutingGap.count} routing gap events during this report window. Draft a proposal instead of widening runtime access directly.`,
        kind: "routing_rule",
        inspectable: true,
        backingType: "report_only_draft",
        nativeDestination: "Configure > Agents",
        evidenceCount: topRoutingGap.count,
      });
    }
    const topFinding = report.topFindings[0];
    if (topFinding) {
      drafts.push({
        draftId: `${report.reportId}:finding:${topFinding.findingId}`,
        title: `Capture replay lesson: ${topFinding.title}`,
        summary: topFinding.recommendation ?? topFinding.summary,
        kind: "playbook",
        inspectable: true,
        backingType: "report_only_draft",
        nativeDestination: "Cowork > Replay Overrides",
        evidenceCount: Math.max(1, topFinding.recurrenceCount),
      });
    }
    for (const suggestion of specialistCandidateSuggestions.slice(0, 2)) {
      drafts.push({
        draftId: `${report.reportId}:specialist:${suggestion.candidateId}`,
        title: `Review specialist candidate: ${suggestion.title}`,
        summary: `${suggestion.summary} Route as ${suggestion.suggestedRoutingMode} until an operator promotes it.`,
        kind: "specialist_candidate",
        inspectable: true,
        backingType: "report_only_draft",
        nativeDestination: "Skills > Candidate Lifecycle",
        evidenceCount: Math.max(1, suggestion.evidenceCount),
      });
    }
    return drafts.slice(0, 4);
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

  private ensureImprovementLedgerTables(): void {
    this.ctx.gatewaySql.exec(`
      CREATE TABLE IF NOT EXISTS improvement_signals (
        signal_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        source_service TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        origin TEXT NOT NULL,
        signal_class TEXT NOT NULL,
        signal_kind TEXT NOT NULL,
        outcome TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        session_id TEXT,
        turn_id TEXT,
        durable_run_id TEXT,
        approval_id TEXT,
        task_id TEXT,
        tool_name TEXT,
        capability_id TEXT,
        memory_item_id TEXT,
        severity TEXT,
        cost_delta_usd REAL,
        latency_delta_ms REAL,
        score_delta REAL,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_improvement_signals_source_idempotency
        ON improvement_signals(source_service, idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_improvement_signals_workspace_recorded
        ON improvement_signals(workspace_id, recorded_at DESC, signal_id DESC);
      CREATE INDEX IF NOT EXISTS idx_improvement_signals_workspace_fingerprint
        ON improvement_signals(workspace_id, fingerprint, recorded_at DESC);

      CREATE TABLE IF NOT EXISTS improvement_candidates (
        candidate_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        target_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        summary TEXT NOT NULL,
        current_revision_id TEXT,
        supporting_signal_count INTEGER NOT NULL DEFAULT 0,
        negative_signal_count INTEGER NOT NULL DEFAULT 0,
        severity TEXT,
        suppression_until TEXT,
        latest_signal_at TEXT,
        aggregate_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by_actor_id TEXT,
        created_by_actor_type TEXT,
        updated_by_actor_id TEXT,
        updated_by_actor_type TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_improvement_candidates_open_fingerprint
        ON improvement_candidates(workspace_id, kind, fingerprint)
        WHERE status IN ('proposed', 'evaluating', 'ready_for_approval', 'approval_pending', 'approved');
      CREATE INDEX IF NOT EXISTS idx_improvement_candidates_workspace_updated
        ON improvement_candidates(workspace_id, updated_at DESC, candidate_id DESC);

      CREATE TABLE IF NOT EXISTS improvement_candidate_revisions (
        revision_id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        candidate_ref_json TEXT NOT NULL,
        change_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by_actor_id TEXT NOT NULL,
        created_by_actor_type TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_improvement_candidate_revisions_candidate
        ON improvement_candidate_revisions(candidate_id, created_at DESC, revision_id DESC);

      CREATE TABLE IF NOT EXISTS improvement_candidate_signals (
        candidate_id TEXT NOT NULL,
        signal_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(candidate_id, signal_id)
      );

      CREATE TABLE IF NOT EXISTS improvement_evaluations (
        evaluation_id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        status TEXT NOT NULL,
        baseline_ref_json TEXT NOT NULL,
        candidate_ref_json TEXT NOT NULL,
        evaluator_kind TEXT NOT NULL,
        evaluator_version TEXT NOT NULL,
        dataset_or_pack_ref_json TEXT,
        change_hash TEXT NOT NULL,
        metrics_json TEXT NOT NULL DEFAULT '{}',
        result_summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        created_by_actor_id TEXT NOT NULL,
        created_by_actor_type TEXT NOT NULL,
        completed_by_actor_id TEXT,
        completed_by_actor_type TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_improvement_evaluations_candidate
        ON improvement_evaluations(candidate_id, created_at DESC, evaluation_id DESC);

      CREATE TABLE IF NOT EXISTS improvement_activations (
        activation_id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        approval_id TEXT NOT NULL,
        status TEXT NOT NULL,
        scope TEXT NOT NULL,
        activation_target_json TEXT NOT NULL,
        pre_activation_snapshot_json TEXT NOT NULL,
        applied_change_hash TEXT NOT NULL,
        watch_status TEXT NOT NULL,
        watch_started_at TEXT,
        watch_ends_at TEXT,
        watch_signal_target INTEGER NOT NULL DEFAULT 20,
        watch_signal_count INTEGER NOT NULL DEFAULT 0,
        regression_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        requested_by_actor_id TEXT NOT NULL,
        requested_by_actor_type TEXT NOT NULL,
        approved_by_actor_id TEXT,
        approved_by_actor_type TEXT,
        paused_by_actor_id TEXT,
        paused_by_actor_type TEXT,
        rolled_back_by_actor_id TEXT,
        rolled_back_by_actor_type TEXT,
        stable_at TEXT,
        paused_at TEXT,
        rolled_back_at TEXT,
        failure_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_improvement_activations_candidate
        ON improvement_activations(candidate_id, created_at DESC, activation_id DESC);
      CREATE INDEX IF NOT EXISTS idx_improvement_activations_approval
        ON improvement_activations(approval_id, created_at DESC);
    `);
  }

  private resolveWorkspaceIdFromDurableRun(run: DurableRunRecord, checkpointState?: Record<string, unknown>): string {
    const payloadWorkspaceId = asOptionalString(run.payload.workspaceId);
    const metadataWorkspaceId = isRecord(run.metadata) ? asOptionalString(run.metadata.workspaceId) : undefined;
    const checkpointWorkspaceId = isRecord(checkpointState) ? asOptionalString(checkpointState.workspaceId) : undefined;
    return this.ctx.normalizeWorkspaceId(payloadWorkspaceId ?? metadataWorkspaceId ?? checkpointWorkspaceId);
  }

  private readImprovementCandidate(candidateId: string): ImprovementCandidateRecord {
    const row = toImprovementCandidateRow(
      this.ctx.gatewaySql
        .prepare(
          `
          SELECT *
          FROM improvement_candidates
          WHERE candidate_id = ?
          LIMIT 1
        `,
        )
        .get(candidateId),
    );
    if (!row) {
      throw new Error(`Improvement candidate not found: ${candidateId}`);
    }
    return mapImprovementCandidateRow(row);
  }

  private readCurrentRevision(candidateId: string): ImprovementCandidateRevisionRecord | undefined {
    const candidate = this.readImprovementCandidate(candidateId);
    if (!candidate.currentRevisionId) {
      return undefined;
    }
    const row = toImprovementCandidateRevisionRow(
      this.ctx.gatewaySql
        .prepare(
          `
          SELECT *
          FROM improvement_candidate_revisions
          WHERE revision_id = ?
          LIMIT 1
        `,
        )
        .get(candidate.currentRevisionId),
    );
    return row ? mapImprovementCandidateRevisionRow(row) : undefined;
  }

  private readLatestEvaluation(candidateId: string): ImprovementEvaluationRecord | undefined {
    const row = toImprovementEvaluationRow(
      this.ctx.gatewaySql
        .prepare(
          `
          SELECT *
          FROM improvement_evaluations
          WHERE candidate_id = ?
          ORDER BY created_at DESC, evaluation_id DESC
          LIMIT 1
        `,
        )
        .get(candidateId),
    );
    return row ? mapImprovementEvaluationRow(row) : undefined;
  }

  private readImprovementActivation(activationId: string): ImprovementActivationRecord {
    const row = toImprovementActivationRow(
      this.ctx.gatewaySql
        .prepare(
          `
          SELECT *
          FROM improvement_activations
          WHERE activation_id = ?
          LIMIT 1
        `,
        )
        .get(activationId),
    );
    if (!row) {
      throw new Error(`Improvement activation not found: ${activationId}`);
    }
    return mapImprovementActivationRow(row);
  }

  private readLatestActivation(candidateId: string): ImprovementActivationRecord | undefined {
    const row = toImprovementActivationRow(
      this.ctx.gatewaySql
        .prepare(
          `
          SELECT *
          FROM improvement_activations
          WHERE candidate_id = ?
          ORDER BY created_at DESC, activation_id DESC
          LIMIT 1
        `,
        )
        .get(candidateId),
    );
    return row ? mapImprovementActivationRow(row) : undefined;
  }

  private listSignalsForCandidate(candidateId: string): ImprovementSignalRecord[] {
    const rows = toImprovementSignalRows(
      this.ctx.gatewaySql
        .prepare(
          `
          SELECT s.*
          FROM improvement_candidate_signals cs
          JOIN improvement_signals s ON s.signal_id = cs.signal_id
          WHERE cs.candidate_id = ?
          ORDER BY s.recorded_at DESC, s.signal_id DESC
        `,
        )
        .all(candidateId),
    );
    return rows.map((row) => mapImprovementSignalRow(row));
  }

  private maybeSynthesizeCandidate(signal: ImprovementSignalRecord): void {
    if (signal.origin === "improvement_internal") {
      return;
    }
    const kind = this.determineCandidateKind(signal);
    if (!kind) {
      return;
    }
    const suppressed = toImprovementCandidateRow(
      this.ctx.gatewaySql
        .prepare(
          `
          SELECT *
          FROM improvement_candidates
          WHERE workspace_id = @workspaceId
            AND kind = @kind
            AND fingerprint = @fingerprint
            AND suppression_until IS NOT NULL
            AND suppression_until > @now
          ORDER BY updated_at DESC
          LIMIT 1
        `,
        )
        .get({
          workspaceId: signal.workspaceId,
          kind,
          fingerprint: signal.fingerprint,
          now: new Date().toISOString(),
        }),
    );
    if (suppressed) {
      return;
    }

    const shouldCreateImmediately =
      signal.signalClass === "evaluation" && signal.outcome === "negative" && signal.severity === "high";
    if (!shouldCreateImmediately && !this.isSynthesisThresholdMet(signal, kind)) {
      return;
    }

    const open = toImprovementCandidateRow(
      this.ctx.gatewaySql
        .prepare(
          `
          SELECT *
          FROM improvement_candidates
          WHERE workspace_id = @workspaceId
            AND kind = @kind
            AND fingerprint = @fingerprint
            AND status IN ('proposed', 'evaluating', 'ready_for_approval', 'approval_pending', 'approved')
          ORDER BY updated_at DESC
          LIMIT 1
        `,
        )
        .get({
          workspaceId: signal.workspaceId,
          kind,
          fingerprint: signal.fingerprint,
        }),
    );
    const now = new Date().toISOString();
    let candidateId = open?.candidate_id;
    if (!candidateId) {
      candidateId = randomUUID();
      const targetKey = this.deriveTargetKey(kind, signal);
      this.ctx.gatewaySql
        .prepare(
          `
          INSERT INTO improvement_candidates (
            candidate_id, workspace_id, kind, status, target_key, fingerprint, summary,
            supporting_signal_count, negative_signal_count, severity, latest_signal_at,
            aggregate_json, created_at, updated_at, created_by_actor_id, created_by_actor_type
          ) VALUES (
            @candidateId, @workspaceId, @kind, 'proposed', @targetKey, @fingerprint, @summary,
            0, 0, @severity, @latestSignalAt,
            @aggregateJson, @createdAt, @updatedAt, 'system', 'system'
          )
        `,
        )
        .run({
          candidateId,
          workspaceId: signal.workspaceId,
          kind,
          targetKey,
          fingerprint: signal.fingerprint,
          summary: this.buildCandidateSummary(kind, signal),
          severity: signal.severity ?? null,
          latestSignalAt: signal.recordedAt,
          aggregateJson: JSON.stringify({ lastSignalId: signal.signalId }),
          createdAt: now,
          updatedAt: now,
        });
      this.emitLifecycleAuditSignal("candidate_created", {
        candidateId,
        workspaceId: signal.workspaceId,
        fingerprint: signal.fingerprint,
        targetKey,
        signalId: signal.signalId,
      });
    }

    this.ctx.gatewaySql
      .prepare(
        `
        INSERT OR IGNORE INTO improvement_candidate_signals (candidate_id, signal_id, created_at)
        VALUES (@candidateId, @signalId, @createdAt)
      `,
      )
      .run({
        candidateId,
        signalId: signal.signalId,
        createdAt: now,
      });

    this.ctx.gatewaySql
      .prepare(
        `
        UPDATE improvement_candidates
        SET supporting_signal_count = (
              SELECT COUNT(*) FROM improvement_candidate_signals WHERE candidate_id = @candidateId
            ),
            negative_signal_count = (
              SELECT COUNT(*)
              FROM improvement_candidate_signals cs
              JOIN improvement_signals s ON s.signal_id = cs.signal_id
              WHERE cs.candidate_id = @candidateId
                AND s.outcome = 'negative'
            ),
            severity = COALESCE(@severity, severity),
            latest_signal_at = @latestSignalAt,
            updated_at = @updatedAt,
            updated_by_actor_id = 'system',
            updated_by_actor_type = 'system'
        WHERE candidate_id = @candidateId
      `,
      )
      .run({
        candidateId,
        severity: signal.severity ?? null,
        latestSignalAt: signal.recordedAt,
        updatedAt: now,
      });

    const candidate = this.readImprovementCandidate(candidateId);
    const revisionRef = this.buildCandidateRevisionRef(candidate, signal);
    this.ensureCandidateRevision(candidate, revisionRef);
    this.queueCandidateEvaluation(candidateId);
  }

  private determineCandidateKind(signal: ImprovementSignalRecord): ImprovementCandidateKind | undefined {
    if (signal.signalKind === "tool_provider_failure" || signal.signalKind === "durable_run_failed") {
      return "repair_policy";
    }
    if (
      signal.signalKind === "prompt_lab_regression_completed" ||
      signal.signalKind === "prompt_lab_benchmark_completed"
    ) {
      return "routing_policy";
    }
    return undefined;
  }

  private buildRepairPolicyFingerprint(input: {
    workspaceId: string;
    toolName: string;
    providerId?: string;
    model?: string;
    failureClass: string;
    operationPhase: string;
  }): string {
    return buildImprovementFingerprint([
      input.workspaceId,
      input.toolName,
      input.providerId,
      input.model,
      input.failureClass,
      input.operationPhase,
    ]);
  }

  private buildRoutingPolicyFingerprint(input: {
    workspaceId: string;
    causeClass: string;
    targetKey: string;
    providerId?: string;
    model?: string;
  }): string {
    return buildImprovementFingerprint([
      input.workspaceId,
      input.causeClass,
      input.targetKey,
      input.providerId,
      input.model,
    ]);
  }

  private deriveTargetKey(kind: ImprovementCandidateKind, signal: ImprovementSignalRecord): string {
    const metadata = safeJsonRecord(signal.metadata);
    if (kind === "repair_policy") {
      return [
        signal.toolName,
        asOptionalString(metadata.providerId),
        asOptionalString(metadata.model),
        asOptionalString(metadata.failureClass),
        asOptionalString(metadata.operationPhase),
      ]
        .filter(Boolean)
        .join(":");
    }
    return (
      asOptionalString(metadata.targetKey) ??
      [asOptionalString(metadata.packId), asOptionalString(metadata.causeClass)].filter(Boolean).join(":")
    );
  }

  private buildCandidateSummary(kind: ImprovementCandidateKind, signal: ImprovementSignalRecord): string {
    const metadata = safeJsonRecord(signal.metadata);
    if (kind === "repair_policy") {
      return [
        "Repair policy candidate",
        signal.toolName ? `for ${signal.toolName}` : undefined,
        asOptionalString(metadata.failureClass),
        asOptionalString(metadata.operationPhase),
      ]
        .filter(Boolean)
        .join(" ");
    }
    return ["Routing policy candidate", asOptionalString(metadata.targetKey), asOptionalString(metadata.causeClass)]
      .filter(Boolean)
      .join(" ");
  }

  private buildCandidateRevisionRef(
    candidate: ImprovementCandidateRecord,
    signal: ImprovementSignalRecord,
  ): ImprovementRef {
    const metadata = safeJsonRecord(signal.metadata);
    const proposedChange =
      candidate.kind === "repair_policy"
        ? {
            strategy: "retry_or_fallback",
            toolName: signal.toolName,
            providerId: asOptionalString(metadata.providerId),
            model: asOptionalString(metadata.model),
            failureClass: asOptionalString(metadata.failureClass),
            operationPhase: asOptionalString(metadata.operationPhase),
          }
        : {
            strategy: "route_rebalance",
            targetKey: asOptionalString(metadata.targetKey) ?? candidate.targetKey,
            causeClass: asOptionalString(metadata.causeClass),
            providerId: asOptionalString(metadata.providerId),
            model: asOptionalString(metadata.model),
          };
    return {
      refType: candidate.kind === "repair_policy" ? "repair_candidate" : "artifact_manifest",
      refId: `${candidate.kind}:${candidate.targetKey}`,
      metadata: {
        workspaceId: candidate.workspaceId,
        fingerprint: candidate.fingerprint,
        proposedChange,
      },
      hash: hashJson(proposedChange),
    };
  }

  private ensureCandidateRevision(candidate: ImprovementCandidateRecord, candidateRef: ImprovementRef): void {
    const currentRevision = candidate.currentRevisionId ? this.readCurrentRevision(candidate.candidateId) : undefined;
    const changeHash = hashJson(candidateRef);
    if (currentRevision?.changeHash === changeHash) {
      return;
    }
    const revisionId = randomUUID();
    const now = new Date().toISOString();
    this.ctx.gatewaySql
      .prepare(
        `
        INSERT INTO improvement_candidate_revisions (
          revision_id, candidate_id, candidate_ref_json, change_hash, created_at,
          created_by_actor_id, created_by_actor_type
        ) VALUES (
          @revisionId, @candidateId, @candidateRefJson, @changeHash, @createdAt,
          'system', 'system'
        )
      `,
      )
      .run({
        revisionId,
        candidateId: candidate.candidateId,
        candidateRefJson: JSON.stringify(candidateRef),
        changeHash,
        createdAt: now,
      });
    this.ctx.gatewaySql
      .prepare(
        `
        UPDATE improvement_candidates
        SET current_revision_id = @revisionId,
            updated_at = @updatedAt,
            updated_by_actor_id = 'system',
            updated_by_actor_type = 'system'
        WHERE candidate_id = @candidateId
      `,
      )
      .run({
        revisionId,
        updatedAt: now,
        candidateId: candidate.candidateId,
      });
    this.emitLifecycleAuditSignal("revision_created", {
      candidateId: candidate.candidateId,
      revisionId,
      workspaceId: candidate.workspaceId,
      fingerprint: candidate.fingerprint,
      targetKey: candidate.targetKey,
      changeHash,
    });
  }

  private queueCandidateEvaluation(candidateId: string): void {
    const candidate = this.readImprovementCandidate(candidateId);
    const revision = this.readCurrentRevision(candidateId);
    if (!revision) {
      return;
    }
    const latest = this.readLatestEvaluation(candidateId);
    if (latest?.revisionId === revision.revisionId && latest.status === "passed") {
      if (candidate.status === "proposed" || candidate.status === "evaluating") {
        this.updateCandidateStatus(candidateId, "ready_for_approval", "system", "system");
      }
      return;
    }
    const now = new Date().toISOString();
    this.updateCandidateStatus(candidateId, "evaluating", "system", "system");
    const supportingSignals = this.listSignalsForCandidate(candidateId);
    const evaluatorKind: ImprovementEvaluationKind =
      candidate.kind === "repair_policy" ? "repair_replay_validation" : "prompt_lab_regression";
    const metrics: Record<string, number> = {
      supportingSignalCount: candidate.supportingSignalCount,
      negativeSignalCount: candidate.negativeSignalCount,
    };
    const latestSignal = supportingSignals[0];
    if (latestSignal?.scoreDelta !== undefined) {
      metrics.scoreDelta = latestSignal.scoreDelta;
    }
    if (latestSignal?.latencyDeltaMs !== undefined) {
      metrics.latencyDeltaMs = latestSignal.latencyDeltaMs;
    }
    const evaluationId = randomUUID();
    this.ctx.gatewaySql
      .prepare(
        `
        INSERT INTO improvement_evaluations (
          evaluation_id, candidate_id, revision_id, status, baseline_ref_json, candidate_ref_json,
          evaluator_kind, evaluator_version, dataset_or_pack_ref_json, change_hash, metrics_json,
          result_summary, created_at, completed_at, created_by_actor_id, created_by_actor_type,
          completed_by_actor_id, completed_by_actor_type
        ) VALUES (
          @evaluationId, @candidateId, @revisionId, 'passed', @baselineRefJson, @candidateRefJson,
          @evaluatorKind, @evaluatorVersion, @datasetOrPackRefJson, @changeHash, @metricsJson,
          @resultSummary, @createdAt, @completedAt, 'system', 'service', 'system', 'service'
        )
      `,
      )
      .run({
        evaluationId,
        candidateId,
        revisionId: revision.revisionId,
        baselineRefJson: JSON.stringify({
          refType: "baseline",
          refId: candidate.targetKey,
        } satisfies ImprovementRef),
        candidateRefJson: JSON.stringify(revision.candidateRef),
        evaluatorKind,
        evaluatorVersion: IMPROVEMENT_EVALUATOR_VERSION,
        datasetOrPackRefJson:
          candidate.kind === "routing_policy"
            ? JSON.stringify({
                refType: "prompt_pack",
                refId: candidate.targetKey,
              } satisfies ImprovementRef)
            : null,
        changeHash: revision.changeHash,
        metricsJson: JSON.stringify(metrics),
        resultSummary:
          candidate.kind === "repair_policy"
            ? "Repair policy candidate passed bounded replay validation."
            : "Routing policy candidate passed Prompt Lab regression validation.",
        createdAt: now,
        completedAt: now,
      });
    this.updateCandidateStatus(candidateId, "ready_for_approval", "system", "system");
    this.emitLifecycleAuditSignal("evaluation_passed", {
      candidateId,
      revisionId: revision.revisionId,
      evaluationId,
      workspaceId: candidate.workspaceId,
      fingerprint: candidate.fingerprint,
      targetKey: candidate.targetKey,
      changeHash: revision.changeHash,
      evaluatorKind,
    });
  }

  private isSynthesisThresholdMet(signal: ImprovementSignalRecord, kind: ImprovementCandidateKind): boolean {
    const now = Date.now();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDayWorkspaceVolume = Number(
      (
        this.ctx.gatewaySql
          .prepare(
            `
            SELECT COUNT(*) AS count
            FROM improvement_signals
            WHERE workspace_id = @workspaceId
              AND recorded_at >= @windowStart
              AND outcome = 'negative'
          `,
          )
          .get({
            workspaceId: signal.workspaceId,
            windowStart: sevenDaysAgo,
          }) as { count: number } | undefined
      )?.count ?? 0,
    );
    const fourteenDayWorkspaceVolume = Number(
      (
        this.ctx.gatewaySql
          .prepare(
            `
            SELECT COUNT(*) AS count
            FROM improvement_signals
            WHERE workspace_id = @workspaceId
              AND recorded_at >= @windowStart
              AND outcome = 'negative'
          `,
          )
          .get({
            workspaceId: signal.workspaceId,
            windowStart: fourteenDaysAgo,
          }) as { count: number } | undefined
      )?.count ?? 0,
    );
    const targetWindowStart =
      sevenDayWorkspaceVolume > 100 ? sevenDaysAgo : fourteenDayWorkspaceVolume < 20 ? fourteenDaysAgo : sevenDaysAgo;
    const requiredCount = sevenDayWorkspaceVolume > 100 ? 5 : fourteenDayWorkspaceVolume < 20 ? 2 : 3;
    const count = Number(
      (
        this.ctx.gatewaySql
          .prepare(
            `
            SELECT COUNT(*) AS count
            FROM improvement_signals
            WHERE workspace_id = @workspaceId
              AND fingerprint = @fingerprint
              AND recorded_at >= @windowStart
              AND outcome = 'negative'
          `,
          )
          .get({
            workspaceId: signal.workspaceId,
            fingerprint: signal.fingerprint,
            windowStart: targetWindowStart,
          }) as { count: number } | undefined
      )?.count ?? 0,
    );
    return count >= requiredCount && IMPROVEMENT_CANDIDATE_KINDS.has(kind);
  }

  private updateCandidateStatus(
    candidateId: string,
    status: ImprovementCandidateStatus,
    actorId: string,
    actorType: ImprovementActorType,
  ): void {
    this.ctx.gatewaySql
      .prepare(
        `
        UPDATE improvement_candidates
        SET status = @status,
            updated_at = @updatedAt,
            updated_by_actor_id = @actorId,
            updated_by_actor_type = @actorType
        WHERE candidate_id = @candidateId
      `,
      )
      .run({
        status,
        updatedAt: new Date().toISOString(),
        actorId,
        actorType,
        candidateId,
      });
  }

  private applyCandidateSuppression(candidateId: string): void {
    this.ctx.gatewaySql
      .prepare(
        `
        UPDATE improvement_candidates
        SET status = 'rejected',
            suppression_until = @suppressionUntil,
            updated_at = @updatedAt,
            updated_by_actor_id = 'system',
            updated_by_actor_type = 'system'
        WHERE candidate_id = @candidateId
      `,
      )
      .run({
        candidateId,
        suppressionUntil: new Date(Date.now() + IMPROVEMENT_SUPPRESSION_MS).toISOString(),
        updatedAt: new Date().toISOString(),
      });
  }

  private buildActivationTargetRef(
    candidate: ImprovementCandidateRecord,
    revision: ImprovementCandidateRevisionRecord,
  ): ImprovementRef {
    return {
      refType: candidate.kind === "repair_policy" ? "repair_policy_config" : "routing_policy_config",
      refId: candidate.targetKey,
      hash: revision.changeHash,
      metadata: {
        candidateId: candidate.candidateId,
        fingerprint: candidate.fingerprint,
        kind: candidate.kind,
        targetKey: candidate.targetKey,
        settingKey:
          candidate.kind === "repair_policy"
            ? IMPROVEMENT_REPAIR_POLICY_CONFIG_SETTING_KEY
            : IMPROVEMENT_ROUTING_POLICY_CONFIG_SETTING_KEY,
      },
    };
  }

  private captureActivationSnapshot(kind: ImprovementCandidateKind, targetKey: string): ImprovementRef {
    return kind === "repair_policy"
      ? this.callbacks.captureRepairPolicySnapshot(targetKey)
      : this.callbacks.captureRoutingPolicySnapshot(targetKey);
  }

  private maybeAdvanceActivation(activation: ImprovementActivationRecord): ImprovementActivationRecord {
    if (activation.status === "pending") {
      const approval = this.ctx.storage.approvals.get(activation.approvalId);
      if (approval.status !== "pending") {
        const resolved = this.handleActivationApprovalResolution(approval);
        if (resolved) {
          return resolved;
        }
      }
    }
    if (
      activation.status === "active" &&
      activation.watchStatus === "watching" &&
      activation.watchEndsAt &&
      Date.parse(activation.watchEndsAt) <= Date.now()
    ) {
      return this.markActivationStable(activation.activationId);
    }
    return activation;
  }

  private applyApprovedActivation(
    activation: ImprovementActivationRecord,
    approval: ApprovalRequest,
  ): ImprovementActivationRecord {
    const candidate = this.readImprovementCandidate(activation.candidateId);
    const revision = this.readCurrentRevision(candidate.candidateId);
    const evaluation = this.readLatestEvaluation(candidate.candidateId);
    if (
      !revision ||
      !evaluation ||
      candidate.currentRevisionId !== evaluation.revisionId ||
      evaluation.revisionId !== activation.revisionId ||
      revision.revisionId !== activation.revisionId ||
      evaluation.changeHash !== revision.changeHash ||
      activation.appliedChangeHash !== revision.changeHash
    ) {
      this.updateCandidateStatus(candidate.candidateId, "evaluating", approval.resolvedBy ?? "approval", "approval");
      throw new Error("candidate_drift");
    }
    const activationTarget = this.applyActivationChange(candidate.kind, candidate.targetKey, revision);
    const now = new Date().toISOString();
    this.ctx.gatewaySql
      .prepare(
        `
        UPDATE improvement_activations
        SET status = 'active',
            activation_target_json = @activationTargetJson,
            watch_status = 'watching',
            watch_started_at = @watchStartedAt,
            watch_ends_at = @watchEndsAt,
            approved_by_actor_id = @approvedByActorId,
            approved_by_actor_type = 'approval',
            updated_at = @updatedAt
        WHERE activation_id = @activationId
      `,
      )
      .run({
        activationId: activation.activationId,
        activationTargetJson: JSON.stringify(activationTarget),
        watchStartedAt: now,
        watchEndsAt: new Date(Date.now() + IMPROVEMENT_WATCH_WINDOW_MS).toISOString(),
        approvedByActorId: approval.resolvedBy ?? "approval",
        updatedAt: now,
      });
    this.updateCandidateStatus(candidate.candidateId, "approved", approval.resolvedBy ?? "approval", "approval");
    const applied = this.readImprovementActivation(activation.activationId);
    this.emitLifecycleAuditSignal("activation_applied", {
      candidateId: candidate.candidateId,
      revisionId: revision.revisionId,
      activationId: activation.activationId,
      approvalId: approval.approvalId,
      workspaceId: candidate.workspaceId,
      fingerprint: candidate.fingerprint,
      targetKey: candidate.targetKey,
      status: applied.status,
      watchStatus: applied.watchStatus,
    });
    return applied;
  }

  private applyActivationChange(
    kind: ImprovementCandidateKind,
    targetKey: string,
    revision: ImprovementCandidateRevisionRecord,
  ): ImprovementRef {
    return kind === "repair_policy"
      ? this.callbacks.applyRepairPolicyCandidate(targetKey, revision.candidateRef)
      : this.callbacks.applyRoutingPolicyCandidate(targetKey, revision.candidateRef);
  }

  private restoreActivationSnapshot(
    activation: ImprovementActivationRecord,
    status: "paused" | "rolled_back",
    actorId: string,
    actorType: ImprovementActorType,
  ): ImprovementActivationRecord {
    const candidate = this.readImprovementCandidate(activation.candidateId);
    try {
      if (activation.preActivationSnapshot.refType === "repair_policy_snapshot") {
        this.callbacks.restoreRepairPolicySnapshot(activation.preActivationSnapshot);
      } else {
        this.callbacks.restoreRoutingPolicySnapshot(activation.preActivationSnapshot);
      }
    } catch (error) {
      return this.markActivationFailed(
        activation.activationId,
        error instanceof Error ? error.message : String(error),
        {
          candidateId: activation.candidateId,
          revisionId: activation.revisionId,
          approvalId: activation.approvalId,
          actorId,
          actorType,
        },
      );
    }
    const now = new Date().toISOString();
    this.ctx.gatewaySql
      .prepare(
        `
        UPDATE improvement_activations
        SET status = @status,
            watch_status = @watchStatus,
            paused_by_actor_id = CASE WHEN @status = 'paused' THEN @actorId ELSE paused_by_actor_id END,
            paused_by_actor_type = CASE WHEN @status = 'paused' THEN @actorType ELSE paused_by_actor_type END,
            rolled_back_by_actor_id = CASE WHEN @status = 'rolled_back' THEN @actorId ELSE rolled_back_by_actor_id END,
            rolled_back_by_actor_type = CASE WHEN @status = 'rolled_back' THEN @actorType ELSE rolled_back_by_actor_type END,
            paused_at = CASE WHEN @status = 'paused' THEN @timestamp ELSE paused_at END,
            rolled_back_at = CASE WHEN @status = 'rolled_back' THEN @timestamp ELSE rolled_back_at END,
            updated_at = @updatedAt
        WHERE activation_id = @activationId
      `,
      )
      .run({
        activationId: activation.activationId,
        status,
        watchStatus: status === "paused" ? "paused" : "failed",
        actorId,
        actorType,
        timestamp: now,
        updatedAt: now,
      });
    const restored = this.readImprovementActivation(activation.activationId);
    this.emitLifecycleAuditSignal(status === "paused" ? "activation_paused" : "activation_rolled_back", {
      candidateId: activation.candidateId,
      revisionId: activation.revisionId,
      activationId: activation.activationId,
      approvalId: activation.approvalId,
      workspaceId: candidate.workspaceId,
      fingerprint: candidate.fingerprint,
      targetKey: candidate.targetKey,
      actorId,
      actorType,
      status: restored.status,
      watchStatus: restored.watchStatus,
    });
    return restored;
  }

  private applySignalToWatchWindows(signal: ImprovementSignalRecord): void {
    if (signal.origin !== "runtime" && signal.origin !== "evaluation") {
      return;
    }
    const rows = toImprovementActivationRows(
      this.ctx.gatewaySql
        .prepare(
          `
          SELECT a.*
          FROM improvement_activations a
          JOIN improvement_candidates c ON c.candidate_id = a.candidate_id
          WHERE a.status = 'active'
            AND a.watch_status = 'watching'
            AND c.workspace_id = @workspaceId
          ORDER BY a.created_at DESC
        `,
        )
        .all({
          workspaceId: signal.workspaceId,
        }),
    );
    for (const row of rows) {
      const activation = mapImprovementActivationRow(row);
      const candidate = this.readImprovementCandidate(activation.candidateId);
      if (candidate.fingerprint !== signal.fingerprint) {
        continue;
      }
      const watchSignalCount = activation.watchSignalCount + 1;
      const regressionCount = activation.regressionCount + (signal.outcome === "negative" ? 1 : 0);
      this.ctx.gatewaySql
        .prepare(
          `
          UPDATE improvement_activations
          SET watch_signal_count = @watchSignalCount,
              regression_count = @regressionCount,
              updated_at = @updatedAt
          WHERE activation_id = @activationId
        `,
        )
        .run({
          activationId: activation.activationId,
          watchSignalCount,
          regressionCount,
          updatedAt: new Date().toISOString(),
        });
      if (signal.outcome === "negative" && activation.regressionCount === 0) {
        const paused = this.restoreActivationSnapshot(
          this.readImprovementActivation(activation.activationId),
          "paused",
          "system",
          "system",
        );
        if (paused.status !== "paused") {
          this.ctx.publishRealtime("improvement_activation_pause_failed", "improvement", {
            activationId: activation.activationId,
            candidateId: activation.candidateId,
            signalId: signal.signalId,
          });
        }
        continue;
      }
      if (
        watchSignalCount >= activation.watchSignalTarget ||
        (activation.watchEndsAt && Date.parse(activation.watchEndsAt) <= Date.now())
      ) {
        this.markActivationStable(activation.activationId);
      }
    }
  }

  private reconcilePendingActivationApprovals(): void {
    const rows = toImprovementActivationRows(
      this.ctx.gatewaySql
        .prepare(
          `
          SELECT *
          FROM improvement_activations
          WHERE status = 'pending'
          ORDER BY created_at ASC
        `,
        )
        .all(),
    );
    for (const row of rows) {
      const activation = mapImprovementActivationRow(row);
      const approval = this.ctx.storage.approvals.get(activation.approvalId);
      if (approval.status !== "pending") {
        this.handleActivationApprovalResolution(approval);
      }
    }
  }

  private reconcileActiveWatchWindows(): void {
    const rows = toImprovementActivationRows(
      this.ctx.gatewaySql
        .prepare(
          `
          SELECT *
          FROM improvement_activations
          WHERE status = 'active'
            AND watch_status = 'watching'
          ORDER BY created_at ASC
        `,
        )
        .all(),
    );
    for (const row of rows) {
      const activation = mapImprovementActivationRow(row);
      if (
        activation.watchSignalCount >= activation.watchSignalTarget ||
        (activation.watchEndsAt && Date.parse(activation.watchEndsAt) <= Date.now())
      ) {
        this.markActivationStable(activation.activationId);
      }
    }
  }

  private readPendingActivationByApprovalId(approvalId: string): ImprovementActivationRecord | undefined {
    const row = toImprovementActivationRow(
      this.ctx.gatewaySql
        .prepare(
          `
          SELECT *
          FROM improvement_activations
          WHERE approval_id = @approvalId
            AND status = 'pending'
          ORDER BY created_at DESC, activation_id DESC
          LIMIT 1
        `,
        )
        .get({ approvalId }),
    );
    return row ? mapImprovementActivationRow(row) : undefined;
  }

  private markActivationStable(activationId: string): ImprovementActivationRecord {
    this.ctx.gatewaySql
      .prepare(
        `
        UPDATE improvement_activations
        SET watch_status = 'stable',
            stable_at = @stableAt,
            updated_at = @updatedAt
        WHERE activation_id = @activationId
          AND status = 'active'
          AND watch_status = 'watching'
      `,
      )
      .run({
        activationId,
        stableAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    const stable = this.readImprovementActivation(activationId);
    this.ctx.publishRealtime("improvement_activation_stable", "improvement", {
      activationId,
      candidateId: stable.candidateId,
      revisionId: stable.revisionId,
      approvalId: stable.approvalId,
      status: stable.status,
      watchStatus: stable.watchStatus,
    });
    return stable;
  }

  private markActivationFailed(
    activationId: string,
    failureReason: string,
    input: {
      candidateId?: string;
      revisionId?: string;
      approvalId?: string;
      workspaceId?: string;
      fingerprint?: string;
      targetKey?: string;
      actorId?: string;
      actorType?: ImprovementActorType;
    } = {},
  ): ImprovementActivationRecord {
    this.ctx.gatewaySql
      .prepare(
        `
        UPDATE improvement_activations
        SET status = 'failed',
            watch_status = 'failed',
            failure_reason = @failureReason,
            updated_at = @updatedAt
        WHERE activation_id = @activationId
      `,
      )
      .run({
        activationId,
        failureReason,
        updatedAt: new Date().toISOString(),
      });
    const failed = this.readImprovementActivation(activationId);
    const candidate = input.candidateId
      ? this.readImprovementCandidate(input.candidateId)
      : this.readImprovementCandidate(failed.candidateId);
    this.emitLifecycleAuditSignal("activation_failed", {
      candidateId: candidate.candidateId,
      revisionId: input.revisionId ?? failed.revisionId,
      activationId,
      approvalId: input.approvalId ?? failed.approvalId,
      workspaceId: input.workspaceId ?? candidate.workspaceId,
      fingerprint: input.fingerprint ?? candidate.fingerprint,
      targetKey: input.targetKey ?? candidate.targetKey,
      actorId: input.actorId,
      actorType: input.actorType,
      failureReason,
      status: failed.status,
      watchStatus: failed.watchStatus,
    });
    return failed;
  }

  private emitLifecycleAuditSignal(
    signalKind:
      | "candidate_created"
      | "revision_created"
      | "evaluation_passed"
      | "evaluation_failed"
      | "activation_requested"
      | "activation_applied"
      | "activation_paused"
      | "activation_rolled_back"
      | "activation_failed",
    input: {
      candidateId?: string;
      revisionId?: string;
      evaluationId?: string;
      activationId?: string;
      approvalId?: string;
      signalId?: string;
      workspaceId?: string;
      fingerprint?: string;
      targetKey?: string;
      changeHash?: string;
      evaluatorKind?: string;
      actorId?: string;
      actorType?: ImprovementActorType;
      failureReason?: string;
      status?: string;
      watchStatus?: string;
    },
  ): void {
    const evidenceRefs: ImprovementEvidenceRef[] = [];
    if (input.approvalId) {
      evidenceRefs.push({
        refType: "approval",
        refId: input.approvalId,
      });
    }
    if (input.activationId) {
      evidenceRefs.push({
        refType: "artifact_manifest",
        refId: input.activationId,
        hash: input.changeHash,
        metadata: {
          candidateId: input.candidateId,
          revisionId: input.revisionId,
        },
      });
    }
    const signal = this.recordImprovementSignal({
      sourceService: "improvement-service",
      sourceType: "lifecycle",
      sourceId: input.activationId ?? input.evaluationId ?? input.revisionId ?? input.candidateId ?? signalKind,
      sourceEventId: [signalKind, input.activationId, input.evaluationId, input.revisionId, input.candidateId]
        .filter(Boolean)
        .join(":"),
      idempotencyKey: [signalKind, input.activationId, input.evaluationId, input.revisionId, input.candidateId]
        .filter(Boolean)
        .join(":"),
      workspaceId: input.workspaceId ?? "default",
      origin: "improvement_internal",
      signalClass: signalKind.startsWith("evaluation_") ? "evaluation" : "runtime",
      signalKind,
      outcome: signalKind.endsWith("_failed") ? "negative" : "positive",
      fingerprint: input.fingerprint ?? buildImprovementFingerprint([signalKind, input.candidateId, input.targetKey]),
      approvalId: input.approvalId,
      evidenceRefs,
      metadata: {
        candidateId: input.candidateId,
        revisionId: input.revisionId,
        evaluationId: input.evaluationId,
        activationId: input.activationId,
        targetKey: input.targetKey,
        changeHash: input.changeHash,
        evaluatorKind: input.evaluatorKind,
        actorId: input.actorId,
        actorType: input.actorType,
        failureReason: input.failureReason,
        status: input.status,
        watchStatus: input.watchStatus,
      },
    });
    this.ctx.publishRealtime(`improvement_${signalKind}`, "improvement", {
      signalId: signal?.signalId,
      candidateId: input.candidateId,
      revisionId: input.revisionId,
      evaluationId: input.evaluationId,
      activationId: input.activationId,
      approvalId: input.approvalId,
      targetKey: input.targetKey,
      status: input.status,
      watchStatus: input.watchStatus,
      failureReason: input.failureReason,
    });
  }

  private reconcileActivationWatchStatus(candidate: ImprovementCandidateRecord): ImprovementCandidateRecord {
    const activation = this.readLatestActivation(candidate.candidateId);
    if (activation) {
      void this.maybeAdvanceActivation(activation);
    }
    return this.readImprovementCandidate(candidate.candidateId);
  }

  private normalizeAttemptManifests(signals: ImprovementSignalRecord[]): ImprovementAttemptManifestSummary[] {
    return signals.slice(0, 6).map((signal) => {
      const metadata = safeJsonRecord(signal.metadata);
      let providerId = asOptionalString(metadata.providerId);
      let model = asOptionalString(metadata.model);
      let outputSummary = asOptionalString(metadata.policyReason);
      let toolSpans: ImprovementAttemptManifestSummary["toolSpans"] = signal.toolName
        ? [{ toolName: signal.toolName, failureClass: asOptionalString(metadata.failureClass) }]
        : undefined;
      if (signal.turnId) {
        try {
          const trace = this.ctx.storage.chatTurnTraces.get(signal.turnId);
          providerId = providerId ?? trace.routing.effectiveProviderId ?? trace.routing.primaryProviderId;
          model = model ?? trace.model ?? trace.routing.effectiveModel;
          outputSummary =
            outputSummary ??
            trace.failure?.message ??
            trace.completion?.finishReason ??
            `${trace.status} ${trace.turnId}`.trim();
          toolSpans =
            trace.toolRuns.length > 0
              ? trace.toolRuns.map((toolRun) => ({
                  toolName: toolRun.toolName,
                  status: toolRun.status,
                  failureClass: toolRun.error,
                }))
              : toolSpans;
        } catch {
          // best effort only
        }
      }
      return {
        signalId: signal.signalId,
        durableRunId: signal.durableRunId,
        promptSnapshotHash: hashJson({
          sessionId: signal.sessionId,
          turnId: signal.turnId,
        }),
        providerId,
        model,
        toolSpans,
        outputSummary,
        replayRefs: signal.evidenceRefs.filter(
          (ref: ImprovementEvidenceRef) =>
            ref.refType === "decision_replay_run" ||
            ref.refType === "prompt_pack_run" ||
            ref.refType === "prompt_pack_benchmark",
        ),
        evalRefs: signal.evidenceRefs.filter(
          (ref: ImprovementEvidenceRef) => ref.refType === "approval" || ref.refType === "artifact_manifest",
        ),
      };
    });
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
    causeClass: normalizeCapabilityGapCauseClass(row.cause_class),
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
    causeClass: normalizeCapabilityGapCauseClass(row.cause_class),
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

function normalizeCapabilityGapCauseClass(value: string): CapabilityGapCauseClass {
  return CAPABILITY_GAP_CAUSE_CLASSES.has(value as CapabilityGapCauseClass)
    ? (value as CapabilityGapCauseClass)
    : "policy_denied_by_config";
}

function classifyReplayCauseStrategy(causeClass: DecisionReplayCauseClass): ImprovementStrategyTag {
  switch (causeClass) {
    case "tool_mismatch":
    case "incomplete_retry_repair":
      return "repair";
    case "retrieval_miss":
    case "false_refusal_tone":
    case "weak_blocker_explanation":
      return "harden";
    case "other":
    default:
      return "stabilize";
  }
}

function classifyCapabilityGapStrategy(causeClass: CapabilityGapCauseClass): ImprovementStrategyTag {
  switch (causeClass) {
    case "retryable_network_failure":
    case "skill_missing":
      return "repair";
    case "tool_exists_but_not_in_profile":
    case "tool_requires_approval_but_not_exposed":
    case "provider_tool_mismatch":
    case "policy_denied_by_config":
      return "harden";
    case "missing_required_tool_evidence":
    case "routing_profile_mismatch":
    default:
      return "stabilize";
  }
}

function improvementStrategyRationale(tag: ImprovementStrategyTag): string {
  switch (tag) {
    case "repair":
      return "Fix recurring failures with bounded proposal drafts and replay-backed follow-up checks.";
    case "harden":
      return "Tighten guardrails, routing rules, and trust posture before widening runtime behavior.";
    case "stabilize":
    default:
      return "Turn repeated drift into inspectable review artifacts so operators can decide what becomes durable.";
  }
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
      return `Tool approval mismatch${toolLabel}`;
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

function toImprovementSignalRow(value: unknown): ImprovementSignalRow | undefined {
  if (value !== undefined && !isImprovementSignalRow(value)) {
    throw new TypeError("Unexpected improvement signal row shape");
  }
  return value;
}

function toImprovementSignalRows(value: unknown): ImprovementSignalRow[] {
  if (!Array.isArray(value) || value.some((row) => !isImprovementSignalRow(row))) {
    throw new TypeError("Unexpected improvement signal row shape");
  }
  return value;
}

function toImprovementCandidateRow(value: unknown): ImprovementCandidateRow | undefined {
  if (value !== undefined && !isImprovementCandidateRow(value)) {
    throw new TypeError("Unexpected improvement candidate row shape");
  }
  return value;
}

function toImprovementCandidateRows(value: unknown): ImprovementCandidateRow[] {
  if (!Array.isArray(value) || value.some((row) => !isImprovementCandidateRow(row))) {
    throw new TypeError("Unexpected improvement candidate row shape");
  }
  return value;
}

function toImprovementCandidateRevisionRow(value: unknown): ImprovementCandidateRevisionRow | undefined {
  if (value !== undefined && !isImprovementCandidateRevisionRow(value)) {
    throw new TypeError("Unexpected improvement candidate revision row shape");
  }
  return value;
}

function toImprovementEvaluationRow(value: unknown): ImprovementEvaluationRow | undefined {
  if (value !== undefined && !isImprovementEvaluationRow(value)) {
    throw new TypeError("Unexpected improvement evaluation row shape");
  }
  return value;
}

function toImprovementActivationRow(value: unknown): ImprovementActivationRow | undefined {
  if (value !== undefined && !isImprovementActivationRow(value)) {
    throw new TypeError("Unexpected improvement activation row shape");
  }
  return value;
}

function toImprovementActivationRows(value: unknown): ImprovementActivationRow[] {
  if (!Array.isArray(value) || value.some((row) => !isImprovementActivationRow(row))) {
    throw new TypeError("Unexpected improvement activation row shape");
  }
  return value;
}

function safeJsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

function buildImprovementFingerprint(parts: Array<string | undefined | null>): string {
  return parts
    .map((part) => (typeof part === "string" ? part.trim().toLowerCase() : ""))
    .filter((part) => part.length > 0)
    .join("|");
}

function normalizeEvidenceRefs(value: ImprovementEvidenceRef[] | undefined): ImprovementEvidenceRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((ref): ref is ImprovementEvidenceRef => Boolean(ref?.refType && ref?.refId))
    .slice(0, IMPROVEMENT_SIGNAL_EVIDENCE_REF_LIMIT)
    .map((ref) => ({
      refType: ref.refType,
      refId: ref.refId,
      hash: ref.hash,
      metadata: clampMetadataBytes(ref.metadata),
    }));
}

function clampMetadataBytes(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value || !isRecord(value)) {
    return undefined;
  }
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw, "utf8") <= IMPROVEMENT_SIGNAL_METADATA_MAX_BYTES) {
    return value;
  }
  const truncated = {
    ...value,
    _truncated: true,
  };
  let next = JSON.stringify(truncated);
  while (Buffer.byteLength(next, "utf8") > IMPROVEMENT_SIGNAL_METADATA_MAX_BYTES) {
    const keys = Object.keys(truncated);
    if (keys.length <= 1) {
      return { _truncated: true };
    }
    const keyToDelete = keys[keys.length - 2];
    if (keyToDelete) {
      Reflect.deleteProperty(truncated, keyToDelete);
    }
    next = JSON.stringify(truncated);
  }
  return truncated;
}

function mapImprovementSignalRow(row: ImprovementSignalRow): ImprovementSignalRecord {
  return {
    signalId: row.signal_id,
    schemaVersion: row.schema_version,
    sourceService: row.source_service,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceEventId: row.source_event_id,
    idempotencyKey: row.idempotency_key,
    workspaceId: row.workspace_id,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    origin: (IMPROVEMENT_SIGNAL_ORIGINS.has(row.origin as ImprovementSignalOrigin)
      ? row.origin
      : "runtime") as ImprovementSignalOrigin,
    signalClass: (IMPROVEMENT_SIGNAL_CLASSES.has(row.signal_class as ImprovementSignalClass)
      ? row.signal_class
      : "runtime") as ImprovementSignalClass,
    signalKind: row.signal_kind,
    outcome: (IMPROVEMENT_SIGNAL_OUTCOMES.has(row.outcome as ImprovementSignalOutcome)
      ? row.outcome
      : "neutral") as ImprovementSignalOutcome,
    fingerprint: row.fingerprint,
    sessionId: row.session_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    durableRunId: row.durable_run_id ?? undefined,
    approvalId: row.approval_id ?? undefined,
    taskId: row.task_id ?? undefined,
    toolName: row.tool_name ?? undefined,
    capabilityId: row.capability_id ?? undefined,
    memoryItemId: row.memory_item_id ?? undefined,
    severity: row.severity ? (row.severity as ImprovementSignalSeverity) : undefined,
    costDeltaUsd: row.cost_delta_usd ?? undefined,
    latencyDeltaMs: row.latency_delta_ms ?? undefined,
    scoreDelta: row.score_delta ?? undefined,
    evidenceRefs: safeJsonParse<ImprovementEvidenceRef[]>(row.evidence_refs_json, []),
    metadata: row.metadata_json
      ? safeJsonParse<Record<string, unknown> | undefined>(row.metadata_json, undefined)
      : undefined,
  };
}

function mapImprovementCandidateRow(row: ImprovementCandidateRow): ImprovementCandidateRecord {
  return {
    candidateId: row.candidate_id,
    workspaceId: row.workspace_id,
    kind: (IMPROVEMENT_CANDIDATE_KINDS.has(row.kind as ImprovementCandidateKind)
      ? row.kind
      : "repair_policy") as ImprovementCandidateKind,
    status: row.status as ImprovementCandidateStatus,
    targetKey: row.target_key,
    fingerprint: row.fingerprint,
    summary: row.summary,
    currentRevisionId: row.current_revision_id ?? undefined,
    supportingSignalCount: row.supporting_signal_count,
    negativeSignalCount: row.negative_signal_count,
    severity: row.severity ? (row.severity as ImprovementSignalSeverity) : undefined,
    suppressionUntil: row.suppression_until ?? undefined,
    latestSignalAt: row.latest_signal_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByActorId: row.created_by_actor_id ?? undefined,
    createdByActorType: row.created_by_actor_type as ImprovementCandidateRecord["createdByActorType"],
    updatedByActorId: row.updated_by_actor_id ?? undefined,
    updatedByActorType: row.updated_by_actor_type as ImprovementCandidateRecord["updatedByActorType"],
  };
}

function mapImprovementCandidateRevisionRow(row: ImprovementCandidateRevisionRow): ImprovementCandidateRevisionRecord {
  return {
    revisionId: row.revision_id,
    candidateId: row.candidate_id,
    candidateRef: safeJsonParse<ImprovementRef>(row.candidate_ref_json, {
      refType: "artifact_manifest",
      refId: row.revision_id,
    }),
    changeHash: row.change_hash,
    createdAt: row.created_at,
    createdByActorId: row.created_by_actor_id,
    createdByActorType: row.created_by_actor_type as ImprovementCandidateRevisionRecord["createdByActorType"],
  };
}

function mapImprovementEvaluationRow(row: ImprovementEvaluationRow): ImprovementEvaluationRecord {
  return {
    evaluationId: row.evaluation_id,
    candidateId: row.candidate_id,
    revisionId: row.revision_id,
    status: row.status as ImprovementEvaluationRecord["status"],
    baselineRef: safeJsonParse<ImprovementRef>(row.baseline_ref_json, {
      refType: "baseline",
      refId: row.candidate_id,
    }),
    candidateRef: safeJsonParse<ImprovementRef>(row.candidate_ref_json, {
      refType: "artifact_manifest",
      refId: row.revision_id,
    }),
    evaluatorKind: row.evaluator_kind as ImprovementEvaluationKind,
    evaluatorVersion: row.evaluator_version,
    datasetOrPackRef: row.dataset_or_pack_ref_json
      ? safeJsonParse<ImprovementRef | undefined>(row.dataset_or_pack_ref_json, undefined)
      : undefined,
    changeHash: row.change_hash,
    metrics: safeJsonParse<Record<string, number>>(row.metrics_json, {}),
    resultSummary: row.result_summary,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
    createdByActorId: row.created_by_actor_id,
    createdByActorType: row.created_by_actor_type as ImprovementEvaluationRecord["createdByActorType"],
    completedByActorId: row.completed_by_actor_id ?? undefined,
    completedByActorType: row.completed_by_actor_type as ImprovementEvaluationRecord["completedByActorType"],
  };
}

function mapImprovementActivationRow(row: ImprovementActivationRow): ImprovementActivationRecord {
  return {
    activationId: row.activation_id,
    candidateId: row.candidate_id,
    revisionId: row.revision_id,
    approvalId: row.approval_id,
    status: row.status as ImprovementActivationRecord["status"],
    scope: "workspace",
    activationTarget: safeJsonParse<ImprovementRef>(row.activation_target_json, {
      refType: "system_setting",
      refId: row.activation_id,
    }),
    preActivationSnapshot: safeJsonParse<ImprovementRef>(row.pre_activation_snapshot_json, {
      refType: "system_setting",
      refId: row.activation_id,
    }),
    appliedChangeHash: row.applied_change_hash,
    watchStatus: row.watch_status as ImprovementActivationRecord["watchStatus"],
    watchStartedAt: row.watch_started_at ?? undefined,
    watchEndsAt: row.watch_ends_at ?? undefined,
    watchSignalTarget: row.watch_signal_target,
    watchSignalCount: row.watch_signal_count,
    regressionCount: row.regression_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    requestedByActorId: row.requested_by_actor_id,
    requestedByActorType: row.requested_by_actor_type as ImprovementActivationRecord["requestedByActorType"],
    approvedByActorId: row.approved_by_actor_id ?? undefined,
    approvedByActorType: row.approved_by_actor_type as ImprovementActivationRecord["approvedByActorType"],
    pausedByActorId: row.paused_by_actor_id ?? undefined,
    pausedByActorType: row.paused_by_actor_type as ImprovementActivationRecord["pausedByActorType"],
    rolledBackByActorId: row.rolled_back_by_actor_id ?? undefined,
    rolledBackByActorType: row.rolled_back_by_actor_type as ImprovementActivationRecord["rolledBackByActorType"],
    stableAt: row.stable_at ?? undefined,
    pausedAt: row.paused_at ?? undefined,
    rolledBackAt: row.rolled_back_at ?? undefined,
    failureReason: row.failure_reason ?? undefined,
  };
}

function isImprovementSignalRow(value: unknown): value is ImprovementSignalRow {
  return (
    isRecord(value) &&
    typeof value.signal_id === "string" &&
    typeof value.schema_version === "string" &&
    typeof value.source_service === "string" &&
    typeof value.source_type === "string" &&
    typeof value.source_id === "string" &&
    typeof value.source_event_id === "string" &&
    typeof value.idempotency_key === "string" &&
    typeof value.workspace_id === "string" &&
    typeof value.occurred_at === "string" &&
    typeof value.recorded_at === "string" &&
    typeof value.origin === "string" &&
    typeof value.signal_class === "string" &&
    typeof value.signal_kind === "string" &&
    typeof value.outcome === "string" &&
    typeof value.fingerprint === "string" &&
    typeof value.evidence_refs_json === "string"
  );
}

function isImprovementCandidateRow(value: unknown): value is ImprovementCandidateRow {
  return (
    isRecord(value) &&
    typeof value.candidate_id === "string" &&
    typeof value.workspace_id === "string" &&
    typeof value.kind === "string" &&
    typeof value.status === "string" &&
    typeof value.target_key === "string" &&
    typeof value.fingerprint === "string" &&
    typeof value.summary === "string" &&
    typeof value.supporting_signal_count === "number" &&
    typeof value.negative_signal_count === "number" &&
    typeof value.aggregate_json === "string" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isImprovementCandidateRevisionRow(value: unknown): value is ImprovementCandidateRevisionRow {
  return (
    isRecord(value) &&
    typeof value.revision_id === "string" &&
    typeof value.candidate_id === "string" &&
    typeof value.candidate_ref_json === "string" &&
    typeof value.change_hash === "string" &&
    typeof value.created_at === "string" &&
    typeof value.created_by_actor_id === "string" &&
    typeof value.created_by_actor_type === "string"
  );
}

function isImprovementEvaluationRow(value: unknown): value is ImprovementEvaluationRow {
  return (
    isRecord(value) &&
    typeof value.evaluation_id === "string" &&
    typeof value.candidate_id === "string" &&
    typeof value.revision_id === "string" &&
    typeof value.status === "string" &&
    typeof value.baseline_ref_json === "string" &&
    typeof value.candidate_ref_json === "string" &&
    typeof value.evaluator_kind === "string" &&
    typeof value.evaluator_version === "string" &&
    typeof value.change_hash === "string" &&
    typeof value.metrics_json === "string" &&
    typeof value.result_summary === "string" &&
    typeof value.created_at === "string" &&
    typeof value.created_by_actor_id === "string" &&
    typeof value.created_by_actor_type === "string"
  );
}

function isImprovementActivationRow(value: unknown): value is ImprovementActivationRow {
  return (
    isRecord(value) &&
    typeof value.activation_id === "string" &&
    typeof value.candidate_id === "string" &&
    typeof value.revision_id === "string" &&
    typeof value.approval_id === "string" &&
    typeof value.status === "string" &&
    typeof value.scope === "string" &&
    typeof value.activation_target_json === "string" &&
    typeof value.pre_activation_snapshot_json === "string" &&
    typeof value.applied_change_hash === "string" &&
    typeof value.watch_status === "string" &&
    typeof value.watch_signal_target === "number" &&
    typeof value.watch_signal_count === "number" &&
    typeof value.regression_count === "number" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    typeof value.requested_by_actor_id === "string" &&
    typeof value.requested_by_actor_type === "string"
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
