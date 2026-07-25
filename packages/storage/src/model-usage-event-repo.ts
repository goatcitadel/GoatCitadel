/* eslint-disable max-lines -- This established owner exceeds the line limit; decomposition belongs in a separate behavior-preserving tranche. */
import type {
  ModelUsageAvailability,
  ModelUsageCallKind,
  ModelUsageCostSource,
  ModelUsageCredentialSource,
  ModelUsageCredentialType,
  ModelUsageDispatchReconciliation,
  ModelUsageEventListQuery,
  ModelUsageEventListResponse,
  ModelUsageEventRecord,
  ModelUsageOutputCapDisposition,
  ModelUsageOutputCapEvidenceFormat,
  ModelUsageOutputCapRecoveryReasonCode,
  ModelUsagePool,
  ModelUsagePricingSource,
  ModelUsageSummary,
  ModelUsageTerminalOutcome,
  ModelUsageTransportRetryReason,
  ModelUsageTransportStatus,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

export interface BeginModelUsageAttemptInput {
  eventId: string;
  idempotencyKey: string;
  source: ModelUsageEventRecord["source"];
  callKind: ModelUsageCallKind;
  requestedProviderId?: string;
  requestedModelId?: string;
  requestedReasoningLevel?: string;
  dispatchedReasoningEffort?: string;
  reasoningDisposition?: ModelUsageEventRecord["reasoningDisposition"];
  reasoningReasonCode?: string;
  effectiveProviderId?: string;
  effectiveModelId?: string;
  effectiveApiStyle?: string;
  routeDecisionId?: string;
  contextSnapshotId?: string;
  contextIntentHash?: string;
  contextEntryRefId?: string;
  operationId: string;
  parentOperationId?: string;
  dispatchGeneration: string;
  attemptIndex: number;
  transportAttemptIndex: number;
  requestedOutputTokenCap?: number;
  effectiveOutputTokenCap?: number;
  outputCapDisposition?: ModelUsageOutputCapDisposition;
  outputCapRecoverySourceEventId?: string;
  outputCapRecoveryReasonCode?: ModelUsageOutputCapRecoveryReasonCode;
  outputCapProviderAvailableTokens?: number;
  outputCapProviderMinimumTokens?: number;
  outputCapRequestInputEstimate?: number;
  outputCapConfiguredContextWindowTokens?: number;
  outputCapSafetyMarginTokens?: number;
  outputCapEvidenceFormat?: ModelUsageOutputCapEvidenceFormat;
  transportRetryParentEventId?: string;
  transportRetryReason?: ModelUsageTransportRetryReason;
  dispatchOwnerId: string;
  dispatchLeaseExpiresAt: string;
  fallbackIndex: number;
  repairIndex: number;
  workspaceId?: string;
  sessionId?: string;
  turnId?: string;
  durableRunId?: string;
  taskId?: string;
  agentId?: string;
  assemblyRunId?: string;
  assemblyRoundIndex?: number;
  assemblyStage?: string;
  workerId?: string;
  utilityKind?: string;
  credentialType: ModelUsageCredentialType;
  usagePool: ModelUsagePool;
  credentialSource: ModelUsageCredentialSource;
  credentialConfigFingerprint?: string;
  pricingCatalogVersion?: string;
  pricingCatalogHash?: string;
  inputRateUsdPerMillion?: number;
  outputRateUsdPerMillion?: number;
  cachedInputRateUsdPerMillion?: number;
  startedAt: string;
}

export interface FinalizeModelUsageAttemptInput {
  dispatchOwnerId: string;
  terminalOutcome: Exclude<ModelUsageTerminalOutcome, "in_flight">;
  availability: ModelUsageAvailability;
  pricingSource: ModelUsagePricingSource;
  costSource: ModelUsageCostSource;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
  reportedEffectiveModelId?: string;
  contextResolutionHash?: string;
  errorCode?: string;
  finishedAt: string;
  durationMs: number;
}

export interface BeginModelUsageAttemptResult {
  record: ModelUsageEventRecord;
  inserted: boolean;
}

export interface FinalizeModelUsageAttemptResult {
  record: ModelUsageEventRecord;
  finalized: boolean;
}

export interface ReconcileModelUsageDispatchInput {
  reconciliation: ModelUsageDispatchReconciliation;
  reconciledAt: string;
  /** Required, bounded, secret-free operator or provider evidence. */
  evidence: string;
  /** Required by operator routes; omitted only for trusted system recovery. */
  reconciledBy?: string;
}

export interface ModelUsageRecoverySweepResult {
  recoveredIntentCount: number;
  recoveredAcceptedCount: number;
  batchCount: number;
  /** True only when the configured batch budget was exhausted; PG may also defer locked rows. */
  batchLimitReached: boolean;
}

interface ModelUsageEventRow {
  event_id: string;
  idempotency_key: string;
  source: ModelUsageEventRecord["source"];
  call_kind: ModelUsageCallKind;
  requested_provider_id: string | null;
  requested_model_id: string | null;
  requested_reasoning_level: string | null;
  dispatched_reasoning_effort: string | null;
  reasoning_disposition: NonNullable<ModelUsageEventRecord["reasoningDisposition"]> | null;
  reasoning_reason_code: string | null;
  dispatched_model_id: string | null;
  effective_provider_id: string | null;
  effective_model_id: string | null;
  effective_api_style: string | null;
  route_decision_id: string | null;
  context_snapshot_id: string | null;
  context_intent_hash: string | null;
  context_entry_ref_id: string | null;
  context_resolution_hash: string | null;
  operation_id: string;
  parent_operation_id: string | null;
  dispatch_generation: string;
  attempt_index: number | string;
  transport_attempt_index: number | string;
  requested_output_token_cap: number | string | null;
  effective_output_token_cap: number | string | null;
  output_cap_disposition: ModelUsageOutputCapDisposition | null;
  output_cap_recovery_source_event_id: string | null;
  output_cap_recovery_reason_code: ModelUsageOutputCapRecoveryReasonCode | null;
  output_cap_provider_available_tokens: number | string | null;
  output_cap_provider_minimum_tokens: number | string | null;
  output_cap_request_input_estimate: number | string | null;
  output_cap_configured_context_window_tokens: number | string | null;
  output_cap_safety_margin_tokens: number | string | null;
  output_cap_evidence_format: ModelUsageOutputCapEvidenceFormat | null;
  transport_retry_parent_event_id: string | null;
  transport_retry_reason: ModelUsageTransportRetryReason | null;
  transport_status: ModelUsageTransportStatus;
  dispatch_owner_id: string;
  dispatch_lease_expires_at: string;
  dispatch_uncertain_at: string | null;
  dispatch_uncertainty_reason: string | null;
  dispatch_reconciled_at: string | null;
  dispatch_reconciled_by: string | null;
  dispatch_reconciliation: ModelUsageDispatchReconciliation | null;
  dispatch_reconciliation_evidence: string | null;
  fallback_index: number | string;
  repair_index: number | string;
  workspace_id: string | null;
  session_id: string | null;
  turn_id: string | null;
  durable_run_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  assembly_run_id: string | null;
  assembly_round_index: number | string | null;
  assembly_stage: string | null;
  worker_id: string | null;
  utility_kind: string | null;
  credential_type: ModelUsageCredentialType;
  usage_pool: ModelUsagePool;
  credential_source: ModelUsageCredentialSource;
  credential_config_fingerprint: string | null;
  pricing_source: ModelUsagePricingSource;
  cost_source: ModelUsageCostSource;
  pricing_catalog_version: string | null;
  pricing_catalog_hash: string | null;
  input_rate_usd_per_million: number | string | null;
  output_rate_usd_per_million: number | string | null;
  cached_input_rate_usd_per_million: number | string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cached_input_tokens: number | string | null;
  cost_usd: number | string | null;
  availability: ModelUsageAvailability;
  terminal_outcome: ModelUsageTerminalOutcome;
  error_code: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | string | null;
}

const SELECT_COLUMNS = `
  event_id, idempotency_key, source, call_kind,
  requested_provider_id, requested_model_id, requested_reasoning_level, dispatched_reasoning_effort,
  reasoning_disposition, reasoning_reason_code,
  dispatched_model_id, effective_provider_id, effective_model_id, effective_api_style,
  route_decision_id, context_snapshot_id, context_intent_hash, context_entry_ref_id, context_resolution_hash,
  operation_id, parent_operation_id, dispatch_generation,
  attempt_index, transport_attempt_index,
  requested_output_token_cap, effective_output_token_cap, output_cap_disposition,
  output_cap_recovery_source_event_id, output_cap_recovery_reason_code,
  output_cap_provider_available_tokens, output_cap_provider_minimum_tokens,
  output_cap_request_input_estimate, output_cap_configured_context_window_tokens,
  output_cap_safety_margin_tokens, output_cap_evidence_format,
  transport_retry_parent_event_id, transport_retry_reason,
  transport_status, dispatch_owner_id, dispatch_lease_expires_at,
  dispatch_uncertain_at, dispatch_uncertainty_reason, dispatch_reconciled_at, dispatch_reconciled_by, dispatch_reconciliation,
  dispatch_reconciliation_evidence, fallback_index, repair_index,
  workspace_id, session_id, turn_id, durable_run_id, task_id, agent_id,
  assembly_run_id, assembly_round_index, assembly_stage, worker_id, utility_kind,
  credential_type, usage_pool, credential_source, credential_config_fingerprint,
  pricing_source, cost_source, pricing_catalog_version, pricing_catalog_hash,
  input_rate_usd_per_million, output_rate_usd_per_million, cached_input_rate_usd_per_million,
  input_tokens, output_tokens, cached_input_tokens, cost_usd,
  availability, terminal_outcome, error_code, started_at, finished_at, duration_ms
`;

export class ModelUsageEventRepository {
  private readonly insertStmt;
  private readonly findByEventIdStmt;
  private readonly findByEventIdForUpdateStmt;
  private readonly findByIdempotencyKeyStmt;
  private readonly finalizeStmt;
  private readonly acceptTransportStmt;
  private readonly renewTransportLeaseStmt;
  private readonly deleteIntentStmt;
  private readonly markDispatchUnknownStmt;
  private readonly recoverInterruptedIntentsStmt;
  private readonly recoverInterruptedAcceptedStmt;
  private readonly reconcileDispatchUnknownStmt;
  private readonly markCompatibilityProjectedStmt;
  private readonly insertCompatibilityCostStmt;
  private readonly applySessionUsageStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO model_usage_events (
        event_id, idempotency_key, source, call_kind,
        requested_provider_id, requested_model_id, requested_reasoning_level, dispatched_reasoning_effort,
        reasoning_disposition, reasoning_reason_code,
        dispatched_model_id, effective_provider_id, effective_model_id, effective_api_style,
        route_decision_id, context_snapshot_id, context_intent_hash, context_entry_ref_id, context_resolution_hash,
        operation_id, parent_operation_id, dispatch_generation,
        attempt_index, transport_attempt_index,
        requested_output_token_cap, effective_output_token_cap, output_cap_disposition,
        output_cap_recovery_source_event_id, output_cap_recovery_reason_code,
        output_cap_provider_available_tokens, output_cap_provider_minimum_tokens,
        output_cap_request_input_estimate, output_cap_configured_context_window_tokens,
        output_cap_safety_margin_tokens, output_cap_evidence_format,
        transport_retry_parent_event_id, transport_retry_reason,
        transport_status, dispatch_owner_id, dispatch_lease_expires_at,
        fallback_index, repair_index,
        workspace_id, session_id, turn_id, durable_run_id, task_id, agent_id,
        assembly_run_id, assembly_round_index, assembly_stage, worker_id, utility_kind,
        credential_type, usage_pool, credential_source, credential_config_fingerprint,
        pricing_source, cost_source, pricing_catalog_version, pricing_catalog_hash,
        input_rate_usd_per_million, output_rate_usd_per_million, cached_input_rate_usd_per_million,
        availability, terminal_outcome, started_at
      ) VALUES (
        @eventId, @idempotencyKey, @source, @callKind,
        @requestedProviderId, @requestedModelId, @requestedReasoningLevel, @dispatchedReasoningEffort,
        @reasoningDisposition, @reasoningReasonCode,
        @effectiveModelId, @effectiveProviderId, @effectiveModelId, @effectiveApiStyle,
        @routeDecisionId, @contextSnapshotId, @contextIntentHash, @contextEntryRefId, NULL,
        @operationId, @parentOperationId, @dispatchGeneration,
        @attemptIndex, @transportAttemptIndex,
        @requestedOutputTokenCap, @effectiveOutputTokenCap, @outputCapDisposition,
        @outputCapRecoverySourceEventId, @outputCapRecoveryReasonCode,
        @outputCapProviderAvailableTokens, @outputCapProviderMinimumTokens,
        @outputCapRequestInputEstimate, @outputCapConfiguredContextWindowTokens,
        @outputCapSafetyMarginTokens, @outputCapEvidenceFormat,
        @transportRetryParentEventId, @transportRetryReason,
        'intent', @dispatchOwnerId, @dispatchLeaseExpiresAt,
        @fallbackIndex, @repairIndex,
        @workspaceId, @sessionId, @turnId, @durableRunId, @taskId, @agentId,
        @assemblyRunId, @assemblyRoundIndex, @assemblyStage, @workerId, @utilityKind,
        @credentialType, @usagePool, @credentialSource, @credentialConfigFingerprint,
        'not_available', 'not_available', @pricingCatalogVersion, @pricingCatalogHash,
        @inputRateUsdPerMillion, @outputRateUsdPerMillion, @cachedInputRateUsdPerMillion,
        'unknown', 'in_flight', @startedAt
      )
      ON CONFLICT(idempotency_key) DO NOTHING
    `);
    this.findByEventIdStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM model_usage_events WHERE event_id = ?`);
    this.findByEventIdForUpdateStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM model_usage_events WHERE event_id = ?${
        db.dialect === "postgres" ? " FOR UPDATE" : ""
      }`,
    );
    this.findByIdempotencyKeyStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM model_usage_events WHERE idempotency_key = ?`,
    );
    this.acceptTransportStmt = db.prepare(`
      UPDATE model_usage_events
      SET transport_status = 'accepted',
          dispatch_lease_expires_at = @dispatchLeaseExpiresAt
      WHERE event_id = @eventId
        AND dispatch_owner_id = @dispatchOwnerId
        AND transport_status = 'intent'
        AND terminal_outcome = 'in_flight'
    `);
    this.renewTransportLeaseStmt = db.prepare(`
      UPDATE model_usage_events
      SET dispatch_lease_expires_at = @dispatchLeaseExpiresAt
      WHERE event_id = @eventId
        AND dispatch_owner_id = @dispatchOwnerId
        AND transport_status = 'accepted'
        AND terminal_outcome = 'in_flight'
    `);
    this.deleteIntentStmt = db.prepare(`
      DELETE FROM model_usage_events
      WHERE event_id = @eventId
        AND dispatch_owner_id = @dispatchOwnerId
        AND transport_status = 'intent'
        AND terminal_outcome = 'in_flight'
    `);
    this.markDispatchUnknownStmt = db.prepare(`
      UPDATE model_usage_events
      SET transport_status = 'dispatch_unknown',
          dispatch_uncertain_at = @uncertainAt,
          dispatch_uncertainty_reason = @reason,
          pricing_source = CASE
            WHEN input_rate_usd_per_million = 0
             AND output_rate_usd_per_million = 0
             AND cached_input_rate_usd_per_million = 0
             AND pricing_catalog_version IS NOT NULL
             AND pricing_catalog_hash IS NOT NULL
            THEN 'gateway_estimate' ELSE pricing_source END,
          cost_source = CASE
            WHEN input_rate_usd_per_million = 0
             AND output_rate_usd_per_million = 0
             AND cached_input_rate_usd_per_million = 0
             AND pricing_catalog_version IS NOT NULL
             AND pricing_catalog_hash IS NOT NULL
            THEN 'gateway_estimate' ELSE cost_source END,
          cost_usd = CASE
            WHEN input_rate_usd_per_million = 0
             AND output_rate_usd_per_million = 0
             AND cached_input_rate_usd_per_million = 0
             AND pricing_catalog_version IS NOT NULL
             AND pricing_catalog_hash IS NOT NULL
            THEN 0 ELSE cost_usd END,
          availability = CASE
            WHEN input_rate_usd_per_million = 0
             AND output_rate_usd_per_million = 0
             AND cached_input_rate_usd_per_million = 0
             AND pricing_catalog_version IS NOT NULL
             AND pricing_catalog_hash IS NOT NULL
            THEN 'tracked' ELSE availability END
      WHERE event_id = @eventId
        AND dispatch_owner_id = @dispatchOwnerId
        AND transport_status = 'intent'
        AND terminal_outcome = 'in_flight'
    `);
    this.recoverInterruptedIntentsStmt = db.prepare(buildRecoverInterruptedIntentsSql(db.dialect));
    this.recoverInterruptedAcceptedStmt = db.prepare(buildRecoverInterruptedAcceptedSql(db.dialect));
    this.reconcileDispatchUnknownStmt = db.prepare(`
      UPDATE model_usage_events
      SET dispatch_reconciled_at = @reconciledAt,
          dispatch_reconciled_by = @reconciledBy,
          dispatch_reconciliation = @reconciliation,
          dispatch_reconciliation_evidence = @evidence
      WHERE event_id = @eventId
        AND transport_status = 'dispatch_unknown'
        AND dispatch_reconciled_at IS NULL
    `);
    this.finalizeStmt = db.prepare(`
      UPDATE model_usage_events
      SET terminal_outcome = @terminalOutcome,
          effective_model_id = COALESCE(@reportedEffectiveModelId, effective_model_id),
          context_resolution_hash = COALESCE(@contextResolutionHash, context_resolution_hash),
          availability = @availability,
          pricing_source = @pricingSource,
          cost_source = @costSource,
          input_tokens = @inputTokens,
          output_tokens = @outputTokens,
          cached_input_tokens = @cachedInputTokens,
          cost_usd = @costUsd,
          error_code = @errorCode,
          finished_at = @finishedAt,
          duration_ms = @durationMs
      WHERE event_id = @eventId
        AND dispatch_owner_id = @dispatchOwnerId
        AND transport_status = 'accepted'
        AND terminal_outcome = 'in_flight'
    `);
    this.markCompatibilityProjectedStmt = db.prepare(`
      UPDATE model_usage_events
      SET compatibility_projected_at = @projectedAt
      WHERE event_id = @eventId
        AND compatibility_projected_at IS NULL
    `);
    this.insertCompatibilityCostStmt = db.prepare(`
      INSERT INTO cost_ledger (
        session_id, agent_id, task_id, provider_id, model_id, day,
        token_input, token_output, token_cached_input, cost_usd, created_at,
        credential_type, usage_pool, canonical_usage_event_id, usage_known_mask
      ) VALUES (
        @sessionId, @agentId, @taskId, @providerId, @modelId, @day,
        @tokenInput, @tokenOutput, @tokenCachedInput, @costUsd, @createdAt,
        @credentialType, @usagePool, @canonicalUsageEventId, @usageKnownMask
      )
      ON CONFLICT(canonical_usage_event_id) DO NOTHING
    `);
    this.applySessionUsageStmt = db.prepare(`
      UPDATE sessions
      SET token_input = token_input + @tokenInput,
          token_output = token_output + @tokenOutput,
          token_cached_input = token_cached_input + @tokenCachedInput,
          token_total = token_total + @tokenInput + @tokenOutput,
          cost_usd_total = cost_usd_total + @costUsd,
          last_activity_at = @timestamp,
          updated_at = @timestamp
      WHERE session_id = @sessionId
    `);
    // Recover only expired ownership leases. This preserves live reservations
    // on shared PostgreSQL while making both dispatch crash windows explicit.
    this.recoverExpiredBacklog(new Date().toISOString());
  }

  public begin(input: BeginModelUsageAttemptInput): BeginModelUsageAttemptResult {
    const normalized = normalizeBeginInput(input);
    return this.db.transaction("immediate", () => {
      let retrySource: ModelUsageEventRecord | undefined;
      if (normalized.transportRetryParentEventId) {
        retrySource = this.findByEventIdForUpdate(String(normalized.transportRetryParentEventId));
        assertTransportRetryLineage(retrySource, normalized);
      }
      if (normalized.outputCapDisposition === "reduced_retry") {
        assertOutputCapRecoveryLineage(retrySource, normalized);
      }
      const result = this.insertStmt.run(normalized);
      const record = this.findByIdempotencyKey(String(normalized.idempotencyKey));
      if (!record) {
        throw new Error("Model usage attempt was not persisted");
      }
      assertSameAttemptIdentity(record, normalized);
      return { record, inserted: result.changes > 0 };
    });
  }

  public finalize(eventId: string, input: FinalizeModelUsageAttemptInput): FinalizeModelUsageAttemptResult {
    const normalized = normalizeFinalizeInput(input);
    const prior = this.findByEventId(eventId);
    if (!prior) {
      throw new Error(`Unknown model usage event: ${eventId}`);
    }
    if (prior.dispatchOwnerId !== normalized.dispatchOwnerId) {
      throw new Error("Model usage attempt cannot be finalized by a different dispatch owner");
    }
    assertCostProvenance(prior, normalized);
    const result = this.finalizeStmt.run({ eventId, ...normalized });
    const record = this.findByEventId(eventId);
    if (!record) {
      throw new Error(`Unknown model usage event: ${eventId}`);
    }
    if (result.changes === 0) {
      assertSameFinalization(record, normalized);
    }
    return { record, finalized: result.changes > 0 };
  }

  public acceptTransport(
    eventId: string,
    dispatchOwnerId: string,
    dispatchLeaseExpiresAt: string,
  ): ModelUsageEventRecord {
    const result = this.acceptTransportStmt.run({
      eventId: requireBoundedText(eventId, "eventId"),
      dispatchOwnerId: requireBoundedText(dispatchOwnerId, "dispatchOwnerId"),
      dispatchLeaseExpiresAt: requireCanonicalIso(dispatchLeaseExpiresAt, "dispatchLeaseExpiresAt"),
    });
    const record = this.findByEventId(eventId);
    if (!record) throw new Error(`Unknown model usage event: ${eventId}`);
    if (record.dispatchOwnerId !== dispatchOwnerId) {
      throw new Error("Model usage transport intent cannot be accepted by a different dispatch owner");
    }
    if (result.changes === 0 && record.transportStatus !== "accepted") {
      throw new Error(`Model usage transport intent cannot be accepted from ${record.transportStatus}`);
    }
    return record;
  }

  public renewTransportLease(
    eventId: string,
    dispatchOwnerId: string,
    dispatchLeaseExpiresAt: string,
  ): ModelUsageEventRecord {
    const result = this.renewTransportLeaseStmt.run({
      eventId: requireBoundedText(eventId, "eventId"),
      dispatchOwnerId: requireBoundedText(dispatchOwnerId, "dispatchOwnerId"),
      dispatchLeaseExpiresAt: requireCanonicalIso(dispatchLeaseExpiresAt, "dispatchLeaseExpiresAt"),
    });
    const record = this.findByEventId(eventId);
    if (!record) throw new Error(`Unknown model usage event: ${eventId}`);
    if (result.changes === 0) throw new Error("Model usage transport lease cannot be renewed by this owner");
    return record;
  }

  public abandonTransportIntent(eventId: string, dispatchOwnerId: string): boolean {
    return (
      this.deleteIntentStmt.run({
        eventId: requireBoundedText(eventId, "eventId"),
        dispatchOwnerId: requireBoundedText(dispatchOwnerId, "dispatchOwnerId"),
      }).changes > 0
    );
  }

  public markDispatchUnknown(
    eventId: string,
    dispatchOwnerId: string,
    uncertainAt: string,
    reason: string,
  ): ModelUsageEventRecord {
    const result = this.markDispatchUnknownStmt.run({
      eventId: requireBoundedText(eventId, "eventId"),
      dispatchOwnerId: requireBoundedText(dispatchOwnerId, "dispatchOwnerId"),
      uncertainAt: requireCanonicalIso(uncertainAt, "uncertainAt"),
      reason: requireBoundedText(reason, "reason", 128),
    });
    const record = this.findByEventId(eventId);
    if (!record) throw new Error(`Unknown model usage event: ${eventId}`);
    if (result.changes === 0 && record.transportStatus !== "dispatch_unknown") {
      throw new Error("Model usage dispatch cannot be marked unknown by this owner");
    }
    return record;
  }

  public recoverExpiredIntents(recoveredAt: string, limit = 1_000): number {
    const boundedLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
    return this.recoverInterruptedIntentsStmt.run({
      recoveredAt: requireCanonicalIso(recoveredAt, "recoveredAt"),
      limit: boundedLimit,
    }).changes;
  }

  public recoverExpiredAcceptedDispatches(recoveredAt: string, limit = 1_000): number {
    const boundedLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
    return this.recoverInterruptedAcceptedStmt.run({
      recoveredAt: requireCanonicalIso(recoveredAt, "recoveredAt"),
      limit: boundedLimit,
    }).changes;
  }

  /**
   * Repeated bounded recovery for startup and periodic sweeps. PostgreSQL
   * workers select with row locks and SKIP LOCKED; a later sweep picks up rows
   * that were actively owned during this pass.
   */
  public recoverExpiredBacklog(
    recoveredAt: string,
    options: { batchSize?: number; maxBatches?: number } = {},
  ): ModelUsageRecoverySweepResult {
    const normalizedRecoveredAt = requireCanonicalIso(recoveredAt, "recoveredAt");
    const batchSize = Math.max(1, Math.min(10_000, Math.floor(options.batchSize ?? 10_000)));
    const maxBatches = Math.max(1, Math.min(1_000, Math.floor(options.maxBatches ?? 100)));
    let recoveredIntentCount = 0;
    let recoveredAcceptedCount = 0;
    let batchCount = 0;
    let lastIntentCount: number;
    let lastAcceptedCount: number;
    do {
      lastIntentCount = this.recoverExpiredIntents(normalizedRecoveredAt, batchSize);
      lastAcceptedCount = this.recoverExpiredAcceptedDispatches(normalizedRecoveredAt, batchSize);
      recoveredIntentCount += lastIntentCount;
      recoveredAcceptedCount += lastAcceptedCount;
      batchCount += 1;
      if (lastIntentCount < batchSize && lastAcceptedCount < batchSize) break;
    } while (batchCount < maxBatches);
    return {
      recoveredIntentCount,
      recoveredAcceptedCount,
      batchCount,
      batchLimitReached: batchCount >= maxBatches && (lastIntentCount >= batchSize || lastAcceptedCount >= batchSize),
    };
  }

  public reconcileDispatchUnknown(eventId: string, input: ReconcileModelUsageDispatchInput): ModelUsageEventRecord {
    const normalized = {
      eventId: requireBoundedText(eventId, "eventId"),
      reconciliation: input.reconciliation,
      reconciledAt: requireCanonicalIso(input.reconciledAt, "reconciledAt"),
      evidence: boundedEvidence(input.evidence),
      reconciledBy: optionalBoundedText(input.reconciledBy, "reconciledBy"),
    };
    const result = this.reconcileDispatchUnknownStmt.run(normalized);
    const record = this.findByEventId(eventId);
    if (!record) throw new Error(`Unknown model usage event: ${eventId}`);
    if (result.changes === 0) {
      const matches =
        record.transportStatus === "dispatch_unknown" &&
        record.dispatchReconciliation === input.reconciliation &&
        record.dispatchReconciledBy === (normalized.reconciledBy ?? undefined) &&
        record.dispatchReconciliationEvidence === normalized.evidence;
      if (!matches) throw new Error("Dispatch uncertainty already has conflicting reconciliation evidence");
    }
    return record;
  }

  /**
   * Finalize canonical truth and, when every legacy numeric field is known,
   * project it to cost/session totals in the same transaction. The projection
   * claim, unique cost row, session delta, and marker commit together, so a
   * crash or concurrent finalizer cannot lose or double-apply totals.
   */
  public finalizeAndProject(
    eventId: string,
    input: FinalizeModelUsageAttemptInput,
  ): FinalizeModelUsageAttemptResult & { compatibilityProjected: boolean } {
    return this.db.transaction("immediate", () => {
      const finalized = this.finalize(eventId, input);
      const claimed = this.markCompatibilityProjectedStmt.run({ eventId, projectedAt: input.finishedAt }).changes > 0;
      if (!claimed) {
        return { ...finalized, compatibilityProjected: false };
      }
      const record = finalized.record;
      const usageKnownMask = buildUsageKnownMask(record);
      if (record.sessionId && usageKnownMask) {
        const inserted = this.insertCompatibilityCostStmt.run({
          sessionId: record.sessionId,
          agentId: record.agentId ?? null,
          taskId: record.taskId ?? null,
          providerId: record.effectiveProviderId ?? null,
          modelId: record.effectiveModelId ?? null,
          day: record.finishedAt?.slice(0, 10) ?? record.startedAt.slice(0, 10),
          tokenInput: record.inputTokens ?? 0,
          tokenOutput: record.outputTokens ?? 0,
          tokenCachedInput: record.cachedInputTokens ?? 0,
          costUsd: record.costUsd ?? 0,
          createdAt: record.finishedAt ?? record.startedAt,
          credentialType: record.credentialType,
          usagePool: record.usagePool,
          canonicalUsageEventId: record.eventId,
          usageKnownMask,
        });
        if (inserted.changes > 0) {
          this.applySessionUsageStmt.run({
            sessionId: record.sessionId,
            tokenInput: record.inputTokens ?? 0,
            tokenOutput: record.outputTokens ?? 0,
            tokenCachedInput: record.cachedInputTokens ?? 0,
            costUsd: record.costUsd ?? 0,
            timestamp: record.finishedAt ?? record.startedAt,
          });
        }
      }
      return { ...finalized, compatibilityProjected: true };
    });
  }

  public findByEventId(eventId: string): ModelUsageEventRecord | undefined {
    const row = this.findByEventIdStmt.get<ModelUsageEventRow>(eventId);
    return row ? mapRow(row) : undefined;
  }

  /** Lock canonical evidence before transactionally fenced ownership validation. */
  public findByEventIdForUpdate(eventId: string): ModelUsageEventRecord | undefined {
    const row = this.findByEventIdForUpdateStmt.get<ModelUsageEventRow>(eventId);
    return row ? mapRow(row) : undefined;
  }

  public findByIdempotencyKey(idempotencyKey: string): ModelUsageEventRecord | undefined {
    const row = this.findByIdempotencyKeyStmt.get<ModelUsageEventRow>(idempotencyKey);
    return row ? mapRow(row) : undefined;
  }

  public list(query: ModelUsageEventListQuery = {}): ModelUsageEventListResponse {
    const limit = Math.max(1, Math.min(200, Math.floor(query.limit ?? 50)));
    const cursor = parseCursor(query.cursor);
    const params = buildListParams(query, cursor, limit + 1);
    const where = buildWhereClause();
    const rows = this.db
      .prepare(
        `
        SELECT ${SELECT_COLUMNS}
        FROM model_usage_events
        WHERE transport_status IN ('accepted', 'dispatch_unknown')
          AND ${where}
        ORDER BY started_at DESC, event_id DESC
        LIMIT @limit
      `,
      )
      .all<ModelUsageEventRow>(params);
    const hasNext = rows.length > limit;
    const items = rows.slice(0, limit).map(mapRow);
    const summaryRow = this.db
      .prepare(
        `
        SELECT
          SUM(CASE WHEN transport_status = 'accepted'
              OR (transport_status = 'dispatch_unknown' AND dispatch_reconciliation = 'confirmed_dispatched_usage_unknown')
            THEN 1 ELSE 0 END) AS attempt_count,
          SUM(CASE WHEN transport_status = 'dispatch_unknown'
              AND (dispatch_reconciliation IS NULL OR dispatch_reconciliation = 'superseded_by_new_generation')
            THEN 1 ELSE 0 END) AS uncertain_dispatch_count,
          SUM(CASE WHEN transport_status = 'accepted' AND availability = 'tracked' THEN 1 ELSE 0 END) AS tracked_count,
          SUM(CASE WHEN (transport_status = 'accepted' AND availability = 'unknown')
              OR (transport_status = 'dispatch_unknown' AND dispatch_reconciliation = 'confirmed_dispatched_usage_unknown')
            THEN 1 ELSE 0 END) AS unknown_count,
          SUM(CASE WHEN transport_status = 'accepted' THEN input_tokens END) AS input_tokens,
          SUM(CASE WHEN transport_status = 'accepted' THEN output_tokens END) AS output_tokens,
          SUM(CASE WHEN transport_status = 'accepted' THEN cached_input_tokens END) AS cached_input_tokens,
          SUM(CASE WHEN transport_status = 'accepted'
              OR (transport_status = 'dispatch_unknown'
                AND (dispatch_reconciliation IS NULL OR dispatch_reconciliation <> 'confirmed_not_dispatched'))
            THEN cost_usd END) AS cost_usd,
          SUM(CASE WHEN transport_status = 'accepted' AND input_tokens IS NOT NULL THEN 1 ELSE 0 END) AS input_known_count,
          SUM(CASE WHEN transport_status = 'accepted' AND output_tokens IS NOT NULL THEN 1 ELSE 0 END) AS output_known_count,
          SUM(CASE WHEN transport_status = 'accepted' AND cached_input_tokens IS NOT NULL THEN 1 ELSE 0 END) AS cached_known_count,
          SUM(CASE WHEN cost_usd IS NOT NULL AND (
              transport_status = 'accepted'
              OR (transport_status = 'dispatch_unknown'
                AND (dispatch_reconciliation IS NULL OR dispatch_reconciliation <> 'confirmed_not_dispatched'))
            ) THEN 1 ELSE 0 END) AS cost_known_count
        FROM model_usage_events
        WHERE ${buildWhereClause({ includeCursor: false })}
      `,
      )
      .get<Record<string, number | string | null>>({
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        durableRunId: params.durableRunId,
        taskId: params.taskId,
        assemblyRunId: params.assemblyRunId,
        from: params.from,
        to: params.to,
        availability: params.availability,
      });
    const last = items.at(-1);
    return {
      items,
      summary: mapSummary(summaryRow),
      ...(hasNext && last ? { nextCursor: encodeCursor(last.startedAt, last.eventId) } : {}),
    };
  }

  /**
   * Bounded retention cleanup. Accepted in-flight attempts and unreconciled
   * uncertain dispatches are retained for operator reconciliation. A crash
   * window record becomes eligible only after explicit reconciliation.
   */
  public pruneTerminalBefore(cutoff: string, limit = 1_000): number {
    const boundedLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
    return this.db
      .prepare(
        `
        DELETE FROM model_usage_events
        WHERE event_id IN (
          SELECT event_id
          FROM model_usage_events
          WHERE (
              transport_status = 'accepted'
              AND terminal_outcome <> 'in_flight'
              AND finished_at IS NOT NULL
              AND finished_at < @cutoff
            ) OR (
              transport_status = 'dispatch_unknown'
              AND dispatch_reconciled_at IS NOT NULL
              AND dispatch_reconciliation <> 'superseded_by_new_generation'
              AND dispatch_reconciled_at < @cutoff
            )
          ORDER BY COALESCE(finished_at, dispatch_reconciled_at) ASC, event_id ASC
          LIMIT @limit
        )
      `,
      )
      .run({ cutoff: requireCanonicalIso(cutoff, "cutoff"), limit: boundedLimit }).changes;
  }

  public deleteForSession(sessionId: string): number {
    return this.db
      .prepare("DELETE FROM model_usage_events WHERE session_id = ?")
      .run(requireBoundedText(sessionId, "sessionId")).changes;
  }

  public deleteForWorkspace(workspaceId: string): number {
    return this.db
      .prepare("DELETE FROM model_usage_events WHERE workspace_id = ?")
      .run(requireBoundedText(workspaceId, "workspaceId")).changes;
  }
}

function buildRecoverInterruptedIntentsSql(dialect: DatabaseClient["dialect"]): string {
  const setClause = `
    transport_status = 'dispatch_unknown',
    dispatch_uncertain_at = @recoveredAt,
    dispatch_uncertainty_reason = 'process_restart_before_transport_acceptance',
    pricing_source = CASE
      WHEN input_rate_usd_per_million = 0
       AND output_rate_usd_per_million = 0
       AND cached_input_rate_usd_per_million = 0
       AND pricing_catalog_version IS NOT NULL
       AND pricing_catalog_hash IS NOT NULL
      THEN 'gateway_estimate' ELSE pricing_source END,
    cost_source = CASE
      WHEN input_rate_usd_per_million = 0
       AND output_rate_usd_per_million = 0
       AND cached_input_rate_usd_per_million = 0
       AND pricing_catalog_version IS NOT NULL
       AND pricing_catalog_hash IS NOT NULL
      THEN 'gateway_estimate' ELSE cost_source END,
    cost_usd = CASE
      WHEN input_rate_usd_per_million = 0
       AND output_rate_usd_per_million = 0
       AND cached_input_rate_usd_per_million = 0
       AND pricing_catalog_version IS NOT NULL
       AND pricing_catalog_hash IS NOT NULL
      THEN 0 ELSE cost_usd END,
    availability = CASE
      WHEN input_rate_usd_per_million = 0
       AND output_rate_usd_per_million = 0
       AND cached_input_rate_usd_per_million = 0
       AND pricing_catalog_version IS NOT NULL
       AND pricing_catalog_hash IS NOT NULL
      THEN 'tracked' ELSE availability END
  `;
  if (dialect === "postgres") {
    return `
      WITH expired AS (
        SELECT event_id
        FROM model_usage_events
        WHERE transport_status = 'intent'
          AND terminal_outcome = 'in_flight'
          AND dispatch_lease_expires_at <= @recoveredAt
        ORDER BY started_at ASC, event_id ASC
        LIMIT @limit
        FOR UPDATE SKIP LOCKED
      )
      UPDATE model_usage_events AS target
      SET ${setClause}
      FROM expired
      WHERE target.event_id = expired.event_id
        AND target.transport_status = 'intent'
        AND target.terminal_outcome = 'in_flight'
        AND target.dispatch_lease_expires_at <= @recoveredAt
    `;
  }
  return `
    UPDATE model_usage_events
    SET ${setClause}
    WHERE event_id IN (
      SELECT event_id
      FROM model_usage_events
      WHERE transport_status = 'intent'
        AND terminal_outcome = 'in_flight'
        AND dispatch_lease_expires_at <= @recoveredAt
      ORDER BY started_at ASC, event_id ASC
      LIMIT @limit
    )
      AND transport_status = 'intent'
      AND terminal_outcome = 'in_flight'
      AND dispatch_lease_expires_at <= @recoveredAt
  `;
}

function buildRecoverInterruptedAcceptedSql(dialect: DatabaseClient["dialect"]): string {
  const setClause = `
    terminal_outcome = 'interrupted_after_dispatch',
    availability = CASE
      WHEN input_rate_usd_per_million = 0
       AND output_rate_usd_per_million = 0
       AND cached_input_rate_usd_per_million = 0
       AND pricing_catalog_version IS NOT NULL
       AND pricing_catalog_hash IS NOT NULL
      THEN 'tracked' ELSE 'unknown' END,
    pricing_source = CASE
      WHEN input_rate_usd_per_million = 0
       AND output_rate_usd_per_million = 0
       AND cached_input_rate_usd_per_million = 0
       AND pricing_catalog_version IS NOT NULL
       AND pricing_catalog_hash IS NOT NULL
      THEN 'gateway_estimate' ELSE 'not_available' END,
    cost_source = CASE
      WHEN input_rate_usd_per_million = 0
       AND output_rate_usd_per_million = 0
       AND cached_input_rate_usd_per_million = 0
       AND pricing_catalog_version IS NOT NULL
       AND pricing_catalog_hash IS NOT NULL
      THEN 'gateway_estimate' ELSE 'not_available' END,
    cost_usd = CASE
      WHEN input_rate_usd_per_million = 0
       AND output_rate_usd_per_million = 0
       AND cached_input_rate_usd_per_million = 0
       AND pricing_catalog_version IS NOT NULL
       AND pricing_catalog_hash IS NOT NULL
      THEN 0 ELSE NULL END,
    error_code = 'process_restart_after_transport_acceptance',
    finished_at = @recoveredAt,
    duration_ms = 0
  `;
  if (dialect === "postgres") {
    return `
      WITH expired AS (
        SELECT event_id
        FROM model_usage_events
        WHERE transport_status = 'accepted'
          AND terminal_outcome = 'in_flight'
          AND dispatch_lease_expires_at <= @recoveredAt
        ORDER BY started_at ASC, event_id ASC
        LIMIT @limit
        FOR UPDATE SKIP LOCKED
      )
      UPDATE model_usage_events AS target
      SET ${setClause}
      FROM expired
      WHERE target.event_id = expired.event_id
        AND target.transport_status = 'accepted'
        AND target.terminal_outcome = 'in_flight'
        AND target.dispatch_lease_expires_at <= @recoveredAt
    `;
  }
  return `
    UPDATE model_usage_events
    SET ${setClause}
    WHERE event_id IN (
      SELECT event_id
      FROM model_usage_events
      WHERE transport_status = 'accepted'
        AND terminal_outcome = 'in_flight'
        AND dispatch_lease_expires_at <= @recoveredAt
      ORDER BY started_at ASC, event_id ASC
      LIMIT @limit
    )
      AND transport_status = 'accepted'
      AND terminal_outcome = 'in_flight'
      AND dispatch_lease_expires_at <= @recoveredAt
  `;
}

function normalizeBeginInput(input: BeginModelUsageAttemptInput): Record<string, unknown> {
  const pricingCatalogVersion = optionalBoundedText(input.pricingCatalogVersion, "pricingCatalogVersion", 128);
  const pricingCatalogHash = optionalSha256(input.pricingCatalogHash, "pricingCatalogHash");
  const rates = {
    inputRateUsdPerMillion: optionalNonNegativeNumber(input.inputRateUsdPerMillion, "inputRateUsdPerMillion"),
    outputRateUsdPerMillion: optionalNonNegativeNumber(input.outputRateUsdPerMillion, "outputRateUsdPerMillion"),
    cachedInputRateUsdPerMillion: optionalNonNegativeNumber(
      input.cachedInputRateUsdPerMillion,
      "cachedInputRateUsdPerMillion",
    ),
  };
  const rateValues = Object.values(rates);
  const hasAnyRate = rateValues.some((value) => value !== null);
  const hasAllRates = rateValues.every((value) => value !== null);
  if ((pricingCatalogVersion === null) !== (pricingCatalogHash === null)) {
    throw new TypeError("pricing catalog version and hash must be supplied together");
  }
  if (hasAnyRate && (!hasAllRates || pricingCatalogVersion === null || pricingCatalogHash === null)) {
    throw new TypeError("pricing rates require a frozen pricing catalog version, SHA-256 hash, and all exact rates");
  }
  const transportRetry = normalizeTransportRetryLineage(input);
  const outputCap = normalizeOutputCapLineage(input, transportRetry);
  return {
    ...input,
    eventId: requireBoundedText(input.eventId, "eventId"),
    idempotencyKey: requireBoundedText(input.idempotencyKey, "idempotencyKey", 1_024),
    operationId: requireBoundedText(input.operationId, "operationId"),
    dispatchGeneration: requireBoundedText(input.dispatchGeneration, "dispatchGeneration"),
    requestedProviderId: optionalBoundedText(input.requestedProviderId, "requestedProviderId"),
    requestedModelId: optionalBoundedText(input.requestedModelId, "requestedModelId"),
    requestedReasoningLevel: optionalBoundedText(input.requestedReasoningLevel, "requestedReasoningLevel", 128),
    dispatchedReasoningEffort: optionalBoundedText(input.dispatchedReasoningEffort, "dispatchedReasoningEffort", 128),
    reasoningDisposition: input.reasoningDisposition ?? null,
    reasoningReasonCode: optionalBoundedText(input.reasoningReasonCode, "reasoningReasonCode", 128),
    effectiveProviderId: optionalBoundedText(input.effectiveProviderId, "effectiveProviderId"),
    effectiveModelId: optionalBoundedText(input.effectiveModelId, "effectiveModelId"),
    effectiveApiStyle: optionalBoundedText(input.effectiveApiStyle, "effectiveApiStyle", 128),
    routeDecisionId: optionalBoundedText(input.routeDecisionId, "routeDecisionId"),
    contextSnapshotId: optionalBoundedText(input.contextSnapshotId, "contextSnapshotId"),
    contextIntentHash: optionalBoundedText(input.contextIntentHash, "contextIntentHash", 256),
    contextEntryRefId: optionalBoundedText(input.contextEntryRefId, "contextEntryRefId"),
    parentOperationId: optionalBoundedText(input.parentOperationId, "parentOperationId"),
    dispatchOwnerId: requireBoundedText(input.dispatchOwnerId, "dispatchOwnerId"),
    dispatchLeaseExpiresAt: requireCanonicalIso(input.dispatchLeaseExpiresAt, "dispatchLeaseExpiresAt"),
    workspaceId: optionalBoundedText(input.workspaceId, "workspaceId"),
    sessionId: optionalBoundedText(input.sessionId, "sessionId"),
    turnId: optionalBoundedText(input.turnId, "turnId"),
    durableRunId: optionalBoundedText(input.durableRunId, "durableRunId"),
    taskId: optionalBoundedText(input.taskId, "taskId"),
    agentId: optionalBoundedText(input.agentId, "agentId"),
    assemblyRunId: optionalBoundedText(input.assemblyRunId, "assemblyRunId"),
    assemblyRoundIndex: optionalNonNegativeInteger(input.assemblyRoundIndex, "assemblyRoundIndex"),
    assemblyStage: optionalBoundedText(input.assemblyStage, "assemblyStage", 128),
    workerId: optionalBoundedText(input.workerId, "workerId"),
    utilityKind: optionalBoundedText(input.utilityKind, "utilityKind", 128),
    credentialConfigFingerprint: optionalSha256(input.credentialConfigFingerprint, "credentialConfigFingerprint"),
    pricingCatalogVersion,
    pricingCatalogHash,
    ...rates,
    attemptIndex: nonNegativeInteger(input.attemptIndex, "attemptIndex"),
    transportAttemptIndex: nonNegativeInteger(input.transportAttemptIndex, "transportAttemptIndex"),
    ...transportRetry,
    ...outputCap,
    fallbackIndex: nonNegativeInteger(input.fallbackIndex, "fallbackIndex"),
    repairIndex: nonNegativeInteger(input.repairIndex, "repairIndex"),
    startedAt: requireCanonicalIso(input.startedAt, "startedAt"),
  };
}

function normalizeTransportRetryLineage(input: BeginModelUsageAttemptInput): Record<string, unknown> {
  const parentEventId = optionalBoundedText(input.transportRetryParentEventId, "transportRetryParentEventId");
  const reason = input.transportRetryReason ?? null;
  if ((parentEventId === null) !== (reason === null)) {
    throw new TypeError("transport retry parent and reason must be supplied together");
  }
  if (reason !== null && reason !== "output_cap_recovery" && reason !== "metadata_compatibility") {
    throw new TypeError("unsupported transport retry reason");
  }
  return {
    transportRetryParentEventId: parentEventId,
    transportRetryReason: reason,
  };
}

function normalizeOutputCapLineage(
  input: BeginModelUsageAttemptInput,
  transportRetry: Record<string, unknown>,
): Record<string, unknown> {
  const requested = optionalNonNegativeInteger(input.requestedOutputTokenCap, "requestedOutputTokenCap");
  const effective = optionalNonNegativeInteger(input.effectiveOutputTokenCap, "effectiveOutputTokenCap");
  const disposition = input.outputCapDisposition ?? null;
  const sourceEventId = optionalBoundedText(input.outputCapRecoverySourceEventId, "outputCapRecoverySourceEventId");
  const reasonCode = input.outputCapRecoveryReasonCode ?? null;
  const providerAvailable = optionalNonNegativeInteger(
    input.outputCapProviderAvailableTokens,
    "outputCapProviderAvailableTokens",
  );
  const providerMinimum = optionalNonNegativeInteger(
    input.outputCapProviderMinimumTokens,
    "outputCapProviderMinimumTokens",
  );
  const requestEstimate = optionalNonNegativeInteger(
    input.outputCapRequestInputEstimate,
    "outputCapRequestInputEstimate",
  );
  const configuredContextWindow = optionalNonNegativeInteger(
    input.outputCapConfiguredContextWindowTokens,
    "outputCapConfiguredContextWindowTokens",
  );
  const safetyMargin = optionalNonNegativeInteger(input.outputCapSafetyMarginTokens, "outputCapSafetyMarginTokens");
  const evidenceFormat = input.outputCapEvidenceFormat ?? null;
  if (
    evidenceFormat !== null &&
    !["anthropic_equation", "bounded_range", "context_breakdown", "character_prompt", "vllm_context"].includes(
      evidenceFormat,
    )
  ) {
    throw new TypeError("unsupported output-cap evidence format");
  }
  const fields = [requested, effective, disposition];
  const hasAnyCore = fields.some((value) => value !== null);
  const hasAllCore = fields.every((value) => value !== null);
  if (hasAnyCore !== hasAllCore) {
    throw new TypeError("requested/effective output caps and disposition must be supplied together");
  }
  if (!hasAnyCore) {
    if (
      [
        sourceEventId,
        reasonCode,
        providerAvailable,
        providerMinimum,
        requestEstimate,
        configuredContextWindow,
        safetyMargin,
        evidenceFormat,
      ].some((value) => value !== null)
    ) {
      throw new TypeError("output-cap recovery evidence requires requested/effective cap lineage");
    }
    if (transportRetry.transportRetryReason === "output_cap_recovery") {
      throw new TypeError("output-cap transport retries require requested/effective cap lineage");
    }
    return {
      requestedOutputTokenCap: null,
      effectiveOutputTokenCap: null,
      outputCapDisposition: null,
      outputCapRecoverySourceEventId: null,
      outputCapRecoveryReasonCode: null,
      outputCapProviderAvailableTokens: null,
      outputCapProviderMinimumTokens: null,
      outputCapRequestInputEstimate: null,
      outputCapConfiguredContextWindowTokens: null,
      outputCapSafetyMarginTokens: null,
      outputCapEvidenceFormat: null,
    };
  }
  if ((requested ?? 0) < 1 || (effective ?? 0) < 1 || (effective ?? 0) > (requested ?? 0)) {
    throw new TypeError("output caps must be positive and the effective cap cannot exceed the requested cap");
  }
  if (disposition === "initial") {
    if (effective !== requested) throw new TypeError("initial output-cap lineage must preserve the requested cap");
    if (transportRetry.transportRetryReason !== null) {
      throw new TypeError("transport retries cannot be recorded as initial output-cap attempts");
    }
    if (
      [
        sourceEventId,
        reasonCode,
        providerAvailable,
        providerMinimum,
        requestEstimate,
        configuredContextWindow,
        safetyMargin,
        evidenceFormat,
      ].some((value) => value !== null)
    ) {
      throw new TypeError("initial output-cap lineage cannot carry retry evidence");
    }
  } else if (disposition === "preserved_retry") {
    if (
      transportRetry.transportRetryReason !== "metadata_compatibility" ||
      !transportRetry.transportRetryParentEventId ||
      [
        sourceEventId,
        reasonCode,
        providerAvailable,
        providerMinimum,
        requestEstimate,
        configuredContextWindow,
        safetyMargin,
        evidenceFormat,
      ].some((value) => value !== null)
    ) {
      throw new TypeError("preserved output-cap retries require metadata-compatibility lineage without cap evidence");
    }
  } else if (disposition === "reduced_retry") {
    if (
      effective === requested ||
      !sourceEventId ||
      transportRetry.transportRetryReason !== "output_cap_recovery" ||
      transportRetry.transportRetryParentEventId !== sourceEventId ||
      reasonCode !== "safe_lower_cap" ||
      (providerAvailable ?? 0) < 1 ||
      (providerMinimum !== null && providerMinimum < 1) ||
      (requestEstimate ?? 0) < 1 ||
      (configuredContextWindow ?? 0) < 1 ||
      safetyMargin === null ||
      !evidenceFormat
    ) {
      throw new TypeError("reduced output-cap retries require complete prior-attempt and budget evidence");
    }
  } else {
    throw new TypeError("unsupported output-cap disposition");
  }
  return {
    requestedOutputTokenCap: requested,
    effectiveOutputTokenCap: effective,
    outputCapDisposition: disposition,
    outputCapRecoverySourceEventId: sourceEventId,
    outputCapRecoveryReasonCode: reasonCode,
    outputCapProviderAvailableTokens: providerAvailable,
    outputCapProviderMinimumTokens: providerMinimum,
    outputCapRequestInputEstimate: requestEstimate,
    outputCapConfiguredContextWindowTokens: configuredContextWindow,
    outputCapSafetyMarginTokens: safetyMargin,
    outputCapEvidenceFormat: evidenceFormat,
  };
}

function normalizeFinalizeInput(input: FinalizeModelUsageAttemptInput): Record<string, unknown> {
  const numbers = {
    inputTokens: optionalNonNegativeInteger(input.inputTokens, "inputTokens"),
    outputTokens: optionalNonNegativeInteger(input.outputTokens, "outputTokens"),
    cachedInputTokens: optionalNonNegativeInteger(input.cachedInputTokens, "cachedInputTokens"),
    costUsd: optionalNonNegativeNumber(input.costUsd, "costUsd"),
  };
  const hasUsage = Object.values(numbers).some((value) => value !== null);
  if ((input.availability === "tracked") !== hasUsage) {
    throw new TypeError("availability must be tracked exactly when at least one usage field is known");
  }
  if (input.terminalOutcome === "failed_before_usage" && hasUsage) {
    throw new TypeError("failed_before_usage cannot carry usage values");
  }
  if (input.terminalOutcome === "failed_after_usage" && !hasUsage) {
    throw new TypeError("failed_after_usage requires at least one usage value");
  }
  return {
    ...input,
    dispatchOwnerId: requireBoundedText(input.dispatchOwnerId, "dispatchOwnerId"),
    ...numbers,
    reportedEffectiveModelId: optionalBoundedText(input.reportedEffectiveModelId, "reportedEffectiveModelId"),
    contextResolutionHash: optionalBoundedText(input.contextResolutionHash, "contextResolutionHash", 256),
    errorCode: optionalBoundedText(input.errorCode, "errorCode", 128),
    finishedAt: requireCanonicalIso(input.finishedAt, "finishedAt"),
    durationMs: nonNegativeInteger(input.durationMs, "durationMs"),
  };
}

function assertCostProvenance(attempt: ModelUsageEventRecord, input: Record<string, unknown>): void {
  const hasCost = input.costUsd !== null && input.costUsd !== undefined;
  if (!hasCost) {
    if (input.costSource !== "not_available" || input.pricingSource !== "not_available") {
      throw new TypeError("absent cost must use not_available cost and pricing provenance");
    }
    return;
  }
  if (input.costSource === "not_available" || input.pricingSource === "not_available") {
    throw new TypeError("known cost requires explicit cost and pricing provenance");
  }
  if (input.costSource !== input.pricingSource) {
    throw new TypeError("costSource and pricingSource must describe the same canonical cost evidence");
  }
  if (input.costSource === "gateway_estimate") {
    if (
      !attempt.pricingCatalogVersion ||
      !attempt.pricingCatalogHash ||
      attempt.inputRateUsdPerMillion === undefined ||
      attempt.outputRateUsdPerMillion === undefined ||
      attempt.cachedInputRateUsdPerMillion === undefined
    ) {
      throw new TypeError("gateway_estimate cost requires a frozen pricing catalog hash and exact rates");
    }
  }
}

function buildListParams(
  query: ModelUsageEventListQuery,
  cursor: { startedAt: string; eventId: string } | undefined,
  limit: number,
): Record<string, unknown> {
  return {
    workspaceId: optionalBoundedText(query.workspaceId, "workspaceId"),
    sessionId: optionalBoundedText(query.sessionId, "sessionId"),
    turnId: optionalBoundedText(query.turnId, "turnId"),
    durableRunId: optionalBoundedText(query.durableRunId, "durableRunId"),
    taskId: optionalBoundedText(query.taskId, "taskId"),
    assemblyRunId: optionalBoundedText(query.assemblyRunId, "assemblyRunId"),
    from: query.from ? requireCanonicalIso(query.from, "from") : null,
    to: query.to ? requireCanonicalIso(query.to, "to") : null,
    availability: query.availability ?? null,
    cursorStartedAt: cursor?.startedAt ?? null,
    cursorEventId: cursor?.eventId ?? null,
    limit,
  };
}

function buildWhereClause(options: { includeCursor?: boolean } = {}): string {
  const base = `
    (CAST(@workspaceId AS TEXT) IS NULL OR workspace_id = @workspaceId)
    AND (CAST(@sessionId AS TEXT) IS NULL OR session_id = @sessionId)
    AND (CAST(@turnId AS TEXT) IS NULL OR turn_id = @turnId)
    AND (CAST(@durableRunId AS TEXT) IS NULL OR durable_run_id = @durableRunId)
    AND (CAST(@taskId AS TEXT) IS NULL OR task_id = @taskId)
    AND (CAST(@assemblyRunId AS TEXT) IS NULL OR assembly_run_id = @assemblyRunId)
    AND (CAST(@from AS TEXT) IS NULL OR started_at >= @from)
    AND (CAST(@to AS TEXT) IS NULL OR started_at <= @to)
    AND (CAST(@availability AS TEXT) IS NULL OR availability = @availability)
  `;
  if (options.includeCursor === false) {
    return base;
  }
  return `${base}
    AND (
      CAST(@cursorStartedAt AS TEXT) IS NULL
      OR started_at < @cursorStartedAt
      OR (started_at = @cursorStartedAt AND event_id < @cursorEventId)
    )`;
}

function mapRow(row: ModelUsageEventRow): ModelUsageEventRecord {
  const record: ModelUsageEventRecord = {
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    source: row.source,
    callKind: row.call_kind,
    ...(row.requested_provider_id ? { requestedProviderId: row.requested_provider_id } : {}),
    ...(row.requested_model_id ? { requestedModelId: row.requested_model_id } : {}),
    ...(row.requested_reasoning_level ? { requestedReasoningLevel: row.requested_reasoning_level } : {}),
    ...(row.dispatched_reasoning_effort ? { dispatchedReasoningEffort: row.dispatched_reasoning_effort } : {}),
    ...(row.reasoning_disposition ? { reasoningDisposition: row.reasoning_disposition } : {}),
    ...(row.reasoning_reason_code ? { reasoningReasonCode: row.reasoning_reason_code } : {}),
    ...(row.dispatched_model_id ? { dispatchedModelId: row.dispatched_model_id } : {}),
    ...(row.effective_provider_id ? { effectiveProviderId: row.effective_provider_id } : {}),
    ...(row.effective_model_id ? { effectiveModelId: row.effective_model_id } : {}),
    ...(row.effective_api_style ? { effectiveApiStyle: row.effective_api_style } : {}),
    ...(row.route_decision_id ? { routeDecisionId: row.route_decision_id } : {}),
    ...(row.context_snapshot_id ? { contextSnapshotId: row.context_snapshot_id } : {}),
    ...(row.context_intent_hash ? { contextIntentHash: row.context_intent_hash } : {}),
    ...(row.context_entry_ref_id ? { contextEntryRefId: row.context_entry_ref_id } : {}),
    ...(row.context_resolution_hash ? { contextResolutionHash: row.context_resolution_hash } : {}),
    operationId: row.operation_id,
    ...(row.parent_operation_id ? { parentOperationId: row.parent_operation_id } : {}),
    dispatchGeneration: row.dispatch_generation,
    attemptIndex: Number(row.attempt_index),
    transportAttemptIndex: Number(row.transport_attempt_index),
    ...optionalNumber("requestedOutputTokenCap", row.requested_output_token_cap),
    ...optionalNumber("effectiveOutputTokenCap", row.effective_output_token_cap),
    ...(row.output_cap_disposition ? { outputCapDisposition: row.output_cap_disposition } : {}),
    ...(row.output_cap_recovery_source_event_id
      ? { outputCapRecoverySourceEventId: row.output_cap_recovery_source_event_id }
      : {}),
    ...(row.output_cap_recovery_reason_code
      ? { outputCapRecoveryReasonCode: row.output_cap_recovery_reason_code }
      : {}),
    ...optionalNumber("outputCapProviderAvailableTokens", row.output_cap_provider_available_tokens),
    ...optionalNumber("outputCapProviderMinimumTokens", row.output_cap_provider_minimum_tokens),
    ...optionalNumber("outputCapRequestInputEstimate", row.output_cap_request_input_estimate),
    ...optionalNumber("outputCapConfiguredContextWindowTokens", row.output_cap_configured_context_window_tokens),
    ...optionalNumber("outputCapSafetyMarginTokens", row.output_cap_safety_margin_tokens),
    ...(row.output_cap_evidence_format ? { outputCapEvidenceFormat: row.output_cap_evidence_format } : {}),
    ...(row.transport_retry_parent_event_id
      ? { transportRetryParentEventId: row.transport_retry_parent_event_id }
      : {}),
    ...(row.transport_retry_reason ? { transportRetryReason: row.transport_retry_reason } : {}),
    transportStatus: row.transport_status,
    dispatchOwnerId: row.dispatch_owner_id,
    dispatchLeaseExpiresAt: row.dispatch_lease_expires_at,
    ...(row.dispatch_uncertain_at ? { dispatchUncertainAt: row.dispatch_uncertain_at } : {}),
    ...(row.dispatch_uncertainty_reason ? { dispatchUncertaintyReason: row.dispatch_uncertainty_reason } : {}),
    ...(row.dispatch_reconciled_at ? { dispatchReconciledAt: row.dispatch_reconciled_at } : {}),
    ...(row.dispatch_reconciled_by ? { dispatchReconciledBy: row.dispatch_reconciled_by } : {}),
    ...(row.dispatch_reconciliation ? { dispatchReconciliation: row.dispatch_reconciliation } : {}),
    ...(row.dispatch_reconciliation_evidence
      ? { dispatchReconciliationEvidence: row.dispatch_reconciliation_evidence }
      : {}),
    fallbackIndex: Number(row.fallback_index),
    repairIndex: Number(row.repair_index),
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.durable_run_id ? { durableRunId: row.durable_run_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.assembly_run_id ? { assemblyRunId: row.assembly_run_id } : {}),
    ...(row.assembly_round_index === null ? {} : { assemblyRoundIndex: Number(row.assembly_round_index) }),
    ...(row.assembly_stage ? { assemblyStage: row.assembly_stage } : {}),
    ...(row.worker_id ? { workerId: row.worker_id } : {}),
    ...(row.utility_kind ? { utilityKind: row.utility_kind } : {}),
    credentialType: row.credential_type,
    usagePool: row.usage_pool,
    credentialSource: row.credential_source,
    ...(row.credential_config_fingerprint ? { credentialConfigFingerprint: row.credential_config_fingerprint } : {}),
    pricingSource: row.pricing_source,
    costSource: row.cost_source,
    ...(row.pricing_catalog_version ? { pricingCatalogVersion: row.pricing_catalog_version } : {}),
    ...(row.pricing_catalog_hash ? { pricingCatalogHash: row.pricing_catalog_hash } : {}),
    ...optionalNumber("inputRateUsdPerMillion", row.input_rate_usd_per_million),
    ...optionalNumber("outputRateUsdPerMillion", row.output_rate_usd_per_million),
    ...optionalNumber("cachedInputRateUsdPerMillion", row.cached_input_rate_usd_per_million),
    ...optionalNumber("inputTokens", row.input_tokens),
    ...optionalNumber("outputTokens", row.output_tokens),
    ...optionalNumber("cachedInputTokens", row.cached_input_tokens),
    ...optionalNumber("costUsd", row.cost_usd),
    availability: row.availability,
    terminalOutcome: row.terminal_outcome,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    startedAt: row.started_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...optionalNumber("durationMs", row.duration_ms),
  };
  assertMappedModelUsageEventInvariants(record);
  return record;
}

function mapSummary(row: Record<string, number | string | null> | undefined): ModelUsageSummary {
  const attemptCount = Number(row?.attempt_count ?? 0);
  const uncertainDispatchCount = Number(row?.uncertain_dispatch_count ?? 0);
  const availability = (knownValue: number | string | null | undefined) => {
    const knownAttemptCount = Number(knownValue ?? 0);
    const unknownAttemptCount = Math.max(0, attemptCount + uncertainDispatchCount - knownAttemptCount);
    return { knownAttemptCount, unknownAttemptCount, complete: unknownAttemptCount === 0 };
  };
  return {
    attemptCount,
    uncertainDispatchCount,
    trackedAttemptCount: Number(row?.tracked_count ?? 0),
    unknownAttemptCount: Number(row?.unknown_count ?? 0),
    ...optionalNumber("inputTokens", row?.input_tokens ?? null),
    ...optionalNumber("outputTokens", row?.output_tokens ?? null),
    ...optionalNumber("cachedInputTokens", row?.cached_input_tokens ?? null),
    ...optionalNumber("costUsd", row?.cost_usd ?? null),
    metricAvailability: {
      inputTokens: availability(row?.input_known_count),
      outputTokens: availability(row?.output_known_count),
      cachedInputTokens: availability(row?.cached_known_count),
      costUsd: availability(row?.cost_known_count),
    },
  };
}

function buildUsageKnownMask(record: ModelUsageEventRecord): string {
  return [
    record.inputTokens === undefined ? undefined : "input",
    record.outputTokens === undefined ? undefined : "output",
    record.cachedInputTokens === undefined ? undefined : "cached",
    record.costUsd === undefined ? undefined : "cost",
  ]
    .filter((value): value is string => Boolean(value))
    .join(",");
}

function assertOutputCapRecoveryLineage(
  source: ModelUsageEventRecord | undefined,
  input: Record<string, unknown>,
): void {
  if (!source) throw new Error("Reduced output-cap retry source attempt does not exist");
  const sameIdentity = isSameTransportRetryIdentity(source, input);
  const sourceFailedForOutputCap =
    source.transportStatus === "accepted" &&
    (source.terminalOutcome === "failed_before_usage" || source.terminalOutcome === "failed_after_usage") &&
    source.errorCode === "provideroutputcaperror";
  const requested = Number(input.requestedOutputTokenCap);
  const effective = Number(input.effectiveOutputTokenCap);
  const providerAvailable = Number(input.outputCapProviderAvailableTokens);
  const providerMinimum =
    input.outputCapProviderMinimumTokens === null ? undefined : Number(input.outputCapProviderMinimumTokens);
  const configuredContext = Number(input.outputCapConfiguredContextWindowTokens);
  const requestEstimate = Number(input.outputCapRequestInputEstimate);
  const margin = Number(input.outputCapSafetyMarginTokens);
  const capLineageValid =
    source.requestedOutputTokenCap === requested &&
    source.effectiveOutputTokenCap !== undefined &&
    source.effectiveOutputTokenCap > effective &&
    source.transportAttemptIndex + 1 === input.transportAttemptIndex &&
    effective <= providerAvailable - margin &&
    effective <= configuredContext - requestEstimate - margin &&
    (providerMinimum === undefined || effective >= providerMinimum);
  if (!sameIdentity || !sourceFailedForOutputCap || !capLineageValid) {
    throw new Error("Reduced output-cap retry is not linked to the immediately prior failed provider attempt");
  }
}

function assertTransportRetryLineage(source: ModelUsageEventRecord | undefined, input: Record<string, unknown>): void {
  if (!source) throw new Error("Transport retry parent attempt does not exist");
  const sameIdentity =
    isSameTransportRetryIdentity(source, input) && source.transportAttemptIndex + 1 === input.transportAttemptIndex;
  const sourceFailed =
    source.transportStatus === "accepted" &&
    (source.terminalOutcome === "failed_before_usage" || source.terminalOutcome === "failed_after_usage");
  const reason = input.transportRetryReason;
  const reasonMatches =
    (reason === "output_cap_recovery" && source.errorCode === "provideroutputcaperror") ||
    (reason === "metadata_compatibility" && source.errorCode === "providermetadatacompatibilityerror");
  const outputCapMatches =
    reason === "metadata_compatibility"
      ? source.requestedOutputTokenCap === (input.requestedOutputTokenCap ?? undefined) &&
        source.effectiveOutputTokenCap === (input.effectiveOutputTokenCap ?? undefined) &&
        (source.requestedOutputTokenCap === undefined || input.outputCapDisposition === "preserved_retry")
      : input.outputCapDisposition === "reduced_retry" &&
        source.requestedOutputTokenCap === input.requestedOutputTokenCap;
  if (!sameIdentity || !sourceFailed || !reasonMatches || !outputCapMatches) {
    throw new Error("Transport retry is not linked to the immediately prior compatible failed provider attempt");
  }
}

function isSameTransportRetryIdentity(source: ModelUsageEventRecord, input: Record<string, unknown>): boolean {
  const expected = {
    source: input.source,
    callKind: input.callKind,
    requestedProviderId: input.requestedProviderId ?? undefined,
    requestedModelId: input.requestedModelId ?? undefined,
    requestedReasoningLevel: input.requestedReasoningLevel ?? undefined,
    dispatchedReasoningEffort: input.dispatchedReasoningEffort ?? undefined,
    reasoningDisposition: input.reasoningDisposition ?? undefined,
    reasoningReasonCode: input.reasoningReasonCode ?? undefined,
    effectiveProviderId: input.effectiveProviderId ?? undefined,
    dispatchedModelId: input.effectiveModelId ?? undefined,
    effectiveApiStyle: input.effectiveApiStyle ?? undefined,
    routeDecisionId: input.routeDecisionId ?? undefined,
    contextSnapshotId: input.contextSnapshotId ?? undefined,
    contextIntentHash: input.contextIntentHash ?? undefined,
    contextEntryRefId: input.contextEntryRefId ?? undefined,
    operationId: input.operationId,
    parentOperationId: input.parentOperationId ?? undefined,
    dispatchGeneration: input.dispatchGeneration,
    attemptIndex: input.attemptIndex,
    fallbackIndex: input.fallbackIndex,
    repairIndex: input.repairIndex,
    workspaceId: input.workspaceId ?? undefined,
    sessionId: input.sessionId ?? undefined,
    turnId: input.turnId ?? undefined,
    durableRunId: input.durableRunId ?? undefined,
    taskId: input.taskId ?? undefined,
    agentId: input.agentId ?? undefined,
    assemblyRunId: input.assemblyRunId ?? undefined,
    assemblyRoundIndex: input.assemblyRoundIndex ?? undefined,
    assemblyStage: input.assemblyStage ?? undefined,
    workerId: input.workerId ?? undefined,
    utilityKind: input.utilityKind ?? undefined,
    dispatchOwnerId: input.dispatchOwnerId,
    credentialType: input.credentialType,
    usagePool: input.usagePool,
    credentialSource: input.credentialSource,
    credentialConfigFingerprint: input.credentialConfigFingerprint ?? undefined,
    pricingCatalogVersion: input.pricingCatalogVersion ?? undefined,
    pricingCatalogHash: input.pricingCatalogHash ?? undefined,
    inputRateUsdPerMillion: input.inputRateUsdPerMillion ?? undefined,
    outputRateUsdPerMillion: input.outputRateUsdPerMillion ?? undefined,
    cachedInputRateUsdPerMillion: input.cachedInputRateUsdPerMillion ?? undefined,
  };
  const actual = {
    source: source.source,
    callKind: source.callKind,
    requestedProviderId: source.requestedProviderId,
    requestedModelId: source.requestedModelId,
    requestedReasoningLevel: source.requestedReasoningLevel,
    dispatchedReasoningEffort: source.dispatchedReasoningEffort,
    reasoningDisposition: source.reasoningDisposition,
    reasoningReasonCode: source.reasoningReasonCode,
    effectiveProviderId: source.effectiveProviderId,
    dispatchedModelId: source.dispatchedModelId,
    effectiveApiStyle: source.effectiveApiStyle,
    routeDecisionId: source.routeDecisionId,
    contextSnapshotId: source.contextSnapshotId,
    contextIntentHash: source.contextIntentHash,
    contextEntryRefId: source.contextEntryRefId,
    operationId: source.operationId,
    parentOperationId: source.parentOperationId,
    dispatchGeneration: source.dispatchGeneration,
    attemptIndex: source.attemptIndex,
    fallbackIndex: source.fallbackIndex,
    repairIndex: source.repairIndex,
    workspaceId: source.workspaceId,
    sessionId: source.sessionId,
    turnId: source.turnId,
    durableRunId: source.durableRunId,
    taskId: source.taskId,
    agentId: source.agentId,
    assemblyRunId: source.assemblyRunId,
    assemblyRoundIndex: source.assemblyRoundIndex,
    assemblyStage: source.assemblyStage,
    workerId: source.workerId,
    utilityKind: source.utilityKind,
    dispatchOwnerId: source.dispatchOwnerId,
    credentialType: source.credentialType,
    usagePool: source.usagePool,
    credentialSource: source.credentialSource,
    credentialConfigFingerprint: source.credentialConfigFingerprint,
    pricingCatalogVersion: source.pricingCatalogVersion,
    pricingCatalogHash: source.pricingCatalogHash,
    inputRateUsdPerMillion: source.inputRateUsdPerMillion,
    outputRateUsdPerMillion: source.outputRateUsdPerMillion,
    cachedInputRateUsdPerMillion: source.cachedInputRateUsdPerMillion,
  };
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function assertMappedModelUsageEventInvariants(record: ModelUsageEventRecord): void {
  const recoveryEvidence = [
    record.outputCapRecoverySourceEventId,
    record.outputCapRecoveryReasonCode,
    record.outputCapProviderAvailableTokens,
    record.outputCapProviderMinimumTokens,
    record.outputCapRequestInputEstimate,
    record.outputCapConfiguredContextWindowTokens,
    record.outputCapSafetyMarginTokens,
    record.outputCapEvidenceFormat,
  ];
  const hasAnyRecoveryEvidence = recoveryEvidence.some((value) => value !== undefined);
  const retryPaired =
    (record.transportRetryParentEventId === undefined) === (record.transportRetryReason === undefined);
  if (!retryPaired) throw new Error("Persisted model usage transport retry lineage is incomplete");
  if (record.requestedOutputTokenCap === undefined) {
    if (
      record.effectiveOutputTokenCap !== undefined ||
      record.outputCapDisposition !== undefined ||
      hasAnyRecoveryEvidence ||
      record.transportRetryReason === "output_cap_recovery"
    ) {
      throw new Error("Persisted model usage output-cap lineage is invalid");
    }
    return;
  }
  const requested = record.requestedOutputTokenCap;
  const effective = record.effectiveOutputTokenCap;
  if (effective === undefined || effective < 1 || effective > requested) {
    throw new Error("Persisted model usage output-cap values are invalid");
  }
  if (record.outputCapDisposition === "initial") {
    if (effective !== requested || hasAnyRecoveryEvidence || record.transportRetryReason !== undefined) {
      throw new Error("Persisted initial output-cap lineage is invalid");
    }
    return;
  }
  if (record.outputCapDisposition === "preserved_retry") {
    if (
      hasAnyRecoveryEvidence ||
      !record.transportRetryParentEventId ||
      record.transportRetryReason !== "metadata_compatibility"
    ) {
      throw new Error("Persisted preserved output-cap lineage is invalid");
    }
    return;
  }
  const available = record.outputCapProviderAvailableTokens;
  const providerMinimum = record.outputCapProviderMinimumTokens;
  const configuredContext = record.outputCapConfiguredContextWindowTokens;
  const requestEstimate = record.outputCapRequestInputEstimate;
  const margin = record.outputCapSafetyMarginTokens;
  if (
    record.outputCapDisposition !== "reduced_retry" ||
    effective >= requested ||
    record.outputCapRecoveryReasonCode !== "safe_lower_cap" ||
    !record.outputCapRecoverySourceEventId ||
    record.transportRetryParentEventId !== record.outputCapRecoverySourceEventId ||
    record.transportRetryReason !== "output_cap_recovery" ||
    available === undefined ||
    requestEstimate === undefined ||
    configuredContext === undefined ||
    margin === undefined ||
    !record.outputCapEvidenceFormat ||
    effective > available - margin ||
    effective > configuredContext - requestEstimate - margin ||
    (providerMinimum !== undefined && effective < providerMinimum)
  ) {
    throw new Error("Persisted reduced output-cap lineage is invalid");
  }
}

function assertSameAttemptIdentity(record: ModelUsageEventRecord, input: Record<string, unknown>): void {
  const expected = {
    source: input.source,
    callKind: input.callKind,
    requestedProviderId: input.requestedProviderId ?? undefined,
    requestedModelId: input.requestedModelId ?? undefined,
    requestedReasoningLevel: input.requestedReasoningLevel ?? undefined,
    dispatchedReasoningEffort: input.dispatchedReasoningEffort ?? undefined,
    reasoningDisposition: input.reasoningDisposition ?? undefined,
    reasoningReasonCode: input.reasoningReasonCode ?? undefined,
    effectiveProviderId: input.effectiveProviderId ?? undefined,
    dispatchedModelId: input.effectiveModelId ?? undefined,
    effectiveApiStyle: input.effectiveApiStyle ?? undefined,
    routeDecisionId: input.routeDecisionId ?? undefined,
    contextSnapshotId: input.contextSnapshotId ?? undefined,
    contextIntentHash: input.contextIntentHash ?? undefined,
    contextEntryRefId: input.contextEntryRefId ?? undefined,
    operationId: input.operationId,
    parentOperationId: input.parentOperationId ?? undefined,
    dispatchGeneration: input.dispatchGeneration,
    attemptIndex: input.attemptIndex,
    transportAttemptIndex: input.transportAttemptIndex,
    requestedOutputTokenCap: input.requestedOutputTokenCap ?? undefined,
    effectiveOutputTokenCap: input.effectiveOutputTokenCap ?? undefined,
    outputCapDisposition: input.outputCapDisposition ?? undefined,
    outputCapRecoverySourceEventId: input.outputCapRecoverySourceEventId ?? undefined,
    outputCapRecoveryReasonCode: input.outputCapRecoveryReasonCode ?? undefined,
    outputCapProviderAvailableTokens: input.outputCapProviderAvailableTokens ?? undefined,
    outputCapProviderMinimumTokens: input.outputCapProviderMinimumTokens ?? undefined,
    outputCapRequestInputEstimate: input.outputCapRequestInputEstimate ?? undefined,
    outputCapConfiguredContextWindowTokens: input.outputCapConfiguredContextWindowTokens ?? undefined,
    outputCapSafetyMarginTokens: input.outputCapSafetyMarginTokens ?? undefined,
    outputCapEvidenceFormat: input.outputCapEvidenceFormat ?? undefined,
    transportRetryParentEventId: input.transportRetryParentEventId ?? undefined,
    transportRetryReason: input.transportRetryReason ?? undefined,
    fallbackIndex: input.fallbackIndex,
    repairIndex: input.repairIndex,
    workspaceId: input.workspaceId ?? undefined,
    sessionId: input.sessionId ?? undefined,
    turnId: input.turnId ?? undefined,
    durableRunId: input.durableRunId ?? undefined,
    taskId: input.taskId ?? undefined,
    agentId: input.agentId ?? undefined,
    assemblyRunId: input.assemblyRunId ?? undefined,
    assemblyRoundIndex: input.assemblyRoundIndex ?? undefined,
    assemblyStage: input.assemblyStage ?? undefined,
    workerId: input.workerId ?? undefined,
    utilityKind: input.utilityKind ?? undefined,
    credentialType: input.credentialType,
    usagePool: input.usagePool,
    credentialSource: input.credentialSource,
    credentialConfigFingerprint: input.credentialConfigFingerprint ?? undefined,
    pricingCatalogVersion: input.pricingCatalogVersion ?? undefined,
    pricingCatalogHash: input.pricingCatalogHash ?? undefined,
    inputRateUsdPerMillion: input.inputRateUsdPerMillion ?? undefined,
    outputRateUsdPerMillion: input.outputRateUsdPerMillion ?? undefined,
    cachedInputRateUsdPerMillion: input.cachedInputRateUsdPerMillion ?? undefined,
  };
  const actual = {
    source: record.source,
    callKind: record.callKind,
    requestedProviderId: record.requestedProviderId,
    requestedModelId: record.requestedModelId,
    requestedReasoningLevel: record.requestedReasoningLevel,
    dispatchedReasoningEffort: record.dispatchedReasoningEffort,
    reasoningDisposition: record.reasoningDisposition,
    reasoningReasonCode: record.reasoningReasonCode,
    effectiveProviderId: record.effectiveProviderId,
    dispatchedModelId: record.dispatchedModelId,
    effectiveApiStyle: record.effectiveApiStyle,
    routeDecisionId: record.routeDecisionId,
    contextSnapshotId: record.contextSnapshotId,
    contextIntentHash: record.contextIntentHash,
    contextEntryRefId: record.contextEntryRefId,
    operationId: record.operationId,
    parentOperationId: record.parentOperationId,
    dispatchGeneration: record.dispatchGeneration,
    attemptIndex: record.attemptIndex,
    transportAttemptIndex: record.transportAttemptIndex,
    requestedOutputTokenCap: record.requestedOutputTokenCap,
    effectiveOutputTokenCap: record.effectiveOutputTokenCap,
    outputCapDisposition: record.outputCapDisposition,
    outputCapRecoverySourceEventId: record.outputCapRecoverySourceEventId,
    outputCapRecoveryReasonCode: record.outputCapRecoveryReasonCode,
    outputCapProviderAvailableTokens: record.outputCapProviderAvailableTokens,
    outputCapProviderMinimumTokens: record.outputCapProviderMinimumTokens,
    outputCapRequestInputEstimate: record.outputCapRequestInputEstimate,
    outputCapConfiguredContextWindowTokens: record.outputCapConfiguredContextWindowTokens,
    outputCapSafetyMarginTokens: record.outputCapSafetyMarginTokens,
    outputCapEvidenceFormat: record.outputCapEvidenceFormat,
    transportRetryParentEventId: record.transportRetryParentEventId,
    transportRetryReason: record.transportRetryReason,
    fallbackIndex: record.fallbackIndex,
    repairIndex: record.repairIndex,
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    turnId: record.turnId,
    durableRunId: record.durableRunId,
    taskId: record.taskId,
    agentId: record.agentId,
    assemblyRunId: record.assemblyRunId,
    assemblyRoundIndex: record.assemblyRoundIndex,
    assemblyStage: record.assemblyStage,
    workerId: record.workerId,
    utilityKind: record.utilityKind,
    credentialType: record.credentialType,
    usagePool: record.usagePool,
    credentialSource: record.credentialSource,
    credentialConfigFingerprint: record.credentialConfigFingerprint,
    pricingCatalogVersion: record.pricingCatalogVersion,
    pricingCatalogHash: record.pricingCatalogHash,
    inputRateUsdPerMillion: record.inputRateUsdPerMillion,
    outputRateUsdPerMillion: record.outputRateUsdPerMillion,
    cachedInputRateUsdPerMillion: record.cachedInputRateUsdPerMillion,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Model usage idempotency key was reused for a different provider attempt");
  }
}

function assertSameFinalization(record: ModelUsageEventRecord, input: Record<string, unknown>): void {
  const expected = {
    terminalOutcome: input.terminalOutcome,
    availability: input.availability,
    inputTokens: input.inputTokens ?? undefined,
    outputTokens: input.outputTokens ?? undefined,
    cachedInputTokens: input.cachedInputTokens ?? undefined,
    costUsd: input.costUsd ?? undefined,
    effectiveModelId: input.reportedEffectiveModelId ?? record.effectiveModelId,
    contextResolutionHash: input.contextResolutionHash ?? record.contextResolutionHash,
    errorCode: input.errorCode ?? undefined,
    pricingSource: input.pricingSource,
    costSource: input.costSource,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
  };
  const actual = {
    terminalOutcome: record.terminalOutcome,
    availability: record.availability,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cachedInputTokens: record.cachedInputTokens,
    costUsd: record.costUsd,
    effectiveModelId: record.effectiveModelId,
    contextResolutionHash: record.contextResolutionHash,
    errorCode: record.errorCode,
    pricingSource: record.pricingSource,
    costSource: record.costSource,
    finishedAt: record.finishedAt,
    durationMs: record.durationMs,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Model usage event was finalized with conflicting terminal evidence");
  }
}

function encodeCursor(startedAt: string, eventId: string): string {
  return `${startedAt}|${eventId}`;
}

function parseCursor(cursor: string | undefined): { startedAt: string; eventId: string } | undefined {
  if (!cursor) return undefined;
  if (cursor.length > 1_024) throw new TypeError("model usage cursor must be at most 1024 characters");
  const separator = cursor.lastIndexOf("|");
  if (separator <= 0 || separator === cursor.length - 1) {
    throw new TypeError("Invalid model usage cursor");
  }
  return {
    startedAt: requireCanonicalIso(cursor.slice(0, separator), "cursor.startedAt"),
    eventId: requireBoundedText(cursor.slice(separator + 1), "cursor.eventId"),
  };
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function requireBoundedText(value: string, field: string, maxLength = 512): string {
  const normalized = requireText(value, field);
  if (normalized.length > maxLength) throw new TypeError(`${field} must be at most ${maxLength} characters`);
  return normalized;
}

function optionalBoundedText(value: string | undefined, field: string, maxLength = 512): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return requireBoundedText(normalized, field, maxLength);
}

function optionalSha256(value: string | undefined, field: string): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new TypeError(`${field} must be a 64-character SHA-256 hex value`);
  return normalized;
}

function requireCanonicalIso(value: string, field: string): string {
  const normalized = requireBoundedText(value, field, 64);
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== normalized) {
    throw new TypeError(`${field} must be a canonical ISO-8601 UTC timestamp`);
  }
  return normalized;
}

function boundedEvidence(value: string): string {
  const normalized = requireText(value, "evidence");
  if (normalized.length > 2_048) throw new TypeError("evidence must be at most 2048 characters");
  return normalized;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return value;
}

function optionalNonNegativeInteger(value: number | undefined, field: string): number | null {
  return value === undefined ? null : nonNegativeInteger(value, field);
}

function optionalNonNegativeNumber(value: number | undefined, field: string): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be a non-negative finite number`);
  return value;
}

function optionalNumber<Key extends string>(key: Key, value: number | string | null): Partial<Record<Key, number>> {
  return value === null ? {} : ({ [key]: Number(value) } as Partial<Record<Key, number>>);
}
