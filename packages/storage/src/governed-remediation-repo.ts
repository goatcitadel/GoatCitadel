/* eslint-disable max-lines -- Governed-remediation storage grew past the cap in the control-plane work; splitting the repository module is tracked follow-up, and the always-on lint lane must stay green meanwhile. */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  ConflictError,
  GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_PHASES,
  GOVERNED_REMEDIATION_PHASE_CLAIM_AGGREGATE_KINDS,
  GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_RECONCILIATION_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_PHASE_CLAIM_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
  NotFoundError,
  canonicalJsonString,
  governedRemediationReconciliationCanTransition,
  governedRemediationStateCanTransition,
  normalizeGovernedRemediationFailure,
  normalizeGovernedRemediationPhaseClaim,
  normalizeGovernedRemediationReceipt,
  normalizeGovernedRemediationReconciliation,
  normalizeGovernedRemediationScope,
  normalizeGovernedRemediationStateRecord,
  type GovernedRemediationFailure,
  type GovernedRemediationPhase,
  type GovernedRemediationPhaseClaim,
  type GovernedRemediationPhaseClaimAggregateKind,
  type GovernedRemediationReceipt,
  type GovernedRemediationReceiptKind,
  type GovernedRemediationReconciliation,
  type GovernedRemediationReconciliationDomain,
  type GovernedRemediationScope,
  type GovernedRemediationState,
  type GovernedRemediationStateRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

export interface GovernedRemediationStoredState {
  ownerId: string;
  record: GovernedRemediationStateRecord;
}

export interface GovernedRemediationCasResult<T> {
  record: T;
  appliedRevision: number;
  replayed: boolean;
}

export interface GovernedRemediationRecoveryQuery {
  updatedBefore?: string;
  limit?: number;
}

export interface GovernedRemediationStateRecoveryCursor {
  updatedAt: string;
  remediationId: string;
}

export interface GovernedRemediationReconciliationRecoveryCursor {
  updatedAt: string;
  reconciliationId: string;
}

export interface GovernedRemediationStateRecoveryQuery extends GovernedRemediationRecoveryQuery {
  states?: readonly GovernedRemediationState[];
  after?: GovernedRemediationStateRecoveryCursor;
}

export interface GovernedRemediationReconciliationRecoveryQuery extends GovernedRemediationRecoveryQuery {
  domains?: readonly GovernedRemediationReconciliationDomain[];
  after?: GovernedRemediationReconciliationRecoveryCursor;
}

export type GovernedRemediationPhaseClaimAcquireDisposition = "acquired" | "replayed" | "busy" | "stale" | "completed";

export interface GovernedRemediationPhaseClaimAcquireInput {
  claimId: string;
  aggregateKind: GovernedRemediationPhaseClaimAggregateKind;
  aggregateId: string;
  remediationId: string;
  phase: GovernedRemediationPhase;
  claimantId: string;
  expectedAggregateRevision: number;
  operationId: string;
  effectId: string | null;
  expectedOwnerRevision: string | null;
  leaseTokenSha256: string;
  leaseDurationSeconds: number;
  acquisitionIdempotencyKey: string;
}

export type GovernedRemediationPhaseClaimAcquireResult =
  | {
      disposition: Exclude<GovernedRemediationPhaseClaimAcquireDisposition, "stale">;
      claim: GovernedRemediationPhaseClaim;
    }
  | { disposition: "stale"; claim: GovernedRemediationPhaseClaim | null };

export interface GovernedRemediationPhaseClaimWitness {
  remediationId: string;
  phase: GovernedRemediationPhase;
  claimId: string;
  claimRevision: number;
  claimantId: string;
  /** Raw 32-byte base64url bearer. It is hashed for comparison and never persisted. */
  leaseToken: string;
}

export type GovernedRemediationClaimedPhaseOutcome =
  | { kind: "state_transition"; nextState: GovernedRemediationStateRecord }
  | {
      kind: "state_receipt";
      receipt: GovernedRemediationReceipt;
      nextState: GovernedRemediationStateRecord;
    }
  | {
      kind: "state_activation_receipts";
      activationReceipt: GovernedRemediationReceipt;
      verificationReceipt: GovernedRemediationReceipt;
      nextState: GovernedRemediationStateRecord;
    }
  | {
      kind: "state_activation_failure";
      activationReceipt: GovernedRemediationReceipt;
      failure: GovernedRemediationFailure;
      nextState: GovernedRemediationStateRecord;
    }
  | {
      kind: "state_activation_failure_reconciliation";
      activationReceipt: GovernedRemediationReceipt;
      failure: GovernedRemediationFailure;
      reconciliation: GovernedRemediationReconciliation;
      nextState: GovernedRemediationStateRecord;
    }
  | {
      kind: "state_failure";
      failure: GovernedRemediationFailure;
      nextState: GovernedRemediationStateRecord;
    }
  | {
      kind: "state_failure_reconciliation";
      failure: GovernedRemediationFailure;
      reconciliation: GovernedRemediationReconciliation;
      nextState: GovernedRemediationStateRecord;
    }
  | { kind: "failure_only"; failure: GovernedRemediationFailure }
  | { kind: "reconciliation_transition"; nextReconciliation: GovernedRemediationReconciliation }
  | {
      kind: "reconciliation_receipt";
      receipt: GovernedRemediationReceipt;
      nextReconciliation: GovernedRemediationReconciliation;
    }
  | {
      kind: "reconciliation_application_receipts";
      applicationReceipt: GovernedRemediationReceipt;
      reconciliationReceipt: GovernedRemediationReceipt;
      nextReconciliation: GovernedRemediationReconciliation;
    }
  | {
      kind: "reconciliation_resume_receipts";
      resumeReceipt: GovernedRemediationReceipt;
      reconciliationReceipt: GovernedRemediationReceipt;
      nextReconciliation: GovernedRemediationReconciliation;
    };

export interface GovernedRemediationClaimedPhasePublicationResult {
  claim: GovernedRemediationPhaseClaim;
  state: GovernedRemediationStoredState | null;
  reconciliation: GovernedRemediationReconciliation | null;
  replayed: boolean;
}

interface StateRow {
  schema_version: typeof GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION;
  remediation_id: string;
  owner_id: string;
  workspace_id: string;
  session_id: string;
  source_turn_id: string;
  durable_run_id: string;
  blocked_checkpoint_id: string;
  requester_actor_id: string;
  recipe_id: string;
  recipe_version: number | string;
  recipe_sha256: string;
  deployment_id: string;
  scope_kind: GovernedRemediationScope["scopeKind"];
  scope_id: string;
  target_id: string;
  state: GovernedRemediationState;
  revision: number | string;
  expected_waiting_run_version: number | string;
  expected_owner_revision: string | null;
  parent_reservation_id: string | null;
  prompt_id: string | null;
  prompt_expires_at: string | null;
  pre_effect_approval_id: string | null;
  activation_approval_id: string | null;
  effect_id: string | null;
  latest_receipt_id: string | null;
  failure_id: string | null;
  reconciliation_id: string | null;
  create_idempotency_key: string;
  create_request_sha256: string;
  last_transition_idempotency_key: string | null;
  last_transition_request_sha256: string | null;
  created_at: string;
  updated_at: string;
}

interface ReceiptRow {
  schema_version: typeof GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION;
  receipt_id: string;
  remediation_id: string;
  recipe_id: string;
  recipe_version: number | string;
  deployment_id: string;
  scope_kind: GovernedRemediationScope["scopeKind"];
  scope_id: string;
  target_id: string;
  kind: GovernedRemediationReceiptKind;
  application_owner_id: string | null;
  effect_id: string | null;
  owner_revision_before: string | null;
  owner_revision_after: string | null;
  application_receipt_id: string | null;
  activation_receipt_id: string | null;
  probe_id: string | null;
  probe_result: "accepted" | null;
  owner_revision_observed: string | null;
  rollback_strategy: "restore_previous" | "remove_candidate" | "transactional" | "safe_stop" | null;
  rollback_outcome: "rolled_back" | null;
  verification_receipt_id: string | null;
  durable_run_id: string | null;
  blocked_checkpoint_id: string | null;
  resumed_run_version: number | string | null;
  reconciliation_id: string | null;
  failure_id: string | null;
  resolution:
    | "confirmed_no_effect"
    | "confirmed_rolled_back"
    | "confirmed_verified"
    | "confirmed_resumed"
    | "confirmed_not_resumed"
    | null;
  resume_receipt_id: string | null;
  idempotency_key: string;
  request_sha256: string;
  recorded_at: string;
}

interface FailureRow {
  schema_version: typeof GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION;
  failure_id: string;
  remediation_id: string;
  recipe_id: string;
  recipe_version: number | string;
  deployment_id: string;
  scope_kind: GovernedRemediationScope["scopeKind"];
  scope_id: string;
  target_id: string;
  phase: GovernedRemediationFailure["phase"];
  reason: GovernedRemediationFailure["reason"];
  effect_boundary: GovernedRemediationFailure["effectBoundary"];
  disposition: GovernedRemediationFailure["disposition"];
  owner_revision_observed: string | null;
  idempotency_key: string;
  request_sha256: string;
  occurred_at: string;
}

interface ReconciliationRow {
  schema_version: typeof GOVERNED_REMEDIATION_RECONCILIATION_SCHEMA_VERSION;
  reconciliation_id: string;
  remediation_id: string;
  failure_id: string;
  recipe_id: string;
  recipe_version: number | string;
  deployment_id: string;
  scope_kind: GovernedRemediationScope["scopeKind"];
  scope_id: string;
  target_id: string;
  domain: GovernedRemediationReconciliation["domain"];
  reason: GovernedRemediationReconciliation["reason"];
  observation: GovernedRemediationReconciliation["observation"];
  state: GovernedRemediationReconciliation["state"];
  owner_revision_observed: string | null;
  resolution_receipt_id: string | null;
  revision: number | string;
  create_idempotency_key: string;
  create_request_sha256: string;
  last_transition_idempotency_key: string | null;
  last_transition_request_sha256: string | null;
  created_at: string;
  updated_at: string;
}

interface CasTransitionRow {
  aggregate_kind: "state" | "reconciliation";
  aggregate_id: string;
  idempotency_key: string;
  request_sha256: string;
  expected_revision: number | string;
  resulting_revision: number | string;
  from_state: string;
  to_state: string;
  recorded_at: string;
}

interface PhaseClaimRow {
  schema_version: typeof GOVERNED_REMEDIATION_PHASE_CLAIM_SCHEMA_VERSION;
  claim_id: string;
  aggregate_kind: GovernedRemediationPhaseClaimAggregateKind;
  aggregate_id: string;
  remediation_id: string;
  phase: GovernedRemediationPhase;
  claim_revision: number | string;
  claimant_id: string;
  expected_aggregate_revision: number | string;
  operation_id: string;
  effect_id: string | null;
  expected_owner_revision: string | null;
  lease_token_sha256: string;
  lease_expires_at: string;
  status: GovernedRemediationPhaseClaim["status"];
  request_sha256: string;
  outcome_sha256: string | null;
  outcome_idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

interface PhaseClaimAcquisitionRow {
  acquisition_idempotency_key: string;
  request_sha256: string;
  claim_id: string | null;
  observed_claim_revision: number | string | null;
  disposition: Exclude<GovernedRemediationPhaseClaimAcquireDisposition, "replayed">;
  recorded_at: string;
}

/**
 * Durable storage owner for the generic governed-remediation contracts.
 *
 * The repository accepts only normalized contract records plus bounded
 * idempotency keys. It cannot persist commands, arbitrary payloads, provider
 * errors, credential values, or OAuth material because no such columns or API
 * inputs exist.
 */
export class GovernedRemediationRepository {
  private claimedPublicationDepth = 0;

  public constructor(private readonly db: DatabaseClient) {}

  public acquirePhaseClaim(
    rawInput: GovernedRemediationPhaseClaimAcquireInput,
  ): GovernedRemediationPhaseClaimAcquireResult {
    const input = normalizePhaseClaimAcquireInput(rawInput);
    const stableRequestSha256 = digestRecord(phaseClaimStableRequest(input));
    const acquisitionRequestSha256 = digestRecord(input);

    return this.db.transaction("immediate", () => {
      this.acquireLock("phase-claim", `${input.aggregateKind}:${input.aggregateId}:${input.phase}`);
      const priorAttempt = this.findPhaseClaimAcquisition(input.acquisitionIdempotencyKey);
      if (priorAttempt) {
        assertExactHash(priorAttempt.request_sha256, acquisitionRequestSha256, "phase claim acquisition");
        return this.resolveRecordedPhaseClaimAcquisition(priorAttempt);
      }

      const matching = this.findPhaseClaimForOperation(input);
      if (matching) assertPhaseClaimStableBindings(matching, input, stableRequestSha256);
      const active = this.findActivePhaseClaim(
        input.aggregateKind,
        input.aggregateId,
        input.phase,
        input.expectedAggregateRevision,
      );
      const aggregateRevision = this.readAggregateRevision(input.aggregateKind, input.aggregateId, input.remediationId);
      if (aggregateRevision !== input.expectedAggregateRevision) {
        const observed = matching ?? active;
        this.recordPhaseClaimAcquisition(input, acquisitionRequestSha256, "stale", observed);
        return { disposition: "stale", claim: observed ? mapPhaseClaimRow(observed) : null };
      }
      this.assertClaimAggregatePhase(input.aggregateKind, input.aggregateId, input.phase, input.effectId);

      const now = this.databaseNow();
      if (matching?.status === "completed") {
        this.recordPhaseClaimAcquisition(input, acquisitionRequestSha256, "completed", matching, now);
        return { disposition: "completed", claim: mapPhaseClaimRow(matching) };
      }
      if (active && Date.parse(active.lease_expires_at) > Date.parse(now)) {
        this.recordPhaseClaimAcquisition(input, acquisitionRequestSha256, "busy", active, now);
        return { disposition: "busy", claim: mapPhaseClaimRow(active) };
      }

      const leaseExpiresAt = new Date(Date.parse(now) + input.leaseDurationSeconds * 1_000).toISOString();
      if (active) {
        assertPhaseClaimStableBindings(active, input, stableRequestSha256);
        const takeover = this.db
          .prepare(
            `UPDATE governed_remediation_phase_claims
             SET claim_revision = @claimRevision, claimant_id = @claimantId,
                 lease_token_sha256 = @leaseTokenSha256, lease_expires_at = @leaseExpiresAt,
                 status = 'active', outcome_sha256 = NULL, outcome_idempotency_key = NULL, updated_at = @updatedAt
             WHERE claim_id = @claimId AND claim_revision = @expectedClaimRevision
               AND status = 'active' AND lease_expires_at <= @updatedAt`,
          )
          .run({
            claimId: active.claim_id,
            expectedClaimRevision: asPositiveInteger(active.claim_revision),
            claimRevision: asPositiveInteger(active.claim_revision) + 1,
            claimantId: input.claimantId,
            leaseTokenSha256: input.leaseTokenSha256,
            leaseExpiresAt,
            updatedAt: now,
          });
        if (Number(takeover.changes ?? 0) !== 1) throw conflict("phase claim takeover");
      } else {
        this.db
          .prepare(
            `INSERT INTO governed_remediation_phase_claims (
              schema_version, claim_id, aggregate_kind, aggregate_id, remediation_id, phase, claim_revision,
              claimant_id, expected_aggregate_revision, operation_id, effect_id, expected_owner_revision,
              lease_token_sha256, lease_expires_at, status, request_sha256, outcome_sha256,
              outcome_idempotency_key, created_at, updated_at
            ) VALUES (
              @schemaVersion, @claimId, @aggregateKind, @aggregateId, @remediationId, @phase, 1,
              @claimantId, @expectedAggregateRevision, @operationId, @effectId, @expectedOwnerRevision,
              @leaseTokenSha256, @leaseExpiresAt, 'active', @requestSha256, NULL, NULL, @createdAt, @updatedAt
            )`,
          )
          .run({
            schemaVersion: GOVERNED_REMEDIATION_PHASE_CLAIM_SCHEMA_VERSION,
            claimId: input.claimId,
            aggregateKind: input.aggregateKind,
            aggregateId: input.aggregateId,
            remediationId: input.remediationId,
            phase: input.phase,
            claimantId: input.claimantId,
            expectedAggregateRevision: input.expectedAggregateRevision,
            operationId: input.operationId,
            effectId: input.effectId,
            expectedOwnerRevision: input.expectedOwnerRevision,
            leaseTokenSha256: input.leaseTokenSha256,
            requestSha256: stableRequestSha256,
            leaseExpiresAt,
            createdAt: now,
            updatedAt: now,
          });
      }
      const acquired = this.findPhaseClaimById(active?.claim_id ?? input.claimId);
      if (!acquired) throw invalidState("phase claim acquisition was not persisted");
      this.recordPhaseClaimAcquisition(input, acquisitionRequestSha256, "acquired", acquired, now);
      return { disposition: "acquired", claim: mapPhaseClaimRow(acquired) };
    });
  }

  public publishClaimedPhaseOutcome(input: {
    claim: GovernedRemediationPhaseClaimWitness;
    expectedAggregateRevision: number;
    outcome: GovernedRemediationClaimedPhaseOutcome;
    publicationIdempotencyKey: string;
  }): GovernedRemediationClaimedPhasePublicationResult {
    const witness = normalizePhaseClaimWitness(input.claim);
    const expectedAggregateRevision = positiveInteger(input.expectedAggregateRevision, "expectedAggregateRevision");
    const publicationIdempotencyKey = identifier(input.publicationIdempotencyKey, "publicationIdempotencyKey", 512);
    const outcome = normalizeClaimedPhaseOutcome(input.outcome);
    const outcomeSha256 = digestRecord(outcome);
    const leaseTokenSha256 = digestLeaseToken(witness.leaseToken);

    return this.db.transaction("immediate", () => {
      const observedClaim = this.findPhaseClaimById(witness.claimId);
      if (!observedClaim) throw new NotFoundError({ entity: "governed remediation phase claim", id: witness.claimId });
      this.acquireLock(
        "phase-claim",
        `${observedClaim.aggregate_kind}:${observedClaim.aggregate_id}:${observedClaim.phase}`,
      );
      const claimRow = this.findPhaseClaimById(witness.claimId);
      if (!claimRow) throw new NotFoundError({ entity: "governed remediation phase claim", id: witness.claimId });
      assertClaimWitness(claimRow, witness, expectedAggregateRevision, leaseTokenSha256);
      const latest = this.findActivePhaseClaim(
        claimRow.aggregate_kind,
        claimRow.aggregate_id,
        claimRow.phase,
        asPositiveInteger(claimRow.expected_aggregate_revision),
      );
      if (claimRow.status === "completed") {
        assertExactHash(claimRow.outcome_sha256 ?? "", outcomeSha256, "phase claim outcome replay");
        if (claimRow.outcome_idempotency_key !== publicationIdempotencyKey) {
          throw conflict("phase claim outcome idempotency");
        }
        return this.claimedPublicationResult(claimRow, true);
      }
      if (
        !latest ||
        latest.claim_id !== claimRow.claim_id ||
        asPositiveInteger(latest.claim_revision) !== asPositiveInteger(claimRow.claim_revision)
      ) {
        throw conflict("phase claim latest generation");
      }
      if (Date.parse(claimRow.lease_expires_at) <= Date.parse(this.databaseNow())) {
        throw conflict("phase claim lease expiry");
      }
      assertClaimedOutcomePhase(claimRow, outcome);
      this.assertClaimAggregatePhase(
        claimRow.aggregate_kind,
        claimRow.aggregate_id,
        claimRow.phase,
        claimRow.effect_id,
      );
      this.assertClaimedOutcomeBindings(claimRow, outcome);
      if (
        this.readAggregateRevision(claimRow.aggregate_kind, claimRow.aggregate_id, claimRow.remediation_id) !==
        expectedAggregateRevision
      ) {
        throw conflict("claimed phase aggregate revision");
      }

      this.claimedPublicationDepth += 1;
      try {
        this.applyClaimedOutcome(claimRow, outcome, publicationIdempotencyKey, outcomeSha256);
      } finally {
        this.claimedPublicationDepth -= 1;
      }

      const completedAt = this.databaseNow();
      if (Date.parse(claimRow.lease_expires_at) <= Date.parse(completedAt)) {
        throw conflict("phase claim lease expiry");
      }
      const databaseLeaseFence =
        this.db.dialect === "postgres"
          ? "gc_try_parse_timestamptz(lease_expires_at) > clock_timestamp()"
          : "lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
      const changes = this.db
        .prepare(
          `UPDATE governed_remediation_phase_claims
           SET status = 'completed', outcome_sha256 = @outcomeSha256,
               outcome_idempotency_key = @publicationIdempotencyKey, updated_at = @updatedAt
           WHERE claim_id = @claimId AND claim_revision = @claimRevision AND claimant_id = @claimantId
             AND lease_token_sha256 = @leaseTokenSha256 AND status = 'active'
             AND ${databaseLeaseFence}`,
        )
        .run({
          claimId: claimRow.claim_id,
          claimRevision: asPositiveInteger(claimRow.claim_revision),
          claimantId: witness.claimantId,
          leaseTokenSha256,
          outcomeSha256,
          publicationIdempotencyKey,
          updatedAt: completedAt,
        });
      if (Number(changes.changes ?? 0) !== 1) throw conflict("phase claim outcome settlement");
      const completed = this.findPhaseClaimById(claimRow.claim_id);
      if (!completed) throw invalidState("completed phase claim is missing");
      return this.claimedPublicationResult(completed, false);
    });
  }

  public createState(input: {
    ownerId: string;
    record: GovernedRemediationStateRecord;
    idempotencyKey: string;
  }): GovernedRemediationStoredState {
    const ownerId = identifier(input.ownerId, "ownerId");
    const record = normalizeGovernedRemediationStateRecord(input.record);
    const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey", 512);
    if (
      record.revision !== 1 ||
      record.state !== "blocked" ||
      record.parentReservationId !== null ||
      record.promptId !== null ||
      record.promptExpiresAt !== null ||
      record.preEffectApprovalId !== null ||
      record.activationApprovalId !== null ||
      record.effectId !== null ||
      record.latestReceiptId !== null ||
      record.failureId !== null ||
      record.reconciliationId !== null
    ) {
      throw conflict("new remediation state authority");
    }
    const requestSha256 = digestRecord({ ownerId, record });

    return this.db.transaction("immediate", () => {
      this.acquireLock("state-create", record.remediationId);
      const existing = this.findStateRowByCreateIdempotency(idempotencyKey) ?? this.findStateRow(record.remediationId);
      if (existing) {
        assertExactHash(existing.create_request_sha256, requestSha256, "remediation state create");
        const stored = mapStateRow(existing);
        assertStoredStateExact(stored, { ownerId, record });
        return stored;
      }
      const scope = scopeBindings(record.scope);
      try {
        this.db
          .prepare(
            `INSERT INTO governed_remediation_states (
              schema_version, remediation_id, owner_id, workspace_id, session_id, source_turn_id, durable_run_id,
              blocked_checkpoint_id, requester_actor_id, recipe_id, recipe_version, recipe_sha256, deployment_id,
              scope_kind, scope_id, target_id, state, revision, expected_waiting_run_version,
              expected_owner_revision, parent_reservation_id, prompt_id, prompt_expires_at,
              pre_effect_approval_id, activation_approval_id, effect_id, latest_receipt_id, failure_id,
              reconciliation_id, create_idempotency_key,
              create_request_sha256, last_transition_idempotency_key, last_transition_request_sha256,
              created_at, updated_at
            ) VALUES (
              @schemaVersion, @remediationId, @ownerId, @workspaceId, @sessionId, @sourceTurnId, @durableRunId,
              @blockedCheckpointId, @requesterActorId, @recipeId, @recipeVersion, @recipeSha256, @deploymentId,
              @scopeKind, @scopeId, @targetId, @state, @revision, @expectedWaitingRunVersion,
              @expectedOwnerRevision, @parentReservationId, @promptId, @promptExpiresAt,
              @preEffectApprovalId, @activationApprovalId, @effectId, @latestReceiptId, @failureId,
              @reconciliationId, @idempotencyKey,
              @requestSha256, NULL, NULL, @createdAt, @updatedAt
            ) ON CONFLICT DO NOTHING`,
          )
          .run({
            schemaVersion: record.schemaVersion,
            remediationId: record.remediationId,
            ownerId,
            workspaceId: record.workspaceId,
            sessionId: record.sessionId,
            sourceTurnId: record.sourceTurnId,
            durableRunId: record.durableRunId,
            blockedCheckpointId: record.blockedCheckpointId,
            requesterActorId: record.requesterActorId,
            recipeId: record.recipeId,
            recipeVersion: record.recipeVersion,
            recipeSha256: record.recipeSha256,
            ...scope,
            state: record.state,
            revision: record.revision,
            expectedWaitingRunVersion: record.expectedWaitingRunVersion,
            expectedOwnerRevision: record.expectedOwnerRevision,
            parentReservationId: record.parentReservationId,
            promptId: record.promptId,
            promptExpiresAt: record.promptExpiresAt,
            preEffectApprovalId: record.preEffectApprovalId,
            activationApprovalId: record.activationApprovalId,
            effectId: record.effectId,
            latestReceiptId: record.latestReceiptId,
            failureId: record.failureId,
            reconciliationId: record.reconciliationId,
            idempotencyKey,
            requestSha256,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          });
      } catch (error) {
        throw normalizeWriteError(error, "remediation state create");
      }
      const storedRow = this.findStateRowByCreateIdempotency(idempotencyKey) ?? this.findStateRow(record.remediationId);
      if (!storedRow) throw invalidState("remediation state create was not persisted");
      assertExactHash(storedRow.create_request_sha256, requestSha256, "remediation state create");
      const stored = mapStateRow(storedRow);
      assertStoredStateExact(stored, { ownerId, record });
      return stored;
    });
  }

  public getState(remediationId: string): GovernedRemediationStoredState {
    const normalizedId = identifier(remediationId, "remediationId");
    const row = this.findStateRow(normalizedId);
    if (!row) throw new NotFoundError({ entity: "governed remediation state", id: normalizedId });
    return mapStateRow(row);
  }

  public findScopedState(input: {
    remediationId: string;
    ownerId: string;
    scope: GovernedRemediationScope;
  }): GovernedRemediationStoredState | undefined {
    const remediationId = identifier(input.remediationId, "remediationId");
    const ownerId = identifier(input.ownerId, "ownerId");
    const scope = normalizeGovernedRemediationScope(input.scope);
    const row = this.db
      .prepare(
        `SELECT * FROM governed_remediation_states
         WHERE remediation_id = @remediationId AND owner_id = @ownerId
           AND deployment_id = @deploymentId AND scope_kind = @scopeKind
           AND scope_id = @scopeId AND target_id = @targetId`,
      )
      .get({ remediationId, ownerId, ...scopeBindings(scope) }) as StateRow | undefined;
    return row ? mapStateRow(row) : undefined;
  }

  public findLatestStateByOwnerScope(input: {
    ownerId: string;
    scope: GovernedRemediationScope;
  }): GovernedRemediationStoredState | undefined {
    const ownerId = identifier(input.ownerId, "ownerId");
    const scope = normalizeGovernedRemediationScope(input.scope);
    const row = this.db
      .prepare(
        `SELECT * FROM governed_remediation_states
         WHERE owner_id = @ownerId AND deployment_id = @deploymentId AND scope_kind = @scopeKind
           AND scope_id = @scopeId AND target_id = @targetId
         ORDER BY updated_at DESC, remediation_id DESC LIMIT 1`,
      )
      .get({ ownerId, ...scopeBindings(scope) }) as StateRow | undefined;
    return row ? mapStateRow(row) : undefined;
  }

  public listStateRecoveryCandidates(
    query: GovernedRemediationStateRecoveryQuery = {},
  ): GovernedRemediationStoredState[] {
    const updatedBefore = optionalTimestamp(query.updatedBefore, "updatedBefore");
    const states = normalizeRecoveryStates(query.states);
    const after = normalizeStateRecoveryCursor(query.after);
    const stateSql = states.map((state) => `'${state}'`).join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM governed_remediation_states
         WHERE state IN (${stateSql})
           AND (@updatedBefore IS NULL OR updated_at <= @updatedBefore)
           AND (
             @afterUpdatedAt IS NULL OR updated_at > @afterUpdatedAt
             OR (updated_at = @afterUpdatedAt AND remediation_id > @afterRemediationId)
           )
         ORDER BY updated_at ASC, remediation_id ASC
         LIMIT @limit`,
      )
      .all({
        updatedBefore,
        afterUpdatedAt: after?.updatedAt ?? null,
        afterRemediationId: after?.remediationId ?? null,
        limit: boundedLimit(query.limit),
      }) as StateRow[];
    return rows.map(mapStateRow);
  }

  public transitionState(input: {
    ownerId: string;
    expectedRevision: number;
    next: GovernedRemediationStateRecord;
    idempotencyKey: string;
    recordedAt: string;
  }): GovernedRemediationCasResult<GovernedRemediationStoredState> {
    const ownerId = identifier(input.ownerId, "ownerId");
    const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
    const next = normalizeGovernedRemediationStateRecord(input.next);
    const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey", 512);
    const recordedAt = timestamp(input.recordedAt, "recordedAt");
    const requestSha256 = digestRecord({ ownerId, next });

    return this.db.transaction("immediate", () => {
      this.acquireLock("state", next.remediationId);
      const replay = this.findCasTransition("state", idempotencyKey);
      if (replay) {
        assertCasReplay(replay, {
          aggregateId: next.remediationId,
          expectedRevision,
          resultingRevision: next.revision,
          toState: next.state,
          requestSha256,
        });
        return {
          record: this.getState(next.remediationId),
          appliedRevision: asPositiveInteger(replay.resulting_revision),
          replayed: true,
        };
      }
      const currentRow = this.findStateRow(next.remediationId);
      if (!currentRow) throw new NotFoundError({ entity: "governed remediation state", id: next.remediationId });
      const current = mapStateRow(currentRow);
      if (
        this.claimedPublicationDepth === 0 &&
        ((current.record.parentReservationId === null && next.parentReservationId !== null) ||
          (current.record.effectId === null && next.effectId !== null))
      ) {
        throw conflict("claimed parent reservation publication fence");
      }
      if (phaseOwnedTransition(current.record.state, next.state) && this.claimedPublicationDepth === 0) {
        throw conflict("claimed phase state publication fence");
      }
      if (current.ownerId !== ownerId) throw conflict("remediation owner scope");
      if (current.record.revision !== expectedRevision || next.revision !== expectedRevision + 1) {
        throw conflict("remediation state revision");
      }
      assertStateImmutableBindings(current.record, next);
      if (!governedRemediationStateCanTransition(current.record.state, next.state)) {
        throw conflict("remediation state transition");
      }
      assertStateTerminalLineage(this, next);
      if (Date.parse(next.updatedAt) < Date.parse(current.record.updatedAt)) {
        throw conflict("remediation state clock");
      }
      this.insertCasTransition({
        aggregateKind: "state",
        aggregateId: next.remediationId,
        idempotencyKey,
        requestSha256,
        expectedRevision,
        resultingRevision: next.revision,
        fromState: current.record.state,
        toState: next.state,
        recordedAt,
      });
      const changes = this.updateState(next, idempotencyKey, requestSha256, expectedRevision);
      if (changes !== 1) throw conflict("remediation state CAS");
      return { record: this.getState(next.remediationId), appliedRevision: next.revision, replayed: false };
    });
  }

  public appendReceipt(input: {
    receipt: GovernedRemediationReceipt;
    idempotencyKey: string;
  }): GovernedRemediationReceipt {
    const receipt = normalizeGovernedRemediationReceipt(input.receipt);
    const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey", 512);
    const requestSha256 = digestRecord(receipt);
    if (this.claimedPublicationDepth === 0) throw conflict("claimed phase receipt publication fence");
    return this.db.transaction("immediate", () => {
      this.acquireLock("state", receipt.remediationId);
      const state = this.getState(receipt.remediationId);
      assertChildBinding(state, receipt);
      if (receipt.kind === "application" && receipt.ownerId !== state.ownerId) {
        throw conflict("application receipt owner");
      }
      this.assertReceiptLineage(state, receipt);
      const existing = this.findReceiptRowByIdempotency(idempotencyKey) ?? this.findReceiptRow(receipt.receiptId);
      if (existing) {
        assertExactHash(existing.request_sha256, requestSha256, "remediation receipt");
        const stored = mapReceiptRow(existing);
        assertExactRecord(stored, receipt, "remediation receipt");
        return stored;
      }
      try {
        this.db.prepare(receiptInsertSql).run(receiptBindings(receipt, idempotencyKey, requestSha256));
      } catch (error) {
        throw normalizeWriteError(error, "remediation receipt");
      }
      const storedRow = this.findReceiptRowByIdempotency(idempotencyKey) ?? this.findReceiptRow(receipt.receiptId);
      if (!storedRow) throw invalidState("remediation receipt was not persisted");
      assertExactHash(storedRow.request_sha256, requestSha256, "remediation receipt");
      const stored = mapReceiptRow(storedRow);
      assertExactRecord(stored, receipt, "remediation receipt");
      return stored;
    });
  }

  public getReceipt(receiptId: string): GovernedRemediationReceipt {
    const normalizedId = identifier(receiptId, "receiptId");
    const row = this.findReceiptRow(normalizedId);
    if (!row) throw new NotFoundError({ entity: "governed remediation receipt", id: normalizedId });
    return mapReceiptRow(row);
  }

  public listReceipts(remediationId: string, limit = 200): GovernedRemediationReceipt[] {
    const normalizedId = identifier(remediationId, "remediationId");
    const rows = this.db
      .prepare(
        `SELECT * FROM governed_remediation_receipts
         WHERE remediation_id = @remediationId
         ORDER BY recorded_at ASC, receipt_id ASC LIMIT @limit`,
      )
      .all({ remediationId: normalizedId, limit: boundedLimit(limit, 500) }) as ReceiptRow[];
    return rows.map(mapReceiptRow);
  }

  public appendFailure(input: {
    failure: GovernedRemediationFailure;
    idempotencyKey: string;
  }): GovernedRemediationFailure {
    const failure = normalizeGovernedRemediationFailure(input.failure);
    const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey", 512);
    const requestSha256 = digestRecord(failure);
    if (phaseOwnedFailure(failure) && this.claimedPublicationDepth === 0) {
      throw conflict("claimed phase failure publication fence");
    }
    return this.db.transaction("immediate", () => {
      this.acquireLock("state", failure.remediationId);
      assertChildBinding(this.getState(failure.remediationId), failure);
      const existing = this.findFailureRowByIdempotency(idempotencyKey) ?? this.findFailureRow(failure.failureId);
      if (existing) {
        assertExactHash(existing.request_sha256, requestSha256, "remediation failure");
        const stored = mapFailureRow(existing);
        assertExactRecord(stored, failure, "remediation failure");
        return stored;
      }
      try {
        this.db
          .prepare(
            `INSERT INTO governed_remediation_failures (
              schema_version, failure_id, remediation_id, recipe_id, recipe_version, deployment_id, scope_kind,
              scope_id, target_id, phase, reason, effect_boundary, disposition, owner_revision_observed,
              idempotency_key, request_sha256, occurred_at
            ) VALUES (
              @schemaVersion, @failureId, @remediationId, @recipeId, @recipeVersion, @deploymentId, @scopeKind,
              @scopeId, @targetId, @phase, @reason, @effectBoundary, @disposition, @ownerRevisionObserved,
              @idempotencyKey, @requestSha256, @occurredAt
            ) ON CONFLICT DO NOTHING`,
          )
          .run({
            schemaVersion: failure.schemaVersion,
            failureId: failure.failureId,
            remediationId: failure.remediationId,
            recipeId: failure.recipeId,
            recipeVersion: failure.recipeVersion,
            ...scopeBindings(failure.scope),
            phase: failure.phase,
            reason: failure.reason,
            effectBoundary: failure.effectBoundary,
            disposition: failure.disposition,
            ownerRevisionObserved: failure.ownerRevisionObserved,
            idempotencyKey,
            requestSha256,
            occurredAt: failure.occurredAt,
          });
      } catch (error) {
        throw normalizeWriteError(error, "remediation failure");
      }
      const storedRow = this.findFailureRowByIdempotency(idempotencyKey) ?? this.findFailureRow(failure.failureId);
      if (!storedRow) throw invalidState("remediation failure was not persisted");
      assertExactHash(storedRow.request_sha256, requestSha256, "remediation failure");
      const stored = mapFailureRow(storedRow);
      assertExactRecord(stored, failure, "remediation failure");
      return stored;
    });
  }

  public getFailure(failureId: string): GovernedRemediationFailure {
    const normalizedId = identifier(failureId, "failureId");
    const row = this.findFailureRow(normalizedId);
    if (!row) throw new NotFoundError({ entity: "governed remediation failure", id: normalizedId });
    return mapFailureRow(row);
  }

  public listFailures(remediationId: string, limit = 200): GovernedRemediationFailure[] {
    const normalizedId = identifier(remediationId, "remediationId");
    const rows = this.db
      .prepare(
        `SELECT * FROM governed_remediation_failures
         WHERE remediation_id = @remediationId
         ORDER BY occurred_at ASC, failure_id ASC LIMIT @limit`,
      )
      .all({ remediationId: normalizedId, limit: boundedLimit(limit, 500) }) as FailureRow[];
    return rows.map(mapFailureRow);
  }

  public createReconciliation(input: {
    reconciliation: GovernedRemediationReconciliation;
    idempotencyKey: string;
  }): GovernedRemediationReconciliation {
    const reconciliation = normalizeGovernedRemediationReconciliation(input.reconciliation);
    const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey", 512);
    if (reconciliation.revision !== 1) throw conflict("new reconciliation revision");
    if (this.claimedPublicationDepth === 0) throw conflict("claimed phase reconciliation publication fence");
    const requestSha256 = digestRecord(reconciliation);
    return this.db.transaction("immediate", () => {
      this.acquireLock("state", reconciliation.remediationId);
      const state = this.getState(reconciliation.remediationId);
      assertChildBinding(state, reconciliation);
      const failure = this.getFailure(reconciliation.failureId);
      assertExactRecord(failure.scope, reconciliation.scope, "reconciliation failure scope");
      if (failure.remediationId !== reconciliation.remediationId) throw conflict("reconciliation failure owner");
      const existing =
        this.findReconciliationRowByCreateIdempotency(idempotencyKey) ??
        this.findReconciliationRow(reconciliation.reconciliationId);
      if (existing) {
        assertExactHash(existing.create_request_sha256, requestSha256, "remediation reconciliation create");
        const stored = mapReconciliationRow(existing);
        assertExactRecord(stored, reconciliation, "remediation reconciliation create");
        return stored;
      }
      try {
        this.db
          .prepare(
            `INSERT INTO governed_remediation_reconciliations (
              schema_version, reconciliation_id, remediation_id, failure_id, recipe_id, recipe_version,
              deployment_id, scope_kind, scope_id, target_id, domain, reason, observation, state,
              owner_revision_observed, resolution_receipt_id, revision, create_idempotency_key,
              create_request_sha256, last_transition_idempotency_key, last_transition_request_sha256,
              created_at, updated_at
            ) VALUES (
              @schemaVersion, @reconciliationId, @remediationId, @failureId, @recipeId, @recipeVersion,
              @deploymentId, @scopeKind, @scopeId, @targetId, @domain, @reason, @observation, @state,
              @ownerRevisionObserved, @resolutionReceiptId, @revision, @idempotencyKey,
              @requestSha256, NULL, NULL, @createdAt, @updatedAt
            ) ON CONFLICT DO NOTHING`,
          )
          .run({
            schemaVersion: reconciliation.schemaVersion,
            reconciliationId: reconciliation.reconciliationId,
            remediationId: reconciliation.remediationId,
            failureId: reconciliation.failureId,
            recipeId: reconciliation.recipeId,
            recipeVersion: reconciliation.recipeVersion,
            ...scopeBindings(reconciliation.scope),
            domain: reconciliation.domain,
            reason: reconciliation.reason,
            observation: reconciliation.observation,
            state: reconciliation.state,
            ownerRevisionObserved: reconciliation.ownerRevisionObserved,
            resolutionReceiptId: reconciliation.resolutionReceiptId,
            revision: reconciliation.revision,
            idempotencyKey,
            requestSha256,
            createdAt: reconciliation.createdAt,
            updatedAt: reconciliation.updatedAt,
          });
      } catch (error) {
        throw normalizeWriteError(error, "remediation reconciliation create");
      }
      const storedRow =
        this.findReconciliationRowByCreateIdempotency(idempotencyKey) ??
        this.findReconciliationRow(reconciliation.reconciliationId);
      if (!storedRow) throw invalidState("remediation reconciliation was not persisted");
      assertExactHash(storedRow.create_request_sha256, requestSha256, "remediation reconciliation create");
      const stored = mapReconciliationRow(storedRow);
      assertExactRecord(stored, reconciliation, "remediation reconciliation create");
      return stored;
    });
  }

  public getReconciliation(reconciliationId: string): GovernedRemediationReconciliation {
    const normalizedId = identifier(reconciliationId, "reconciliationId");
    const row = this.findReconciliationRow(normalizedId);
    if (!row) throw new NotFoundError({ entity: "governed remediation reconciliation", id: normalizedId });
    return mapReconciliationRow(row);
  }

  public findScopedReconciliation(input: {
    reconciliationId: string;
    ownerId: string;
    scope: GovernedRemediationScope;
  }): GovernedRemediationReconciliation | undefined {
    const reconciliationId = identifier(input.reconciliationId, "reconciliationId");
    const ownerId = identifier(input.ownerId, "ownerId");
    const scope = normalizeGovernedRemediationScope(input.scope);
    const row = this.db
      .prepare(
        `SELECT reconciliation.*
         FROM governed_remediation_reconciliations reconciliation
         INNER JOIN governed_remediation_states remediation
           ON remediation.remediation_id = reconciliation.remediation_id
         WHERE reconciliation.reconciliation_id = @reconciliationId
           AND remediation.owner_id = @ownerId
           AND reconciliation.deployment_id = @deploymentId
           AND reconciliation.scope_kind = @scopeKind
           AND reconciliation.scope_id = @scopeId
           AND reconciliation.target_id = @targetId`,
      )
      .get({ reconciliationId, ownerId, ...scopeBindings(scope) }) as ReconciliationRow | undefined;
    return row ? mapReconciliationRow(row) : undefined;
  }

  public listReconciliationRecoveryCandidates(
    query: GovernedRemediationReconciliationRecoveryQuery = {},
  ): GovernedRemediationReconciliation[] {
    const updatedBefore = optionalTimestamp(query.updatedBefore, "updatedBefore");
    const domains = normalizeReconciliationDomains(query.domains);
    const after = normalizeReconciliationRecoveryCursor(query.after);
    const domainSql = domains.map((domain) => `'${domain}'`).join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM governed_remediation_reconciliations
         WHERE state IN ('open', 'quarantined')
           AND domain IN (${domainSql})
           AND (@updatedBefore IS NULL OR updated_at <= @updatedBefore)
           AND (
             @afterUpdatedAt IS NULL OR updated_at > @afterUpdatedAt
             OR (updated_at = @afterUpdatedAt AND reconciliation_id > @afterReconciliationId)
           )
         ORDER BY updated_at ASC, reconciliation_id ASC
         LIMIT @limit`,
      )
      .all({
        updatedBefore,
        afterUpdatedAt: after?.updatedAt ?? null,
        afterReconciliationId: after?.reconciliationId ?? null,
        limit: boundedLimit(query.limit),
      }) as ReconciliationRow[];
    return rows.map(mapReconciliationRow);
  }

  public transitionReconciliation(input: {
    expectedRevision: number;
    next: GovernedRemediationReconciliation;
    idempotencyKey: string;
    recordedAt: string;
  }): GovernedRemediationCasResult<GovernedRemediationReconciliation> {
    const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
    const next = normalizeGovernedRemediationReconciliation(input.next);
    const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey", 512);
    const recordedAt = timestamp(input.recordedAt, "recordedAt");
    const requestSha256 = digestRecord(next);
    if (this.claimedPublicationDepth === 0) throw conflict("claimed phase reconciliation publication fence");
    return this.db.transaction("immediate", () => {
      this.acquireLock("reconciliation", next.reconciliationId);
      const replay = this.findCasTransition("reconciliation", idempotencyKey);
      if (replay) {
        assertCasReplay(replay, {
          aggregateId: next.reconciliationId,
          expectedRevision,
          resultingRevision: next.revision,
          toState: next.state,
          requestSha256,
        });
        return {
          record: this.getReconciliation(next.reconciliationId),
          appliedRevision: asPositiveInteger(replay.resulting_revision),
          replayed: true,
        };
      }
      const current = this.getReconciliation(next.reconciliationId);
      if (current.revision !== expectedRevision || next.revision !== expectedRevision + 1) {
        throw conflict("remediation reconciliation revision");
      }
      assertReconciliationImmutableBindings(current, next);
      if (!governedRemediationReconciliationCanTransition(current.state, next.state)) {
        throw conflict("remediation reconciliation transition");
      }
      assertReconciliationResolutionLineage(this, next);
      if (Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) {
        throw conflict("remediation reconciliation clock");
      }
      this.insertCasTransition({
        aggregateKind: "reconciliation",
        aggregateId: next.reconciliationId,
        idempotencyKey,
        requestSha256,
        expectedRevision,
        resultingRevision: next.revision,
        fromState: current.state,
        toState: next.state,
        recordedAt,
      });
      const changes = this.updateReconciliation(next, idempotencyKey, requestSha256, expectedRevision);
      if (changes !== 1) throw conflict("remediation reconciliation CAS");
      return { record: this.getReconciliation(next.reconciliationId), appliedRevision: next.revision, replayed: false };
    });
  }

  private applyClaimedOutcome(
    claim: PhaseClaimRow,
    outcome: GovernedRemediationClaimedPhaseOutcome,
    publicationIdempotencyKey: string,
    outcomeSha256: string,
  ): void {
    const childKey = (label: string): string =>
      `claimed-${digestRecord({ publicationIdempotencyKey, outcomeSha256, label })}`;
    const state = this.getState(claim.remediation_id);
    if (outcome.kind === "state_transition") {
      this.transitionState({
        ownerId: state.ownerId,
        expectedRevision: asPositiveInteger(claim.expected_aggregate_revision),
        next: outcome.nextState,
        idempotencyKey: childKey("state-transition"),
        recordedAt: outcome.nextState.updatedAt,
      });
      return;
    }
    if (outcome.kind === "state_receipt") {
      this.appendReceipt({ receipt: outcome.receipt, idempotencyKey: childKey("state-receipt") });
      this.transitionState({
        ownerId: state.ownerId,
        expectedRevision: asPositiveInteger(claim.expected_aggregate_revision),
        next: outcome.nextState,
        idempotencyKey: childKey("state-transition"),
        recordedAt: outcome.nextState.updatedAt,
      });
      return;
    }
    if (outcome.kind === "state_activation_receipts") {
      this.appendReceipt({
        receipt: outcome.activationReceipt,
        idempotencyKey: childKey("state-activation-receipt"),
      });
      this.appendReceipt({
        receipt: outcome.verificationReceipt,
        idempotencyKey: childKey("state-activation-verification-receipt"),
      });
      this.transitionState({
        ownerId: state.ownerId,
        expectedRevision: asPositiveInteger(claim.expected_aggregate_revision),
        next: outcome.nextState,
        idempotencyKey: childKey("state-transition"),
        recordedAt: outcome.nextState.updatedAt,
      });
      return;
    }
    if (outcome.kind === "state_activation_failure" || outcome.kind === "state_activation_failure_reconciliation") {
      this.appendReceipt({
        receipt: outcome.activationReceipt,
        idempotencyKey: childKey("state-activation-receipt"),
      });
      this.appendFailure({ failure: outcome.failure, idempotencyKey: childKey("state-failure") });
      if (outcome.kind === "state_activation_failure_reconciliation") {
        this.createReconciliation({
          reconciliation: outcome.reconciliation,
          idempotencyKey: childKey("state-reconciliation"),
        });
      }
      this.transitionState({
        ownerId: state.ownerId,
        expectedRevision: asPositiveInteger(claim.expected_aggregate_revision),
        next: outcome.nextState,
        idempotencyKey: childKey("state-transition"),
        recordedAt: outcome.nextState.updatedAt,
      });
      return;
    }
    if (outcome.kind === "state_failure" || outcome.kind === "state_failure_reconciliation") {
      this.appendFailure({ failure: outcome.failure, idempotencyKey: childKey("state-failure") });
      if (outcome.kind === "state_failure_reconciliation") {
        this.createReconciliation({
          reconciliation: outcome.reconciliation,
          idempotencyKey: childKey("state-reconciliation"),
        });
      }
      this.transitionState({
        ownerId: state.ownerId,
        expectedRevision: asPositiveInteger(claim.expected_aggregate_revision),
        next: outcome.nextState,
        idempotencyKey: childKey("state-transition"),
        recordedAt: outcome.nextState.updatedAt,
      });
      return;
    }
    if (outcome.kind === "failure_only") {
      this.appendFailure({ failure: outcome.failure, idempotencyKey: childKey("state-failure") });
      return;
    }
    if (outcome.kind === "reconciliation_transition") {
      this.transitionReconciliation({
        expectedRevision: asPositiveInteger(claim.expected_aggregate_revision),
        next: outcome.nextReconciliation,
        idempotencyKey: childKey("reconciliation-transition"),
        recordedAt: outcome.nextReconciliation.updatedAt,
      });
      return;
    }
    if (outcome.kind === "reconciliation_receipt") {
      this.appendReceipt({ receipt: outcome.receipt, idempotencyKey: childKey("reconciliation-receipt") });
      this.transitionReconciliation({
        expectedRevision: asPositiveInteger(claim.expected_aggregate_revision),
        next: outcome.nextReconciliation,
        idempotencyKey: childKey("reconciliation-transition"),
        recordedAt: outcome.nextReconciliation.updatedAt,
      });
      return;
    }
    if (outcome.kind === "reconciliation_application_receipts") {
      this.appendReceipt({
        receipt: outcome.applicationReceipt,
        idempotencyKey: childKey("reconciliation-application-receipt"),
      });
      this.appendReceipt({
        receipt: outcome.reconciliationReceipt,
        idempotencyKey: childKey("reconciliation-receipt"),
      });
      this.transitionReconciliation({
        expectedRevision: asPositiveInteger(claim.expected_aggregate_revision),
        next: outcome.nextReconciliation,
        idempotencyKey: childKey("reconciliation-transition"),
        recordedAt: outcome.nextReconciliation.updatedAt,
      });
      return;
    }
    this.appendReceipt({
      receipt: outcome.resumeReceipt,
      idempotencyKey: childKey("reconciliation-resume-receipt"),
    });
    this.appendReceipt({
      receipt: outcome.reconciliationReceipt,
      idempotencyKey: childKey("reconciliation-receipt"),
    });
    this.transitionReconciliation({
      expectedRevision: asPositiveInteger(claim.expected_aggregate_revision),
      next: outcome.nextReconciliation,
      idempotencyKey: childKey("reconciliation-transition"),
      recordedAt: outcome.nextReconciliation.updatedAt,
    });
  }

  private assertClaimedOutcomeBindings(claim: PhaseClaimRow, outcome: GovernedRemediationClaimedPhaseOutcome): void {
    const state = this.getState(claim.remediation_id);
    const expectedRevision = asPositiveInteger(claim.expected_aggregate_revision);
    const claimEffectId = claim.effect_id;
    const claimOwnerRevision = claim.expected_owner_revision;
    if (
      state.record.state === "verified" &&
      (claim.phase === "rollback" || claim.phase === "resume") &&
      outcome.kind !== "state_failure" &&
      outcome.kind !== "state_failure_reconciliation"
    ) {
      throw conflict("verified recovery claim outcome");
    }
    const assertStateNext = (next: GovernedRemediationStateRecord): void => {
      if (claim.aggregate_kind !== "state" || next.remediationId !== claim.aggregate_id) {
        throw conflict("claimed phase state aggregate binding");
      }
      if (next.revision !== expectedRevision + 1) throw conflict("claimed phase state revision binding");
    };
    const assertFailure = (failure: GovernedRemediationFailure): void => {
      assertChildBinding(state, failure);
      assertClaimFailurePhase(claim.phase, failure.phase);
    };
    const assertReconciliationNext = (next: GovernedRemediationReconciliation): void => {
      if (claim.aggregate_kind !== "reconciliation" || next.reconciliationId !== claim.aggregate_id) {
        throw conflict("claimed phase reconciliation aggregate binding");
      }
      if (next.revision !== expectedRevision + 1) throw conflict("claimed phase reconciliation revision binding");
    };
    if (outcome.kind === "state_transition") {
      assertStateNext(outcome.nextState);
      if (
        claim.phase === "parent_reserve" &&
        (outcome.nextState.state !== "applying" ||
          outcome.nextState.parentReservationId === null ||
          outcome.nextState.effectId !== claimEffectId)
      ) {
        throw conflict("claimed parent reservation effect binding");
      }
      if (claim.phase === "resume_reconcile" && outcome.nextState.state !== "failed") {
        throw conflict("claimed resume reconciliation terminal binding");
      }
      return;
    }
    if (outcome.kind === "state_receipt") {
      assertStateNext(outcome.nextState);
      assertChildBinding(state, outcome.receipt);
      if (outcome.nextState.latestReceiptId !== outcome.receipt.receiptId) {
        throw conflict("claimed phase latest receipt binding");
      }
      if (outcome.receipt.kind === "application") {
        if (outcome.nextState.state !== "verifying") {
          throw conflict("claimed application transition");
        }
        if (outcome.receipt.effectId !== claimEffectId || outcome.nextState.effectId !== claimEffectId) {
          throw conflict("claimed application effect binding");
        }
        if (claimOwnerRevision !== null && outcome.receipt.ownerRevisionBefore !== claimOwnerRevision) {
          throw conflict("claimed application owner revision");
        }
      }
      if (
        outcome.receipt.kind === "verification" &&
        (claimOwnerRevision === null ||
          outcome.receipt.ownerRevisionObserved !== claimOwnerRevision ||
          outcome.receipt.activationReceiptId !== null ||
          (outcome.nextState.state !== "credential_verified" && outcome.nextState.state !== "verified"))
      ) {
        throw conflict("claimed verification transition");
      }
      if (outcome.receipt.kind === "rollback" && outcome.receipt.ownerRevisionBefore !== claimOwnerRevision) {
        throw conflict("claimed rollback owner revision");
      }
      if (outcome.receipt.kind === "resume") {
        if (claimOwnerRevision === null) throw conflict("claimed resume owner revision");
        const verification = this.getReceipt(outcome.receipt.verificationReceiptId);
        if (verification.kind !== "verification" || verification.ownerRevisionObserved !== claimOwnerRevision) {
          throw conflict("claimed resume owner revision");
        }
      }
      if (outcome.receipt.kind === "resume" && outcome.nextState.state !== "completed") {
        throw conflict("claimed resume transition");
      }
      return;
    }
    if (outcome.kind === "state_activation_receipts") {
      assertStateNext(outcome.nextState);
      const activation = outcome.activationReceipt;
      const verification = outcome.verificationReceipt;
      assertActivationClaimLineage(this, state, claim, activation);
      if (
        verification.kind !== "verification" ||
        outcome.nextState.state !== "verified" ||
        outcome.nextState.latestReceiptId !== verification.receiptId ||
        activation.applicationReceiptId !== verification.applicationReceiptId ||
        verification.activationReceiptId !== activation.receiptId ||
        activation.ownerRevisionAfter !== verification.ownerRevisionObserved ||
        outcome.nextState.effectId !== claimEffectId
      ) {
        throw conflict("claimed activation receipt lineage");
      }
      return;
    }
    if (outcome.kind === "state_activation_failure" || outcome.kind === "state_activation_failure_reconciliation") {
      assertStateNext(outcome.nextState);
      assertFailure(outcome.failure);
      if (outcome.failure.effectBoundary !== "crossed") {
        throw conflict("claimed activation failure effect boundary");
      }
      assertActivationClaimLineage(this, state, claim, outcome.activationReceipt);
      if (outcome.nextState.failureId !== outcome.failure.failureId) {
        throw conflict("claimed activation failure state binding");
      }
      if (outcome.kind === "state_activation_failure_reconciliation") {
        if (
          outcome.nextState.state !== "failed" ||
          outcome.reconciliation.domain !== "effect" ||
          outcome.reconciliation.failureId !== outcome.failure.failureId ||
          outcome.nextState.reconciliationId !== outcome.reconciliation.reconciliationId
        ) {
          throw conflict("claimed activation failure reconciliation binding");
        }
      } else if (
        outcome.nextState.state !== "rolling_back" ||
        outcome.failure.disposition !== "rollback_required" ||
        outcome.nextState.reconciliationId !== null
      ) {
        throw conflict("claimed activation failure reconciliation absence");
      }
      if (outcome.nextState.latestReceiptId !== outcome.activationReceipt.receiptId) {
        throw conflict("claimed activation failure latest receipt binding");
      }
      return;
    }
    if (outcome.kind === "state_failure") {
      assertFailure(outcome.failure);
      assertStateNext(outcome.nextState);
      if (
        (outcome.nextState.state !== "failed" && outcome.nextState.state !== "rolling_back") ||
        (outcome.nextState.state === "rolling_back" && outcome.failure.disposition !== "rollback_required") ||
        outcome.nextState.failureId !== outcome.failure.failureId ||
        outcome.nextState.reconciliationId !== null
      ) {
        throw conflict("claimed phase failure state binding");
      }
      return;
    }
    if (outcome.kind === "state_failure_reconciliation") {
      assertFailure(outcome.failure);
      assertStateNext(outcome.nextState);
      const expectedFailureState =
        outcome.reconciliation.domain === "resume"
          ? "reconciling_resume"
          : state.record.state === "rolling_back"
            ? "rollback_failed"
            : "failed";
      if (
        outcome.nextState.state !== expectedFailureState ||
        outcome.reconciliation.remediationId !== claim.remediation_id ||
        outcome.reconciliation.failureId !== outcome.failure.failureId ||
        outcome.nextState.failureId !== outcome.failure.failureId ||
        outcome.nextState.reconciliationId !== outcome.reconciliation.reconciliationId
      ) {
        throw conflict("claimed phase reconciliation state binding");
      }
      if (
        (outcome.reconciliation.domain === "effect") !==
        (claim.phase !== "resume" && claim.phase !== "resume_reconcile")
      ) {
        throw conflict("claimed phase reconciliation domain");
      }
      return;
    }
    if (outcome.kind === "failure_only") {
      assertFailure(outcome.failure);
      if (
        outcome.failure.effectBoundary !== "not_crossed" ||
        outcome.failure.disposition !== "retry_with_fresh_authority"
      ) {
        throw conflict("claimed nonterminal apply failure");
      }
      return;
    }
    if (outcome.kind === "reconciliation_transition") {
      assertReconciliationNext(outcome.nextReconciliation);
      return;
    }
    const reconciliationReceipt =
      outcome.kind === "reconciliation_receipt" ? outcome.receipt : outcome.reconciliationReceipt;
    const nextReconciliation = outcome.nextReconciliation;
    assertReconciliationNext(nextReconciliation);
    if (
      reconciliationReceipt.kind !== "reconciliation" ||
      reconciliationReceipt.reconciliationId !== claim.aggregate_id ||
      nextReconciliation.resolutionReceiptId !== reconciliationReceipt.receiptId
    ) {
      throw conflict("claimed reconciliation receipt binding");
    }
    if (outcome.kind === "reconciliation_application_receipts") {
      if (
        outcome.applicationReceipt.kind !== "application" ||
        reconciliationReceipt.applicationReceiptId !== outcome.applicationReceipt.receiptId ||
        reconciliationReceipt.resumeReceiptId !== null ||
        outcome.applicationReceipt.effectId !== claimEffectId ||
        (claimOwnerRevision !== null && outcome.applicationReceipt.ownerRevisionBefore !== claimOwnerRevision)
      ) {
        throw conflict("claimed reconciliation application lineage");
      }
    }
    if (outcome.kind === "reconciliation_resume_receipts") {
      if (
        outcome.resumeReceipt.kind !== "resume" ||
        reconciliationReceipt.resumeReceiptId !== outcome.resumeReceipt.receiptId ||
        reconciliationReceipt.applicationReceiptId !== null
      ) {
        throw conflict("claimed reconciliation resume lineage");
      }
      if (claimOwnerRevision === null) {
        throw conflict("claimed reconciliation resume owner revision");
      } else {
        const verification = this.getReceipt(outcome.resumeReceipt.verificationReceiptId);
        if (verification.kind !== "verification" || verification.ownerRevisionObserved !== claimOwnerRevision) {
          throw conflict("claimed reconciliation resume owner revision");
        }
      }
    }
  }

  private assertReceiptLineage(state: GovernedRemediationStoredState, receipt: GovernedRemediationReceipt): void {
    if (receipt.kind === "application") {
      if (receipt.ownerId !== state.ownerId) throw conflict("application receipt owner");
      return;
    }
    if (receipt.kind === "verification") {
      const application = this.getReceipt(receipt.applicationReceiptId);
      assertReferencedReceipt(state, application, "application", "verification application receipt");
      if (application.kind !== "application" || application.effectId !== state.record.effectId) {
        throw conflict("verification application lineage");
      }
      if (receipt.activationReceiptId === null) {
        if (receipt.ownerRevisionObserved !== application.ownerRevisionAfter) {
          throw conflict("initial verification owner revision lineage");
        }
      } else {
        const activation = this.getReceipt(receipt.activationReceiptId);
        assertReferencedReceipt(state, activation, "activation", "post-activation verification receipt");
        if (
          activation.kind !== "activation" ||
          activation.applicationReceiptId !== receipt.applicationReceiptId ||
          activation.ownerRevisionAfter !== receipt.ownerRevisionObserved
        ) {
          throw conflict("post-activation verification lineage");
        }
      }
      return;
    }
    if (receipt.kind === "activation") {
      const application = this.getReceipt(receipt.applicationReceiptId);
      const verification = this.getReceipt(receipt.initialVerificationReceiptId);
      assertReferencedReceipt(state, application, "application", "activation application receipt");
      assertReferencedReceipt(state, verification, "verification", "activation verification receipt");
      if (
        verification.kind !== "verification" ||
        verification.activationReceiptId !== null ||
        verification.applicationReceiptId !== receipt.applicationReceiptId ||
        verification.ownerRevisionObserved !== receipt.ownerRevisionBefore
      ) {
        throw conflict("activation verification lineage");
      }
      return;
    }
    if (receipt.kind === "rollback") {
      const application = this.getReceipt(receipt.applicationReceiptId);
      assertReferencedReceipt(state, application, "application", "rollback application receipt");
      if (receipt.ownerRevisionBefore !== durableEffectRevision(this, state)) {
        throw conflict("rollback durable effect revision lineage");
      }
      return;
    }
    if (receipt.kind === "resume") {
      const verification = this.getReceipt(receipt.verificationReceiptId);
      assertReferencedReceipt(state, verification, "verification", "resume verification receipt");
      if (
        receipt.durableRunId !== state.record.durableRunId ||
        receipt.blockedCheckpointId !== state.record.blockedCheckpointId ||
        receipt.resumedRunVersion !== state.record.expectedWaitingRunVersion + 1
      ) {
        throw conflict("resume durable-run lineage");
      }
      return;
    }
    const reconciliation = this.getReconciliation(receipt.reconciliationId);
    if (
      reconciliation.remediationId !== state.record.remediationId ||
      reconciliation.failureId !== receipt.failureId ||
      reconciliation.domain !== reconciliationDomainForResolution(receipt.resolution)
    ) {
      throw conflict("reconciliation receipt aggregate lineage");
    }
    const failure = this.getFailure(receipt.failureId);
    assertChildBinding(state, failure);
    if (receipt.applicationReceiptId !== null) {
      assertReferencedReceipt(
        state,
        this.getReceipt(receipt.applicationReceiptId),
        "application",
        "reconciliation application receipt",
      );
    }
    if (receipt.resumeReceiptId !== null) {
      assertReferencedReceipt(
        state,
        this.getReceipt(receipt.resumeReceiptId),
        "resume",
        "reconciliation resume receipt",
      );
    }
  }

  private claimedPublicationResult(
    row: PhaseClaimRow,
    replayed: boolean,
  ): GovernedRemediationClaimedPhasePublicationResult {
    return {
      claim: mapPhaseClaimRow(row),
      state: this.getState(row.remediation_id),
      reconciliation: row.aggregate_kind === "reconciliation" ? this.getReconciliation(row.aggregate_id) : null,
      replayed,
    };
  }

  private databaseNow(): string {
    const row =
      this.db.dialect === "postgres"
        ? this.db
            .prepare(
              `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS database_now`,
            )
            .get<{ database_now: string }>()
        : this.db
            .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS database_now")
            .get<{ database_now: string }>();
    if (!row) throw invalidState("database clock is unavailable");
    return timestamp(String(row.database_now), "database clock");
  }

  private readAggregateRevision(
    aggregateKind: GovernedRemediationPhaseClaimAggregateKind,
    aggregateId: string,
    remediationId: string,
  ): number {
    if (aggregateKind === "state") {
      const row = this.findStateRow(aggregateId);
      if (!row || row.remediation_id !== remediationId) throw conflict("phase claim state aggregate");
      return asPositiveInteger(row.revision);
    }
    const row = this.findReconciliationRow(aggregateId);
    if (!row || row.remediation_id !== remediationId) throw conflict("phase claim reconciliation aggregate");
    return asPositiveInteger(row.revision);
  }

  private assertClaimAggregatePhase(
    aggregateKind: GovernedRemediationPhaseClaimAggregateKind,
    aggregateId: string,
    phase: GovernedRemediationPhase,
    effectId: string | null,
  ): void {
    if (aggregateKind === "state") {
      const state = this.getState(aggregateId).record;
      const allowed: Partial<Record<GovernedRemediationPhase, readonly GovernedRemediationState[]>> = {
        parent_reserve: ["blocked", "offered", "awaiting_preapproval", "awaiting_secure_input"],
        apply: ["applying"],
        verify: ["verifying"],
        activate_and_verify: ["activating"],
        rollback: ["rolling_back", "credential_verified", "awaiting_activation_approval", "verified"],
        resume: ["verified", "resuming"],
        resume_reconcile: ["reconciling_resume"],
      };
      if (!allowed[phase]?.includes(state.state)) throw conflict("phase claim state provenance");
      if (phase !== "parent_reserve" && state.effectId !== effectId) {
        throw conflict("phase claim state effect binding");
      }
      return;
    }
    const reconciliation = this.getReconciliation(aggregateId);
    const expectedDomain = phase === "effect_reconcile" ? "effect" : "resume";
    if (
      reconciliation.domain !== expectedDomain ||
      (reconciliation.state !== "open" && reconciliation.state !== "quarantined")
    ) {
      throw conflict("phase claim reconciliation provenance");
    }
    const state = this.getState(reconciliation.remediationId);
    if (state.record.effectId !== effectId) throw conflict("phase claim reconciliation effect binding");
  }

  private findPhaseClaimById(claimId: string): PhaseClaimRow | undefined {
    return this.db.prepare("SELECT * FROM governed_remediation_phase_claims WHERE claim_id = ?").get(claimId) as
      | PhaseClaimRow
      | undefined;
  }

  private findPhaseClaimForOperation(input: GovernedRemediationPhaseClaimAcquireInput): PhaseClaimRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM governed_remediation_phase_claims
         WHERE aggregate_kind = @aggregateKind AND aggregate_id = @aggregateId AND phase = @phase
           AND expected_aggregate_revision = @expectedAggregateRevision AND operation_id = @operationId
         ORDER BY created_at DESC, claim_id DESC LIMIT 1`,
      )
      .get({
        aggregateKind: input.aggregateKind,
        aggregateId: input.aggregateId,
        phase: input.phase,
        expectedAggregateRevision: input.expectedAggregateRevision,
        operationId: input.operationId,
      }) as PhaseClaimRow | undefined;
  }

  private findActivePhaseClaim(
    aggregateKind: GovernedRemediationPhaseClaimAggregateKind,
    aggregateId: string,
    phase: GovernedRemediationPhase,
    expectedAggregateRevision: number,
  ): PhaseClaimRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM governed_remediation_phase_claims
         WHERE aggregate_kind = @aggregateKind AND aggregate_id = @aggregateId AND phase = @phase
           AND expected_aggregate_revision = @expectedAggregateRevision AND status = 'active'
         ORDER BY created_at DESC, claim_id DESC LIMIT 1`,
      )
      .get({ aggregateKind, aggregateId, phase, expectedAggregateRevision }) as PhaseClaimRow | undefined;
  }

  private findPhaseClaimAcquisition(acquisitionIdempotencyKey: string): PhaseClaimAcquisitionRow | undefined {
    return this.db
      .prepare("SELECT * FROM governed_remediation_phase_claim_acquisitions WHERE acquisition_idempotency_key = ?")
      .get(acquisitionIdempotencyKey) as PhaseClaimAcquisitionRow | undefined;
  }

  private recordPhaseClaimAcquisition(
    input: GovernedRemediationPhaseClaimAcquireInput,
    requestSha256: string,
    disposition: Exclude<GovernedRemediationPhaseClaimAcquireDisposition, "replayed">,
    claim: PhaseClaimRow | undefined,
    recordedAt = this.databaseNow(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO governed_remediation_phase_claim_acquisitions (
          acquisition_idempotency_key, request_sha256, claim_id, observed_claim_revision, disposition, recorded_at
        ) VALUES (
          @acquisitionIdempotencyKey, @requestSha256, @claimId, @observedClaimRevision, @disposition, @recordedAt
        )`,
      )
      .run({
        acquisitionIdempotencyKey: input.acquisitionIdempotencyKey,
        requestSha256,
        claimId: claim?.claim_id ?? null,
        observedClaimRevision: claim ? asPositiveInteger(claim.claim_revision) : null,
        disposition,
        recordedAt,
      });
  }

  private resolveRecordedPhaseClaimAcquisition(
    row: PhaseClaimAcquisitionRow,
  ): GovernedRemediationPhaseClaimAcquireResult {
    const claim = row.claim_id ? this.findPhaseClaimById(row.claim_id) : undefined;
    if (!claim) return { disposition: "stale", claim: null };
    const observedRevision =
      row.observed_claim_revision === null ? null : asPositiveInteger(row.observed_claim_revision);
    const currentRevision = asPositiveInteger(claim.claim_revision);
    if (row.disposition === "acquired" && observedRevision === currentRevision && claim.status === "active") {
      return { disposition: "replayed", claim: mapPhaseClaimRow(claim) };
    }
    if ((row.disposition === "acquired" || row.disposition === "completed") && claim.status === "completed") {
      return { disposition: "completed", claim: mapPhaseClaimRow(claim) };
    }
    if (row.disposition === "busy" && observedRevision === currentRevision && claim.status === "active") {
      return { disposition: "busy", claim: mapPhaseClaimRow(claim) };
    }
    return { disposition: "stale", claim: mapPhaseClaimRow(claim) };
  }

  private updateState(
    next: GovernedRemediationStateRecord,
    idempotencyKey: string,
    requestSha256: string,
    expectedRevision: number,
  ): number {
    const result = this.db
      .prepare(
        `UPDATE governed_remediation_states
         SET state = @state, revision = @revision, prompt_id = @promptId, prompt_expires_at = @promptExpiresAt,
             parent_reservation_id = @parentReservationId, pre_effect_approval_id = @preEffectApprovalId,
             activation_approval_id = @activationApprovalId, effect_id = @effectId,
             latest_receipt_id = @latestReceiptId,
             failure_id = @failureId, reconciliation_id = @reconciliationId,
             last_transition_idempotency_key = @idempotencyKey,
             last_transition_request_sha256 = @requestSha256, updated_at = @updatedAt
         WHERE remediation_id = @remediationId AND revision = @expectedRevision`,
      )
      .run({
        remediationId: next.remediationId,
        expectedRevision,
        state: next.state,
        revision: next.revision,
        promptId: next.promptId,
        promptExpiresAt: next.promptExpiresAt,
        parentReservationId: next.parentReservationId,
        preEffectApprovalId: next.preEffectApprovalId,
        activationApprovalId: next.activationApprovalId,
        effectId: next.effectId,
        latestReceiptId: next.latestReceiptId,
        failureId: next.failureId,
        reconciliationId: next.reconciliationId,
        idempotencyKey,
        requestSha256,
        updatedAt: next.updatedAt,
      });
    return Number(result.changes ?? 0);
  }

  private updateReconciliation(
    next: GovernedRemediationReconciliation,
    idempotencyKey: string,
    requestSha256: string,
    expectedRevision: number,
  ): number {
    const result = this.db
      .prepare(
        `UPDATE governed_remediation_reconciliations
         SET observation = @observation, state = @state, owner_revision_observed = @ownerRevisionObserved,
             resolution_receipt_id = @resolutionReceiptId, revision = @revision,
             last_transition_idempotency_key = @idempotencyKey,
             last_transition_request_sha256 = @requestSha256, updated_at = @updatedAt
         WHERE reconciliation_id = @reconciliationId AND revision = @expectedRevision`,
      )
      .run({
        reconciliationId: next.reconciliationId,
        expectedRevision,
        observation: next.observation,
        state: next.state,
        ownerRevisionObserved: next.ownerRevisionObserved,
        resolutionReceiptId: next.resolutionReceiptId,
        revision: next.revision,
        idempotencyKey,
        requestSha256,
        updatedAt: next.updatedAt,
      });
    return Number(result.changes ?? 0);
  }

  private insertCasTransition(input: {
    aggregateKind: "state" | "reconciliation";
    aggregateId: string;
    idempotencyKey: string;
    requestSha256: string;
    expectedRevision: number;
    resultingRevision: number;
    fromState: string;
    toState: string;
    recordedAt: string;
  }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO governed_remediation_cas_transitions (
            aggregate_kind, aggregate_id, idempotency_key, request_sha256, expected_revision,
            resulting_revision, from_state, to_state, recorded_at
          ) VALUES (
            @aggregateKind, @aggregateId, @idempotencyKey, @requestSha256, @expectedRevision,
            @resultingRevision, @fromState, @toState, @recordedAt
          )`,
        )
        .run(input);
    } catch (error) {
      throw normalizeWriteError(error, "remediation CAS transition");
    }
  }

  private findStateRow(remediationId: string): StateRow | undefined {
    return this.db.prepare("SELECT * FROM governed_remediation_states WHERE remediation_id = ?").get(remediationId) as
      | StateRow
      | undefined;
  }

  private findStateRowByCreateIdempotency(idempotencyKey: string): StateRow | undefined {
    return this.db
      .prepare("SELECT * FROM governed_remediation_states WHERE create_idempotency_key = ?")
      .get(idempotencyKey) as StateRow | undefined;
  }

  private findReceiptRow(receiptId: string): ReceiptRow | undefined {
    return this.db.prepare("SELECT * FROM governed_remediation_receipts WHERE receipt_id = ?").get(receiptId) as
      | ReceiptRow
      | undefined;
  }

  private findReceiptRowByIdempotency(idempotencyKey: string): ReceiptRow | undefined {
    return this.db
      .prepare("SELECT * FROM governed_remediation_receipts WHERE idempotency_key = ?")
      .get(idempotencyKey) as ReceiptRow | undefined;
  }

  private findFailureRow(failureId: string): FailureRow | undefined {
    return this.db.prepare("SELECT * FROM governed_remediation_failures WHERE failure_id = ?").get(failureId) as
      | FailureRow
      | undefined;
  }

  private findFailureRowByIdempotency(idempotencyKey: string): FailureRow | undefined {
    return this.db
      .prepare("SELECT * FROM governed_remediation_failures WHERE idempotency_key = ?")
      .get(idempotencyKey) as FailureRow | undefined;
  }

  private findReconciliationRow(reconciliationId: string): ReconciliationRow | undefined {
    return this.db
      .prepare("SELECT * FROM governed_remediation_reconciliations WHERE reconciliation_id = ?")
      .get(reconciliationId) as ReconciliationRow | undefined;
  }

  private findReconciliationRowByCreateIdempotency(idempotencyKey: string): ReconciliationRow | undefined {
    return this.db
      .prepare("SELECT * FROM governed_remediation_reconciliations WHERE create_idempotency_key = ?")
      .get(idempotencyKey) as ReconciliationRow | undefined;
  }

  private findCasTransition(
    aggregateKind: "state" | "reconciliation",
    idempotencyKey: string,
  ): CasTransitionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM governed_remediation_cas_transitions
         WHERE aggregate_kind = @aggregateKind AND idempotency_key = @idempotencyKey`,
      )
      .get({ aggregateKind, idempotencyKey }) as CasTransitionRow | undefined;
  }

  private acquireLock(kind: string, aggregateId: string): void {
    if (this.db.dialect !== "postgres") return;
    this.db
      .prepare("SELECT pg_advisory_xact_lock(hashtextextended(@lockKey, 541)) AS locked")
      .get({ lockKey: `governed-remediation:${kind}:${aggregateId}` });
  }
}

const receiptInsertSql = `INSERT INTO governed_remediation_receipts (
  schema_version, receipt_id, remediation_id, recipe_id, recipe_version, deployment_id, scope_kind, scope_id,
  target_id, kind, application_owner_id, effect_id, owner_revision_before, owner_revision_after,
  application_receipt_id, activation_receipt_id, probe_id, probe_result, owner_revision_observed, rollback_strategy, rollback_outcome,
  verification_receipt_id, durable_run_id, blocked_checkpoint_id, resumed_run_version, reconciliation_id,
  failure_id, resolution, resume_receipt_id, idempotency_key, request_sha256, recorded_at
) VALUES (
  @schemaVersion, @receiptId, @remediationId, @recipeId, @recipeVersion, @deploymentId, @scopeKind, @scopeId,
  @targetId, @kind, @applicationOwnerId, @effectId, @ownerRevisionBefore, @ownerRevisionAfter,
  @applicationReceiptId, @activationReceiptId, @probeId, @probeResult, @ownerRevisionObserved, @rollbackStrategy, @rollbackOutcome,
  @verificationReceiptId, @durableRunId, @blockedCheckpointId, @resumedRunVersion, @reconciliationId,
  @failureId, @resolution, @resumeReceiptId, @idempotencyKey, @requestSha256, @recordedAt
) ON CONFLICT DO NOTHING`;

function receiptBindings(
  receipt: GovernedRemediationReceipt,
  idempotencyKey: string,
  requestSha256: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    schemaVersion: receipt.schemaVersion,
    receiptId: receipt.receiptId,
    remediationId: receipt.remediationId,
    recipeId: receipt.recipeId,
    recipeVersion: receipt.recipeVersion,
    ...scopeBindings(receipt.scope),
    kind: receipt.kind,
    applicationOwnerId: null,
    effectId: null,
    ownerRevisionBefore: null,
    ownerRevisionAfter: null,
    applicationReceiptId: null,
    activationReceiptId: null,
    probeId: null,
    probeResult: null,
    ownerRevisionObserved: null,
    rollbackStrategy: null,
    rollbackOutcome: null,
    verificationReceiptId: null,
    durableRunId: null,
    blockedCheckpointId: null,
    resumedRunVersion: null,
    reconciliationId: null,
    failureId: null,
    resolution: null,
    resumeReceiptId: null,
    idempotencyKey,
    requestSha256,
    recordedAt: receipt.recordedAt,
  };
  if (receipt.kind === "application") {
    return {
      ...base,
      applicationOwnerId: receipt.ownerId,
      effectId: receipt.effectId,
      ownerRevisionBefore: receipt.ownerRevisionBefore,
      ownerRevisionAfter: receipt.ownerRevisionAfter,
    };
  }
  if (receipt.kind === "verification") {
    return {
      ...base,
      applicationReceiptId: receipt.applicationReceiptId,
      activationReceiptId: receipt.activationReceiptId,
      probeId: receipt.probeId,
      probeResult: receipt.probeResult,
      ownerRevisionObserved: receipt.ownerRevisionObserved,
    };
  }
  if (receipt.kind === "activation") {
    return {
      ...base,
      applicationReceiptId: receipt.applicationReceiptId,
      verificationReceiptId: receipt.initialVerificationReceiptId,
      ownerRevisionBefore: receipt.ownerRevisionBefore,
      ownerRevisionAfter: receipt.ownerRevisionAfter,
    };
  }
  if (receipt.kind === "rollback") {
    return {
      ...base,
      applicationReceiptId: receipt.applicationReceiptId,
      rollbackStrategy: receipt.rollbackStrategy,
      rollbackOutcome: receipt.outcome,
      ownerRevisionBefore: receipt.ownerRevisionBefore,
      ownerRevisionAfter: receipt.ownerRevisionAfter,
    };
  }
  if (receipt.kind === "resume") {
    return {
      ...base,
      verificationReceiptId: receipt.verificationReceiptId,
      durableRunId: receipt.durableRunId,
      blockedCheckpointId: receipt.blockedCheckpointId,
      resumedRunVersion: receipt.resumedRunVersion,
    };
  }
  return {
    ...base,
    reconciliationId: receipt.reconciliationId,
    failureId: receipt.failureId,
    resolution: receipt.resolution,
    applicationReceiptId: receipt.applicationReceiptId,
    resumeReceiptId: receipt.resumeReceiptId,
    ownerRevisionObserved: receipt.ownerRevisionObserved,
  };
}

function mapStateRow(row: StateRow): GovernedRemediationStoredState {
  const record = normalizeGovernedRemediationStateRecord({
    schemaVersion: row.schema_version,
    remediationId: row.remediation_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    sourceTurnId: row.source_turn_id,
    durableRunId: row.durable_run_id,
    blockedCheckpointId: row.blocked_checkpoint_id,
    requesterActorId: row.requester_actor_id,
    recipeId: row.recipe_id,
    recipeVersion: asPositiveInteger(row.recipe_version),
    recipeSha256: row.recipe_sha256,
    scope: mapScope(row),
    state: row.state,
    revision: asPositiveInteger(row.revision),
    expectedWaitingRunVersion: asPositiveInteger(row.expected_waiting_run_version),
    expectedOwnerRevision: row.expected_owner_revision,
    parentReservationId: row.parent_reservation_id,
    promptId: row.prompt_id,
    promptExpiresAt: row.prompt_expires_at,
    preEffectApprovalId: row.pre_effect_approval_id,
    activationApprovalId: row.activation_approval_id,
    effectId: row.effect_id,
    latestReceiptId: row.latest_receipt_id,
    failureId: row.failure_id,
    reconciliationId: row.reconciliation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return { ownerId: identifier(row.owner_id, "stored ownerId"), record };
}

function mapReceiptRow(row: ReceiptRow): GovernedRemediationReceipt {
  const base = {
    schemaVersion: row.schema_version,
    receiptId: row.receipt_id,
    remediationId: row.remediation_id,
    recipeId: row.recipe_id,
    recipeVersion: asPositiveInteger(row.recipe_version),
    scope: mapScope(row),
    kind: row.kind,
    recordedAt: row.recorded_at,
  };
  if (row.kind === "application") {
    return normalizeGovernedRemediationReceipt({
      ...base,
      kind: row.kind,
      ownerId: required(row.application_owner_id),
      effectId: required(row.effect_id),
      ownerRevisionBefore: row.owner_revision_before,
      ownerRevisionAfter: required(row.owner_revision_after),
    });
  }
  if (row.kind === "verification") {
    return normalizeGovernedRemediationReceipt({
      ...base,
      kind: row.kind,
      applicationReceiptId: required(row.application_receipt_id),
      activationReceiptId: row.activation_receipt_id,
      probeId: required(row.probe_id),
      probeResult: required(row.probe_result),
      ownerRevisionObserved: required(row.owner_revision_observed),
    });
  }
  if (row.kind === "activation") {
    return normalizeGovernedRemediationReceipt({
      ...base,
      kind: row.kind,
      applicationReceiptId: required(row.application_receipt_id),
      initialVerificationReceiptId: required(row.verification_receipt_id),
      ownerRevisionBefore: required(row.owner_revision_before),
      ownerRevisionAfter: required(row.owner_revision_after),
    });
  }
  if (row.kind === "rollback") {
    return normalizeGovernedRemediationReceipt({
      ...base,
      kind: row.kind,
      applicationReceiptId: required(row.application_receipt_id),
      rollbackStrategy: required(row.rollback_strategy),
      outcome: required(row.rollback_outcome),
      ownerRevisionBefore: required(row.owner_revision_before),
      ownerRevisionAfter: required(row.owner_revision_after),
    });
  }
  if (row.kind === "resume") {
    return normalizeGovernedRemediationReceipt({
      ...base,
      kind: row.kind,
      verificationReceiptId: required(row.verification_receipt_id),
      durableRunId: required(row.durable_run_id),
      blockedCheckpointId: required(row.blocked_checkpoint_id),
      resumedRunVersion: asPositiveInteger(row.resumed_run_version),
    });
  }
  return normalizeGovernedRemediationReceipt({
    ...base,
    kind: row.kind,
    reconciliationId: required(row.reconciliation_id),
    failureId: required(row.failure_id),
    resolution: required(row.resolution),
    applicationReceiptId: row.application_receipt_id,
    resumeReceiptId: row.resume_receipt_id,
    ownerRevisionObserved: row.owner_revision_observed,
  });
}

function mapFailureRow(row: FailureRow): GovernedRemediationFailure {
  return normalizeGovernedRemediationFailure({
    schemaVersion: row.schema_version,
    failureId: row.failure_id,
    remediationId: row.remediation_id,
    recipeId: row.recipe_id,
    recipeVersion: asPositiveInteger(row.recipe_version),
    scope: mapScope(row),
    phase: row.phase,
    reason: row.reason,
    effectBoundary: row.effect_boundary,
    disposition: row.disposition,
    ownerRevisionObserved: row.owner_revision_observed,
    occurredAt: row.occurred_at,
  });
}

function mapReconciliationRow(row: ReconciliationRow): GovernedRemediationReconciliation {
  return normalizeGovernedRemediationReconciliation({
    schemaVersion: row.schema_version,
    reconciliationId: row.reconciliation_id,
    remediationId: row.remediation_id,
    failureId: row.failure_id,
    recipeId: row.recipe_id,
    recipeVersion: asPositiveInteger(row.recipe_version),
    scope: mapScope(row),
    domain: row.domain,
    reason: row.reason,
    observation: row.observation,
    state: row.state,
    ownerRevisionObserved: row.owner_revision_observed,
    resolutionReceiptId: row.resolution_receipt_id,
    revision: asPositiveInteger(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapPhaseClaimRow(row: PhaseClaimRow): GovernedRemediationPhaseClaim {
  return normalizeGovernedRemediationPhaseClaim({
    schemaVersion: row.schema_version,
    claimId: row.claim_id,
    aggregateKind: row.aggregate_kind,
    aggregateId: row.aggregate_id,
    remediationId: row.remediation_id,
    phase: row.phase,
    claimRevision: asPositiveInteger(row.claim_revision),
    claimantId: row.claimant_id,
    expectedAggregateRevision: asPositiveInteger(row.expected_aggregate_revision),
    operationId: row.operation_id,
    effectId: row.effect_id,
    expectedOwnerRevision: row.expected_owner_revision,
    leaseTokenSha256: row.lease_token_sha256,
    leaseExpiresAt: row.lease_expires_at,
    status: row.status,
    requestSha256: row.request_sha256,
    outcomeSha256: row.outcome_sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapScope(row: {
  deployment_id: string;
  scope_kind: GovernedRemediationScope["scopeKind"];
  scope_id: string;
  target_id: string;
}): GovernedRemediationScope {
  return normalizeGovernedRemediationScope({
    schemaVersion: GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION,
    deploymentId: row.deployment_id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    targetId: row.target_id,
  });
}

function scopeBindings(scope: GovernedRemediationScope): Record<string, string> {
  return {
    deploymentId: scope.deploymentId,
    scopeKind: scope.scopeKind,
    scopeId: scope.scopeId,
    targetId: scope.targetId,
  };
}

function assertChildBinding(
  state: GovernedRemediationStoredState,
  child: {
    remediationId: string;
    recipeId: string;
    recipeVersion: number;
    scope: GovernedRemediationScope;
  },
): void {
  if (
    child.remediationId !== state.record.remediationId ||
    child.recipeId !== state.record.recipeId ||
    child.recipeVersion !== state.record.recipeVersion ||
    canonicalJsonString(child.scope) !== canonicalJsonString(state.record.scope)
  ) {
    throw conflict("remediation child owner or scope");
  }
}

function assertStateImmutableBindings(
  current: GovernedRemediationStateRecord,
  next: GovernedRemediationStateRecord,
): void {
  const currentBindings = {
    remediationId: current.remediationId,
    workspaceId: current.workspaceId,
    sessionId: current.sessionId,
    sourceTurnId: current.sourceTurnId,
    durableRunId: current.durableRunId,
    blockedCheckpointId: current.blockedCheckpointId,
    requesterActorId: current.requesterActorId,
    recipeId: current.recipeId,
    recipeVersion: current.recipeVersion,
    recipeSha256: current.recipeSha256,
    scope: current.scope,
    expectedWaitingRunVersion: current.expectedWaitingRunVersion,
    expectedOwnerRevision: current.expectedOwnerRevision,
    createdAt: current.createdAt,
  };
  const nextBindings = {
    remediationId: next.remediationId,
    workspaceId: next.workspaceId,
    sessionId: next.sessionId,
    sourceTurnId: next.sourceTurnId,
    durableRunId: next.durableRunId,
    blockedCheckpointId: next.blockedCheckpointId,
    requesterActorId: next.requesterActorId,
    recipeId: next.recipeId,
    recipeVersion: next.recipeVersion,
    recipeSha256: next.recipeSha256,
    scope: next.scope,
    expectedWaitingRunVersion: next.expectedWaitingRunVersion,
    expectedOwnerRevision: next.expectedOwnerRevision,
    createdAt: next.createdAt,
  };
  assertExactRecord(currentBindings, nextBindings, "remediation state immutable binding");
  assertInitializeOnce(current.parentReservationId, next.parentReservationId, "parent reservation");
  assertInitializeOnce(current.preEffectApprovalId, next.preEffectApprovalId, "pre-effect approval");
  assertInitializeOnce(current.activationApprovalId, next.activationApprovalId, "activation approval");
  assertInitializeOnce(current.effectId, next.effectId, "effect");
}

function assertInitializeOnce(current: string | null, next: string | null, label: string): void {
  if (current !== null && next !== current) throw conflict(`${label} immutable binding`);
}

function assertReconciliationImmutableBindings(
  current: GovernedRemediationReconciliation,
  next: GovernedRemediationReconciliation,
): void {
  const currentBindings = {
    reconciliationId: current.reconciliationId,
    remediationId: current.remediationId,
    failureId: current.failureId,
    recipeId: current.recipeId,
    recipeVersion: current.recipeVersion,
    scope: current.scope,
    domain: current.domain,
    reason: current.reason,
    createdAt: current.createdAt,
  };
  const nextBindings = {
    reconciliationId: next.reconciliationId,
    remediationId: next.remediationId,
    failureId: next.failureId,
    recipeId: next.recipeId,
    recipeVersion: next.recipeVersion,
    scope: next.scope,
    domain: next.domain,
    reason: next.reason,
    createdAt: next.createdAt,
  };
  assertExactRecord(currentBindings, nextBindings, "remediation reconciliation immutable binding");
}

function assertStoredStateExact(
  stored: GovernedRemediationStoredState,
  attempted: GovernedRemediationStoredState,
): void {
  assertExactRecord(stored, attempted, "remediation state create");
}

function assertExactRecord(stored: unknown, attempted: unknown, label: string): void {
  if (canonicalJsonString(stored) !== canonicalJsonString(attempted)) throw conflict(label);
}

function assertExactHash(stored: string, attempted: string, label: string): void {
  if (stored !== attempted) throw conflict(label);
}

function assertCasReplay(
  row: CasTransitionRow,
  expected: {
    aggregateId: string;
    expectedRevision: number;
    resultingRevision: number;
    toState: string;
    requestSha256: string;
  },
): void {
  if (
    row.aggregate_id !== expected.aggregateId ||
    asPositiveInteger(row.expected_revision) !== expected.expectedRevision ||
    asPositiveInteger(row.resulting_revision) !== expected.resultingRevision ||
    row.to_state !== expected.toState ||
    row.request_sha256 !== expected.requestSha256
  ) {
    throw conflict("remediation transition idempotency");
  }
}

function normalizePhaseClaimAcquireInput(
  input: GovernedRemediationPhaseClaimAcquireInput,
): GovernedRemediationPhaseClaimAcquireInput {
  const value = exactObject(input, "phase claim acquire", [
    "claimId",
    "aggregateKind",
    "aggregateId",
    "remediationId",
    "phase",
    "claimantId",
    "expectedAggregateRevision",
    "operationId",
    "effectId",
    "expectedOwnerRevision",
    "leaseTokenSha256",
    "leaseDurationSeconds",
    "acquisitionIdempotencyKey",
  ]);
  const aggregateKind = enumValue(
    value.aggregateKind,
    GOVERNED_REMEDIATION_PHASE_CLAIM_AGGREGATE_KINDS,
    "phase claim aggregate kind",
  );
  const phase = enumValue(value.phase, GOVERNED_REMEDIATION_PHASES, "phase claim phase");
  const claimId = identifier(value.claimId as string, "phase claim ID");
  const remediationId = identifier(value.remediationId as string, "phase claim remediationId");
  const aggregateId = identifier(value.aggregateId as string, "phase claim aggregateId");
  const effectId = nullableIdentifier(value.effectId, "phase claim effectId");
  const effectBound = [
    "parent_reserve",
    "apply",
    "verify",
    "activate_and_verify",
    "rollback",
    "resume",
    "effect_reconcile",
    "resume_reconcile",
  ].includes(phase);
  if (effectBound !== (effectId !== null))
    throw new TypeError("Governed remediation phase claim effect binding is invalid.");
  if (aggregateKind === "state") {
    if (aggregateId !== remediationId || phase === "effect_reconcile") {
      throw new TypeError("Governed remediation state phase claim aggregate binding is invalid.");
    }
  } else if (phase !== "effect_reconcile" && phase !== "resume_reconcile") {
    throw new TypeError("Governed remediation reconciliation phase claim aggregate binding is invalid.");
  }
  const leaseDurationSeconds = Number(value.leaseDurationSeconds);
  if (!Number.isSafeInteger(leaseDurationSeconds) || leaseDurationSeconds < 1 || leaseDurationSeconds > 900) {
    throw new TypeError("Governed remediation phase claim lease duration must be between 1 and 900 seconds.");
  }
  const expectedOwnerRevision = nullableIdentifier(value.expectedOwnerRevision, "phase expected owner revision", 512);
  return {
    claimId,
    aggregateKind,
    aggregateId,
    remediationId,
    phase,
    claimantId: identifier(value.claimantId as string, "phase claimant ID"),
    expectedAggregateRevision: positiveInteger(
      Number(value.expectedAggregateRevision),
      "phase expected aggregate revision",
    ),
    operationId: identifier(value.operationId as string, "phase operation ID"),
    effectId,
    expectedOwnerRevision,
    leaseTokenSha256: sha256(value.leaseTokenSha256, "phase lease token SHA-256"),
    leaseDurationSeconds,
    acquisitionIdempotencyKey: identifier(
      value.acquisitionIdempotencyKey as string,
      "phase acquisition idempotency key",
      512,
    ),
  };
}

function phaseClaimStableRequest(input: GovernedRemediationPhaseClaimAcquireInput): Record<string, unknown> {
  return {
    claimId: input.claimId,
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    remediationId: input.remediationId,
    phase: input.phase,
    expectedAggregateRevision: input.expectedAggregateRevision,
    operationId: input.operationId,
    effectId: input.effectId,
    expectedOwnerRevision: input.expectedOwnerRevision,
  };
}

function assertPhaseClaimStableBindings(
  row: PhaseClaimRow,
  input: GovernedRemediationPhaseClaimAcquireInput,
  stableRequestSha256: string,
): void {
  if (row.claim_id !== input.claimId || row.request_sha256 !== stableRequestSha256) {
    throw conflict("phase claim stable operation binding");
  }
}

function normalizePhaseClaimWitness(input: GovernedRemediationPhaseClaimWitness): GovernedRemediationPhaseClaimWitness {
  const value = exactObject(input, "phase claim witness", [
    "remediationId",
    "phase",
    "claimId",
    "claimRevision",
    "claimantId",
    "leaseToken",
  ]);
  return {
    remediationId: identifier(value.remediationId as string, "phase witness remediationId"),
    phase: enumValue(value.phase, GOVERNED_REMEDIATION_PHASES, "phase witness phase"),
    claimId: identifier(value.claimId as string, "phase witness claimId"),
    claimRevision: positiveInteger(Number(value.claimRevision), "phase witness claim revision"),
    claimantId: identifier(value.claimantId as string, "phase witness claimantId"),
    leaseToken: canonicalLeaseToken(value.leaseToken),
  };
}

function normalizeClaimedPhaseOutcome(
  input: GovernedRemediationClaimedPhaseOutcome,
): GovernedRemediationClaimedPhaseOutcome {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Governed remediation claimed phase outcome must be an object.");
  }
  const kind = (input as { kind?: unknown }).kind;
  if (kind === "state_transition") {
    const value = exactObject(input, "claimed state transition outcome", ["kind", "nextState"]);
    return { kind, nextState: normalizeGovernedRemediationStateRecord(value.nextState) };
  }
  if (kind === "state_receipt") {
    const value = exactObject(input, "claimed state receipt outcome", ["kind", "receipt", "nextState"]);
    return {
      kind,
      receipt: normalizeGovernedRemediationReceipt(value.receipt),
      nextState: normalizeGovernedRemediationStateRecord(value.nextState),
    };
  }
  if (kind === "state_activation_receipts") {
    const value = exactObject(input, "claimed activation receipts outcome", [
      "kind",
      "activationReceipt",
      "verificationReceipt",
      "nextState",
    ]);
    return {
      kind,
      activationReceipt: normalizeGovernedRemediationReceipt(value.activationReceipt),
      verificationReceipt: normalizeGovernedRemediationReceipt(value.verificationReceipt),
      nextState: normalizeGovernedRemediationStateRecord(value.nextState),
    };
  }
  if (kind === "state_activation_failure") {
    const value = exactObject(input, "claimed activation failure outcome", [
      "kind",
      "activationReceipt",
      "failure",
      "nextState",
    ]);
    return {
      kind,
      activationReceipt: normalizeGovernedRemediationReceipt(value.activationReceipt),
      failure: normalizeGovernedRemediationFailure(value.failure),
      nextState: normalizeGovernedRemediationStateRecord(value.nextState),
    };
  }
  if (kind === "state_activation_failure_reconciliation") {
    const value = exactObject(input, "claimed activation failure reconciliation outcome", [
      "kind",
      "activationReceipt",
      "failure",
      "reconciliation",
      "nextState",
    ]);
    return {
      kind,
      activationReceipt: normalizeGovernedRemediationReceipt(value.activationReceipt),
      failure: normalizeGovernedRemediationFailure(value.failure),
      reconciliation: normalizeGovernedRemediationReconciliation(value.reconciliation),
      nextState: normalizeGovernedRemediationStateRecord(value.nextState),
    };
  }
  if (kind === "state_failure") {
    const value = exactObject(input, "claimed state failure outcome", ["kind", "failure", "nextState"]);
    return {
      kind,
      failure: normalizeGovernedRemediationFailure(value.failure),
      nextState: normalizeGovernedRemediationStateRecord(value.nextState),
    };
  }
  if (kind === "state_failure_reconciliation") {
    const value = exactObject(input, "claimed state reconciliation outcome", [
      "kind",
      "failure",
      "reconciliation",
      "nextState",
    ]);
    return {
      kind,
      failure: normalizeGovernedRemediationFailure(value.failure),
      reconciliation: normalizeGovernedRemediationReconciliation(value.reconciliation),
      nextState: normalizeGovernedRemediationStateRecord(value.nextState),
    };
  }
  if (kind === "failure_only") {
    const value = exactObject(input, "claimed failure-only outcome", ["kind", "failure"]);
    return { kind, failure: normalizeGovernedRemediationFailure(value.failure) };
  }
  if (kind === "reconciliation_transition") {
    const value = exactObject(input, "claimed reconciliation transition outcome", ["kind", "nextReconciliation"]);
    return { kind, nextReconciliation: normalizeGovernedRemediationReconciliation(value.nextReconciliation) };
  }
  if (kind === "reconciliation_receipt") {
    const value = exactObject(input, "claimed reconciliation receipt outcome", [
      "kind",
      "receipt",
      "nextReconciliation",
    ]);
    return {
      kind,
      receipt: normalizeGovernedRemediationReceipt(value.receipt),
      nextReconciliation: normalizeGovernedRemediationReconciliation(value.nextReconciliation),
    };
  }
  if (kind === "reconciliation_application_receipts") {
    const value = exactObject(input, "claimed reconciliation application receipts outcome", [
      "kind",
      "applicationReceipt",
      "reconciliationReceipt",
      "nextReconciliation",
    ]);
    return {
      kind,
      applicationReceipt: normalizeGovernedRemediationReceipt(value.applicationReceipt),
      reconciliationReceipt: normalizeGovernedRemediationReceipt(value.reconciliationReceipt),
      nextReconciliation: normalizeGovernedRemediationReconciliation(value.nextReconciliation),
    };
  }
  if (kind === "reconciliation_resume_receipts") {
    const value = exactObject(input, "claimed reconciliation resume receipts outcome", [
      "kind",
      "resumeReceipt",
      "reconciliationReceipt",
      "nextReconciliation",
    ]);
    return {
      kind,
      resumeReceipt: normalizeGovernedRemediationReceipt(value.resumeReceipt),
      reconciliationReceipt: normalizeGovernedRemediationReceipt(value.reconciliationReceipt),
      nextReconciliation: normalizeGovernedRemediationReconciliation(value.nextReconciliation),
    };
  }
  throw new TypeError("Governed remediation claimed phase outcome kind is invalid.");
}

function assertClaimWitness(
  row: PhaseClaimRow,
  witness: GovernedRemediationPhaseClaimWitness,
  expectedAggregateRevision: number,
  leaseTokenSha256: string,
): void {
  if (
    row.remediation_id !== witness.remediationId ||
    row.phase !== witness.phase ||
    asPositiveInteger(row.claim_revision) !== witness.claimRevision ||
    row.claimant_id !== witness.claimantId ||
    asPositiveInteger(row.expected_aggregate_revision) !== expectedAggregateRevision ||
    !safeDigestEqual(row.lease_token_sha256, leaseTokenSha256)
  ) {
    throw conflict("phase claim witness");
  }
}

function assertClaimedOutcomePhase(row: PhaseClaimRow, outcome: GovernedRemediationClaimedPhaseOutcome): void {
  if (row.aggregate_kind === "state") {
    if (
      outcome.kind === "reconciliation_transition" ||
      outcome.kind === "reconciliation_receipt" ||
      outcome.kind === "reconciliation_application_receipts" ||
      outcome.kind === "reconciliation_resume_receipts"
    ) {
      throw conflict("claimed phase outcome aggregate kind");
    }
    if (outcome.kind === "state_transition" && row.phase !== "parent_reserve" && row.phase !== "resume_reconcile") {
      throw conflict("claimed phase transition outcome");
    }
    if (outcome.kind === "failure_only" && row.phase !== "apply") {
      throw conflict("claimed phase failure-only outcome");
    }
    if (
      (outcome.kind === "state_activation_receipts" ||
        outcome.kind === "state_activation_failure" ||
        outcome.kind === "state_activation_failure_reconciliation") &&
      row.phase !== "activate_and_verify"
    ) {
      throw conflict("claimed activation outcome phase");
    }
    if (outcome.kind === "state_receipt") {
      const expectedKind: Partial<Record<GovernedRemediationPhase, GovernedRemediationReceiptKind>> = {
        apply: "application",
        verify: "verification",
        rollback: "rollback",
        resume: "resume",
        resume_reconcile: "resume",
      };
      if (expectedKind[row.phase] !== outcome.receipt.kind) throw conflict("claimed phase receipt kind");
    }
    return;
  }
  if (
    outcome.kind === "state_transition" ||
    outcome.kind === "state_receipt" ||
    outcome.kind === "state_activation_receipts" ||
    outcome.kind === "state_activation_failure" ||
    outcome.kind === "state_activation_failure_reconciliation" ||
    outcome.kind === "state_failure" ||
    outcome.kind === "state_failure_reconciliation" ||
    outcome.kind === "failure_only"
  ) {
    throw conflict("claimed phase outcome aggregate kind");
  }
  if (row.phase === "effect_reconcile" && outcome.kind === "reconciliation_resume_receipts") {
    throw conflict("claimed effect reconciliation outcome");
  }
  if (row.phase === "resume_reconcile" && outcome.kind === "reconciliation_application_receipts") {
    throw conflict("claimed resume reconciliation outcome");
  }
}

function assertActivationClaimLineage(
  repository: GovernedRemediationRepository,
  state: GovernedRemediationStoredState,
  claim: PhaseClaimRow,
  receipt: GovernedRemediationReceipt,
): asserts receipt is Extract<GovernedRemediationReceipt, { kind: "activation" }> {
  if (
    receipt.kind !== "activation" ||
    receipt.ownerRevisionBefore !== claim.expected_owner_revision ||
    state.record.effectId !== claim.effect_id
  ) {
    throw conflict("claimed activation authority binding");
  }
  assertChildBinding(state, receipt);
  const initialVerification = repository.getReceipt(receipt.initialVerificationReceiptId);
  if (
    initialVerification.kind !== "verification" ||
    initialVerification.activationReceiptId !== null ||
    initialVerification.applicationReceiptId !== receipt.applicationReceiptId ||
    initialVerification.ownerRevisionObserved !== receipt.ownerRevisionBefore
  ) {
    throw conflict("claimed activation initial verification lineage");
  }
}

function assertClaimFailurePhase(
  claimPhase: GovernedRemediationPhase,
  failurePhase: GovernedRemediationFailure["phase"],
): void {
  const expected: Record<GovernedRemediationPhase, readonly GovernedRemediationFailure["phase"][]> = {
    parent_reserve: ["preflight", "recovery"],
    apply: ["apply", "recovery"],
    verify: ["verify", "recovery"],
    activate_and_verify: ["activation", "recovery"],
    rollback: ["rollback", "recovery"],
    resume: ["resume", "recovery"],
    effect_reconcile: ["recovery"],
    resume_reconcile: ["resume", "recovery"],
  };
  if (!expected[claimPhase].includes(failurePhase)) throw conflict("claimed failure phase provenance");
}

function phaseOwnedTransition(from: GovernedRemediationState, to: GovernedRemediationState): boolean {
  if (to === "applying") return true;
  if (["applying", "verifying", "activating", "resuming", "reconciling_resume", "rolling_back"].includes(from)) {
    return true;
  }
  if (from === "blocked") return to === "failed";
  if (from === "credential_verified") return to === "declined" || to === "expired" || to === "failed";
  if (from === "awaiting_activation_approval") return to === "declined" || to === "expired";
  return from === "verified" && to === "failed";
}

function phaseOwnedFailure(failure: GovernedRemediationFailure): boolean {
  return ["apply", "verify", "activation", "rollback", "resume", "recovery"].includes(failure.phase);
}

function assertReferencedReceipt(
  state: GovernedRemediationStoredState,
  receipt: GovernedRemediationReceipt,
  expectedKind: GovernedRemediationReceiptKind,
  label: string,
): void {
  assertChildBinding(state, receipt);
  if (receipt.kind !== expectedKind) throw conflict(label);
}

function durableEffectRevision(
  repository: GovernedRemediationRepository,
  state: GovernedRemediationStoredState,
): string {
  if (state.record.latestReceiptId === null) throw conflict("rollback latest effect receipt");
  const latest = repository.getReceipt(state.record.latestReceiptId);
  assertChildBinding(state, latest);
  if (latest.kind === "application" || latest.kind === "activation") return latest.ownerRevisionAfter;
  if (latest.kind === "verification") return latest.ownerRevisionObserved;
  throw conflict("rollback latest effect receipt kind");
}

function assertStateTerminalLineage(
  repository: GovernedRemediationRepository,
  next: GovernedRemediationStateRecord,
): void {
  const storedState = repository.getState(next.remediationId);
  if (next.latestReceiptId !== null) {
    const latest = repository.getReceipt(next.latestReceiptId);
    assertChildBinding(storedState, latest);
    if (next.state === "completed") {
      if (
        latest.kind !== "resume" ||
        latest.durableRunId !== next.durableRunId ||
        latest.blockedCheckpointId !== next.blockedCheckpointId ||
        latest.resumedRunVersion !== next.expectedWaitingRunVersion + 1
      ) {
        throw conflict("completed remediation receipt lineage");
      }
    }
    if (next.state === "rolled_back" && latest.kind !== "rollback") {
      throw conflict("rolled-back remediation receipt lineage");
    }
  }
  if (next.failureId !== null) {
    assertChildBinding(storedState, repository.getFailure(next.failureId));
  }
  if (next.reconciliationId !== null) {
    const reconciliation = repository.getReconciliation(next.reconciliationId);
    assertChildBinding(storedState, reconciliation);
    if (next.state === "reconciling_resume" && reconciliation.domain !== "resume") {
      throw conflict("resume reconciliation state lineage");
    }
    if (next.state === "rollback_failed" && reconciliation.domain !== "effect") {
      throw conflict("rollback reconciliation state lineage");
    }
  }
}

function assertReconciliationResolutionLineage(
  repository: GovernedRemediationRepository,
  next: GovernedRemediationReconciliation,
): void {
  if (next.resolutionReceiptId === null) return;
  const receipt = repository.getReceipt(next.resolutionReceiptId);
  if (
    receipt.kind !== "reconciliation" ||
    receipt.reconciliationId !== next.reconciliationId ||
    receipt.failureId !== next.failureId ||
    receipt.resolution !== reconciliationResolutionForState(next.state)
  ) {
    throw conflict("reconciliation resolution receipt lineage");
  }
}

function reconciliationDomainForResolution(
  resolution: Extract<GovernedRemediationReceipt, { kind: "reconciliation" }>["resolution"],
): GovernedRemediationReconciliationDomain {
  return resolution === "confirmed_resumed" || resolution === "confirmed_not_resumed" ? "resume" : "effect";
}

function reconciliationResolutionForState(
  state: GovernedRemediationReconciliation["state"],
): Extract<GovernedRemediationReceipt, { kind: "reconciliation" }>["resolution"] | null {
  const resolutions: Partial<
    Record<
      GovernedRemediationReconciliation["state"],
      Extract<GovernedRemediationReceipt, { kind: "reconciliation" }>["resolution"]
    >
  > = {
    resolved_no_effect: "confirmed_no_effect",
    resolved_rolled_back: "confirmed_rolled_back",
    resolved_verified: "confirmed_verified",
    resolved_resumed: "confirmed_resumed",
    resolved_not_resumed: "confirmed_not_resumed",
  };
  return resolutions[state] ?? null;
}

function digestLeaseToken(value: string): string {
  return createHash("sha256")
    .update(Buffer.from(canonicalLeaseToken(value), "base64url"))
    .digest("hex");
}

function canonicalLeaseToken(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new TypeError("Governed remediation phase lease token must encode exactly 32 random bytes.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    throw new TypeError("Governed remediation phase lease token must be canonical base64url.");
  }
  return value;
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`Governed remediation ${field} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function nullableIdentifier(value: unknown, field: string, maxLength = 256): string | null {
  return value === null ? null : identifier(value as string, field, maxLength);
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`Governed remediation ${field} is invalid.`);
  }
  return value as T[number];
}

function exactObject(input: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`Governed remediation ${field} must be an object.`);
  }
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`Governed remediation ${field} contains unsupported fields.`);
  }
  return value;
}

function digestRecord(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

function identifier(value: string, field: string, maxLength = 256): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    value !== value.normalize("NFKC").trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u.test(value)
  ) {
    throw new TypeError(`Governed remediation ${field} must be a bounded canonical identifier.`);
  }
  return value;
}

function timestamp(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError(`Governed remediation ${field} must be a canonical UTC ISO timestamp.`);
  }
  return value;
}

function optionalTimestamp(value: string | undefined, field: string): string | null {
  return value === undefined ? null : timestamp(value, field);
}

const RECOVERABLE_REMEDIATION_STATES = new Set<GovernedRemediationState>([
  "blocked",
  "offered",
  "awaiting_preapproval",
  "awaiting_secure_input",
  "applying",
  "verifying",
  "credential_verified",
  "awaiting_activation_approval",
  "activating",
  "verified",
  "resuming",
  "reconciling_resume",
  "rolling_back",
]);

function normalizeRecoveryStates(states: readonly GovernedRemediationState[] | undefined): GovernedRemediationState[] {
  const normalized = states === undefined ? [...RECOVERABLE_REMEDIATION_STATES] : [...states];
  if (normalized.length === 0 || new Set(normalized).size !== normalized.length) {
    throw new TypeError("Governed remediation recovery states must be a non-empty unique set.");
  }
  for (const state of normalized) {
    if (!RECOVERABLE_REMEDIATION_STATES.has(state)) {
      throw new TypeError("Governed remediation recovery state is not recoverable.");
    }
  }
  return normalized;
}

function normalizeReconciliationDomains(
  domains: readonly GovernedRemediationReconciliationDomain[] | undefined,
): GovernedRemediationReconciliationDomain[] {
  const normalized: GovernedRemediationReconciliationDomain[] =
    domains === undefined ? ["effect", "resume"] : [...domains];
  if (
    normalized.length === 0 ||
    new Set(normalized).size !== normalized.length ||
    normalized.some((domain) => domain !== "effect" && domain !== "resume")
  ) {
    throw new TypeError("Governed remediation reconciliation domains must be a non-empty unique set.");
  }
  return normalized;
}

function normalizeStateRecoveryCursor(
  cursor: GovernedRemediationStateRecoveryCursor | undefined,
): GovernedRemediationStateRecoveryCursor | null {
  return cursor
    ? {
        updatedAt: timestamp(cursor.updatedAt, "state recovery cursor timestamp"),
        remediationId: identifier(cursor.remediationId, "state recovery cursor remediationId"),
      }
    : null;
}

function normalizeReconciliationRecoveryCursor(
  cursor: GovernedRemediationReconciliationRecoveryCursor | undefined,
): GovernedRemediationReconciliationRecoveryCursor | null {
  return cursor
    ? {
        updatedAt: timestamp(cursor.updatedAt, "reconciliation recovery cursor timestamp"),
        reconciliationId: identifier(cursor.reconciliationId, "reconciliation recovery cursor reconciliationId"),
      }
    : null;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Governed remediation ${field} must be a positive safe integer.`);
  }
  return value;
}

function asPositiveInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw invalidState("stored positive integer is invalid");
  return parsed;
}

function boundedLimit(value: number | undefined, max = 200): number {
  if (value === undefined) return Math.min(100, max);
  return Math.max(1, Math.min(Math.trunc(value), max));
}

function required<T>(value: T | null): T {
  if (value === null) throw invalidState("stored variant field is missing");
  return value;
}

function conflict(label: string): ConflictError {
  return new ConflictError({
    code: "STATE_CONFLICT",
    message: `${label} conflicts with durable governed-remediation authority.`,
    details: { reason: "governed_remediation_conflict" },
  });
}

function normalizeWriteError(error: unknown, label: string): Error {
  if (error instanceof ConflictError || error instanceof NotFoundError || error instanceof TypeError) return error;
  return conflict(label);
}

function invalidState(message: string): Error {
  return new Error(`Governed remediation storage is invalid: ${message}.`);
}
