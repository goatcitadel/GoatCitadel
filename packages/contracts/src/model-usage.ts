/**
 * Canonical per-network-attempt model usage truth.
 *
 * These records intentionally distinguish an exact numeric zero from missing
 * provider usage. Legacy assistant-message and cost-ledger aggregates are
 * compatibility projections only and must not be used to reconstruct attempts.
 */

export type ModelUsageCallKind =
  | "chat_initial"
  | "chat_tool_loop"
  | "chat_repair"
  | "chat_fallback"
  | "delegation_worker"
  | "assembly_participant"
  | "assembly_synthesis"
  | "utility"
  | "embedding"
  | "image_generation";

export type ModelUsageTerminalOutcome =
  | "in_flight"
  | "succeeded"
  | "failed_before_usage"
  | "failed_after_usage"
  | "interrupted_after_dispatch"
  | "cancelled";

export type ModelUsageTransportStatus = "intent" | "accepted" | "dispatch_unknown";

export type ModelUsageDispatchReconciliation =
  | "confirmed_not_dispatched"
  | "confirmed_dispatched_usage_unknown"
  | "superseded_by_new_generation";

export type ModelUsageAvailability = "tracked" | "unknown";

export type ModelUsageCredentialType = "api_key" | "oauth" | "service_account" | "adc" | "unknown";
export type ModelUsagePool = "standard" | "subscription" | "local" | "unknown";
export type ModelUsageCredentialSource = "inline" | "env" | "keychain" | "oauth" | "adc" | "none" | "unknown";
export type ModelUsagePricingSource = "provider_reported" | "gateway_estimate" | "not_available";
export type ModelUsageCostSource = "provider_reported" | "gateway_estimate" | "not_available";
export type ModelUsageReasoningDisposition = "honored" | "downgraded" | "unsupported_blocked" | "provider_default";

export type ModelUsageOutputCapDisposition = "initial" | "preserved_retry" | "reduced_retry";
export type ModelUsageOutputCapRecoveryReasonCode = "safe_lower_cap";
export type ModelUsageOutputCapEvidenceFormat =
  | "anthropic_equation"
  | "bounded_range"
  | "context_breakdown"
  | "character_prompt"
  | "vllm_context";
export type ModelUsageTransportRetryReason = "output_cap_recovery" | "metadata_compatibility";

/**
 * Secret-free attribution supplied by the runtime owner before provider
 * dispatch. `operationId` must be stable across a replay of the same logical
 * call; attempt/fallback/repair ordinals make each real network attempt unique.
 */
export interface ModelUsageAttributionContext {
  operationId?: string;
  callKind?: ModelUsageCallKind;
  /** Original operator/routing request, preserved across effective fallbacks. */
  requestedProviderId?: string;
  requestedModelId?: string;
  requestedReasoningLevel?: string;
  dispatchedReasoningEffort?: string;
  reasoningDisposition?: ModelUsageReasoningDisposition;
  reasoningReasonCode?: string;
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
  routeDecisionId?: string;
  contextSnapshotId?: string;
  contextIntentHash?: string;
  contextEntryRefId?: string;
  /** Optional terminal linkage; it is not part of pre-dispatch identity. */
  contextResolutionHash?: string;
  parentOperationId?: string;
  /**
   * A new value is required whenever recovery may perform a fresh dispatch.
   * Reuse is allowed only when the runtime has proved the original dispatch did
   * not occur. Non-durable callers may omit it and receive an invocation UUID.
   */
  dispatchGeneration?: string;
  attemptIndex?: number;
  fallbackIndex?: number;
  repairIndex?: number;
}

export interface ModelUsageNumbers {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export interface ModelUsageEventRecord extends ModelUsageNumbers {
  eventId: string;
  idempotencyKey: string;
  source: "llm_service" | "embedding_runtime" | "manual_test";
  callKind: ModelUsageCallKind;
  requestedProviderId?: string;
  requestedModelId?: string;
  requestedReasoningLevel?: string;
  dispatchedReasoningEffort?: string;
  reasoningDisposition?: ModelUsageReasoningDisposition;
  reasoningReasonCode?: string;
  /** Model resolved by GoatCitadel immediately before transport dispatch. */
  dispatchedModelId?: string;
  effectiveProviderId?: string;
  /** Provider-reported model when available, otherwise the dispatched model. */
  effectiveModelId?: string;
  effectiveApiStyle?: string;
  routeDecisionId?: string;
  contextSnapshotId?: string;
  contextIntentHash?: string;
  contextEntryRefId?: string;
  contextResolutionHash?: string;
  operationId: string;
  parentOperationId?: string;
  dispatchGeneration: string;
  attemptIndex: number;
  transportAttemptIndex: number;
  /** Original operator/runtime cap retained across transport-only recovery. */
  requestedOutputTokenCap?: number;
  /** Exact output cap placed on this network attempt. */
  effectiveOutputTokenCap?: number;
  outputCapDisposition?: ModelUsageOutputCapDisposition;
  /** Prior failed HX-306 attempt that authorized a reduced-cap redispatch. */
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
  transportStatus: ModelUsageTransportStatus;
  dispatchOwnerId: string;
  dispatchLeaseExpiresAt: string;
  dispatchUncertainAt?: string;
  dispatchUncertaintyReason?: string;
  dispatchReconciledAt?: string;
  dispatchReconciliation?: ModelUsageDispatchReconciliation;
  /** Durable actor id for manual reconciliation; absent only for system recovery. */
  dispatchReconciledBy?: string;
  /** Bounded, secret-free operator evidence supporting reconciliation. */
  dispatchReconciliationEvidence?: string;
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
  /** SHA-256 of secret-free effective provider credential configuration. */
  credentialConfigFingerprint?: string;
  pricingSource: ModelUsagePricingSource;
  costSource: ModelUsageCostSource;
  pricingCatalogVersion?: string;
  pricingCatalogHash?: string;
  inputRateUsdPerMillion?: number;
  outputRateUsdPerMillion?: number;
  cachedInputRateUsdPerMillion?: number;
  availability: ModelUsageAvailability;
  terminalOutcome: ModelUsageTerminalOutcome;
  errorCode?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface ModelUsageEventListQuery {
  workspaceId?: string;
  sessionId?: string;
  turnId?: string;
  durableRunId?: string;
  taskId?: string;
  assemblyRunId?: string;
  from?: string;
  to?: string;
  availability?: ModelUsageAvailability;
  limit?: number;
  cursor?: string;
}

export interface ModelUsageSummary {
  attemptCount: number;
  /** Crash-window dispatches that cannot safely be treated as accepted or absent. */
  uncertainDispatchCount: number;
  trackedAttemptCount: number;
  unknownAttemptCount: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
  metricAvailability: {
    inputTokens: ModelUsageMetricAvailability;
    outputTokens: ModelUsageMetricAvailability;
    cachedInputTokens: ModelUsageMetricAvailability;
    costUsd: ModelUsageMetricAvailability;
  };
}

export interface ModelUsageMetricAvailability {
  knownAttemptCount: number;
  unknownAttemptCount: number;
  complete: boolean;
}

export interface ModelUsageEventListResponse {
  items: ModelUsageEventRecord[];
  summary: ModelUsageSummary;
  nextCursor?: string;
}
