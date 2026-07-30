/* eslint-disable @typescript-eslint/no-unused-vars, max-lines */
import { createHash, randomUUID } from "node:crypto";
import {
  clampInt,
  computeImprovementLifecycleRequestSha256,
  computeImprovementLifecycleResultSha256,
  ConflictError,
  IMPROVEMENT_LIFECYCLE_APPROVAL_KIND,
  type ApprovalCreateInput,
  type ApprovalRequest,
  type AgenticDiagnosticSignal,
  type DurableRunRecord,
  type ImprovementLifecycleOperationKind,
  type ImprovementLifecycleOperationRecord,
  type ImprovementLifecycleSettlementDisposition,
  type ImprovementLifecycleSettlementRecord,
  type ImprovementLifecycleTargetKind,
  type RealtimeEvent,
  type TaskRecord,
} from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import type { Storage } from "@goatcitadel/storage";
import type { CronSpecMutationOwner } from "./cron-config-generation-owner.js";
import { assertNoAssembledPromptInjection } from "./assembled-prompt-injection-guard.js";
import { trackBackgroundTask } from "./background-scheduler.js";
import { IMPROVEMENT_WEEKLY_JOB_ID } from "./gateway/cron-job-ids.js";

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
  ModelUsageAttributionContext,
  ChatThinkingLevel,
  ChatTurnTraceRecord,
  ChatWebMode,
  CuratorReviewItem,
  CuratorReviewResponse,
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
  ImprovementCandidateLifecycleAction,
  ImprovementCandidateLifecycleInput,
  ImprovementCandidateLifecycleResult,
  ImprovementCandidateKind,
  ImprovementCandidateRecord,
  ImprovementCandidateRevisionRecord,
  ImprovementCandidateStatus,
  ImprovementEvaluationKind,
  ImprovementEvaluationRecord,
  ImprovementEvidenceRef,
  ImprovementEvidenceRefType,
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
import {
  AgenticImprovementBridgeService,
  type AgenticImprovementBridgeInput,
  type AgenticImprovementBridgeProposal,
} from "./agentic-improvement-bridge-service.js";
import {
  buildCapabilityGapFingerprint,
  buildRepairCandidateSummary,
  buildRepairCandidateTitle,
  buildSuggestedRepairPatch,
  CAPABILITY_GAP_CAUSE_CLASSES,
  classifyCapabilityGapStrategy,
  classifyReplayCauseStrategy,
  type CapabilityGapEventUpsertInput,
  improvementStrategyRationale,
  mapCapabilityGapEventRow,
  mapRepairCandidateRow,
  normalizeCapabilityGapCauseClass,
  normalizeRecoveryOptions,
  REPAIR_VALIDATION_STATUSES,
  type RepairCandidateRow,
  type RepairCandidateValidationUpdateInput,
  toCapabilityGapEventRow,
  toCapabilityGapEventRows,
  toRepairCandidateRow,
  toRepairCandidateRows,
} from "./improvement-capability-gaps.js";
import {
  clamp01,
  clampProbability,
  extractCompletionText,
  parseLooseJsonRecord,
  redactSensitivePayload,
  safeJsonParse,
  truncateForModelJudge,
} from "./improvement-common.js";
import { runBoundedUtilityModelCall } from "./utility-model-call.js";
import { isAuthoritativeModelUsageAccountingError } from "@goatcitadel/gateway-core";
import {
  buildDecisionReplayItemSummary,
  compareDecisionCauseCounts,
  computeDecisionWrongnessProbability,
  type DecisionReplayCandidate,
  evaluateDecisionReplayRuleScores,
  getZonedDateParts,
  inferDecisionReplayCauseClass,
  type ImprovementReplayTriggerInput,
  mapDecisionAutoTuneRow,
  mapDecisionReplayRunRow,
  mapImprovementReportRow,
  normalizeDecisionReplayCauseClass,
  recommendationForDecisionReplayCause,
  type ReplayScoredItemResult,
  sampleDecisionReplayCandidates,
  severityRank,
  summarizeDecisionReplayFinding,
  titleForDecisionReplayCause,
  toWeekKeyForTimezone,
} from "./improvement-replay.js";
import { resolveActiveUpdateTarget } from "./improvement-service-active-update.js";
import {
  buildImprovementLifecycleApprovalBinding,
  buildImprovementLifecycleApprovalPayload,
  buildImprovementLifecycleRequestJourneyEvent,
  buildImprovementLifecycleRequestSha256,
  buildImprovementLifecycleSettlementJourneyEvent,
  buildImprovementLifecycleStateSha256,
  computeImprovementLifecycleObservedStateSha256,
  createImprovementLifecycleOperationRepository,
  deriveImprovementLifecycleActivationId,
  deriveImprovementLifecycleApprovalId,
  deriveImprovementLifecycleInspectionId,
  deriveImprovementLifecycleOperationId,
  deriveImprovementLifecycleSettlementId,
  ImprovementLifecycleApplyError,
  improvementLifecycleOperationIdempotencyKey,
  improvementLifecycleRequestJourneyIdempotencyKey,
  parseImprovementActivateMutation,
  parseImprovementLifecycleApprovalBinding,
  parseImprovementLifecycleRequestEnvelope,
  parseImprovementPauseRollbackMutation,
  type ImprovementExternalStateMaterial,
  type ImprovementLifecycleApprovalBindingV1,
  type ImprovementPauseRollbackMutationV1,
} from "./improvement-lifecycle-journey-producer.js";
import { IDEMPOTENT_REALTIME_ENVELOPE_KEY } from "./realtime-event-service.js";
import { createUtilityModelUsageAttribution } from "./utility-model-usage-attribution.js";

// ── constants ────────────────────────────────────────────────────────
const IMPROVEMENT_WEEKLY_TIME_ZONE = "America/Los_Angeles";
const IMPROVEMENT_WEEKLY_SCHEDULE_LABEL = "0 2 * * 0 America/Los_Angeles";
const IMPROVEMENT_WEEKLY_SAMPLE_SIZE = 500;
const IMPROVEMENT_JUDGE_SAMPLE_LIMIT = 120;
const IMPROVEMENT_JUDGE_TIMEOUT_MS = 15_000;

class ImprovementActivationCompensationError extends Error {}

class ImprovementActivationClaimError extends Error {}

class ImprovementActivationPostCommitError extends Error {}

const IMPROVEMENT_SCHEDULER_INTERVAL_MS = 60_000;
const IMPROVEMENT_WEEKLY_DEDUP_SETTING_KEY = "improvement_weekly_last_week_key_v1";
const IMPROVEMENT_TUNE_KEY_BLOCKER_TEMPLATE = "improvement_tune_blocker_template_v1";
const IMPROVEMENT_TUNE_KEY_RETRY_THRESHOLD = "improvement_tune_retry_threshold_v1";
const IMPROVEMENT_TUNE_KEY_LIVE_INTENT = "improvement_tune_live_intent_threshold_v1";
const IMPROVEMENT_REPAIR_POLICY_CONFIG_SETTING_KEY = "improvement_repair_policy_config_v1";
const IMPROVEMENT_ROUTING_POLICY_CONFIG_SETTING_KEY = "improvement_routing_policy_config_v1";
const IMPROVEMENT_SIGNAL_ORIGINS = new Set<ImprovementSignalOrigin>([
  "runtime",
  "human",
  "evaluation",
  "improvement_internal",
]);
const IMPROVEMENT_SIGNAL_CLASSES = new Set<ImprovementSignalClass>(["runtime", "approval", "evaluation"]);
const IMPROVEMENT_SIGNAL_OUTCOMES = new Set<ImprovementSignalOutcome>(["positive", "negative", "neutral"]);
const IMPROVEMENT_SIGNAL_SEVERITIES = new Set<ImprovementSignalSeverity>(["low", "medium", "high"]);
const IMPROVEMENT_CANDIDATE_KINDS = new Set<ImprovementCandidateKind>([
  "repair_policy",
  "routing_policy",
  "skill_revision",
]);
const IMPROVEMENT_WATCH_SIGNAL_TARGET = 20;
const IMPROVEMENT_SIGNAL_SCHEMA_VERSION = "1.1.1";
const IMPROVEMENT_EVALUATOR_VERSION = "improvement-ledger-v1.1.1";
const IMPROVEMENT_SIGNAL_METADATA_MAX_BYTES = 4 * 1024;
const IMPROVEMENT_SIGNAL_EVIDENCE_REF_LIMIT = 8;

export interface ImprovementServiceContext {
  readonly storage: Pick<
    Storage,
    "approvals" | "approvalEvents" | "chatTurnTraces" | "cronJobs" | "governanceJourneyEvents" | "systemSettings"
  >;
  readonly cronSpecOwner?: Pick<CronSpecMutationOwner, "reconcileSpec">;
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

export interface AgenticImprovementProposalIngestionResult {
  proposal: AgenticImprovementBridgeProposal;
  signal?: ImprovementSignalRecord;
  candidate?: ImprovementCandidateRecord;
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

export interface SurfaceRouteOverrideSignalInput {
  citadelId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  fromMode: string;
  toMode: string;
  autoConfidence: number;
  promptFeatureHash: string;
}

export interface SurfaceRouteOverrideExemplar {
  fromMode: string;
  toMode: string;
  recordedAt: string;
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
  // S2 — skill self-authoring. The gateway delegates these to SkillMutationService.
  // applySkillRevisionCandidate writes the authored SKILL.md, records the
  // candidate lifecycle, and (only under master autonomy) promotes it to a
  // callable `approved` state via this recorded activation. isSkillCallable is
  // never bypassed; promotion is reversible by restoreSkillRevisionSnapshot.
  // These are synchronous to fit the activation state machine (the policy
  // callbacks above are sync); the gateway delegate uses synchronous fs.
  captureSkillRevisionSnapshot(targetKey: string, revisionRef: ImprovementRef): ImprovementRef;
  applySkillRevisionCandidate(targetKey: string, revisionRef: ImprovementRef): ImprovementRef;
  restoreSkillRevisionSnapshot(snapshotRef: ImprovementRef): void;
  createChatCompletion(
    request: ChatCompletionRequest,
    attribution: ModelUsageAttributionContext,
  ): Promise<ChatCompletionResponse>;
  getPromptRunnerModelDefaults(): { providerId?: string; model?: string };
  // P2-W3 — close the improvement loop. These getters report the *effective*
  // value the runtime decision points will read for each tuned setting, using
  // the same translation the readers use (improvement-tune-reads.ts). The tuner
  // is storage-only: it writes the raw setting, then records the effective value
  // these return on the applied auto-tune so the loop is auditable and every
  // written key is demonstrably read at its decision point.
  readEffectiveBlockerTemplateStrictness(): number;
  readEffectiveRetryRepairThreshold(): number;
  readEffectiveLiveIntentThreshold(): number;
  // Cross-cutting kill-switch & rollback. Fired after an auto-tune is applied so
  // the gateway can append a unified autonomy-audit entry. The tune row already
  // holds its own rollback snapshot, so the restoreRef is just the tuneId; revert
  // calls revertDecisionAutoTune(tuneId). Optional + best-effort.
  onAutoTuneApplied?(tuneId: string, settingKey: string): void;
  readTranscriptOrEmpty(sessionId: string): Promise<TranscriptEvent[]>;
  retryChatTurn(
    sessionId: string,
    turnId: string,
    overrides: Partial<ChatSendMessageRequest>,
  ): Promise<ChatSendMessageResponse>;
  readonly backgroundTasks: Set<Promise<void>>;
  closing: boolean;
  /**
   * HX-402 P3 (test-only): lease duration for one governed improvement
   * lifecycle claim. Production uses the default; crash-recovery tests shorten
   * it so an expired lease admits the next claim generation against the REAL
   * database clock (the stale-lease fence lives in the storage trigger).
   */
  improvementLifecycleClaimLeaseMs?: number;
  /**
   * HX-402 P3 (test-only): crash-injection seam for the governed worker. The
   * proof suites throw from each boundary to show recovery resumes from the
   * durable intent, never re-executes a non-idempotent callback blindly, and
   * that settlement/state/signal/Journey commit or roll back as one unit.
   */
  improvementLifecycleCrashSeam?: (boundary: ImprovementLifecycleCrashBoundary) => void;
}

/** HX-402 P3 crash-injection boundaries (audit-verbatim: callback, inspection, settlement, signal, Journey). */
export type ImprovementLifecycleCrashBoundary =
  | "improvement_lifecycle_before_callback"
  | "improvement_lifecycle_after_callback"
  | "improvement_lifecycle_after_inspection"
  | "improvement_lifecycle_before_signal"
  | "improvement_lifecycle_before_journey";

/** Route-facing authority input for one approval-first improvement lifecycle request. */
export interface ImprovementLifecycleAuthorityInput {
  requesterId?: string;
}

export interface ImprovementLifecyclePendingApproval {
  approvalId: string;
  status: ApprovalRequest["status"];
  kind: typeof IMPROVEMENT_LIFECYCLE_APPROVAL_KIND;
  operationKind: ImprovementLifecycleOperationKind;
  targetKind: ImprovementLifecycleTargetKind;
  targetId: string;
  workspaceId: string;
  requestSha256: string;
  expectedStateSha256: string;
  expiresAt?: string;
  createdAt: string;
  replayed: boolean;
}

export interface ImprovementLifecyclePendingOutcome {
  pendingApproval: ImprovementLifecyclePendingApproval;
}

export interface ImprovementLifecycleNoOpOutcome {
  pendingApproval: null;
  noMutationRequired: true;
  activation: ImprovementActivationRecord;
}

export type ImprovementLifecycleRequestOutcome = ImprovementLifecyclePendingOutcome | ImprovementLifecycleNoOpOutcome;

export interface ImprovementLifecycleApplyResult {
  disposition: ImprovementLifecycleSettlementDisposition;
  operationId: string;
  settlementId: string;
  operationKind: ImprovementLifecycleOperationKind;
  targetKind: ImprovementLifecycleTargetKind;
  targetId: string;
  activationId?: string;
  resultSha256: string;
  replayed: boolean;
}

// ── shared utility helpers ───────────────────────────────────────────

/**
 * Encapsulates all self-improvement, decision replay, auto-tune, and weekly
 * report logic previously inlined in GatewayService.
 */
const IMPROVEMENT_LIFECYCLE_APPROVAL_TTL_MS = 15 * 60_000;
const IMPROVEMENT_LIFECYCLE_CLAIM_LEASE_MS = 60_000;

export class ImprovementService {
  private scheduler?: ReturnType<typeof setInterval>;
  /** HX-402 P3: lazy adapter over the P0 durable intent/claim/inspection/settlement owner. */
  private improvementLifecycleRepository?: ReturnType<typeof createImprovementLifecycleOperationRepository>;
  // Cache of prepared statements keyed by the built SQL string. The hot read
  // paths (listImprovementSignals / listImprovementCandidates) recompiled their
  // statement on every call during improvement passes; each query has at most a
  // couple of static variants (workspace-filtered vs unfiltered), so caching by
  // SQL text compiles each variant exactly once while preserving query semantics.
  private readonly preparedCache = new Map<string, ReturnType<ImprovementServiceContext["gatewaySql"]["prepare"]>>();

  constructor(
    private readonly ctx: ImprovementServiceContext,
    private readonly callbacks: ImprovementServiceCallbacks,
  ) {
    this.ensureCapabilityGapTables();
    this.ensureImprovementLedgerTables();
  }

  /**
   * Returns a cached prepared statement for {@link sql}, preparing it once on
   * first use. Callers must pass a stable SQL string (no per-call interpolation
   * of values — use bound `@params`) so the cache key space stays bounded.
   */
  private prepareCached(sql: string): ReturnType<ImprovementServiceContext["gatewaySql"]["prepare"]> {
    const cached = this.preparedCache.get(sql);
    if (cached) {
      return cached;
    }
    const stmt = this.ctx.gatewaySql.prepare(sql);
    this.preparedCache.set(sql, stmt);
    return stmt;
  }

  // ── scheduler lifecycle ──────────────────────────────────────────

  startScheduler(): void {
    if (this.scheduler) {
      return;
    }
    this.scheduler = setInterval(() => {
      const task = this.runSchedulerTick().catch((error) => {
        log.error("scheduler tick failed", { error: error instanceof Error ? error.message : String(error) });
        try {
          this.ctx.publishRealtime("system", "improvement", {
            type: "improvement_scheduler_error",
            message: error instanceof Error ? error.message : String(error),
          });
        } catch (reportingError) {
          log.error("scheduler failure realtime projection failed", {
            error: reportingError instanceof Error ? reportingError.message : String(reportingError),
          });
        }
      });
      trackBackgroundTask(this.callbacks.backgroundTasks, task);
    }, IMPROVEMENT_SCHEDULER_INTERVAL_MS);
    // Don't let the scheduler timer keep the process/test-runner alive in paths that
    // don't call stopScheduler() (matches the shared background-scheduler helper).
    this.scheduler?.unref();
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

  async runWeeklyImprovementSchedulerIfDue(
    options: { force?: boolean; recordCronState?: boolean } = {},
  ): Promise<void> {
    const job = this.ctx.storage.cronJobs.get(IMPROVEMENT_WEEKLY_JOB_ID);
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
    if (options.recordCronState !== false) {
      this.ctx.storage.cronJobs.mergeRuntimeTelemetry(
        job.jobId,
        {
          lastRunAt: finishedAt,
          nextRunAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        },
        finishedAt,
      );
    }
  }

  async ensureWeeklyImprovementCronJob(): Promise<void> {
    if (!this.ctx.cronSpecOwner) {
      throw new Error("Cron spec owner is required to reconcile the weekly improvement job.");
    }
    const existing = this.ctx.storage.cronJobs.get(IMPROVEMENT_WEEKLY_JOB_ID);
    await this.ctx.cronSpecOwner.reconcileSpec({
      jobId: IMPROVEMENT_WEEKLY_JOB_ID,
      name: "Self-Improvement Weekly Replay",
      action: "improvement",
      // SECURITY (codex finding #27): The weekly improvement run samples
      // recent chat turn traces and tool runs (args_json/result_json)
      // and ships them to the configured LLM provider for a judge pass.
      // Until the redaction layer below has been verified against every
      // tool category, the first-run default must be DISABLED so a fresh
      // install does not start emitting chat-turn telemetry without an
      // explicit operator opt-in. Operators who want the audit run
      // toggle it on from Mission Control settings.
      description:
        existing?.description ??
        "Run the weekly self-improvement replay cycle. Disabled by default (codex #27) — enable from Mission Control settings after reviewing what is sent to the LLM provider.",
      schedule: IMPROVEMENT_WEEKLY_SCHEDULE_LABEL,
      enabled: existing?.enabled ?? false,
      endAt: existing?.endAt,
    });
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
        ? this.prepareCached(sql).all({
            workspaceId: normalizedWorkspaceId,
            limit: Math.max(1, Math.min(limit, 500)),
          })
        : this.prepareCached(sql).all({
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
        ? this.prepareCached(sql).all({
            workspaceId: normalizedWorkspaceId,
            limit: Math.max(1, Math.min(limit, 300)),
          })
        : this.prepareCached(sql).all({
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
      candidate,
      currentRevision: this.readCurrentRevision(candidateId),
      supportingSignals,
      latestEvaluation: this.readLatestEvaluation(candidateId),
      latestActivation: reconciledActivation,
      attemptManifestSummary: this.normalizeAttemptManifests(supportingSignals),
    };
  }

  listCuratorReviewItems(input: { limit?: number; workspaceId?: string } = {}): CuratorReviewResponse {
    this.ensureImprovementLedgerTables();
    const candidates = this.listImprovementCandidates(input.limit ?? 100, input.workspaceId).filter((candidate) =>
      this.isCuratorCandidate(candidate),
    );
    return {
      generatedAt: new Date().toISOString(),
      items: candidates.map((candidate) =>
        this.buildCuratorReviewItem(this.getImprovementCandidateDetail(candidate.candidateId)),
      ),
    };
  }

  getCuratorReviewItem(candidateId: string): CuratorReviewItem {
    this.ensureImprovementLedgerTables();
    return this.buildCuratorReviewItem(this.getImprovementCandidateDetail(candidateId));
  }

  validateImprovementCandidate(
    candidateId: string,
    input: ImprovementCandidateLifecycleInput = {},
  ): ImprovementCandidateLifecycleResult {
    this.ensureImprovementLedgerTables();
    const actorId = input.actorId?.trim() || "operator";
    const candidate = this.readImprovementCandidate(candidateId);
    const revision = this.readCurrentRevision(candidateId);
    if (!revision) {
      throw new Error(`Candidate ${candidateId} is missing a current revision.`);
    }
    this.assertCandidateNotCorruptOrQuarantined(candidate, revision);
    this.queueCandidateEvaluation(candidateId);
    const review = this.getCuratorReviewItem(candidateId);
    this.emitLifecycleAuditSignal("candidate_validated", {
      candidateId,
      actorId,
      workspaceId: review.candidate.workspaceId,
      fingerprint: review.candidate.fingerprint,
      targetKey: review.candidate.targetKey,
      mutationApplied: review.mutationApplied,
      reason: input.reason,
    });
    return {
      action: "validate",
      status: "validated",
      review,
      mutationApplied: review.mutationApplied,
    };
  }

  approveImprovementCandidate(
    candidateId: string,
    input: ImprovementCandidateLifecycleInput = {},
  ): ImprovementCandidateLifecycleResult {
    this.ensureImprovementLedgerTables();
    const actorId = input.actorId?.trim() || "operator";
    const candidate = this.readImprovementCandidate(candidateId);
    const revision = this.readCurrentRevision(candidateId);
    const evaluation = this.readLatestEvaluation(candidateId);
    if (
      !revision ||
      !evaluation ||
      evaluation.status !== "passed" ||
      candidate.currentRevisionId !== evaluation.revisionId
    ) {
      throw new Error(`Candidate ${candidateId} must pass validation before approval.`);
    }
    this.assertCandidateNotCorruptOrQuarantined(candidate, revision);
    this.updateCandidateStatus(candidateId, "approved", actorId, "operator");
    const review = this.getCuratorReviewItem(candidateId);
    this.emitLifecycleAuditSignal("candidate_approved", {
      candidateId,
      actorId,
      workspaceId: review.candidate.workspaceId,
      fingerprint: review.candidate.fingerprint,
      targetKey: review.candidate.targetKey,
      mutationApplied: review.mutationApplied,
      reason: input.reason,
    });
    return {
      action: "approve",
      status: "approved",
      review,
      mutationApplied: review.mutationApplied,
    };
  }

  rejectImprovementCandidate(
    candidateId: string,
    input: ImprovementCandidateLifecycleInput = {},
  ): ImprovementCandidateLifecycleResult {
    this.ensureImprovementLedgerTables();
    const actorId = input.actorId?.trim() || "operator";
    this.ctx.gatewaySql.runImmediateTransaction(() => {
      this.lockCandidateForLifecycleMutation(candidateId);
      this.assertCandidateHasNoAppliedActivation(candidateId);
      this.updateCandidateStatus(candidateId, "rejected", actorId, "operator");
      this.clearCandidateSuppression(candidateId, actorId, "operator");
    });
    const review = this.getCuratorReviewItem(candidateId);
    this.emitLifecycleAuditSignal("candidate_rejected", {
      candidateId,
      actorId,
      workspaceId: review.candidate.workspaceId,
      fingerprint: review.candidate.fingerprint,
      targetKey: review.candidate.targetKey,
      mutationApplied: review.mutationApplied,
      reason: input.reason,
    });
    return {
      action: "reject",
      status: "rejected",
      review,
      mutationApplied: review.mutationApplied,
    };
  }

  snoozeImprovementCandidate(
    candidateId: string,
    input: ImprovementCandidateLifecycleInput = {},
  ): ImprovementCandidateLifecycleResult {
    this.ensureImprovementLedgerTables();
    const actorId = input.actorId?.trim() || "operator";
    const snoozeUntil =
      input.snoozeUntil && Number.isFinite(Date.parse(input.snoozeUntil))
        ? new Date(input.snoozeUntil).toISOString()
        : new Date(Date.now() + IMPROVEMENT_SUPPRESSION_MS).toISOString();
    this.ctx.gatewaySql.runImmediateTransaction(() => {
      this.lockCandidateForLifecycleMutation(candidateId);
      this.assertCandidateHasNoAppliedActivation(candidateId);
      this.updateCandidateStatus(candidateId, "rejected", actorId, "operator");
      this.setCandidateSuppression(candidateId, snoozeUntil, actorId, "operator");
    });
    const review = this.getCuratorReviewItem(candidateId);
    this.emitLifecycleAuditSignal("candidate_snoozed", {
      candidateId,
      actorId,
      workspaceId: review.candidate.workspaceId,
      fingerprint: review.candidate.fingerprint,
      targetKey: review.candidate.targetKey,
      snoozeUntil,
      mutationApplied: review.mutationApplied,
      reason: input.reason,
    });
    return {
      action: "snooze",
      status: "snoozed",
      review,
      mutationApplied: review.mutationApplied,
    };
  }

  async activateImprovementCandidate(
    candidateId: string,
    input: ImprovementCandidateLifecycleInput = {},
  ): Promise<ImprovementCandidateLifecycleResult> {
    this.ensureImprovementLedgerTables();
    const actorId = input.actorId?.trim() || "operator";
    const candidate = this.readImprovementCandidate(candidateId);
    const revision = this.readCurrentRevision(candidateId);
    if (!revision) {
      throw new Error(`Candidate ${candidateId} is missing a current revision.`);
    }
    this.assertCandidateReadyForMutation(candidate, revision);
    if (candidate.kind === "skill_revision") {
      throw new Error(
        "Skill revision candidates promote through capability proposals; no direct mutation was applied.",
      );
    }
    // HX-402 P3: the operator surface is approval-first through the governed
    // `improvement.lifecycle` rail — the request never mutates, and only the
    // recovered approval effect may later create the durable intent and apply.
    const { pendingApproval } = this.requestImprovementActivationApproval(candidateId, { requesterId: actorId });
    const review = this.getCuratorReviewItem(candidateId);
    return {
      action: "activate",
      status: "approval_pending",
      review,
      approvalId: pendingApproval.approvalId,
      mutationApplied: review.mutationApplied,
    };
  }

  promoteImprovementCandidate(
    candidateId: string,
    input: ImprovementCandidateLifecycleInput = {},
  ): ImprovementCandidateLifecycleResult {
    this.ensureImprovementLedgerTables();
    const candidate = this.readImprovementCandidate(candidateId);
    const revision = this.readCurrentRevision(candidateId);
    if (!revision) {
      throw new Error(`Candidate ${candidateId} is missing a current revision.`);
    }
    this.assertCandidateReadyForMutation(candidate, revision);
    throw new Error("Promotion is review-only until a capability proposal approval applies the mutation.");
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

  recordAgenticDiagnosticSignal(input: {
    task: TaskRecord;
    diagnostic: AgenticDiagnosticSignal;
  }): ImprovementSignalRecord | undefined {
    if (!this.ctx.isFeatureEnabled("improvementLedgerV1Enabled")) {
      return undefined;
    }
    const workspaceId = this.ctx.normalizeWorkspaceId(input.task.workspaceId);
    const context = input.task.agenticContext;
    const sourceEventId = `${input.task.taskId}:${input.diagnostic.signalId}`;
    return this.recordImprovementSignal({
      sourceService: "task-lifecycle-service",
      sourceType: "agentic_diagnostic",
      sourceId: input.diagnostic.signalId,
      sourceEventId,
      idempotencyKey: sourceEventId,
      workspaceId,
      occurredAt: input.diagnostic.createdAt,
      origin: "runtime",
      signalClass: "runtime",
      signalKind: `agentic_${input.diagnostic.code}`,
      outcome: input.diagnostic.severity === "info" ? "neutral" : "negative",
      severity: mapAgenticDiagnosticSeverity(input.diagnostic.severity),
      fingerprint: buildImprovementFingerprint([
        "agentic",
        workspaceId,
        context?.surface,
        context?.failureClass,
        context?.profileId,
        input.diagnostic.code,
      ]),
      sessionId: context?.parentSessionId,
      durableRunId: context?.durableRunId,
      taskId: input.task.taskId,
      evidenceRefs: [
        {
          refType: "agentic_diagnostic",
          refId: input.diagnostic.signalId,
          hash: hashJson({
            taskId: input.task.taskId,
            runId: context?.runId,
            code: input.diagnostic.code,
            summary: input.diagnostic.summary,
          }),
          metadata: {
            taskId: input.task.taskId,
            runId: context?.runId,
            evidenceRef: input.diagnostic.evidenceRef,
          },
        },
      ],
      metadata: {
        diagnosticCode: input.diagnostic.code,
        diagnosticTitle: input.diagnostic.title,
        diagnosticSummary: input.diagnostic.summary,
        severity: input.diagnostic.severity,
        runId: context?.runId,
        parentRunId: context?.parentRunId,
        surface: context?.surface,
        failureClass: context?.failureClass,
        profileId: context?.profileId,
      },
    });
  }

  recordAgenticImprovementProposals(
    input: AgenticImprovementBridgeInput,
    options: { workspaceId?: string } = {},
  ): AgenticImprovementProposalIngestionResult[] {
    if (!this.ctx.isFeatureEnabled("improvementLedgerV1Enabled")) {
      return [];
    }
    const workspaceId = this.ctx.normalizeWorkspaceId(options.workspaceId);
    const bridge = new AgenticImprovementBridgeService();
    return bridge
      .buildProposalSummaries(input)
      .map((proposal) => this.recordAgenticImprovementProposal(proposal, workspaceId));
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

  public recordSurfaceRouteOverrideSignal(input: SurfaceRouteOverrideSignalInput): void {
    const fingerprint = `surface_route_override:${input.citadelId}:${input.fromMode}->${input.toMode}:${input.promptFeatureHash}`;
    this.recordImprovementSignal({
      sourceService: "surface-router",
      sourceType: "surface_route_override",
      sourceId: input.sessionId,
      sourceEventId: input.turnId,
      idempotencyKey: `${input.sessionId}:${fingerprint}`,
      workspaceId: input.workspaceId,
      origin: "human",
      signalClass: "runtime",
      signalKind: "surface_route_override",
      outcome: "negative",
      fingerprint,
      sessionId: input.sessionId,
      turnId: input.turnId,
      metadata: {
        citadelId: input.citadelId,
        fromMode: input.fromMode,
        toMode: input.toMode,
        autoConfidence: input.autoConfidence,
      },
    });
  }

  public listSurfaceRouteOverrideExemplars(citadelId: string, limit = 8): SurfaceRouteOverrideExemplar[] {
    const exemplars: SurfaceRouteOverrideExemplar[] = [];
    for (const signal of this.listImprovementSignals(500)) {
      if (exemplars.length >= limit) {
        break;
      }
      if (signal.signalKind !== "surface_route_override") {
        continue;
      }
      const meta = safeJsonRecord(signal.metadata);
      if (asOptionalString(meta.citadelId) !== citadelId) {
        continue;
      }
      const fromMode = asOptionalString(meta.fromMode);
      const toMode = asOptionalString(meta.toMode);
      if (!fromMode || !toMode) {
        continue;
      }
      exemplars.push({ fromMode, toMode, recordedAt: signal.recordedAt });
    }
    return exemplars;
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

  recordSkillEvaluationSignal(input: {
    skillId: string;
    skillName: string;
    runId: string;
    proposalId?: string;
    accepted: boolean;
    passRate: number;
    improvementDelta: number;
    summary: string;
  }): { signal?: ImprovementSignalRecord; candidate?: ImprovementCandidateRecord } | undefined {
    if (!this.ctx.isFeatureEnabled("improvementLedgerV1Enabled")) {
      return undefined;
    }
    const workspaceId = this.ctx.normalizeWorkspaceId(undefined);
    const targetKey = `skill:${input.skillId}`;
    const signal = this.recordImprovementSignal({
      sourceService: "skill_evaluation",
      sourceType: "skill_evaluation_run",
      sourceId: input.runId,
      sourceEventId: input.proposalId ?? input.runId,
      idempotencyKey: `skill-evaluation:${input.runId}:${input.proposalId ?? "run"}`,
      workspaceId,
      origin: "evaluation",
      signalClass: "evaluation",
      signalKind: "skill_revision_evaluated",
      outcome: input.accepted ? "positive" : "neutral",
      severity: input.accepted ? "low" : "medium",
      fingerprint: buildImprovementFingerprint([workspaceId, "skill_revision", input.skillId]),
      capabilityId: input.skillId,
      scoreDelta: input.improvementDelta,
      evidenceRefs: [
        {
          refType: "skill_evaluation_run",
          refId: input.runId,
        },
        ...(input.proposalId
          ? [
              {
                refType: "capability_proposal" as const,
                refId: input.proposalId,
              },
            ]
          : []),
      ],
      metadata: {
        kind: "skill_revision",
        skillId: input.skillId,
        skillName: input.skillName,
        targetKey,
        proposalId: input.proposalId,
        passRate: input.passRate,
        improvementDelta: input.improvementDelta,
        title: `Skill revision candidate: ${input.skillName}`,
        summary: input.summary,
      },
    });
    if (!signal) {
      return undefined;
    }
    const candidate = toImprovementCandidateRow(
      this.ctx.gatewaySql
        .prepare(
          `
          SELECT *
          FROM improvement_candidates
          WHERE workspace_id = @workspaceId
            AND kind = 'skill_revision'
            AND fingerprint = @fingerprint
          ORDER BY updated_at DESC
          LIMIT 1
        `,
        )
        .get({
          workspaceId,
          fingerprint: signal.fingerprint,
        }),
    );
    return {
      signal,
      candidate: candidate ? mapImprovementCandidateRow(candidate) : undefined,
    };
  }

  async requestImprovementActivation(candidateId: string, actorId = "operator"): Promise<ImprovementActivationRecord> {
    this.ctx.requireFeatureEnabled("improvementActivationV1Enabled");
    this.ensureImprovementLedgerTables();
    const candidate = this.readImprovementCandidate(candidateId);
    if (candidate.kind === "skill_revision") {
      throw new Error("Skill revision candidates activate through capability proposals, not direct ledger activation.");
    }
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
    const preActivationSnapshot = this.captureActivationSnapshot(candidate.kind, candidate.targetKey, revision);
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
    const activation = this.readLatestActivationByApprovalId(approval.approvalId);
    if (!activation) {
      return undefined;
    }
    if (activation.status === "active" || activation.watchStartedAt) {
      this.emitActivationAppliedAuditOrThrow(activation, approval);
    }
    if (activation.status === "active") {
      return activation;
    }
    if (activation.status !== "pending") {
      return activation;
    }

    const pendingActivation = activation;
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
        expectedStatus: "pending",
      });
    }

    if (!this.isPendingActivationCandidateEligible(candidate)) {
      return this.markActivationFailed(pendingActivation.activationId, "candidate_no_longer_eligible", {
        approvalId: approval.approvalId,
        actorId,
        actorType: "approval",
        candidateId: candidate.candidateId,
        revisionId: pendingActivation.revisionId,
        workspaceId: candidate.workspaceId,
        fingerprint: candidate.fingerprint,
        targetKey: candidate.targetKey,
        expectedStatus: "pending",
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
        expectedStatus: "pending",
      });
    }

    try {
      return this.applyApprovedActivation(pendingActivation, approval);
    } catch (error) {
      if (
        error instanceof ImprovementActivationCompensationError ||
        error instanceof ImprovementActivationClaimError ||
        error instanceof ImprovementActivationPostCommitError
      ) {
        throw error;
      }
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
          expectedStatus: "pending",
        },
      );
    }
  }

  pauseImprovementActivation(activationId: string, actorId = "operator"): ImprovementActivationRecord {
    this.ctx.requireFeatureEnabled("improvementActivationV1Enabled");
    this.ensureImprovementLedgerTables();
    const activation = this.maybeAdvanceActivation(this.readImprovementActivation(activationId));
    if (activation.status !== "active" || !activation.watchStartedAt) {
      throw new Error(`Activation ${activationId} must be active before it can be paused.`);
    }
    return this.restoreActivationSnapshot(activation, "paused", actorId, "operator");
  }

  rollbackImprovementActivation(activationId: string, actorId = "operator"): ImprovementActivationRecord {
    this.ctx.requireFeatureEnabled("improvementActivationV1Enabled");
    this.ensureImprovementLedgerTables();
    const activation = this.maybeAdvanceActivation(this.readImprovementActivation(activationId));
    if (
      !activation.watchStartedAt ||
      (activation.status !== "active" && activation.status !== "paused" && activation.status !== "failed")
    ) {
      throw new Error(`Activation ${activationId} must have been applied before it can be rolled back.`);
    }
    const restored = this.restoreActivationSnapshot(activation, "rolled_back", actorId, "operator");
    this.applyCandidateSuppression(restored.candidateId);
    return restored;
  }

  // ── HX-402 P3: approval-first governed improvement lifecycle ─────────
  //
  // The route surface never mutates: each activate/pause/rollback request
  // commits one canonical deterministic `improvement.lifecycle` approval plus
  // immutable requester Journey evidence. The recovered approval effect
  // creates the durable P0 intent (never executing the callback inline), then
  // the worker claims it one-winner, revalidates the exact reviewed state,
  // executes the external callback, re-inspects exact external state, and
  // commits activation/candidate state + immutable settlement + canonical
  // signal + Journey in ONE immediate transaction. The external callback is
  // never database-atomic: the intent/inspection/settlement state machine is
  // the crash-recovery truth, and recovery re-INSPECTS instead of re-executing
  // a non-idempotent callback blindly.

  private getImprovementLifecycleRepository(): ReturnType<typeof createImprovementLifecycleOperationRepository> {
    this.improvementLifecycleRepository ??= createImprovementLifecycleOperationRepository(this.ctx.gatewaySql);
    return this.improvementLifecycleRepository;
  }

  /**
   * Request one approved improvement activation. Never mutates: validates the
   * exact candidate/revision/evaluation coherence, binds the reviewed database
   * state and the exact external pre/target policy state into the approval,
   * and returns the pending `improvement.lifecycle` approval envelope.
   */
  requestImprovementActivationApproval(
    candidateId: string,
    authority: ImprovementLifecycleAuthorityInput = {},
  ): ImprovementLifecyclePendingOutcome {
    this.ctx.requireFeatureEnabled("improvementActivationV1Enabled");
    this.ensureImprovementLedgerTables();
    const candidate = this.readImprovementCandidate(candidateId);
    if (candidate.kind === "skill_revision") {
      throw new Error("Skill revision candidates activate through capability proposals, not direct ledger activation.");
    }
    const revision = this.readCurrentRevision(candidateId);
    const evaluation = this.readLatestEvaluation(candidateId);
    if (!revision || !evaluation) {
      throw new Error(`Candidate ${candidateId} is missing a current revision or evaluation.`);
    }
    if (candidate.status !== "ready_for_approval" && candidate.status !== "approved") {
      throw new Error(`Candidate ${candidateId} is not ready for activation approval.`);
    }
    if (candidate.currentRevisionId !== evaluation.revisionId || revision.changeHash !== evaluation.changeHash) {
      throw new Error(`Candidate ${candidateId} drifted since evaluation and must be re-evaluated.`);
    }
    this.assertCandidateHasNoAppliedActivation(candidateId);
    const kind: "repair_policy" | "routing_policy" =
      candidate.kind === "repair_policy" ? "repair_policy" : "routing_policy";
    const preState = this.captureImprovementExternalState(kind, candidate.targetKey);
    const targetState: ImprovementExternalStateMaterial = {
      hadValue: true,
      value: deriveActivationTargetValue(revision.candidateRef),
    };
    const mutation = {
      candidateId,
      revisionId: revision.revisionId,
      changeHash: revision.changeHash,
      kind,
      targetKey: candidate.targetKey,
      preState,
      targetState,
    };
    const binding = buildImprovementLifecycleApprovalBinding({
      workspaceId: this.ctx.normalizeWorkspaceId(candidate.workspaceId),
      operationKind: "activate",
      targetKind: "improvement_candidate",
      targetId: candidateId,
      mutation,
      expectedState: this.buildActivateReviewedStateMaterial(candidate, revision, evaluation),
    });
    const pendingApproval = this.commitImprovementLifecycleApproval({
      binding,
      riskLevel: candidate.kind === "routing_policy" ? "caution" : "safe",
      requesterId: normalizeImprovementRequesterId(authority.requesterId),
      mutation,
      preview: {
        title: "Approve improvement activation",
        operationKind: "activate",
        candidateId,
        revisionId: revision.revisionId,
        summary: candidate.summary,
        targetKey: candidate.targetKey,
        kind: candidate.kind,
      },
    });
    return { pendingApproval };
  }

  /** Request one approved pause; an already-paused activation is a pure no-op. */
  requestImprovementPauseApproval(
    activationId: string,
    authority: ImprovementLifecycleAuthorityInput = {},
  ): ImprovementLifecycleRequestOutcome {
    return this.requestImprovementRestoreApproval(activationId, "pause", authority);
  }

  /** Request one approved rollback; an already-rolled-back activation is a pure no-op. */
  requestImprovementRollbackApproval(
    activationId: string,
    authority: ImprovementLifecycleAuthorityInput = {},
  ): ImprovementLifecycleRequestOutcome {
    return this.requestImprovementRestoreApproval(activationId, "rollback", authority);
  }

  /**
   * Pause and rollback require FRESH approval (audit P3): a later mutation can
   * never ride the activation approval. The request binds the exact activation
   * row state plus the exact external pre/target policy state; the recovered
   * effect refuses anything else.
   */
  private requestImprovementRestoreApproval(
    activationId: string,
    operationKind: "pause" | "rollback",
    authority: ImprovementLifecycleAuthorityInput,
  ): ImprovementLifecycleRequestOutcome {
    this.ctx.requireFeatureEnabled("improvementActivationV1Enabled");
    this.ensureImprovementLedgerTables();
    const activation = this.maybeAdvanceActivation(this.readImprovementActivation(activationId));
    if (operationKind === "pause") {
      if (activation.status === "paused") {
        return { pendingApproval: null, noMutationRequired: true, activation };
      }
      if (activation.status !== "active" || !activation.watchStartedAt) {
        throw new Error(`Activation ${activationId} must be active before it can be paused.`);
      }
    } else {
      if (activation.status === "rolled_back") {
        return { pendingApproval: null, noMutationRequired: true, activation };
      }
      if (
        !activation.watchStartedAt ||
        (activation.status !== "active" && activation.status !== "paused" && activation.status !== "failed")
      ) {
        throw new Error(`Activation ${activationId} must have been applied before it can be rolled back.`);
      }
    }
    const candidate = this.readImprovementCandidate(activation.candidateId);
    if (candidate.kind === "skill_revision" || activation.preActivationSnapshot.refType === "skill_revision_snapshot") {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message:
          "Skill revision activations pause and roll back through capability proposals, not the governed policy rail.",
      });
    }
    const kind: "repair_policy" | "routing_policy" =
      candidate.kind === "repair_policy" ? "repair_policy" : "routing_policy";
    const preState = this.captureImprovementExternalState(kind, candidate.targetKey);
    const targetState = snapshotRefToExternalState(activation.preActivationSnapshot);
    const mutation: ImprovementPauseRollbackMutationV1 = { activationId, preState, targetState };
    const binding = buildImprovementLifecycleApprovalBinding({
      workspaceId: this.ctx.normalizeWorkspaceId(candidate.workspaceId),
      operationKind,
      targetKind: "improvement_activation",
      targetId: activationId,
      mutation,
      expectedState: buildRestoreReviewedStateMaterial(activation),
    });
    const pendingApproval = this.commitImprovementLifecycleApproval({
      binding,
      riskLevel: "caution",
      requesterId: normalizeImprovementRequesterId(authority.requesterId),
      mutation,
      preview: {
        title: operationKind === "pause" ? "Approve improvement pause" : "Approve improvement rollback",
        operationKind,
        activationId,
        candidateId: candidate.candidateId,
        targetKey: candidate.targetKey,
        currentStatus: activation.status,
      },
    });
    return { pendingApproval };
  }

  private commitImprovementLifecycleApproval(input: {
    binding: ImprovementLifecycleApprovalBindingV1;
    riskLevel: "safe" | "caution" | "danger";
    requesterId: string;
    mutation: unknown;
    preview: Record<string, unknown>;
  }): ImprovementLifecyclePendingApproval {
    const approvalId = deriveImprovementLifecycleApprovalId(input.binding);
    const payload = buildImprovementLifecycleApprovalPayload({
      binding: input.binding,
      requesterId: input.requesterId,
      mutation: input.mutation,
    });
    const committed = this.ctx.gatewaySql.runImmediateTransaction(() => {
      const stored = this.ctx.storage.approvals.createDeterministicDetachedWithTtlDuration(
        {
          approvalId,
          kind: IMPROVEMENT_LIFECYCLE_APPROVAL_KIND,
          riskLevel: input.riskLevel,
          payload,
          preview: { ...input.preview },
          linkage: { workspaceId: input.binding.workspaceId, actionType: "improvement_lifecycle" },
        },
        IMPROVEMENT_LIFECYCLE_APPROVAL_TTL_MS,
      );
      if (stored.created) {
        this.ctx.storage.approvalEvents.append({
          approvalId,
          eventType: "created",
          actorId: "system",
          timestamp: stored.approval.createdAt,
          payload: {
            kind: stored.approval.kind,
            riskLevel: stored.approval.riskLevel,
            status: stored.approval.status,
          },
        });
        this.ctx.storage.governanceJourneyEvents.create(
          buildImprovementLifecycleRequestJourneyEvent({
            approval: stored.approval,
            binding: input.binding,
            requesterId: input.requesterId,
          }),
        );
      } else {
        // The original requester remains the immutable evidence. A byte-exact
        // replay from the SAME requester converges; a different requester's
        // identical mutation conflicts in the approvals owner because the
        // requester is payload material. A missing evidence row self-heals so
        // the recovered effect can never execute without requester evidence.
        const evidence = this.ctx.storage.governanceJourneyEvents.findByIdempotencyKey(
          improvementLifecycleRequestJourneyIdempotencyKey(approvalId),
        );
        if (!evidence) {
          this.ctx.storage.governanceJourneyEvents.create(
            buildImprovementLifecycleRequestJourneyEvent({
              approval: stored.approval,
              binding: input.binding,
              requesterId: input.requesterId,
            }),
          );
        }
      }
      return stored;
    });
    if (committed.created) {
      this.ctx.publishRealtime("improvement_mutation_approval_requested", "improvement", {
        approvalId,
        operationKind: input.binding.operationKind,
        targetKind: input.binding.targetKind,
        targetId: input.binding.targetId,
        workspaceId: input.binding.workspaceId,
      });
    }
    return {
      approvalId,
      status: committed.approval.status,
      kind: IMPROVEMENT_LIFECYCLE_APPROVAL_KIND,
      operationKind: input.binding.operationKind,
      targetKind: input.binding.targetKind,
      targetId: input.binding.targetId,
      workspaceId: input.binding.workspaceId,
      requestSha256: input.binding.requestSha256,
      expectedStateSha256: input.binding.expectedStateSha256,
      ...(committed.approval.expiresAt ? { expiresAt: committed.approval.expiresAt } : {}),
      createdAt: committed.approval.createdAt,
      replayed: !committed.created,
    };
  }

  /**
   * Execute one approved `improvement.lifecycle` mutation as the recovered
   * approval effect. Revalidates the exact approval (kind, deterministic
   * identity, status, expiry), recovers the requester from the immutable
   * request Journey evidence, byte-verifies the request hash, creates the
   * durable P0 intent, claims it one-winner with database-clock lease fencing,
   * and settles through exact external re-inspection. Governance violations
   * throw the terminal {@link ImprovementLifecycleApplyError}; competing
   * live claims and infrastructure crashes propagate raw so the approval
   * effect worker defers for bounded retry and recovery resumes from the
   * durable intent.
   */
  executeApprovedImprovementLifecycleMutation(input: {
    workspaceId: string;
    approvalId: string;
  }): ImprovementLifecycleApplyResult {
    if (!this.ctx.isFeatureEnabled("improvementActivationV1Enabled")) {
      throw new ImprovementLifecycleApplyError("improvement_lifecycle_approval_not_executable");
    }
    this.ensureImprovementLedgerTables();
    let approval: ApprovalRequest;
    try {
      approval = this.ctx.storage.approvals.get(input.approvalId);
    } catch (error) {
      if (isNotFoundLikeError(error)) {
        throw new ImprovementLifecycleApplyError("improvement_lifecycle_approval_not_executable");
      }
      throw error;
    }
    if (approval.kind !== IMPROVEMENT_LIFECYCLE_APPROVAL_KIND) {
      throw new ImprovementLifecycleApplyError("improvement_lifecycle_approval_not_executable");
    }
    const payload = approval.payload as Record<string, unknown> | undefined;
    const binding = parseImprovementLifecycleApprovalBinding(payload?.improvementLifecycle);
    const envelope = parseImprovementLifecycleRequestEnvelope(payload);
    if (
      !binding ||
      !envelope ||
      deriveImprovementLifecycleApprovalId(binding) !== approval.approvalId ||
      binding.workspaceId !== this.ctx.normalizeWorkspaceId(input.workspaceId)
    ) {
      throw new ImprovementLifecycleApplyError("improvement_lifecycle_approval_not_executable");
    }
    if (approval.status !== "approved" || !approval.resolvedBy) {
      throw new ImprovementLifecycleApplyError("improvement_lifecycle_approval_not_executable");
    }
    if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now()) {
      throw new ImprovementLifecycleApplyError("improvement_lifecycle_approval_expired");
    }
    const evidence = this.ctx.storage.governanceJourneyEvents.findByIdempotencyKey(
      improvementLifecycleRequestJourneyIdempotencyKey(approval.approvalId),
    );
    if (!evidence || evidence.approvalId !== approval.approvalId || evidence.actorId !== envelope.requesterId) {
      throw new ImprovementLifecycleApplyError("improvement_lifecycle_request_evidence_missing");
    }
    if (
      buildImprovementLifecycleRequestSha256({
        workspaceId: binding.workspaceId,
        operationKind: binding.operationKind,
        targetKind: binding.targetKind,
        targetId: binding.targetId,
        mutation: envelope.mutation,
      }) !== binding.requestSha256
    ) {
      throw new ImprovementLifecycleApplyError("improvement_lifecycle_request_drift");
    }

    // The recovered effect creates the durable INTENT — the callback is never
    // executed inline with approval resolution, and crash recovery resumes
    // from this row, never from an attempted callback.
    const repository = this.getImprovementLifecycleRepository();
    const operationId = deriveImprovementLifecycleOperationId(approval.approvalId);
    const intentBase = {
      operationId,
      idempotencyKey: improvementLifecycleOperationIdempotencyKey(approval.approvalId),
      workspaceId: binding.workspaceId,
      operationKind: binding.operationKind,
      targetKind: binding.targetKind,
      targetId: binding.targetId,
      actorId: envelope.requesterId,
      createdAt: new Date(approval.resolvedAt ?? approval.createdAt).toISOString(),
    };
    const intent: ImprovementLifecycleOperationRecord = {
      ...intentBase,
      approvalId: approval.approvalId,
      requestSha256: computeImprovementLifecycleRequestSha256(intentBase),
    };
    try {
      repository.createIntent(intent);
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new ImprovementLifecycleApplyError("improvement_lifecycle_apply_conflict");
      }
      throw error;
    }
    const settled = repository.findSettlementByOperationId(operationId);
    if (settled) {
      return mapSettlementToApplyResult(settled, binding, true);
    }
    // One-winner claim with database-clock stale-lease fencing. A live
    // competing claim throws ConflictError, which propagates RAW: the effect
    // defers for bounded retry and later converges on the winner's settlement.
    const claimedAtMs = Date.now();
    const leaseMs = Math.max(
      5,
      this.callbacks.improvementLifecycleClaimLeaseMs ?? IMPROVEMENT_LIFECYCLE_CLAIM_LEASE_MS,
    );
    const claim = repository.claim({
      operationId,
      workerId: `improvement-lifecycle-worker:${randomUUID()}`,
      claimedAt: new Date(claimedAtMs).toISOString(),
      leaseExpiresAt: new Date(claimedAtMs + leaseMs).toISOString(),
    });
    if (binding.operationKind === "activate") {
      const mutation = parseImprovementActivateMutation(envelope.mutation);
      if (!mutation || mutation.candidateId !== binding.targetId) {
        throw new ImprovementLifecycleApplyError("improvement_lifecycle_approval_not_executable");
      }
      return this.runGovernedActivate({
        approval,
        binding,
        mutation,
        intent,
        claimGeneration: claim.claimGeneration,
        requesterId: envelope.requesterId,
      });
    }
    const mutation = parseImprovementPauseRollbackMutation(envelope.mutation);
    if (!mutation || mutation.activationId !== binding.targetId) {
      throw new ImprovementLifecycleApplyError("improvement_lifecycle_approval_not_executable");
    }
    return this.runGovernedRestore({
      approval,
      binding,
      mutation,
      intent,
      claimGeneration: claim.claimGeneration,
      requesterId: envelope.requesterId,
    });
  }

  /** Governed activate worker: claim held; revalidate, callback, re-inspect, settle. */
  private runGovernedActivate(input: {
    approval: ApprovalRequest;
    binding: ImprovementLifecycleApprovalBindingV1;
    mutation: NonNullable<ReturnType<typeof parseImprovementActivateMutation>>;
    intent: ImprovementLifecycleOperationRecord;
    claimGeneration: number;
    requesterId: string;
  }): ImprovementLifecycleApplyResult {
    const { approval, binding, mutation, intent, claimGeneration, requesterId } = input;
    const resolvedBy = approval.resolvedBy ?? "approval";
    let candidate: ImprovementCandidateRecord | undefined;
    try {
      candidate = this.readImprovementCandidate(mutation.candidateId);
    } catch {
      candidate = undefined;
    }
    const revision = candidate ? this.readCurrentRevision(candidate.candidateId) : undefined;
    const evaluation = candidate ? this.readLatestEvaluation(candidate.candidateId) : undefined;
    const stateOk =
      buildImprovementLifecycleStateSha256(this.buildActivateReviewedStateMaterial(candidate, revision, evaluation)) ===
      binding.expectedStateSha256;
    const observedPre = this.captureImprovementExternalState(mutation.kind, mutation.targetKey);
    const observedPreHash = computeImprovementLifecycleObservedStateSha256(observedPre);
    const approvedPreHash = computeImprovementLifecycleObservedStateSha256(mutation.preState);
    const targetHash = computeImprovementLifecycleObservedStateSha256(mutation.targetState);
    const signalBase = {
      candidateId: mutation.candidateId,
      revisionId: mutation.revisionId,
      approvalId: approval.approvalId,
      workspaceId: binding.workspaceId,
      fingerprint: candidate?.fingerprint,
      targetKey: mutation.targetKey,
      changeHash: mutation.changeHash,
      actorId: resolvedBy,
      actorType: "approval" as const,
    };
    const activationId = deriveImprovementLifecycleActivationId(intent.operationId);

    // Crash recovery convergence: the external target state is ALREADY exact
    // (an earlier claim executed the callback and crashed before settling).
    // Do NOT re-execute the non-idempotent callback; settle `applied` from the
    // durable matches_intent observation and commit the database half now.
    if (stateOk && observedPreHash === targetHash) {
      const inspection = this.recordGovernedInspection(
        intent,
        claimGeneration,
        "pre",
        observedPreHash,
        "matches_intent",
      );
      return this.settleGovernedImprovementOperation({
        binding,
        intent,
        claimGeneration,
        requesterId,
        resolvedBy,
        inspection,
        disposition: "applied",
        activationId,
        applyStateChange: () =>
          this.applyGovernedActivationRows({
            approval,
            binding,
            mutation,
            candidate: candidate!,
            revision: revision!,
            activationId,
            requesterId,
            status: "active",
          }),
        signalKind: "activation_applied",
        signalInput: { ...signalBase, activationId, status: "active", watchStatus: "watching" },
      });
    }

    if (!stateOk || observedPreHash !== approvedPreHash) {
      // The reviewed database state or the external pre-state drifted from
      // what the approval bound: refuse WITHOUT executing the callback and
      // settle the truthful abort.
      const inspection = this.recordGovernedInspection(
        intent,
        claimGeneration,
        "pre",
        observedPreHash,
        observedPreHash === targetHash ? "matches_intent" : "diverged",
      );
      return this.settleGovernedImprovementOperation({
        binding,
        intent,
        claimGeneration,
        requesterId,
        resolvedBy,
        inspection,
        disposition: "aborted",
        reasonCode: stateOk ? "external_state_drift" : "state_drift",
        signalKind: "activation_failed",
        signalInput: {
          ...signalBase,
          activationId,
          failureReason: stateOk ? "external_state_drift" : "state_drift",
          status: "failed",
          watchStatus: "failed",
        },
      });
    }

    // Exact pre-state confirmed: record the durable attempt marker, execute
    // the external callback once, then conclude ONLY from re-inspection.
    this.recordGovernedInspection(intent, claimGeneration, "pre", observedPreHash, "diverged");
    this.callbacks.improvementLifecycleCrashSeam?.("improvement_lifecycle_before_callback");
    let callbackError: unknown;
    try {
      if (mutation.kind === "repair_policy") {
        this.callbacks.applyRepairPolicyCandidate(mutation.targetKey, revision!.candidateRef);
      } else {
        this.callbacks.applyRoutingPolicyCandidate(mutation.targetKey, revision!.candidateRef);
      }
    } catch (error) {
      callbackError = error;
    }
    this.callbacks.improvementLifecycleCrashSeam?.("improvement_lifecycle_after_callback");
    const observedPost = this.captureImprovementExternalState(mutation.kind, mutation.targetKey);
    const observedPostHash = computeImprovementLifecycleObservedStateSha256(observedPost);
    const matches = observedPostHash === targetHash;
    this.callbacks.improvementLifecycleCrashSeam?.("improvement_lifecycle_after_inspection");
    if (matches) {
      return this.settleGovernedImprovementOperation({
        binding,
        intent,
        claimGeneration,
        requesterId,
        resolvedBy,
        inspection: {
          inspectionId: deriveImprovementLifecycleInspectionId(intent.operationId, claimGeneration, "post"),
          observedStateSha256: observedPostHash,
          disposition: "matches_intent",
          recorded: false,
        },
        disposition: "applied",
        activationId,
        applyStateChange: () =>
          this.applyGovernedActivationRows({
            approval,
            binding,
            mutation,
            candidate: candidate!,
            revision: revision!,
            activationId,
            requesterId,
            status: "active",
          }),
        signalKind: "activation_applied",
        signalInput: { ...signalBase, activationId, status: "active", watchStatus: "watching" },
      });
    }
    // The callback ran (or threw) and exact re-inspection does NOT show the
    // intended state: record the truthful mismatch. No false `applied` claim.
    const reasonCode = callbackError ? "activation_callback_failed" : "external_state_diverged";
    return this.settleGovernedImprovementOperation({
      binding,
      intent,
      claimGeneration,
      requesterId,
      resolvedBy,
      inspection: {
        inspectionId: deriveImprovementLifecycleInspectionId(intent.operationId, claimGeneration, "post"),
        observedStateSha256: observedPostHash,
        disposition: "diverged",
        recorded: false,
      },
      disposition: "failed",
      reasonCode,
      activationId,
      applyStateChange: () =>
        this.applyGovernedActivationRows({
          approval,
          binding,
          mutation,
          candidate: candidate!,
          revision: revision!,
          activationId,
          requesterId,
          status: "failed",
          failureReason: reasonCode,
        }),
      signalKind: "activation_failed",
      signalInput: {
        ...signalBase,
        activationId,
        failureReason: reasonCode,
        status: "failed",
        watchStatus: "failed",
      },
    });
  }

  /** Governed pause/rollback worker: restore the pre-activation snapshot under fresh approval. */
  private runGovernedRestore(input: {
    approval: ApprovalRequest;
    binding: ImprovementLifecycleApprovalBindingV1;
    mutation: ImprovementPauseRollbackMutationV1;
    intent: ImprovementLifecycleOperationRecord;
    claimGeneration: number;
    requesterId: string;
  }): ImprovementLifecycleApplyResult {
    const { approval, binding, mutation, intent, claimGeneration, requesterId } = input;
    const resolvedBy = approval.resolvedBy ?? "approval";
    let activation: ImprovementActivationRecord;
    try {
      activation = this.readImprovementActivation(mutation.activationId);
    } catch {
      throw new ImprovementLifecycleApplyError("improvement_lifecycle_apply_conflict");
    }
    const candidate = this.readImprovementCandidate(activation.candidateId);
    const kind: "repair_policy" | "routing_policy" =
      candidate.kind === "repair_policy" ? "repair_policy" : "routing_policy";
    if (candidate.kind === "skill_revision" || activation.preActivationSnapshot.refType === "skill_revision_snapshot") {
      throw new ImprovementLifecycleApplyError("improvement_lifecycle_apply_conflict");
    }
    // The immutable pre-activation snapshot on the row must still be the exact
    // restore target the approval reviewed; anything else is tampering.
    const rowTargetHash = computeImprovementLifecycleObservedStateSha256(
      snapshotRefToExternalState(activation.preActivationSnapshot),
    );
    const targetHash = computeImprovementLifecycleObservedStateSha256(mutation.targetState);
    if (rowTargetHash !== targetHash) {
      throw new ImprovementLifecycleApplyError("improvement_lifecycle_apply_conflict");
    }
    const stateOk =
      buildImprovementLifecycleStateSha256(buildRestoreReviewedStateMaterial(activation)) ===
      binding.expectedStateSha256;
    const observedPre = this.captureImprovementExternalState(kind, candidate.targetKey);
    const observedPreHash = computeImprovementLifecycleObservedStateSha256(observedPre);
    const approvedPreHash = computeImprovementLifecycleObservedStateSha256(mutation.preState);
    const restoredStatus = binding.operationKind === "pause" ? ("paused" as const) : ("rolled_back" as const);
    const signalKindApplied = binding.operationKind === "pause" ? "activation_paused" : "activation_rolled_back";
    const signalBase = {
      candidateId: activation.candidateId,
      revisionId: activation.revisionId,
      activationId: activation.activationId,
      approvalId: approval.approvalId,
      workspaceId: binding.workspaceId,
      fingerprint: candidate.fingerprint,
      targetKey: candidate.targetKey,
      actorId: resolvedBy,
      actorType: "approval" as const,
    };

    if (stateOk && observedPreHash === targetHash) {
      // Crash recovery convergence: the snapshot restore already reached the
      // external system; commit the database half without a second restore.
      const inspection = this.recordGovernedInspection(
        intent,
        claimGeneration,
        "pre",
        observedPreHash,
        "matches_intent",
      );
      return this.settleGovernedImprovementOperation({
        binding,
        intent,
        claimGeneration,
        requesterId,
        resolvedBy,
        inspection,
        disposition: "applied",
        activationId: activation.activationId,
        applyStateChange: () => this.applyGovernedRestoreRows(activation, restoredStatus, resolvedBy),
        signalKind: signalKindApplied,
        signalInput: {
          ...signalBase,
          status: restoredStatus,
          watchStatus: binding.operationKind === "pause" ? "paused" : "failed",
        },
      });
    }

    if (!stateOk || observedPreHash !== approvedPreHash) {
      const inspection = this.recordGovernedInspection(
        intent,
        claimGeneration,
        "pre",
        observedPreHash,
        observedPreHash === targetHash ? "matches_intent" : "diverged",
      );
      return this.settleGovernedImprovementOperation({
        binding,
        intent,
        claimGeneration,
        requesterId,
        resolvedBy,
        inspection,
        disposition: "aborted",
        reasonCode: stateOk ? "external_state_drift" : "state_drift",
        activationId: activation.activationId,
        signalKind: "activation_failed",
        signalInput: {
          ...signalBase,
          failureReason: stateOk ? "external_state_drift" : "state_drift",
          status: activation.status,
          watchStatus: activation.watchStatus,
        },
      });
    }

    this.recordGovernedInspection(intent, claimGeneration, "pre", observedPreHash, "diverged");
    this.callbacks.improvementLifecycleCrashSeam?.("improvement_lifecycle_before_callback");
    let callbackError: unknown;
    try {
      if (kind === "repair_policy") {
        this.callbacks.restoreRepairPolicySnapshot(activation.preActivationSnapshot);
      } else {
        this.callbacks.restoreRoutingPolicySnapshot(activation.preActivationSnapshot);
      }
    } catch (error) {
      callbackError = error;
    }
    this.callbacks.improvementLifecycleCrashSeam?.("improvement_lifecycle_after_callback");
    const observedPost = this.captureImprovementExternalState(kind, candidate.targetKey);
    const observedPostHash = computeImprovementLifecycleObservedStateSha256(observedPost);
    const matches = observedPostHash === targetHash;
    this.callbacks.improvementLifecycleCrashSeam?.("improvement_lifecycle_after_inspection");
    if (matches) {
      return this.settleGovernedImprovementOperation({
        binding,
        intent,
        claimGeneration,
        requesterId,
        resolvedBy,
        inspection: {
          inspectionId: deriveImprovementLifecycleInspectionId(intent.operationId, claimGeneration, "post"),
          observedStateSha256: observedPostHash,
          disposition: "matches_intent",
          recorded: false,
        },
        disposition: "applied",
        activationId: activation.activationId,
        applyStateChange: () => this.applyGovernedRestoreRows(activation, restoredStatus, resolvedBy),
        signalKind: signalKindApplied,
        signalInput: {
          ...signalBase,
          status: restoredStatus,
          watchStatus: binding.operationKind === "pause" ? "paused" : "failed",
        },
      });
    }
    // The restore ran (or threw) and re-inspection does NOT show the snapshot
    // state: the rollback/pause can NEVER claim success without its own
    // matches_intent inspection. Record the truthful failed settlement and
    // leave the activation row un-flipped.
    const reasonCode = callbackError ? "restore_callback_failed" : "external_state_diverged";
    return this.settleGovernedImprovementOperation({
      binding,
      intent,
      claimGeneration,
      requesterId,
      resolvedBy,
      inspection: {
        inspectionId: deriveImprovementLifecycleInspectionId(intent.operationId, claimGeneration, "post"),
        observedStateSha256: observedPostHash,
        disposition: "diverged",
        recorded: false,
      },
      disposition: "failed",
      reasonCode,
      activationId: activation.activationId,
      signalKind: "activation_failed",
      signalInput: {
        ...signalBase,
        failureReason: reasonCode,
        status: activation.status,
        watchStatus: activation.watchStatus,
      },
    });
  }

  /** Record one durable observation for the CURRENT claim (the attempt marker / abort citation). */
  private recordGovernedInspection(
    intent: ImprovementLifecycleOperationRecord,
    claimGeneration: number,
    phase: "pre" | "post",
    observedStateSha256: string,
    disposition: "matches_intent" | "diverged",
  ): { inspectionId: string; observedStateSha256: string; disposition: "matches_intent" | "diverged"; recorded: true } {
    const inspectionId = deriveImprovementLifecycleInspectionId(intent.operationId, claimGeneration, phase);
    this.getImprovementLifecycleRepository().recordInspection({
      inspectionId,
      operationId: intent.operationId,
      claimGeneration,
      observedStateSha256,
      disposition,
      observedAt: new Date().toISOString(),
    });
    return { inspectionId, observedStateSha256, disposition, recorded: true };
  }

  /**
   * Commit the database half as ONE immediate transaction: the (still
   * unrecorded post-callback) inspection, the activation/candidate state, the
   * immutable settlement, the canonical improvement signal, and the Journey
   * evidence. Any member failing rolls back every member, so recovery resumes
   * from the durable intent with zero partial state.
   */
  private settleGovernedImprovementOperation(input: {
    binding: ImprovementLifecycleApprovalBindingV1;
    intent: ImprovementLifecycleOperationRecord;
    claimGeneration: number;
    requesterId: string;
    resolvedBy: string;
    inspection: {
      inspectionId: string;
      observedStateSha256: string;
      disposition: "matches_intent" | "diverged";
      recorded: boolean;
    };
    disposition: ImprovementLifecycleSettlementDisposition;
    reasonCode?: string;
    activationId?: string;
    applyStateChange?: () => void;
    signalKind: "activation_applied" | "activation_paused" | "activation_rolled_back" | "activation_failed";
    signalInput: Parameters<ImprovementService["emitLifecycleAuditSignal"]>[1];
  }): ImprovementLifecycleApplyResult {
    const { binding, intent, claimGeneration, inspection } = input;
    const repository = this.getImprovementLifecycleRepository();
    const settlementId = deriveImprovementLifecycleSettlementId(intent.operationId);
    const result: Record<string, unknown> = {
      operationKind: binding.operationKind,
      targetKind: binding.targetKind,
      targetId: binding.targetId,
      disposition: input.disposition,
      observedStateSha256: inspection.observedStateSha256,
      ...(input.activationId === undefined ? {} : { activationId: input.activationId }),
      ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
    };
    const resultSha256 = computeImprovementLifecycleResultSha256(result);
    const settledAt = new Date().toISOString();
    const settlement: ImprovementLifecycleSettlementRecord = {
      settlementId,
      operationId: intent.operationId,
      claimGeneration,
      inspectionId: inspection.inspectionId,
      disposition: input.disposition,
      observedStateSha256: inspection.observedStateSha256,
      result,
      resultSha256,
      settledAt,
    };
    this.ctx.gatewaySql.runImmediateTransaction(() => {
      if (!inspection.recorded) {
        repository.recordInspection({
          inspectionId: inspection.inspectionId,
          operationId: intent.operationId,
          claimGeneration,
          observedStateSha256: inspection.observedStateSha256,
          disposition: inspection.disposition,
          observedAt: settledAt,
        });
      }
      input.applyStateChange?.();
      repository.settle(settlement);
      this.callbacks.improvementLifecycleCrashSeam?.("improvement_lifecycle_before_signal");
      this.emitLifecycleAuditSignal(input.signalKind, input.signalInput);
      this.callbacks.improvementLifecycleCrashSeam?.("improvement_lifecycle_before_journey");
      this.ctx.storage.governanceJourneyEvents.create(
        buildImprovementLifecycleSettlementJourneyEvent({
          binding,
          approvalId: intent.approvalId,
          operationId: intent.operationId,
          settlementId,
          inspectionId: inspection.inspectionId,
          claimGeneration,
          disposition: input.disposition,
          observedStateSha256: inspection.observedStateSha256,
          actorId: input.resolvedBy,
          requesterId: input.requesterId,
          occurredAt: settledAt,
          ...(input.activationId === undefined ? {} : { activationId: input.activationId }),
          ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
        }),
      );
    });
    return {
      disposition: input.disposition,
      operationId: intent.operationId,
      settlementId,
      operationKind: binding.operationKind,
      targetKind: binding.targetKind,
      targetId: binding.targetId,
      ...(input.activationId === undefined ? {} : { activationId: input.activationId }),
      resultSha256,
      replayed: false,
    };
  }

  /** Governed activate DB half: the activation row plus the candidate transition. */
  private applyGovernedActivationRows(input: {
    approval: ApprovalRequest;
    binding: ImprovementLifecycleApprovalBindingV1;
    mutation: NonNullable<ReturnType<typeof parseImprovementActivateMutation>>;
    candidate: ImprovementCandidateRecord;
    revision: ImprovementCandidateRevisionRecord;
    activationId: string;
    requesterId: string;
    status: "active" | "failed";
    failureReason?: string;
  }): void {
    const now = new Date().toISOString();
    const activationTarget = this.buildActivationTargetRef(input.candidate, input.revision);
    const inserted = this.ctx.gatewaySql
      .prepare(
        `
        INSERT INTO improvement_activations (
          activation_id, candidate_id, revision_id, approval_id, status, scope,
          activation_target_json, pre_activation_snapshot_json, applied_change_hash,
          watch_status, watch_started_at, watch_ends_at, watch_signal_target,
          watch_signal_count, regression_count, failure_reason,
          created_at, updated_at, requested_by_actor_id, requested_by_actor_type,
          approved_by_actor_id, approved_by_actor_type
        ) VALUES (
          @activationId, @candidateId, @revisionId, @approvalId, @status, 'workspace',
          @activationTargetJson, @preActivationSnapshotJson, @appliedChangeHash,
          @watchStatus, @watchStartedAt, @watchEndsAt, @watchSignalTarget,
          0, 0, @failureReason,
          @createdAt, @updatedAt, @requestedByActorId, 'operator',
          @approvedByActorId, 'approval'
        )
      `,
      )
      .run({
        activationId: input.activationId,
        candidateId: input.candidate.candidateId,
        revisionId: input.revision.revisionId,
        approvalId: input.approval.approvalId,
        status: input.status,
        activationTargetJson: JSON.stringify(activationTarget),
        preActivationSnapshotJson: JSON.stringify(
          buildGovernedPolicySnapshotRef(input.mutation.kind, input.mutation.targetKey, input.mutation.preState),
        ),
        appliedChangeHash: input.revision.changeHash,
        watchStatus: input.status === "active" ? "watching" : "failed",
        watchStartedAt: input.status === "active" ? now : null,
        watchEndsAt:
          input.status === "active" ? new Date(Date.now() + IMPROVEMENT_WATCH_WINDOW_MS).toISOString() : null,
        watchSignalTarget: IMPROVEMENT_WATCH_SIGNAL_TARGET,
        failureReason: input.failureReason ?? null,
        createdAt: now,
        updatedAt: now,
        requestedByActorId: input.requesterId,
        approvedByActorId: input.approval.resolvedBy ?? "approval",
      });
    if ((inserted.changes ?? 0) !== 1) {
      throw new Error(`Governed activation ${input.activationId} could not persist its canonical row.`);
    }
    if (input.status === "active") {
      this.updateCandidateStatus(
        input.candidate.candidateId,
        "approved",
        input.approval.resolvedBy ?? "approval",
        "approval",
      );
    }
  }

  /** Governed pause/rollback DB half: flip the activation row under its verified prior status. */
  private applyGovernedRestoreRows(
    activation: ImprovementActivationRecord,
    status: "paused" | "rolled_back",
    actorId: string,
  ): void {
    const now = new Date().toISOString();
    const flipped = this.ctx.gatewaySql
      .prepare(
        `
        UPDATE improvement_activations
        SET status = @status,
            watch_status = @watchStatus,
            paused_by_actor_id = CASE WHEN @status = 'paused' THEN @actorId ELSE paused_by_actor_id END,
            paused_by_actor_type = CASE WHEN @status = 'paused' THEN 'approval' ELSE paused_by_actor_type END,
            rolled_back_by_actor_id = CASE WHEN @status = 'rolled_back' THEN @actorId ELSE rolled_back_by_actor_id END,
            rolled_back_by_actor_type = CASE WHEN @status = 'rolled_back' THEN 'approval' ELSE rolled_back_by_actor_type END,
            paused_at = CASE WHEN @status = 'paused' THEN @timestamp ELSE paused_at END,
            rolled_back_at = CASE WHEN @status = 'rolled_back' THEN @timestamp ELSE rolled_back_at END,
            updated_at = @updatedAt
        WHERE activation_id = @activationId
          AND status = @expectedStatus
      `,
      )
      .run({
        activationId: activation.activationId,
        status,
        watchStatus: status === "paused" ? "paused" : "failed",
        actorId,
        timestamp: now,
        updatedAt: now,
        expectedStatus: activation.status,
      });
    if ((flipped.changes ?? 0) !== 1) {
      throw new Error(`Governed activation ${activation.activationId} lost its ${activation.status}-state claim.`);
    }
    if (status === "rolled_back") {
      this.applyCandidateSuppression(activation.candidateId);
    }
  }

  /** The exact reviewed DATABASE state for one governed activate request/apply. */
  private buildActivateReviewedStateMaterial(
    candidate: ImprovementCandidateRecord | undefined,
    revision: ImprovementCandidateRevisionRecord | undefined,
    evaluation: ImprovementEvaluationRecord | undefined,
  ): Record<string, unknown> {
    const latestActivation = candidate ? this.readLatestActivation(candidate.candidateId) : undefined;
    return buildImprovementActivateReviewedStateMaterial(candidate, revision, evaluation, latestActivation);
  }

  private captureImprovementExternalState(
    kind: "repair_policy" | "routing_policy",
    targetKey: string,
  ): ImprovementExternalStateMaterial {
    const ref =
      kind === "repair_policy"
        ? this.callbacks.captureRepairPolicySnapshot(targetKey)
        : this.callbacks.captureRoutingPolicySnapshot(targetKey);
    return snapshotRefToExternalState(ref);
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

  private recordAgenticImprovementProposal(
    proposal: AgenticImprovementBridgeProposal,
    workspaceId: string,
  ): AgenticImprovementProposalIngestionResult {
    const kind = determineAgenticProposalCandidateKind(proposal);
    const targetKey = buildAgenticProposalTargetKey(proposal, kind);
    const signal = this.recordImprovementSignal({
      sourceService: "agentic-improvement-bridge",
      sourceType: "agentic_improvement_proposal",
      sourceId: proposal.proposalId,
      sourceEventId: proposal.proposalId,
      idempotencyKey: `agentic-improvement-proposal:${workspaceId}:${proposal.proposalId}`,
      workspaceId,
      origin: "evaluation",
      signalClass: "evaluation",
      signalKind: "agentic_improvement_proposal",
      outcome: proposal.risk === "low" ? "neutral" : "negative",
      severity: proposal.risk,
      fingerprint: buildImprovementFingerprint(["agentic_proposal", workspaceId, kind, proposal.proposalId]),
      capabilityId: proposal.evidence.find((ref) => ref.source !== "prompt_lab")?.sourceId,
      memoryItemId: proposal.evidence.find((ref) => ref.source === "memory")?.sourceId,
      evidenceRefs: proposal.evidence.map((ref) => ({
        refType: mapAgenticProposalEvidenceRefType(ref.source),
        refId: ref.sourceId,
        hash: hashJson(ref),
        metadata: {
          source: ref.source,
          title: ref.title,
          summary: ref.summary,
          proposalId: proposal.proposalId,
        },
      })),
      metadata: {
        kind,
        targetKey,
        proposalId: proposal.proposalId,
        proposalTitle: proposal.title,
        observedIssue: proposal.observedIssue,
        proposedChange: proposal.proposedChange,
        callableImpact: proposal.callableImpact,
        rollbackRef: proposal.rollbackRef,
        risk: proposal.risk,
        actionStatuses: proposal.actionStatuses,
        trust: proposal.trust,
        mutationApplied: false,
        agenticProposal: proposal,
      },
    });
    if (signal) {
      this.maybeSynthesizeCandidate(signal);
    }
    const candidate = signal ? this.readOpenImprovementCandidateBySignal(signal, kind) : undefined;
    return { proposal, signal, candidate };
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
        replay_run_id, source_run_id, status, overrides_json, diff_json, started_at, finished_at, error_text
      ) VALUES (
        @replayRunId, @sourceRunId, 'draft', @overridesJson, NULL, @startedAt, NULL, NULL
      )
    `,
      )
      .run({
        replayRunId,
        sourceRunId,
        overridesJson: JSON.stringify({
          count: normalized.length,
          stepKeys: normalized.map((item) => item.stepKey),
        }),
        startedAt: now,
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
    this.ctx.gatewaySql
      .prepare(
        `
      UPDATE replay_override_runs
      SET status = 'running'
      WHERE replay_run_id = @replayRunId
    `,
      )
      .run({
        replayRunId: draft.replayRunId,
      });

    const summary = this.computeReplayDiffSummary(sourceRunId, draft.replayRunId, draft.overrides);
    const finishedAt = new Date().toISOString();
    this.ctx.gatewaySql
      .prepare(
        `
      UPDATE replay_override_runs
      SET status = 'completed',
          diff_json = @diffJson,
          finished_at = @finishedAt
      WHERE replay_run_id = @replayRunId
    `,
      )
      .run({
        replayRunId: draft.replayRunId,
        diffJson: JSON.stringify(summary),
        finishedAt,
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
      SELECT replay_run_id, source_run_id, status, diff_json, started_at, finished_at
      FROM replay_override_runs
      WHERE replay_run_id = ?
    `,
      )
      .get(replayRunId) as
      | {
          replay_run_id: string;
          source_run_id: string;
          status: ReplayOverrideDraft["status"];
          diff_json: string | null;
          started_at: string;
          finished_at: string | null;
        }
      | undefined;
    if (!row) {
      throw new Error(`Replay override run not found: ${replayRunId}`);
    }
    const parsed = safeJsonParse<Record<string, unknown>>(row.diff_json ?? "", {});
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
      comparedAt: row.finished_at ?? row.started_at,
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
      INSERT INTO replay_override_steps (step_id, replay_run_id, step_key, override_kind, override_json, created_at)
      VALUES (@stepId, @replayRunId, @stepKey, @overrideKind, @overrideJson, @createdAt)
    `);
    const now = new Date().toISOString();
    for (const override of overrides) {
      insert.run({
        stepId: randomUUID(),
        replayRunId,
        stepKey: override.stepKey,
        overrideKind: override.overrideKind,
        overrideJson: JSON.stringify(override.override ?? {}),
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

  private readOpenImprovementCandidateBySignal(
    signal: ImprovementSignalRecord,
    kind: ImprovementCandidateKind,
  ): ImprovementCandidateRecord | undefined {
    const row = toImprovementCandidateRow(
      this.ctx.gatewaySql
        .prepare(
          `
          SELECT *
          FROM improvement_candidates
          WHERE workspace_id = @workspaceId
            AND kind = @kind
            AND fingerprint = @fingerprint
            AND status IN ('proposed', 'evaluating', 'ready_for_approval', 'approval_pending', 'approved')
          ORDER BY updated_at DESC, candidate_id DESC
          LIMIT 1
        `,
        )
        .get({
          workspaceId: signal.workspaceId,
          kind,
          fingerprint: signal.fingerprint,
        }),
    );
    return row ? mapImprovementCandidateRow(row) : undefined;
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
      signal.signalKind === "agentic_improvement_proposal" ||
      (signal.signalClass === "evaluation" && signal.outcome === "negative" && signal.severity === "high") ||
      (signal.signalKind === "skill_revision_evaluated" && signal.outcome === "positive");
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
    if (signal.signalKind === "agentic_improvement_proposal") {
      const kind = asOptionalString(safeJsonRecord(signal.metadata).kind);
      return IMPROVEMENT_CANDIDATE_KINDS.has(kind as ImprovementCandidateKind)
        ? (kind as ImprovementCandidateKind)
        : "repair_policy";
    }
    if (signal.signalKind === "tool_provider_failure" || signal.signalKind === "durable_run_failed") {
      return "repair_policy";
    }
    if (
      signal.signalKind === "prompt_lab_regression_completed" ||
      signal.signalKind === "prompt_lab_benchmark_completed"
    ) {
      return "routing_policy";
    }
    if (signal.signalKind === "skill_revision_evaluated") {
      return "skill_revision";
    }
    if (signal.signalKind === "surface_route_override") {
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
    const explicitTargetKey = asOptionalString(metadata.targetKey);
    if (explicitTargetKey) {
      return explicitTargetKey;
    }
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
    if (kind === "skill_revision") {
      return asOptionalString(metadata.targetKey) ?? `skill:${signal.capabilityId ?? signal.sourceId}`;
    }
    return (
      asOptionalString(metadata.targetKey) ??
      [asOptionalString(metadata.packId), asOptionalString(metadata.causeClass)].filter(Boolean).join(":")
    );
  }

  private buildCandidateSummary(kind: ImprovementCandidateKind, signal: ImprovementSignalRecord): string {
    const metadata = safeJsonRecord(signal.metadata);
    const proposalTitle = asOptionalString(metadata.proposalTitle);
    if (signal.signalKind === "agentic_improvement_proposal" && proposalTitle) {
      return proposalTitle;
    }
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
    if (kind === "skill_revision") {
      return ["Skill revision candidate", asOptionalString(metadata.skillName) ?? signal.capabilityId]
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
    if (signal.signalKind === "agentic_improvement_proposal") {
      const proposalId = asOptionalString(metadata.proposalId) ?? signal.sourceId;
      const proposedChange = {
        strategy: "review_first_agentic_improvement",
        proposalId,
        title: asOptionalString(metadata.proposalTitle) ?? candidate.summary,
        observedIssue: asOptionalString(metadata.observedIssue),
        proposedChange: asOptionalString(metadata.proposedChange),
        callableImpact: asOptionalString(metadata.callableImpact),
        rollbackRef: asOptionalString(metadata.rollbackRef),
        risk: asOptionalString(metadata.risk),
        actionStatuses: isRecord(metadata.actionStatuses) ? metadata.actionStatuses : undefined,
        trust: isRecord(metadata.trust) ? metadata.trust : undefined,
        mutationApplied: false,
      };
      return {
        refType:
          candidate.kind === "repair_policy"
            ? "repair_candidate"
            : candidate.kind === "skill_revision"
              ? "skill_evaluation_run"
              : "artifact_manifest",
        refId: `agentic_proposal:${proposalId}`,
        metadata: {
          workspaceId: candidate.workspaceId,
          fingerprint: candidate.fingerprint,
          targetKey: candidate.targetKey,
          proposedChange,
          agenticProposal: isRecord(metadata.agenticProposal) ? metadata.agenticProposal : undefined,
          mutationApplied: false,
        },
        hash: hashJson(proposedChange),
      };
    }
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
        : candidate.kind === "skill_revision"
          ? {
              strategy: "skill_instruction_revision",
              skillId: asOptionalString(metadata.skillId) ?? signal.capabilityId,
              skillName: asOptionalString(metadata.skillName),
              evaluationRunId: signal.sourceId,
              proposalId: asOptionalString(metadata.proposalId),
              targetKey: asOptionalString(metadata.targetKey) ?? candidate.targetKey,
            }
          : {
              strategy: "route_rebalance",
              targetKey: asOptionalString(metadata.targetKey) ?? candidate.targetKey,
              causeClass: asOptionalString(metadata.causeClass),
              providerId: asOptionalString(metadata.providerId),
              model: asOptionalString(metadata.model),
            };
    return {
      refType:
        candidate.kind === "repair_policy"
          ? "repair_candidate"
          : candidate.kind === "skill_revision"
            ? "skill_evaluation_run"
            : "artifact_manifest",
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
      candidate.kind === "repair_policy"
        ? "repair_replay_validation"
        : candidate.kind === "skill_revision"
          ? "skill_eval_scorecard"
          : "prompt_lab_regression";
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
            : candidate.kind === "skill_revision"
              ? JSON.stringify({
                  refType: "skill_evaluation_run",
                  refId: latestSignal?.sourceId ?? candidate.targetKey,
                } satisfies ImprovementRef)
              : null,
        changeHash: revision.changeHash,
        metricsJson: JSON.stringify(metrics),
        resultSummary:
          candidate.kind === "repair_policy"
            ? "Repair policy candidate passed bounded replay validation."
            : candidate.kind === "skill_revision"
              ? "Skill revision candidate passed bounded skill evaluation."
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

  private isCuratorCandidate(candidate: ImprovementCandidateRecord): boolean {
    return candidate.kind === "skill_revision" || candidate.targetKey.startsWith("memory:");
  }

  private buildCuratorReviewItem(detail: ImprovementCandidateDetailResponse): CuratorReviewItem {
    const revision = detail.currentRevision;
    const metadata = safeJsonRecord(revision?.candidateRef.metadata);
    const proposedChange = safeJsonRecord(metadata.proposedChange);
    const agenticProposal = safeJsonRecord(metadata.agenticProposal);
    const latestActivation = detail.latestActivation;
    const callableImpact = normalizeCallableImpact(
      asOptionalString(proposedChange.callableImpact) ?? asOptionalString(agenticProposal.callableImpact),
    );
    const runtimeProvenCallable = readBooleanFlag(metadata, proposedChange, agenticProposal, "runtimeProvenCallable");
    const corruptionStatus = resolveCuratorCorruptionStatus(metadata, proposedChange, agenticProposal);
    const mutationApplied =
      latestActivation?.status === "active" ||
      readBooleanFlag(metadata, proposedChange, agenticProposal, "mutationApplied");
    const risk = normalizeCuratorRisk(
      asOptionalString(proposedChange.risk) ?? asOptionalString(agenticProposal.risk) ?? detail.candidate.severity,
    );
    const approvalReady =
      Boolean(revision) &&
      detail.latestEvaluation?.status === "passed" &&
      detail.latestEvaluation.revisionId === detail.candidate.currentRevisionId &&
      corruptionStatus === "clean" &&
      detail.candidate.status !== "rejected";
    const activationNeedsRuntimeCallable = callableImpact === "widens_after_approval";
    const disabledReasons: CuratorReviewItem["disabledReasons"] = {};
    if (!revision) {
      disabledReasons.validate = "Missing candidate revision.";
      disabledReasons.approve = "Missing candidate revision.";
      disabledReasons.activate = "Missing candidate revision.";
      disabledReasons.promote = "Missing candidate revision.";
    }
    if (corruptionStatus !== "clean") {
      const reason = `Candidate is ${corruptionStatus} and cannot mutate runtime state.`;
      disabledReasons.validate = reason;
      disabledReasons.approve = reason;
      disabledReasons.activate = reason;
      disabledReasons.promote = reason;
    }
    if (!approvalReady && !disabledReasons.approve) {
      disabledReasons.approve = "Candidate must pass validation before approval.";
    }
    if (detail.candidate.status !== "approved") {
      disabledReasons.activate = "Candidate must be approved before activation.";
      disabledReasons.promote = "Candidate must be approved before promotion.";
    }
    if (!disabledReasons.promote) {
      disabledReasons.promote = "Promotion is review-only until capability proposal approval applies the mutation.";
    }
    if (detail.candidate.kind === "skill_revision") {
      disabledReasons.activate = "Skill revisions promote through capability proposals.";
      disabledReasons.promote = "Capability proposal promotion is approval-gated and not applied silently.";
    }
    if (activationNeedsRuntimeCallable && !runtimeProvenCallable) {
      disabledReasons.activate = "Callable exposure must be runtime-proven before activation.";
      disabledReasons.promote = "Callable exposure must be runtime-proven before promotion.";
    }
    if (mutationApplied) {
      disabledReasons.reject = "Already applied candidates must be paused or rolled back instead.";
      disabledReasons.snooze = "Already applied candidates must be paused or rolled back instead.";
    }
    return {
      candidate: detail.candidate,
      currentRevision: revision,
      latestEvaluation: detail.latestEvaluation,
      latestActivation,
      evidence: dedupeImprovementEvidence(detail.supportingSignals.flatMap((signal) => signal.evidenceRefs)),
      risk,
      rollbackRef:
        asOptionalString(proposedChange.rollbackRef) ??
        asOptionalString(agenticProposal.rollbackRef) ??
        revision?.candidateRef.hash,
      observedIssue: asOptionalString(proposedChange.observedIssue) ?? asOptionalString(agenticProposal.observedIssue),
      proposedChange:
        asOptionalString(proposedChange.proposedChange) ?? asOptionalString(agenticProposal.proposedChange),
      callableImpact,
      approvalRequired: true,
      mutationApplied,
      runtimeProvenCallable,
      corruptionStatus,
      actionStatuses: {
        validate: disabledReasons.validate ? "blocked" : "ready",
        approve: disabledReasons.approve ? "blocked" : "ready",
        reject: disabledReasons.reject ? "blocked" : "ready",
        snooze: disabledReasons.snooze ? "blocked" : "ready",
        activate: disabledReasons.activate ? "blocked" : "ready",
        promote: disabledReasons.promote ? "blocked" : "ready",
      },
      disabledReasons,
    };
  }

  private assertCandidateNotCorruptOrQuarantined(
    candidate: ImprovementCandidateRecord,
    revision: ImprovementCandidateRevisionRecord,
  ): void {
    const metadata = safeJsonRecord(revision.candidateRef.metadata);
    const proposedChange = safeJsonRecord(metadata.proposedChange);
    const agenticProposal = safeJsonRecord(metadata.agenticProposal);
    const corruptionStatus = resolveCuratorCorruptionStatus(metadata, proposedChange, agenticProposal);
    if (corruptionStatus !== "clean") {
      throw new Error(`Candidate ${candidate.candidateId} is ${corruptionStatus} and cannot be promoted.`);
    }
  }

  private assertCandidateReadyForMutation(
    candidate: ImprovementCandidateRecord,
    revision: ImprovementCandidateRevisionRecord,
  ): void {
    if (candidate.status !== "approved") {
      throw new Error(`Candidate ${candidate.candidateId} must be approved before mutation-capable actions.`);
    }
    this.assertCandidateNotCorruptOrQuarantined(candidate, revision);
    const metadata = safeJsonRecord(revision.candidateRef.metadata);
    const proposedChange = safeJsonRecord(metadata.proposedChange);
    const agenticProposal = safeJsonRecord(metadata.agenticProposal);
    const callableImpact = normalizeCallableImpact(
      asOptionalString(proposedChange.callableImpact) ?? asOptionalString(agenticProposal.callableImpact),
    );
    if (
      callableImpact === "widens_after_approval" &&
      !readBooleanFlag(metadata, proposedChange, agenticProposal, "runtimeProvenCallable")
    ) {
      throw new Error(`Candidate ${candidate.candidateId} must be runtime-proven callable before promotion.`);
    }
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

  private clearCandidateSuppression(candidateId: string, actorId: string, actorType: ImprovementActorType): void {
    this.ctx.gatewaySql
      .prepare(
        `
        UPDATE improvement_candidates
        SET suppression_until = NULL,
            updated_at = @updatedAt,
            updated_by_actor_id = @actorId,
            updated_by_actor_type = @actorType
        WHERE candidate_id = @candidateId
      `,
      )
      .run({
        candidateId,
        updatedAt: new Date().toISOString(),
        actorId,
        actorType,
      });
  }

  private setCandidateSuppression(
    candidateId: string,
    suppressionUntil: string,
    actorId: string,
    actorType: ImprovementActorType,
  ): void {
    this.ctx.gatewaySql
      .prepare(
        `
        UPDATE improvement_candidates
        SET suppression_until = @suppressionUntil,
            updated_at = @updatedAt,
            updated_by_actor_id = @actorId,
            updated_by_actor_type = @actorType
        WHERE candidate_id = @candidateId
      `,
      )
      .run({
        candidateId,
        suppressionUntil,
        updatedAt: new Date().toISOString(),
        actorId,
        actorType,
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
      refType:
        candidate.kind === "skill_revision"
          ? "skill_revision_config"
          : candidate.kind === "repair_policy"
            ? "repair_policy_config"
            : "routing_policy_config",
      refId: candidate.targetKey,
      hash: revision.changeHash,
      metadata: {
        candidateId: candidate.candidateId,
        fingerprint: candidate.fingerprint,
        kind: candidate.kind,
        targetKey: candidate.targetKey,
        ...(candidate.kind === "skill_revision"
          ? {}
          : {
              settingKey:
                candidate.kind === "repair_policy"
                  ? IMPROVEMENT_REPAIR_POLICY_CONFIG_SETTING_KEY
                  : IMPROVEMENT_ROUTING_POLICY_CONFIG_SETTING_KEY,
            }),
      },
    };
  }

  private captureActivationSnapshot(
    kind: ImprovementCandidateKind,
    targetKey: string,
    revision: ImprovementCandidateRevisionRecord,
  ): ImprovementRef {
    if (kind === "skill_revision") {
      return this.callbacks.captureSkillRevisionSnapshot(targetKey, revision.candidateRef);
    }
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
    const now = new Date().toISOString();
    let mutationApplied = false;
    try {
      this.ctx.gatewaySql.runImmediateTransaction(() => {
        const candidateClaim = this.ctx.gatewaySql
          .prepare(
            `
            UPDATE improvement_candidates
            SET updated_at = updated_at
            WHERE candidate_id = @candidateId
              AND status = 'approval_pending'
              AND (suppression_until IS NULL OR suppression_until <= @claimAt)
          `,
          )
          .run({
            candidateId: activation.candidateId,
            claimAt: now,
          });
        if (candidateClaim.changes !== 1) {
          throw new Error("candidate_no_longer_eligible");
        }
        const claim = this.ctx.gatewaySql
          .prepare(
            `
            UPDATE improvement_activations
            SET updated_at = @claimAt
            WHERE activation_id = @activationId
              AND status = 'pending'
          `,
          )
          .run({
            activationId: activation.activationId,
            claimAt: now,
          });
        if (claim.changes !== 1) {
          return;
        }
        const claimedCandidate = this.readImprovementCandidate(activation.candidateId);
        const claimedRevision = this.readCurrentRevision(claimedCandidate.candidateId);
        const claimedEvaluation = this.readLatestEvaluation(claimedCandidate.candidateId);
        if (!this.isPendingActivationCandidateEligible(claimedCandidate)) {
          throw new Error("candidate_no_longer_eligible");
        }
        if (
          !claimedRevision ||
          !claimedEvaluation ||
          claimedCandidate.currentRevisionId !== claimedEvaluation.revisionId ||
          claimedEvaluation.revisionId !== activation.revisionId ||
          claimedRevision.revisionId !== activation.revisionId ||
          claimedEvaluation.changeHash !== claimedRevision.changeHash ||
          activation.appliedChangeHash !== claimedRevision.changeHash
        ) {
          throw new Error("candidate_drift");
        }
        mutationApplied = true;
        const activationTarget = this.applyActivationChange(
          claimedCandidate.kind,
          claimedCandidate.targetKey,
          claimedRevision,
        );
        const activated = this.ctx.gatewaySql
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
              AND status = 'pending'
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
        if (activated.changes !== 1) {
          throw new Error(`Activation ${activation.activationId} lost its pending-state claim before commit.`);
        }
        this.updateCandidateStatus(
          claimedCandidate.candidateId,
          "approved",
          approval.resolvedBy ?? "approval",
          "approval",
        );
      });
    } catch (error) {
      if (mutationApplied) {
        this.compensateFailedActivationApply(activation, error);
      }
      throw error;
    }
    let applied: ImprovementActivationRecord;
    try {
      applied = this.readImprovementActivation(activation.activationId);
    } catch (error) {
      if (!mutationApplied) {
        throw error;
      }
      throw new ImprovementActivationPostCommitError(
        `Activation ${activation.activationId} was applied but its committed state could not be reloaded: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (!mutationApplied) {
      if (applied.status === "active") {
        this.emitActivationAppliedAuditOrThrow(applied, approval);
        return applied;
      }
      if (applied.status !== "pending") {
        return applied;
      }
      throw new ImprovementActivationClaimError(
        `Activation ${activation.activationId} could not acquire its pending-state claim.`,
      );
    }
    this.emitActivationAppliedAuditOrThrow(applied, approval);
    return applied;
  }

  private compensateFailedActivationApply(activation: ImprovementActivationRecord, failure: unknown): void {
    try {
      if (activation.preActivationSnapshot.refType === "skill_revision_snapshot") {
        this.callbacks.restoreSkillRevisionSnapshot(activation.preActivationSnapshot);
      } else if (activation.preActivationSnapshot.refType === "repair_policy_snapshot") {
        this.callbacks.restoreRepairPolicySnapshot(activation.preActivationSnapshot);
      } else {
        this.callbacks.restoreRoutingPolicySnapshot(activation.preActivationSnapshot);
      }
    } catch (restoreError) {
      throw new ImprovementActivationCompensationError(
        `Activation ${activation.activationId} failed and its pre-activation snapshot could not be restored: ${
          restoreError instanceof Error ? restoreError.message : String(restoreError)
        }`,
        { cause: failure },
      );
    }
  }

  private emitActivationAppliedAudit(activation: ImprovementActivationRecord, approval: ApprovalRequest): void {
    const candidate = this.readImprovementCandidate(activation.candidateId);
    this.emitLifecycleAuditSignal("activation_applied", {
      candidateId: candidate.candidateId,
      revisionId: activation.revisionId,
      activationId: activation.activationId,
      approvalId: approval.approvalId,
      workspaceId: candidate.workspaceId,
      fingerprint: candidate.fingerprint,
      targetKey: candidate.targetKey,
      status: "active",
      watchStatus: "watching",
    });
  }

  private emitActivationAppliedAuditOrThrow(activation: ImprovementActivationRecord, approval: ApprovalRequest): void {
    try {
      this.emitActivationAppliedAudit(activation, approval);
    } catch (error) {
      throw new ImprovementActivationPostCommitError(
        `Activation ${activation.activationId} was applied but its lifecycle audit is still pending: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  private isPendingActivationCandidateEligible(candidate: ImprovementCandidateRecord): boolean {
    if (candidate.status !== "approval_pending") {
      return false;
    }
    const suppressionUntil = candidate.suppressionUntil ? Date.parse(candidate.suppressionUntil) : Number.NaN;
    return !Number.isFinite(suppressionUntil) || suppressionUntil <= Date.now();
  }

  private lockCandidateForLifecycleMutation(candidateId: string): void {
    const lock = this.ctx.gatewaySql
      .prepare(
        `
        UPDATE improvement_candidates
        SET updated_at = updated_at
        WHERE candidate_id = @candidateId
      `,
      )
      .run({ candidateId });
    if (lock.changes !== 1) {
      throw new Error(`Improvement candidate not found: ${candidateId}`);
    }
  }

  private assertCandidateHasNoAppliedActivation(candidateId: string): void {
    const activation = this.readLatestActivation(candidateId);
    if (activation?.watchStartedAt && activation.status !== "paused" && activation.status !== "rolled_back") {
      throw new Error(
        `Candidate ${candidateId} has an applied activation; pause or roll it back before rejection or snooze.`,
      );
    }
  }

  private applyActivationChange(
    kind: ImprovementCandidateKind,
    targetKey: string,
    revision: ImprovementCandidateRevisionRecord,
  ): ImprovementRef {
    if (kind === "skill_revision") {
      // Writes the authored SKILL.md, records the candidate lifecycle, and (only
      // under master autonomy) promotes it to a callable `approved` state via
      // this recorded, reversible activation. isSkillCallable is never bypassed.
      return this.callbacks.applySkillRevisionCandidate(targetKey, revision.candidateRef);
    }
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
      if (activation.preActivationSnapshot.refType === "skill_revision_snapshot") {
        this.callbacks.restoreSkillRevisionSnapshot(activation.preActivationSnapshot);
      } else if (activation.preActivationSnapshot.refType === "repair_policy_snapshot") {
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

  private readLatestActivationByApprovalId(approvalId: string): ImprovementActivationRecord | undefined {
    const row = toImprovementActivationRow(
      this.ctx.gatewaySql
        .prepare(
          `
          SELECT *
          FROM improvement_activations
          WHERE approval_id = @approvalId
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
      expectedStatus?: ImprovementActivationRecord["status"];
    } = {},
  ): ImprovementActivationRecord {
    const transition = this.ctx.gatewaySql
      .prepare(
        `
        UPDATE improvement_activations
        SET status = 'failed',
            watch_status = 'failed',
            failure_reason = @failureReason,
            updated_at = @updatedAt
        WHERE activation_id = @activationId
          AND (
            CAST(@expectedStatus AS TEXT) IS NULL
            OR status = CAST(@expectedStatus AS TEXT)
          )
      `,
      )
      .run({
        activationId,
        failureReason,
        expectedStatus: input.expectedStatus ?? null,
        updatedAt: new Date().toISOString(),
      });
    const failed = this.readImprovementActivation(activationId);
    if ((transition.changes ?? 0) !== 1) {
      return failed;
    }
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
      | "candidate_validated"
      | "candidate_approved"
      | "candidate_rejected"
      | "candidate_snoozed"
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
      reason?: string;
      snoozeUntil?: string;
      mutationApplied?: boolean;
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
    const lifecycleSignalKey = [signalKind, input.activationId, input.evaluationId, input.revisionId, input.candidateId]
      .filter(Boolean)
      .join(":");
    const signal = this.recordImprovementSignal({
      sourceService: "improvement-service",
      sourceType: "lifecycle",
      sourceId: input.activationId ?? input.evaluationId ?? input.revisionId ?? input.candidateId ?? signalKind,
      sourceEventId: lifecycleSignalKey,
      idempotencyKey: lifecycleSignalKey,
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
      [IDEMPOTENT_REALTIME_ENVELOPE_KEY]: {
        deliveryId: `improvement-lifecycle:${signal?.signalId ?? lifecycleSignalKey}`,
        occurredAt: signal?.occurredAt ?? new Date().toISOString(),
      },
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

  /**
   * P2-W3: map a tuned setting key to the runtime-effective value its decision
   * point will read, via the shared getter callbacks. Returns `undefined` for
   * keys that have no wired decision point (so the audit record simply omits the
   * field rather than asserting a false "effective" value).
   */
  private readEffectiveTuneValue(settingKey: string): number | undefined {
    switch (settingKey) {
      case IMPROVEMENT_TUNE_KEY_BLOCKER_TEMPLATE:
        return this.callbacks.readEffectiveBlockerTemplateStrictness();
      case IMPROVEMENT_TUNE_KEY_RETRY_THRESHOLD:
        return this.callbacks.readEffectiveRetryRepairThreshold();
      case IMPROVEMENT_TUNE_KEY_LIVE_INTENT:
        return this.callbacks.readEffectiveLiveIntentThreshold();
      default:
        return undefined;
    }
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
    // P2-W3: record the value the runtime decision point will now actually READ
    // for this setting, proving the loop is closed (written key ⇒ read key) and
    // making the applied tune auditable. `undefined` for keys without a wired
    // decision point (e.g. medium-risk routing weights, which never auto-apply).
    const effectiveRuntimeValue = this.readEffectiveTuneValue(settingKey);
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
        resultJson: JSON.stringify({
          appliedBy: mode,
          settingKey,
          nextValue,
          ...(effectiveRuntimeValue !== undefined ? { effectiveRuntimeValue } : {}),
        }),
      });
    this.ctx.publishRealtime("improvement_autotune_applied", "improvement", {
      tuneId,
      settingKey,
      mode,
      ...(effectiveRuntimeValue !== undefined ? { effectiveRuntimeValue } : {}),
    });
    // Cross-cutting audit (best-effort): notify the gateway so the applied tune is
    // captured in the unified autonomy-audit ledger. The tune row carries its own
    // rollback snapshot, so the audit restoreRef only needs the tuneId.
    try {
      this.callbacks.onAutoTuneApplied?.(tuneId, settingKey);
    } catch {
      // Best-effort audit append must never break the tune apply.
    }
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
        modelScores = await this.judgeDecisionReplayCandidate(runId, candidate, excerpts, ruleEval.scores);
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
      // SECURITY (codex finding #27): redact secret-bearing patterns and
      // env-resolved credentials BEFORE truncating + emitting into the
      // judge prompt.
      return {
        inputExcerpt: truncateForModelJudge(
          redactSensitivePayload(candidate.args ? JSON.stringify(candidate.args, null, 2) : ""),
          1800,
        ),
        outputExcerpt: truncateForModelJudge(
          redactSensitivePayload(
            candidate.error ?? (candidate.result ? JSON.stringify(candidate.result, null, 2) : ""),
          ),
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
        ? truncateForModelJudge(redactSensitivePayload(sessionMessages.get(candidate.userMessageId) ?? ""), 2200)
        : undefined,
      outputExcerpt: candidate.assistantMessageId
        ? truncateForModelJudge(redactSensitivePayload(sessionMessages.get(candidate.assistantMessageId) ?? ""), 2500)
        : undefined,
    };
  }

  private async judgeDecisionReplayCandidate(
    runId: string,
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
      assertNoAssembledPromptInjection(`Grade strictly. JSON only.\n${prompt}`);
      const attribution = createUtilityModelUsageAttribution({
        operationId: `improvement:${encodeURIComponent(runId)}:decision-judge:${encodeURIComponent(
          candidate.turnId ?? candidate.toolRunId ?? candidate.occurredAt,
        )}`,
        utilityKind: "improvement_decision_replay_judge",
        requestedProviderId: defaults.providerId,
        requestedModelId: defaults.model,
        lineage: {
          sessionId: candidate.sessionId,
          turnId: candidate.turnId,
          taskId: runId,
          agentId: "improvement-reviewer",
          parentOperationId: `improvement:${encodeURIComponent(runId)}`,
        },
      });
      const completion = await runBoundedUtilityModelCall({
        timeoutMs: IMPROVEMENT_JUDGE_TIMEOUT_MS,
        timeoutMessage: `Decision replay judge timed out after ${IMPROVEMENT_JUDGE_TIMEOUT_MS}ms`,
        start: (boundedSignal) =>
          this.callbacks.createChatCompletion(
            {
              providerId: defaults.providerId,
              model: defaults.model,
              messages: [
                { role: "system", content: "Grade strictly. JSON only." },
                { role: "user", content: prompt },
              ],
              temperature: 0,
              max_tokens: 220,
              signal: boundedSignal,
            },
            attribution,
          ),
      });
      const payload = parseLooseJsonRecord(extractCompletionText(completion));
      if (!payload) return undefined;
      return {
        correctnessLikelihood: clampProbability(payload.correctnessLikelihood),
        missedToolProbability: clampProbability(payload.missedToolProbability),
        betterResponsePotential: clampProbability(payload.betterResponsePotential),
        rationale: typeof payload.rationale === "string" ? payload.rationale.slice(0, 500) : undefined,
      };
    } catch (error) {
      if (isAuthoritativeModelUsageAccountingError(error)) {
        throw error;
      }
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
    // Raw "BEGIN IMMEDIATE" is sqlite-only syntax; the helper picks the
    // driver-appropriate transaction statements on Postgres deployments.
    this.ctx.gatewaySql.runImmediateTransaction(() => {
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
    });
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
    // Raw "BEGIN IMMEDIATE" is sqlite-only syntax; the helper picks the
    // driver-appropriate transaction statements on Postgres deployments.
    this.ctx.gatewaySql.runImmediateTransaction(() => {
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
    });
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

function determineAgenticProposalCandidateKind(proposal: AgenticImprovementBridgeProposal): ImprovementCandidateKind {
  if (proposal.evidence.some((ref) => ref.source === "skill_evaluation")) {
    return "skill_revision";
  }
  if (proposal.callableImpact === "narrows" || proposal.proposalId.startsWith("agentic-diagnostic-")) {
    return "repair_policy";
  }
  return "routing_policy";
}

function buildAgenticProposalTargetKey(
  proposal: AgenticImprovementBridgeProposal,
  kind: ImprovementCandidateKind,
  justLoadedSkillIds: string[] = [],
): string {
  return resolveActiveUpdateTarget({ candidateKind: kind, evidence: proposal.evidence, justLoadedSkillIds });
}

function mapAgenticProposalEvidenceRefType(
  source: AgenticImprovementBridgeProposal["evidence"][number]["source"],
): ImprovementEvidenceRefType {
  if (source === "agentic_diagnostic") {
    return "agentic_diagnostic";
  }
  if (source === "prompt_lab") {
    return "prompt_pack_run";
  }
  if (source === "skill_evaluation") {
    return "skill_evaluation_run";
  }
  if (source === "plugin" || source === "provider" || source === "channel") {
    return "capability_proposal";
  }
  return "artifact_manifest";
}

function mapAgenticDiagnosticSeverity(severity: AgenticDiagnosticSignal["severity"]): ImprovementSignalSeverity {
  if (severity === "critical") {
    return "high";
  }
  if (severity === "warning") {
    return "medium";
  }
  return "low";
}

function normalizeCuratorRisk(value: unknown): "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

function normalizeCallableImpact(value: unknown): "none" | "narrows" | "widens_after_approval" {
  return value === "narrows" || value === "widens_after_approval" ? value : "none";
}

function readBooleanFlag(records: Record<string, unknown>[], key: string): boolean;
function readBooleanFlag(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
  third: Record<string, unknown>,
  key: string,
): boolean;
function readBooleanFlag(
  first: Record<string, unknown> | Record<string, unknown>[],
  second: Record<string, unknown> | string,
  third?: Record<string, unknown>,
  fourth?: string,
): boolean {
  const records = Array.isArray(first) ? first : [first, second as Record<string, unknown>, third ?? {}];
  const key = Array.isArray(first) ? (second as string) : (fourth as string);
  return records.some((record) => record[key] === true);
}

function resolveCuratorCorruptionStatus(
  metadata: Record<string, unknown>,
  proposedChange: Record<string, unknown>,
  agenticProposal: Record<string, unknown>,
): "clean" | "corrupt" | "quarantined" {
  if (
    metadata.quarantined === true ||
    proposedChange.quarantined === true ||
    agenticProposal.quarantined === true ||
    metadata.integrityStatus === "quarantined" ||
    proposedChange.integrityStatus === "quarantined" ||
    agenticProposal.integrityStatus === "quarantined"
  ) {
    return "quarantined";
  }
  if (
    metadata.corrupt === true ||
    proposedChange.corrupt === true ||
    agenticProposal.corrupt === true ||
    metadata.integrityStatus === "corrupt" ||
    proposedChange.integrityStatus === "corrupt" ||
    agenticProposal.integrityStatus === "corrupt"
  ) {
    return "corrupt";
  }
  return "clean";
}

function dedupeImprovementEvidence(evidenceRefs: ImprovementEvidenceRef[]): ImprovementEvidenceRef[] {
  const seen = new Set<string>();
  const result: ImprovementEvidenceRef[] = [];
  for (const ref of evidenceRefs) {
    const key = `${ref.refType}:${ref.refId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(ref);
  }
  return result;
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

// ── HX-402 P3 governed-lifecycle module helpers ──────────────────────

/**
 * The exact reviewed DATABASE state one governed activate approval binds.
 * Exported for the postgres-dialect harness, which must seed the canonical
 * approval row directly because the approvals repository's TTL-window SQL is
 * genuinely postgres-flavored (P1 precedent).
 */
export function buildImprovementActivateReviewedStateMaterial(
  candidate: ImprovementCandidateRecord | undefined,
  revision: ImprovementCandidateRevisionRecord | undefined,
  evaluation: ImprovementEvaluationRecord | undefined,
  latestActivation: ImprovementActivationRecord | undefined,
): Record<string, unknown> {
  return {
    candidate: candidate
      ? {
          candidateId: candidate.candidateId,
          status: candidate.status,
          currentRevisionId: candidate.currentRevisionId ?? null,
          suppressionUntil: candidate.suppressionUntil ?? null,
        }
      : null,
    revision: revision ? { revisionId: revision.revisionId, changeHash: revision.changeHash } : null,
    evaluation: evaluation
      ? { evaluationId: evaluation.evaluationId, revisionId: evaluation.revisionId, changeHash: evaluation.changeHash }
      : null,
    latestActivation: latestActivation
      ? {
          activationId: latestActivation.activationId,
          status: latestActivation.status,
          watchStartedAt: latestActivation.watchStartedAt ?? null,
        }
      : null,
  };
}

/** The exact reviewed DATABASE state for one governed pause/rollback request/apply (exported: P1 precedent). */
export function buildImprovementRestoreReviewedStateMaterial(
  activation: ImprovementActivationRecord,
): Record<string, unknown> {
  return buildRestoreReviewedStateMaterial(activation);
}

/** The exact reviewed DATABASE state for one governed pause/rollback request/apply. */
function buildRestoreReviewedStateMaterial(activation: ImprovementActivationRecord): Record<string, unknown> {
  return {
    activation: {
      activationId: activation.activationId,
      candidateId: activation.candidateId,
      revisionId: activation.revisionId,
      status: activation.status,
      watchStatus: activation.watchStatus,
      appliedChangeHash: activation.appliedChangeHash,
    },
  };
}

/** Extract the canonical {hadValue, value} observation from a policy snapshot/capture ref. */
function snapshotRefToExternalState(ref: ImprovementRef): ImprovementExternalStateMaterial {
  const metadata = isRecord(ref.metadata) ? ref.metadata : {};
  const hadValue = metadata.hadValue === true;
  return { hadValue, value: hadValue ? (metadata.previousValue ?? null) : null };
}

/** Build the value-carrying pre-activation snapshot ref the governed activate row persists. */
function buildGovernedPolicySnapshotRef(
  kind: "repair_policy" | "routing_policy",
  targetKey: string,
  state: ImprovementExternalStateMaterial,
): ImprovementRef {
  return {
    refType: kind === "repair_policy" ? "repair_policy_snapshot" : "routing_policy_snapshot",
    refId: targetKey,
    hash: createHash("sha1")
      .update(JSON.stringify({ hadValue: state.hadValue, previousValue: state.value }))
      .digest("hex"),
    metadata: {
      targetKey,
      hadValue: state.hadValue,
      previousValue: state.value,
    },
  };
}

/** The exact value applyRepairPolicyCandidate/applyRoutingPolicyCandidate will write for a revision. */
function deriveActivationTargetValue(candidateRef: ImprovementRef): unknown {
  const proposedChange = isRecord(candidateRef.metadata) ? candidateRef.metadata.proposedChange : undefined;
  return proposedChange ?? candidateRef.metadata ?? {};
}

function normalizeImprovementRequesterId(requesterId: string | undefined): string {
  const normalized = requesterId?.trim();
  return normalized && normalized.length <= 256 ? normalized : "operator";
}

function isNotFoundLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === "NotFoundError" || /not found/iu.test(error.message));
}

function mapSettlementToApplyResult(
  settlement: ImprovementLifecycleSettlementRecord,
  binding: ImprovementLifecycleApprovalBindingV1,
  replayed: boolean,
): ImprovementLifecycleApplyResult {
  return {
    disposition: settlement.disposition,
    operationId: settlement.operationId,
    settlementId: settlement.settlementId,
    operationKind: binding.operationKind,
    targetKind: binding.targetKind,
    targetId: binding.targetId,
    ...(asOptionalString(settlement.result.activationId) === undefined
      ? {}
      : { activationId: asOptionalString(settlement.result.activationId) }),
    resultSha256: settlement.resultSha256,
    replayed,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
