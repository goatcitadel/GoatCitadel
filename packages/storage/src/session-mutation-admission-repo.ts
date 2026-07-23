/* eslint-disable max-lines -- Admission, preemption, replay, and cross-dialect fencing stay in one audited checkpoint boundary. */
import { createHash } from "node:crypto";
import { canonicalJsonString, ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

export type SessionMutationAdmissionKind = "synchronous" | "turn_write";
export type SessionMutationAdmissionStatus = "active" | "completed" | "cancelled";
export type SessionMutationAdmissionActorKind = "operator" | "external_companion" | "system";
export type SessionMutationAdmissionTerminalAuthorityKind =
  | "synchronous"
  | "request_runtime"
  | "durable_run"
  | "durable_terminal"
  | "expired_recovery"
  | "lifecycle_delete"
  | "authority_superseded"
  | "post_commit_child_stage";
export const SESSION_MUTATION_REQUEST_RUNTIME_LEASE_MS = 60_000;
const HEARTBEAT_PREEMPTION_PENDING_CONTROL_REQUEST_LIMIT = 256;

export interface SessionMutationAdmissionRecord {
  admissionId: string;
  sessionIncarnationId: string;
  workspaceId: string;
  sessionId: string;
  turnId?: string;
  runtimeOwnerId?: string;
  runtimeLastHeartbeatAt?: string;
  runtimeLeaseExpiresAt?: string;
  runtimeLeaseRevision?: number;
  runtimeLeaseRelinquishedAt?: string;
  admissionKind: SessionMutationAdmissionKind;
  aggregateRevision: number;
  controllerGeneration: number;
  actorKind: SessionMutationAdmissionActorKind;
  actorId: string;
  operation: string;
  materialSha256: string;
  status: SessionMutationAdmissionStatus;
  idempotencyKey: string;
  requestSha256: string;
  correlationId: string;
  createdAt: string;
  closedAt?: string;
  terminalAuthorityKind?: SessionMutationAdmissionTerminalAuthorityKind;
  terminalRuntimeOwnerId?: string;
  terminalRuntimeLeaseRevision?: number;
  terminalDurableRunId?: string;
  terminalDurableLeaseOwnerId?: string;
  terminalDurableAttemptCount?: number;
  terminalDurableRunVersion?: number;
  terminalDurableRunStatus?: string;
  terminalLifecycleIntentId?: string;
  terminalControlEventId?: string;
}

export interface SessionMutationAdmissionEventRecord {
  eventId: string;
  admissionId: string;
  sessionIncarnationId: string;
  workspaceId: string;
  sessionId: string;
  turnId?: string;
  runtimeOwnerId?: string;
  runtimeLeaseRevision?: number;
  eventSequence: number;
  eventType: "admitted" | "completed" | "cancelled";
  admissionKind: SessionMutationAdmissionKind;
  aggregateRevision: number;
  controllerGeneration: number;
  actorKind: SessionMutationAdmissionActorKind;
  actorId: string;
  operation: string;
  materialSha256: string;
  idempotencyKey: string;
  requestSha256: string;
  correlationId: string;
  createdAt: string;
  terminalAuthorityKind?: SessionMutationAdmissionTerminalAuthorityKind;
  terminalRuntimeOwnerId?: string;
  terminalRuntimeLeaseRevision?: number;
  terminalDurableRunId?: string;
  terminalDurableLeaseOwnerId?: string;
  terminalDurableAttemptCount?: number;
  terminalDurableRunVersion?: number;
  terminalDurableRunStatus?: string;
  terminalLifecycleIntentId?: string;
  terminalControlEventId?: string;
}

export interface AdmitSessionMutationInput {
  workspaceId: string;
  sessionId: string;
  expectedSessionIncarnationId?: string;
  turnId?: string;
  runtimeOwnerId?: string;
  admissionKind: SessionMutationAdmissionKind;
  aggregateRevision: number;
  controllerGeneration: number;
  actorKind: SessionMutationAdmissionActorKind;
  actorId: string;
  operation: string;
  materialSha256: string;
  idempotencyKey: string;
  correlationId: string;
}

export interface AdmitSessionMutationOutcome {
  disposition: "created" | "replayed";
  admission: SessionMutationAdmissionRecord;
}

export interface PreemptHeartbeatAndAdmitOperatorTurnInput {
  workspaceId: string;
  sessionId: string;
  expectedSessionIncarnationId?: string;
  turnId: string;
  runtimeOwnerId: string;
  aggregateRevision: number;
  expectedControllerGeneration: number;
  operatorActorId: string;
  operation: string;
  materialSha256: string;
  idempotencyKey: string;
  correlationId: string;
}

export type PreemptHeartbeatAndAdmitOperatorTurnOutcome =
  | (AdmitSessionMutationOutcome & {
      preemptionDisposition: "not_required" | "preempted" | "replayed";
      controllerGeneration: number;
      controlEventId?: string;
      occurrenceId?: string;
      heartbeatAdmissionId?: string;
      durableRunId?: string;
    })
  | {
      disposition: "decision_committed";
      preemptionDisposition: "decision_committed";
      controllerGeneration: number;
      workspaceId: string;
      sessionId: string;
      sessionIncarnationId: string;
      turnId: string;
      occurrenceId: string;
      heartbeatAdmissionId: string;
      durableRunId: string;
    };

export interface AbandonAdmittedHeartbeatForExecutionDisabledInput {
  workspaceId: string;
  sessionId: string;
  occurrenceId: string;
  admissionId: string;
  claimSha256: string;
  idempotencyKey: string;
  correlationId: string;
}

export interface AbandonAdmittedHeartbeatForExecutionDisabledOutcome {
  disposition: "parked" | "replayed" | "drift";
  occurrenceId: string;
  admission: SessionMutationAdmissionRecord;
}

export type PreviewSessionMutationAdmissionIdentityInput = Omit<
  AdmitSessionMutationInput,
  "expectedSessionIncarnationId"
> & {
  sessionIncarnationId: string;
};

export interface PreviewSessionMutationAdmissionIdentityOutcome {
  admissionId: string;
  requestSha256: string;
  sessionIncarnationId: string;
}

export interface TurnWriteAdmissionIdentity {
  admissionId: string;
  workspaceId: string;
  sessionId: string;
  sessionIncarnationId: string;
  turnId: string;
}

export interface DurableTurnWriteClaim {
  durableRunId: string;
  leaseOwnerId: string;
  attemptCount: number;
}

export interface RequestRuntimeLeaseClaim {
  runtimeOwnerId: string;
  leaseRevision: number;
}

export interface AssertActiveTurnWriteInput extends TurnWriteAdmissionIdentity {
  requestRuntimeClaim?: RequestRuntimeLeaseClaim;
  durableClaim?: DurableTurnWriteClaim;
}

export interface AssertActiveTurnWriteOutcome {
  admission: SessionMutationAdmissionRecord;
  durableRunVersion?: number;
}

export interface BindTurnWriteDurableRunInput extends TurnWriteAdmissionIdentity {
  durableRunId: string;
  requestRuntimeClaim: RequestRuntimeLeaseClaim;
}

export interface TurnWriteDurableRunBindingRecord extends TurnWriteAdmissionIdentity {
  durableRunId: string;
  createdAt: string;
}

export interface BindTurnWriteDurableRunOutcome {
  disposition: "created" | "replayed";
  binding: TurnWriteDurableRunBindingRecord;
}

export interface VerifyTerminalTurnWriteHandoffInput extends TurnWriteAdmissionIdentity {
  durableRunId: string;
  userMessageId: string;
  assistantMessageId: string;
}

export interface VerifyDurableTurnPayloadIdentityInput extends TurnWriteAdmissionIdentity {
  durableRunId: string;
}

export interface VerifiedTerminalTurnWriteHandoff {
  durableRunStatus: "completed" | "failed" | "cancelled";
  traceStatus: "completed" | "partial" | "failed" | "cancelled";
  handoffSha256: string;
}

export interface BindTurnCapabilityProfileInput extends AssertActiveTurnWriteInput {
  profileId: string;
  profileHash: string;
  createdAt: string;
}

export interface TurnCapabilityProfileIncarnationBindingRecord {
  profileId: string;
  turnId: string;
  profileHash: string;
  createdAt: string;
}

export interface BindTurnCapabilityProfileOutcome {
  disposition: "created" | "replayed";
  binding: TurnCapabilityProfileIncarnationBindingRecord;
}

export interface RequireTurnCapabilityProfileBindingInput extends TurnWriteAdmissionIdentity {
  profileId: string;
  profileHash: string;
  createdAt: string;
}

export interface RequireTurnCapabilityProfileBindingOutcome {
  admission: SessionMutationAdmissionRecord;
  binding: TurnCapabilityProfileIncarnationBindingRecord;
}

export type DurableChatUserInputResponderAuthSource =
  | "none"
  | "token"
  | "basic"
  | "loopback"
  | "sse"
  | "device"
  | "companion"
  | "a2a_peer";

export interface DurableChatUserInputResumeRecord {
  promptId: string;
  kind: "single_select" | "text";
  title: string;
  question: string;
  answeredAt: string;
  response: { kind: "single_select"; optionId: string } | { kind: "text"; text: string };
  selectedOption?: { optionId: string; label: string; description: string };
}

export interface DurableChatUserInputAdmissionIdentity extends TurnWriteAdmissionIdentity {
  aggregateRevision: number;
  controllerGeneration: number;
  materialSha256: string;
}

export interface ResolveDurableChatUserInputInput {
  admissionIdentity: DurableChatUserInputAdmissionIdentity;
  durableRunId: string;
  expectedWaitingRunVersion: number;
  promptId: string;
  eventKey: "chat.user_input.resolved";
  correlationId: string;
  responder: {
    actorId: string;
    authActorSource: DurableChatUserInputResponderAuthSource;
  };
  response: { kind: "single_select"; optionId: string } | { kind: "text"; text: string };
}

export interface DurableChatUserInputContinuationSealRecord {
  version: 1;
  sealId: string;
  admissionId: string;
  sessionIncarnationId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  durableRunId: string;
  promptId: string;
  eventKey: "chat.user_input.resolved";
  correlationId: string;
  resumeRecordSha256: string;
  responderActorId: string;
  responderAuthActorSource: DurableChatUserInputResponderAuthSource;
  waitingRunVersion: number;
  queuedRunVersion: number;
  resolvedAt: string;
  materialSha256: string;
}

export interface ResolveDurableChatUserInputOutcome {
  disposition: "resolved" | "replayed";
  run: { runId: string; status: string; version: number };
  seal: DurableChatUserInputContinuationSealRecord;
  responseRecord: DurableChatUserInputResumeRecord;
}

export interface RenewTurnWriteRequestLeaseInput extends TurnWriteAdmissionIdentity {
  requestRuntimeClaim: RequestRuntimeLeaseClaim;
}

export interface CloseTurnWriteInput extends TurnWriteAdmissionIdentity {
  status: "completed" | "cancelled";
  actorId: string;
  idempotencyKey: string;
  correlationId: string;
  requestRuntimeClaim?: RequestRuntimeLeaseClaim;
  durableClaim?: DurableTurnWriteClaim;
}

export interface CancelExpiredUnboundTurnAdmissionsInput {
  actorId: string;
  idempotencyKeyPrefix: string;
  correlationId: string;
  limit?: number;
}

export interface CancelExpiredUnboundTurnAdmissionsOutcome {
  cancelledAdmissionIds: string[];
}

export interface ReclaimExpiredSystemTurnWriteRequestLeaseInput extends TurnWriteAdmissionIdentity {
  occurrenceId: string;
  runtimeOwnerId: string;
  expectedLeaseRevision: number;
  actorId: "system-heartbeat";
  operation: "chat_system_heartbeat";
  materialSha256: string;
  idempotencyKey: string;
  correlationId: string;
  admissionRequestSha256: string;
  expectedDurableRunId: string;
  userMessageId: string;
  assistantMessageId: string;
  evaluatedPolicySha256: string;
  frozenRequestSha256: string;
  frozenObjectiveSha256: string;
  claimSha256: string;
}

export type ReclaimExpiredSystemTurnWriteRequestLeaseOutcome =
  | { disposition: "live"; admission: SessionMutationAdmissionRecord }
  | { disposition: "reclaimed"; admission: SessionMutationAdmissionRecord }
  | { disposition: "durable_bound"; admission: SessionMutationAdmissionRecord }
  | {
      disposition: "closed_or_authority_drift";
      reason: "closed" | "authority_drift" | "lifecycle_drift";
      admission: SessionMutationAdmissionRecord;
    };

export type SettleTurnWriteAuthorityInput = TurnWriteAdmissionIdentity;

export interface SettleTurnWriteAuthorityOutcome {
  disposition: "current" | "authority_superseded";
  admission: SessionMutationAdmissionRecord;
}

export type ParentLocalPostCommitEffect = "capability_gap" | "realtime" | "agent_end";

export interface ParentLocalPostCommitStageInput {
  parentAdmission: DurableChatUserInputAdmissionIdentity;
  parentRunId: string;
  postCommitGenerationId: string;
  effect: ParentLocalPostCommitEffect;
}

export interface ParentLocalPostCommitStageAuthority {
  admission: SessionMutationAdmissionRecord;
  durableRunVersion: number;
  effect: ParentLocalPostCommitEffect;
}

export interface ParentLocalPostCommitStageOutcome<T> {
  disposition: "allowed" | "replayed" | "late_blocked";
  admission: SessionMutationAdmissionRecord;
  durableRunVersion: number;
  value?: T;
}

export interface PostCommitChildStageInput {
  childAdmission: PostCommitChildAdmissionIdentity;
  parentRunId: string;
  postCommitGenerationId: string;
  effect: "commitments" | "background_review" | "memory_maintenance";
  childRunId: string;
  sourceTurnId: string;
  postCommitEligibility: PostCommitEligibility;
  stage: "commitments_write" | "background_counter" | "background_evidence" | "memory_maintenance_evaluation";
  terminal: boolean;
  durableClaim: DurableTurnWriteClaim;
}

export type AssertPostCommitChildDispatchAuthorityInput = Omit<PostCommitChildStageInput, "stage" | "terminal">;

export interface PostCommitChildStageAuthority {
  disposition: "allowed" | "late_blocked";
  admission: SessionMutationAdmissionRecord;
  durableRunVersion: number;
}

export interface PostCommitChildStageOutcome<T> {
  disposition: "allowed" | "late_blocked";
  value: T;
  admission: SessionMutationAdmissionRecord;
}

export interface PostCommitChildStageCallbackOutcome<T> {
  disposition: "allowed" | "late_blocked";
  value: T;
}

export interface CloseSessionMutationAdmissionInput {
  admissionId: string;
  status: "completed" | "cancelled";
  actorId: string;
  idempotencyKey: string;
  correlationId: string;
}

interface AdmissionRow {
  admission_id: string;
  session_incarnation_id: string;
  workspace_id: string;
  session_id: string;
  turn_id: string | null;
  runtime_owner_id: string | null;
  runtime_last_heartbeat_at: string | null;
  runtime_lease_expires_at: string | null;
  runtime_lease_revision: number | bigint | string | null;
  runtime_lease_relinquished_at: string | null;
  admission_kind: SessionMutationAdmissionKind;
  aggregate_revision: number | bigint | string;
  controller_generation: number | bigint | string;
  actor_kind: SessionMutationAdmissionActorKind;
  actor_id: string;
  operation: string;
  material_sha256: string;
  status: SessionMutationAdmissionStatus;
  idempotency_key: string;
  request_sha256: string;
  correlation_id: string;
  admit_event_id: string;
  created_at: string;
  closed_at: string | null;
  terminal_actor_id: string | null;
  terminal_event_id: string | null;
  terminal_idempotency_key: string | null;
  terminal_correlation_id: string | null;
  terminal_authority_kind: SessionMutationAdmissionTerminalAuthorityKind | null;
  terminal_runtime_owner_id: string | null;
  terminal_runtime_lease_revision: number | bigint | string | null;
  terminal_durable_run_id: string | null;
  terminal_durable_lease_owner_id: string | null;
  terminal_durable_attempt_count: number | bigint | string | null;
  terminal_durable_run_version: number | bigint | string | null;
  terminal_durable_run_status: string | null;
  terminal_lifecycle_intent_id: string | null;
  terminal_control_event_id: string | null;
}

interface AdmissionEventRow {
  event_id: string;
  admission_id: string;
  session_incarnation_id: string;
  workspace_id: string;
  session_id: string;
  turn_id: string | null;
  runtime_owner_id: string | null;
  runtime_lease_revision: number | bigint | string | null;
  event_sequence: number | bigint | string;
  event_type: "admitted" | "completed" | "cancelled";
  admission_kind: SessionMutationAdmissionKind;
  aggregate_revision: number | bigint | string;
  controller_generation: number | bigint | string;
  actor_kind: SessionMutationAdmissionActorKind;
  actor_id: string;
  operation: string;
  material_sha256: string;
  idempotency_key: string;
  request_sha256: string;
  correlation_id: string;
  created_at: string;
  terminal_authority_kind: SessionMutationAdmissionTerminalAuthorityKind | null;
  terminal_runtime_owner_id: string | null;
  terminal_runtime_lease_revision: number | bigint | string | null;
  terminal_durable_run_id: string | null;
  terminal_durable_lease_owner_id: string | null;
  terminal_durable_attempt_count: number | bigint | string | null;
  terminal_durable_run_version: number | bigint | string | null;
  terminal_durable_run_status: string | null;
  terminal_lifecycle_intent_id: string | null;
  terminal_control_event_id: string | null;
}

type CloseAuthorityProof =
  | { kind: "synchronous" }
  | { kind: "request_runtime"; claim: ReturnType<typeof normalizeRequestRuntimeClaim> }
  | {
      kind: "durable_run";
      claim: ReturnType<typeof normalizeDurableClaim>;
      runVersion: number;
    }
  | {
      kind: "durable_terminal";
      durableRunId: string;
      runVersion: number;
      runStatus: "completed" | "failed" | "cancelled";
    }
  | { kind: "expired_recovery"; runtimeOwnerId: string; leaseRevision: number }
  | { kind: "lifecycle_delete"; lifecycleIntentId: string }
  | { kind: "authority_superseded"; controlEventId: string }
  | {
      kind: "post_commit_child_stage";
      claim: ReturnType<typeof normalizeDurableClaim>;
      runVersion: number;
    };

interface ChatTurnAdmissionHandoffMarker {
  version: 1;
  admissionId: string;
  sessionIncarnationId: string;
  turnId: string;
  parentRunId: string;
  postCommitGenerationId: string;
  parentLocalEffectsStatus: "settled";
  childRunIds: string[];
  childRunIdsSha256: string;
  committedAt: string;
}

type TerminalDurableRunStatus = "completed" | "failed" | "cancelled";
type TerminalPostCommitChildStatus = TerminalDurableRunStatus | "dead_lettered";
type TerminalRuntimeFinalizer = "linked" | "autonomous" | "general";

interface TerminalRuntimeAuthorityOutput {
  assistantMessageId: string;
  outputTextSha256: string;
  outputSummarySha256: string;
}

interface TerminalRuntimeLinkedFinalization {
  finalizationId: string;
  requestedAt: string;
  reasonSha256: string;
}

interface HeartbeatDecisionReceipt {
  version: 1;
  occurrenceId: string;
  claimSha256: string;
  rawOutputSha256: string;
  notify: boolean;
  normalizedMessageSha256: string | null;
}

interface TerminalRuntimeAuthorityMaterial {
  version: "chat.turn.runtime-authority.v1";
  runId: string;
  turnId: string;
  transitionKind: "terminal" | "linked_finalization";
  durableStatus: TerminalDurableRunStatus;
  traceStatus: "completed" | "partial" | "failed" | "cancelled";
  transitionAt: string;
  postCommitGenerationId: string;
  postCommitEligibility: PostCommitEligibility;
  waitForEvent: null;
  terminalOutput: TerminalRuntimeAuthorityOutput | null;
  linkedFinalization: TerminalRuntimeLinkedFinalization | null;
  requiredFinalizers: TerminalRuntimeFinalizer[];
  heartbeatDecisionReceipt?: HeartbeatDecisionReceipt;
}

interface TerminalRuntimeAuthoritySeal {
  material: TerminalRuntimeAuthorityMaterial;
  materialSha256: string;
}

interface TerminalGeneralDurableEffectOutcome {
  runId: string;
  status: TerminalPostCommitChildStatus;
  settledAt: string;
  error?: string;
}

interface TerminalGeneralPostCommitSettlement {
  generationId: string;
  traceStatus: TerminalRuntimeAuthorityMaterial["traceStatus"];
  requestedAt: string;
  postCommitEligibility: PostCommitEligibility;
  parentLocalEffectsStatus: "settled";
  parentLocalEffectsSettledAt: string;
  completedEffects: string[];
  durableEffectRunIds: Record<string, string>;
  durableEffectOutcomes: Record<string, TerminalGeneralDurableEffectOutcome>;
  childOutcomeAuthority: "child_durable_runs";
  settlementStatus: "completed" | "settled_with_failures";
  completedAt: string;
}

export interface PostCommitChildAdmissionIdentity {
  admissionId: string;
  sessionIncarnationId: string;
  workspaceId: string;
  sessionId: string;
  aggregateRevision: number;
  controllerGeneration: number;
  actorKind: SessionMutationAdmissionActorKind;
  actorId: string;
  operation: "chat_post_commit_child";
  materialSha256: string;
}

export interface PostCommitChildAdmissionMaterialInput {
  parentRunId: string;
  postCommitGenerationId: string;
  effect: string;
  childRunId: string;
  workspaceId: string;
  sessionId: string;
  sourceTurnId: string;
  sessionIncarnationId: string;
  postCommitEligibility: PostCommitEligibility;
}

export interface PostCommitEligibility {
  version: 1;
  autonomyEnabledAtParentSettlement: boolean;
  evalIntegrityTurn: boolean;
  humanSession: boolean;
}

interface DurableBindingRow {
  admission_id: string;
  turn_id: string;
  workspace_id: string;
  session_id: string;
  session_incarnation_id: string;
  durable_run_id: string;
  created_at: string;
}

interface DurableRunFenceRow {
  run_id: string;
  workflow_key: string;
  status: string;
  attempt_count: number | bigint | string;
  payload_json: string;
  metadata_json: string | null;
  lease_owner_id: string | null;
  lease_expires_at: string | null;
  version: number | bigint | string;
}

interface ParentLocalPostCommitPendingMarker {
  generationId: string;
  completedEffects: string[];
}

const GENERAL_CHAT_POST_COMMIT_EFFECTS = new Set([
  "capability_gap",
  "learned_memory_user",
  "learned_memory_assistant",
  "commitments",
  "background_review",
  "memory_maintenance",
  "memory_prewarm",
  "realtime",
  "agent_end",
]);

interface DurableChatUserInputContinuationSealRow {
  seal_id: string;
  version: number | bigint | string;
  admission_id: string;
  session_incarnation_id: string;
  workspace_id: string;
  session_id: string;
  turn_id: string;
  durable_run_id: string;
  prompt_id: string;
  event_key: "chat.user_input.resolved";
  correlation_id: string;
  resume_record_sha256: string;
  responder_actor_id: string;
  responder_auth_actor_source: DurableChatUserInputResponderAuthSource;
  waiting_run_version: number | bigint | string;
  queued_run_version: number | bigint | string;
  resolved_at: string;
  material_sha256: string;
}

interface WaitingChatUserInputTraceRow {
  turn_id: string;
  session_id: string;
  status: string;
  durable_json: string | null;
  pending_user_input_json: string | null;
}

export class SessionMutationAdmissionRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public previewAdmissionIdentity(
    input: PreviewSessionMutationAdmissionIdentityInput,
  ): PreviewSessionMutationAdmissionIdentityOutcome {
    const sessionIncarnationId = boundedIdentifier(input.sessionIncarnationId, "sessionIncarnationId", 320);
    const { sessionIncarnationId: _sessionIncarnationId, ...admissionInput } = input;
    const normalized = normalizeAdmitInput({
      ...admissionInput,
      expectedSessionIncarnationId: sessionIncarnationId,
    });
    const requestSha256 = admissionRequestSha256(normalized, sessionIncarnationId);
    return {
      admissionId: deriveId("csma", normalized.idempotencyKey, requestSha256),
      requestSha256,
      sessionIncarnationId,
    };
  }

  public admit(input: AdmitSessionMutationInput): AdmitSessionMutationOutcome {
    const normalized = normalizeAdmitInput(input);
    try {
      return this.db.transaction("immediate", () => {
        this.acquireSessionLock(normalized.sessionId);
        const replay = this.findByIdempotency(normalized.idempotencyKey);
        if (replay) {
          const requestSha256 = admissionRequestSha256(normalized, replay.session_incarnation_id);
          const admissionId = deriveId("csma", normalized.idempotencyKey, requestSha256);
          if (replay.request_sha256 !== requestSha256 || replay.admission_id !== admissionId) {
            throw admissionConflict(
              "SESSION_MUTATION_ADMISSION_REPLAY_CONFLICT",
              "Mutation admission replay conflicts.",
            );
          }
          this.requireExactTurnBinding(replay);
          return { disposition: "replayed", admission: mapAdmission(replay) };
        }
        const sessionIncarnationId = this.requireCurrentSessionAuthority(normalized);
        if (
          normalized.expectedSessionIncarnationId !== null &&
          normalized.expectedSessionIncarnationId !== sessionIncarnationId
        ) {
          throw admissionConflict(
            "SESSION_MUTATION_INCARNATION_MISMATCH",
            "Mutation admission expected a different session incarnation.",
          );
        }
        this.cancelSupersededActiveTurnAdmissions(normalized, sessionIncarnationId);
        return this.insertNormalizedAdmission(normalized, sessionIncarnationId);
      });
    } catch (error) {
      throw normalizeAdmissionWriteError(error);
    }
  }

  public preemptHeartbeatAndAdmitOperatorTurn(
    input: PreemptHeartbeatAndAdmitOperatorTurnInput,
  ): PreemptHeartbeatAndAdmitOperatorTurnOutcome {
    const expectedControllerGeneration = positiveInteger(
      input.expectedControllerGeneration,
      "expectedControllerGeneration",
    );
    const normalized = normalizeAdmitInput({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      ...(input.expectedSessionIncarnationId
        ? { expectedSessionIncarnationId: input.expectedSessionIncarnationId }
        : {}),
      turnId: input.turnId,
      runtimeOwnerId: input.runtimeOwnerId,
      admissionKind: "turn_write",
      aggregateRevision: input.aggregateRevision,
      controllerGeneration: expectedControllerGeneration,
      actorKind: "operator",
      actorId: input.operatorActorId,
      operation: input.operation,
      materialSha256: input.materialSha256,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
    });
    const preemptionIdempotencyKey = deriveId(
      "heartbeat-preempt",
      normalized.workspaceId,
      normalized.sessionId,
      normalized.idempotencyKey,
    );
    const preemptionRequestSha256 = heartbeatPreemptionRequestSha256({
      workspaceId: normalized.workspaceId,
      sessionId: normalized.sessionId,
      expectedControllerGeneration,
      operatorActorId: normalized.actorId,
      operatorAdmissionIdempotencyKey: normalized.idempotencyKey,
      correlationId: normalized.correlationId,
    });
    try {
      return this.db.transaction("immediate", () => {
        this.acquireSessionLock(normalized.sessionId);
        const replay = this.findByIdempotency(normalized.idempotencyKey);
        if (replay) {
          const replayGeneration = asPositiveInteger(replay.controller_generation);
          if (
            replayGeneration !== expectedControllerGeneration &&
            replayGeneration !== incrementPositiveInteger(expectedControllerGeneration)
          ) {
            throw admissionConflict(
              "SESSION_MUTATION_ADMISSION_REPLAY_CONFLICT",
              "Operator admission replay conflicts with its heartbeat-preemption generation.",
            );
          }
          const replayNormalized = { ...normalized, controllerGeneration: replayGeneration };
          const requestSha256 = admissionRequestSha256(replayNormalized, replay.session_incarnation_id);
          if (
            replay.request_sha256 !== requestSha256 ||
            replay.admission_id !== deriveId("csma", replayNormalized.idempotencyKey, requestSha256)
          ) {
            throw admissionConflict(
              "SESSION_MUTATION_ADMISSION_REPLAY_CONFLICT",
              "Operator admission replay conflicts.",
            );
          }
          this.requireExactTurnBinding(replay);
          const event = this.db
            .prepare(
              `SELECT event_id, workspace_id, session_id, previous_generation, next_generation,
                      previous_owner_kind, next_owner_kind, previous_lease_state, next_lease_state,
                      reason_code, actor_kind, actor_id, correlation_id, request_sha256
               FROM chat_session_control_events
               WHERE idempotency_key = @idempotencyKey`,
            )
            .get<{
              event_id: string;
              workspace_id: string;
              session_id: string;
              previous_generation: number | bigint | string;
              next_generation: number | bigint | string;
              previous_owner_kind: string;
              next_owner_kind: string;
              previous_lease_state: string;
              next_lease_state: string;
              reason_code: string;
              actor_kind: string;
              actor_id: string;
              correlation_id: string;
              request_sha256: string;
            }>({ idempotencyKey: preemptionIdempotencyKey });
          if (!event) {
            if (replayGeneration !== expectedControllerGeneration) {
              throw admissionConflict(
                "SESSION_MUTATION_ADMISSION_REPLAY_CONFLICT",
                "Operator admission replay lost its heartbeat-preemption evidence.",
              );
            }
            return {
              disposition: "replayed",
              preemptionDisposition: "not_required",
              controllerGeneration: replayGeneration,
              admission: mapAdmission(replay),
            };
          }
          const eventPreviousGeneration = asPositiveInteger(event.previous_generation);
          const eventNextGeneration = asPositiveInteger(event.next_generation);
          if (
            replayGeneration !== eventNextGeneration ||
            (expectedControllerGeneration !== eventPreviousGeneration &&
              expectedControllerGeneration !== eventNextGeneration)
          ) {
            throw admissionConflict(
              "SESSION_MUTATION_ADMISSION_REPLAY_CONFLICT",
              "Operator admission replay has inconsistent heartbeat-preemption generations.",
            );
          }
          const replayPreemptionRequestSha256 = heartbeatPreemptionRequestSha256({
            workspaceId: normalized.workspaceId,
            sessionId: normalized.sessionId,
            expectedControllerGeneration: eventPreviousGeneration,
            operatorActorId: normalized.actorId,
            operatorAdmissionIdempotencyKey: normalized.idempotencyKey,
            correlationId: normalized.correlationId,
          });
          if (
            event.workspace_id !== normalized.workspaceId ||
            event.session_id !== normalized.sessionId ||
            event.previous_owner_kind !== "operator" ||
            event.next_owner_kind !== "operator" ||
            event.previous_lease_state !== "operator_active" ||
            event.next_lease_state !== "operator_active" ||
            event.reason_code !== "heartbeat_preempted" ||
            event.actor_kind !== "operator" ||
            event.actor_id !== normalized.actorId ||
            event.correlation_id !== normalized.correlationId ||
            event.request_sha256 !== replayPreemptionRequestSha256
          ) {
            throw admissionConflict(
              "SESSION_MUTATION_ADMISSION_REPLAY_CONFLICT",
              "Heartbeat preemption replay conflicts.",
            );
          }
          const stalePendingRequest = this.db
            .prepare(
              `SELECT request_id FROM chat_session_control_requests
               WHERE workspace_id = @workspaceId AND session_id = @sessionId
                 AND requested_generation = @generation AND status = 'pending'
               LIMIT 1`,
            )
            .get<{ request_id: string }>({
              workspaceId: normalized.workspaceId,
              sessionId: normalized.sessionId,
              generation: eventPreviousGeneration,
            });
          if (stalePendingRequest) {
            throw admissionConflict(
              "SESSION_MUTATION_ADMISSION_REPLAY_CONFLICT",
              "Heartbeat preemption replay found an unterminated prior-generation control request.",
            );
          }
          const occurrence = this.db
            .prepare(
              `SELECT occurrence.occurrence_id, occurrence.admission_id, occurrence.durable_run_id,
                      occurrence.abandonment_reason,
                      heartbeat_admission.terminal_authority_kind,
                       heartbeat_admission.terminal_control_event_id,
                       heartbeat_admission.terminal_idempotency_key,
                       heartbeat_admission.terminal_correlation_id
               FROM chat_heartbeat_occurrences occurrence
               JOIN chat_session_mutation_admissions heartbeat_admission
                 ON heartbeat_admission.admission_id = occurrence.admission_id
               WHERE occurrence.workspace_id = @workspaceId AND occurrence.session_id = @sessionId
                 AND occurrence.controller_generation = @expectedControllerGeneration
                 AND occurrence.state = 'abandoned'`,
            )
            .all<{
              occurrence_id: string;
              admission_id: string;
              durable_run_id: string | null;
              abandonment_reason: string;
              terminal_authority_kind: string;
              terminal_control_event_id: string | null;
              terminal_idempotency_key: string;
              terminal_correlation_id: string;
            }>({
              workspaceId: normalized.workspaceId,
              sessionId: normalized.sessionId,
              expectedControllerGeneration: eventPreviousGeneration,
            })
            .find((candidate) =>
              candidate.durable_run_id
                ? candidate.abandonment_reason === "authority_drift" &&
                  candidate.terminal_authority_kind === "authority_superseded" &&
                  candidate.terminal_control_event_id === event.event_id
                : candidate.abandonment_reason === "admission_closed" &&
                  candidate.terminal_authority_kind === "request_runtime" &&
                  candidate.terminal_idempotency_key ===
                    heartbeatPrebindCloseIdempotencyKey(candidate.admission_id, event.event_id) &&
                  candidate.terminal_correlation_id === event.event_id,
            );
          if (!occurrence) {
            throw admissionConflict(
              "SESSION_MUTATION_ADMISSION_REPLAY_CONFLICT",
              "Heartbeat preemption replay lost its occurrence evidence.",
            );
          }
          return {
            disposition: "replayed",
            preemptionDisposition: "replayed",
            controllerGeneration: replayGeneration,
            admission: mapAdmission(replay),
            controlEventId: event.event_id,
            occurrenceId: occurrence.occurrence_id,
            heartbeatAdmissionId: occurrence.admission_id,
            ...(occurrence.durable_run_id ? { durableRunId: occurrence.durable_run_id } : {}),
          };
        }

        const sessionIncarnationId = this.requireCurrentSessionAuthority(normalized);
        if (
          normalized.expectedSessionIncarnationId !== null &&
          normalized.expectedSessionIncarnationId !== sessionIncarnationId
        ) {
          throw admissionConflict(
            "SESSION_MUTATION_INCARNATION_MISMATCH",
            "Mutation admission expected a different session incarnation.",
          );
        }
        let activeAdmission = this.db
          .prepare(
            `SELECT * FROM chat_session_mutation_admissions
             WHERE workspace_id = @workspaceId AND session_id = @sessionId
               AND admission_kind = 'turn_write' AND status = 'active'
             ORDER BY admission_id${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
          )
          .get<AdmissionRow>({ workspaceId: normalized.workspaceId, sessionId: normalized.sessionId });
        if (!activeAdmission) {
          const openOccurrence = this.db
            .prepare(
              `SELECT occurrence_id FROM chat_heartbeat_occurrences
               WHERE workspace_id = @workspaceId AND session_id = @sessionId
                 AND state IN ('admitted', 'durable_bound')`,
            )
            .get<{ occurrence_id: string }>({
              workspaceId: normalized.workspaceId,
              sessionId: normalized.sessionId,
            });
          if (openOccurrence) {
            throw admissionConflict(
              "SESSION_MUTATION_HEARTBEAT_OCCURRENCE_CONFLICT",
              "An unresolved heartbeat occurrence has no active admission.",
            );
          }
          const created = this.insertNormalizedAdmission(normalized, sessionIncarnationId);
          return {
            ...created,
            preemptionDisposition: "not_required",
            controllerGeneration: expectedControllerGeneration,
          };
        }
        const occurrence = this.db
          .prepare(
            `SELECT occurrence_id, workspace_id, session_id, session_incarnation_id, admission_id,
                    expected_durable_run_id, durable_run_id, state, revision, turn_id,
                    controller_generation, aggregate_revision, user_message_id, assistant_message_id,
                    admission_material_sha256, claim_sha256
             FROM chat_heartbeat_occurrences
             WHERE admission_id = @admissionId${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
          )
          .get<{
            occurrence_id: string;
            workspace_id: string;
            session_id: string;
            session_incarnation_id: string;
            admission_id: string;
            expected_durable_run_id: string;
            durable_run_id: string | null;
            state: "admitted" | "durable_bound" | "terminal" | "abandoned";
            revision: number | bigint | string;
            turn_id: string;
            controller_generation: number | bigint | string;
            aggregate_revision: number | bigint | string;
            user_message_id: string;
            assistant_message_id: string;
            admission_material_sha256: string;
            claim_sha256: string;
          }>({ admissionId: activeAdmission.admission_id });
        if (
          activeAdmission.actor_kind !== "system" ||
          activeAdmission.actor_id !== "system-heartbeat" ||
          activeAdmission.operation !== "chat_system_heartbeat" ||
          asPositiveInteger(activeAdmission.controller_generation) !== expectedControllerGeneration ||
          !occurrence ||
          !["admitted", "durable_bound"].includes(occurrence.state) ||
          occurrence.workspace_id !== normalized.workspaceId ||
          occurrence.session_id !== normalized.sessionId ||
          occurrence.session_incarnation_id !== sessionIncarnationId ||
          occurrence.turn_id !== activeAdmission.turn_id ||
          asPositiveInteger(occurrence.controller_generation) !== expectedControllerGeneration ||
          asPositiveInteger(occurrence.aggregate_revision) !== normalized.aggregateRevision ||
          occurrence.admission_material_sha256 !== activeAdmission.material_sha256
        ) {
          throw admissionConflict(
            "SESSION_MUTATION_ACTIVE_TURN_CONFLICT",
            "The active turn is not an exact preemptible heartbeat occurrence.",
          );
        }

        let durablePreemptionRun: DurableRunFenceRow | undefined;
        if (occurrence.state === "durable_bound") {
          const binding = this.findDurableBinding(
            activeAdmission.admission_id,
            occurrence.turn_id,
            occurrence.expected_durable_run_id,
            true,
          );
          const run = this.requireDurableRun(occurrence.expected_durable_run_id, true);
          const payload = parseJsonObject(run.payload_json);
          if (
            !binding ||
            occurrence.durable_run_id !== occurrence.expected_durable_run_id ||
            run.workflow_key !== "chat.turn.execute" ||
            payload.heartbeatOccurrenceId !== occurrence.occurrence_id ||
            payload.heartbeatClaimSha256 !== occurrence.claim_sha256
          ) {
            throw admissionConflict(
              "SESSION_MUTATION_HEARTBEAT_PREEMPTION_CONFLICT",
              "Durable heartbeat preemption lacks exact run authority.",
            );
          }
          const decisionState = requireExactHeartbeatDecisionCommitState(this.db, {
            occurrenceId: occurrence.occurrence_id,
            claimSha256: occurrence.claim_sha256,
            workspaceId: occurrence.workspace_id,
            sessionId: occurrence.session_id,
            turnId: occurrence.turn_id,
            userMessageId: occurrence.user_message_id,
            assistantMessageId: occurrence.assistant_message_id,
            run,
          });
          if (decisionState === "committed") {
            return {
              disposition: "decision_committed",
              preemptionDisposition: "decision_committed",
              controllerGeneration: expectedControllerGeneration,
              workspaceId: occurrence.workspace_id,
              sessionId: occurrence.session_id,
              sessionIncarnationId: occurrence.session_incarnation_id,
              turnId: occurrence.turn_id,
              occurrenceId: occurrence.occurrence_id,
              heartbeatAdmissionId: occurrence.admission_id,
              durableRunId: occurrence.expected_durable_run_id,
            };
          }
          if (!["queued", "running", "waiting", "paused"].includes(run.status)) {
            throw admissionConflict(
              "SESSION_MUTATION_HEARTBEAT_PREEMPTION_CONFLICT",
              "Durable heartbeat is no longer preemptible.",
            );
          }
          durablePreemptionRun = run;
        }

        const nextControllerGeneration = incrementPositiveInteger(expectedControllerGeneration);
        const preemptionClock = this.readDatabaseRequestRuntimeLease();
        const preemptedAt = preemptionClock.heartbeatAt;
        if (occurrence.state === "admitted") {
          const expiredPredicate =
            this.db.dialect === "postgres"
              ? "gc_try_parse_timestamptz(runtime_lease_expires_at) <= gc_try_parse_timestamptz(@preemptedAt)"
              : "julianday(runtime_lease_expires_at) <= julianday(@preemptedAt)";
          const reclaimed = this.db
            .prepare(
              `UPDATE chat_session_mutation_admissions
               SET runtime_last_heartbeat_at = @preemptedAt,
                   runtime_lease_expires_at = @leaseExpiresAt,
                   runtime_lease_revision = runtime_lease_revision + 1
               WHERE admission_id = @admissionId AND status = 'active'
                 AND runtime_owner_id = @runtimeOwnerId
                 AND runtime_lease_revision = @leaseRevision
                 AND runtime_lease_relinquished_at IS NULL
                 AND ${expiredPredicate}`,
            )
            .run({
              admissionId: activeAdmission.admission_id,
              runtimeOwnerId: activeAdmission.runtime_owner_id,
              leaseRevision: asPositiveInteger(activeAdmission.runtime_lease_revision!),
              preemptedAt,
              leaseExpiresAt: preemptionClock.leaseExpiresAt,
            });
          if (reclaimed.changes === 1) {
            activeAdmission = this.requireRow(activeAdmission.admission_id, true);
          }
        }
        const controlEventId = deriveId(
          "sce",
          normalized.workspaceId,
          normalized.sessionId,
          preemptionIdempotencyKey,
          "heartbeat_preempted",
        );
        closePendingControlRequestsForHeartbeatPreemption(this.db, {
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          generation: expectedControllerGeneration,
          operatorActorId: normalized.actorId,
          correlationId: normalized.correlationId,
          controlEventId,
          preemptedAt,
        });
        const insertPreemptionEvent = () =>
          insertHeartbeatPreemptionControlEvent(this.db, {
            eventId: controlEventId,
            workspaceId: normalized.workspaceId,
            sessionId: normalized.sessionId,
            previousGeneration: expectedControllerGeneration,
            nextGeneration: nextControllerGeneration,
            actorId: normalized.actorId,
            idempotencyKey: preemptionIdempotencyKey,
            requestSha256: preemptionRequestSha256,
            correlationId: normalized.correlationId,
            createdAt: preemptedAt,
          });
        insertPreemptionEvent();
        const terminalized = this.db
          .prepare(
            `UPDATE chat_session_control_grants
             SET is_current = 0, lease_state = 'superseded', control_revision = control_revision + 1,
                 updated_at = @preemptedAt, terminal_at = @preemptedAt
             WHERE workspace_id = @workspaceId AND session_id = @sessionId
               AND generation = @expectedControllerGeneration AND is_current = 1
               AND owner_kind = 'operator' AND lease_state = 'operator_active'`,
          )
          .run({
            workspaceId: normalized.workspaceId,
            sessionId: normalized.sessionId,
            expectedControllerGeneration,
            preemptedAt,
          });
        if (terminalized.changes !== 1) {
          throw admissionConflict(
            "SESSION_MUTATION_ADMISSION_AUTHORITY_CHANGED",
            "Session control changed during heartbeat preemption.",
          );
        }
        const emptyCapabilitiesSha256 = sha256("[]");
        this.db
          .prepare(
            `INSERT INTO chat_session_control_grants (
               workspace_id, session_id, generation, is_current, owner_kind, lease_state,
               requested_capabilities_json, requested_capabilities_sha256,
               effective_capabilities_json, effective_capabilities_sha256,
               control_revision, transition_idempotency_key, transition_request_sha256,
               created_at, updated_at
             ) VALUES (
               @workspaceId, @sessionId, @generation, 1, 'operator', 'operator_active',
               '[]', @emptyCapabilitiesSha256, '[]', @emptyCapabilitiesSha256,
               1, @idempotencyKey, @requestSha256, @createdAt, @createdAt
             )`,
          )
          .run({
            workspaceId: normalized.workspaceId,
            sessionId: normalized.sessionId,
            generation: nextControllerGeneration,
            emptyCapabilitiesSha256,
            idempotencyKey: preemptionIdempotencyKey,
            requestSha256: preemptionRequestSha256,
            createdAt: preemptedAt,
          });

        if (durablePreemptionRun) {
          const cancelledRun = this.db
            .prepare(
              `UPDATE durable_runs
               SET status = 'cancelled', finished_at = @preemptedAt,
                   lease_owner_id = NULL, lease_expires_at = NULL, lease_heartbeat_at = NULL,
                   version = version + 1, updated_at = @preemptedAt
               WHERE run_id = @runId AND version = @version
                 AND status IN ('queued', 'running', 'waiting', 'paused')`,
            )
            .run({
              runId: durablePreemptionRun.run_id,
              version: asPositiveInteger(durablePreemptionRun.version),
              preemptedAt,
            });
          if (cancelledRun.changes !== 1) {
            throw admissionConflict(
              "SESSION_MUTATION_HEARTBEAT_PREEMPTION_CONFLICT",
              "Durable heartbeat changed during preemption.",
            );
          }
        }

        const abandonmentReason =
          occurrence.state === "admitted" ? ("admission_closed" as const) : ("authority_drift" as const);
        if (occurrence.state === "admitted") {
          if (activeAdmission.runtime_owner_id === null || activeAdmission.runtime_lease_revision === null) {
            throw admissionConflict(
              "SESSION_MUTATION_HEARTBEAT_PREEMPTION_CONFLICT",
              "Pre-bind heartbeat preemption lost its request-runtime claim.",
            );
          }
          this.closeActiveRow(
            {
              admissionId: activeAdmission.admission_id,
              status: "cancelled",
              actorId: "system-heartbeat",
              idempotencyKey: heartbeatPrebindCloseIdempotencyKey(activeAdmission.admission_id, controlEventId),
              correlationId: controlEventId,
            },
            {
              kind: "request_runtime",
              claim: {
                runtimeOwnerId: activeAdmission.runtime_owner_id,
                leaseRevision: asPositiveInteger(activeAdmission.runtime_lease_revision),
              },
            },
            preemptedAt,
          );
        } else {
          this.closeActiveRow(
            {
              admissionId: activeAdmission.admission_id,
              status: "cancelled",
              actorId: "system:session-authority",
              idempotencyKey: `admission:authority-superseded:${activeAdmission.admission_id}:${controlEventId}`,
              correlationId: controlEventId,
            },
            { kind: "authority_superseded", controlEventId },
            preemptedAt,
          );
        }
        const abandoned = this.db
          .prepare(
            `UPDATE chat_heartbeat_occurrences
             SET state = 'abandoned', abandoned_at = @preemptedAt,
                 abandonment_reason = @abandonmentReason, revision = revision + 1,
                 updated_at = @preemptedAt
             WHERE occurrence_id = @occurrenceId AND revision = @revision
               AND state = @state`,
          )
          .run({
            occurrenceId: occurrence.occurrence_id,
            revision: asPositiveInteger(occurrence.revision),
            state: occurrence.state,
            abandonmentReason,
            preemptedAt,
          });
        if (abandoned.changes !== 1) {
          throw admissionConflict(
            "SESSION_MUTATION_HEARTBEAT_PREEMPTION_CONFLICT",
            "Heartbeat occurrence changed during preemption.",
          );
        }
        const operatorAdmission = this.insertNormalizedAdmission(
          { ...normalized, controllerGeneration: nextControllerGeneration },
          sessionIncarnationId,
        );
        return {
          ...operatorAdmission,
          preemptionDisposition: "preempted",
          controllerGeneration: nextControllerGeneration,
          controlEventId,
          occurrenceId: occurrence.occurrence_id,
          heartbeatAdmissionId: occurrence.admission_id,
          ...(occurrence.durable_run_id ? { durableRunId: occurrence.durable_run_id } : {}),
        };
      });
    } catch (error) {
      throw normalizeAdmissionWriteError(error);
    }
  }

  public abandonAdmittedHeartbeatForExecutionDisabled(
    input: AbandonAdmittedHeartbeatForExecutionDisabledInput,
  ): AbandonAdmittedHeartbeatForExecutionDisabledOutcome {
    const normalized = {
      workspaceId: identifier(input.workspaceId, "workspaceId"),
      sessionId: identifier(input.sessionId, "sessionId"),
      occurrenceId: identifier(input.occurrenceId, "occurrenceId"),
      admissionId: identifier(input.admissionId, "admissionId"),
      claimSha256: digest(input.claimSha256, "claimSha256"),
      idempotencyKey: boundedIdentifier(input.idempotencyKey, "idempotencyKey", 512),
      correlationId: identifier(input.correlationId, "correlationId"),
    };
    try {
      return this.db.transaction("immediate", () => {
        this.acquireSessionLock(normalized.sessionId);
        const occurrence = this.db
          .prepare(
            `SELECT occurrence_id, workspace_id, session_id, admission_id, claim_sha256,
                    state, revision, abandonment_reason
             FROM chat_heartbeat_occurrences
             WHERE occurrence_id = @occurrenceId${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
          )
          .get<{
            occurrence_id: string;
            workspace_id: string;
            session_id: string;
            admission_id: string;
            claim_sha256: string;
            state: "admitted" | "durable_bound" | "terminal" | "abandoned";
            revision: number | bigint | string;
            abandonment_reason: string | null;
          }>({ occurrenceId: normalized.occurrenceId });
        let admission = this.requireRow(normalized.admissionId, true);
        if (
          !occurrence ||
          occurrence.workspace_id !== normalized.workspaceId ||
          occurrence.session_id !== normalized.sessionId ||
          occurrence.admission_id !== normalized.admissionId ||
          occurrence.claim_sha256 !== normalized.claimSha256 ||
          admission.workspace_id !== normalized.workspaceId ||
          admission.session_id !== normalized.sessionId ||
          admission.actor_kind !== "system" ||
          admission.actor_id !== "system-heartbeat" ||
          admission.operation !== "chat_system_heartbeat"
        ) {
          throw admissionConflict(
            "SESSION_MUTATION_HEARTBEAT_OCCURRENCE_CONFLICT",
            "Execution-disabled heartbeat parking conflicts with immutable occurrence identity.",
          );
        }
        if (occurrence.state === "abandoned") {
          if (
            occurrence.abandonment_reason === "admission_closed" &&
            admission.status === "cancelled" &&
            admission.terminal_authority_kind === "request_runtime" &&
            admission.terminal_idempotency_key === normalized.idempotencyKey &&
            admission.terminal_correlation_id === normalized.correlationId
          ) {
            return {
              disposition: "replayed",
              occurrenceId: occurrence.occurrence_id,
              admission: mapAdmission(admission),
            };
          }
          return {
            disposition: "drift",
            occurrenceId: occurrence.occurrence_id,
            admission: mapAdmission(admission),
          };
        }
        if (
          occurrence.state !== "admitted" ||
          admission.status !== "active" ||
          admission.runtime_owner_id === null ||
          admission.runtime_lease_revision === null ||
          !this.admissionHasCurrentAuthority(admission) ||
          this.findDurableBinding(admission.admission_id, admission.turn_id!, undefined, true)
        ) {
          return {
            disposition: "drift",
            occurrenceId: occurrence.occurrence_id,
            admission: mapAdmission(admission),
          };
        }
        const parkingClock = this.readDatabaseRequestRuntimeLease();
        const parkedAt = parkingClock.heartbeatAt;
        const expiredPredicate =
          this.db.dialect === "postgres"
            ? "gc_try_parse_timestamptz(runtime_lease_expires_at) <= gc_try_parse_timestamptz(@parkedAt)"
            : "julianday(runtime_lease_expires_at) <= julianday(@parkedAt)";
        const reclaimed = this.db
          .prepare(
            `UPDATE chat_session_mutation_admissions
             SET runtime_last_heartbeat_at = @parkedAt,
                 runtime_lease_expires_at = @leaseExpiresAt,
                 runtime_lease_revision = runtime_lease_revision + 1
             WHERE admission_id = @admissionId AND status = 'active'
               AND runtime_owner_id = @runtimeOwnerId
               AND runtime_lease_revision = @leaseRevision
               AND runtime_lease_relinquished_at IS NULL
               AND ${expiredPredicate}`,
          )
          .run({
            admissionId: admission.admission_id,
            runtimeOwnerId: admission.runtime_owner_id,
            leaseRevision: asPositiveInteger(admission.runtime_lease_revision),
            parkedAt,
            leaseExpiresAt: parkingClock.leaseExpiresAt,
          });
        if (reclaimed.changes === 1) admission = this.requireRow(admission.admission_id, true);
        if (admission.runtime_owner_id === null || admission.runtime_lease_revision === null) {
          throw admissionConflict(
            "SESSION_MUTATION_HEARTBEAT_PREEMPTION_CONFLICT",
            "Execution-disabled heartbeat parking lost its request-runtime claim.",
          );
        }
        const closedAdmission = this.closeActiveRow(
          {
            admissionId: admission.admission_id,
            status: "cancelled",
            actorId: "system-heartbeat",
            idempotencyKey: normalized.idempotencyKey,
            correlationId: normalized.correlationId,
          },
          {
            kind: "request_runtime",
            claim: {
              runtimeOwnerId: admission.runtime_owner_id,
              leaseRevision: asPositiveInteger(admission.runtime_lease_revision),
            },
          },
          parkedAt,
        );
        const parked = this.db
          .prepare(
            `UPDATE chat_heartbeat_occurrences
             SET state = 'abandoned', abandoned_at = @parkedAt,
                 abandonment_reason = 'admission_closed', revision = revision + 1,
                 updated_at = @parkedAt
             WHERE occurrence_id = @occurrenceId AND state = 'admitted' AND revision = @revision`,
          )
          .run({
            occurrenceId: occurrence.occurrence_id,
            revision: asPositiveInteger(occurrence.revision),
            parkedAt,
          });
        if (parked.changes !== 1) {
          throw admissionConflict(
            "SESSION_MUTATION_HEARTBEAT_ABANDON_STALE",
            "Heartbeat occurrence changed during execution-disabled parking.",
          );
        }
        return {
          disposition: "parked",
          occurrenceId: occurrence.occurrence_id,
          admission: closedAdmission,
        };
      });
    } catch (error) {
      throw normalizeAdmissionWriteError(error);
    }
  }

  public renewTurnWriteRequestLease(input: RenewTurnWriteRequestLeaseInput): SessionMutationAdmissionRecord {
    const normalized = normalizeTurnWriteIdentity(input);
    const requestRuntimeClaim = normalizeRequestRuntimeClaim(input.requestRuntimeClaim);
    try {
      return this.db.transaction("immediate", () => {
        const observed = this.requireRow(normalized.admissionId, false);
        this.acquireSessionLock(observed.session_id);
        const admission = this.requireRow(normalized.admissionId, true);
        this.assertTurnWriteIdentity(admission, normalized);
        if (admission.status !== "active") {
          throw admissionConflict("SESSION_MUTATION_ADMISSION_CLOSED", "Turn mutation admission is closed.");
        }
        this.requireAdmissionCurrentAuthority(admission);
        this.requireExactTurnBinding(admission);
        if (this.findDurableBinding(normalized.admissionId, normalized.turnId, undefined, true)) {
          throw admissionConflict(
            "SESSION_MUTATION_REQUEST_LEASE_RELINQUISHED",
            "Durable-bound turn no longer uses the request-runtime lease.",
          );
        }
        this.requireFreshRequestRuntimeClaim(admission, requestRuntimeClaim);
        const nextLease = this.readDatabaseRequestRuntimeLease();
        const renewed = this.db
          .prepare(
            `UPDATE chat_session_mutation_admissions
             SET runtime_last_heartbeat_at = @heartbeatAt,
                 runtime_lease_expires_at = @leaseExpiresAt,
                 runtime_lease_revision = runtime_lease_revision + 1
             WHERE admission_id = @admissionId AND status = 'active'
               AND runtime_owner_id = @runtimeOwnerId
               AND runtime_lease_revision = @leaseRevision
               AND runtime_lease_relinquished_at IS NULL`,
          )
          .run({
            admissionId: normalized.admissionId,
            runtimeOwnerId: requestRuntimeClaim.runtimeOwnerId,
            leaseRevision: requestRuntimeClaim.leaseRevision,
            ...nextLease,
          });
        if (renewed.changes !== 1) {
          throw admissionConflict(
            "SESSION_MUTATION_REQUEST_LEASE_STALE",
            "Turn request-runtime lease changed during renewal.",
          );
        }
        return this.require(normalized.admissionId);
      });
    } catch (error) {
      throw normalizeAdmissionWriteError(error);
    }
  }

  public bindDurableRun(input: BindTurnWriteDurableRunInput): BindTurnWriteDurableRunOutcome {
    const normalized = normalizeTurnWriteIdentity(input);
    const durableRunId = identifier(input.durableRunId, "durableRunId");
    const requestRuntimeClaim = normalizeRequestRuntimeClaim(input.requestRuntimeClaim);
    try {
      return this.db.transaction("immediate", () => {
        const observed = this.requireRow(normalized.admissionId, false);
        this.acquireSessionLock(observed.session_id);
        const admission = this.requireRow(normalized.admissionId, true);
        this.assertTurnWriteIdentity(admission, normalized);
        if (admission.status !== "active") {
          throw admissionConflict(
            "SESSION_MUTATION_ADMISSION_CLOSED",
            "A closed turn admission cannot bind a durable run.",
          );
        }
        this.requireAdmissionCurrentAuthority(admission);
        const existing = this.findDurableBinding(normalized.admissionId, normalized.turnId, durableRunId, true);
        if (existing) {
          if (
            existing.admission_id !== normalized.admissionId ||
            existing.turn_id !== normalized.turnId ||
            existing.workspace_id !== normalized.workspaceId ||
            existing.session_id !== normalized.sessionId ||
            existing.session_incarnation_id !== normalized.sessionIncarnationId ||
            existing.durable_run_id !== durableRunId
          ) {
            throw admissionConflict(
              "SESSION_MUTATION_DURABLE_BINDING_CONFLICT",
              "Turn admission durable-run binding conflicts.",
            );
          }
          this.requireExactDurableRunPayloadIdentity(admission, this.requireDurableRun(durableRunId, true));
          return { disposition: "replayed", binding: mapDurableBinding(existing) };
        }
        this.requireExactTurnBinding(admission);
        this.requireFreshRequestRuntimeClaim(admission, requestRuntimeClaim);
        const run = this.requireDurableRun(durableRunId, true);
        if (
          run.workflow_key !== "chat.turn.execute" ||
          !["queued", "running", "waiting", "paused"].includes(run.status)
        ) {
          throw admissionConflict(
            "SESSION_MUTATION_DURABLE_RUN_INELIGIBLE",
            "Turn admission durable-run target is not an active Chat run.",
          );
        }
        this.requireExactDurableRunPayloadIdentity(admission, run);
        const createdAt = this.readDatabaseTime();
        this.db
          .prepare(
            `INSERT INTO chat_turn_mutation_admission_durable_bindings (
               admission_id, turn_id, workspace_id, session_id, session_incarnation_id, durable_run_id, created_at
             ) VALUES (
               @admissionId, @turnId, @workspaceId, @sessionId, @sessionIncarnationId, @durableRunId, @createdAt
             )`,
          )
          .run({ ...normalized, durableRunId, createdAt });
        const transferred = this.db
          .prepare(
            `UPDATE chat_session_mutation_admissions
             SET runtime_lease_relinquished_at = @createdAt,
                 runtime_lease_revision = runtime_lease_revision + 1
             WHERE admission_id = @admissionId AND status = 'active'
               AND runtime_owner_id = @runtimeOwnerId
               AND runtime_lease_revision = @leaseRevision
               AND runtime_lease_relinquished_at IS NULL`,
          )
          .run({
            admissionId: normalized.admissionId,
            runtimeOwnerId: requestRuntimeClaim.runtimeOwnerId,
            leaseRevision: requestRuntimeClaim.leaseRevision,
            createdAt,
          });
        if (transferred.changes !== 1) {
          throw admissionConflict(
            "SESSION_MUTATION_REQUEST_LEASE_STALE",
            "Turn request-runtime lease changed during durable transfer.",
          );
        }
        return {
          disposition: "created",
          binding: mapDurableBinding(
            this.requireDurableBinding(normalized.admissionId, normalized.turnId, durableRunId, false),
          ),
        };
      });
    } catch (error) {
      throw normalizeAdmissionWriteError(error);
    }
  }

  public findVerifiedTerminalTurnWriteHandoff(
    input: VerifyTerminalTurnWriteHandoffInput,
  ): VerifiedTerminalTurnWriteHandoff | undefined {
    const identity = normalizeTurnWriteIdentity(input);
    const durableRunId = identifier(input.durableRunId, "durableRunId");
    const userMessageId = identifier(input.userMessageId, "userMessageId");
    const assistantMessageId = identifier(input.assistantMessageId, "assistantMessageId");
    return this.db.transaction("immediate", () => {
      this.acquireSessionLock(identity.sessionId);
      const admission = this.requireRow(identity.admissionId, true);
      this.assertTurnWriteIdentity(admission, identity);
      const binding = this.requireDurableBinding(identity.admissionId, identity.turnId, durableRunId, true);
      const run = this.requireDurableRun(durableRunId, true);
      if (
        admission.status === "active" ||
        !["completed", "failed", "cancelled", "dead_lettered"].includes(run.status)
      ) {
        return undefined;
      }
      if (
        run.status === "dead_lettered" ||
        admission.terminal_authority_kind !== "durable_terminal" ||
        admission.terminal_durable_run_id !== durableRunId ||
        admission.terminal_durable_run_status !== run.status
      ) {
        throw admissionConflict(
          "SESSION_MUTATION_DURABLE_TERMINAL_EVIDENCE_MISSING",
          "Terminal heartbeat run lacks exact durable admission evidence.",
        );
      }
      this.requireTerminalDurableHandoffEvidence(admission, binding, run);
      const trace = this.db
        .prepare(
          `SELECT session_id, user_message_id, assistant_message_id, status, finished_at
           FROM chat_turn_traces WHERE turn_id = @turnId${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
        )
        .get<{
          session_id: string;
          user_message_id: string;
          assistant_message_id: string | null;
          status:
            | "queued"
            | "running"
            | "waiting_for_tool"
            | "waiting_for_approval"
            | "waiting_for_user_input"
            | "completed"
            | "partial"
            | "failed"
            | "cancelled";
          finished_at: string | null;
        }>({ turnId: identity.turnId });
      const traceMatchesRun =
        run.status === "completed"
          ? trace?.status === "completed" || trace?.status === "partial"
          : run.status === "failed"
            ? trace?.status === "failed"
            : trace?.status === "cancelled";
      if (
        !trace ||
        trace.session_id !== identity.sessionId ||
        trace.user_message_id !== userMessageId ||
        trace.assistant_message_id !== assistantMessageId ||
        !trace.finished_at ||
        !traceMatchesRun
      ) {
        throw admissionConflict(
          "SESSION_MUTATION_DURABLE_TERMINAL_TRACE_CONFLICT",
          "Terminal heartbeat run conflicts with its exact trace finalizer.",
        );
      }
      const metadata = run.metadata_json ? parseJsonObject(run.metadata_json) : {};
      if (
        "generalChatPostCommitPending" in metadata ||
        "linkedFinalizationPending" in metadata ||
        "autonomousChatPostCommitPending" in metadata
      ) {
        throw admissionConflict(
          "SESSION_MUTATION_DURABLE_HANDOFF_PENDING",
          "Terminal heartbeat run still has pending finalizer authority.",
        );
      }
      const marker = readChatTurnAdmissionHandoffMarker(metadata.chatTurnAdmissionHandoff);
      if (!marker) {
        throw admissionConflict(
          "SESSION_MUTATION_DURABLE_HANDOFF_MISSING",
          "Terminal heartbeat run has no exact committed handoff marker.",
        );
      }
      return {
        durableRunStatus: run.status as "completed" | "failed" | "cancelled",
        traceStatus: trace.status as "completed" | "partial" | "failed" | "cancelled",
        handoffSha256: sha256(canonicalJsonString(marker)),
      };
    });
  }

  public requireExactDurableTurnPayloadIdentity(input: VerifyDurableTurnPayloadIdentityInput): void {
    const identity = normalizeTurnWriteIdentity(input);
    const durableRunId = identifier(input.durableRunId, "durableRunId");
    this.db.transaction("immediate", () => {
      const observed = this.requireRow(identity.admissionId, false);
      this.acquireSessionLock(observed.session_id);
      const admission = this.requireRow(identity.admissionId, true);
      this.assertTurnWriteIdentity(admission, identity);
      this.requireDurableBinding(identity.admissionId, identity.turnId, durableRunId, true);
      this.requireExactDurableRunPayloadIdentity(admission, this.requireDurableRun(durableRunId, true));
    });
  }

  /**
   * Freeze a capability profile to an active turn admission before the profile
   * row itself is inserted. The profile foreign key is deferred, so callers
   * must perform this operation and immutable profile creation in one outer
   * immediate transaction.
   */
  public bindCapabilityProfile(input: BindTurnCapabilityProfileInput): BindTurnCapabilityProfileOutcome {
    const normalized = normalizeTurnWriteIdentity(input);
    const profileId = identifier(input.profileId, "profileId");
    const profileHash = digest(input.profileHash, "profileHash");
    const createdAt = requiredIsoTimestamp(input.createdAt, "createdAt");
    const requestRuntimeClaim = input.requestRuntimeClaim
      ? normalizeRequestRuntimeClaim(input.requestRuntimeClaim)
      : undefined;
    const durableClaim = input.durableClaim ? normalizeDurableClaim(input.durableClaim) : undefined;
    if (requestRuntimeClaim && durableClaim) throw new ValidationError({ field: "requestRuntimeClaim" });
    try {
      return this.db.transaction("immediate", () => {
        const observed = this.requireRow(normalized.admissionId, false);
        this.acquireSessionLock(observed.session_id);
        const admission = this.requireRow(normalized.admissionId, true);
        this.assertTurnWriteIdentity(admission, normalized);
        if (admission.status !== "active") {
          throw admissionConflict("SESSION_MUTATION_ADMISSION_CLOSED", "Turn mutation admission is closed.");
        }
        this.requireAdmissionCurrentAuthority(admission);
        this.requireExactTurnBinding(admission);
        this.requireTurnWriteRuntimeAuthority(admission, normalized, requestRuntimeClaim, durableClaim);

        const existing = this.db
          .prepare(
            `SELECT profile_id, turn_id, profile_hash, created_at
             FROM chat_turn_capability_profile_incarnation_bindings
             WHERE profile_id = @profileId OR turn_id = @turnId${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
          )
          .get<{
            profile_id: string;
            turn_id: string;
            profile_hash: string;
            created_at: string;
          }>({ profileId, turnId: normalized.turnId });
        if (existing) {
          const binding = mapTurnCapabilityProfileBinding(existing);
          if (
            binding.profileId !== profileId ||
            binding.turnId !== normalized.turnId ||
            binding.profileHash !== profileHash ||
            binding.createdAt !== createdAt
          ) {
            throw admissionConflict(
              "SESSION_MUTATION_CAPABILITY_PROFILE_BINDING_CONFLICT",
              "Capability profile incarnation binding conflicts.",
            );
          }
          return { disposition: "replayed", binding };
        }
        this.db
          .prepare(
            `INSERT INTO chat_turn_capability_profile_incarnation_bindings (
               profile_id, turn_id, profile_hash, created_at
             ) VALUES (@profileId, @turnId, @profileHash, @createdAt)`,
          )
          .run({ profileId, turnId: normalized.turnId, profileHash, createdAt });
        return {
          disposition: "created",
          binding: { profileId, turnId: normalized.turnId, profileHash, createdAt },
        };
      });
    } catch (error) {
      throw normalizeAdmissionWriteError(error);
    }
  }

  /**
   * Read-only proof that an immutable capability profile belongs to this exact
   * turn admission. Terminal replay intentionally uses this path: it verifies
   * identity and bytes without reopening authority or acquiring a runtime
   * lease, and it never creates a missing binding.
   */
  public requireCapabilityProfileBinding(
    input: RequireTurnCapabilityProfileBindingInput,
  ): RequireTurnCapabilityProfileBindingOutcome {
    const normalized = normalizeTurnWriteIdentity(input);
    const profileId = identifier(input.profileId, "profileId");
    const profileHash = digest(input.profileHash, "profileHash");
    const createdAt = requiredIsoTimestamp(input.createdAt, "createdAt");
    try {
      const admissionRow = this.requireRow(normalized.admissionId, false);
      this.assertTurnWriteIdentity(admissionRow, normalized);
      const existing = this.db
        .prepare(
          `SELECT profile_id, turn_id, profile_hash, created_at
           FROM chat_turn_capability_profile_incarnation_bindings
           WHERE profile_id = @profileId OR turn_id = @turnId`,
        )
        .get<{
          profile_id: string;
          turn_id: string;
          profile_hash: string;
          created_at: string;
        }>({ profileId, turnId: normalized.turnId });
      if (!existing) {
        throw admissionConflict(
          "SESSION_MUTATION_CAPABILITY_PROFILE_BINDING_MISSING",
          "Capability profile incarnation binding is missing.",
        );
      }
      const binding = mapTurnCapabilityProfileBinding(existing);
      if (
        binding.profileId !== profileId ||
        binding.turnId !== normalized.turnId ||
        binding.profileHash !== profileHash ||
        binding.createdAt !== createdAt
      ) {
        throw admissionConflict(
          "SESSION_MUTATION_CAPABILITY_PROFILE_BINDING_CONFLICT",
          "Capability profile incarnation binding conflicts.",
        );
      }
      return { admission: mapAdmission(admissionRow), binding };
    } catch (error) {
      throw normalizeAdmissionWriteError(error);
    }
  }

  public resolveDurableChatUserInput(input: ResolveDurableChatUserInputInput): ResolveDurableChatUserInputOutcome {
    const normalized = normalizeDurableChatUserInputResolutionInput(input);
    try {
      return this.db.transaction("immediate", () => {
        const observed = this.requireRow(normalized.admissionIdentity.admissionId, false);
        this.acquireSessionLock(observed.session_id);
        const admission = this.requireRow(normalized.admissionIdentity.admissionId, true);
        this.assertDurableChatUserInputAdmissionIdentity(admission, normalized.admissionIdentity);
        if (
          admission.actor_kind !== "operator" ||
          !["none", "token", "basic", "loopback"].includes(normalized.responder.authActorSource)
        ) {
          throw admissionConflict(
            "SESSION_MUTATION_USER_INPUT_RESPONDER_UNAUTHORIZED",
            "Durable Chat user input requires an operator admission and a control-plane responder.",
          );
        }

        const replaySeal = this.findDurableChatUserInputContinuationSeal(
          normalized.admissionIdentity.admissionId,
          normalized.durableRunId,
          normalized.promptId,
          true,
        );
        if (replaySeal) {
          const seal = mapDurableChatUserInputContinuationSeal(replaySeal);
          const replayRun = this.requireDurableRun(normalized.durableRunId, true);
          this.requireExactDurableRunPayloadIdentity(admission, replayRun);
          const replayPayload = parseJsonObject(replayRun.payload_json);
          const responseRecord = readDurableChatUserInputResponses(replayPayload.userInputResponses).find(
            (candidate) => candidate.promptId === normalized.promptId,
          );
          if (!responseRecord) {
            throw admissionConflict(
              "SESSION_MUTATION_USER_INPUT_REPLAY_CONFLICT",
              "Durable Chat user-input continuation replay has no canonical response record.",
            );
          }
          this.assertExactDurableChatUserInputContinuationReplay(normalized, seal, responseRecord);
          return {
            disposition: "replayed",
            run: {
              runId: replayRun.run_id,
              status: replayRun.status,
              version: asPositiveInteger(replayRun.version),
            },
            seal,
            responseRecord,
          };
        }

        if (admission.status !== "active") {
          throw admissionConflict("SESSION_MUTATION_ADMISSION_CLOSED", "Turn mutation admission is closed.");
        }
        this.requireAdmissionCurrentAuthority(admission);
        this.requireExactTurnBinding(admission);
        const durableBinding = this.requireDurableBinding(
          normalized.admissionIdentity.admissionId,
          normalized.admissionIdentity.turnId,
          normalized.durableRunId,
          true,
        );
        if (
          durableBinding.workspace_id !== normalized.admissionIdentity.workspaceId ||
          durableBinding.session_id !== normalized.admissionIdentity.sessionId ||
          durableBinding.session_incarnation_id !== normalized.admissionIdentity.sessionIncarnationId
        ) {
          throw admissionConflict(
            "SESSION_MUTATION_DURABLE_BINDING_CONFLICT",
            "Turn admission durable-run binding conflicts.",
          );
        }

        const run = this.requireDurableRun(normalized.durableRunId, true);
        if (
          run.workflow_key !== "chat.turn.execute" ||
          run.status !== "waiting" ||
          asPositiveInteger(run.version) !== normalized.expectedWaitingRunVersion
        ) {
          throw admissionConflict(
            "SESSION_MUTATION_USER_INPUT_WAIT_CONFLICT",
            "Durable Chat run is not at the expected waiting version.",
          );
        }
        this.requireExactDurableRunPayloadIdentity(admission, run);
        const payload = parseJsonObject(run.payload_json);
        const metadata = run.metadata_json ? parseJsonObject(run.metadata_json) : {};
        assertExactDurableChatUserInputWait(
          metadata,
          normalized.promptId,
          normalized.eventKey,
          normalized.correlationId,
        );
        const trace = this.requireWaitingChatUserInputTrace(normalized.admissionIdentity, normalized.durableRunId);
        const prompt = readExactChatUserInputPrompt(trace.pending_user_input_json!, normalized.promptId);
        if (prompt.turnId !== normalized.admissionIdentity.turnId) {
          throw admissionConflict(
            "SESSION_MUTATION_USER_INPUT_PROMPT_CONFLICT",
            "Chat turn pending user-input prompt belongs to a different turn.",
          );
        }
        const responses = readDurableChatUserInputResponses(payload.userInputResponses);
        if (responses.some((response) => response.promptId === normalized.promptId)) {
          throw admissionConflict(
            "SESSION_MUTATION_USER_INPUT_RESPONSE_EXISTS",
            "Durable Chat payload already contains this prompt response.",
          );
        }
        const resolvedAt = this.readDatabaseTime();
        const responseRecord = buildDurableChatUserInputResumeRecord(prompt, normalized.response, resolvedAt);
        const resumeRecordSha256 = sha256(canonicalJsonString(responseRecord));
        const queuedRunVersion = normalized.expectedWaitingRunVersion + 1;
        const sealMaterial = {
          version: 1 as const,
          admissionId: normalized.admissionIdentity.admissionId,
          sessionIncarnationId: normalized.admissionIdentity.sessionIncarnationId,
          workspaceId: normalized.admissionIdentity.workspaceId,
          sessionId: normalized.admissionIdentity.sessionId,
          turnId: normalized.admissionIdentity.turnId,
          durableRunId: normalized.durableRunId,
          promptId: normalized.promptId,
          eventKey: normalized.eventKey,
          correlationId: normalized.correlationId,
          resumeRecordSha256,
          responderActorId: normalized.responder.actorId,
          responderAuthActorSource: normalized.responder.authActorSource,
          waitingRunVersion: normalized.expectedWaitingRunVersion,
          queuedRunVersion,
          resolvedAt,
        };
        const materialSha256 = sha256(canonicalJsonString(sealMaterial));
        const sealId = deriveId(
          "ctuics",
          normalized.admissionIdentity.admissionId,
          normalized.durableRunId,
          normalized.promptId,
        );
        this.db
          .prepare(
            `INSERT INTO chat_turn_user_input_continuation_seals (
               seal_id, version, admission_id, session_incarnation_id, workspace_id, session_id,
               turn_id, durable_run_id, prompt_id, event_key, correlation_id,
               resume_record_sha256, responder_actor_id,
               responder_auth_actor_source, waiting_run_version, queued_run_version,
               resolved_at, material_sha256
             ) VALUES (
               @sealId, @version, @admissionId, @sessionIncarnationId, @workspaceId, @sessionId,
               @turnId, @durableRunId, @promptId, @eventKey, @correlationId,
               @resumeRecordSha256, @responderActorId,
               @responderAuthActorSource, @waitingRunVersion, @queuedRunVersion,
               @resolvedAt, @materialSha256
             )`,
          )
          .run({ sealId, ...sealMaterial, materialSha256 });

        const nextPayloadJson = canonicalJsonString({
          ...payload,
          userInputResponses: [...responses, responseRecord],
        });
        const updatedRun = this.db
          .prepare(
            `UPDATE durable_runs
             SET status = 'queued', payload_json = @payloadJson,
                 started_at = COALESCE(started_at, @resolvedAt), finished_at = NULL,
                 last_error = NULL, lease_owner_id = NULL, lease_expires_at = NULL,
                 lease_heartbeat_at = NULL, version = version + 1, updated_at = @resolvedAt
             WHERE run_id = @durableRunId AND workflow_key = 'chat.turn.execute'
               AND status = 'waiting' AND version = @waitingRunVersion`,
          )
          .run({
            durableRunId: normalized.durableRunId,
            waitingRunVersion: normalized.expectedWaitingRunVersion,
            payloadJson: nextPayloadJson,
            resolvedAt,
          });
        if (updatedRun.changes !== 1) {
          throw admissionConflict(
            "SESSION_MUTATION_USER_INPUT_WAIT_CONFLICT",
            "Durable Chat waiting version changed during continuation resolution.",
          );
        }
        const updatedTrace = this.db
          .prepare(
            `UPDATE chat_turn_traces
             SET status = 'running', pending_user_input_json = NULL
             WHERE turn_id = @turnId AND session_id = @sessionId
               AND status = 'waiting_for_user_input' AND pending_user_input_json = @pendingUserInputJson`,
          )
          .run({
            turnId: normalized.admissionIdentity.turnId,
            sessionId: normalized.admissionIdentity.sessionId,
            pendingUserInputJson: trace.pending_user_input_json,
          });
        if (updatedTrace.changes !== 1) {
          throw admissionConflict(
            "SESSION_MUTATION_USER_INPUT_TRACE_CONFLICT",
            "Chat turn user-input trace changed during continuation resolution.",
          );
        }
        this.appendDurableChatUserInputResolvedEvent({
          sealId,
          ...sealMaterial,
          materialSha256,
        });
        return {
          disposition: "resolved",
          run: { runId: normalized.durableRunId, status: "queued", version: queuedRunVersion },
          seal: { sealId, ...sealMaterial, materialSha256 },
          responseRecord,
        };
      });
    } catch (error) {
      throw normalizeAdmissionWriteError(error);
    }
  }

  public assertActiveTurnWrite(input: AssertActiveTurnWriteInput): AssertActiveTurnWriteOutcome {
    const normalized = normalizeTurnWriteIdentity(input);
    const requestRuntimeClaim = input.requestRuntimeClaim
      ? normalizeRequestRuntimeClaim(input.requestRuntimeClaim)
      : undefined;
    const durableClaim = input.durableClaim ? normalizeDurableClaim(input.durableClaim) : undefined;
    if (requestRuntimeClaim && durableClaim) throw new ValidationError({ field: "requestRuntimeClaim" });
    try {
      return this.db.transaction("immediate", () => {
        const observed = this.requireRow(normalized.admissionId, false);
        this.acquireSessionLock(observed.session_id);
        const admission = this.requireRow(normalized.admissionId, true);
        this.assertTurnWriteIdentity(admission, normalized);
        if (admission.status !== "active") {
          throw admissionConflict("SESSION_MUTATION_ADMISSION_CLOSED", "Turn mutation admission is closed.");
        }
        this.requireAdmissionCurrentAuthority(admission);
        this.requireExactTurnBinding(admission);
        const durableBinding = this.findDurableBinding(
          normalized.admissionId,
          normalized.turnId,
          durableClaim?.durableRunId,
          true,
        );
        if (!durableClaim) {
          if (durableBinding) {
            throw admissionConflict(
              "SESSION_MUTATION_DURABLE_CLAIM_REQUIRED",
              "Durable turn mutation requires the current execution claim.",
            );
          }
          if (!requestRuntimeClaim) {
            throw admissionConflict(
              "SESSION_MUTATION_REQUEST_LEASE_REQUIRED",
              "Pre-durable turn mutation requires the current request-runtime lease.",
            );
          }
          this.requireFreshRequestRuntimeClaim(admission, requestRuntimeClaim);
          return { admission: mapAdmission(admission) };
        }
        if (
          !durableBinding ||
          durableBinding.admission_id !== normalized.admissionId ||
          durableBinding.turn_id !== normalized.turnId ||
          durableBinding.workspace_id !== normalized.workspaceId ||
          durableBinding.session_id !== normalized.sessionId ||
          durableBinding.session_incarnation_id !== normalized.sessionIncarnationId ||
          durableBinding.durable_run_id !== durableClaim.durableRunId
        ) {
          throw admissionConflict(
            "SESSION_MUTATION_DURABLE_BINDING_MISSING",
            "Durable turn mutation has no exact run binding.",
          );
        }
        const run = this.requireFreshDurableClaim(durableClaim);
        return {
          admission: mapAdmission(admission),
          durableRunVersion: asPositiveInteger(run.version),
        };
      });
    } catch (error) {
      throw normalizeAdmissionWriteError(error);
    }
  }

  public closeTurnWrite(input: CloseTurnWriteInput): SessionMutationAdmissionRecord {
    const identity = normalizeTurnWriteIdentity(input);
    const terminal = normalizeCloseInput(input);
    const requestRuntimeClaim = input.requestRuntimeClaim
      ? normalizeRequestRuntimeClaim(input.requestRuntimeClaim)
      : undefined;
    const durableClaim = input.durableClaim ? normalizeDurableClaim(input.durableClaim) : undefined;
    if (requestRuntimeClaim && durableClaim) throw new ValidationError({ field: "requestRuntimeClaim" });
    try {
      return this.db.transaction("immediate", () => {
        const observed = this.requireRow(identity.admissionId, false);
        this.acquireSessionLock(observed.session_id);
        const admission = this.requireRow(identity.admissionId, true);
        this.assertTurnWriteIdentity(admission, identity);
        if (admission.status !== "active") {
          if (admission.status === "cancelled" && admission.terminal_authority_kind === "authority_superseded") {
            return mapAdmission(admission);
          }
          this.assertExactTerminalReplayClaim(admission, requestRuntimeClaim, durableClaim);
          return this.requireExactTerminalReplay(admission, terminal);
        }
        this.requireAdmissionCurrentAuthority(admission);
        this.requireExactTurnBinding(admission);
        const durableBinding = this.findDurableBinding(
          identity.admissionId,
          identity.turnId,
          durableClaim?.durableRunId,
          true,
        );
        let closeProof: CloseAuthorityProof;
        if (durableBinding) {
          if (requestRuntimeClaim) {
            throw admissionConflict(
              "SESSION_MUTATION_REQUEST_LEASE_RELINQUISHED",
              "Durable-bound turn no longer uses the request-runtime lease.",
            );
          }
          if (durableClaim) {
            if (durableBinding.durable_run_id !== durableClaim.durableRunId) {
              throw admissionConflict(
                "SESSION_MUTATION_DURABLE_BINDING_CONFLICT",
                "Turn admission durable-run binding conflicts.",
              );
            }
            const run = this.requireFreshDurableClaim(durableClaim);
            closeProof = {
              kind: "durable_run",
              claim: durableClaim,
              runVersion: asPositiveInteger(run.version),
            };
          } else {
            const run = this.requireDurableRun(durableBinding.durable_run_id, true);
            if (!["completed", "failed", "cancelled"].includes(run.status)) {
              throw admissionConflict(
                "SESSION_MUTATION_DURABLE_CLAIM_REQUIRED",
                "A non-canonical terminal durable turn cannot close admitted Chat authority.",
              );
            }
            const expectedTerminalStatus = run.status === "completed" ? "completed" : "cancelled";
            if (terminal.status !== expectedTerminalStatus) {
              throw admissionConflict(
                "SESSION_MUTATION_DURABLE_TERMINAL_STATUS_CONFLICT",
                "Turn admission terminal status conflicts with the durable run outcome.",
              );
            }
            this.requireTerminalDurableHandoffEvidence(admission, durableBinding, run);
            closeProof = {
              kind: "durable_terminal",
              durableRunId: durableBinding.durable_run_id,
              runVersion: asPositiveInteger(run.version),
              runStatus: run.status as "completed" | "failed" | "cancelled",
            };
          }
        } else {
          if (durableClaim) {
            throw admissionConflict(
              "SESSION_MUTATION_DURABLE_BINDING_MISSING",
              "Turn admission has no durable-run binding.",
            );
          }
          if (!requestRuntimeClaim) {
            throw admissionConflict(
              "SESSION_MUTATION_REQUEST_LEASE_REQUIRED",
              "Non-durable turn close requires the current request-runtime lease.",
            );
          }
          this.requireFreshRequestRuntimeClaim(admission, requestRuntimeClaim);
          closeProof = { kind: "request_runtime", claim: requestRuntimeClaim };
        }
        return this.closeActiveRow(terminal, closeProof);
      });
    } catch (error) {
      throw normalizeAdmissionWriteError(error);
    }
  }

  public cancelExpiredUnboundTurnAdmissions(
    input: CancelExpiredUnboundTurnAdmissionsInput,
  ): CancelExpiredUnboundTurnAdmissionsOutcome {
    const actorId = identifier(input.actorId, "actorId");
    const idempotencyKeyPrefix = boundedIdentifier(input.idempotencyKeyPrefix, "idempotencyKeyPrefix", 400);
    const correlationId = identifier(input.correlationId, "correlationId");
    const limit = boundedLimit(input.limit ?? 50, 100, "limit");
    try {
      return this.db.transaction("immediate", () => {
        const expiryPredicate =
          this.db.dialect === "postgres"
            ? "gc_try_parse_timestamptz(admission.runtime_lease_expires_at) <= clock_timestamp()"
            : "julianday(admission.runtime_lease_expires_at) <= julianday('now')";
        const candidates = this.db
          .prepare(
            `SELECT admission.admission_id, admission.session_id
             FROM chat_session_mutation_admissions admission
             WHERE admission.status = 'active' AND admission.admission_kind = 'turn_write'
               AND admission.runtime_lease_relinquished_at IS NULL
               AND ${expiryPredicate}
               AND NOT EXISTS (
                 SELECT 1 FROM chat_turn_mutation_admission_durable_bindings durable_binding
                 WHERE durable_binding.admission_id = admission.admission_id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM chat_heartbeat_occurrences occurrence
                 WHERE occurrence.admission_id = admission.admission_id
                   AND occurrence.state IN ('admitted', 'durable_bound')
               )
             ORDER BY admission.session_id ASC, admission.admission_id ASC
             LIMIT @limit`,
          )
          .all<{ admission_id: string; session_id: string }>({ limit });
        const cancelledAdmissionIds: string[] = [];
        for (const candidate of candidates) {
          this.acquireSessionLock(candidate.session_id);
          const current = this.requireRow(candidate.admission_id, true);
          if (!this.isExpiredUnboundTurnWrite(current)) continue;
          const idempotencyKey = `${idempotencyKeyPrefix}:${sha256(candidate.admission_id).slice(0, 48)}`;
          this.closeActiveRow(
            {
              admissionId: candidate.admission_id,
              status: "cancelled",
              actorId,
              idempotencyKey,
              correlationId,
            },
            {
              kind: "expired_recovery",
              runtimeOwnerId: current.runtime_owner_id!,
              leaseRevision: asPositiveInteger(current.runtime_lease_revision!),
            },
          );
          cancelledAdmissionIds.push(candidate.admission_id);
        }
        return { cancelledAdmissionIds };
      });
    } catch (error) {
      throw normalizeAdmissionWriteError(error);
    }
  }

  public reclaimExpiredSystemTurnWriteRequestLease(
    input: ReclaimExpiredSystemTurnWriteRequestLeaseInput,
  ): ReclaimExpiredSystemTurnWriteRequestLeaseOutcome {
    const normalized = normalizeHeartbeatReclaimInput(input);
    try {
      return this.db.transaction("immediate", () => {
        this.acquireSessionLock(normalized.sessionId);
        let admission = this.requireRow(normalized.admissionId, true);
        this.assertTurnWriteIdentity(admission, normalized);
        if (
          admission.runtime_owner_id !== normalized.runtimeOwnerId ||
          admission.runtime_lease_revision === null ||
          admission.actor_kind !== "system" ||
          admission.actor_id !== normalized.actorId ||
          admission.operation !== normalized.operation ||
          admission.material_sha256 !== normalized.materialSha256 ||
          admission.idempotency_key !== normalized.idempotencyKey ||
          admission.correlation_id !== normalized.correlationId ||
          admission.request_sha256 !== normalized.admissionRequestSha256
        ) {
          throw admissionConflict(
            "SESSION_MUTATION_HEARTBEAT_RECLAIM_IDENTITY_CONFLICT",
            "Heartbeat request-runtime reclaim conflicts with immutable admission identity.",
          );
        }
        const occurrence = this.db
          .prepare(
            `SELECT occurrence_id, workspace_id, session_id, session_incarnation_id, admission_id,
                    runtime_owner_id, system_actor_id, admission_material_sha256,
                    admission_idempotency_key, admission_correlation_id, admission_request_sha256,
                    expected_durable_run_id, user_message_id, assistant_message_id,
                    evaluated_policy_sha256, frozen_request_sha256, frozen_objective_sha256,
                    claim_sha256, state, revision
             FROM chat_heartbeat_occurrences WHERE occurrence_id = @occurrenceId${
               this.db.dialect === "postgres" ? " FOR UPDATE" : ""
             }`,
          )
          .get<{
            occurrence_id: string;
            workspace_id: string;
            session_id: string;
            session_incarnation_id: string;
            admission_id: string;
            runtime_owner_id: string;
            system_actor_id: string;
            admission_material_sha256: string;
            admission_idempotency_key: string;
            admission_correlation_id: string;
            admission_request_sha256: string;
            expected_durable_run_id: string;
            user_message_id: string;
            assistant_message_id: string;
            evaluated_policy_sha256: string;
            frozen_request_sha256: string;
            frozen_objective_sha256: string;
            claim_sha256: string;
            state: "admitted" | "durable_bound" | "terminal" | "abandoned";
            revision: number | bigint | string;
          }>({ occurrenceId: normalized.occurrenceId });
        if (
          !occurrence ||
          occurrence.workspace_id !== normalized.workspaceId ||
          occurrence.session_id !== normalized.sessionId ||
          occurrence.session_incarnation_id !== normalized.sessionIncarnationId ||
          occurrence.admission_id !== normalized.admissionId ||
          occurrence.runtime_owner_id !== normalized.runtimeOwnerId ||
          occurrence.system_actor_id !== normalized.actorId ||
          occurrence.admission_material_sha256 !== normalized.materialSha256 ||
          occurrence.admission_idempotency_key !== normalized.idempotencyKey ||
          occurrence.admission_correlation_id !== normalized.correlationId ||
          occurrence.admission_request_sha256 !== normalized.admissionRequestSha256 ||
          occurrence.expected_durable_run_id !== normalized.expectedDurableRunId ||
          occurrence.user_message_id !== normalized.userMessageId ||
          occurrence.assistant_message_id !== normalized.assistantMessageId ||
          occurrence.evaluated_policy_sha256 !== normalized.evaluatedPolicySha256 ||
          occurrence.frozen_request_sha256 !== normalized.frozenRequestSha256 ||
          occurrence.frozen_objective_sha256 !== normalized.frozenObjectiveSha256 ||
          occurrence.claim_sha256 !== normalized.claimSha256
        ) {
          throw admissionConflict(
            "SESSION_MUTATION_HEARTBEAT_OCCURRENCE_CONFLICT",
            "Heartbeat request-runtime reclaim has no exact admitted occurrence.",
          );
        }
        const durableBinding = this.findDurableBinding(
          normalized.admissionId,
          normalized.turnId,
          normalized.expectedDurableRunId,
          true,
        );
        if (durableBinding || occurrence.state === "durable_bound" || occurrence.state === "terminal") {
          return { disposition: "durable_bound", admission: mapAdmission(admission) };
        }
        if (occurrence.state === "abandoned" || admission.status !== "active") {
          if (occurrence.state === "admitted") {
            this.abandonHeartbeatOccurrenceForClosedAdmission(occurrence, admission);
          }
          const closedReason = heartbeatClosedReason(admission);
          return {
            disposition: "closed_or_authority_drift",
            reason: closedReason === "admission_closed" ? "closed" : closedReason,
            admission: mapAdmission(admission),
          };
        }
        if (!this.admissionHasCurrentAuthority(admission)) {
          const lifecycle = this.db
            .prepare(
              `SELECT meta.lifecycle_intent_id, meta.deletion_intent_id,
                      deletion_intent.actor_id AS deletion_actor_id,
                      deletion_intent.correlation_id AS deletion_correlation_id
               FROM chat_session_meta meta
               LEFT JOIN chat_session_lifecycle_intents deletion_intent
                 ON deletion_intent.intent_id = meta.deletion_intent_id
               WHERE meta.session_id = @sessionId${this.db.dialect === "postgres" ? " FOR UPDATE OF meta" : ""}`,
            )
            .get<{
              lifecycle_intent_id: string | null;
              deletion_intent_id: string | null;
              deletion_actor_id: string | null;
              deletion_correlation_id: string | null;
            }>({
              sessionId: normalized.sessionId,
            });
          const driftReason = lifecycle?.deletion_intent_id ? "lifecycle_drift" : "authority_drift";
          if (lifecycle?.deletion_intent_id) {
            if (!lifecycle.deletion_actor_id || !lifecycle.deletion_correlation_id) {
              throw admissionConflict(
                "SESSION_MUTATION_HEARTBEAT_LIFECYCLE_PROOF_MISSING",
                "Heartbeat recovery found deletion drift without its exact lifecycle close proof.",
              );
            }
            this.closeActiveRow(
              normalizeCloseInput({
                admissionId: normalized.admissionId,
                status: "cancelled",
                actorId: lifecycle.deletion_actor_id,
                idempotencyKey: `lifecycle:delete:admission:${normalized.admissionId}`,
                correlationId: lifecycle.deletion_correlation_id,
              }),
              { kind: "lifecycle_delete", lifecycleIntentId: lifecycle.deletion_intent_id },
            );
            admission = this.requireRow(normalized.admissionId, true);
          } else {
            const controlEventId = this.requireCurrentControlEventId(normalized.sessionId);
            this.closeActiveRow(
              normalizeCloseInput({
                admissionId: normalized.admissionId,
                status: "cancelled",
                actorId: "system:session-authority",
                idempotencyKey: `admission:authority-superseded:${normalized.admissionId}:${controlEventId}`,
                correlationId: controlEventId,
              }),
              { kind: "authority_superseded", controlEventId },
            );
            admission = this.requireRow(normalized.admissionId, true);
          }
          this.abandonHeartbeatOccurrence(
            occurrence.occurrence_id,
            asPositiveInteger(occurrence.revision),
            driftReason,
          );
          return {
            disposition: "closed_or_authority_drift",
            reason: driftReason,
            admission: mapAdmission(admission),
          };
        }
        const currentLeaseRevision = asPositiveInteger(admission.runtime_lease_revision);
        if (normalized.expectedLeaseRevision < currentLeaseRevision) {
          return { disposition: "live", admission: mapAdmission(admission) };
        }
        if (normalized.expectedLeaseRevision > currentLeaseRevision) {
          throw admissionConflict(
            "SESSION_MUTATION_HEARTBEAT_RECLAIM_IDENTITY_CONFLICT",
            "Heartbeat request-runtime reclaim references a future lease revision.",
          );
        }
        const livePredicate =
          this.db.dialect === "postgres"
            ? "gc_try_parse_timestamptz(runtime_lease_expires_at) > clock_timestamp()"
            : "julianday(runtime_lease_expires_at) > julianday('now')";
        if (
          this.db
            .prepare(
              `SELECT 1 FROM chat_session_mutation_admissions
               WHERE admission_id = @admissionId AND status = 'active'
                 AND runtime_owner_id = @runtimeOwnerId AND runtime_lease_revision = @leaseRevision
                 AND runtime_lease_relinquished_at IS NULL AND ${livePredicate}`,
            )
            .get({
              admissionId: normalized.admissionId,
              runtimeOwnerId: normalized.runtimeOwnerId,
              leaseRevision: normalized.expectedLeaseRevision,
            })
        ) {
          return { disposition: "live", admission: mapAdmission(admission) };
        }
        const nextLease = this.readDatabaseRequestRuntimeLease();
        const expiredPredicate =
          this.db.dialect === "postgres"
            ? "gc_try_parse_timestamptz(runtime_lease_expires_at) <= clock_timestamp()"
            : "julianday(runtime_lease_expires_at) <= julianday('now')";
        const reclaimed = this.db
          .prepare(
            `UPDATE chat_session_mutation_admissions
             SET runtime_last_heartbeat_at = @heartbeatAt,
                 runtime_lease_expires_at = @leaseExpiresAt,
                 runtime_lease_revision = runtime_lease_revision + 1
             WHERE admission_id = @admissionId AND status = 'active'
               AND runtime_owner_id = @runtimeOwnerId AND runtime_lease_revision = @leaseRevision
               AND runtime_lease_relinquished_at IS NULL AND ${expiredPredicate}
               AND EXISTS (
                 SELECT 1 FROM chat_heartbeat_occurrences occurrence
                 WHERE occurrence.occurrence_id = @occurrenceId
                   AND occurrence.admission_id = chat_session_mutation_admissions.admission_id
                   AND occurrence.state = 'admitted'
               )`,
          )
          .run({
            admissionId: normalized.admissionId,
            runtimeOwnerId: normalized.runtimeOwnerId,
            leaseRevision: normalized.expectedLeaseRevision,
            occurrenceId: normalized.occurrenceId,
            ...nextLease,
          });
        if (reclaimed.changes !== 1) {
          throw admissionConflict(
            "SESSION_MUTATION_HEARTBEAT_RECLAIM_STALE",
            "Heartbeat request-runtime lease changed during reclaim.",
          );
        }
        return { disposition: "reclaimed", admission: this.require(normalized.admissionId) };
      });
    } catch (error) {
      throw normalizeAdmissionWriteError(error);
    }
  }

  public settleTurnWriteAuthority(input: SettleTurnWriteAuthorityInput): SettleTurnWriteAuthorityOutcome {
    const identity = normalizeTurnWriteIdentity(input);
    try {
      return this.db.transaction("immediate", () => {
        const observed = this.requireRow(identity.admissionId, false);
        this.acquireSessionLock(observed.session_id);
        const admission = this.requireRow(identity.admissionId, true);
        this.assertTurnWriteIdentity(admission, identity);
        if (admission.status !== "active") {
          if (admission.status === "cancelled" && admission.terminal_authority_kind === "authority_superseded") {
            return { disposition: "authority_superseded", admission: mapAdmission(admission) };
          }
          throw admissionConflict(
            "SESSION_MUTATION_ADMISSION_CLOSED",
            "Mutation admission was settled by a different authority path.",
          );
        }
        const currentControlEventId = this.requireCurrentControlEventId(identity.sessionId);
        if (this.admissionHasCurrentAuthority(admission)) {
          return { disposition: "current", admission: mapAdmission(admission) };
        }
        return {
          disposition: "authority_superseded",
          admission: this.closeActiveRow(
            {
              admissionId: admission.admission_id,
              status: "cancelled",
              actorId: "system:session-authority",
              idempotencyKey: `admission:authority-superseded:${admission.admission_id}:${currentControlEventId}`,
              correlationId: currentControlEventId,
            },
            { kind: "authority_superseded", controlEventId: currentControlEventId },
          ),
        };
      });
    } catch (error) {
      throw normalizeAdmissionWriteError(error);
    }
  }

  public runParentLocalPostCommitStage<T>(
    input: ParentLocalPostCommitStageInput,
    callback: (authority: ParentLocalPostCommitStageAuthority) => T,
  ): ParentLocalPostCommitStageOutcome<T> {
    const normalized = normalizeParentLocalPostCommitStageInput(input);
    try {
      return this.db.transaction("immediate", () => {
        const observed = this.requireRow(normalized.parentAdmission.admissionId, false);
        this.acquireSessionLock(observed.session_id);
        const admission = this.requireRow(normalized.parentAdmission.admissionId, true);
        this.assertDurableChatUserInputAdmissionIdentity(admission, normalized.parentAdmission);
        const binding = this.requireDurableBinding(
          admission.admission_id,
          normalized.parentAdmission.turnId,
          normalized.parentRunId,
          true,
        );
        if (
          binding.workspace_id !== admission.workspace_id ||
          binding.session_id !== admission.session_id ||
          binding.session_incarnation_id !== admission.session_incarnation_id
        ) {
          throw admissionConflict(
            "SESSION_MUTATION_PARENT_LOCAL_BINDING_CONFLICT",
            "Parent-local post-commit stage has no exact durable binding.",
          );
        }
        const run = this.requireDurableRun(normalized.parentRunId, true);
        const marker = this.requireExactParentLocalPostCommitRun(admission, run, normalized);
        const runVersion = asPositiveInteger(run.version);
        if (marker.completedEffects.includes(normalized.effect)) {
          return {
            disposition: "replayed",
            admission: mapAdmission(admission),
            durableRunVersion: runVersion,
          };
        }
        if (admission.status !== "active") {
          if (admission.status === "cancelled" && admission.terminal_authority_kind === "authority_superseded") {
            return {
              disposition: "late_blocked",
              admission: mapAdmission(admission),
              durableRunVersion: runVersion,
            };
          }
          throw admissionConflict(
            "SESSION_MUTATION_PARENT_LOCAL_ADMISSION_CLOSED",
            "Parent-local post-commit stage admission was closed by a different authority path.",
          );
        }
        const currentControlEventId = this.requireCurrentControlEventId(admission.session_id);
        if (!this.admissionHasCurrentAuthority(admission)) {
          const settled = this.closeActiveRow(
            {
              admissionId: admission.admission_id,
              status: "cancelled",
              actorId: "system:session-authority",
              idempotencyKey: `admission:authority-superseded:${admission.admission_id}:${currentControlEventId}`,
              correlationId: currentControlEventId,
            },
            { kind: "authority_superseded", controlEventId: currentControlEventId },
          );
          return {
            disposition: "late_blocked",
            admission: settled,
            durableRunVersion: runVersion,
          };
        }
        const value = callback({
          admission: mapAdmission(admission),
          durableRunVersion: runVersion,
          effect: normalized.effect,
        });
        if (isThenable(value)) {
          throw new TypeError("Parent-local post-commit stage callback must be synchronous.");
        }
        const postCallbackAdmission = this.requireRow(admission.admission_id, true);
        if (postCallbackAdmission.status !== "active" || !this.admissionHasCurrentAuthority(postCallbackAdmission)) {
          throw admissionConflict(
            "SESSION_MUTATION_PARENT_LOCAL_AUTHORITY_CHANGED",
            "Parent-local post-commit authority changed during its callback.",
          );
        }
        const postCallbackRun = this.requireDurableRun(normalized.parentRunId, true);
        const postCallbackMarker = this.requireExactParentLocalPostCommitRun(
          postCallbackAdmission,
          postCallbackRun,
          normalized,
        );
        if (
          asPositiveInteger(postCallbackRun.version) !== runVersion ||
          postCallbackMarker.completedEffects.includes(normalized.effect)
        ) {
          throw admissionConflict(
            "SESSION_MUTATION_PARENT_LOCAL_RUN_CHANGED",
            "Parent-local post-commit parent changed during its callback.",
          );
        }
        const metadata = parseJsonObject(postCallbackRun.metadata_json!);
        metadata.generalChatPostCommitPending = {
          ...readJsonObject(metadata.generalChatPostCommitPending)!,
          completedEffects: [...postCallbackMarker.completedEffects, normalized.effect],
        };
        const updatedAt = this.readDatabaseTime();
        const updated = this.db
          .prepare(
            `UPDATE durable_runs
             SET metadata_json = @metadataJson, updated_at = @updatedAt, version = version + 1
             WHERE run_id = @parentRunId AND version = @expectedVersion`,
          )
          .run({
            metadataJson: canonicalJsonString(metadata),
            updatedAt,
            parentRunId: normalized.parentRunId,
            expectedVersion: runVersion,
          });
        if (updated.changes !== 1) {
          throw admissionConflict(
            "SESSION_MUTATION_PARENT_LOCAL_RUN_CHANGED",
            "Parent-local post-commit parent changed before its receipt committed.",
          );
        }
        return {
          disposition: "allowed",
          admission: mapAdmission(postCallbackAdmission),
          durableRunVersion: runVersion + 1,
          value,
        };
      });
    } catch (error) {
      throw normalizeAdmissionWriteError(error);
    }
  }

  public runPostCommitChildStage<T>(
    input: PostCommitChildStageInput,
    callback: (authority: PostCommitChildStageAuthority) => PostCommitChildStageCallbackOutcome<T>,
  ): PostCommitChildStageOutcome<T> {
    const normalized = normalizePostCommitChildStageInput(input);
    try {
      return this.db.transaction("immediate", () => {
        this.acquireSessionLock(normalized.childAdmission.sessionId);
        const admission = this.requireRow(normalized.childAdmission.admissionId, true);
        this.assertExactPostCommitChildAdmission(admission, normalized.childAdmission);
        const closedReplayDisposition = this.resolvePostCommitChildClosedReplayDisposition(admission, normalized);
        if (admission.status !== "active" && !closedReplayDisposition) {
          throw admissionConflict(
            "SESSION_MUTATION_POST_COMMIT_CHILD_CLOSED",
            "Post-commit child admission is already closed.",
          );
        }
        const run = this.requireFreshDurableClaimForWorkflow(normalized.durableClaim, "chat.post_commit.effect");
        this.assertExactPostCommitChildRun(normalized, run);
        const authorityDisposition =
          closedReplayDisposition ?? (this.admissionHasCurrentAuthority(admission) ? "allowed" : "late_blocked");
        const authority: PostCommitChildStageAuthority = {
          disposition: authorityDisposition,
          admission: mapAdmission(admission),
          durableRunVersion: asPositiveInteger(run.version),
        };
        const callbackOutcome = callback(authority);
        if (isThenable(callbackOutcome)) {
          throw new TypeError("Post-commit child stage callback must be synchronous.");
        }
        if (
          !callbackOutcome ||
          (callbackOutcome.disposition !== "allowed" && callbackOutcome.disposition !== "late_blocked")
        ) {
          throw new TypeError("Post-commit child stage callback returned an invalid disposition.");
        }
        const postCallbackRun = this.requireFreshDurableClaimForWorkflow(
          normalized.durableClaim,
          "chat.post_commit.effect",
        );
        this.assertExactPostCommitChildRun(normalized, postCallbackRun);
        const postCallbackRunVersion = asPositiveInteger(postCallbackRun.version);
        const disposition =
          authorityDisposition === "late_blocked" || callbackOutcome.disposition === "late_blocked"
            ? "late_blocked"
            : "allowed";
        if (admission.status === "completed" && disposition !== "allowed") {
          throw admissionConflict(
            "SESSION_MUTATION_POST_COMMIT_CHILD_REPLAY_CONFLICT",
            "A completed post-commit child stage cannot replay as late-blocked.",
          );
        }
        const shouldSettle = admission.status === "active" && (disposition === "late_blocked" || normalized.terminal);
        const settled = shouldSettle
          ? this.closeActiveRow(
              {
                admissionId: admission.admission_id,
                status: disposition === "allowed" ? "completed" : "cancelled",
                actorId: "system:chat-post-commit-stage",
                idempotencyKey: postCommitChildStageIdempotencyKey(normalized, disposition),
                correlationId: normalized.childRunId,
              },
              {
                kind: "post_commit_child_stage",
                claim: normalized.durableClaim,
                runVersion: postCallbackRunVersion,
              },
            )
          : mapAdmission(admission);
        return { disposition, value: callbackOutcome.value, admission: settled };
      });
    } catch (error) {
      throw normalizeAdmissionWriteError(error);
    }
  }

  public assertPostCommitChildDispatchAuthority(
    input: AssertPostCommitChildDispatchAuthorityInput,
  ): PostCommitChildStageAuthority {
    const normalized = normalizePostCommitChildDispatchInput(input);
    try {
      return this.db.transaction("immediate", () => {
        this.acquireSessionLock(normalized.childAdmission.sessionId);
        const admission = this.requireRow(normalized.childAdmission.admissionId, true);
        this.assertExactPostCommitChildAdmission(admission, normalized.childAdmission);
        if (admission.status !== "active") {
          throw admissionConflict(
            "SESSION_MUTATION_POST_COMMIT_CHILD_CLOSED",
            "Post-commit child admission is already closed.",
          );
        }
        const run = this.requireFreshDurableClaimForWorkflow(normalized.durableClaim, "chat.post_commit.effect");
        this.assertExactPostCommitChildRun(normalized, run);
        return {
          disposition: this.admissionHasCurrentAuthority(admission) ? "allowed" : "late_blocked",
          admission: mapAdmission(admission),
          durableRunVersion: asPositiveInteger(run.version),
        };
      });
    } catch (error) {
      throw normalizeAdmissionWriteError(error);
    }
  }

  public close(input: CloseSessionMutationAdmissionInput): SessionMutationAdmissionRecord {
    const normalized = {
      admissionId: identifier(input.admissionId, "admissionId"),
      status: input.status,
      actorId: identifier(input.actorId, "actorId"),
      idempotencyKey: boundedIdentifier(input.idempotencyKey, "idempotencyKey", 512),
      correlationId: identifier(input.correlationId, "correlationId"),
    };
    try {
      return this.db.transaction("immediate", () => {
        const observed = this.requireRow(normalized.admissionId, false);
        this.acquireSessionLock(observed.session_id);
        const current = this.requireRow(normalized.admissionId, true);
        if (current.session_id !== observed.session_id) {
          throw admissionConflict(
            "SESSION_MUTATION_ADMISSION_IDENTITY_CHANGED",
            "Mutation admission identity changed while acquiring authority.",
          );
        }
        if (current.status !== "active") {
          if (
            current.status === normalized.status &&
            current.terminal_actor_id === normalized.actorId &&
            current.terminal_idempotency_key === normalized.idempotencyKey &&
            current.terminal_correlation_id === normalized.correlationId
          ) {
            return mapAdmission(current);
          }
          throw admissionConflict("SESSION_MUTATION_ADMISSION_CLOSED", "Mutation admission is already closed.");
        }
        if (current.admission_kind === "turn_write") {
          throw admissionConflict(
            "SESSION_MUTATION_TURN_CLOSE_REQUIRES_FENCE",
            "Turn mutation admission close requires exact runtime authority.",
          );
        }
        this.requireAdmissionCurrentAuthority(current);
        return this.closeActiveRow(normalized, { kind: "synchronous" });
      });
    } catch (error) {
      throw normalizeAdmissionWriteError(error);
    }
  }

  public get(admissionId: string): SessionMutationAdmissionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM chat_session_mutation_admissions WHERE admission_id = @admissionId")
      .get<AdmissionRow>({ admissionId: identifier(admissionId, "admissionId") });
    return row ? mapAdmission(row) : undefined;
  }

  public require(admissionId: string): SessionMutationAdmissionRecord {
    return mapAdmission(this.requireRow(identifier(admissionId, "admissionId"), false));
  }

  public listActive(workspaceIdInput: string, sessionIdInput: string): SessionMutationAdmissionRecord[] {
    const workspaceId = identifier(workspaceIdInput, "workspaceId");
    const sessionId = identifier(sessionIdInput, "sessionId");
    return this.db
      .prepare(
        `SELECT * FROM chat_session_mutation_admissions
         WHERE workspace_id = @workspaceId AND session_id = @sessionId AND status = 'active'
         ORDER BY created_at ASC, admission_id ASC`,
      )
      .all<AdmissionRow>({ workspaceId, sessionId })
      .map(mapAdmission);
  }

  public listEvents(admissionIdInput: string): SessionMutationAdmissionEventRecord[] {
    const admissionId = identifier(admissionIdInput, "admissionId");
    return this.db
      .prepare(
        `SELECT * FROM chat_session_mutation_admission_events
         WHERE admission_id = @admissionId ORDER BY event_sequence ASC`,
      )
      .all<AdmissionEventRow>({ admissionId })
      .map(mapEvent);
  }

  private findByIdempotency(idempotencyKey: string): AdmissionRow | undefined {
    return this.db
      .prepare("SELECT * FROM chat_session_mutation_admissions WHERE idempotency_key = @idempotencyKey")
      .get<AdmissionRow>({ idempotencyKey });
  }

  private requireRow(admissionId: string, forUpdate: boolean): AdmissionRow {
    const row = this.db
      .prepare(
        `SELECT * FROM chat_session_mutation_admissions WHERE admission_id = @admissionId${
          forUpdate && this.db.dialect === "postgres" ? " FOR UPDATE" : ""
        }`,
      )
      .get<AdmissionRow>({ admissionId });
    if (!row) throw new NotFoundError({ entity: "Session mutation admission", id: admissionId });
    return row;
  }

  private requireExactTerminalReplay(
    admission: AdmissionRow,
    input: ReturnType<typeof normalizeCloseInput>,
  ): SessionMutationAdmissionRecord {
    if (
      admission.status === input.status &&
      admission.terminal_actor_id === input.actorId &&
      admission.terminal_idempotency_key === input.idempotencyKey &&
      admission.terminal_correlation_id === input.correlationId
    ) {
      return mapAdmission(admission);
    }
    throw admissionConflict("SESSION_MUTATION_ADMISSION_CLOSED", "Mutation admission is already closed.");
  }

  private closeActiveRow(
    input: ReturnType<typeof normalizeCloseInput>,
    proof: CloseAuthorityProof,
    closedAtOverride?: string,
  ): SessionMutationAdmissionRecord {
    const closedAt = closedAtOverride ?? this.readDatabaseTime();
    const updated = this.db
      .prepare(
        `UPDATE chat_session_mutation_admissions
         SET status = @status, closed_at = @closedAt, terminal_actor_id = @actorId,
             terminal_event_id = @terminalEventId,
             terminal_idempotency_key = @idempotencyKey,
             terminal_correlation_id = @correlationId,
             terminal_authority_kind = @terminalAuthorityKind,
             terminal_runtime_owner_id = @terminalRuntimeOwnerId,
             terminal_runtime_lease_revision = @terminalRuntimeLeaseRevision,
             terminal_durable_run_id = @terminalDurableRunId,
             terminal_durable_lease_owner_id = @terminalDurableLeaseOwnerId,
             terminal_durable_attempt_count = @terminalDurableAttemptCount,
             terminal_durable_run_version = @terminalDurableRunVersion,
             terminal_durable_run_status = @terminalDurableRunStatus,
             terminal_lifecycle_intent_id = @terminalLifecycleIntentId,
             terminal_control_event_id = @terminalControlEventId
         WHERE admission_id = @admissionId AND status = 'active'`,
      )
      .run({
        ...input,
        ...closeAuthorityProofParams(proof),
        terminalEventId: deriveId("csmae", input.admissionId, input.idempotencyKey, input.status),
        closedAt,
      });
    if (updated.changes !== 1) {
      throw admissionConflict("SESSION_MUTATION_ADMISSION_STALE", "Mutation admission changed concurrently.");
    }
    return this.require(input.admissionId);
  }

  private assertTurnWriteIdentity(
    admission: AdmissionRow,
    identity: ReturnType<typeof normalizeTurnWriteIdentity>,
  ): void {
    if (
      admission.admission_kind !== "turn_write" ||
      admission.admission_id !== identity.admissionId ||
      admission.workspace_id !== identity.workspaceId ||
      admission.session_id !== identity.sessionId ||
      admission.session_incarnation_id !== identity.sessionIncarnationId ||
      admission.turn_id !== identity.turnId
    ) {
      throw admissionConflict("SESSION_MUTATION_TURN_IDENTITY_CONFLICT", "Turn mutation admission identity conflicts.");
    }
  }

  private findDurableBinding(
    admissionId: string,
    turnId: string,
    durableRunId: string | undefined,
    forUpdate: boolean,
  ): DurableBindingRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM chat_turn_mutation_admission_durable_bindings
         WHERE admission_id = @admissionId OR turn_id = @turnId${durableRunId ? " OR durable_run_id = @durableRunId" : ""}${
           forUpdate && this.db.dialect === "postgres" ? " FOR UPDATE" : ""
         }`,
      )
      .get<DurableBindingRow>({ admissionId, turnId, ...(durableRunId ? { durableRunId } : {}) });
  }

  private requireDurableBinding(
    admissionId: string,
    turnId: string,
    durableRunId: string,
    forUpdate: boolean,
  ): DurableBindingRow {
    const row = this.findDurableBinding(admissionId, turnId, durableRunId, forUpdate);
    if (!row) {
      throw admissionConflict("SESSION_MUTATION_DURABLE_BINDING_MISSING", "Durable turn mutation binding is missing.");
    }
    return row;
  }

  private requireDurableRun(durableRunId: string, forUpdate: boolean): DurableRunFenceRow {
    const row = this.db
      .prepare(
        `SELECT run_id, workflow_key, status, attempt_count, payload_json, metadata_json,
                lease_owner_id, lease_expires_at, version
         FROM durable_runs WHERE run_id = @durableRunId${
           forUpdate && this.db.dialect === "postgres" ? " FOR UPDATE" : ""
         }`,
      )
      .get<DurableRunFenceRow>({ durableRunId });
    if (!row) throw new NotFoundError({ entity: "Durable run", id: durableRunId });
    return row;
  }

  private requireFreshDurableClaim(claim: ReturnType<typeof normalizeDurableClaim>): DurableRunFenceRow {
    return this.requireFreshDurableClaimForWorkflow(claim, "chat.turn.execute");
  }

  private requireTurnWriteRuntimeAuthority(
    admission: AdmissionRow,
    identity: ReturnType<typeof normalizeTurnWriteIdentity>,
    requestRuntimeClaim: ReturnType<typeof normalizeRequestRuntimeClaim> | undefined,
    durableClaim: ReturnType<typeof normalizeDurableClaim> | undefined,
  ): void {
    const durableBinding = this.findDurableBinding(
      identity.admissionId,
      identity.turnId,
      durableClaim?.durableRunId,
      true,
    );
    if (!durableClaim) {
      if (durableBinding) {
        throw admissionConflict(
          "SESSION_MUTATION_DURABLE_CLAIM_REQUIRED",
          "Durable turn mutation requires the current execution claim.",
        );
      }
      if (!requestRuntimeClaim) {
        throw admissionConflict(
          "SESSION_MUTATION_REQUEST_LEASE_REQUIRED",
          "Pre-durable turn mutation requires the current request-runtime lease.",
        );
      }
      this.requireFreshRequestRuntimeClaim(admission, requestRuntimeClaim);
      return;
    }
    if (
      !durableBinding ||
      durableBinding.admission_id !== identity.admissionId ||
      durableBinding.turn_id !== identity.turnId ||
      durableBinding.workspace_id !== identity.workspaceId ||
      durableBinding.session_id !== identity.sessionId ||
      durableBinding.session_incarnation_id !== identity.sessionIncarnationId ||
      durableBinding.durable_run_id !== durableClaim.durableRunId
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_DURABLE_BINDING_MISSING",
        "Durable turn mutation has no exact run binding.",
      );
    }
    this.requireFreshDurableClaim(durableClaim);
  }

  private requireFreshDurableClaimForWorkflow(
    claim: ReturnType<typeof normalizeDurableClaim>,
    workflowKey: "chat.turn.execute" | "chat.post_commit.effect",
  ): DurableRunFenceRow {
    const sql =
      this.db.dialect === "postgres"
        ? `SELECT run_id, workflow_key, status, attempt_count, payload_json, metadata_json,
                  lease_owner_id, lease_expires_at, version
           FROM durable_runs
           WHERE run_id = @durableRunId AND workflow_key = @workflowKey
             AND status = 'running' AND lease_owner_id = @leaseOwnerId
             AND attempt_count = @attemptCount AND lease_expires_at IS NOT NULL
             AND gc_try_parse_timestamptz(lease_expires_at) > clock_timestamp()
           FOR UPDATE`
        : `SELECT run_id, workflow_key, status, attempt_count, payload_json, metadata_json,
                  lease_owner_id, lease_expires_at, version
           FROM durable_runs
           WHERE run_id = @durableRunId AND workflow_key = @workflowKey
             AND status = 'running' AND lease_owner_id = @leaseOwnerId
             AND attempt_count = @attemptCount AND lease_expires_at IS NOT NULL
             AND julianday(lease_expires_at) > julianday('now')`;
    const row = this.db.prepare(sql).get<DurableRunFenceRow>({ ...claim, workflowKey });
    if (!row) {
      throw admissionConflict(
        "SESSION_MUTATION_DURABLE_CLAIM_STALE",
        "Durable turn mutation execution claim is stale or expired.",
      );
    }
    return row;
  }

  private assertExactTerminalReplayClaim(
    admission: AdmissionRow,
    requestRuntimeClaim: ReturnType<typeof normalizeRequestRuntimeClaim> | undefined,
    durableClaim: ReturnType<typeof normalizeDurableClaim> | undefined,
  ): void {
    if (admission.terminal_authority_kind === "request_runtime") {
      if (
        !requestRuntimeClaim ||
        durableClaim ||
        admission.terminal_runtime_owner_id !== requestRuntimeClaim.runtimeOwnerId ||
        admission.terminal_runtime_lease_revision === null ||
        asPositiveInteger(admission.terminal_runtime_lease_revision) !== requestRuntimeClaim.leaseRevision
      ) {
        throw admissionConflict(
          "SESSION_MUTATION_TERMINAL_REPLAY_CLAIM_CONFLICT",
          "Turn admission terminal replay conflicts with the recorded request-runtime claim.",
        );
      }
      return;
    }
    if (admission.terminal_authority_kind === "durable_run") {
      if (
        requestRuntimeClaim ||
        !durableClaim ||
        admission.terminal_durable_run_id !== durableClaim.durableRunId ||
        admission.terminal_durable_lease_owner_id !== durableClaim.leaseOwnerId ||
        admission.terminal_durable_attempt_count === null ||
        asNonNegativeInteger(admission.terminal_durable_attempt_count) !== durableClaim.attemptCount
      ) {
        throw admissionConflict(
          "SESSION_MUTATION_TERMINAL_REPLAY_CLAIM_CONFLICT",
          "Turn admission terminal replay conflicts with the recorded durable claim.",
        );
      }
      return;
    }
    if (admission.terminal_authority_kind === "durable_terminal") {
      if (requestRuntimeClaim || durableClaim) {
        throw admissionConflict(
          "SESSION_MUTATION_TERMINAL_REPLAY_CLAIM_CONFLICT",
          "Terminal durable-run replay does not accept a runtime claim.",
        );
      }
      return;
    }
    throw admissionConflict(
      "SESSION_MUTATION_TERMINAL_REPLAY_CLAIM_CONFLICT",
      "Turn admission terminal replay was closed by a different authority path.",
    );
  }

  private requireTerminalDurableHandoffEvidence(
    admission: AdmissionRow,
    binding: DurableBindingRow,
    run: DurableRunFenceRow,
  ): void {
    if (
      run.workflow_key !== "chat.turn.execute" ||
      run.lease_owner_id !== null ||
      run.lease_expires_at !== null ||
      binding.durable_run_id !== run.run_id
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_DURABLE_TERMINAL_EVIDENCE_MISSING",
        "Terminal durable turn has no exact relinquished run evidence.",
      );
    }
    this.requireExactDurableRunPayloadIdentity(admission, run);
    const metadata = run.metadata_json ? parseJsonObject(run.metadata_json) : {};
    const pendingFinalizers = [
      "linkedFinalizationPending",
      "autonomousChatPostCommitPending",
      "generalChatPostCommitPending",
    ];
    if (pendingFinalizers.some((key) => key in metadata)) {
      throw admissionConflict(
        "SESSION_MUTATION_DURABLE_HANDOFF_PENDING",
        "Terminal durable turn still has pending parent finalization authority.",
      );
    }

    const { authority, checkpointState, payload, trace } = this.requireTerminalRuntimeAuthority(
      admission,
      run,
      metadata,
    );
    this.requireTerminalRuntimeOutputBinding(run, metadata, checkpointState, payload, trace, authority);

    const requiredFinalizers = authority.material.requiredFinalizers;
    const linkedSettlement = readExactTerminalLinkedFinalization(metadata.linkedFinalization);
    const linkedRequired = requiredFinalizers.includes("linked");
    const linkedAuthority = authority.material.linkedFinalization;
    if (
      linkedRequired
        ? !linkedSettlement ||
          !linkedAuthority ||
          linkedSettlement.finalizationId !== linkedAuthority.finalizationId ||
          linkedSettlement.requestedAt !== linkedAuthority.requestedAt ||
          linkedSettlement.reasonSha256 !== linkedAuthority.reasonSha256
        : metadata.linkedFinalization !== undefined || linkedAuthority !== null
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_DURABLE_LINKED_SETTLEMENT_CONFLICT",
        "Terminal durable turn has missing, malformed, or stray linked-finalization evidence.",
      );
    }

    const autonomousSettlement = readExactTerminalAutonomousSettlement(metadata.autonomousChatPostCommit);
    const autonomousRequired = requiredFinalizers.includes("autonomous");
    const autonomousAdmission = metadata.autonomousAdmission !== undefined;
    const heartbeatTerminal = typeof payload.heartbeatOccurrenceId === "string";
    const heartbeatCompleted = heartbeatTerminal && run.status === "completed";
    if (
      autonomousRequired
        ? run.status !== "completed" ||
          !autonomousAdmission ||
          !autonomousSettlement ||
          autonomousSettlement.generationId !== authority.material.postCommitGenerationId ||
          autonomousSettlement.requestedAt !== authority.material.transitionAt ||
          (heartbeatCompleted && autonomousSettlement.heartbeatCleanupStatus !== "not_required")
        : metadata.autonomousChatPostCommit !== undefined || (run.status === "completed" && autonomousAdmission)
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_DURABLE_AUTONOMOUS_SETTLEMENT_CONFLICT",
        "Terminal durable turn has missing, malformed, or stray autonomous-finalization evidence.",
      );
    }

    if (!requiredFinalizers.includes("general")) {
      throw admissionConflict(
        "SESSION_MUTATION_DURABLE_GENERAL_SETTLEMENT_CONFLICT",
        "Terminal durable turn authority omits the general finalizer.",
      );
    }
    const generalSettlement = readExactTerminalGeneralSettlement(metadata.generalChatPostCommit);
    if (
      !generalSettlement ||
      generalSettlement.generationId !== authority.material.postCommitGenerationId ||
      generalSettlement.traceStatus !== authority.material.traceStatus ||
      generalSettlement.requestedAt !== authority.material.transitionAt ||
      canonicalJsonString(generalSettlement.postCommitEligibility) !==
        canonicalJsonString(authority.material.postCommitEligibility)
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_DURABLE_GENERAL_SETTLEMENT_CONFLICT",
        "Terminal durable turn has no exact final general settlement.",
      );
    }

    const marker = readChatTurnAdmissionHandoffMarker(metadata.chatTurnAdmissionHandoff);
    const expectedChildRunIds = [...new Set(Object.values(generalSettlement.durableEffectRunIds))].sort((left, right) =>
      left.localeCompare(right),
    );
    if (
      !marker ||
      marker.admissionId !== admission.admission_id ||
      marker.sessionIncarnationId !== admission.session_incarnation_id ||
      marker.turnId !== admission.turn_id ||
      marker.parentRunId !== run.run_id ||
      marker.postCommitGenerationId !== authority.material.postCommitGenerationId ||
      canonicalJsonString(marker.childRunIds) !== canonicalJsonString(expectedChildRunIds) ||
      marker.childRunIdsSha256 !== sha256(canonicalJsonString(expectedChildRunIds)) ||
      (heartbeatTerminal &&
        (generalSettlement.completedEffects.length !== 0 ||
          expectedChildRunIds.length !== 0 ||
          Object.keys(generalSettlement.durableEffectOutcomes).length !== 0 ||
          marker.childRunIds.length !== 0))
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_DURABLE_HANDOFF_MISSING",
        "Terminal durable turn has no exact committed admission handoff marker.",
      );
    }
    this.requireExactPostCommitChildren(admission, marker, generalSettlement);
  }

  private requireTerminalRuntimeAuthority(
    admission: AdmissionRow,
    run: DurableRunFenceRow,
    metadata: Record<string, unknown>,
  ): {
    authority: TerminalRuntimeAuthoritySeal;
    checkpointState: Record<string, unknown>;
    payload: Record<string, unknown>;
    trace: {
      session_id: string;
      user_message_id: string;
      assistant_message_id: string | null;
      status: string;
      durable_json: string | null;
    };
  } {
    if (!(["completed", "failed", "cancelled"] as const).includes(run.status as TerminalDurableRunStatus)) {
      throw admissionConflict(
        "SESSION_MUTATION_DURABLE_TERMINAL_STATUS_CONFLICT",
        "Terminal durable turn is not in a canonical terminal status.",
      );
    }
    const payload = parseJsonObject(run.payload_json);
    const authority = readExactTerminalRuntimeAuthoritySeal(metadata.chatTurnRuntimeAuthority);
    const trace = this.db
      .prepare(
        `SELECT session_id, user_message_id, assistant_message_id, status, durable_json
         FROM chat_turn_traces WHERE turn_id = @turnId${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
      )
      .get<{
        session_id: string;
        user_message_id: string;
        assistant_message_id: string | null;
        status: string;
        durable_json: string | null;
      }>({ turnId: admission.turn_id! });
    const checkpointKind =
      run.status === "completed" ? "run_completed" : run.status === "failed" ? "run_failed" : "run_cancelled";
    const checkpoint = this.db
      .prepare(
        `SELECT checkpoint_id, run_id, checkpoint_kind, state_json, created_at
         FROM durable_checkpoints
         WHERE run_id = @runId AND checkpoint_kind = @checkpointKind
         ORDER BY created_at DESC, checkpoint_id DESC LIMIT 1${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
      )
      .get<{
        checkpoint_id: string;
        run_id: string;
        checkpoint_kind: string;
        state_json: string;
        created_at: string;
      }>({ runId: run.run_id, checkpointKind });
    const checkpointState = checkpoint ? parseJsonObject(checkpoint.state_json) : undefined;
    const checkpointAuthority = checkpointState
      ? readExactTerminalRuntimeAuthoritySeal(checkpointState.chatTurnRuntimeAuthority)
      : undefined;
    const traceDurable = trace?.durable_json ? parseJsonObject(trace.durable_json) : undefined;
    const terminalStatus = run.status as TerminalDurableRunStatus;
    const exactTraceStatus =
      terminalStatus === "completed"
        ? trace?.status === "completed" || trace?.status === "partial"
        : trace?.status === terminalStatus;
    const autonomousAdmission = metadata.autonomousAdmission !== undefined;
    const expectedFinalizers: TerminalRuntimeFinalizer[] =
      authority?.material.transitionKind === "linked_finalization"
        ? ["linked", "general"]
        : terminalStatus === "completed" && autonomousAdmission
          ? ["autonomous", "general"]
          : ["general"];
    if (
      !authority ||
      !trace ||
      !checkpoint ||
      !checkpointState ||
      !checkpointAuthority ||
      canonicalJsonString(checkpointAuthority) !== canonicalJsonString(authority) ||
      authority.material.runId !== run.run_id ||
      authority.material.turnId !== admission.turn_id ||
      authority.material.durableStatus !== terminalStatus ||
      authority.material.traceStatus !== trace.status ||
      !exactTraceStatus ||
      (authority.material.transitionKind === "linked_finalization" && terminalStatus !== "failed") ||
      canonicalJsonString(authority.material.requiredFinalizers) !== canonicalJsonString(expectedFinalizers) ||
      metadata.waitForEvent !== undefined ||
      trace.session_id !== admission.session_id ||
      trace.user_message_id !== payload.userMessageId ||
      trace.assistant_message_id !== payload.assistantMessageId ||
      !traceDurable ||
      traceDurable.runId !== run.run_id ||
      traceDurable.status !== terminalStatus ||
      traceDurable.checkpointKind !== checkpointKind ||
      checkpoint.run_id !== run.run_id ||
      checkpoint.checkpoint_kind !== checkpointKind ||
      !isCanonicalIsoTimestamp(checkpoint.created_at)
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_DURABLE_RUNTIME_AUTHORITY_CONFLICT",
        "Terminal durable turn has no exact checkpoint-anchored runtime authority.",
      );
    }
    return { authority, checkpointState, payload, trace };
  }

  private requireTerminalRuntimeOutputBinding(
    run: DurableRunFenceRow,
    metadata: Record<string, unknown>,
    checkpointState: Record<string, unknown>,
    payload: Record<string, unknown>,
    trace: { user_message_id?: string; assistant_message_id: string | null },
    authority: TerminalRuntimeAuthoritySeal,
  ): void {
    const output = authority.material.terminalOutput;
    const metadataOutputKeys = [
      "outputText",
      "finalOutput",
      "outputSummary",
      "finalSummary",
      "outputMessageId",
      "outputTraceStatus",
    ];
    const checkpointOutputKeys = [
      "assistantMessageId",
      "outputText",
      "finalOutput",
      "outputSummary",
      "finalSummary",
      "outputMessageId",
      "outputTraceStatus",
    ];
    const heartbeatOccurrenceId =
      typeof payload.heartbeatOccurrenceId === "string" ? payload.heartbeatOccurrenceId : undefined;
    const heartbeatAuthorityReceipt = authority.material.heartbeatDecisionReceipt;
    const metadataHeartbeatReceipt = readExactHeartbeatDecisionReceipt(metadata.heartbeatDecisionReceipt);
    const checkpointHeartbeatReceipt = readExactHeartbeatDecisionReceipt(checkpointState.heartbeatDecisionReceipt);
    const metadataHeartbeatRawOutput = metadata.heartbeatDecisionRawOutput;
    const checkpointHeartbeatRawOutput = checkpointState.heartbeatDecisionRawOutput;
    if (heartbeatOccurrenceId && !isExactSilentHeartbeatEligibility(authority.material.postCommitEligibility)) {
      throw admissionConflict(
        "SESSION_MUTATION_HEARTBEAT_DECISION_CONFLICT",
        "Heartbeat terminal runtime authority did not force all post-commit eligibility gates closed.",
      );
    }
    if (
      heartbeatOccurrenceId &&
      !readExactHeartbeatAutonomousAdmissionSeal(metadata.autonomousAdmission, payload, metadata, run.run_id)
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_HEARTBEAT_DECISION_CONFLICT",
        "Heartbeat terminal runtime authority has no exact sealed autonomous admission context.",
      );
    }
    if (!heartbeatOccurrenceId) {
      if (
        heartbeatAuthorityReceipt ||
        metadata.heartbeatDecisionReceipt !== undefined ||
        metadata.heartbeatDecisionRawOutput !== undefined ||
        checkpointState.heartbeatDecisionReceipt !== undefined ||
        checkpointState.heartbeatDecisionRawOutput !== undefined
      ) {
        throw admissionConflict(
          "SESSION_MUTATION_HEARTBEAT_DECISION_CONFLICT",
          "Non-heartbeat terminal durable turn contains heartbeat decision evidence.",
        );
      }
    } else if (run.status === "completed") {
      const decision =
        typeof metadataHeartbeatRawOutput === "string"
          ? readExactHeartbeatDecision(metadataHeartbeatRawOutput)
          : undefined;
      const expectedClaimSha256 =
        typeof payload.heartbeatClaimSha256 === "string" ? payload.heartbeatClaimSha256 : undefined;
      if (
        !heartbeatAuthorityReceipt ||
        !metadataHeartbeatReceipt ||
        !checkpointHeartbeatReceipt ||
        typeof metadataHeartbeatRawOutput !== "string" ||
        checkpointHeartbeatRawOutput !== metadataHeartbeatRawOutput ||
        !decision ||
        canonicalJsonString(metadataHeartbeatReceipt) !== canonicalJsonString(heartbeatAuthorityReceipt) ||
        canonicalJsonString(checkpointHeartbeatReceipt) !== canonicalJsonString(heartbeatAuthorityReceipt) ||
        heartbeatAuthorityReceipt.occurrenceId !== heartbeatOccurrenceId ||
        heartbeatAuthorityReceipt.claimSha256 !== expectedClaimSha256 ||
        heartbeatAuthorityReceipt.rawOutputSha256 !== sha256(metadataHeartbeatRawOutput) ||
        heartbeatAuthorityReceipt.notify !== decision.notify ||
        heartbeatAuthorityReceipt.normalizedMessageSha256 !==
          (decision.notify ? sha256(decision.normalizedMessage) : null)
      ) {
        throw admissionConflict(
          "SESSION_MUTATION_HEARTBEAT_DECISION_CONFLICT",
          "Completed heartbeat turn has missing, malformed, or unsealed decision evidence.",
        );
      }
      const assistantMessage = this.db
        .prepare(
          `SELECT message_id, session_id, role, actor_type, actor_id, content
           FROM chat_messages WHERE message_id = @messageId${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
        )
        .get<{
          message_id: string;
          session_id: string;
          role: string;
          actor_type: string | null;
          actor_id: string;
          content: string;
        }>({ messageId: payload.assistantMessageId });
      if (!decision.notify) {
        if (
          output ||
          assistantMessage ||
          metadataOutputKeys.some((key) => metadata[key] !== undefined) ||
          checkpointOutputKeys.some((key) => checkpointState[key] !== undefined)
        ) {
          throw admissionConflict(
            "SESSION_MUTATION_HEARTBEAT_DECISION_CONFLICT",
            "Silent heartbeat turn persisted visible assistant output.",
          );
        }
        return;
      }
      if (
        !output ||
        output.assistantMessageId !== payload.assistantMessageId ||
        output.assistantMessageId !== trace.assistant_message_id ||
        typeof metadata.outputText !== "string" ||
        typeof metadata.outputSummary !== "string" ||
        metadata.outputText !== decision.normalizedMessage ||
        metadata.finalOutput !== metadata.outputText ||
        metadata.finalSummary !== metadata.outputSummary ||
        metadata.outputMessageId !== undefined ||
        metadata.outputTraceStatus !== undefined ||
        sha256(canonicalJsonString(metadata.outputText)) !== output.outputTextSha256 ||
        sha256(canonicalJsonString(metadata.outputSummary)) !== output.outputSummarySha256 ||
        checkpointState.assistantMessageId !== output.assistantMessageId ||
        checkpointState.outputText !== metadata.outputText ||
        checkpointState.outputSummary !== metadata.outputSummary ||
        checkpointState.finalOutput !== undefined ||
        checkpointState.finalSummary !== undefined ||
        checkpointState.outputMessageId !== undefined ||
        checkpointState.outputTraceStatus !== undefined ||
        !assistantMessage ||
        assistantMessage.session_id !== payload.sessionId ||
        assistantMessage.role !== "assistant" ||
        assistantMessage.actor_type !== "system" ||
        assistantMessage.actor_id !== "system-heartbeat" ||
        assistantMessage.content !== decision.normalizedMessage
      ) {
        throw admissionConflict(
          "SESSION_MUTATION_HEARTBEAT_DECISION_CONFLICT",
          "Notifying heartbeat turn conflicts with its sealed normalized system message.",
        );
      }
      return;
    } else if (
      heartbeatAuthorityReceipt ||
      metadata.heartbeatDecisionReceipt !== undefined ||
      metadata.heartbeatDecisionRawOutput !== undefined ||
      checkpointState.heartbeatDecisionReceipt !== undefined ||
      checkpointState.heartbeatDecisionRawOutput !== undefined
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_HEARTBEAT_DECISION_CONFLICT",
        "Failed or cancelled heartbeat turn contains completed decision evidence.",
      );
    }
    if (run.status !== "completed") {
      if (
        output ||
        metadataOutputKeys.some((key) => metadata[key] !== undefined) ||
        checkpointOutputKeys.some((key) => checkpointState[key] !== undefined)
      ) {
        throw admissionConflict(
          "SESSION_MUTATION_DURABLE_TERMINAL_OUTPUT_CONFLICT",
          "Failed or cancelled terminal durable turn carries output evidence.",
        );
      }
      return;
    }
    const message = output
      ? this.db
          .prepare(
            `SELECT message_id, session_id, role, actor_type, content
             FROM chat_messages WHERE message_id = @messageId${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
          )
          .get<{
            message_id: string;
            session_id: string;
            role: string;
            actor_type: string | null;
            content: string;
          }>({ messageId: output.assistantMessageId })
      : undefined;
    if (
      !output ||
      output.assistantMessageId !== payload.assistantMessageId ||
      output.assistantMessageId !== trace.assistant_message_id ||
      typeof metadata.outputText !== "string" ||
      typeof metadata.outputSummary !== "string" ||
      metadata.finalOutput !== metadata.outputText ||
      metadata.finalSummary !== metadata.outputSummary ||
      metadata.outputMessageId !== undefined ||
      metadata.outputTraceStatus !== undefined ||
      sha256(canonicalJsonString(metadata.outputText)) !== output.outputTextSha256 ||
      sha256(canonicalJsonString(metadata.outputSummary)) !== output.outputSummarySha256 ||
      checkpointState.assistantMessageId !== output.assistantMessageId ||
      checkpointState.outputText !== metadata.outputText ||
      checkpointState.outputSummary !== metadata.outputSummary ||
      checkpointState.finalOutput !== undefined ||
      checkpointState.finalSummary !== undefined ||
      checkpointState.outputMessageId !== undefined ||
      checkpointState.outputTraceStatus !== undefined ||
      !message ||
      message.session_id !== payload.sessionId ||
      message.role !== "assistant" ||
      message.actor_type !== "agent" ||
      message.content !== metadata.outputText
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_DURABLE_TERMINAL_OUTPUT_CONFLICT",
        "Completed terminal durable turn output drifted from runtime authority.",
      );
    }
  }

  private requireExactParentLocalPostCommitRun(
    admission: AdmissionRow,
    run: DurableRunFenceRow,
    input: ReturnType<typeof normalizeParentLocalPostCommitStageInput>,
  ): ParentLocalPostCommitPendingMarker {
    if (
      run.run_id !== input.parentRunId ||
      run.workflow_key !== "chat.turn.execute" ||
      !["waiting", "completed", "failed", "cancelled", "dead_lettered"].includes(run.status) ||
      run.lease_owner_id !== null ||
      run.lease_expires_at !== null
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_PARENT_LOCAL_RUN_CONFLICT",
        "Parent-local post-commit stage has no exact settled parent run.",
      );
    }
    this.requireExactDurableRunPayloadIdentity(admission, run);
    const metadata = run.metadata_json ? parseJsonObject(run.metadata_json) : {};
    if (metadata.chatTurnAdmissionHandoff !== undefined) {
      throw admissionConflict(
        "SESSION_MUTATION_PARENT_LOCAL_HANDOFF_COMMITTED",
        "Parent-local post-commit stage cannot run after terminal handoff.",
      );
    }
    const marker = readParentLocalPostCommitPendingMarker(metadata.generalChatPostCommitPending);
    if (!marker || marker.generationId !== input.postCommitGenerationId) {
      throw admissionConflict(
        "SESSION_MUTATION_PARENT_LOCAL_GENERATION_CONFLICT",
        "Parent-local post-commit stage has no exact pending generation.",
      );
    }
    return marker;
  }

  private requireExactDurableRunPayloadIdentity(admission: AdmissionRow, run: DurableRunFenceRow): void {
    const payload = parseJsonObject(run.payload_json);
    const effectiveRequest = readJsonObject(payload.request);
    const requestActor = readJsonObject(payload.requestActor);
    const admittedRequest = effectiveRequest
      ? reconstructAdmittedRequest(effectiveRequest, payload.surfaceDerivation)
      : undefined;
    const effectiveRequestMaterialSha256 =
      typeof payload.effectiveRequestMaterialSha256 === "string" ? payload.effectiveRequestMaterialSha256 : undefined;
    if (
      payload.version !== "chat.turn.execute.v2" ||
      payload.admissionId !== admission.admission_id ||
      payload.sessionIncarnationId !== admission.session_incarnation_id ||
      payload.admissionMaterialSha256 !== admission.material_sha256 ||
      payload.workspaceId !== admission.workspace_id ||
      payload.admissionAggregateRevision !== asPositiveInteger(admission.aggregate_revision) ||
      payload.admissionControllerGeneration !== asPositiveInteger(admission.controller_generation) ||
      payload.sessionId !== admission.session_id ||
      payload.turnId !== admission.turn_id ||
      !effectiveRequest ||
      !requestActor ||
      requestActor.actorKind !== admission.actor_kind ||
      requestActor.actorId !== admission.actor_id ||
      !admittedRequest ||
      ["signal", "operatorId", "authActorId", "authActorSource"].some((key) => key in effectiveRequest) ||
      sha256(canonicalJsonString({ version: 2, request: admittedRequest })) !== admission.material_sha256 ||
      effectiveRequestMaterialSha256 !==
        sha256(
          canonicalJsonString({
            version: 1,
            admissionMaterialSha256: admission.material_sha256,
            request: effectiveRequest,
          }),
        )
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_DURABLE_PAYLOAD_IDENTITY_CONFLICT",
        "Durable Chat turn payload conflicts with its frozen admission.",
      );
    }
    this.requireExactHeartbeatPayloadIdentity(admission, run, payload);
    this.requireExactDurableChatUserInputContinuationSet(admission, run, payload);
  }

  private requireExactHeartbeatPayloadIdentity(
    admission: AdmissionRow,
    run: DurableRunFenceRow,
    payload: Record<string, unknown>,
  ): void {
    const expectedHeartbeatKeys = [
      "heartbeatClaimSha256",
      "heartbeatEvaluatedPolicySha256",
      "heartbeatFrozenObjectiveSha256",
      "heartbeatOccurrenceId",
    ].sort();
    const observedHeartbeatKeys = Object.keys(payload)
      .filter((key) => /^heartbeat[A-Z]/u.test(key))
      .sort();
    const heartbeatAdmission =
      admission.actor_kind === "system" &&
      admission.actor_id === "system-heartbeat" &&
      admission.operation === "chat_system_heartbeat";
    if (!heartbeatAdmission) {
      if (observedHeartbeatKeys.length > 0) {
        throw admissionConflict(
          "SESSION_MUTATION_HEARTBEAT_PAYLOAD_CONFLICT",
          "Non-heartbeat Chat payload contains heartbeat authority fields.",
        );
      }
      return;
    }
    const occurrence = this.db
      .prepare(
        `SELECT occurrence_id, workspace_id, session_id, session_incarnation_id, admission_id,
                admission_request_sha256, system_actor_id, admission_material_sha256,
                evaluated_policy_sha256, frozen_request_sha256, frozen_objective_sha256,
                claim_sha256, aggregate_revision, controller_generation, turn_id,
                expected_durable_run_id, durable_run_id, state
         FROM chat_heartbeat_occurrences WHERE admission_id = @admissionId${
           this.db.dialect === "postgres" ? " FOR UPDATE" : ""
         }`,
      )
      .get<{
        occurrence_id: string;
        workspace_id: string;
        session_id: string;
        session_incarnation_id: string;
        admission_id: string;
        admission_request_sha256: string;
        system_actor_id: string;
        admission_material_sha256: string;
        evaluated_policy_sha256: string;
        frozen_request_sha256: string;
        frozen_objective_sha256: string;
        claim_sha256: string;
        aggregate_revision: number | bigint | string;
        controller_generation: number | bigint | string;
        turn_id: string;
        expected_durable_run_id: string;
        durable_run_id: string | null;
        state: string;
      }>({ admissionId: admission.admission_id });
    if (
      canonicalJsonString(observedHeartbeatKeys) !== canonicalJsonString(expectedHeartbeatKeys) ||
      !occurrence ||
      occurrence.occurrence_id !== payload.heartbeatOccurrenceId ||
      occurrence.claim_sha256 !== payload.heartbeatClaimSha256 ||
      occurrence.evaluated_policy_sha256 !== payload.heartbeatEvaluatedPolicySha256 ||
      occurrence.frozen_objective_sha256 !== payload.heartbeatFrozenObjectiveSha256 ||
      occurrence.workspace_id !== admission.workspace_id ||
      occurrence.session_id !== admission.session_id ||
      occurrence.session_incarnation_id !== admission.session_incarnation_id ||
      occurrence.admission_id !== admission.admission_id ||
      occurrence.admission_request_sha256 !== admission.request_sha256 ||
      occurrence.system_actor_id !== admission.actor_id ||
      occurrence.admission_material_sha256 !== admission.material_sha256 ||
      occurrence.frozen_request_sha256 !== admission.material_sha256 ||
      asPositiveInteger(occurrence.aggregate_revision) !== asPositiveInteger(admission.aggregate_revision) ||
      asPositiveInteger(occurrence.controller_generation) !== asPositiveInteger(admission.controller_generation) ||
      occurrence.turn_id !== admission.turn_id ||
      occurrence.expected_durable_run_id !== run.run_id ||
      (occurrence.durable_run_id !== null && occurrence.durable_run_id !== run.run_id) ||
      !["admitted", "durable_bound", "terminal"].includes(occurrence.state)
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_HEARTBEAT_PAYLOAD_CONFLICT",
        "Heartbeat Chat payload conflicts with immutable occurrence authority.",
      );
    }
    const persistedSyntheticInput = this.db
      .prepare("SELECT message_id FROM chat_messages WHERE message_id = @messageId")
      .get<{ message_id: string }>({ messageId: payload.userMessageId });
    if (persistedSyntheticInput) {
      throw admissionConflict(
        "SESSION_MUTATION_HEARTBEAT_INPUT_PERSISTED",
        "Heartbeat Chat input must remain model-history-only and cannot be persisted in the operator transcript.",
      );
    }
  }

  private requireCurrentControlEventId(sessionId: string): string {
    const currentControl = this.db
      .prepare(
        `SELECT event_row.event_id
         FROM chat_session_control_grants control
         JOIN chat_session_control_events event_row
           ON event_row.session_id = control.session_id
          AND event_row.idempotency_key = control.transition_idempotency_key
         WHERE control.session_id = @sessionId AND control.is_current = 1${
           this.db.dialect === "postgres" ? " FOR UPDATE OF control, event_row" : ""
         }`,
      )
      .get<{ event_id: string }>({ sessionId });
    if (!currentControl) {
      throw admissionConflict(
        "SESSION_MUTATION_ADMISSION_AUTHORITY_MISSING",
        "Current session authority evidence is missing.",
      );
    }
    return currentControl.event_id;
  }

  private requireExactDurableChatUserInputContinuationSet(
    admission: AdmissionRow,
    run: DurableRunFenceRow,
    payload: Record<string, unknown>,
  ): void {
    const responses = readDurableChatUserInputResponses(payload.userInputResponses);
    const seals = this.db
      .prepare(
        `SELECT * FROM chat_turn_user_input_continuation_seals
         WHERE durable_run_id = @durableRunId ORDER BY prompt_id ASC${
           this.db.dialect === "postgres" ? " FOR UPDATE" : ""
         }`,
      )
      .all<DurableChatUserInputContinuationSealRow>({ durableRunId: run.run_id })
      .map(mapDurableChatUserInputContinuationSeal);
    if (responses.length !== seals.length) {
      throw admissionConflict(
        "SESSION_MUTATION_USER_INPUT_CONTINUATION_SET_CONFLICT",
        "Durable Chat user-input responses do not match immutable continuation seals.",
      );
    }
    const responseByPrompt = new Map<string, DurableChatUserInputResumeRecord>();
    for (const response of responses) {
      if (responseByPrompt.has(response.promptId)) {
        throw admissionConflict(
          "SESSION_MUTATION_USER_INPUT_CONTINUATION_SET_CONFLICT",
          "Durable Chat user-input response prompts are not unique.",
        );
      }
      responseByPrompt.set(response.promptId, response);
    }
    for (const seal of seals) {
      const response = responseByPrompt.get(seal.promptId);
      const expectedMaterial = sha256(
        canonicalJsonString({
          version: 1,
          admissionId: seal.admissionId,
          sessionIncarnationId: seal.sessionIncarnationId,
          workspaceId: seal.workspaceId,
          sessionId: seal.sessionId,
          turnId: seal.turnId,
          durableRunId: seal.durableRunId,
          promptId: seal.promptId,
          eventKey: seal.eventKey,
          correlationId: seal.correlationId,
          resumeRecordSha256: seal.resumeRecordSha256,
          responderActorId: seal.responderActorId,
          responderAuthActorSource: seal.responderAuthActorSource,
          waitingRunVersion: seal.waitingRunVersion,
          queuedRunVersion: seal.queuedRunVersion,
          resolvedAt: seal.resolvedAt,
        }),
      );
      if (
        !response ||
        seal.admissionId !== admission.admission_id ||
        seal.sessionIncarnationId !== admission.session_incarnation_id ||
        seal.workspaceId !== admission.workspace_id ||
        seal.sessionId !== admission.session_id ||
        seal.turnId !== admission.turn_id ||
        seal.durableRunId !== run.run_id ||
        seal.eventKey !== "chat.user_input.resolved" ||
        seal.correlationId !== seal.promptId ||
        seal.resumeRecordSha256 !== sha256(canonicalJsonString(response)) ||
        seal.materialSha256 !== expectedMaterial
      ) {
        throw admissionConflict(
          "SESSION_MUTATION_USER_INPUT_CONTINUATION_SET_CONFLICT",
          "Durable Chat user-input responses do not match immutable continuation seals.",
        );
      }
    }
  }

  private requireExactPostCommitChildren(
    parentAdmission: AdmissionRow,
    marker: ChatTurnAdmissionHandoffMarker,
    settlement: TerminalGeneralPostCommitSettlement,
  ): void {
    const expectedByRunId = new Map<string, { effect: string; outcome: TerminalGeneralDurableEffectOutcome }>();
    for (const [effect, childRunId] of Object.entries(settlement.durableEffectRunIds)) {
      const outcome = settlement.durableEffectOutcomes[effect];
      if (!outcome || outcome.runId !== childRunId || expectedByRunId.has(childRunId)) {
        throw admissionConflict(
          "SESSION_MUTATION_DURABLE_CHILD_OUTCOME_CONFLICT",
          "Terminal durable turn child outcomes do not exactly own their run receipts.",
        );
      }
      expectedByRunId.set(childRunId, { effect, outcome });
    }
    for (const childRunId of marker.childRunIds) {
      const child = this.requireDurableRun(childRunId, true);
      const expected = expectedByRunId.get(childRunId);
      if (
        !expected ||
        child.workflow_key !== "chat.post_commit.effect" ||
        child.status !== expected.outcome.status ||
        !["completed", "failed", "cancelled", "dead_lettered"].includes(child.status) ||
        child.lease_owner_id !== null ||
        child.lease_expires_at !== null
      ) {
        throw admissionConflict(
          "SESSION_MUTATION_DURABLE_CHILD_HANDOFF_CONFLICT",
          "Terminal durable turn handoff references a non-terminal or outcome-conflicting child.",
        );
      }
      const payload = parseJsonObject(child.payload_json);
      const metadata = child.metadata_json ? parseJsonObject(child.metadata_json) : {};
      const payloadAdmission = readPostCommitChildAdmissionIdentity(payload.childAdmission);
      const metadataAdmission = readPostCommitChildAdmissionIdentity(metadata.childAdmission);
      const payloadEligibility = readPostCommitEligibility(payload.postCommitEligibility);
      const metadataEligibility = readPostCommitEligibility(metadata.postCommitEligibility);
      if (
        payload.version !== "chat.post_commit.effect.v2" ||
        payload.parentRunId !== marker.parentRunId ||
        payload.postCommitGenerationId !== marker.postCommitGenerationId ||
        typeof payload.effect !== "string" ||
        !["commitments", "background_review", "memory_maintenance"].includes(payload.effect) ||
        payload.effect !== expected.effect ||
        typeof payload.traceStatus !== "string" ||
        !payload.traceStatus ||
        metadata.parentRunId !== payload.parentRunId ||
        metadata.postCommitGenerationId !== payload.postCommitGenerationId ||
        metadata.effect !== payload.effect ||
        metadata.workspaceId !== parentAdmission.workspace_id ||
        metadata.sessionId !== parentAdmission.session_id ||
        metadata.turnId !== parentAdmission.turn_id ||
        !payloadAdmission ||
        !metadataAdmission ||
        !payloadEligibility ||
        !metadataEligibility ||
        canonicalJsonString(payloadAdmission) !== canonicalJsonString(metadataAdmission) ||
        canonicalJsonString(payloadEligibility) !== canonicalJsonString(metadataEligibility) ||
        payloadAdmission.sessionIncarnationId !== parentAdmission.session_incarnation_id ||
        payloadAdmission.workspaceId !== parentAdmission.workspace_id ||
        payloadAdmission.sessionId !== parentAdmission.session_id ||
        payloadAdmission.controllerGeneration !== asPositiveInteger(parentAdmission.controller_generation) ||
        payloadAdmission.aggregateRevision < asPositiveInteger(parentAdmission.aggregate_revision) ||
        payloadAdmission.actorKind !== parentAdmission.actor_kind ||
        payloadAdmission.actorId !== parentAdmission.actor_id ||
        payloadAdmission.materialSha256 !==
          computePostCommitChildAdmissionMaterialSha256({
            parentRunId: marker.parentRunId,
            postCommitGenerationId: marker.postCommitGenerationId,
            effect: payload.effect,
            childRunId,
            workspaceId: parentAdmission.workspace_id,
            sessionId: parentAdmission.session_id,
            sourceTurnId: parentAdmission.turn_id!,
            sessionIncarnationId: parentAdmission.session_incarnation_id,
            postCommitEligibility: payloadEligibility,
          })
      ) {
        throw admissionConflict(
          "SESSION_MUTATION_DURABLE_CHILD_HANDOFF_CONFLICT",
          "Terminal durable turn handoff references a child with conflicting lineage.",
        );
      }
      const storedAdmission = this.db
        .prepare("SELECT * FROM chat_session_mutation_admissions WHERE admission_id = @admissionId")
        .get<AdmissionRow>({ admissionId: payloadAdmission.admissionId });
      if (
        !storedAdmission ||
        storedAdmission.admission_kind !== "synchronous" ||
        storedAdmission.turn_id !== null ||
        storedAdmission.session_incarnation_id !== payloadAdmission.sessionIncarnationId ||
        storedAdmission.workspace_id !== payloadAdmission.workspaceId ||
        storedAdmission.session_id !== payloadAdmission.sessionId ||
        asPositiveInteger(storedAdmission.aggregate_revision) !== payloadAdmission.aggregateRevision ||
        asPositiveInteger(storedAdmission.controller_generation) !== payloadAdmission.controllerGeneration ||
        storedAdmission.actor_kind !== payloadAdmission.actorKind ||
        storedAdmission.actor_id !== payloadAdmission.actorId ||
        storedAdmission.operation !== payloadAdmission.operation ||
        storedAdmission.material_sha256 !== payloadAdmission.materialSha256 ||
        storedAdmission.status !== (child.status === "completed" ? "completed" : "cancelled") ||
        storedAdmission.terminal_authority_kind !== "post_commit_child_stage" ||
        storedAdmission.terminal_durable_run_id !== childRunId ||
        storedAdmission.terminal_durable_run_status !== "running" ||
        storedAdmission.terminal_durable_lease_owner_id === null ||
        storedAdmission.terminal_durable_attempt_count === null ||
        storedAdmission.terminal_durable_run_version === null
      ) {
        throw admissionConflict(
          "SESSION_MUTATION_DURABLE_CHILD_ADMISSION_CONFLICT",
          "Terminal durable turn child admission conflicts with its frozen payload identity.",
        );
      }
    }
    const childParentPredicate =
      this.db.dialect === "postgres"
        ? "gc_try_parse_jsonb(payload_json) ->> 'parentRunId' = @parentRunId AND gc_try_parse_jsonb(payload_json) ->> 'postCommitGenerationId' = @generationId"
        : "json_extract(payload_json, '$.parentRunId') = @parentRunId AND json_extract(payload_json, '$.postCommitGenerationId') = @generationId";
    const observedChildRunIds = this.db
      .prepare(
        `SELECT run_id FROM durable_runs
         WHERE workflow_key = 'chat.post_commit.effect' AND ${childParentPredicate}
         ORDER BY run_id ASC${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
      )
      .all<{ run_id: string }>({
        parentRunId: marker.parentRunId,
        generationId: marker.postCommitGenerationId,
      })
      .map((row) => row.run_id);
    if (canonicalJsonString(observedChildRunIds) !== canonicalJsonString(marker.childRunIds)) {
      throw admissionConflict(
        "SESSION_MUTATION_DURABLE_CHILD_HANDOFF_CONFLICT",
        "Terminal durable turn handoff omits or invents a post-commit child.",
      );
    }
  }

  private assertExactPostCommitChildAdmission(
    admission: AdmissionRow,
    expected: PostCommitChildAdmissionIdentity,
  ): void {
    if (
      admission.admission_id !== expected.admissionId ||
      admission.admission_kind !== "synchronous" ||
      admission.turn_id !== null ||
      admission.session_incarnation_id !== expected.sessionIncarnationId ||
      admission.workspace_id !== expected.workspaceId ||
      admission.session_id !== expected.sessionId ||
      asPositiveInteger(admission.aggregate_revision) !== expected.aggregateRevision ||
      asPositiveInteger(admission.controller_generation) !== expected.controllerGeneration ||
      admission.actor_kind !== expected.actorKind ||
      admission.actor_id !== expected.actorId ||
      admission.operation !== expected.operation ||
      admission.material_sha256 !== expected.materialSha256
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_POST_COMMIT_CHILD_IDENTITY_CONFLICT",
        "Post-commit child admission conflicts with its frozen identity.",
      );
    }
  }

  private resolvePostCommitChildClosedReplayDisposition(
    admission: AdmissionRow,
    input: ReturnType<typeof normalizePostCommitChildStageInput>,
  ): "allowed" | "late_blocked" | undefined {
    if (admission.status === "active") return undefined;
    if (
      admission.status === "cancelled" &&
      (admission.terminal_authority_kind === "lifecycle_delete" ||
        admission.terminal_authority_kind === "authority_superseded")
    ) {
      return "late_blocked";
    }
    if (
      admission.terminal_authority_kind === "post_commit_child_stage" &&
      admission.terminal_durable_run_id === input.childRunId
    ) {
      const disposition = admission.status === "completed" ? "allowed" : "late_blocked";
      if (admission.terminal_idempotency_key === postCommitChildStageIdempotencyKey(input, disposition)) {
        return disposition;
      }
    }
    return undefined;
  }

  private assertExactPostCommitChildRun(
    input: ReturnType<typeof normalizePostCommitChildStageInput>,
    run: DurableRunFenceRow,
  ): void {
    const payload = parseJsonObject(run.payload_json);
    const metadata = run.metadata_json ? parseJsonObject(run.metadata_json) : {};
    const payloadAdmission = readPostCommitChildAdmissionIdentity(payload.childAdmission);
    const metadataAdmission = readPostCommitChildAdmissionIdentity(metadata.childAdmission);
    const payloadEligibility = readPostCommitEligibility(payload.postCommitEligibility);
    const metadataEligibility = readPostCommitEligibility(metadata.postCommitEligibility);
    if (
      run.run_id !== input.childRunId ||
      run.workflow_key !== "chat.post_commit.effect" ||
      payload.version !== "chat.post_commit.effect.v2" ||
      payload.parentRunId !== input.parentRunId ||
      payload.postCommitGenerationId !== input.postCommitGenerationId ||
      payload.effect !== input.effect ||
      metadata.parentRunId !== input.parentRunId ||
      metadata.postCommitGenerationId !== input.postCommitGenerationId ||
      metadata.effect !== input.effect ||
      metadata.workspaceId !== input.childAdmission.workspaceId ||
      metadata.sessionId !== input.childAdmission.sessionId ||
      metadata.turnId !== input.sourceTurnId ||
      !payloadAdmission ||
      !metadataAdmission ||
      canonicalJsonString(payloadAdmission) !== canonicalJsonString(input.childAdmission) ||
      canonicalJsonString(metadataAdmission) !== canonicalJsonString(input.childAdmission) ||
      !payloadEligibility ||
      !metadataEligibility ||
      canonicalJsonString(payloadEligibility) !== canonicalJsonString(input.postCommitEligibility) ||
      canonicalJsonString(metadataEligibility) !== canonicalJsonString(input.postCommitEligibility)
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_POST_COMMIT_CHILD_RUN_CONFLICT",
        "Post-commit child run conflicts with its frozen admission lineage.",
      );
    }
  }

  private requireFreshRequestRuntimeClaim(
    admission: AdmissionRow,
    claim: ReturnType<typeof normalizeRequestRuntimeClaim>,
  ): void {
    if (
      admission.runtime_owner_id !== claim.runtimeOwnerId ||
      admission.runtime_lease_revision === null ||
      asPositiveInteger(admission.runtime_lease_revision) !== claim.leaseRevision ||
      admission.runtime_lease_relinquished_at !== null
    ) {
      throw admissionConflict("SESSION_MUTATION_REQUEST_LEASE_STALE", "Turn request-runtime lease identity is stale.");
    }
    const sql =
      this.db.dialect === "postgres"
        ? `SELECT 1 FROM chat_session_mutation_admissions
           WHERE admission_id = @admissionId AND status = 'active'
             AND runtime_owner_id = @runtimeOwnerId AND runtime_lease_revision = @leaseRevision
             AND runtime_lease_relinquished_at IS NULL
             AND gc_try_parse_timestamptz(runtime_lease_expires_at) > clock_timestamp()
           FOR UPDATE`
        : `SELECT 1 FROM chat_session_mutation_admissions
           WHERE admission_id = @admissionId AND status = 'active'
             AND runtime_owner_id = @runtimeOwnerId AND runtime_lease_revision = @leaseRevision
             AND runtime_lease_relinquished_at IS NULL
             AND julianday(runtime_lease_expires_at) > julianday('now')`;
    if (
      !this.db.prepare(sql).get({
        admissionId: admission.admission_id,
        runtimeOwnerId: claim.runtimeOwnerId,
        leaseRevision: claim.leaseRevision,
      })
    ) {
      throw admissionConflict("SESSION_MUTATION_REQUEST_LEASE_EXPIRED", "Turn request-runtime lease is expired.");
    }
  }

  private isExpiredUnboundTurnWrite(admission: AdmissionRow): boolean {
    if (
      admission.admission_kind !== "turn_write" ||
      admission.status !== "active" ||
      admission.runtime_lease_relinquished_at !== null ||
      this.findDurableBinding(admission.admission_id, admission.turn_id!, undefined, true)
    ) {
      return false;
    }
    const expiryPredicate =
      this.db.dialect === "postgres"
        ? "gc_try_parse_timestamptz(runtime_lease_expires_at) <= clock_timestamp()"
        : "julianday(runtime_lease_expires_at) <= julianday('now')";
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM chat_session_mutation_admissions
           WHERE admission_id = @admissionId AND status = 'active'
             AND runtime_lease_relinquished_at IS NULL AND ${expiryPredicate}
             AND NOT EXISTS (
               SELECT 1 FROM chat_turn_mutation_admission_durable_bindings durable_binding
               WHERE durable_binding.admission_id = chat_session_mutation_admissions.admission_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM chat_heartbeat_occurrences occurrence
               WHERE occurrence.admission_id = chat_session_mutation_admissions.admission_id
                 AND occurrence.state IN ('admitted', 'durable_bound')
             )`,
        )
        .get({ admissionId: admission.admission_id }),
    );
  }

  private abandonHeartbeatOccurrenceForClosedAdmission(
    occurrence: { occurrence_id: string; revision: number | bigint | string },
    admission: AdmissionRow,
  ): void {
    this.abandonHeartbeatOccurrence(
      occurrence.occurrence_id,
      asPositiveInteger(occurrence.revision),
      heartbeatClosedReason(admission),
    );
  }

  private abandonHeartbeatOccurrence(
    occurrenceId: string,
    revision: number,
    reason: "admission_closed" | "authority_drift" | "lifecycle_drift",
  ): void {
    const updatedAt = this.readDatabaseTime();
    const result = this.db
      .prepare(
        `UPDATE chat_heartbeat_occurrences
         SET state = 'abandoned', abandoned_at = @updatedAt, abandonment_reason = @reason,
             updated_at = @updatedAt, revision = revision + 1
         WHERE occurrence_id = @occurrenceId AND state = 'admitted' AND revision = @revision`,
      )
      .run({ occurrenceId, revision, reason, updatedAt });
    if (result.changes !== 1) {
      throw admissionConflict(
        "SESSION_MUTATION_HEARTBEAT_ABANDON_STALE",
        "Heartbeat occurrence changed during recovery abandonment.",
      );
    }
  }

  private requireCurrentSessionAuthority(normalized: ReturnType<typeof normalizeAdmitInput>): string {
    const row = this.db
      .prepare(
        `SELECT meta.workspace_id, meta.lifecycle_intent_id, meta.deletion_intent_id,
                meta.revision, control.generation, control.owner_kind, control.lease_state,
                control.companion_session_id
         FROM chat_session_meta meta
         JOIN chat_session_control_grants control
           ON control.session_id = meta.session_id AND control.is_current = 1
         WHERE meta.session_id = @sessionId${this.db.dialect === "postgres" ? " FOR UPDATE OF meta, control" : ""}`,
      )
      .get<{
        workspace_id: string;
        lifecycle_intent_id: string | null;
        deletion_intent_id: string | null;
        revision: number | bigint | string;
        generation: number | bigint | string | null;
        owner_kind: "operator" | "external_companion" | null;
        lease_state: string | null;
        companion_session_id: string | null;
      }>({ sessionId: normalized.sessionId });
    const exactController =
      row?.generation !== null &&
      row?.generation !== undefined &&
      asPositiveInteger(row.generation) === normalized.controllerGeneration;
    const exactActorAuthority =
      normalized.actorKind === "external_companion"
        ? row?.owner_kind === "external_companion" &&
          row.lease_state === "external_live" &&
          row.companion_session_id === normalized.actorId
        : row?.owner_kind === "operator" && row.lease_state === "operator_active";
    if (
      !row ||
      row.workspace_id !== normalized.workspaceId ||
      row.deletion_intent_id !== null ||
      asPositiveInteger(row.revision) !== normalized.aggregateRevision ||
      !exactController ||
      !exactActorAuthority
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_ADMISSION_AUTHORITY_MISSING",
        "Mutation admission has no live session incarnation authority.",
      );
    }
    return row.lifecycle_intent_id ?? `legacy-session-incarnation:${normalized.sessionId}`;
  }

  private insertNormalizedAdmission(
    normalized: ReturnType<typeof normalizeAdmitInput>,
    sessionIncarnationId: string,
  ): AdmitSessionMutationOutcome {
    const requestSha256 = admissionRequestSha256(normalized, sessionIncarnationId);
    const admissionId = deriveId("csma", normalized.idempotencyKey, requestSha256);
    const requestLease = normalized.admissionKind === "turn_write" ? this.readDatabaseRequestRuntimeLease() : undefined;
    const createdAt = requestLease?.heartbeatAt ?? this.readDatabaseTime();
    const { expectedSessionIncarnationId: _expectedSessionIncarnationId, ...admissionMaterial } = normalized;
    this.db
      .prepare(
        `INSERT INTO chat_session_mutation_admissions (
           admission_id, session_incarnation_id, workspace_id, session_id, turn_id,
           runtime_owner_id, runtime_last_heartbeat_at, runtime_lease_expires_at,
           runtime_lease_revision, runtime_lease_relinquished_at,
           admission_kind, aggregate_revision,
           controller_generation, actor_kind, actor_id, operation, material_sha256,
           status, idempotency_key, request_sha256, correlation_id, admit_event_id, created_at
         ) VALUES (
           @admissionId, @sessionIncarnationId, @workspaceId, @sessionId, @turnId,
           @runtimeOwnerId, @runtimeLastHeartbeatAt, @runtimeLeaseExpiresAt,
           @runtimeLeaseRevision, NULL,
           @admissionKind, @aggregateRevision,
           @controllerGeneration, @actorKind, @actorId, @operation, @materialSha256,
           'active', @idempotencyKey, @requestSha256, @correlationId, @admitEventId, @createdAt
         )`,
      )
      .run({
        admissionId,
        sessionIncarnationId,
        ...admissionMaterial,
        runtimeLastHeartbeatAt: requestLease?.heartbeatAt ?? null,
        runtimeLeaseExpiresAt: requestLease?.leaseExpiresAt ?? null,
        runtimeLeaseRevision: requestLease ? 1 : null,
        requestSha256,
        admitEventId: deriveId("csmae", admissionId, "admitted"),
        createdAt,
      });
    if (normalized.turnId) {
      this.db
        .prepare(
          `INSERT INTO chat_turn_session_incarnation_bindings (
             turn_id, workspace_id, session_id, session_incarnation_id, admission_id, created_at
           ) VALUES (
             @turnId, @workspaceId, @sessionId, @sessionIncarnationId, @admissionId, @createdAt
           )`,
        )
        .run({
          turnId: normalized.turnId,
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          sessionIncarnationId,
          admissionId,
          createdAt,
        });
    }
    return { disposition: "created", admission: this.require(admissionId) };
  }

  private requireAdmissionCurrentAuthority(admission: AdmissionRow): void {
    if (!this.admissionHasCurrentAuthority(admission)) {
      throw admissionConflict(
        "SESSION_MUTATION_ADMISSION_AUTHORITY_CHANGED",
        "Mutation admission no longer matches the current session controller authority.",
      );
    }
  }

  private admissionHasCurrentAuthority(admission: AdmissionRow): boolean {
    const row = this.db
      .prepare(
        `SELECT meta.workspace_id, meta.lifecycle_intent_id, meta.deletion_intent_id,
                meta.revision, control.generation, control.owner_kind, control.lease_state,
                control.companion_session_id
         FROM chat_session_meta meta
         JOIN chat_session_control_grants control
           ON control.session_id = meta.session_id AND control.is_current = 1
         WHERE meta.session_id = @sessionId${this.db.dialect === "postgres" ? " FOR UPDATE OF meta, control" : ""}`,
      )
      .get<{
        workspace_id: string;
        lifecycle_intent_id: string | null;
        deletion_intent_id: string | null;
        revision: number | bigint | string;
        generation: number | bigint | string;
        owner_kind: "operator" | "external_companion";
        lease_state: string;
        companion_session_id: string | null;
      }>({ sessionId: admission.session_id });
    const currentIncarnation = row
      ? (row.lifecycle_intent_id ?? `legacy-session-incarnation:${admission.session_id}`)
      : undefined;
    const actorAuthority =
      admission.actor_kind === "external_companion"
        ? row?.owner_kind === "external_companion" &&
          row.lease_state === "external_live" &&
          row.companion_session_id === admission.actor_id
        : row?.owner_kind === "operator" && row.lease_state === "operator_active";
    if (!row) return false;
    return (
      row.workspace_id === admission.workspace_id &&
      row.deletion_intent_id === null &&
      currentIncarnation === admission.session_incarnation_id &&
      asPositiveInteger(row.revision) >= asPositiveInteger(admission.aggregate_revision) &&
      asPositiveInteger(row.generation) === asPositiveInteger(admission.controller_generation) &&
      actorAuthority
    );
  }

  private cancelSupersededActiveTurnAdmissions(
    normalized: ReturnType<typeof normalizeAdmitInput>,
    currentSessionIncarnationId: string,
  ): void {
    const currentControl = this.db
      .prepare(
        `SELECT control.generation, control.owner_kind, control.lease_state,
                control.companion_session_id, event_row.event_id
         FROM chat_session_control_grants control
         JOIN chat_session_control_events event_row
           ON event_row.session_id = control.session_id
          AND event_row.idempotency_key = control.transition_idempotency_key
         WHERE control.session_id = @sessionId AND control.workspace_id = @workspaceId
           AND control.is_current = 1${this.db.dialect === "postgres" ? " FOR UPDATE OF control, event_row" : ""}`,
      )
      .get<{
        generation: number | bigint | string;
        owner_kind: "operator" | "external_companion";
        lease_state: string;
        companion_session_id: string | null;
        event_id: string;
      }>({ sessionId: normalized.sessionId, workspaceId: normalized.workspaceId });
    if (!currentControl || asPositiveInteger(currentControl.generation) !== normalized.controllerGeneration) {
      throw admissionConflict(
        "SESSION_MUTATION_ADMISSION_AUTHORITY_CHANGED",
        "Mutation admission controller changed while acquiring authority.",
      );
    }
    const active = this.db
      .prepare(
        `SELECT * FROM chat_session_mutation_admissions
         WHERE session_id = @sessionId AND status = 'active' AND admission_kind = 'turn_write'
         ORDER BY admission_id${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
      )
      .all<AdmissionRow>({ sessionId: normalized.sessionId });
    for (const admission of active) {
      const actorStillCurrent =
        admission.actor_kind === "external_companion"
          ? currentControl.owner_kind === "external_companion" &&
            currentControl.lease_state === "external_live" &&
            currentControl.companion_session_id === admission.actor_id
          : currentControl.owner_kind === "operator" && currentControl.lease_state === "operator_active";
      if (
        admission.workspace_id === normalized.workspaceId &&
        admission.session_incarnation_id === currentSessionIncarnationId &&
        asPositiveInteger(admission.controller_generation) === normalized.controllerGeneration &&
        actorStillCurrent
      ) {
        continue;
      }
      const idempotencyKey = `admission:authority-superseded:${admission.admission_id}:${currentControl.event_id}`;
      this.closeActiveRow(
        {
          admissionId: admission.admission_id,
          status: "cancelled",
          actorId: "system:session-authority",
          idempotencyKey,
          correlationId: currentControl.event_id,
        },
        { kind: "authority_superseded", controlEventId: currentControl.event_id },
      );
    }
  }

  private requireExactTurnBinding(admission: AdmissionRow): void {
    if (admission.admission_kind !== "turn_write") return;
    const binding = this.db
      .prepare(
        `SELECT workspace_id, session_id, session_incarnation_id, admission_id
         FROM chat_turn_session_incarnation_bindings WHERE turn_id = @turnId`,
      )
      .get<{
        workspace_id: string;
        session_id: string;
        session_incarnation_id: string;
        admission_id: string | null;
      }>({ turnId: admission.turn_id });
    if (
      !binding ||
      binding.workspace_id !== admission.workspace_id ||
      binding.session_id !== admission.session_id ||
      binding.session_incarnation_id !== admission.session_incarnation_id ||
      binding.admission_id !== admission.admission_id
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_TURN_BINDING_CORRUPT",
        "Mutation admission has no exact frozen turn incarnation binding.",
      );
    }
  }

  private readDatabaseTime(): string {
    const sql =
      this.db.dialect === "postgres"
        ? `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`
        : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now`;
    const row = this.db.prepare(sql).get<{ now: string }>();
    if (!row?.now) throw new TypeError("database clock did not return a timestamp");
    return row.now;
  }

  private readDatabaseRequestRuntimeLease(): { heartbeatAt: string; leaseExpiresAt: string } {
    const sql =
      this.db.dialect === "postgres"
        ? `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS now_instant)
           SELECT
             to_char(now_instant AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS heartbeat_at,
             to_char(
               (now_instant + interval '60 seconds') AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             ) AS lease_expires_at
           FROM database_clock`
        : `SELECT
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS heartbeat_at,
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 seconds') AS lease_expires_at`;
    const row = this.db.prepare(sql).get<{ heartbeat_at: string; lease_expires_at: string }>();
    if (!row?.heartbeat_at || !row.lease_expires_at) {
      throw new TypeError("database clock did not return a request runtime lease");
    }
    return { heartbeatAt: row.heartbeat_at, leaseExpiresAt: row.lease_expires_at };
  }

  private assertDurableChatUserInputAdmissionIdentity(
    admission: AdmissionRow,
    identity: ReturnType<typeof normalizeDurableChatUserInputAdmissionIdentity>,
  ): void {
    this.assertTurnWriteIdentity(admission, identity);
    if (
      asPositiveInteger(admission.aggregate_revision) !== identity.aggregateRevision ||
      asPositiveInteger(admission.controller_generation) !== identity.controllerGeneration ||
      admission.material_sha256 !== identity.materialSha256
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_USER_INPUT_ADMISSION_IDENTITY_CONFLICT",
        "Durable Chat user-input admission identity conflicts.",
      );
    }
  }

  private findDurableChatUserInputContinuationSeal(
    admissionId: string,
    durableRunId: string,
    promptId: string,
    forUpdate: boolean,
  ): DurableChatUserInputContinuationSealRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM chat_turn_user_input_continuation_seals
         WHERE admission_id = @admissionId AND durable_run_id = @durableRunId AND prompt_id = @promptId${
           forUpdate && this.db.dialect === "postgres" ? " FOR UPDATE" : ""
         }`,
      )
      .get<DurableChatUserInputContinuationSealRow>({ admissionId, durableRunId, promptId });
  }

  private assertExactDurableChatUserInputContinuationReplay(
    input: ReturnType<typeof normalizeDurableChatUserInputResolutionInput>,
    seal: DurableChatUserInputContinuationSealRecord,
    responseRecord: DurableChatUserInputResumeRecord,
  ): void {
    const expectedMaterial = sha256(
      canonicalJsonString({
        version: 1,
        admissionId: seal.admissionId,
        sessionIncarnationId: seal.sessionIncarnationId,
        workspaceId: seal.workspaceId,
        sessionId: seal.sessionId,
        turnId: seal.turnId,
        durableRunId: seal.durableRunId,
        promptId: seal.promptId,
        eventKey: seal.eventKey,
        correlationId: seal.correlationId,
        resumeRecordSha256: seal.resumeRecordSha256,
        responderActorId: seal.responderActorId,
        responderAuthActorSource: seal.responderAuthActorSource,
        waitingRunVersion: seal.waitingRunVersion,
        queuedRunVersion: seal.queuedRunVersion,
        resolvedAt: seal.resolvedAt,
      }),
    );
    if (
      seal.admissionId !== input.admissionIdentity.admissionId ||
      seal.sessionIncarnationId !== input.admissionIdentity.sessionIncarnationId ||
      seal.workspaceId !== input.admissionIdentity.workspaceId ||
      seal.sessionId !== input.admissionIdentity.sessionId ||
      seal.turnId !== input.admissionIdentity.turnId ||
      seal.durableRunId !== input.durableRunId ||
      seal.promptId !== input.promptId ||
      seal.eventKey !== input.eventKey ||
      seal.correlationId !== input.correlationId ||
      seal.resumeRecordSha256 !== sha256(canonicalJsonString(responseRecord)) ||
      canonicalJsonString(responseRecord.response) !== canonicalJsonString(input.response) ||
      seal.responderActorId !== input.responder.actorId ||
      seal.responderAuthActorSource !== input.responder.authActorSource ||
      seal.queuedRunVersion !== seal.waitingRunVersion + 1 ||
      seal.materialSha256 !== expectedMaterial
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_USER_INPUT_REPLAY_CONFLICT",
        "Durable Chat user-input continuation replay conflicts.",
      );
    }
  }

  private requireWaitingChatUserInputTrace(
    identity: ReturnType<typeof normalizeDurableChatUserInputAdmissionIdentity>,
    durableRunId: string,
  ): WaitingChatUserInputTraceRow {
    const trace = this.db
      .prepare(
        `SELECT turn_id, session_id, status, durable_json, pending_user_input_json
         FROM chat_turn_traces WHERE turn_id = @turnId${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
      )
      .get<WaitingChatUserInputTraceRow>({ turnId: identity.turnId });
    const durable = trace?.durable_json ? parseJsonObject(trace.durable_json) : undefined;
    if (
      !trace ||
      trace.session_id !== identity.sessionId ||
      trace.status !== "waiting_for_user_input" ||
      !trace.pending_user_input_json ||
      durable?.runId !== durableRunId
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_USER_INPUT_TRACE_CONFLICT",
        "Chat turn has no exact pending durable user-input trace.",
      );
    }
    return trace;
  }

  private appendDurableChatUserInputResolvedEvent(seal: DurableChatUserInputContinuationSealRecord): void {
    const sequenceRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
         FROM durable_run_events WHERE run_id = @durableRunId`,
      )
      .get<{ next_sequence: number | bigint | string }>({ durableRunId: seal.durableRunId });
    const sequence = asPositiveInteger(sequenceRow?.next_sequence ?? 1);
    this.db
      .prepare(
        `INSERT INTO durable_run_events (
           event_id, run_id, event_type, step_key, payload_json, created_at, sequence
         ) VALUES (
           @eventId, @durableRunId, 'run_woken', @promptId, @payloadJson, @resolvedAt, @sequence
         )`,
      )
      .run({
        eventId: deriveId("drue", seal.sealId, "chat-user-input-resolved"),
        durableRunId: seal.durableRunId,
        promptId: seal.promptId,
        payloadJson: canonicalJsonString({
          version: 1,
          eventKey: seal.eventKey,
          correlationId: seal.correlationId,
          sealId: seal.sealId,
          admissionId: seal.admissionId,
          sessionIncarnationId: seal.sessionIncarnationId,
          workspaceId: seal.workspaceId,
          sessionId: seal.sessionId,
          turnId: seal.turnId,
          runId: seal.durableRunId,
          promptId: seal.promptId,
          resumeRecordSha256: seal.resumeRecordSha256,
          responderActorId: seal.responderActorId,
          responderAuthActorSource: seal.responderAuthActorSource,
          waitingRunVersion: seal.waitingRunVersion,
          queuedRunVersion: seal.queuedRunVersion,
          sealMaterialSha256: seal.materialSha256,
        }),
        resolvedAt: seal.resolvedAt,
        sequence,
      });
  }

  private acquireSessionLock(sessionId: string): void {
    if (this.db.dialect === "postgres") {
      this.db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(@sessionId, 411))").get({ sessionId });
    }
  }
}

function normalizeAdmitInput(input: AdmitSessionMutationInput) {
  if (input.admissionKind !== "synchronous" && input.admissionKind !== "turn_write") {
    throw new ValidationError({ field: "admissionKind" });
  }
  const turnId = input.turnId?.trim();
  const runtimeOwnerId = input.runtimeOwnerId?.trim();
  if ((input.admissionKind === "turn_write") !== Boolean(turnId)) {
    throw new ValidationError({ field: "turnId" });
  }
  if ((input.admissionKind === "turn_write") !== Boolean(runtimeOwnerId)) {
    throw new ValidationError({ field: "runtimeOwnerId" });
  }
  if (input.actorKind !== "operator" && input.actorKind !== "external_companion" && input.actorKind !== "system") {
    throw new ValidationError({ field: "actorKind" });
  }
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    sessionId: identifier(input.sessionId, "sessionId"),
    expectedSessionIncarnationId: input.expectedSessionIncarnationId
      ? boundedIdentifier(input.expectedSessionIncarnationId, "expectedSessionIncarnationId", 320)
      : null,
    turnId: turnId ? identifier(turnId, "turnId") : null,
    runtimeOwnerId: runtimeOwnerId ? identifier(runtimeOwnerId, "runtimeOwnerId") : null,
    admissionKind: input.admissionKind,
    aggregateRevision: positiveInteger(input.aggregateRevision, "aggregateRevision"),
    controllerGeneration: positiveInteger(input.controllerGeneration, "controllerGeneration"),
    actorKind: input.actorKind,
    actorId: identifier(input.actorId, "actorId"),
    operation: boundedIdentifier(input.operation, "operation", 128),
    materialSha256: digest(input.materialSha256, "materialSha256"),
    idempotencyKey: boundedIdentifier(input.idempotencyKey, "idempotencyKey", 512),
    correlationId: identifier(input.correlationId, "correlationId"),
  };
}

function normalizeTurnWriteIdentity(input: TurnWriteAdmissionIdentity) {
  return {
    admissionId: identifier(input.admissionId, "admissionId"),
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    sessionId: identifier(input.sessionId, "sessionId"),
    sessionIncarnationId: boundedIdentifier(input.sessionIncarnationId, "sessionIncarnationId", 320),
    turnId: identifier(input.turnId, "turnId"),
  };
}

function normalizeHeartbeatReclaimInput(input: ReclaimExpiredSystemTurnWriteRequestLeaseInput) {
  const identity = normalizeTurnWriteIdentity(input);
  if (input.actorId !== "system-heartbeat") throw new ValidationError({ field: "actorId" });
  if (input.operation !== "chat_system_heartbeat") throw new ValidationError({ field: "operation" });
  return {
    ...identity,
    occurrenceId: identifier(input.occurrenceId, "occurrenceId"),
    runtimeOwnerId: identifier(input.runtimeOwnerId, "runtimeOwnerId"),
    expectedLeaseRevision: positiveInteger(input.expectedLeaseRevision, "expectedLeaseRevision"),
    actorId: input.actorId,
    operation: input.operation,
    materialSha256: digest(input.materialSha256, "materialSha256"),
    idempotencyKey: boundedIdentifier(input.idempotencyKey, "idempotencyKey", 512),
    correlationId: identifier(input.correlationId, "correlationId"),
    admissionRequestSha256: digest(input.admissionRequestSha256, "admissionRequestSha256"),
    expectedDurableRunId: identifier(input.expectedDurableRunId, "expectedDurableRunId"),
    userMessageId: identifier(input.userMessageId, "userMessageId"),
    assistantMessageId: identifier(input.assistantMessageId, "assistantMessageId"),
    evaluatedPolicySha256: digest(input.evaluatedPolicySha256, "evaluatedPolicySha256"),
    frozenRequestSha256: digest(input.frozenRequestSha256, "frozenRequestSha256"),
    frozenObjectiveSha256: digest(input.frozenObjectiveSha256, "frozenObjectiveSha256"),
    claimSha256: digest(input.claimSha256, "claimSha256"),
  };
}

function normalizeDurableChatUserInputAdmissionIdentity(input: DurableChatUserInputAdmissionIdentity) {
  if (
    !readJsonObject(input) ||
    !hasExactKeys(input as unknown as Record<string, unknown>, [
      "admissionId",
      "aggregateRevision",
      "controllerGeneration",
      "materialSha256",
      "sessionId",
      "sessionIncarnationId",
      "turnId",
      "workspaceId",
    ])
  ) {
    throw new ValidationError({ field: "admissionIdentity" });
  }
  return {
    ...normalizeTurnWriteIdentity(input),
    aggregateRevision: positiveInteger(input.aggregateRevision, "admissionIdentity.aggregateRevision"),
    controllerGeneration: positiveInteger(input.controllerGeneration, "admissionIdentity.controllerGeneration"),
    materialSha256: digest(input.materialSha256, "admissionIdentity.materialSha256"),
  };
}

function normalizeParentLocalPostCommitStageInput(input: ParentLocalPostCommitStageInput) {
  if (input.effect !== "capability_gap" && input.effect !== "realtime" && input.effect !== "agent_end") {
    throw new ValidationError({ field: "effect" });
  }
  return {
    parentAdmission: normalizeDurableChatUserInputAdmissionIdentity(input.parentAdmission),
    parentRunId: identifier(input.parentRunId, "parentRunId"),
    postCommitGenerationId: identifier(input.postCommitGenerationId, "postCommitGenerationId"),
    effect: input.effect,
  };
}

function normalizeDurableChatUserInputResolutionInput(input: ResolveDurableChatUserInputInput) {
  const admissionIdentity = normalizeDurableChatUserInputAdmissionIdentity(input.admissionIdentity);
  const durableRunId = identifier(input.durableRunId, "durableRunId");
  const expectedWaitingRunVersion = positiveInteger(input.expectedWaitingRunVersion, "expectedWaitingRunVersion");
  const promptId = identifier(input.promptId, "promptId");
  if (input.eventKey !== "chat.user_input.resolved") throw new ValidationError({ field: "eventKey" });
  const correlationId = identifier(input.correlationId, "correlationId");
  if (correlationId !== promptId) throw new ValidationError({ field: "correlationId" });
  const responderObject = readJsonObject(input.responder);
  if (
    !responderObject ||
    !hasExactKeys(responderObject, ["actorId", "authActorSource"]) ||
    !isDurableChatUserInputResponderAuthSource(input.responder.authActorSource)
  ) {
    throw new ValidationError({ field: "responder" });
  }
  const responder = {
    actorId: identifier(input.responder.actorId, "responder.actorId"),
    authActorSource: input.responder.authActorSource,
  };
  const response = normalizeChatUserInputResponse(input.response, "response");
  return {
    admissionIdentity,
    durableRunId,
    expectedWaitingRunVersion,
    promptId,
    eventKey: input.eventKey,
    correlationId,
    responder,
    response,
  };
}

function normalizeDurableClaim(input: DurableTurnWriteClaim) {
  return {
    durableRunId: identifier(input.durableRunId, "durableRunId"),
    leaseOwnerId: identifier(input.leaseOwnerId, "leaseOwnerId"),
    attemptCount: nonNegativeInteger(input.attemptCount, "attemptCount"),
  };
}

function normalizeRequestRuntimeClaim(input: RequestRuntimeLeaseClaim) {
  return {
    runtimeOwnerId: identifier(input.runtimeOwnerId, "runtimeOwnerId"),
    leaseRevision: positiveInteger(input.leaseRevision, "leaseRevision"),
  };
}

function normalizeCloseInput(input: CloseSessionMutationAdmissionInput) {
  if (input.status !== "completed" && input.status !== "cancelled") {
    throw new ValidationError({ field: "status" });
  }
  return {
    admissionId: identifier(input.admissionId, "admissionId"),
    status: input.status,
    actorId: identifier(input.actorId, "actorId"),
    idempotencyKey: boundedIdentifier(input.idempotencyKey, "idempotencyKey", 512),
    correlationId: identifier(input.correlationId, "correlationId"),
  };
}

function normalizePostCommitChildStageInput(input: PostCommitChildStageInput) {
  const childAdmission = readPostCommitChildAdmissionIdentity(input.childAdmission);
  const postCommitEligibility = readPostCommitEligibility(input.postCommitEligibility);
  if (!childAdmission) throw new ValidationError({ field: "childAdmission" });
  if (!postCommitEligibility) throw new ValidationError({ field: "postCommitEligibility" });
  const normalized = {
    childAdmission,
    parentRunId: identifier(input.parentRunId, "parentRunId"),
    postCommitGenerationId: identifier(input.postCommitGenerationId, "postCommitGenerationId"),
    effect: input.effect,
    childRunId: identifier(input.childRunId, "childRunId"),
    sourceTurnId: identifier(input.sourceTurnId, "sourceTurnId"),
    postCommitEligibility,
    stage: input.stage,
    terminal: input.terminal,
    durableClaim: normalizeDurableClaim(input.durableClaim),
  };
  if (!(["commitments", "background_review", "memory_maintenance"] as const).includes(normalized.effect)) {
    throw new ValidationError({ field: "effect" });
  }
  if (normalized.durableClaim.durableRunId !== normalized.childRunId) {
    throw new ValidationError({ field: "durableClaim" });
  }
  const expectedStage =
    normalized.effect === "commitments"
      ? { stage: "commitments_write", terminal: true }
      : normalized.effect === "memory_maintenance"
        ? { stage: "memory_maintenance_evaluation", terminal: true }
        : normalized.stage === "background_counter"
          ? { stage: "background_counter", terminal: false }
          : { stage: "background_evidence", terminal: true };
  if (normalized.stage !== expectedStage.stage || normalized.terminal !== expectedStage.terminal) {
    throw new ValidationError({ field: "stage" });
  }
  const expectedMaterial = computePostCommitChildAdmissionMaterialSha256({
    parentRunId: normalized.parentRunId,
    postCommitGenerationId: normalized.postCommitGenerationId,
    effect: normalized.effect,
    childRunId: normalized.childRunId,
    workspaceId: childAdmission.workspaceId,
    sessionId: childAdmission.sessionId,
    sourceTurnId: normalized.sourceTurnId,
    sessionIncarnationId: childAdmission.sessionIncarnationId,
    postCommitEligibility,
  });
  if (childAdmission.materialSha256 !== expectedMaterial) {
    throw new ValidationError({ field: "childAdmission.materialSha256" });
  }
  return normalized;
}

function normalizePostCommitChildDispatchInput(input: AssertPostCommitChildDispatchAuthorityInput) {
  return normalizePostCommitChildStageInput({
    ...input,
    ...(input.effect === "commitments"
      ? { stage: "commitments_write" as const, terminal: true }
      : input.effect === "memory_maintenance"
        ? { stage: "memory_maintenance_evaluation" as const, terminal: true }
        : { stage: "background_counter" as const, terminal: false }),
  });
}

function postCommitChildStageIdempotencyKey(
  input: ReturnType<typeof normalizePostCommitChildStageInput>,
  disposition: "allowed" | "late_blocked",
): string {
  return `chat-post-commit-child-stage:v2:${input.childRunId}:${input.stage}:${disposition}`;
}

function mapAdmission(row: AdmissionRow): SessionMutationAdmissionRecord {
  return {
    admissionId: row.admission_id,
    sessionIncarnationId: row.session_incarnation_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.runtime_owner_id ? { runtimeOwnerId: row.runtime_owner_id } : {}),
    ...(row.runtime_last_heartbeat_at ? { runtimeLastHeartbeatAt: row.runtime_last_heartbeat_at } : {}),
    ...(row.runtime_lease_expires_at ? { runtimeLeaseExpiresAt: row.runtime_lease_expires_at } : {}),
    ...(row.runtime_lease_revision !== null
      ? { runtimeLeaseRevision: asPositiveInteger(row.runtime_lease_revision) }
      : {}),
    ...(row.runtime_lease_relinquished_at ? { runtimeLeaseRelinquishedAt: row.runtime_lease_relinquished_at } : {}),
    admissionKind: row.admission_kind,
    aggregateRevision: asPositiveInteger(row.aggregate_revision),
    controllerGeneration: asPositiveInteger(row.controller_generation),
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    operation: row.operation,
    materialSha256: row.material_sha256,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    closedAt: row.closed_at ?? undefined,
    ...(row.terminal_authority_kind ? { terminalAuthorityKind: row.terminal_authority_kind } : {}),
    ...(row.terminal_runtime_owner_id ? { terminalRuntimeOwnerId: row.terminal_runtime_owner_id } : {}),
    ...(row.terminal_runtime_lease_revision !== null
      ? { terminalRuntimeLeaseRevision: asPositiveInteger(row.terminal_runtime_lease_revision) }
      : {}),
    ...(row.terminal_durable_run_id ? { terminalDurableRunId: row.terminal_durable_run_id } : {}),
    ...(row.terminal_durable_lease_owner_id
      ? { terminalDurableLeaseOwnerId: row.terminal_durable_lease_owner_id }
      : {}),
    ...(row.terminal_durable_attempt_count !== null
      ? { terminalDurableAttemptCount: asNonNegativeInteger(row.terminal_durable_attempt_count) }
      : {}),
    ...(row.terminal_durable_run_version !== null
      ? { terminalDurableRunVersion: asPositiveInteger(row.terminal_durable_run_version) }
      : {}),
    ...(row.terminal_durable_run_status ? { terminalDurableRunStatus: row.terminal_durable_run_status } : {}),
    ...(row.terminal_lifecycle_intent_id ? { terminalLifecycleIntentId: row.terminal_lifecycle_intent_id } : {}),
    ...(row.terminal_control_event_id ? { terminalControlEventId: row.terminal_control_event_id } : {}),
  };
}

function mapEvent(row: AdmissionEventRow): SessionMutationAdmissionEventRecord {
  return {
    eventId: row.event_id,
    admissionId: row.admission_id,
    sessionIncarnationId: row.session_incarnation_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.runtime_owner_id ? { runtimeOwnerId: row.runtime_owner_id } : {}),
    ...(row.runtime_lease_revision !== null
      ? { runtimeLeaseRevision: asPositiveInteger(row.runtime_lease_revision) }
      : {}),
    eventSequence: asPositiveInteger(row.event_sequence),
    eventType: row.event_type,
    admissionKind: row.admission_kind,
    aggregateRevision: asPositiveInteger(row.aggregate_revision),
    controllerGeneration: asPositiveInteger(row.controller_generation),
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    operation: row.operation,
    materialSha256: row.material_sha256,
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    ...(row.terminal_authority_kind ? { terminalAuthorityKind: row.terminal_authority_kind } : {}),
    ...(row.terminal_runtime_owner_id ? { terminalRuntimeOwnerId: row.terminal_runtime_owner_id } : {}),
    ...(row.terminal_runtime_lease_revision !== null
      ? { terminalRuntimeLeaseRevision: asPositiveInteger(row.terminal_runtime_lease_revision) }
      : {}),
    ...(row.terminal_durable_run_id ? { terminalDurableRunId: row.terminal_durable_run_id } : {}),
    ...(row.terminal_durable_lease_owner_id
      ? { terminalDurableLeaseOwnerId: row.terminal_durable_lease_owner_id }
      : {}),
    ...(row.terminal_durable_attempt_count !== null
      ? { terminalDurableAttemptCount: asNonNegativeInteger(row.terminal_durable_attempt_count) }
      : {}),
    ...(row.terminal_durable_run_version !== null
      ? { terminalDurableRunVersion: asPositiveInteger(row.terminal_durable_run_version) }
      : {}),
    ...(row.terminal_durable_run_status ? { terminalDurableRunStatus: row.terminal_durable_run_status } : {}),
    ...(row.terminal_lifecycle_intent_id ? { terminalLifecycleIntentId: row.terminal_lifecycle_intent_id } : {}),
    ...(row.terminal_control_event_id ? { terminalControlEventId: row.terminal_control_event_id } : {}),
  };
}

function mapDurableBinding(row: DurableBindingRow): TurnWriteDurableRunBindingRecord {
  return {
    admissionId: row.admission_id,
    turnId: row.turn_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    sessionIncarnationId: row.session_incarnation_id,
    durableRunId: row.durable_run_id,
    createdAt: row.created_at,
  };
}

function mapTurnCapabilityProfileBinding(row: {
  profile_id: string;
  turn_id: string;
  profile_hash: string;
  created_at: string;
}): TurnCapabilityProfileIncarnationBindingRecord {
  return {
    profileId: row.profile_id,
    turnId: row.turn_id,
    profileHash: row.profile_hash,
    createdAt: row.created_at,
  };
}

function mapDurableChatUserInputContinuationSeal(
  row: DurableChatUserInputContinuationSealRow,
): DurableChatUserInputContinuationSealRecord {
  return {
    version: 1,
    sealId: row.seal_id,
    admissionId: row.admission_id,
    sessionIncarnationId: row.session_incarnation_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    durableRunId: row.durable_run_id,
    promptId: row.prompt_id,
    eventKey: row.event_key,
    correlationId: row.correlation_id,
    resumeRecordSha256: row.resume_record_sha256,
    responderActorId: row.responder_actor_id,
    responderAuthActorSource: row.responder_auth_actor_source,
    waitingRunVersion: asPositiveInteger(row.waiting_run_version),
    queuedRunVersion: asPositiveInteger(row.queued_run_version),
    resolvedAt: row.resolved_at,
    materialSha256: row.material_sha256,
  };
}

function admissionRequestSha256(
  normalized: ReturnType<typeof normalizeAdmitInput>,
  sessionIncarnationId: string,
): string {
  return sha256(
    canonicalJsonString({
      operation: "admit_session_mutation",
      value: { ...normalized, sessionIncarnationId },
    }),
  );
}

function closeAuthorityProofParams(proof: CloseAuthorityProof): {
  terminalAuthorityKind: SessionMutationAdmissionTerminalAuthorityKind;
  terminalRuntimeOwnerId: string | null;
  terminalRuntimeLeaseRevision: number | null;
  terminalDurableRunId: string | null;
  terminalDurableLeaseOwnerId: string | null;
  terminalDurableAttemptCount: number | null;
  terminalDurableRunVersion: number | null;
  terminalDurableRunStatus: string | null;
  terminalLifecycleIntentId: string | null;
  terminalControlEventId: string | null;
} {
  const empty = {
    terminalRuntimeOwnerId: null,
    terminalRuntimeLeaseRevision: null,
    terminalDurableRunId: null,
    terminalDurableLeaseOwnerId: null,
    terminalDurableAttemptCount: null,
    terminalDurableRunVersion: null,
    terminalDurableRunStatus: null,
    terminalLifecycleIntentId: null,
    terminalControlEventId: null,
  };
  switch (proof.kind) {
    case "synchronous":
      return { ...empty, terminalAuthorityKind: proof.kind };
    case "request_runtime":
      return {
        ...empty,
        terminalAuthorityKind: proof.kind,
        terminalRuntimeOwnerId: proof.claim.runtimeOwnerId,
        terminalRuntimeLeaseRevision: proof.claim.leaseRevision,
      };
    case "durable_run":
      return {
        ...empty,
        terminalAuthorityKind: proof.kind,
        terminalDurableRunId: proof.claim.durableRunId,
        terminalDurableLeaseOwnerId: proof.claim.leaseOwnerId,
        terminalDurableAttemptCount: proof.claim.attemptCount,
        terminalDurableRunVersion: proof.runVersion,
        terminalDurableRunStatus: "running",
      };
    case "durable_terminal":
      return {
        ...empty,
        terminalAuthorityKind: proof.kind,
        terminalDurableRunId: proof.durableRunId,
        terminalDurableRunVersion: proof.runVersion,
        terminalDurableRunStatus: proof.runStatus,
      };
    case "expired_recovery":
      return {
        ...empty,
        terminalAuthorityKind: proof.kind,
        terminalRuntimeOwnerId: proof.runtimeOwnerId,
        terminalRuntimeLeaseRevision: proof.leaseRevision,
      };
    case "lifecycle_delete":
      return { ...empty, terminalAuthorityKind: proof.kind, terminalLifecycleIntentId: proof.lifecycleIntentId };
    case "authority_superseded":
      return { ...empty, terminalAuthorityKind: proof.kind, terminalControlEventId: proof.controlEventId };
    case "post_commit_child_stage":
      return {
        ...empty,
        terminalAuthorityKind: proof.kind,
        terminalDurableRunId: proof.claim.durableRunId,
        terminalDurableLeaseOwnerId: proof.claim.leaseOwnerId,
        terminalDurableAttemptCount: proof.claim.attemptCount,
        terminalDurableRunVersion: proof.runVersion,
        terminalDurableRunStatus: "running",
      };
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through: normalized below as corrupt durable authority evidence.
  }
  throw admissionConflict(
    "SESSION_MUTATION_DURABLE_EVIDENCE_CORRUPT",
    "Durable turn authority evidence is not a JSON object.",
  );
}

function readJsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function reconstructAdmittedRequest(
  effectiveRequest: Record<string, unknown>,
  surfaceDerivationValue: unknown,
): Record<string, unknown> | undefined {
  if (surfaceDerivationValue === undefined) return effectiveRequest;
  const derivation = readJsonObject(surfaceDerivationValue);
  if (
    !derivation ||
    !hasExactKeys(derivation, [
      "effectiveAutoRoute",
      "effectiveMode",
      "originalAutoRoute",
      "originalMode",
      "version",
    ]) ||
    derivation.version !== 1 ||
    derivation.effectiveMode !== "chat" ||
    derivation.effectiveAutoRoute !== false ||
    effectiveRequest.mode !== "chat" ||
    effectiveRequest.autoRoute !== false ||
    !(
      derivation.originalMode === null ||
      (typeof derivation.originalMode === "string" && Boolean(derivation.originalMode))
    ) ||
    !(derivation.originalAutoRoute === null || typeof derivation.originalAutoRoute === "boolean")
  ) {
    return undefined;
  }
  const admitted = { ...effectiveRequest };
  if (derivation.originalMode === null) delete admitted.mode;
  else admitted.mode = derivation.originalMode;
  if (derivation.originalAutoRoute === null) delete admitted.autoRoute;
  else admitted.autoRoute = derivation.originalAutoRoute;
  return admitted;
}

function readExactTerminalRuntimeAuthoritySeal(value: unknown): TerminalRuntimeAuthoritySeal | undefined {
  const seal = readJsonObject(value);
  if (!seal || !hasExactKeys(seal, ["material", "materialSha256"])) return undefined;
  const material = readJsonObject(seal.material);
  const hasHeartbeatDecisionReceipt = Boolean(
    material && Object.prototype.hasOwnProperty.call(material, "heartbeatDecisionReceipt"),
  );
  if (
    !material ||
    !hasExactKeys(material, [
      "durableStatus",
      ...(hasHeartbeatDecisionReceipt ? ["heartbeatDecisionReceipt"] : []),
      "linkedFinalization",
      "postCommitEligibility",
      "postCommitGenerationId",
      "requiredFinalizers",
      "runId",
      "terminalOutput",
      "traceStatus",
      "transitionAt",
      "transitionKind",
      "turnId",
      "version",
      "waitForEvent",
    ]) ||
    material.version !== "chat.turn.runtime-authority.v1" ||
    !isNonEmptyRuntimeString(material.runId) ||
    !isNonEmptyRuntimeString(material.turnId) ||
    (material.transitionKind !== "terminal" && material.transitionKind !== "linked_finalization") ||
    !["completed", "failed", "cancelled"].includes(String(material.durableStatus)) ||
    !["completed", "partial", "failed", "cancelled"].includes(String(material.traceStatus)) ||
    !isCanonicalIsoTimestamp(material.transitionAt) ||
    !isNonEmptyRuntimeString(material.postCommitGenerationId) ||
    !readPostCommitEligibility(material.postCommitEligibility) ||
    material.waitForEvent !== null ||
    !Array.isArray(material.requiredFinalizers)
  ) {
    return undefined;
  }
  const requiredFinalizers = material.requiredFinalizers;
  const canonicalFinalizers = ["linked", "autonomous", "general"].filter((finalizer) =>
    requiredFinalizers.includes(finalizer),
  );
  if (
    requiredFinalizers.some(
      (finalizer) => typeof finalizer !== "string" || !["linked", "autonomous", "general"].includes(finalizer),
    ) ||
    new Set(requiredFinalizers).size !== requiredFinalizers.length ||
    canonicalJsonString(requiredFinalizers) !== canonicalJsonString(canonicalFinalizers)
  ) {
    return undefined;
  }
  const terminalOutput =
    material.terminalOutput === null ? null : readExactTerminalRuntimeOutput(material.terminalOutput);
  const heartbeatDecisionReceipt = hasHeartbeatDecisionReceipt
    ? readExactHeartbeatDecisionReceipt(material.heartbeatDecisionReceipt)
    : undefined;
  const linkedFinalization =
    material.linkedFinalization === null
      ? null
      : readExactTerminalRuntimeLinkedFinalization(material.linkedFinalization);
  if (
    (material.terminalOutput !== null && !terminalOutput) ||
    (hasHeartbeatDecisionReceipt && !heartbeatDecisionReceipt) ||
    (material.linkedFinalization !== null && !linkedFinalization)
  ) {
    return undefined;
  }
  const durableStatus = material.durableStatus as TerminalDurableRunStatus;
  const traceStatus = material.traceStatus as TerminalRuntimeAuthorityMaterial["traceStatus"];
  const exactTerminalPair =
    (durableStatus === "completed" && (traceStatus === "completed" || traceStatus === "partial") && terminalOutput) ||
    (durableStatus === "completed" &&
      (traceStatus === "completed" || traceStatus === "partial") &&
      heartbeatDecisionReceipt?.notify === false &&
      !terminalOutput) ||
    (durableStatus === "failed" && traceStatus === "failed" && !terminalOutput) ||
    (durableStatus === "cancelled" && traceStatus === "cancelled" && !terminalOutput);
  if (
    (heartbeatDecisionReceipt && (durableStatus !== "completed" || traceStatus !== "completed")) ||
    (material.transitionKind === "linked_finalization" &&
      (durableStatus !== "failed" || traceStatus !== "failed" || terminalOutput || !linkedFinalization)) ||
    (material.transitionKind === "terminal" && (!exactTerminalPair || linkedFinalization))
  ) {
    return undefined;
  }
  const parsedMaterial: TerminalRuntimeAuthorityMaterial = {
    version: "chat.turn.runtime-authority.v1",
    runId: material.runId as string,
    turnId: material.turnId as string,
    transitionKind: material.transitionKind,
    durableStatus,
    traceStatus,
    transitionAt: material.transitionAt as string,
    postCommitGenerationId: material.postCommitGenerationId as string,
    postCommitEligibility: material.postCommitEligibility as PostCommitEligibility,
    waitForEvent: null,
    terminalOutput: terminalOutput ?? null,
    linkedFinalization: linkedFinalization ?? null,
    requiredFinalizers: [...requiredFinalizers] as TerminalRuntimeFinalizer[],
    ...(heartbeatDecisionReceipt ? { heartbeatDecisionReceipt } : {}),
  };
  if (!isSha256Digest(seal.materialSha256) || seal.materialSha256 !== sha256(canonicalJsonString(parsedMaterial))) {
    return undefined;
  }
  return { material: parsedMaterial, materialSha256: seal.materialSha256 };
}

function requireExactHeartbeatDecisionCommitState(
  db: DatabaseClient,
  input: {
    occurrenceId: string;
    claimSha256: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    userMessageId: string;
    assistantMessageId: string;
    run: DurableRunFenceRow;
  },
): "none" | "committed" {
  const metadata = parseJsonObject(input.run.metadata_json ?? "{}");
  const hasRawOutput = Object.prototype.hasOwnProperty.call(metadata, "heartbeatDecisionRawOutput");
  const hasReceipt = Object.prototype.hasOwnProperty.call(metadata, "heartbeatDecisionReceipt");
  const messages = db
    .prepare(
      `SELECT message_id, session_id, role, actor_type, actor_id, content
       FROM chat_messages WHERE message_id IN (@userMessageId, @assistantMessageId)`,
    )
    .all<{
      message_id: string;
      session_id: string;
      role: string;
      actor_type: string | null;
      actor_id: string;
      content: string;
    }>({ userMessageId: input.userMessageId, assistantMessageId: input.assistantMessageId });
  const userMessage = messages.find((message) => message.message_id === input.userMessageId);
  const assistantMessage = messages.find((message) => message.message_id === input.assistantMessageId);
  const trace = db
    .prepare(
      `SELECT session_id, user_message_id, assistant_message_id, status,
              pending_user_input_json, completion_json, finished_at
       FROM chat_turn_traces WHERE turn_id = @turnId${db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
    )
    .get<{
      session_id: string;
      user_message_id: string;
      assistant_message_id: string | null;
      status: string;
      pending_user_input_json: string | null;
      completion_json: string | null;
      finished_at: string | null;
    }>({ turnId: input.turnId });
  if (!hasRawOutput && !hasReceipt) {
    if (
      userMessage ||
      assistantMessage ||
      !trace ||
      trace.session_id !== input.sessionId ||
      trace.user_message_id !== input.userMessageId ||
      trace.assistant_message_id !== input.assistantMessageId ||
      !["queued", "running"].includes(trace.status) ||
      trace.pending_user_input_json !== null ||
      trace.completion_json !== null ||
      trace.finished_at !== null
    ) {
      throw admissionConflict(
        "SESSION_MUTATION_HEARTBEAT_PREEMPTION_CONFLICT",
        "Durable heartbeat pre-decision evidence is not exact or has no committed decision pair.",
      );
    }
    return "none";
  }
  if (!hasRawOutput || !hasReceipt || typeof metadata.heartbeatDecisionRawOutput !== "string") {
    throw admissionConflict(
      "SESSION_MUTATION_HEARTBEAT_DECISION_CONFLICT",
      "Durable heartbeat has one-sided decision evidence.",
    );
  }
  const receipt = readExactHeartbeatDecisionReceipt(metadata.heartbeatDecisionReceipt);
  const decision = readExactHeartbeatDecision(metadata.heartbeatDecisionRawOutput);
  const completion = trace?.completion_json ? parseJsonObject(trace.completion_json) : undefined;
  if (
    !receipt ||
    !decision ||
    receipt.occurrenceId !== input.occurrenceId ||
    receipt.claimSha256 !== input.claimSha256 ||
    receipt.rawOutputSha256 !== sha256(metadata.heartbeatDecisionRawOutput) ||
    receipt.notify !== decision.notify ||
    receipt.normalizedMessageSha256 !== (decision.notify ? sha256(decision.normalizedMessage) : null) ||
    !trace ||
    trace.session_id !== input.sessionId ||
    trace.user_message_id !== input.userMessageId ||
    trace.assistant_message_id !== input.assistantMessageId ||
    trace.status !== "completed" ||
    !completion ||
    !hasExactKeys(completion, ["repaired", "status"]) ||
    completion.status !== "complete" ||
    completion.repaired !== false ||
    !isCanonicalIsoTimestamp(trace.finished_at) ||
    userMessage ||
    (decision.notify
      ? !assistantMessage ||
        assistantMessage.session_id !== input.sessionId ||
        assistantMessage.role !== "assistant" ||
        assistantMessage.actor_type !== "system" ||
        assistantMessage.actor_id !== "system-heartbeat" ||
        assistantMessage.content !== decision.normalizedMessage
      : Boolean(assistantMessage))
  ) {
    throw admissionConflict(
      "SESSION_MUTATION_HEARTBEAT_DECISION_CONFLICT",
      "Durable heartbeat decision evidence is not exact or is not backed by its completed trace.",
    );
  }
  return "committed";
}

function insertHeartbeatPreemptionControlEvent(
  db: DatabaseClient,
  input: {
    eventId: string;
    workspaceId: string;
    sessionId: string;
    previousGeneration: number;
    nextGeneration: number;
    actorId: string;
    idempotencyKey: string;
    requestSha256: string;
    correlationId: string;
    createdAt: string;
  },
): void {
  const eventSequence =
    asNonNegativeInteger(
      db
        .prepare(
          `SELECT COALESCE(MAX(event_sequence), 0) AS sequence
           FROM chat_session_control_events WHERE session_id = @sessionId`,
        )
        .get<{ sequence: number | bigint | string }>({ sessionId: input.sessionId })?.sequence ?? 0,
    ) + 1;
  db.prepare(
    `INSERT INTO chat_session_control_events (
       event_id, workspace_id, session_id, event_sequence, request_id,
       previous_generation, next_generation, previous_owner_kind, next_owner_kind,
       previous_lease_state, next_lease_state, reason_code, actor_kind, actor_id,
       companion_session_id, device_grant_id, idempotency_key, request_sha256,
       correlation_id, created_at
     ) VALUES (
       @eventId, @workspaceId, @sessionId, @eventSequence, NULL,
       @previousGeneration, @nextGeneration, 'operator', 'operator',
       'operator_active', 'operator_active', 'heartbeat_preempted', 'operator', @actorId,
       NULL, NULL, @idempotencyKey, @requestSha256, @correlationId, @createdAt
     )`,
  ).run({ ...input, eventSequence });
}

function closePendingControlRequestsForHeartbeatPreemption(
  db: DatabaseClient,
  input: {
    workspaceId: string;
    sessionId: string;
    generation: number;
    operatorActorId: string;
    correlationId: string;
    controlEventId: string;
    preemptedAt: string;
  },
): void {
  const pending = db
    .prepare(
      `SELECT request_id, companion_session_id, device_grant_id, expires_at
       FROM chat_session_control_requests
       WHERE workspace_id = @workspaceId AND session_id = @sessionId
         AND requested_generation = @generation AND status = 'pending'
       ORDER BY created_at ASC, request_id ASC
       LIMIT @pendingLimit${db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
    )
    .all<{
      request_id: string;
      companion_session_id: string;
      device_grant_id: string;
      expires_at: string;
    }>({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      generation: input.generation,
      pendingLimit: HEARTBEAT_PREEMPTION_PENDING_CONTROL_REQUEST_LIMIT + 1,
    });
  if (pending.length > HEARTBEAT_PREEMPTION_PENDING_CONTROL_REQUEST_LIMIT) {
    throw admissionConflict(
      "SESSION_MUTATION_HEARTBEAT_PENDING_CONTROL_LIMIT",
      "Heartbeat preemption found too many pending session-control requests to settle atomically.",
    );
  }
  for (const request of pending) {
    const expired = request.expires_at <= input.preemptedAt;
    const status = expired ? "expired" : "cancelled";
    const reasonCode = expired ? "request_expired" : "request_cancelled";
    const idempotencyKey = deriveId("heartbeat-preempt-request", input.controlEventId, request.request_id, reasonCode);
    const requestSha256 = sha256(
      canonicalJsonString({
        version: 1,
        operation: "heartbeat_preemption_request_cleanup",
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        generation: input.generation,
        requestId: request.request_id,
        status,
        reasonCode,
        operatorActorId: input.operatorActorId,
        correlationId: input.correlationId,
        controlEventId: input.controlEventId,
      }),
    );
    const eventSequence =
      asNonNegativeInteger(
        db
          .prepare(
            `SELECT COALESCE(MAX(event_sequence), 0) AS sequence
             FROM chat_session_control_events WHERE session_id = @sessionId`,
          )
          .get<{ sequence: number | bigint | string }>({ sessionId: input.sessionId })?.sequence ?? 0,
      ) + 1;
    const eventId = deriveId("sce", input.workspaceId, input.sessionId, idempotencyKey, reasonCode);
    const insertCleanupEvent = () =>
      db
        .prepare(
          `INSERT INTO chat_session_control_events (
           event_id, workspace_id, session_id, event_sequence, request_id,
           previous_generation, next_generation, previous_owner_kind, next_owner_kind,
           previous_lease_state, next_lease_state, reason_code, actor_kind, actor_id,
           companion_session_id, device_grant_id, idempotency_key, request_sha256,
           correlation_id, created_at
         ) VALUES (
           @eventId, @workspaceId, @sessionId, @eventSequence, @requestId,
           @generation, @generation, 'operator', 'operator',
           'operator_active', 'operator_active', @reasonCode, 'operator', @actorId,
           @companionSessionId, @deviceGrantId, @idempotencyKey, @requestSha256,
           @correlationId, @createdAt
         )`,
        )
        .run({
          eventId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          eventSequence,
          requestId: request.request_id,
          generation: input.generation,
          reasonCode,
          actorId: input.operatorActorId,
          companionSessionId: request.companion_session_id,
          deviceGrantId: request.device_grant_id,
          idempotencyKey,
          requestSha256,
          correlationId: input.correlationId,
          createdAt: input.preemptedAt,
        });
    insertCleanupEvent();
    const updated = db
      .prepare(
        `UPDATE chat_session_control_requests
         SET status = @status, decided_at = @decidedAt, decided_by_actor_id = @actorId,
             decision_reason_code = @reasonCode
         WHERE request_id = @requestId AND status = 'pending'
           AND requested_generation = @generation`,
      )
      .run({
        status,
        decidedAt: input.preemptedAt,
        actorId: input.operatorActorId,
        reasonCode,
        requestId: request.request_id,
        generation: input.generation,
      });
    if (updated.changes !== 1) {
      throw admissionConflict(
        "SESSION_MUTATION_ADMISSION_AUTHORITY_CHANGED",
        "A pending session-control request changed during heartbeat preemption.",
      );
    }
  }
}

function readExactHeartbeatDecisionReceipt(value: unknown): HeartbeatDecisionReceipt | undefined {
  const receipt = readJsonObject(value);
  if (
    !receipt ||
    !hasExactKeys(receipt, [
      "claimSha256",
      "normalizedMessageSha256",
      "notify",
      "occurrenceId",
      "rawOutputSha256",
      "version",
    ]) ||
    receipt.version !== 1 ||
    !isNonEmptyRuntimeString(receipt.occurrenceId) ||
    !isSha256Digest(receipt.claimSha256) ||
    !isSha256Digest(receipt.rawOutputSha256) ||
    typeof receipt.notify !== "boolean" ||
    !(
      (receipt.notify === false && receipt.normalizedMessageSha256 === null) ||
      (receipt.notify === true && isSha256Digest(receipt.normalizedMessageSha256))
    )
  ) {
    return undefined;
  }
  return {
    version: 1,
    occurrenceId: receipt.occurrenceId,
    claimSha256: receipt.claimSha256,
    rawOutputSha256: receipt.rawOutputSha256,
    notify: receipt.notify,
    normalizedMessageSha256: receipt.normalizedMessageSha256,
  } as HeartbeatDecisionReceipt;
}

function readExactHeartbeatDecision(
  rawOutput: string,
): { notify: false } | { notify: true; normalizedMessage: string } | undefined {
  const decision = readUniqueFlatJsonObject(rawOutput);
  if (!decision) return undefined;
  if (decision.size === 1 && decision.get("notify") === false) {
    return { notify: false };
  }
  if (decision.size === 2 && decision.get("notify") === true && typeof decision.get("message") === "string") {
    const normalizedMessage = (decision.get("message") as string).trim();
    const scalarCount = [...normalizedMessage].length;
    if (scalarCount > 0 && scalarCount <= 4_000 && hasOnlyUnicodeScalars(normalizedMessage)) {
      return { notify: true, normalizedMessage };
    }
  }
  return undefined;
}

function readUniqueFlatJsonObject(raw: string): Map<string, string | boolean> | undefined {
  let cursor = 0;
  const skipWhitespace = () => {
    while (cursor < raw.length) {
      const character = raw[cursor]!;
      if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r") break;
      cursor += 1;
    }
  };
  const readStringToken = (): string | undefined => {
    if (raw[cursor] !== '"') return undefined;
    const start = cursor;
    cursor += 1;
    let escaped = false;
    while (cursor < raw.length) {
      const character = raw[cursor]!;
      cursor += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        try {
          const value = JSON.parse(raw.slice(start, cursor)) as unknown;
          return typeof value === "string" && hasOnlyUnicodeScalars(value) ? value : undefined;
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  };
  skipWhitespace();
  if (raw[cursor] !== "{") return undefined;
  cursor += 1;
  const entries = new Map<string, string | boolean>();
  skipWhitespace();
  if (raw[cursor] === "}") {
    cursor += 1;
    skipWhitespace();
    return cursor === raw.length ? entries : undefined;
  }
  while (cursor < raw.length) {
    skipWhitespace();
    const key = readStringToken();
    if (key === undefined || entries.has(key)) return undefined;
    skipWhitespace();
    if (raw[cursor] !== ":") return undefined;
    cursor += 1;
    skipWhitespace();
    let value: string | boolean | undefined;
    if (raw[cursor] === '"') value = readStringToken();
    else if (raw.startsWith("true", cursor)) {
      cursor += 4;
      value = true;
    } else if (raw.startsWith("false", cursor)) {
      cursor += 5;
      value = false;
    }
    if (value === undefined) return undefined;
    entries.set(key, value);
    skipWhitespace();
    if (raw[cursor] === "}") {
      cursor += 1;
      skipWhitespace();
      return cursor === raw.length ? entries : undefined;
    }
    if (raw[cursor] !== ",") return undefined;
    cursor += 1;
  }
  return undefined;
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  }
  return true;
}

function isExactSilentHeartbeatEligibility(value: PostCommitEligibility): boolean {
  return (
    value.version === 1 &&
    value.autonomyEnabledAtParentSettlement === false &&
    value.evalIntegrityTurn === false &&
    value.humanSession === false
  );
}

function readExactHeartbeatAutonomousAdmissionSeal(
  value: unknown,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>,
  runId: string,
): boolean {
  const seal = readJsonObject(value);
  const material = seal ? readJsonObject(seal.material) : undefined;
  const identity = material ? readJsonObject(material.identity) : undefined;
  const autonomous = material ? readJsonObject(material.autonomous) : undefined;
  const admission = material ? readJsonObject(material.admission) : undefined;
  const capability = material ? readJsonObject(material.capability) : undefined;
  const request = readJsonObject(payload.request);
  const requestActor = readJsonObject(payload.requestActor);
  const autonomousKeys = autonomous ? Object.keys(autonomous) : [];
  const allowedAutonomousKeys = new Set([
    "commitmentId",
    "deliverMode",
    "deliveryChannel",
    "kind",
    "profilePosture",
    "reason",
    "sourceRunId",
    "systemActorId",
  ]);
  if (
    !seal ||
    !material ||
    !identity ||
    !autonomous ||
    !admission ||
    !capability ||
    !request ||
    !requestActor ||
    !hasExactKeys(seal, ["material", "materialSha256"]) ||
    !hasExactKeys(material, [
      "admission",
      "autonomous",
      "capability",
      "cronAdmission",
      "identity",
      "objectiveSha256",
      "sessionId",
      "version",
    ]) ||
    material.version !== "chat.autonomous.admission.v1" ||
    !hasExactKeys(identity, ["assistantMessageId", "durableRunId", "turnId", "userMessageId"]) ||
    identity.userMessageId !== payload.userMessageId ||
    identity.assistantMessageId !== payload.assistantMessageId ||
    identity.turnId !== payload.turnId ||
    identity.durableRunId !== runId ||
    material.sessionId !== payload.sessionId ||
    typeof metadata.objective !== "string" ||
    metadata.objective !== request.content ||
    material.objectiveSha256 !== sha256(canonicalJsonString(metadata.objective)) ||
    autonomousKeys.some((key) => !allowedAutonomousKeys.has(key)) ||
    !["deliverMode", "kind", "reason", "sourceRunId", "systemActorId"].every((key) =>
      Object.prototype.hasOwnProperty.call(autonomous, key),
    ) ||
    autonomous.kind !== "heartbeat" ||
    autonomous.systemActorId !== "system-heartbeat" ||
    autonomous.deliverMode !== "on_notify" ||
    !isNonEmptyRuntimeString(autonomous.sourceRunId) ||
    !isNonEmptyRuntimeString(autonomous.reason) ||
    canonicalJsonString(metadata.autonomous) !== canonicalJsonString(autonomous) ||
    requestActor.actorKind !== "system" ||
    requestActor.actorId !== "system-heartbeat" ||
    !hasExactKeys(admission, [
      "admissionId",
      "admissionMaterialSha256",
      "effectiveRequestMaterialSha256",
      "sessionIncarnationId",
      "workspaceId",
    ]) ||
    admission.admissionId !== payload.admissionId ||
    admission.sessionIncarnationId !== payload.sessionIncarnationId ||
    admission.workspaceId !== payload.workspaceId ||
    admission.admissionMaterialSha256 !== payload.admissionMaterialSha256 ||
    admission.effectiveRequestMaterialSha256 !== payload.effectiveRequestMaterialSha256 ||
    !hasExactKeys(capability, ["profileHash", "profileId", "snapshotId"]) ||
    capability.profileId !== payload.capabilityProfileId ||
    capability.profileHash !== payload.capabilityProfileHash ||
    capability.profileId !== metadata.capabilityProfileId ||
    capability.profileHash !== metadata.capabilityProfileHash ||
    !isNonEmptyRuntimeString(capability.snapshotId) ||
    material.cronAdmission !== null ||
    !isSha256Digest(seal.materialSha256) ||
    seal.materialSha256 !== sha256(canonicalJsonString(material))
  ) {
    return false;
  }
  if (autonomous.deliveryChannel !== undefined) {
    const deliveryChannel = readJsonObject(autonomous.deliveryChannel);
    if (
      !deliveryChannel ||
      !["channelKey", "target"].every(
        (key) => key === "target" || Object.prototype.hasOwnProperty.call(deliveryChannel, key),
      ) ||
      Object.keys(deliveryChannel).some((key) => !["channelKey", "target"].includes(key)) ||
      !isNonEmptyRuntimeString(deliveryChannel.channelKey) ||
      (deliveryChannel.target !== undefined && !isNonEmptyRuntimeString(deliveryChannel.target))
    ) {
      return false;
    }
  }
  return true;
}

function readExactTerminalRuntimeOutput(value: unknown): TerminalRuntimeAuthorityOutput | undefined {
  const output = readJsonObject(value);
  if (
    !output ||
    !hasExactKeys(output, ["assistantMessageId", "outputSummarySha256", "outputTextSha256"]) ||
    !isNonEmptyRuntimeString(output.assistantMessageId) ||
    !isSha256Digest(output.outputTextSha256) ||
    !isSha256Digest(output.outputSummarySha256)
  ) {
    return undefined;
  }
  return output as unknown as TerminalRuntimeAuthorityOutput;
}

function readExactTerminalRuntimeLinkedFinalization(value: unknown): TerminalRuntimeLinkedFinalization | undefined {
  const linked = readJsonObject(value);
  if (
    !linked ||
    !hasExactKeys(linked, ["finalizationId", "reasonSha256", "requestedAt"]) ||
    !isNonEmptyRuntimeString(linked.finalizationId) ||
    !isCanonicalIsoTimestamp(linked.requestedAt) ||
    !isSha256Digest(linked.reasonSha256)
  ) {
    return undefined;
  }
  return linked as unknown as TerminalRuntimeLinkedFinalization;
}

function readExactTerminalLinkedFinalization(
  value: unknown,
): (TerminalRuntimeLinkedFinalization & { version: 1; completedAt: string }) | undefined {
  const settlement = readJsonObject(value);
  if (
    !settlement ||
    !hasExactKeys(settlement, ["completedAt", "finalizationId", "reasonSha256", "requestedAt", "version"]) ||
    settlement.version !== 1 ||
    !isNonEmptyRuntimeString(settlement.finalizationId) ||
    !isCanonicalIsoTimestamp(settlement.requestedAt) ||
    !isSha256Digest(settlement.reasonSha256) ||
    !isCanonicalIsoTimestamp(settlement.completedAt)
  ) {
    return undefined;
  }
  return settlement as unknown as TerminalRuntimeLinkedFinalization & { version: 1; completedAt: string };
}

function readExactTerminalAutonomousSettlement(value: unknown):
  | {
      generationId: string;
      requestedAt: string;
      completedAt: string;
      heartbeatCleanupStatus:
        | "completed"
        | "already_completed"
        | "not_required"
        | "manual_reconciliation"
        | "retryable_failure";
    }
  | undefined {
  const settlement = readJsonObject(value);
  if (
    !settlement ||
    !hasExactKeys(settlement, ["completedAt", "delivery", "generationId", "heartbeatCleanup", "requestedAt"]) ||
    !readExactTerminalAutonomousDelivery(settlement.delivery) ||
    !readExactTerminalHeartbeatCleanup(settlement.heartbeatCleanup) ||
    !isNonEmptyRuntimeString(settlement.generationId) ||
    !isCanonicalIsoTimestamp(settlement.requestedAt) ||
    !isCanonicalIsoTimestamp(settlement.completedAt)
  ) {
    return undefined;
  }
  return {
    generationId: settlement.generationId,
    requestedAt: settlement.requestedAt,
    completedAt: settlement.completedAt,
    heartbeatCleanupStatus: (settlement.heartbeatCleanup as { status: string }).status,
  } as {
    generationId: string;
    requestedAt: string;
    completedAt: string;
    heartbeatCleanupStatus:
      | "completed"
      | "already_completed"
      | "not_required"
      | "manual_reconciliation"
      | "retryable_failure";
  };
}

function readExactTerminalAutonomousDelivery(value: unknown): boolean {
  const delivery = readJsonObject(value);
  if (!delivery) return false;
  if (delivery.status === "enqueued") {
    return hasExactKeys(delivery, ["runId", "status"]) && isNonEmptyRuntimeString(delivery.runId);
  }
  if (delivery.status === "skipped") {
    return hasExactKeys(delivery, ["reason", "status"]) && isNonEmptyRuntimeString(delivery.reason);
  }
  return false;
}

function readExactTerminalHeartbeatCleanup(value: unknown): boolean {
  const cleanup = readJsonObject(value);
  if (!cleanup) return false;
  if (["completed", "already_completed", "not_required"].includes(String(cleanup.status))) {
    return hasExactKeys(cleanup, ["status"]);
  }
  if (["manual_reconciliation", "retryable_failure"].includes(String(cleanup.status))) {
    return hasExactKeys(cleanup, ["reason", "status"]) && isNonEmptyRuntimeString(cleanup.reason);
  }
  return false;
}

function readExactTerminalGeneralSettlement(value: unknown): TerminalGeneralPostCommitSettlement | undefined {
  const settlement = readJsonObject(value);
  const requiredKeys = [
    "childOutcomeAuthority",
    "completedEffects",
    "durableEffectOutcomes",
    "durableEffectRunIds",
    "generationId",
    "parentLocalEffectsSettledAt",
    "parentLocalEffectsStatus",
    "postCommitEligibility",
    "requestedAt",
    "settlementStatus",
    "traceStatus",
  ];
  const optionalKeys = [
    "agentEnd",
    "backgroundReview",
    "capabilityGap",
    "commitments",
    "completedAt",
    "learnedMemory",
    "memoryMaintenance",
    "memoryPrewarm",
    "realtime",
    "status",
    "turnId",
  ];
  if (
    !settlement ||
    !hasExactOptionalRuntimeKeys(settlement, requiredKeys, optionalKeys) ||
    !isNonEmptyRuntimeString(settlement.generationId) ||
    !["completed", "partial", "failed", "cancelled"].includes(String(settlement.traceStatus)) ||
    !isCanonicalIsoTimestamp(settlement.requestedAt) ||
    !readPostCommitEligibility(settlement.postCommitEligibility) ||
    settlement.parentLocalEffectsStatus !== "settled" ||
    !isCanonicalIsoTimestamp(settlement.parentLocalEffectsSettledAt) ||
    settlement.childOutcomeAuthority !== "child_durable_runs" ||
    (settlement.settlementStatus !== "completed" && settlement.settlementStatus !== "settled_with_failures") ||
    !isCanonicalIsoTimestamp(settlement.completedAt)
  ) {
    return undefined;
  }
  const completedEffects = readExactTerminalEffectArray(settlement.completedEffects);
  const durableEffectRunIdsValue = readJsonObject(settlement.durableEffectRunIds);
  const durableEffectOutcomesValue = readJsonObject(settlement.durableEffectOutcomes);
  if (!completedEffects || !durableEffectRunIdsValue || !durableEffectOutcomesValue) return undefined;
  const durableEffects = ["background_review", "commitments", "memory_maintenance"];
  if (
    Object.keys(durableEffectRunIdsValue).some((effect) => !durableEffects.includes(effect)) ||
    Object.keys(durableEffectOutcomesValue).sort().join(",") !== Object.keys(durableEffectRunIdsValue).sort().join(",")
  ) {
    return undefined;
  }
  const durableEffectRunIds: Record<string, string> = {};
  const durableEffectOutcomes: Record<string, TerminalGeneralDurableEffectOutcome> = {};
  for (const [effect, runId] of Object.entries(durableEffectRunIdsValue)) {
    if (!isNonEmptyRuntimeString(runId)) return undefined;
    const outcome = readJsonObject(durableEffectOutcomesValue[effect]);
    if (
      !outcome ||
      !hasExactOptionalRuntimeKeys(outcome, ["runId", "settledAt", "status"], ["error"]) ||
      outcome.runId !== runId ||
      !["completed", "failed", "cancelled", "dead_lettered"].includes(String(outcome.status)) ||
      !isCanonicalIsoTimestamp(outcome.settledAt) ||
      (outcome.error !== undefined && !isNonEmptyRuntimeString(outcome.error))
    ) {
      return undefined;
    }
    durableEffectRunIds[effect] = runId;
    durableEffectOutcomes[effect] = {
      runId,
      status: outcome.status as TerminalPostCommitChildStatus,
      settledAt: outcome.settledAt as string,
      ...(outcome.error === undefined ? {} : { error: outcome.error as string }),
    };
  }
  if (new Set(Object.values(durableEffectRunIds)).size !== Object.keys(durableEffectRunIds).length) {
    return undefined;
  }
  return {
    generationId: settlement.generationId as string,
    traceStatus: settlement.traceStatus as TerminalRuntimeAuthorityMaterial["traceStatus"],
    requestedAt: settlement.requestedAt as string,
    postCommitEligibility: settlement.postCommitEligibility as PostCommitEligibility,
    parentLocalEffectsStatus: "settled",
    parentLocalEffectsSettledAt: settlement.parentLocalEffectsSettledAt as string,
    completedEffects,
    durableEffectRunIds,
    durableEffectOutcomes,
    childOutcomeAuthority: "child_durable_runs",
    settlementStatus: settlement.settlementStatus,
    completedAt: settlement.completedAt as string,
  };
}

function readExactTerminalEffectArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((effect) => typeof effect !== "string")) return undefined;
  const effects = value as string[];
  if (
    effects.some((effect) => !GENERAL_CHAT_POST_COMMIT_EFFECTS.has(effect)) ||
    new Set(effects).size !== effects.length
  ) {
    return undefined;
  }
  return [...effects];
}

function hasExactOptionalRuntimeKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    requiredKeys.every((key) => key in value) &&
    keys.every((key) => requiredKeys.includes(key) || optionalKeys.includes(key))
  );
}

function isNonEmptyRuntimeString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (!isNonEmptyRuntimeString(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function readChatTurnAdmissionHandoffMarker(value: unknown): ChatTurnAdmissionHandoffMarker | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (
    !hasExactKeys(value as Record<string, unknown>, [
      "admissionId",
      "childRunIds",
      "childRunIdsSha256",
      "committedAt",
      "parentLocalEffectsStatus",
      "parentRunId",
      "postCommitGenerationId",
      "sessionIncarnationId",
      "turnId",
      "version",
    ])
  )
    return undefined;
  const marker = value as Partial<ChatTurnAdmissionHandoffMarker>;
  if (
    marker.version !== 1 ||
    typeof marker.admissionId !== "string" ||
    !marker.admissionId ||
    typeof marker.sessionIncarnationId !== "string" ||
    !marker.sessionIncarnationId ||
    typeof marker.turnId !== "string" ||
    !marker.turnId ||
    typeof marker.parentRunId !== "string" ||
    !marker.parentRunId ||
    typeof marker.postCommitGenerationId !== "string" ||
    !marker.postCommitGenerationId ||
    marker.parentLocalEffectsStatus !== "settled" ||
    !Array.isArray(marker.childRunIds) ||
    marker.childRunIds.some((childRunId) => typeof childRunId !== "string" || !childRunId) ||
    typeof marker.childRunIdsSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(marker.childRunIdsSha256) ||
    !isCanonicalIsoTimestamp(marker.committedAt)
  ) {
    return undefined;
  }
  const childRunIds = marker.childRunIds as string[];
  const sortedUnique = [...new Set(childRunIds)].sort((left, right) => left.localeCompare(right));
  if (
    canonicalJsonString(childRunIds) !== canonicalJsonString(sortedUnique) ||
    sha256(canonicalJsonString(sortedUnique)) !== marker.childRunIdsSha256
  ) {
    return undefined;
  }
  return { ...(marker as ChatTurnAdmissionHandoffMarker), childRunIds: sortedUnique };
}

function readParentLocalPostCommitPendingMarker(value: unknown): ParentLocalPostCommitPendingMarker | undefined {
  const marker = readJsonObject(value);
  if (
    !marker ||
    !hasExactKeys(marker, [
      "completedEffects",
      "durableEffectRunIds",
      "generationId",
      "postCommitEligibility",
      "requestedAt",
      "traceStatus",
      "version",
    ]) ||
    marker.version !== 1 ||
    typeof marker.generationId !== "string" ||
    !marker.generationId ||
    typeof marker.requestedAt !== "string" ||
    !marker.requestedAt ||
    typeof marker.traceStatus !== "string" ||
    !marker.traceStatus ||
    !readPostCommitEligibility(marker.postCommitEligibility) ||
    !readJsonObject(marker.durableEffectRunIds) ||
    !Array.isArray(marker.completedEffects)
  ) {
    return undefined;
  }
  const completedEffects = marker.completedEffects;
  if (
    completedEffects.some((effect) => typeof effect !== "string" || !GENERAL_CHAT_POST_COMMIT_EFFECTS.has(effect)) ||
    new Set(completedEffects).size !== completedEffects.length
  ) {
    return undefined;
  }
  return { generationId: marker.generationId, completedEffects: [...completedEffects] as string[] };
}

function readPostCommitChildAdmissionIdentity(value: unknown): PostCommitChildAdmissionIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (
    !hasExactKeys(value as Record<string, unknown>, [
      "actorId",
      "actorKind",
      "admissionId",
      "aggregateRevision",
      "controllerGeneration",
      "materialSha256",
      "operation",
      "sessionId",
      "sessionIncarnationId",
      "workspaceId",
    ])
  )
    return undefined;
  const admission = value as Partial<PostCommitChildAdmissionIdentity>;
  if (
    typeof admission.admissionId !== "string" ||
    !admission.admissionId ||
    typeof admission.sessionIncarnationId !== "string" ||
    !admission.sessionIncarnationId ||
    typeof admission.workspaceId !== "string" ||
    !admission.workspaceId ||
    typeof admission.sessionId !== "string" ||
    !admission.sessionId ||
    !Number.isSafeInteger(admission.aggregateRevision) ||
    Number(admission.aggregateRevision) < 1 ||
    !Number.isSafeInteger(admission.controllerGeneration) ||
    Number(admission.controllerGeneration) < 1 ||
    (admission.actorKind !== "operator" &&
      admission.actorKind !== "external_companion" &&
      admission.actorKind !== "system") ||
    typeof admission.actorId !== "string" ||
    !admission.actorId ||
    admission.operation !== "chat_post_commit_child" ||
    typeof admission.materialSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(admission.materialSha256)
  ) {
    return undefined;
  }
  return admission as PostCommitChildAdmissionIdentity;
}

function readPostCommitEligibility(value: unknown): PostCommitEligibility | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const eligibility = value as Partial<PostCommitEligibility>;
  if (
    !hasExactKeys(value as Record<string, unknown>, [
      "autonomyEnabledAtParentSettlement",
      "evalIntegrityTurn",
      "humanSession",
      "version",
    ]) ||
    eligibility.version !== 1 ||
    typeof eligibility.autonomyEnabledAtParentSettlement !== "boolean" ||
    typeof eligibility.evalIntegrityTurn !== "boolean" ||
    typeof eligibility.humanSession !== "boolean"
  ) {
    return undefined;
  }
  return eligibility as PostCommitEligibility;
}

interface ExactChatUserInputPrompt {
  promptId: string;
  turnId: string;
  kind: "single_select" | "text";
  title: string;
  question: string;
  options?: Array<{ optionId: string; label: string; description: string }>;
}

function assertExactDurableChatUserInputWait(
  metadata: Record<string, unknown>,
  promptId: string,
  eventKey: "chat.user_input.resolved",
  correlationId: string,
): void {
  const wait = readJsonObject(metadata.waitForEvent);
  if (!wait || wait.eventKey !== eventKey || wait.correlationId !== correlationId || correlationId !== promptId) {
    throw admissionConflict(
      "SESSION_MUTATION_USER_INPUT_WAIT_REGISTRATION_CONFLICT",
      "Durable Chat run has no exact user-input wake registration.",
    );
  }
}

function readExactChatUserInputPrompt(value: string, promptId: string): ExactChatUserInputPrompt {
  const prompt = parseJsonObject(value);
  const options = prompt.options;
  if (
    prompt.promptId !== promptId ||
    typeof prompt.turnId !== "string" ||
    !prompt.turnId ||
    (prompt.kind !== "single_select" && prompt.kind !== "text") ||
    typeof prompt.title !== "string" ||
    typeof prompt.question !== "string" ||
    !prompt.question
  ) {
    throw admissionConflict(
      "SESSION_MUTATION_USER_INPUT_PROMPT_CONFLICT",
      "Chat turn pending user-input prompt is invalid.",
    );
  }
  let normalizedOptions: ExactChatUserInputPrompt["options"];
  if (options !== undefined) {
    if (!Array.isArray(options)) {
      throw admissionConflict(
        "SESSION_MUTATION_USER_INPUT_PROMPT_CONFLICT",
        "Chat turn pending user-input prompt options are invalid.",
      );
    }
    normalizedOptions = options.map((candidate) => {
      const option = readJsonObject(candidate);
      if (
        !option ||
        typeof option.optionId !== "string" ||
        !option.optionId ||
        typeof option.label !== "string" ||
        typeof option.description !== "string"
      ) {
        throw admissionConflict(
          "SESSION_MUTATION_USER_INPUT_PROMPT_CONFLICT",
          "Chat turn pending user-input prompt options are invalid.",
        );
      }
      return { optionId: option.optionId, label: option.label, description: option.description };
    });
  }
  return {
    promptId,
    turnId: prompt.turnId,
    kind: prompt.kind,
    title: prompt.title,
    question: prompt.question,
    ...(normalizedOptions ? { options: normalizedOptions } : {}),
  };
}

function normalizeChatUserInputResponse(
  value: ResolveDurableChatUserInputInput["response"],
  field: string,
): ResolveDurableChatUserInputInput["response"] {
  const response = readJsonObject(value);
  if (!response) throw new ValidationError({ field });
  if (response.kind === "text") {
    if (!hasExactKeys(response, ["kind", "text"]) || typeof response.text !== "string" || !response.text.trim()) {
      throw new ValidationError({ field });
    }
    return { kind: "text", text: response.text.trim() };
  }
  if (
    response.kind !== "single_select" ||
    !hasExactKeys(response, ["kind", "optionId"]) ||
    typeof response.optionId !== "string" ||
    !response.optionId.trim()
  ) {
    throw new ValidationError({ field });
  }
  return { kind: "single_select", optionId: response.optionId.trim() };
}

function buildDurableChatUserInputResumeRecord(
  prompt: ExactChatUserInputPrompt,
  response: ResolveDurableChatUserInputInput["response"],
  resolvedAt: string,
): DurableChatUserInputResumeRecord {
  if (prompt.kind !== response.kind) {
    throw admissionConflict(
      "SESSION_MUTATION_USER_INPUT_RESPONSE_CONFLICT",
      "Durable Chat user-input response kind does not match the pending prompt.",
    );
  }
  if (response.kind === "text") {
    return {
      promptId: prompt.promptId,
      kind: "text",
      title: prompt.title,
      question: prompt.question,
      answeredAt: resolvedAt,
      response,
    };
  }
  const option = prompt.options?.find((candidate) => candidate.optionId === response.optionId);
  if (!option) {
    throw admissionConflict(
      "SESSION_MUTATION_USER_INPUT_RESPONSE_CONFLICT",
      "Durable Chat user-input selection does not match a frozen prompt option.",
    );
  }
  return {
    promptId: prompt.promptId,
    kind: "single_select",
    title: prompt.title,
    question: prompt.question,
    answeredAt: resolvedAt,
    response,
    selectedOption: option,
  };
}

function normalizeDurableChatUserInputResumeRecord(
  value: DurableChatUserInputResumeRecord,
  field: string,
): DurableChatUserInputResumeRecord {
  const record = readJsonObject(value);
  if (!record) throw new ValidationError({ field });
  const kind = record.kind;
  if (kind !== "single_select" && kind !== "text") throw new ValidationError({ field: `${field}.kind` });
  const expectedKeys =
    kind === "single_select"
      ? ["answeredAt", "kind", "promptId", "question", "response", "selectedOption", "title"]
      : ["answeredAt", "kind", "promptId", "question", "response", "title"];
  if (!hasExactKeys(record, expectedKeys)) throw new ValidationError({ field });
  const promptId = identifier(String(record.promptId ?? ""), `${field}.promptId`);
  const title = typeof record.title === "string" ? record.title : undefined;
  const question = typeof record.question === "string" ? record.question : undefined;
  if (title === undefined || question === undefined || !question) throw new ValidationError({ field });
  const answeredAt = requiredIsoTimestamp(String(record.answeredAt ?? ""), `${field}.answeredAt`);
  const response = readJsonObject(record.response);
  if (!response) throw new ValidationError({ field: `${field}.response` });
  if (kind === "text") {
    if (
      !hasExactKeys(response, ["kind", "text"]) ||
      response.kind !== "text" ||
      typeof response.text !== "string" ||
      !response.text.trim() ||
      response.text !== response.text.trim()
    ) {
      throw new ValidationError({ field: `${field}.response` });
    }
    return { promptId, kind, title, question, answeredAt, response: { kind: "text", text: response.text } };
  }
  if (
    !hasExactKeys(response, ["kind", "optionId"]) ||
    response.kind !== "single_select" ||
    typeof response.optionId !== "string" ||
    !response.optionId
  ) {
    throw new ValidationError({ field: `${field}.response` });
  }
  const selectedOption = readJsonObject(record.selectedOption);
  if (
    !selectedOption ||
    !hasExactKeys(selectedOption, ["description", "label", "optionId"]) ||
    typeof selectedOption.optionId !== "string" ||
    typeof selectedOption.label !== "string" ||
    typeof selectedOption.description !== "string"
  ) {
    throw new ValidationError({ field: `${field}.selectedOption` });
  }
  return {
    promptId,
    kind,
    title,
    question,
    answeredAt,
    response: { kind: "single_select", optionId: response.optionId },
    selectedOption: {
      optionId: selectedOption.optionId,
      label: selectedOption.label,
      description: selectedOption.description,
    },
  };
}

function readDurableChatUserInputResponses(value: unknown): DurableChatUserInputResumeRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw admissionConflict(
      "SESSION_MUTATION_USER_INPUT_CONTINUATION_SET_CONFLICT",
      "Durable Chat user-input response set is invalid.",
    );
  }
  try {
    return value.map((record, index) =>
      normalizeDurableChatUserInputResumeRecord(
        record as DurableChatUserInputResumeRecord,
        `userInputResponses.${index}`,
      ),
    );
  } catch {
    throw admissionConflict(
      "SESSION_MUTATION_USER_INPUT_CONTINUATION_SET_CONFLICT",
      "Durable Chat user-input response set is invalid.",
    );
  }
}

function isDurableChatUserInputResponderAuthSource(value: unknown): value is DurableChatUserInputResponderAuthSource {
  return (
    value === "none" ||
    value === "token" ||
    value === "basic" ||
    value === "loopback" ||
    value === "sse" ||
    value === "device" ||
    value === "companion" ||
    value === "a2a_peer"
  );
}

function hasExactKeys(value: Record<string, unknown>, expectedSortedKeys: readonly string[]): boolean {
  const keys = Object.keys(value).sort((left, right) => left.localeCompare(right));
  return canonicalJsonString(keys) === canonicalJsonString(expectedSortedKeys);
}

export function computePostCommitChildAdmissionMaterialSha256(input: PostCommitChildAdmissionMaterialInput): string {
  return sha256(
    canonicalJsonString({
      version: 1,
      operation: "chat_post_commit_child",
      ...input,
    }),
  );
}

function identifier(value: string, field: string): string {
  return boundedIdentifier(value, field, 256);
}

function boundedIdentifier(value: string, field: string, max: number): string {
  const normalized = value.trim();
  if (!normalized) throw new ValidationError({ code: "FIELD_REQUIRED", field });
  if (normalized.length > max) throw new ValidationError({ field });
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new ValidationError({ field });
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ValidationError({ field });
  return value;
}

function boundedLimit(value: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new ValidationError({ field });
  return value;
}

function asPositiveInteger(value: number | bigint | string): number {
  const parsed = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw admissionConflict("SESSION_MUTATION_ADMISSION_CORRUPT", "Mutation admission numeric state is corrupt.");
  }
  return parsed;
}

function asNonNegativeInteger(value: number | bigint | string): number {
  const parsed = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw admissionConflict("SESSION_MUTATION_ADMISSION_CORRUPT", "Mutation admission numeric state is corrupt.");
  }
  return parsed;
}

function incrementPositiveInteger(value: number): number {
  const next = value + 1;
  if (!Number.isSafeInteger(next) || next < 1) {
    throw admissionConflict(
      "SESSION_MUTATION_ADMISSION_CORRUPT",
      "Mutation admission controller generation overflowed.",
    );
  }
  return next;
}

function digest(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) throw new ValidationError({ field });
  return normalized;
}

function requiredIsoTimestamp(value: string, field: string): string {
  const normalized = boundedIdentifier(value, field, 64);
  if (Number.isNaN(Date.parse(normalized))) throw new ValidationError({ field });
  return normalized;
}

function deriveId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256(canonicalJsonString(parts)).slice(0, 48)}`;
}

function heartbeatPreemptionRequestSha256(input: {
  workspaceId: string;
  sessionId: string;
  expectedControllerGeneration: number;
  operatorActorId: string;
  operatorAdmissionIdempotencyKey: string;
  correlationId: string;
}): string {
  return sha256(
    canonicalJsonString({
      version: 1,
      operation: "heartbeat_preempted",
      ...input,
    }),
  );
}

function heartbeatPrebindCloseIdempotencyKey(admissionId: string, controlEventId: string): string {
  return `heartbeat-preempt:admission:${admissionId}:${controlEventId}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function heartbeatClosedReason(admission: AdmissionRow): "admission_closed" | "authority_drift" | "lifecycle_drift" {
  if (admission.terminal_authority_kind === "authority_superseded") return "authority_drift";
  if (admission.terminal_authority_kind === "lifecycle_delete") return "lifecycle_drift";
  return "admission_closed";
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function",
  );
}

function admissionConflict(code: string, message: string): ConflictError {
  return new ConflictError({ code: "STATE_CONFLICT", message, details: { sessionMutationAdmissionCode: code } });
}

function normalizeAdmissionWriteError(error: unknown): Error {
  if (error instanceof ConflictError || error instanceof NotFoundError || error instanceof ValidationError)
    return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  if (
    /one_active_turn|one active|idx_chat_session_mutation_admissions_one_active_turn|mutation_admissions\.session_id/iu.test(
      message,
    )
  ) {
    return admissionConflict(
      "SESSION_MUTATION_TURN_ALREADY_ACTIVE",
      "Session already has one active durable turn admission.",
    );
  }
  if (/^(?:23505|23514|SQLITE_CONSTRAINT)/u.test(code) || /constraint|invariant|immutable|unique/iu.test(message)) {
    return admissionConflict(
      "SESSION_MUTATION_ADMISSION_DENIED",
      "Session mutation admission conflicts with authority.",
    );
  }
  return error instanceof Error ? error : new Error("Session mutation admission failed.");
}
