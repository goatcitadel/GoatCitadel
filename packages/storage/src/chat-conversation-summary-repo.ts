/* eslint-disable max-lines -- This established owner exceeds the line limit; decomposition belongs in a separate behavior-preserving tranche. */
import { createHash } from "node:crypto";
import type {
  ChatCompactionAttemptDisposition,
  ChatCompactionAttemptOutcome,
  ChatCompactionBreakerActionKind,
  ChatCompactionBreakerActionRecord,
  ChatCompactionBreakerActionStatus,
  ChatCompactionBreakerRecord,
  ChatCompactionBreakerStatus,
  ChatCompactionStateRecord,
  ChatConversationSummaryRecord,
} from "@goatcitadel/contracts";
import { ConflictError, NotFoundError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

const MAX_ID_LENGTH = 256;
const MAX_HASH_LENGTH = 128;
const MAX_SUMMARY_TEXT_LENGTH = 65_536;
const MAX_JSON_LENGTH = 131_072;
const MAX_SUMMARY_TURN_IDS = 64;
const MAX_STATE_TURN_IDS = 512;
const MAX_ROWS_PER_LOOKUP = 128;
const MAX_SUMMARY_ROWS_PER_SESSION = 256;
const MAX_STATE_ROWS_PER_SESSION = 128;
const MAX_BREAKER_STREAK = 2;
const MAX_REPAIR_REASON_LENGTH = 512;
const MAX_ACTION_REASON_LENGTH = 512;
const MAX_ACTION_REJECTION_REASON_LENGTH = 512;

interface ChatConversationSummaryRow {
  summary_id: string;
  session_id: string;
  branch_head_turn_id: string;
  start_turn_id: string;
  end_turn_id: string;
  turn_ids_json: string;
  source_hash: string;
  window_key?: string | null;
  token_estimate: number;
  summary_text: string;
  created_at: string;
  updated_at: string;
}

interface ChatCompactionStateRow {
  state_key: string;
  session_id: string;
  dimension_hash: string;
  provider_id?: string | null;
  model?: string | null;
  profile_fingerprint?: string | null;
  boundary_turn_ids_json: string;
  boundary_source_hash: string;
  baseline_input_tokens: number;
  last_observed_input_tokens: number;
  observed_turn_count: number;
  armed: number;
  created_at: string;
  updated_at: string;
}

interface ChatCompactionBreakerRow {
  session_id: string;
  dimension_hash: string;
  provider_id?: string | null;
  model?: string | null;
  profile_fingerprint?: string | null;
  status: string;
  fallback_streak: number;
  ineffective_streak: number;
  pending_attempt_id?: string | null;
  pending_state_key?: string | null;
  quarantined_state_key?: string | null;
  pending_branch_head_turn_id?: string | null;
  pending_observed_turn_count?: number | null;
  pending_disposition?: string | null;
  pending_started_at?: string | null;
  last_attempt_id?: string | null;
  last_evidence_turn_id?: string | null;
  last_evidence_input_tokens?: number | null;
  last_outcome: string;
  revision: number;
  last_repaired_at?: string | null;
  last_repair_reason?: string | null;
  last_repaired_actor_hash?: string | null;
  created_at: string;
  updated_at: string;
}

interface ChatCompactionBreakerActionRow {
  action_id: string;
  session_id: string;
  dimension_hash: string;
  action_kind: string;
  expected_breaker_revision: number;
  actor_hash: string;
  request_evidence_hash: string;
  policy_decision_hash: string;
  audit_evidence_hash: string;
  approval_id?: string | null;
  reason: string;
  status: string;
  rejection_reason?: string | null;
  created_at: string;
  expires_at: string;
  consumed_at?: string | null;
  resulting_attempt_id?: string | null;
  resulting_breaker_revision?: number | null;
  quarantined_state_key?: string | null;
  updated_at: string;
}

export interface ChatConversationSummaryUpsertInput {
  summaryId?: string;
  sessionId: string;
  branchHeadTurnId: string;
  startTurnId: string;
  endTurnId: string;
  turnIds: string[];
  sourceHash: string;
  windowKey?: string;
  tokenEstimate: number;
  summary: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ChatCompactionStateUpsertInput {
  stateKey: string;
  sessionId: string;
  dimensionHash: string;
  providerId?: string;
  model?: string;
  profileFingerprint?: string;
  boundaryTurnIds: string[];
  boundarySourceHash: string;
  baselineInputTokens: number;
  lastObservedInputTokens: number;
  observedTurnCount: number;
  armed: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ChatCompactionBoundaryCommitInput {
  state: ChatCompactionStateUpsertInput;
  attemptId: string;
  branchHeadTurnId: string;
  disposition: Exclude<ChatCompactionAttemptDisposition, "no_progress">;
  expectedBreakerRevision?: number;
  forceAction?: ChatCompactionForceActionReference;
  startedAt?: string;
}

export interface ChatCompactionNoProgressInput {
  sessionId: string;
  dimensionHash: string;
  providerId?: string;
  model?: string;
  profileFingerprint?: string;
  attemptId: string;
  branchHeadTurnId: string;
  observedTurnCount: number;
  attemptedBoundarySourceHash: string;
  expectedBreakerRevision?: number;
  forceAction?: ChatCompactionForceActionReference;
  occurredAt?: string;
}

export interface ChatCompactionForceActionReference {
  actionId: string;
  actorHash: string;
}

export interface ChatCompactionBreakerActionCreateInput {
  actionId: string;
  sessionId: string;
  dimensionHash: string;
  actionKind: ChatCompactionBreakerActionKind;
  expectedBreakerRevision: number;
  actorHash: string;
  requestEvidenceHash: string;
  policyDecisionHash: string;
  auditEvidenceHash: string;
  approvalId?: string;
  reason: string;
  status: Extract<ChatCompactionBreakerActionStatus, "pending" | "rejected">;
  rejectionReason?: string;
  createdAt: string;
  expiresAt: string;
}

export interface ChatCompactionEvidenceInput {
  sessionId: string;
  dimensionHash: string;
  providerId?: string;
  model?: string;
  profileFingerprint?: string;
  evidenceTurnId: string;
  evidenceObservedTurnCount: number;
  reportedInputTokens: number;
  rearmTokens: number;
  triggerTokens: number;
  observedAt?: string;
}

export interface ChatCompactionBreakerRepairActionInput {
  actionId: string;
  sessionId: string;
  dimensionHash: string;
  actorHash: string;
  consumedAt?: string;
}

export class ChatConversationSummaryRepository {
  private readonly getStmt;
  private readonly insertStmt;
  private readonly getByWindowKeyStmt;
  private readonly listByBranchStmt;
  private readonly listBySessionStmt;
  private readonly pruneSessionSummariesStmt;
  private readonly upsertStateStmt;
  private readonly getStateStmt;
  private readonly listStatesStmt;
  private readonly pruneSessionStatesStmt;
  private readonly getBreakerStmt;
  private readonly insertBreakerStmt;
  private readonly updateBreakerCasStmt;
  private readonly markBreakerCorruptStmt;
  private readonly getActionStmt;
  private readonly getPendingActionStmt;
  private readonly insertActionStmt;
  private readonly expireActionStmt;
  private readonly expirePendingActionsForKeyStmt;
  private readonly consumeActionStmt;
  private readonly rejectActionStmt;
  private readonly repairBreakerCasStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM chat_conversation_summaries WHERE summary_id = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO chat_conversation_summaries (
        summary_id, session_id, branch_head_turn_id, start_turn_id, end_turn_id, turn_ids_json,
        source_hash, window_key, token_estimate, summary_text, created_at, updated_at
      ) VALUES (
        @summaryId, @sessionId, @branchHeadTurnId, @startTurnId, @endTurnId, @turnIdsJson,
        @sourceHash, @windowKey, @tokenEstimate, @summary, @createdAt, @updatedAt
      )
      ON CONFLICT DO NOTHING
    `);
    this.getByWindowKeyStmt = db.prepare(`
      SELECT * FROM chat_conversation_summaries
      WHERE window_key = @windowKey
      LIMIT 1
    `);
    this.listByBranchStmt = db.prepare(`
      SELECT * FROM chat_conversation_summaries
      WHERE session_id = @sessionId
        AND branch_head_turn_id = @branchHeadTurnId
      ORDER BY created_at ASC
      LIMIT ${MAX_ROWS_PER_LOOKUP}
    `);
    this.listBySessionStmt = db.prepare(`
      SELECT * FROM chat_conversation_summaries
      WHERE session_id = @sessionId
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.pruneSessionSummariesStmt = db.prepare(`
      DELETE FROM chat_conversation_summaries
      WHERE session_id = @sessionId
        AND summary_id NOT IN (
          SELECT summary_id
          FROM chat_conversation_summaries
          WHERE session_id = @sessionId
          ORDER BY
            CASE WHEN window_key = @protectedWindowKey THEN 0 ELSE 1 END ASC,
            updated_at DESC,
            summary_id DESC
          LIMIT ${MAX_SUMMARY_ROWS_PER_SESSION}
        )
    `);
    this.upsertStateStmt = db.prepare(`
      INSERT INTO chat_compaction_states (
        state_key, session_id, dimension_hash, provider_id, model, profile_fingerprint,
        boundary_turn_ids_json, boundary_source_hash, baseline_input_tokens,
        last_observed_input_tokens, observed_turn_count, armed, created_at, updated_at
      ) VALUES (
        @stateKey, @sessionId, @dimensionHash, @providerId, @model, @profileFingerprint,
        @boundaryTurnIdsJson, @boundarySourceHash, @baselineInputTokens,
        @lastObservedInputTokens, @observedTurnCount, @armed, @createdAt, @updatedAt
      )
      ON CONFLICT(state_key) DO UPDATE SET
        baseline_input_tokens = CASE
          WHEN excluded.observed_turn_count > chat_compaction_states.observed_turn_count
          THEN excluded.baseline_input_tokens
          ELSE chat_compaction_states.baseline_input_tokens
        END,
        last_observed_input_tokens = CASE
          WHEN excluded.observed_turn_count > chat_compaction_states.observed_turn_count
          THEN excluded.last_observed_input_tokens
          ELSE chat_compaction_states.last_observed_input_tokens
        END,
        observed_turn_count = CASE
          WHEN excluded.observed_turn_count > chat_compaction_states.observed_turn_count
          THEN excluded.observed_turn_count
          ELSE chat_compaction_states.observed_turn_count
        END,
        armed = CASE
          WHEN excluded.observed_turn_count > chat_compaction_states.observed_turn_count
          THEN excluded.armed
          WHEN excluded.observed_turn_count = chat_compaction_states.observed_turn_count
            AND (excluded.armed = 0 OR chat_compaction_states.armed = 0)
          THEN 0
          ELSE chat_compaction_states.armed
        END,
        updated_at = CASE
          WHEN excluded.observed_turn_count >= chat_compaction_states.observed_turn_count
          THEN excluded.updated_at
          ELSE chat_compaction_states.updated_at
        END
    `);
    this.getStateStmt = db.prepare("SELECT * FROM chat_compaction_states WHERE state_key = ?");
    this.listStatesStmt = db.prepare(`
      SELECT * FROM chat_compaction_states
      WHERE session_id = @sessionId
        AND dimension_hash = @dimensionHash
      ORDER BY observed_turn_count DESC, updated_at DESC
      LIMIT ${MAX_ROWS_PER_LOOKUP}
    `);
    this.pruneSessionStatesStmt = db.prepare(`
      DELETE FROM chat_compaction_states
      WHERE session_id = @sessionId
        AND state_key NOT IN (
          SELECT pending_state_key
          FROM chat_compaction_breakers
          WHERE session_id = @sessionId
            AND pending_state_key IS NOT NULL
        )
        AND state_key NOT IN (
          SELECT state_key
          FROM chat_compaction_states
          WHERE session_id = @sessionId
          ORDER BY
            CASE WHEN state_key = @protectedStateKey THEN 0 ELSE 1 END ASC,
            observed_turn_count DESC,
            updated_at DESC,
            state_key DESC
          LIMIT ${MAX_STATE_ROWS_PER_SESSION}
        )
    `);
    this.getBreakerStmt = db.prepare(`
      SELECT *
      FROM chat_compaction_breakers
      WHERE session_id = @sessionId
        AND dimension_hash = @dimensionHash
      LIMIT 1
    `);
    this.insertBreakerStmt = db.prepare(`
      INSERT INTO chat_compaction_breakers (
        session_id, dimension_hash, provider_id, model, profile_fingerprint,
        status, fallback_streak, ineffective_streak,
        pending_attempt_id, pending_state_key, pending_branch_head_turn_id,
        pending_observed_turn_count, pending_disposition, pending_started_at,
        last_attempt_id, last_evidence_turn_id, last_evidence_input_tokens,
        last_outcome, revision, last_repaired_at, last_repair_reason, last_repaired_actor_hash,
        created_at, updated_at
      ) VALUES (
        @sessionId, @dimensionHash, @providerId, @model, @profileFingerprint,
        @status, @fallbackStreak, @ineffectiveStreak,
        @pendingAttemptId, @pendingStateKey, @pendingBranchHeadTurnId,
        @pendingObservedTurnCount, @pendingDisposition, @pendingStartedAt,
        @lastAttemptId, @lastEvidenceTurnId, @lastEvidenceInputTokens,
        @lastOutcome, @revision, @lastRepairedAt, @lastRepairReason, @lastRepairedActorHash,
        @createdAt, @updatedAt
      )
      ON CONFLICT(session_id, dimension_hash) DO NOTHING
    `);
    this.updateBreakerCasStmt = db.prepare(`
      UPDATE chat_compaction_breakers
      SET
        provider_id = @providerId,
        model = @model,
        profile_fingerprint = @profileFingerprint,
        status = @status,
        fallback_streak = @fallbackStreak,
        ineffective_streak = @ineffectiveStreak,
        pending_attempt_id = @pendingAttemptId,
        pending_state_key = @pendingStateKey,
        pending_branch_head_turn_id = @pendingBranchHeadTurnId,
        pending_observed_turn_count = @pendingObservedTurnCount,
        pending_disposition = @pendingDisposition,
        pending_started_at = @pendingStartedAt,
        last_attempt_id = @lastAttemptId,
        last_evidence_turn_id = @lastEvidenceTurnId,
        last_evidence_input_tokens = @lastEvidenceInputTokens,
        last_outcome = @lastOutcome,
        revision = @revision,
        last_repaired_at = @lastRepairedAt,
        last_repair_reason = @lastRepairReason,
        last_repaired_actor_hash = @lastRepairedActorHash,
        updated_at = @updatedAt
      WHERE session_id = @sessionId
        AND dimension_hash = @dimensionHash
        AND revision = @expectedRevision
    `);
    this.markBreakerCorruptStmt = db.prepare(`
      UPDATE chat_compaction_breakers
      SET
        provider_id = CASE
          WHEN provider_id IS NULL OR (length(trim(provider_id)) BETWEEN 1 AND ${MAX_ID_LENGTH})
          THEN provider_id
          ELSE NULL
        END,
        model = CASE
          WHEN model IS NULL OR (length(trim(model)) BETWEEN 1 AND ${MAX_ID_LENGTH})
          THEN model
          ELSE NULL
        END,
        profile_fingerprint = CASE
          WHEN profile_fingerprint IS NULL OR (length(trim(profile_fingerprint)) BETWEEN 1 AND ${MAX_HASH_LENGTH})
          THEN profile_fingerprint
          ELSE NULL
        END,
        status = 'blocked_corrupt',
        fallback_streak = ${MAX_BREAKER_STREAK},
        ineffective_streak = ${MAX_BREAKER_STREAK},
        quarantined_state_key = CASE
          WHEN pending_state_key IS NOT NULL THEN pending_state_key
          ELSE quarantined_state_key
        END,
        pending_attempt_id = NULL,
        pending_state_key = NULL,
        pending_branch_head_turn_id = NULL,
        pending_observed_turn_count = NULL,
        pending_disposition = NULL,
        pending_started_at = NULL,
        last_attempt_id = NULL,
        last_evidence_turn_id = NULL,
        last_evidence_input_tokens = NULL,
        last_outcome = 'unverified',
        revision = revision + 1,
        last_repaired_at = CASE
          WHEN last_repaired_at IS NULL OR (length(trim(last_repaired_at)) BETWEEN 1 AND 64)
          THEN last_repaired_at
          ELSE NULL
        END,
        last_repair_reason = CASE
          WHEN last_repair_reason IS NULL OR (length(trim(last_repair_reason)) BETWEEN 1 AND ${MAX_REPAIR_REASON_LENGTH})
          THEN last_repair_reason
          ELSE NULL
        END,
        last_repaired_actor_hash = CASE
          WHEN last_repaired_actor_hash IS NULL OR (length(trim(last_repaired_actor_hash)) BETWEEN 1 AND ${MAX_HASH_LENGTH})
          THEN last_repaired_actor_hash
          ELSE NULL
        END,
        created_at = CASE
          WHEN length(trim(created_at)) BETWEEN 1 AND 64 THEN created_at
          ELSE @updatedAt
        END,
        updated_at = @updatedAt
      WHERE session_id = @sessionId
        AND dimension_hash = @dimensionHash
    `);
    this.getActionStmt = db.prepare(`
      SELECT *
      FROM chat_compaction_breaker_actions
      WHERE action_id = @actionId
      LIMIT 1
    `);
    this.getPendingActionStmt = db.prepare(`
      SELECT *
      FROM chat_compaction_breaker_actions
      WHERE session_id = @sessionId
        AND dimension_hash = @dimensionHash
        AND action_kind = @actionKind
        AND status = 'pending'
      LIMIT 1
    `);
    this.insertActionStmt = db.prepare(`
      INSERT INTO chat_compaction_breaker_actions (
        action_id, session_id, dimension_hash, action_kind, expected_breaker_revision,
        actor_hash, request_evidence_hash, policy_decision_hash, audit_evidence_hash,
        approval_id, reason, status, rejection_reason, created_at, expires_at,
        consumed_at, resulting_attempt_id, resulting_breaker_revision,
        quarantined_state_key, updated_at
      ) VALUES (
        @actionId, @sessionId, @dimensionHash, @actionKind, @expectedBreakerRevision,
        @actorHash, @requestEvidenceHash, @policyDecisionHash, @auditEvidenceHash,
        @approvalId, @reason, @status, @rejectionReason, @createdAt, @expiresAt,
        NULL, NULL, NULL, NULL, @updatedAt
      )
    `);
    this.expireActionStmt = db.prepare(`
      UPDATE chat_compaction_breaker_actions
      SET status = 'expired', updated_at = @updatedAt
      WHERE action_id = @actionId
        AND status = 'pending'
        AND expires_at <= @updatedAt
    `);
    this.expirePendingActionsForKeyStmt = db.prepare(`
      UPDATE chat_compaction_breaker_actions
      SET status = 'expired', updated_at = @updatedAt
      WHERE session_id = @sessionId
        AND dimension_hash = @dimensionHash
        AND action_kind = @actionKind
        AND status = 'pending'
        AND expires_at <= @updatedAt
    `);
    this.consumeActionStmt = db.prepare(`
      UPDATE chat_compaction_breaker_actions
      SET status = 'consumed', consumed_at = @consumedAt,
        resulting_attempt_id = @resultingAttemptId,
        resulting_breaker_revision = @resultingBreakerRevision,
        quarantined_state_key = @quarantinedStateKey,
        updated_at = @consumedAt
      WHERE action_id = @actionId
        AND status = 'pending'
    `);
    this.rejectActionStmt = db.prepare(`
      UPDATE chat_compaction_breaker_actions
      SET status = 'rejected', rejection_reason = @rejectionReason, updated_at = @updatedAt
      WHERE action_id = @actionId
        AND status = 'pending'
    `);
    this.repairBreakerCasStmt = db.prepare(`
      UPDATE chat_compaction_breakers
      SET provider_id = @providerId,
        model = @model,
        profile_fingerprint = @profileFingerprint,
        status = 'tripped',
        fallback_streak = ${MAX_BREAKER_STREAK},
        ineffective_streak = ${MAX_BREAKER_STREAK},
        quarantined_state_key = NULL,
        pending_attempt_id = NULL,
        pending_state_key = NULL,
        pending_branch_head_turn_id = NULL,
        pending_observed_turn_count = NULL,
        pending_disposition = NULL,
        pending_started_at = NULL,
        last_attempt_id = NULL,
        last_evidence_turn_id = NULL,
        last_evidence_input_tokens = NULL,
        last_outcome = 'unverified',
        revision = revision + 1,
        last_repaired_at = @repairedAt,
        last_repair_reason = @reason,
        last_repaired_actor_hash = @actorHash,
        created_at = @createdAt,
        updated_at = @repairedAt
      WHERE session_id = @sessionId
        AND dimension_hash = @dimensionHash
        AND revision = @expectedRevision
    `);
  }

  public get(summaryId: string): ChatConversationSummaryRecord {
    assertBoundedString("summaryId", summaryId, MAX_ID_LENGTH);
    const record = mapSummaryRow(toChatConversationSummaryRow(this.getStmt.get(summaryId)));
    if (!record) {
      throw new NotFoundError({ entity: "Chat conversation summary", id: summaryId });
    }
    return record;
  }

  public upsert(input: ChatConversationSummaryUpsertInput): ChatConversationSummaryRecord {
    validateSummaryInput(input);
    const expectedWindowKey = buildConversationSummaryWindowKey(input.sessionId, input.turnIds, input.sourceHash);
    if (input.windowKey && input.windowKey !== expectedWindowKey) {
      throw new RangeError("windowKey must match the exact ordered turn ids and source hash");
    }
    const windowKey = input.windowKey ?? expectedWindowKey;
    const summaryId = input.summaryId ?? `chat-summary-${windowKey}`;
    const createdAt = input.createdAt ?? new Date().toISOString();
    const updatedAt = input.updatedAt ?? createdAt;
    return this.db.transaction("immediate", () => {
      this.insertStmt.run({
        summaryId,
        sessionId: input.sessionId,
        branchHeadTurnId: input.branchHeadTurnId,
        startTurnId: input.startTurnId,
        endTurnId: input.endTurnId,
        turnIdsJson: JSON.stringify(input.turnIds),
        sourceHash: input.sourceHash,
        windowKey,
        tokenEstimate: Math.floor(input.tokenEstimate),
        summary: input.summary,
        createdAt,
        updatedAt,
      });

      const persisted = this.findByWindowKey(windowKey);
      if (!persisted) {
        throw new NotFoundError("Failed to read chat conversation summary after idempotent insert");
      }
      this.pruneSessionSummariesStmt.run({
        sessionId: input.sessionId,
        protectedWindowKey: windowKey,
      });
      return persisted;
    });
  }

  public findReusableWindow(input: {
    sessionId: string;
    turnIds: string[];
    sourceHash: string;
  }): ChatConversationSummaryRecord | undefined {
    validateTurnIds(input.turnIds, MAX_SUMMARY_TURN_IDS);
    assertBoundedString("sessionId", input.sessionId, MAX_ID_LENGTH);
    assertBoundedString("sourceHash", input.sourceHash, MAX_HASH_LENGTH);
    const windowKey = buildConversationSummaryWindowKey(input.sessionId, input.turnIds, input.sourceHash);
    const exact = this.findByWindowKey(windowKey);
    if (
      exact &&
      exact.sessionId === input.sessionId &&
      exact.sourceHash === input.sourceHash &&
      arraysEqual(exact.turnIds, input.turnIds)
    ) {
      return exact;
    }
    // Compatibility with pre-window-key rows. The scan is deliberately bounded.
    return this.listBySession(input.sessionId, MAX_ROWS_PER_LOOKUP).find(
      (summary) => summary.sourceHash === input.sourceHash && arraysEqual(summary.turnIds, input.turnIds),
    );
  }

  public listByBranch(sessionId: string, branchHeadTurnId: string): ChatConversationSummaryRecord[] {
    assertBoundedString("sessionId", sessionId, MAX_ID_LENGTH);
    assertBoundedString("branchHeadTurnId", branchHeadTurnId, MAX_ID_LENGTH);
    return mapSummaryRows(this.listByBranchStmt.all({ sessionId, branchHeadTurnId }));
  }

  public listBySession(sessionId: string, limit = 50): ChatConversationSummaryRecord[] {
    assertBoundedString("sessionId", sessionId, MAX_ID_LENGTH);
    return mapSummaryRows(
      this.listBySessionStmt.all({ sessionId, limit: Math.max(1, Math.min(limit, MAX_ROWS_PER_LOOKUP)) }),
    );
  }

  public upsertCompactionState(input: ChatCompactionStateUpsertInput): ChatCompactionStateRecord {
    validateCompactionStateInput(input);
    const expectedStateKey = buildChatCompactionStateKey(
      input.sessionId,
      input.dimensionHash,
      input.boundaryTurnIds,
      input.boundarySourceHash,
    );
    if (input.stateKey !== expectedStateKey) {
      throw new RangeError("stateKey must match the exact compaction boundary and dimension");
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const updatedAt = input.updatedAt ?? createdAt;
    return this.db.transaction("immediate", () => {
      const persisted = this.writeCompactionState(input, createdAt, updatedAt);
      this.pruneSessionStatesStmt.run({
        sessionId: input.sessionId,
        protectedStateKey: input.stateKey,
      });
      return persisted;
    });
  }

  public listCompactionStates(sessionId: string, dimensionHash: string): ChatCompactionStateRecord[] {
    assertBoundedString("sessionId", sessionId, MAX_ID_LENGTH);
    assertBoundedString("dimensionHash", dimensionHash, MAX_HASH_LENGTH);
    return mapCompactionStateRows(this.listStatesStmt.all({ sessionId, dimensionHash }));
  }

  public getCompactionBreaker(sessionId: string, dimensionHash: string): ChatCompactionBreakerRecord | undefined {
    assertBoundedString("sessionId", sessionId, MAX_ID_LENGTH);
    assertBoundedString("dimensionHash", dimensionHash, MAX_HASH_LENGTH);
    return this.db.transaction("immediate", () => this.readAndValidateBreaker(sessionId, dimensionHash));
  }

  public createCompactionBreakerAction(
    input: ChatCompactionBreakerActionCreateInput,
  ): ChatCompactionBreakerActionRecord {
    validateCompactionBreakerActionCreateInput(input);
    return this.db.transaction("immediate", () => {
      const rawValue = this.getBreakerStmt.get({
        sessionId: input.sessionId,
        dimensionHash: input.dimensionHash,
      });
      if (rawValue === undefined) {
        throw new NotFoundError({
          entity: "Chat compaction breaker",
          id: `${input.sessionId}/${input.dimensionHash}`,
        });
      }
      const raw = toChatCompactionBreakerRow(rawValue);
      const useStableCorruptSnapshot = input.actionKind === "repair" && raw?.status === "blocked_corrupt";
      const current = useStableCorruptSnapshot
        ? undefined
        : this.readAndValidateBreaker(input.sessionId, input.dimensionHash);
      const revision = useStableCorruptSnapshot ? Number(raw.revision) : current?.revision;
      if (!Number.isSafeInteger(revision) || revision !== input.expectedBreakerRevision) {
        throwBreakerRevisionConflict();
      }
      if (input.actionKind === "force" && (!current || current.status !== "tripped")) {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: "A force action is recovery-only and requires an exactly tripped compaction breaker",
        });
      }
      if (
        input.actionKind === "repair" &&
        (useStableCorruptSnapshot ? raw.status : current?.status) !== "blocked_corrupt"
      ) {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: "A repair action is recovery-only and requires blocked corrupt compaction state",
        });
      }

      this.expirePendingActionsForKeyStmt.run({
        sessionId: input.sessionId,
        dimensionHash: input.dimensionHash,
        actionKind: input.actionKind,
        updatedAt: input.createdAt,
      });
      if (
        input.status === "pending" &&
        toChatCompactionBreakerActionRow(
          this.getPendingActionStmt.get({
            sessionId: input.sessionId,
            dimensionHash: input.dimensionHash,
            actionKind: input.actionKind,
          }),
        )
      ) {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: "A pending compaction breaker action already exists for this kind and dimension",
        });
      }

      try {
        this.insertActionStmt.run({
          ...input,
          approvalId: input.approvalId ?? null,
          rejectionReason: input.rejectionReason ?? null,
          updatedAt: input.createdAt,
        });
      } catch (error) {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: `Compaction breaker action could not be persisted: ${error instanceof Error ? error.message : "conflict"}`,
        });
      }
      return this.requireMappedAction(input.actionId);
    });
  }

  public getCompactionBreakerAction(
    actionId: string,
    observedAt = new Date().toISOString(),
  ): ChatCompactionBreakerActionRecord {
    assertBoundedString("actionId", actionId, MAX_ID_LENGTH);
    assertIsoTimestamp("observedAt", observedAt);
    return this.db.transaction("immediate", () => {
      this.expireActionStmt.run({ actionId, updatedAt: observedAt });
      return this.requireMappedAction(actionId);
    });
  }

  public validatePendingCompactionBreakerForceAction(input: {
    sessionId: string;
    dimensionHash: string;
    actionId: string;
    actorHash: string;
    observedAt?: string;
  }): { action: ChatCompactionBreakerActionRecord; breaker: ChatCompactionBreakerRecord } {
    validateForceActionReference(input);
    const observedAt = input.observedAt ?? new Date().toISOString();
    assertIsoTimestamp("observedAt", observedAt);
    return this.db.transaction("immediate", () => {
      const breaker = this.readAndValidateBreaker(input.sessionId, input.dimensionHash);
      if (!breaker) {
        throw new NotFoundError({
          entity: "Chat compaction breaker",
          id: `${input.sessionId}/${input.dimensionHash}`,
        });
      }
      if (breaker.status !== "tripped") {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: "A force action is recovery-only and requires an exactly tripped compaction breaker",
        });
      }
      const action = this.requirePendingAction({ ...input, actionKind: "force", breaker, observedAt });
      return { action, breaker };
    });
  }

  public findPendingCompactionBreakerForceAction(input: {
    sessionId: string;
    dimensionHash: string;
    actorHash: string;
    observedAt?: string;
  }): ChatCompactionBreakerActionRecord | undefined {
    assertBoundedString("sessionId", input.sessionId, MAX_ID_LENGTH);
    assertBoundedString("dimensionHash", input.dimensionHash, MAX_HASH_LENGTH);
    assertBoundedString("actorHash", input.actorHash, MAX_HASH_LENGTH);
    const observedAt = input.observedAt ?? new Date().toISOString();
    assertIsoTimestamp("observedAt", observedAt);
    return this.db.transaction("immediate", () => {
      this.expirePendingActionsForKeyStmt.run({
        sessionId: input.sessionId,
        dimensionHash: input.dimensionHash,
        actionKind: "force",
        updatedAt: observedAt,
      });
      const action = mapCompactionBreakerActionRow(
        toChatCompactionBreakerActionRow(
          this.getPendingActionStmt.get({
            sessionId: input.sessionId,
            dimensionHash: input.dimensionHash,
            actionKind: "force",
          }),
        ),
      );
      if (!action || action.actorHash !== input.actorHash) {
        return undefined;
      }
      const breaker = this.readAndValidateBreaker(input.sessionId, input.dimensionHash);
      if (!breaker || breaker.status !== "tripped" || breaker.revision !== action.expectedBreakerRevision) {
        this.rejectActionStmt.run({
          actionId: action.actionId,
          rejectionReason: "Force action became stale before sealed Chat attachment",
          updatedAt: observedAt,
        });
        return undefined;
      }
      return action;
    });
  }

  public commitCompactionBoundary(input: ChatCompactionBoundaryCommitInput): {
    state: ChatCompactionStateRecord;
    breaker: ChatCompactionBreakerRecord;
  } {
    validateCompactionStateInput(input.state);
    assertBoundedString("attemptId", input.attemptId, MAX_HASH_LENGTH);
    assertBoundedString("branchHeadTurnId", input.branchHeadTurnId, MAX_ID_LENGTH);
    if (input.disposition !== "structured" && input.disposition !== "fallback") {
      throw new RangeError("Compaction boundary disposition must be structured or fallback");
    }
    if (input.forceAction && input.disposition !== "structured") {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "A force action requires an exact structured compaction result",
      });
    }
    if (input.forceAction) {
      validateForceActionReference(input.forceAction);
    }
    if (input.startedAt) {
      assertBoundedString("startedAt", input.startedAt, 64);
    }
    const expectedStateKey = buildChatCompactionStateKey(
      input.state.sessionId,
      input.state.dimensionHash,
      input.state.boundaryTurnIds,
      input.state.boundarySourceHash,
    );
    if (input.state.stateKey !== expectedStateKey) {
      throw new RangeError("stateKey must match the exact compaction boundary and dimension");
    }
    const expectedAttemptId = buildChatCompactionAttemptId({
      sessionId: input.state.sessionId,
      dimensionHash: input.state.dimensionHash,
      ...(input.state.providerId ? { providerId: input.state.providerId } : {}),
      ...(input.state.model ? { model: input.state.model } : {}),
      ...(input.state.profileFingerprint ? { profileFingerprint: input.state.profileFingerprint } : {}),
      branchHeadTurnId: input.branchHeadTurnId,
      observedTurnCount: input.state.observedTurnCount,
      boundarySourceHash: input.state.boundarySourceHash,
      disposition: input.disposition,
    });
    if (input.attemptId !== expectedAttemptId) {
      throw new RangeError("attemptId must match the exact compaction boundary attempt");
    }
    const now = input.startedAt ?? new Date().toISOString();
    return this.db.transaction("immediate", () => {
      const current = this.readAndValidateBreaker(input.state.sessionId, input.state.dimensionHash);
      if (current?.pendingAttemptId === input.attemptId || current?.lastAttemptId === input.attemptId) {
        if (input.forceAction) {
          this.assertForceActionReplay({
            ...input.forceAction,
            sessionId: input.state.sessionId,
            dimensionHash: input.state.dimensionHash,
            attemptId: input.attemptId,
            expectedStatus: "consumed",
          });
        }
        const existingState = mapCompactionStateRow(
          toChatCompactionStateRow(this.getStateStmt.get(input.state.stateKey)),
        );
        if (!existingState) {
          return this.blockCorruptAndThrow(input.state.sessionId, input.state.dimensionHash, now);
        }
        return { state: existingState, breaker: current };
      }
      assertBreakerExpectedRevision(current, input.expectedBreakerRevision);
      assertBreakerDimension(current, input.state);
      const forceAction = input.forceAction
        ? this.requirePendingAction({
            ...input.forceAction,
            sessionId: input.state.sessionId,
            dimensionHash: input.state.dimensionHash,
            actionKind: "force",
            ...(current ? { breaker: current } : { breakerRevision: -1 }),
            observedAt: now,
          })
        : undefined;
      if (forceAction && current?.status !== "tripped") {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: "A force action is recovery-only and requires an exactly tripped compaction breaker",
        });
      }
      if (!forceAction && current && (current.status === "tripped" || current.status === "blocked_corrupt")) {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: "Automatic chat compaction is blocked by its durable breaker",
        });
      }
      if (current?.pendingAttemptId) {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: "Chat compaction already has a boundary awaiting exact provider evidence",
        });
      }
      if (forceAction && current?.status === "blocked_corrupt") {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: "A force action cannot bypass corrupt compaction state; repair is required first",
        });
      }

      const state = this.writeCompactionState(input.state, input.state.createdAt ?? now, input.state.updatedAt ?? now);
      const fallbackStreak =
        input.disposition === "fallback"
          ? Math.min(MAX_BREAKER_STREAK, (current?.fallbackStreak ?? 0) + 1)
          : (current?.fallbackStreak ?? 0);
      const next: ChatCompactionBreakerRecord = {
        sessionId: input.state.sessionId,
        dimensionHash: input.state.dimensionHash,
        ...(input.state.providerId ? { providerId: input.state.providerId } : {}),
        ...(input.state.model ? { model: input.state.model } : {}),
        ...(input.state.profileFingerprint ? { profileFingerprint: input.state.profileFingerprint } : {}),
        // A committed boundary always waits for the first exact descendant
        // provider observation. The saturated fallback streak becomes
        // `tripped` when that pending evidence is consumed; while pending,
        // `awaiting_evidence` already blocks another automatic attempt.
        status: "awaiting_evidence",
        fallbackStreak,
        ineffectiveStreak: current?.ineffectiveStreak ?? 0,
        pendingAttemptId: input.attemptId,
        pendingStateKey: state.stateKey,
        pendingBranchHeadTurnId: input.branchHeadTurnId,
        pendingObservedTurnCount: input.state.observedTurnCount,
        pendingDisposition: input.disposition,
        pendingStartedAt: now,
        lastAttemptId: input.attemptId,
        ...(current?.lastEvidenceTurnId ? { lastEvidenceTurnId: current.lastEvidenceTurnId } : {}),
        ...(current?.lastEvidenceInputTokens !== undefined
          ? { lastEvidenceInputTokens: current.lastEvidenceInputTokens }
          : {}),
        lastOutcome: input.disposition === "fallback" ? "fallback" : "unverified",
        revision: (current?.revision ?? -1) + 1,
        ...(current?.lastRepairedAt ? { lastRepairedAt: current.lastRepairedAt } : {}),
        ...(current?.lastRepairReason ? { lastRepairReason: current.lastRepairReason } : {}),
        ...(current?.lastRepairedActorHash ? { lastRepairedActorHash: current.lastRepairedActorHash } : {}),
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      const breaker = this.writeBreaker(current, next);
      if (forceAction) {
        const consumed = this.consumeActionStmt.run({
          actionId: forceAction.actionId,
          consumedAt: now,
          resultingAttemptId: input.attemptId,
          resultingBreakerRevision: breaker.revision,
          quarantinedStateKey: null,
        });
        if (consumed.changes !== 1) {
          throw new ConflictError({
            code: "STATE_CONFLICT",
            message: "Compaction breaker force action was consumed concurrently",
          });
        }
      }
      this.pruneSessionStatesStmt.run({ sessionId: state.sessionId, protectedStateKey: state.stateKey });
      return { state, breaker };
    });
  }

  public recordCompactionNoProgress(input: ChatCompactionNoProgressInput): ChatCompactionBreakerRecord {
    validateBreakerIdentity(input);
    assertBoundedString("attemptId", input.attemptId, MAX_HASH_LENGTH);
    assertBoundedString("branchHeadTurnId", input.branchHeadTurnId, MAX_ID_LENGTH);
    assertNonNegativeInteger("observedTurnCount", input.observedTurnCount);
    assertBoundedString("attemptedBoundarySourceHash", input.attemptedBoundarySourceHash, MAX_HASH_LENGTH);
    if (input.forceAction) {
      validateForceActionReference(input.forceAction);
    }
    const expectedAttemptId = buildChatCompactionAttemptId({
      sessionId: input.sessionId,
      dimensionHash: input.dimensionHash,
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.profileFingerprint ? { profileFingerprint: input.profileFingerprint } : {}),
      branchHeadTurnId: input.branchHeadTurnId,
      observedTurnCount: input.observedTurnCount,
      boundarySourceHash: input.attemptedBoundarySourceHash,
      disposition: "no_progress",
    });
    if (input.attemptId !== expectedAttemptId) {
      throw new RangeError("attemptId must match the exact no-progress compaction attempt");
    }
    if (input.occurredAt) {
      assertBoundedString("occurredAt", input.occurredAt, 64);
    }
    const now = input.occurredAt ?? new Date().toISOString();
    return this.db.transaction("immediate", () => {
      const current = this.readAndValidateBreaker(input.sessionId, input.dimensionHash);
      if (current?.lastAttemptId === input.attemptId) {
        if (input.forceAction) {
          this.assertForceActionReplay({
            ...input.forceAction,
            sessionId: input.sessionId,
            dimensionHash: input.dimensionHash,
            attemptId: input.attemptId,
            expectedStatus: "rejected",
          });
        }
        return current;
      }
      assertBreakerExpectedRevision(current, input.expectedBreakerRevision);
      assertBreakerDimension(current, input);
      const forceAction = input.forceAction
        ? this.requirePendingAction({
            ...input.forceAction,
            sessionId: input.sessionId,
            dimensionHash: input.dimensionHash,
            actionKind: "force",
            ...(current ? { breaker: current } : { breakerRevision: -1 }),
            observedAt: now,
          })
        : undefined;
      if (forceAction && current?.status !== "tripped") {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: "A force action is recovery-only and requires an exactly tripped compaction breaker",
        });
      }
      if (!forceAction && current && current.status !== "closed") {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: "Automatic chat compaction is blocked or awaiting evidence",
        });
      }
      const ineffectiveStreak = forceAction
        ? MAX_BREAKER_STREAK
        : Math.min(MAX_BREAKER_STREAK, (current?.ineffectiveStreak ?? 0) + 1);
      const next: ChatCompactionBreakerRecord = {
        sessionId: input.sessionId,
        dimensionHash: input.dimensionHash,
        ...(input.providerId ? { providerId: input.providerId } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.profileFingerprint ? { profileFingerprint: input.profileFingerprint } : {}),
        status:
          forceAction || ineffectiveStreak >= MAX_BREAKER_STREAK || (current?.fallbackStreak ?? 0) >= MAX_BREAKER_STREAK
            ? "tripped"
            : "closed",
        fallbackStreak: current?.fallbackStreak ?? 0,
        ineffectiveStreak,
        lastAttemptId: input.attemptId,
        ...(current?.lastEvidenceTurnId ? { lastEvidenceTurnId: current.lastEvidenceTurnId } : {}),
        ...(current?.lastEvidenceInputTokens !== undefined
          ? { lastEvidenceInputTokens: current.lastEvidenceInputTokens }
          : {}),
        lastOutcome: "no_progress",
        revision: (current?.revision ?? -1) + 1,
        ...(current?.lastRepairedAt ? { lastRepairedAt: current.lastRepairedAt } : {}),
        ...(current?.lastRepairReason ? { lastRepairReason: current.lastRepairReason } : {}),
        ...(current?.lastRepairedActorHash ? { lastRepairedActorHash: current.lastRepairedActorHash } : {}),
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      const breaker = this.writeBreaker(current, next);
      if (forceAction) {
        const rejected = this.rejectActionStmt.run({
          actionId: forceAction.actionId,
          rejectionReason: "Forced compaction produced no exact structured boundary",
          updatedAt: now,
        });
        if (rejected.changes !== 1) {
          throw new ConflictError({
            code: "STATE_CONFLICT",
            message: "Compaction breaker force action was settled concurrently",
          });
        }
      }
      return breaker;
    });
  }

  public observeCompactionEvidence(input: ChatCompactionEvidenceInput): ChatCompactionBreakerRecord | undefined {
    validateBreakerIdentity(input);
    assertBoundedString("evidenceTurnId", input.evidenceTurnId, MAX_ID_LENGTH);
    for (const [label, value] of [
      ["evidenceObservedTurnCount", input.evidenceObservedTurnCount],
      ["reportedInputTokens", input.reportedInputTokens],
      ["rearmTokens", input.rearmTokens],
      ["triggerTokens", input.triggerTokens],
    ] as const) {
      assertNonNegativeInteger(label, value);
    }
    if (input.rearmTokens >= input.triggerTokens) {
      throw new RangeError("Compaction rearm threshold must be below its trigger threshold");
    }
    if (input.observedAt) {
      assertBoundedString("observedAt", input.observedAt, 64);
    }
    const now = input.observedAt ?? new Date().toISOString();
    return this.db.transaction("immediate", () => {
      const current = this.readAndValidateBreaker(input.sessionId, input.dimensionHash);
      if (!current?.pendingAttemptId) {
        return current;
      }
      assertBreakerDimension(current, input);
      if (
        current.lastEvidenceTurnId === input.evidenceTurnId ||
        input.evidenceObservedTurnCount <= (current.pendingObservedTurnCount ?? Number.MAX_SAFE_INTEGER)
      ) {
        return current;
      }
      if (input.reportedInputTokens > input.rearmTokens && input.reportedInputTokens < input.triggerTokens) {
        return current;
      }

      const structuredHealthy =
        current.pendingDisposition === "structured" && input.reportedInputTokens <= input.rearmTokens;
      const ineffective = input.reportedInputTokens >= input.triggerTokens;
      const fallbackStreak = structuredHealthy ? 0 : current.fallbackStreak;
      const ineffectiveStreak = ineffective
        ? Math.min(MAX_BREAKER_STREAK, current.ineffectiveStreak + 1)
        : input.reportedInputTokens <= input.rearmTokens
          ? 0
          : current.ineffectiveStreak;
      const lastOutcome: ChatCompactionAttemptOutcome = ineffective
        ? "ineffective"
        : structuredHealthy
          ? "healthy"
          : current.pendingDisposition === "fallback"
            ? "fallback"
            : "unverified";
      const status: ChatCompactionBreakerStatus =
        fallbackStreak >= MAX_BREAKER_STREAK || ineffectiveStreak >= MAX_BREAKER_STREAK ? "tripped" : "closed";
      const next: ChatCompactionBreakerRecord = {
        ...current,
        status,
        fallbackStreak,
        ineffectiveStreak,
        lastAttemptId: current.pendingAttemptId,
        lastEvidenceTurnId: input.evidenceTurnId,
        lastEvidenceInputTokens: input.reportedInputTokens,
        lastOutcome,
        revision: current.revision + 1,
        updatedAt: now,
      };
      delete next.pendingAttemptId;
      delete next.pendingStateKey;
      delete next.pendingBranchHeadTurnId;
      delete next.pendingObservedTurnCount;
      delete next.pendingDisposition;
      delete next.pendingStartedAt;
      return this.writeBreaker(current, next);
    });
  }

  public consumeCompactionBreakerRepairAction(input: ChatCompactionBreakerRepairActionInput): {
    action: ChatCompactionBreakerActionRecord;
    breaker: ChatCompactionBreakerRecord;
  } {
    validateForceActionReference(input);
    const now = input.consumedAt ?? new Date().toISOString();
    assertIsoTimestamp("consumedAt", now);
    return this.db.transaction("immediate", () => {
      const raw = toChatCompactionBreakerRow(
        this.getBreakerStmt.get({ sessionId: input.sessionId, dimensionHash: input.dimensionHash }),
      );
      if (!raw) {
        throw new NotFoundError({
          entity: "Chat compaction breaker",
          id: `${input.sessionId}/${input.dimensionHash}`,
        });
      }
      const revision = Number(raw.revision);
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throwBreakerRevisionConflict();
      }
      const action = this.requirePendingAction({
        ...input,
        actionKind: "repair",
        breakerRevision: revision,
        observedAt: now,
      });
      const quarantinedStateKey =
        typeof raw.quarantined_state_key === "string" &&
        isBoundedStoredString(raw.quarantined_state_key, MAX_HASH_LENGTH)
          ? raw.quarantined_state_key
          : typeof raw.pending_state_key === "string" && isBoundedStoredString(raw.pending_state_key, MAX_HASH_LENGTH)
            ? raw.pending_state_key
            : this.findCorruptCompactionStateKey(input.sessionId, input.dimensionHash);
      const repairResult = this.repairBreakerCasStmt.run({
        sessionId: input.sessionId,
        dimensionHash: input.dimensionHash,
        expectedRevision: revision,
        providerId:
          typeof raw.provider_id === "string" && isBoundedStoredString(raw.provider_id, MAX_ID_LENGTH)
            ? raw.provider_id
            : null,
        model: typeof raw.model === "string" && isBoundedStoredString(raw.model, MAX_ID_LENGTH) ? raw.model : null,
        profileFingerprint:
          typeof raw.profile_fingerprint === "string" && isBoundedStoredString(raw.profile_fingerprint, MAX_HASH_LENGTH)
            ? raw.profile_fingerprint
            : null,
        createdAt: isBoundedStoredString(raw.created_at, 64) ? raw.created_at : now,
        repairedAt: now,
        reason: action.reason,
        actorHash: action.actorHash,
      });
      if (repairResult.changes !== 1) {
        throwBreakerRevisionConflict();
      }
      const resultingRevision = revision + 1;
      const consumed = this.consumeActionStmt.run({
        actionId: action.actionId,
        consumedAt: now,
        resultingAttemptId: null,
        resultingBreakerRevision: resultingRevision,
        quarantinedStateKey: quarantinedStateKey ?? null,
      });
      if (consumed.changes !== 1) {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: "Compaction breaker repair action was consumed concurrently",
        });
      }
      const breaker = mapCompactionBreakerRow(
        toChatCompactionBreakerRow(
          this.getBreakerStmt.get({ sessionId: input.sessionId, dimensionHash: input.dimensionHash }),
        ),
      );
      if (!breaker) {
        throw new NotFoundError("Failed to read chat compaction breaker after governed repair");
      }
      return { action: this.requireMappedAction(action.actionId), breaker };
    });
  }

  private writeCompactionState(
    input: ChatCompactionStateUpsertInput,
    createdAt: string,
    updatedAt: string,
  ): ChatCompactionStateRecord {
    this.upsertStateStmt.run({
      stateKey: input.stateKey,
      sessionId: input.sessionId,
      dimensionHash: input.dimensionHash,
      providerId: input.providerId ?? null,
      model: input.model ?? null,
      profileFingerprint: input.profileFingerprint ?? null,
      boundaryTurnIdsJson: JSON.stringify(input.boundaryTurnIds),
      boundarySourceHash: input.boundarySourceHash,
      baselineInputTokens: Math.floor(input.baselineInputTokens),
      lastObservedInputTokens: Math.floor(input.lastObservedInputTokens),
      observedTurnCount: Math.floor(input.observedTurnCount),
      armed: input.armed ? 1 : 0,
      createdAt,
      updatedAt,
    });
    const persisted = mapCompactionStateRow(toChatCompactionStateRow(this.getStateStmt.get(input.stateKey)));
    if (!persisted) {
      throw new NotFoundError("Failed to read chat compaction state after upsert");
    }
    return persisted;
  }

  private readAndValidateBreaker(sessionId: string, dimensionHash: string): ChatCompactionBreakerRecord | undefined {
    const rawValue = this.getBreakerStmt.get({ sessionId, dimensionHash });
    if (rawValue === undefined) {
      return undefined;
    }
    const raw = toChatCompactionBreakerRow(rawValue);
    if (!raw) {
      return this.markBreakerCorrupt(sessionId, dimensionHash, new Date().toISOString());
    }
    const mapped = mapCompactionBreakerRow(raw);
    if (!mapped) {
      return this.markBreakerCorrupt(sessionId, dimensionHash, new Date().toISOString(), raw);
    }
    if (mapped.pendingStateKey) {
      const state = mapCompactionStateRow(toChatCompactionStateRow(this.getStateStmt.get(mapped.pendingStateKey)));
      if (!state || state.sessionId !== sessionId || state.dimensionHash !== dimensionHash) {
        return this.markBreakerCorrupt(sessionId, dimensionHash, new Date().toISOString(), raw);
      }
    }
    return mapped;
  }

  private markBreakerCorrupt(
    sessionId: string,
    dimensionHash: string,
    updatedAt: string,
    raw?: ChatCompactionBreakerRow,
  ): ChatCompactionBreakerRecord {
    this.markBreakerCorruptStmt.run({ sessionId, dimensionHash, updatedAt });
    const marked = mapCompactionBreakerRow(
      toChatCompactionBreakerRow(this.getBreakerStmt.get({ sessionId, dimensionHash })),
    );
    if (marked) {
      return marked;
    }
    return {
      sessionId,
      dimensionHash,
      status: "blocked_corrupt",
      fallbackStreak: MAX_BREAKER_STREAK,
      ineffectiveStreak: MAX_BREAKER_STREAK,
      lastOutcome: "unverified",
      revision: raw && Number.isSafeInteger(Number(raw.revision)) ? Number(raw.revision) + 1 : 0,
      createdAt: raw && isBoundedStoredString(raw.created_at, 64) ? raw.created_at : updatedAt,
      updatedAt,
    };
  }

  private blockCorruptAndThrow(sessionId: string, dimensionHash: string, updatedAt: string): never {
    const raw = toChatCompactionBreakerRow(this.getBreakerStmt.get({ sessionId, dimensionHash }));
    if (raw) {
      this.markBreakerCorrupt(sessionId, dimensionHash, updatedAt, raw);
    }
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Chat compaction breaker references missing or corrupt boundary state",
    });
  }

  private writeBreaker(
    current: ChatCompactionBreakerRecord | undefined,
    next: ChatCompactionBreakerRecord,
  ): ChatCompactionBreakerRecord {
    const params = breakerWriteParams(next);
    const result = current
      ? (() => {
          const { createdAt: _createdAt, ...updateParams } = params;
          return this.updateBreakerCasStmt.run({ ...updateParams, expectedRevision: current.revision });
        })()
      : this.insertBreakerStmt.run(params);
    if (result.changes !== 1) {
      throwBreakerRevisionConflict();
    }
    const persisted = mapCompactionBreakerRow(
      toChatCompactionBreakerRow(
        this.getBreakerStmt.get({ sessionId: next.sessionId, dimensionHash: next.dimensionHash }),
      ),
    );
    if (!persisted) {
      throw new NotFoundError("Failed to read chat compaction breaker after write");
    }
    return persisted;
  }

  private requireMappedAction(actionId: string): ChatCompactionBreakerActionRecord {
    const action = mapCompactionBreakerActionRow(
      toChatCompactionBreakerActionRow(this.getActionStmt.get({ actionId })),
    );
    if (!action) {
      throw new NotFoundError({ entity: "Chat compaction breaker action", id: actionId });
    }
    return action;
  }

  private requirePendingAction(input: {
    actionId: string;
    actorHash: string;
    sessionId: string;
    dimensionHash: string;
    actionKind: ChatCompactionBreakerActionKind;
    breaker?: ChatCompactionBreakerRecord;
    breakerRevision?: number;
    observedAt: string;
  }): ChatCompactionBreakerActionRecord {
    this.expireActionStmt.run({ actionId: input.actionId, updatedAt: input.observedAt });
    const action = this.requireMappedAction(input.actionId);
    const breakerRevision = input.breaker?.revision ?? input.breakerRevision;
    if (
      action.status !== "pending" ||
      action.sessionId !== input.sessionId ||
      action.dimensionHash !== input.dimensionHash ||
      action.actionKind !== input.actionKind ||
      action.actorHash !== input.actorHash ||
      action.expectedBreakerRevision !== breakerRevision
    ) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Compaction breaker action is stale, settled, or not bound to this actor and dimension",
      });
    }
    return action;
  }

  private assertForceActionReplay(input: {
    actionId: string;
    actorHash: string;
    sessionId: string;
    dimensionHash: string;
    attemptId: string;
    expectedStatus: "consumed" | "rejected";
  }): void {
    const action = this.requireMappedAction(input.actionId);
    if (
      action.actionKind !== "force" ||
      action.status !== input.expectedStatus ||
      action.actorHash !== input.actorHash ||
      action.sessionId !== input.sessionId ||
      action.dimensionHash !== input.dimensionHash ||
      (input.expectedStatus === "consumed" && action.resultingAttemptId !== input.attemptId)
    ) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Compaction breaker force replay does not match the settled governed action",
      });
    }
  }

  private findCorruptCompactionStateKey(sessionId: string, dimensionHash: string): string | undefined {
    const rows = this.listStatesStmt.all({ sessionId, dimensionHash });
    if (!Array.isArray(rows)) {
      return undefined;
    }
    for (const value of rows) {
      const row = toChatCompactionStateRow(value);
      if (row && !mapCompactionStateRow(row) && isBoundedStoredString(row.state_key, MAX_HASH_LENGTH)) {
        return row.state_key;
      }
      if (
        !row &&
        isRecord(value) &&
        typeof value.state_key === "string" &&
        isBoundedStoredString(value.state_key, MAX_HASH_LENGTH)
      ) {
        return value.state_key;
      }
    }
    return undefined;
  }

  private findByWindowKey(windowKey: string): ChatConversationSummaryRecord | undefined {
    assertBoundedString("windowKey", windowKey, MAX_HASH_LENGTH);
    return mapSummaryRow(toChatConversationSummaryRow(this.getByWindowKeyStmt.get({ windowKey })));
  }
}

export function buildConversationSummaryWindowKey(sessionId: string, turnIds: string[], sourceHash: string): string {
  return createHash("sha256")
    .update(JSON.stringify([sessionId, turnIds, sourceHash]))
    .digest("hex");
}

export function buildChatCompactionStateKey(
  sessionId: string,
  dimensionHash: string,
  boundaryTurnIds: string[],
  boundarySourceHash: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([sessionId, dimensionHash, boundaryTurnIds, boundarySourceHash]))
    .digest("hex");
}

export function buildChatCompactionAttemptId(input: {
  sessionId: string;
  dimensionHash: string;
  providerId?: string;
  model?: string;
  profileFingerprint?: string;
  branchHeadTurnId: string;
  observedTurnCount: number;
  boundarySourceHash: string;
  disposition: ChatCompactionAttemptDisposition;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        sessionId: input.sessionId,
        dimensionHash: input.dimensionHash,
        providerId: input.providerId ?? null,
        model: input.model ?? null,
        profileFingerprint: input.profileFingerprint ?? null,
        branchHeadTurnId: input.branchHeadTurnId,
        observedTurnCount: input.observedTurnCount,
        boundarySourceHash: input.boundarySourceHash,
        disposition: input.disposition,
      }),
    )
    .digest("hex");
}

function validateSummaryInput(input: ChatConversationSummaryUpsertInput): void {
  if (input.summaryId) {
    assertBoundedString("summaryId", input.summaryId, MAX_ID_LENGTH);
  }
  if (input.windowKey) {
    assertBoundedString("windowKey", input.windowKey, MAX_HASH_LENGTH);
  }
  for (const [label, value] of [
    ["sessionId", input.sessionId],
    ["branchHeadTurnId", input.branchHeadTurnId],
    ["startTurnId", input.startTurnId],
    ["endTurnId", input.endTurnId],
  ] as const) {
    assertBoundedString(label, value, MAX_ID_LENGTH);
  }
  validateTurnIds(input.turnIds, MAX_SUMMARY_TURN_IDS);
  if (input.turnIds[0] !== input.startTurnId || input.turnIds.at(-1) !== input.endTurnId) {
    throw new RangeError("Summary turn bounds must match the ordered turn id list");
  }
  assertBoundedString("sourceHash", input.sourceHash, MAX_HASH_LENGTH);
  assertBoundedString("summary", input.summary, MAX_SUMMARY_TEXT_LENGTH);
  assertNonNegativeInteger("tokenEstimate", input.tokenEstimate);
  if (input.createdAt) {
    assertBoundedString("createdAt", input.createdAt, 64);
  }
  if (input.updatedAt) {
    assertBoundedString("updatedAt", input.updatedAt, 64);
  }
  if (JSON.stringify(input.turnIds).length > MAX_JSON_LENGTH) {
    throw new RangeError("Summary turn id JSON exceeds the storage bound");
  }
}

function validateCompactionStateInput(input: ChatCompactionStateUpsertInput): void {
  assertBoundedString("stateKey", input.stateKey, MAX_HASH_LENGTH);
  assertBoundedString("sessionId", input.sessionId, MAX_ID_LENGTH);
  assertBoundedString("dimensionHash", input.dimensionHash, MAX_HASH_LENGTH);
  assertBoundedString("boundarySourceHash", input.boundarySourceHash, MAX_HASH_LENGTH);
  if (input.providerId) {
    assertBoundedString("providerId", input.providerId, MAX_ID_LENGTH);
  }
  if (input.model) {
    assertBoundedString("model", input.model, MAX_ID_LENGTH);
  }
  if (input.profileFingerprint) {
    assertBoundedString("profileFingerprint", input.profileFingerprint, MAX_HASH_LENGTH);
  }
  validateTurnIds(input.boundaryTurnIds, MAX_STATE_TURN_IDS);
  for (const [label, value] of [
    ["baselineInputTokens", input.baselineInputTokens],
    ["lastObservedInputTokens", input.lastObservedInputTokens],
    ["observedTurnCount", input.observedTurnCount],
  ] as const) {
    assertNonNegativeInteger(label, value);
  }
  if (input.observedTurnCount < input.boundaryTurnIds.length) {
    throw new RangeError("Compaction state observation cannot precede its boundary");
  }
  if (input.createdAt) {
    assertBoundedString("createdAt", input.createdAt, 64);
  }
  if (input.updatedAt) {
    assertBoundedString("updatedAt", input.updatedAt, 64);
  }
  if (JSON.stringify(input.boundaryTurnIds).length > MAX_JSON_LENGTH) {
    throw new RangeError("Compaction boundary turn id JSON exceeds the storage bound");
  }
}

function mapSummaryRow(row: ChatConversationSummaryRow | undefined): ChatConversationSummaryRecord | undefined {
  if (
    !row ||
    row.turn_ids_json.length > MAX_JSON_LENGTH ||
    !isBoundedStoredString(row.summary_text, MAX_SUMMARY_TEXT_LENGTH) ||
    ![row.summary_id, row.session_id, row.branch_head_turn_id, row.start_turn_id, row.end_turn_id].every((value) =>
      isBoundedStoredString(value, MAX_ID_LENGTH),
    ) ||
    !isBoundedStoredString(row.source_hash, MAX_HASH_LENGTH) ||
    (row.window_key !== undefined &&
      row.window_key !== null &&
      !isBoundedStoredString(row.window_key, MAX_HASH_LENGTH)) ||
    !isBoundedStoredString(row.created_at, 64) ||
    !isBoundedStoredString(row.updated_at, 64) ||
    !Number.isSafeInteger(Number(row.token_estimate)) ||
    Number(row.token_estimate) < 0
  ) {
    return undefined;
  }
  const turnIds = parseBoundedStringArray(row.turn_ids_json, MAX_SUMMARY_TURN_IDS);
  if (!turnIds || turnIds[0] !== row.start_turn_id || turnIds.at(-1) !== row.end_turn_id) {
    return undefined;
  }
  if (
    row.window_key &&
    row.window_key !== buildConversationSummaryWindowKey(row.session_id, turnIds, row.source_hash)
  ) {
    return undefined;
  }
  return {
    summaryId: row.summary_id,
    sessionId: row.session_id,
    branchHeadTurnId: row.branch_head_turn_id,
    startTurnId: row.start_turn_id,
    endTurnId: row.end_turn_id,
    turnIds,
    sourceHash: row.source_hash,
    ...(typeof row.window_key === "string" && row.window_key ? { windowKey: row.window_key } : {}),
    tokenEstimate: Number(row.token_estimate),
    summary: row.summary_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCompactionStateRow(row: ChatCompactionStateRow | undefined): ChatCompactionStateRecord | undefined {
  if (
    !row ||
    row.boundary_turn_ids_json.length > MAX_JSON_LENGTH ||
    !isBoundedStoredString(row.state_key, MAX_HASH_LENGTH) ||
    !isBoundedStoredString(row.session_id, MAX_ID_LENGTH) ||
    !isBoundedStoredString(row.dimension_hash, MAX_HASH_LENGTH) ||
    !isBoundedStoredString(row.boundary_source_hash, MAX_HASH_LENGTH) ||
    (row.provider_id !== undefined &&
      row.provider_id !== null &&
      !isBoundedStoredString(row.provider_id, MAX_ID_LENGTH)) ||
    (row.model !== undefined && row.model !== null && !isBoundedStoredString(row.model, MAX_ID_LENGTH)) ||
    (row.profile_fingerprint !== undefined &&
      row.profile_fingerprint !== null &&
      !isBoundedStoredString(row.profile_fingerprint, MAX_HASH_LENGTH)) ||
    !isBoundedStoredString(row.created_at, 64) ||
    !isBoundedStoredString(row.updated_at, 64)
  ) {
    return undefined;
  }
  const boundaryTurnIds = parseBoundedStringArray(row.boundary_turn_ids_json, MAX_STATE_TURN_IDS);
  const baselineInputTokens = Number(row.baseline_input_tokens);
  const lastObservedInputTokens = Number(row.last_observed_input_tokens);
  const observedTurnCount = Number(row.observed_turn_count);
  if (
    !boundaryTurnIds ||
    !Number.isSafeInteger(baselineInputTokens) ||
    !Number.isSafeInteger(lastObservedInputTokens) ||
    !Number.isSafeInteger(observedTurnCount) ||
    baselineInputTokens < 0 ||
    lastObservedInputTokens < 0 ||
    observedTurnCount < 0 ||
    observedTurnCount < boundaryTurnIds.length ||
    (row.armed !== 0 && row.armed !== 1)
  ) {
    return undefined;
  }
  if (
    row.state_key !==
    buildChatCompactionStateKey(row.session_id, row.dimension_hash, boundaryTurnIds, row.boundary_source_hash)
  ) {
    return undefined;
  }
  return {
    stateKey: row.state_key,
    sessionId: row.session_id,
    dimensionHash: row.dimension_hash,
    ...(row.provider_id ? { providerId: row.provider_id } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.profile_fingerprint ? { profileFingerprint: row.profile_fingerprint } : {}),
    boundaryTurnIds,
    boundarySourceHash: row.boundary_source_hash,
    baselineInputTokens,
    lastObservedInputTokens,
    observedTurnCount,
    armed: row.armed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCompactionBreakerRow(row: ChatCompactionBreakerRow | undefined): ChatCompactionBreakerRecord | undefined {
  if (
    !row ||
    !isBoundedStoredString(row.session_id, MAX_ID_LENGTH) ||
    !isBoundedStoredString(row.dimension_hash, MAX_HASH_LENGTH) ||
    (row.provider_id !== undefined &&
      row.provider_id !== null &&
      !isBoundedStoredString(row.provider_id, MAX_ID_LENGTH)) ||
    (row.model !== undefined && row.model !== null && !isBoundedStoredString(row.model, MAX_ID_LENGTH)) ||
    (row.profile_fingerprint !== undefined &&
      row.profile_fingerprint !== null &&
      !isBoundedStoredString(row.profile_fingerprint, MAX_HASH_LENGTH)) ||
    !isBreakerStatus(row.status) ||
    !isBreakerOutcome(row.last_outcome) ||
    !isBoundedStoredString(row.created_at, 64) ||
    !isBoundedStoredString(row.updated_at, 64)
  ) {
    return undefined;
  }
  const fallbackStreak = Number(row.fallback_streak);
  const ineffectiveStreak = Number(row.ineffective_streak);
  const revision = Number(row.revision);
  if (
    !Number.isSafeInteger(fallbackStreak) ||
    fallbackStreak < 0 ||
    fallbackStreak > MAX_BREAKER_STREAK ||
    !Number.isSafeInteger(ineffectiveStreak) ||
    ineffectiveStreak < 0 ||
    ineffectiveStreak > MAX_BREAKER_STREAK ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    return undefined;
  }
  const pendingValues = [
    row.pending_attempt_id,
    row.pending_state_key,
    row.pending_branch_head_turn_id,
    row.pending_observed_turn_count,
    row.pending_disposition,
    row.pending_started_at,
  ];
  const pendingPresent = pendingValues.every((value) => value !== undefined && value !== null);
  if (pendingValues.some((value) => value !== undefined && value !== null) !== pendingPresent) {
    return undefined;
  }
  if (row.status === "awaiting_evidence" && !pendingPresent) {
    return undefined;
  }
  if (pendingPresent) {
    if (
      !isBoundedStoredString(row.pending_attempt_id!, MAX_HASH_LENGTH) ||
      !isBoundedStoredString(row.pending_state_key!, MAX_HASH_LENGTH) ||
      !isBoundedStoredString(row.pending_branch_head_turn_id!, MAX_ID_LENGTH) ||
      !Number.isSafeInteger(Number(row.pending_observed_turn_count)) ||
      Number(row.pending_observed_turn_count) < 0 ||
      !isBreakerDisposition(row.pending_disposition!) ||
      !isBoundedStoredString(row.pending_started_at!, 64) ||
      row.status !== "awaiting_evidence"
    ) {
      return undefined;
    }
  }
  const hasEvidenceTurn = row.last_evidence_turn_id !== undefined && row.last_evidence_turn_id !== null;
  const hasEvidenceTokens = row.last_evidence_input_tokens !== undefined && row.last_evidence_input_tokens !== null;
  if (hasEvidenceTurn !== hasEvidenceTokens) {
    return undefined;
  }
  if (
    (hasEvidenceTurn && !isBoundedStoredString(row.last_evidence_turn_id!, MAX_ID_LENGTH)) ||
    (hasEvidenceTokens &&
      (!Number.isSafeInteger(Number(row.last_evidence_input_tokens)) || Number(row.last_evidence_input_tokens) < 0)) ||
    (row.last_attempt_id !== undefined &&
      row.last_attempt_id !== null &&
      !isBoundedStoredString(row.last_attempt_id, MAX_HASH_LENGTH)) ||
    (row.last_repaired_at !== undefined &&
      row.last_repaired_at !== null &&
      !isBoundedStoredString(row.last_repaired_at, 64)) ||
    (row.last_repair_reason !== undefined &&
      row.last_repair_reason !== null &&
      !isBoundedStoredString(row.last_repair_reason, MAX_REPAIR_REASON_LENGTH)) ||
    (row.last_repaired_actor_hash !== undefined &&
      row.last_repaired_actor_hash !== null &&
      !isBoundedStoredString(row.last_repaired_actor_hash, MAX_HASH_LENGTH))
  ) {
    return undefined;
  }
  return {
    sessionId: row.session_id,
    dimensionHash: row.dimension_hash,
    ...(row.provider_id ? { providerId: row.provider_id } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.profile_fingerprint ? { profileFingerprint: row.profile_fingerprint } : {}),
    status: row.status,
    fallbackStreak,
    ineffectiveStreak,
    ...(pendingPresent
      ? {
          pendingAttemptId: row.pending_attempt_id!,
          pendingStateKey: row.pending_state_key!,
          pendingBranchHeadTurnId: row.pending_branch_head_turn_id!,
          pendingObservedTurnCount: Number(row.pending_observed_turn_count),
          pendingDisposition: row.pending_disposition! as ChatCompactionAttemptDisposition,
          pendingStartedAt: row.pending_started_at!,
        }
      : {}),
    ...(row.last_attempt_id ? { lastAttemptId: row.last_attempt_id } : {}),
    ...(hasEvidenceTurn
      ? {
          lastEvidenceTurnId: row.last_evidence_turn_id!,
          lastEvidenceInputTokens: Number(row.last_evidence_input_tokens),
        }
      : {}),
    lastOutcome: row.last_outcome,
    revision,
    ...(row.last_repaired_at ? { lastRepairedAt: row.last_repaired_at } : {}),
    ...(row.last_repair_reason ? { lastRepairReason: row.last_repair_reason } : {}),
    ...(row.last_repaired_actor_hash ? { lastRepairedActorHash: row.last_repaired_actor_hash } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCompactionBreakerActionRow(
  row: ChatCompactionBreakerActionRow | undefined,
): ChatCompactionBreakerActionRecord | undefined {
  if (
    !row ||
    !isBoundedStoredString(row.action_id, MAX_ID_LENGTH) ||
    !isBoundedStoredString(row.session_id, MAX_ID_LENGTH) ||
    !isBoundedStoredString(row.dimension_hash, MAX_HASH_LENGTH) ||
    !isBreakerActionKind(row.action_kind) ||
    !isBreakerActionStatus(row.status) ||
    !isBoundedStoredString(row.actor_hash, MAX_HASH_LENGTH) ||
    !isBoundedStoredString(row.request_evidence_hash, MAX_HASH_LENGTH) ||
    !isBoundedStoredString(row.policy_decision_hash, MAX_HASH_LENGTH) ||
    !isBoundedStoredString(row.audit_evidence_hash, MAX_HASH_LENGTH) ||
    (row.approval_id !== undefined &&
      row.approval_id !== null &&
      !isBoundedStoredString(row.approval_id, MAX_ID_LENGTH)) ||
    !isBoundedStoredString(row.reason, MAX_ACTION_REASON_LENGTH) ||
    !isCanonicalIsoTimestamp(row.created_at) ||
    !isCanonicalIsoTimestamp(row.expires_at) ||
    !isCanonicalIsoTimestamp(row.updated_at)
  ) {
    return undefined;
  }
  const expectedBreakerRevision = Number(row.expected_breaker_revision);
  const resultingBreakerRevision =
    row.resulting_breaker_revision === undefined || row.resulting_breaker_revision === null
      ? undefined
      : Number(row.resulting_breaker_revision);
  if (
    !Number.isSafeInteger(expectedBreakerRevision) ||
    expectedBreakerRevision < 0 ||
    (resultingBreakerRevision !== undefined &&
      (!Number.isSafeInteger(resultingBreakerRevision) || resultingBreakerRevision < 0)) ||
    (row.rejection_reason !== undefined &&
      row.rejection_reason !== null &&
      !isBoundedStoredString(row.rejection_reason, MAX_ACTION_REJECTION_REASON_LENGTH)) ||
    (row.consumed_at !== undefined && row.consumed_at !== null && !isCanonicalIsoTimestamp(row.consumed_at)) ||
    (row.resulting_attempt_id !== undefined &&
      row.resulting_attempt_id !== null &&
      !isBoundedStoredString(row.resulting_attempt_id, MAX_HASH_LENGTH)) ||
    (row.quarantined_state_key !== undefined &&
      row.quarantined_state_key !== null &&
      !isBoundedStoredString(row.quarantined_state_key, MAX_HASH_LENGTH))
  ) {
    return undefined;
  }
  const rejectionReason = row.rejection_reason ?? undefined;
  const consumedAt = row.consumed_at ?? undefined;
  const resultingAttemptId = row.resulting_attempt_id ?? undefined;
  const quarantinedStateKey = row.quarantined_state_key ?? undefined;
  const lifecycleValid =
    (row.status === "pending" &&
      !rejectionReason &&
      !consumedAt &&
      !resultingAttemptId &&
      resultingBreakerRevision === undefined &&
      !quarantinedStateKey) ||
    (row.status === "expired" &&
      !rejectionReason &&
      !consumedAt &&
      !resultingAttemptId &&
      resultingBreakerRevision === undefined &&
      !quarantinedStateKey) ||
    (row.status === "rejected" &&
      Boolean(rejectionReason) &&
      !consumedAt &&
      !resultingAttemptId &&
      resultingBreakerRevision === undefined &&
      !quarantinedStateKey) ||
    (row.status === "consumed" &&
      !rejectionReason &&
      Boolean(consumedAt) &&
      resultingBreakerRevision !== undefined &&
      ((row.action_kind === "force" && Boolean(resultingAttemptId) && !quarantinedStateKey) ||
        (row.action_kind === "repair" && !resultingAttemptId)));
  if (!lifecycleValid) {
    return undefined;
  }
  return {
    actionId: row.action_id,
    sessionId: row.session_id,
    dimensionHash: row.dimension_hash,
    actionKind: row.action_kind,
    expectedBreakerRevision,
    actorHash: row.actor_hash,
    requestEvidenceHash: row.request_evidence_hash,
    policyDecisionHash: row.policy_decision_hash,
    auditEvidenceHash: row.audit_evidence_hash,
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
    reason: row.reason,
    status: row.status,
    ...(rejectionReason ? { rejectionReason } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(consumedAt ? { consumedAt } : {}),
    ...(resultingAttemptId ? { resultingAttemptId } : {}),
    ...(resultingBreakerRevision !== undefined ? { resultingBreakerRevision } : {}),
    ...(quarantinedStateKey ? { quarantinedStateKey } : {}),
    updatedAt: row.updated_at,
  };
}

function mapSummaryRows(value: unknown): ChatConversationSummaryRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, MAX_ROWS_PER_LOOKUP).flatMap((item) => {
    const mapped = mapSummaryRow(toChatConversationSummaryRow(item));
    return mapped ? [mapped] : [];
  });
}

function mapCompactionStateRows(value: unknown): ChatCompactionStateRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, MAX_ROWS_PER_LOOKUP).flatMap((item) => {
    const mapped = mapCompactionStateRow(toChatCompactionStateRow(item));
    return mapped ? [mapped] : [];
  });
}

function parseBoundedStringArray(json: string, maxItems: number): string[] | undefined {
  if (json.length > MAX_JSON_LENGTH) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
      return undefined;
    }
    const result: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || !item.trim() || item.length > MAX_ID_LENGTH) {
        return undefined;
      }
      result.push(item);
    }
    return result;
  } catch {
    return undefined;
  }
}

function validateTurnIds(turnIds: string[], maxItems: number): void {
  if (!Array.isArray(turnIds) || turnIds.length === 0 || turnIds.length > maxItems) {
    throw new RangeError(`turnIds must contain between 1 and ${maxItems} entries`);
  }
  const unique = new Set<string>();
  for (const turnId of turnIds) {
    assertBoundedString("turnId", turnId, MAX_ID_LENGTH);
    if (unique.has(turnId)) {
      throw new RangeError("turnIds must not contain duplicates");
    }
    unique.add(turnId);
  }
}

function assertBoundedString(label: string, value: string, maxLength: number): void {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new RangeError(`${label} must be a non-empty string no longer than ${maxLength} characters`);
  }
}

function isBoundedStoredString(value: string, maxLength: number): boolean {
  return Boolean(value.trim()) && value.length <= maxLength;
}

function assertNonNegativeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function toChatConversationSummaryRow(value: unknown): ChatConversationSummaryRow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.summary_id === "string" &&
    typeof value.session_id === "string" &&
    typeof value.branch_head_turn_id === "string" &&
    typeof value.start_turn_id === "string" &&
    typeof value.end_turn_id === "string" &&
    typeof value.turn_ids_json === "string" &&
    typeof value.source_hash === "string" &&
    (value.window_key === undefined || value.window_key === null || typeof value.window_key === "string") &&
    typeof value.token_estimate === "number" &&
    typeof value.summary_text === "string" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
    ? (value as unknown as ChatConversationSummaryRow)
    : undefined;
}

function toChatCompactionStateRow(value: unknown): ChatCompactionStateRow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.state_key === "string" &&
    typeof value.session_id === "string" &&
    typeof value.dimension_hash === "string" &&
    typeof value.boundary_turn_ids_json === "string" &&
    typeof value.boundary_source_hash === "string" &&
    typeof value.baseline_input_tokens === "number" &&
    typeof value.last_observed_input_tokens === "number" &&
    typeof value.observed_turn_count === "number" &&
    typeof value.armed === "number" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
    ? (value as unknown as ChatCompactionStateRow)
    : undefined;
}

function toChatCompactionBreakerRow(value: unknown): ChatCompactionBreakerRow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.session_id === "string" &&
    typeof value.dimension_hash === "string" &&
    (value.provider_id === undefined || value.provider_id === null || typeof value.provider_id === "string") &&
    (value.model === undefined || value.model === null || typeof value.model === "string") &&
    (value.profile_fingerprint === undefined ||
      value.profile_fingerprint === null ||
      typeof value.profile_fingerprint === "string") &&
    typeof value.status === "string" &&
    typeof value.fallback_streak === "number" &&
    typeof value.ineffective_streak === "number" &&
    (value.pending_attempt_id === undefined ||
      value.pending_attempt_id === null ||
      typeof value.pending_attempt_id === "string") &&
    (value.pending_state_key === undefined ||
      value.pending_state_key === null ||
      typeof value.pending_state_key === "string") &&
    (value.quarantined_state_key === undefined ||
      value.quarantined_state_key === null ||
      typeof value.quarantined_state_key === "string") &&
    (value.pending_branch_head_turn_id === undefined ||
      value.pending_branch_head_turn_id === null ||
      typeof value.pending_branch_head_turn_id === "string") &&
    (value.pending_observed_turn_count === undefined ||
      value.pending_observed_turn_count === null ||
      typeof value.pending_observed_turn_count === "number") &&
    (value.pending_disposition === undefined ||
      value.pending_disposition === null ||
      typeof value.pending_disposition === "string") &&
    (value.pending_started_at === undefined ||
      value.pending_started_at === null ||
      typeof value.pending_started_at === "string") &&
    (value.last_attempt_id === undefined ||
      value.last_attempt_id === null ||
      typeof value.last_attempt_id === "string") &&
    (value.last_evidence_turn_id === undefined ||
      value.last_evidence_turn_id === null ||
      typeof value.last_evidence_turn_id === "string") &&
    (value.last_evidence_input_tokens === undefined ||
      value.last_evidence_input_tokens === null ||
      typeof value.last_evidence_input_tokens === "number") &&
    typeof value.last_outcome === "string" &&
    typeof value.revision === "number" &&
    (value.last_repaired_at === undefined ||
      value.last_repaired_at === null ||
      typeof value.last_repaired_at === "string") &&
    (value.last_repair_reason === undefined ||
      value.last_repair_reason === null ||
      typeof value.last_repair_reason === "string") &&
    (value.last_repaired_actor_hash === undefined ||
      value.last_repaired_actor_hash === null ||
      typeof value.last_repaired_actor_hash === "string") &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
    ? (value as unknown as ChatCompactionBreakerRow)
    : undefined;
}

function toChatCompactionBreakerActionRow(value: unknown): ChatCompactionBreakerActionRow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.action_id === "string" &&
    typeof value.session_id === "string" &&
    typeof value.dimension_hash === "string" &&
    typeof value.action_kind === "string" &&
    typeof value.expected_breaker_revision === "number" &&
    typeof value.actor_hash === "string" &&
    typeof value.request_evidence_hash === "string" &&
    typeof value.policy_decision_hash === "string" &&
    typeof value.audit_evidence_hash === "string" &&
    (value.approval_id === undefined || value.approval_id === null || typeof value.approval_id === "string") &&
    typeof value.reason === "string" &&
    typeof value.status === "string" &&
    (value.rejection_reason === undefined ||
      value.rejection_reason === null ||
      typeof value.rejection_reason === "string") &&
    typeof value.created_at === "string" &&
    typeof value.expires_at === "string" &&
    (value.consumed_at === undefined || value.consumed_at === null || typeof value.consumed_at === "string") &&
    (value.resulting_attempt_id === undefined ||
      value.resulting_attempt_id === null ||
      typeof value.resulting_attempt_id === "string") &&
    (value.resulting_breaker_revision === undefined ||
      value.resulting_breaker_revision === null ||
      typeof value.resulting_breaker_revision === "number") &&
    (value.quarantined_state_key === undefined ||
      value.quarantined_state_key === null ||
      typeof value.quarantined_state_key === "string") &&
    typeof value.updated_at === "string"
    ? (value as unknown as ChatCompactionBreakerActionRow)
    : undefined;
}

function breakerWriteParams(record: ChatCompactionBreakerRecord): Record<string, unknown> {
  return {
    sessionId: record.sessionId,
    dimensionHash: record.dimensionHash,
    providerId: record.providerId ?? null,
    model: record.model ?? null,
    profileFingerprint: record.profileFingerprint ?? null,
    status: record.status,
    fallbackStreak: record.fallbackStreak,
    ineffectiveStreak: record.ineffectiveStreak,
    pendingAttemptId: record.pendingAttemptId ?? null,
    pendingStateKey: record.pendingStateKey ?? null,
    pendingBranchHeadTurnId: record.pendingBranchHeadTurnId ?? null,
    pendingObservedTurnCount: record.pendingObservedTurnCount ?? null,
    pendingDisposition: record.pendingDisposition ?? null,
    pendingStartedAt: record.pendingStartedAt ?? null,
    lastAttemptId: record.lastAttemptId ?? null,
    lastEvidenceTurnId: record.lastEvidenceTurnId ?? null,
    lastEvidenceInputTokens: record.lastEvidenceInputTokens ?? null,
    lastOutcome: record.lastOutcome,
    revision: record.revision,
    lastRepairedAt: record.lastRepairedAt ?? null,
    lastRepairReason: record.lastRepairReason ?? null,
    lastRepairedActorHash: record.lastRepairedActorHash ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function validateBreakerIdentity(input: {
  sessionId: string;
  dimensionHash: string;
  providerId?: string;
  model?: string;
  profileFingerprint?: string;
}): void {
  assertBoundedString("sessionId", input.sessionId, MAX_ID_LENGTH);
  assertBoundedString("dimensionHash", input.dimensionHash, MAX_HASH_LENGTH);
  if (input.providerId) {
    assertBoundedString("providerId", input.providerId, MAX_ID_LENGTH);
  }
  if (input.model) {
    assertBoundedString("model", input.model, MAX_ID_LENGTH);
  }
  if (input.profileFingerprint) {
    assertBoundedString("profileFingerprint", input.profileFingerprint, MAX_HASH_LENGTH);
  }
}

function validateCompactionBreakerActionCreateInput(input: ChatCompactionBreakerActionCreateInput): void {
  assertBoundedString("actionId", input.actionId, MAX_ID_LENGTH);
  assertBoundedString("sessionId", input.sessionId, MAX_ID_LENGTH);
  assertBoundedString("dimensionHash", input.dimensionHash, MAX_HASH_LENGTH);
  if (!isBreakerActionKind(input.actionKind)) {
    throw new RangeError("actionKind must be force or repair");
  }
  assertNonNegativeInteger("expectedBreakerRevision", input.expectedBreakerRevision);
  for (const [label, value] of [
    ["actorHash", input.actorHash],
    ["requestEvidenceHash", input.requestEvidenceHash],
    ["policyDecisionHash", input.policyDecisionHash],
    ["auditEvidenceHash", input.auditEvidenceHash],
  ] as const) {
    assertBoundedString(label, value, MAX_HASH_LENGTH);
  }
  if (input.approvalId) {
    assertBoundedString("approvalId", input.approvalId, MAX_ID_LENGTH);
  }
  assertBoundedString("reason", input.reason, MAX_ACTION_REASON_LENGTH);
  if (input.status === "pending") {
    if (!input.approvalId) {
      throw new RangeError("A pending compaction breaker action requires approved evidence");
    }
    if (input.rejectionReason !== undefined) {
      throw new RangeError("A pending compaction breaker action cannot include a rejection reason");
    }
  } else if (input.status === "rejected") {
    assertBoundedString("rejectionReason", input.rejectionReason ?? "", MAX_ACTION_REJECTION_REASON_LENGTH);
  } else {
    throw new RangeError("A new compaction breaker action must be pending or rejected");
  }
  assertIsoTimestamp("createdAt", input.createdAt);
  assertIsoTimestamp("expiresAt", input.expiresAt);
  if (input.expiresAt <= input.createdAt) {
    throw new RangeError("expiresAt must be later than createdAt");
  }
}

function validateForceActionReference(input: {
  actionId: string;
  actorHash: string;
  sessionId?: string;
  dimensionHash?: string;
}): void {
  assertBoundedString("actionId", input.actionId, MAX_ID_LENGTH);
  assertBoundedString("actorHash", input.actorHash, MAX_HASH_LENGTH);
  if (input.sessionId !== undefined) {
    assertBoundedString("sessionId", input.sessionId, MAX_ID_LENGTH);
  }
  if (input.dimensionHash !== undefined) {
    assertBoundedString("dimensionHash", input.dimensionHash, MAX_HASH_LENGTH);
  }
}

function assertIsoTimestamp(label: string, value: string): void {
  if (!isCanonicalIsoTimestamp(value)) {
    throw new RangeError(`${label} must be a canonical ISO timestamp`);
  }
}

function isCanonicalIsoTimestamp(value: string): boolean {
  if (!isBoundedStoredString(value, 64)) {
    return false;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function assertBreakerExpectedRevision(
  current: ChatCompactionBreakerRecord | undefined,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision !== undefined) {
    assertNonNegativeInteger("expectedBreakerRevision", expectedRevision);
  }
  if ((!current && expectedRevision !== undefined) || (current && current.revision !== expectedRevision)) {
    throwBreakerRevisionConflict();
  }
}

function assertBreakerDimension(
  current: ChatCompactionBreakerRecord | undefined,
  input: { providerId?: string; model?: string; profileFingerprint?: string },
): void {
  if (!current) {
    return;
  }
  if (
    current.providerId !== input.providerId ||
    current.model !== input.model ||
    current.profileFingerprint !== input.profileFingerprint
  ) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Chat compaction breaker identity does not match its sealed provider/model/profile dimension",
    });
  }
}

function throwBreakerRevisionConflict(): never {
  throw new ConflictError({
    code: "STATE_CONFLICT",
    message: "Chat compaction breaker revision changed; reload durable state before retrying",
  });
}

function isBreakerStatus(value: string): value is ChatCompactionBreakerStatus {
  return value === "closed" || value === "awaiting_evidence" || value === "tripped" || value === "blocked_corrupt";
}

function isBreakerDisposition(value: string): value is ChatCompactionAttemptDisposition {
  return value === "structured" || value === "fallback" || value === "no_progress";
}

function isBreakerOutcome(value: string): value is ChatCompactionAttemptOutcome {
  return (
    value === "healthy" ||
    value === "ineffective" ||
    value === "fallback" ||
    value === "no_progress" ||
    value === "unverified"
  );
}

function isBreakerActionKind(value: string): value is ChatCompactionBreakerActionKind {
  return value === "force" || value === "repair";
}

function isBreakerActionStatus(value: string): value is ChatCompactionBreakerActionStatus {
  return value === "pending" || value === "consumed" || value === "expired" || value === "rejected";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
