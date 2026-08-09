import { createHash } from "node:crypto";
import {
  ConflictError,
  GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_RECONCILIATION_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
  NotFoundError,
  canonicalJsonString,
  governedRemediationReconciliationCanTransition,
  governedRemediationStateCanTransition,
  normalizeGovernedRemediationFailure,
  normalizeGovernedRemediationReceipt,
  normalizeGovernedRemediationReconciliation,
  normalizeGovernedRemediationScope,
  normalizeGovernedRemediationStateRecord,
  type GovernedRemediationFailure,
  type GovernedRemediationReceipt,
  type GovernedRemediationReceiptKind,
  type GovernedRemediationReconciliation,
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

interface StateRow {
  schema_version: typeof GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION;
  remediation_id: string;
  owner_id: string;
  workspace_id: string;
  session_id: string;
  source_turn_id: string;
  durable_run_id: string;
  blocked_checkpoint_id: string;
  recipe_id: string;
  recipe_version: number | string;
  deployment_id: string;
  scope_kind: GovernedRemediationScope["scopeKind"];
  scope_id: string;
  target_id: string;
  state: GovernedRemediationState;
  revision: number | string;
  expected_waiting_run_version: number | string;
  expected_owner_revision: string | null;
  prompt_id: string | null;
  prompt_expires_at: string | null;
  approval_id: string | null;
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
  resolution: "confirmed_no_effect" | "confirmed_rolled_back" | "confirmed_verified" | null;
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

/**
 * Durable storage owner for the generic governed-remediation contracts.
 *
 * The repository accepts only normalized contract records plus bounded
 * idempotency keys. It cannot persist commands, arbitrary payloads, provider
 * errors, credential values, or OAuth material because no such columns or API
 * inputs exist.
 */
export class GovernedRemediationRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public createState(input: {
    ownerId: string;
    record: GovernedRemediationStateRecord;
    idempotencyKey: string;
  }): GovernedRemediationStoredState {
    const ownerId = identifier(input.ownerId, "ownerId");
    const record = normalizeGovernedRemediationStateRecord(input.record);
    const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey", 512);
    if (record.revision !== 1) throw conflict("new remediation state revision");
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
              blocked_checkpoint_id, recipe_id, recipe_version, deployment_id, scope_kind, scope_id, target_id,
              state, revision, expected_waiting_run_version, expected_owner_revision, prompt_id, prompt_expires_at,
              approval_id, effect_id, latest_receipt_id, failure_id, reconciliation_id, create_idempotency_key,
              create_request_sha256, last_transition_idempotency_key, last_transition_request_sha256,
              created_at, updated_at
            ) VALUES (
              @schemaVersion, @remediationId, @ownerId, @workspaceId, @sessionId, @sourceTurnId, @durableRunId,
              @blockedCheckpointId, @recipeId, @recipeVersion, @deploymentId, @scopeKind, @scopeId, @targetId,
              @state, @revision, @expectedWaitingRunVersion, @expectedOwnerRevision, @promptId, @promptExpiresAt,
              @approvalId, @effectId, @latestReceiptId, @failureId, @reconciliationId, @idempotencyKey,
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
            recipeId: record.recipeId,
            recipeVersion: record.recipeVersion,
            ...scope,
            state: record.state,
            revision: record.revision,
            expectedWaitingRunVersion: record.expectedWaitingRunVersion,
            expectedOwnerRevision: record.expectedOwnerRevision,
            promptId: record.promptId,
            promptExpiresAt: record.promptExpiresAt,
            approvalId: record.approvalId,
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

  public listStateRecoveryCandidates(query: GovernedRemediationRecoveryQuery = {}): GovernedRemediationStoredState[] {
    const updatedBefore = optionalTimestamp(query.updatedBefore, "updatedBefore");
    const rows = this.db
      .prepare(
        `SELECT * FROM governed_remediation_states
         WHERE state IN (
           'awaiting_preapproval', 'awaiting_secure_input', 'applying', 'verifying',
           'awaiting_activation_approval', 'activating', 'resuming', 'rolling_back'
         )
           AND (@updatedBefore IS NULL OR updated_at <= @updatedBefore)
         ORDER BY updated_at ASC, remediation_id ASC
         LIMIT @limit`,
      )
      .all({ updatedBefore, limit: boundedLimit(query.limit) }) as StateRow[];
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
      if (current.ownerId !== ownerId) throw conflict("remediation owner scope");
      if (current.record.revision !== expectedRevision || next.revision !== expectedRevision + 1) {
        throw conflict("remediation state revision");
      }
      assertStateImmutableBindings(current.record, next);
      if (!governedRemediationStateCanTransition(current.record.state, next.state)) {
        throw conflict("remediation state transition");
      }
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
    return this.db.transaction("immediate", () => {
      this.acquireLock("state", receipt.remediationId);
      const state = this.getState(receipt.remediationId);
      assertChildBinding(state, receipt);
      if (receipt.kind === "application" && receipt.ownerId !== state.ownerId) {
        throw conflict("application receipt owner");
      }
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
              deployment_id, scope_kind, scope_id, target_id, reason, observation, state,
              owner_revision_observed, resolution_receipt_id, revision, create_idempotency_key,
              create_request_sha256, last_transition_idempotency_key, last_transition_request_sha256,
              created_at, updated_at
            ) VALUES (
              @schemaVersion, @reconciliationId, @remediationId, @failureId, @recipeId, @recipeVersion,
              @deploymentId, @scopeKind, @scopeId, @targetId, @reason, @observation, @state,
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
    query: GovernedRemediationRecoveryQuery = {},
  ): GovernedRemediationReconciliation[] {
    const updatedBefore = optionalTimestamp(query.updatedBefore, "updatedBefore");
    const rows = this.db
      .prepare(
        `SELECT * FROM governed_remediation_reconciliations
         WHERE state IN ('open', 'quarantined')
           AND (@updatedBefore IS NULL OR updated_at <= @updatedBefore)
         ORDER BY CASE state WHEN 'quarantined' THEN 0 ELSE 1 END, updated_at ASC, reconciliation_id ASC
         LIMIT @limit`,
      )
      .all({ updatedBefore, limit: boundedLimit(query.limit) }) as ReconciliationRow[];
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
             approval_id = @approvalId, effect_id = @effectId, latest_receipt_id = @latestReceiptId,
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
        approvalId: next.approvalId,
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
  application_receipt_id, probe_id, probe_result, owner_revision_observed, rollback_strategy, rollback_outcome,
  verification_receipt_id, durable_run_id, blocked_checkpoint_id, resumed_run_version, reconciliation_id,
  failure_id, resolution, idempotency_key, request_sha256, recorded_at
) VALUES (
  @schemaVersion, @receiptId, @remediationId, @recipeId, @recipeVersion, @deploymentId, @scopeKind, @scopeId,
  @targetId, @kind, @applicationOwnerId, @effectId, @ownerRevisionBefore, @ownerRevisionAfter,
  @applicationReceiptId, @probeId, @probeResult, @ownerRevisionObserved, @rollbackStrategy, @rollbackOutcome,
  @verificationReceiptId, @durableRunId, @blockedCheckpointId, @resumedRunVersion, @reconciliationId,
  @failureId, @resolution, @idempotencyKey, @requestSha256, @recordedAt
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
      probeId: receipt.probeId,
      probeResult: receipt.probeResult,
      ownerRevisionObserved: receipt.ownerRevisionObserved,
    };
  }
  if (receipt.kind === "rollback") {
    return {
      ...base,
      applicationReceiptId: receipt.applicationReceiptId,
      rollbackStrategy: receipt.rollbackStrategy,
      rollbackOutcome: receipt.outcome,
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
    recipeId: row.recipe_id,
    recipeVersion: asPositiveInteger(row.recipe_version),
    scope: mapScope(row),
    state: row.state,
    revision: asPositiveInteger(row.revision),
    expectedWaitingRunVersion: asPositiveInteger(row.expected_waiting_run_version),
    expectedOwnerRevision: row.expected_owner_revision,
    promptId: row.prompt_id,
    promptExpiresAt: row.prompt_expires_at,
    approvalId: row.approval_id,
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
      probeId: required(row.probe_id),
      probeResult: required(row.probe_result),
      ownerRevisionObserved: required(row.owner_revision_observed),
    });
  }
  if (row.kind === "rollback") {
    return normalizeGovernedRemediationReceipt({
      ...base,
      kind: row.kind,
      applicationReceiptId: required(row.application_receipt_id),
      rollbackStrategy: required(row.rollback_strategy),
      outcome: required(row.rollback_outcome),
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
    recipeId: current.recipeId,
    recipeVersion: current.recipeVersion,
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
    recipeId: next.recipeId,
    recipeVersion: next.recipeVersion,
    scope: next.scope,
    expectedWaitingRunVersion: next.expectedWaitingRunVersion,
    expectedOwnerRevision: next.expectedOwnerRevision,
    createdAt: next.createdAt,
  };
  assertExactRecord(currentBindings, nextBindings, "remediation state immutable binding");
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
