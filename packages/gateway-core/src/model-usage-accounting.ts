import { createHash, randomUUID } from "node:crypto";
import type {
  ModelUsageAttributionContext,
  ModelUsageCostSource,
  ModelUsageCredentialSource,
  ModelUsageCredentialType,
  ModelUsageEventRecord,
  ModelUsageNumbers,
  ModelUsageOutputCapDisposition,
  ModelUsageOutputCapEvidenceFormat,
  ModelUsageOutputCapRecoveryReasonCode,
  ModelUsagePool,
  ModelUsagePricingSource,
  ModelUsageTransportRetryReason,
} from "@goatcitadel/contracts";
import type { ModelUsageEventRepository } from "@goatcitadel/storage";

export interface ModelUsagePricingLineage {
  catalogVersion?: string;
  catalogHash?: string;
  inputRateUsdPerMillion?: number;
  outputRateUsdPerMillion?: number;
  cachedInputRateUsdPerMillion?: number;
}

export interface ModelUsageCredentialLineage {
  credentialType: ModelUsageCredentialType;
  usagePool: ModelUsagePool;
  credentialSource: ModelUsageCredentialSource;
  credentialConfigFingerprint?: string;
}

export interface BeginModelUsageDispatchInput {
  source: "llm_service" | "embedding_runtime";
  attribution: ModelUsageAttributionContext;
  requestedProviderId?: string;
  requestedModelId?: string;
  effectiveProviderId?: string;
  effectiveModelId?: string;
  effectiveApiStyle?: string;
  transportAttemptIndex: number;
  outputCap?: {
    requestedOutputTokenCap: number;
    effectiveOutputTokenCap: number;
    disposition: ModelUsageOutputCapDisposition;
    recoverySourceEventId?: string;
    recoveryReasonCode?: ModelUsageOutputCapRecoveryReasonCode;
    providerAvailableTokens?: number;
    providerMinimumTokens?: number;
    requestInputEstimate?: number;
    configuredContextWindowTokens?: number;
    safetyMarginTokens?: number;
    evidenceFormat?: ModelUsageOutputCapEvidenceFormat;
  };
  transportRetry?: {
    parentEventId: string;
    reason: ModelUsageTransportRetryReason;
  };
  credential: ModelUsageCredentialLineage;
  pricing?: ModelUsagePricingLineage;
  startedAt?: string;
}

export interface ModelUsageObservation extends ModelUsageNumbers {
  costSource?: ModelUsageCostSource;
  pricingSource?: ModelUsagePricingSource;
  effectiveModelId?: string;
}

export type ModelUsageSettlementOutcome = "succeeded" | "failed_before_usage" | "failed_after_usage" | "cancelled";

/**
 * A stable dispatch identity may already own or have completed the network
 * attempt. Callers must not retry or fall back until canonical reconciliation
 * proves a new dispatch generation is safe.
 */
export class ModelUsageDispatchUncertainError extends Error {
  public readonly eventId?: string;

  public constructor(message: string, options: { eventId?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelUsageDispatchUncertainError";
    this.eventId = options.eventId;
  }
}

/**
 * Canonical terminal persistence failed after transport ownership was accepted.
 * Callers must surface this error instead of reclassifying the provider outcome;
 * the accepted row remains recoverable by its lease owner/recovery sweep.
 */
export class ModelUsageSettlementError extends Error {
  public readonly eventId: string;
  public readonly intendedOutcome: ModelUsageSettlementOutcome;

  public constructor(eventId: string, intendedOutcome: ModelUsageSettlementOutcome, cause: unknown) {
    super(`Canonical model usage settlement failed for ${eventId} (${intendedOutcome})`, { cause });
    this.name = "ModelUsageSettlementError";
    this.eventId = eventId;
    this.intendedOutcome = intendedOutcome;
  }
}

export type ModelUsageDispatchPersistenceAction = "abandon_intent" | "mark_dispatch_unknown" | "renew_accepted_lease";

/**
 * Canonical dispatch-lifecycle state could not be persisted. The intent or
 * accepted attempt may still exist, so callers must surface this error and
 * must not redispatch.
 */
export class ModelUsageDispatchPersistenceError extends Error {
  public readonly eventId: string;
  public readonly action: ModelUsageDispatchPersistenceAction;

  public constructor(eventId: string, action: ModelUsageDispatchPersistenceAction, cause: unknown) {
    super(`Canonical model usage dispatch persistence failed for ${eventId} (${action})`, { cause });
    this.name = "ModelUsageDispatchPersistenceError";
    this.eventId = eventId;
    this.action = action;
  }
}

/**
 * Fail-closed accounting faults that must survive adapter, stream, and package
 * boundaries without retry, fallback, or best-effort suppression.
 */
export function isAuthoritativeModelUsageAccountingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return (
    name === "ModelUsageDispatchUncertainError" ||
    name === "ModelUsageSettlementError" ||
    name === "ModelUsageDispatchPersistenceError"
  );
}

/**
 * A handle exists only after the exact transport dispatch fence has persisted
 * an in-flight attempt. It finalizes once even when stream consumers cancel or
 * a provider fails after sending usage.
 */
export class ModelUsageAttemptHandle {
  private observation: ModelUsageObservation = {};
  private terminal?: ModelUsageEventRecord;
  private settlementFailure?: ModelUsageSettlementError;
  private nextLeaseRenewalAtMs: number;

  public constructor(
    private readonly repository: ModelUsageEventRepository,
    public readonly eventId: string,
    private readonly startedAtMs: number,
    private readonly dispatchOwnerId: string,
    private readonly acceptedLeaseMs: number,
    private readonly zeroCostProvider: boolean,
    private readonly contextResolutionHash?: string,
  ) {
    this.nextLeaseRenewalAtMs = Date.now() + Math.max(1_000, Math.floor(acceptedLeaseMs / 3));
  }

  /** Keep a long-running stream protected from stale-owner recovery. */
  public renewLease(nowMs = Date.now()): void {
    if (nowMs < this.nextLeaseRenewalAtMs || this.terminal) return;
    try {
      this.repository.renewTransportLease(
        this.eventId,
        this.dispatchOwnerId,
        new Date(nowMs + this.acceptedLeaseMs).toISOString(),
      );
    } catch (cause) {
      throw new ModelUsageDispatchPersistenceError(this.eventId, "renew_accepted_lease", cause);
    }
    this.nextLeaseRenewalAtMs = nowMs + Math.max(1_000, Math.floor(this.acceptedLeaseMs / 3));
  }

  public observe(usage: unknown): void {
    this.observation = mergeObservations(this.observation, normalizeUsageObservation(usage));
  }

  public observeNormalized(observation: ModelUsageObservation): void {
    this.observation = mergeObservations(this.observation, normalizeObservation(observation));
  }

  public succeed(usage?: unknown): ModelUsageEventRecord {
    if (usage !== undefined) this.observe(usage);
    this.ensureZeroCostEvidence();
    return this.finish("succeeded");
  }

  public fail(error: unknown, usage?: unknown): ModelUsageEventRecord {
    if (usage !== undefined) this.observe(usage);
    this.ensureZeroCostEvidence();
    if (isCancellation(error)) return this.finish("cancelled", error);
    const hasUsage = hasAnyUsage(this.observation);
    return this.finish(hasUsage ? "failed_after_usage" : "failed_before_usage", error);
  }

  public cancel(reason?: unknown): ModelUsageEventRecord {
    this.ensureZeroCostEvidence();
    return this.finish("cancelled", reason);
  }

  private ensureZeroCostEvidence(): void {
    if (this.zeroCostProvider && this.observation.costUsd === undefined) {
      this.observeNormalized({ costUsd: 0, costSource: "gateway_estimate", pricingSource: "gateway_estimate" });
    }
  }

  private finish(outcome: ModelUsageSettlementOutcome, error?: unknown): ModelUsageEventRecord {
    if (this.terminal) return this.terminal;
    if (this.settlementFailure) throw this.settlementFailure;
    const finishedAt = new Date().toISOString();
    const hasUsage = hasAnyUsage(this.observation);
    const costKnown = this.observation.costUsd !== undefined;
    const costSource = costKnown ? (this.observation.costSource ?? "not_available") : "not_available";
    const pricingSource = costKnown ? (this.observation.pricingSource ?? costSource) : "not_available";
    let result;
    try {
      result = this.repository.finalizeAndProject(this.eventId, {
        dispatchOwnerId: this.dispatchOwnerId,
        terminalOutcome: outcome,
        availability: hasUsage ? "tracked" : "unknown",
        pricingSource,
        costSource,
        ...(this.observation.inputTokens === undefined ? {} : { inputTokens: this.observation.inputTokens }),
        ...(this.observation.outputTokens === undefined ? {} : { outputTokens: this.observation.outputTokens }),
        ...(this.observation.cachedInputTokens === undefined
          ? {}
          : { cachedInputTokens: this.observation.cachedInputTokens }),
        ...(this.observation.costUsd === undefined ? {} : { costUsd: this.observation.costUsd }),
        ...(this.observation.effectiveModelId ? { reportedEffectiveModelId: this.observation.effectiveModelId } : {}),
        ...(this.contextResolutionHash ? { contextResolutionHash: this.contextResolutionHash } : {}),
        ...(error === undefined ? {} : { errorCode: classifyErrorCode(error) }),
        finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - this.startedAtMs),
      });
    } catch (cause) {
      this.settlementFailure = new ModelUsageSettlementError(this.eventId, outcome, cause);
      throw this.settlementFailure;
    }
    this.terminal = result.record;
    return result.record;
  }
}

export class ModelUsageDispatchReservation {
  private settled = false;

  public constructor(
    private readonly repository: ModelUsageEventRepository,
    public readonly eventId: string,
    private readonly startedAtMs: number,
    private readonly dispatchOwnerId: string,
    private readonly acceptedLeaseMs: number,
    private readonly zeroCostProvider: boolean,
    private readonly contextResolutionHash?: string,
  ) {}

  /** Mark the request as a real transport attempt after fetch returned a promise. */
  public accept(): ModelUsageAttemptHandle {
    if (this.settled) throw new Error("Model usage dispatch reservation is already settled");
    this.repository.acceptTransport(
      this.eventId,
      this.dispatchOwnerId,
      new Date(Date.now() + this.acceptedLeaseMs).toISOString(),
    );
    this.settled = true;
    return new ModelUsageAttemptHandle(
      this.repository,
      this.eventId,
      this.startedAtMs,
      this.dispatchOwnerId,
      this.acceptedLeaseMs,
      this.zeroCostProvider,
      this.contextResolutionHash,
    );
  }

  /** Remove an intent when fetch throws synchronously before accepting transport. */
  public abandon(): void {
    if (this.settled) return;
    try {
      if (!this.repository.abandonTransportIntent(this.eventId, this.dispatchOwnerId)) {
        throw new Error("Model usage dispatch intent could not be abandoned");
      }
    } catch (cause) {
      throw new ModelUsageDispatchPersistenceError(this.eventId, "abandon_intent", cause);
    }
    this.settled = true;
  }

  /** Preserve an already-started but not durably accepted dispatch as uncertain. */
  public markDispatchUnknown(reason = "transport_acceptance_persistence_failed"): void {
    if (this.settled) return;
    try {
      this.repository.markDispatchUnknown(this.eventId, this.dispatchOwnerId, new Date().toISOString(), reason);
    } catch (cause) {
      throw new ModelUsageDispatchPersistenceError(this.eventId, "mark_dispatch_unknown", cause);
    }
    this.settled = true;
  }
}

export class ModelUsageAccountingService {
  public constructor(
    private readonly repository: ModelUsageEventRepository,
    private readonly dispatchOwnerId: string = randomUUID(),
    private readonly intentLeaseMs = 5 * 60_000,
    private readonly acceptedLeaseMs = 30 * 60_000,
  ) {}

  /**
   * Reserve an identity before fetch without counting a network attempt. The
   * transport wrapper accepts it only after fetch synchronously returns a
   * promise; synchronous fetch throws abandon the intent and leave no attempt.
   */
  public prepareDispatch(input: BeginModelUsageDispatchInput): ModelUsageDispatchReservation {
    const startedAt = input.startedAt ?? new Date().toISOString();
    const startedAtMs = Date.parse(startedAt);
    const attribution = normalizeAttribution(input.attribution);
    const identity = {
      source: input.source,
      operationId: attribution.operationId,
      dispatchGeneration: attribution.dispatchGeneration,
      attemptIndex: attribution.attemptIndex,
      transportAttemptIndex: input.transportAttemptIndex,
      fallbackIndex: attribution.fallbackIndex,
      repairIndex: attribution.repairIndex,
      requestedReasoningLevel: attribution.requestedReasoningLevel,
      dispatchedReasoningEffort: attribution.dispatchedReasoningEffort,
      reasoningDisposition: attribution.reasoningDisposition,
      reasoningReasonCode: attribution.reasoningReasonCode,
      effectiveProviderId: normalizeOptionalText(input.effectiveProviderId),
      effectiveModelId: normalizeOptionalText(input.effectiveModelId),
    };
    const idempotencyKey = `model-usage:${sha256(JSON.stringify(identity))}`;
    const eventId = randomUUID();
    const result = this.repository.begin({
      eventId,
      idempotencyKey,
      source: input.source,
      callKind: attribution.callKind,
      requestedProviderId: normalizeOptionalText(input.requestedProviderId),
      requestedModelId: normalizeOptionalText(input.requestedModelId),
      requestedReasoningLevel: attribution.requestedReasoningLevel,
      dispatchedReasoningEffort: attribution.dispatchedReasoningEffort,
      reasoningDisposition: attribution.reasoningDisposition,
      reasoningReasonCode: attribution.reasoningReasonCode,
      effectiveProviderId: normalizeOptionalText(input.effectiveProviderId),
      effectiveModelId: normalizeOptionalText(input.effectiveModelId),
      effectiveApiStyle: normalizeOptionalText(input.effectiveApiStyle),
      routeDecisionId: attribution.routeDecisionId,
      contextSnapshotId: attribution.contextSnapshotId,
      contextIntentHash: attribution.contextIntentHash,
      contextEntryRefId: attribution.contextEntryRefId,
      operationId: attribution.operationId,
      parentOperationId: attribution.parentOperationId,
      dispatchGeneration: attribution.dispatchGeneration,
      attemptIndex: attribution.attemptIndex,
      transportAttemptIndex: input.transportAttemptIndex,
      requestedOutputTokenCap: input.outputCap?.requestedOutputTokenCap,
      effectiveOutputTokenCap: input.outputCap?.effectiveOutputTokenCap,
      outputCapDisposition: input.outputCap?.disposition,
      outputCapRecoverySourceEventId: input.outputCap?.recoverySourceEventId,
      outputCapRecoveryReasonCode: input.outputCap?.recoveryReasonCode,
      outputCapProviderAvailableTokens: input.outputCap?.providerAvailableTokens,
      outputCapProviderMinimumTokens: input.outputCap?.providerMinimumTokens,
      outputCapRequestInputEstimate: input.outputCap?.requestInputEstimate,
      outputCapConfiguredContextWindowTokens: input.outputCap?.configuredContextWindowTokens,
      outputCapSafetyMarginTokens: input.outputCap?.safetyMarginTokens,
      outputCapEvidenceFormat: input.outputCap?.evidenceFormat,
      transportRetryParentEventId: input.transportRetry?.parentEventId,
      transportRetryReason: input.transportRetry?.reason,
      dispatchOwnerId: this.dispatchOwnerId,
      dispatchLeaseExpiresAt: new Date(
        (Number.isFinite(startedAtMs) ? startedAtMs : Date.now()) + this.intentLeaseMs,
      ).toISOString(),
      fallbackIndex: attribution.fallbackIndex,
      repairIndex: attribution.repairIndex,
      workspaceId: attribution.workspaceId,
      sessionId: attribution.sessionId,
      turnId: attribution.turnId,
      durableRunId: attribution.durableRunId,
      taskId: attribution.taskId,
      agentId: attribution.agentId,
      assemblyRunId: attribution.assemblyRunId,
      assemblyRoundIndex: attribution.assemblyRoundIndex,
      assemblyStage: attribution.assemblyStage,
      workerId: attribution.workerId,
      utilityKind: attribution.utilityKind,
      credentialType: input.credential.credentialType,
      usagePool: input.credential.usagePool,
      credentialSource: input.credential.credentialSource,
      credentialConfigFingerprint: input.credential.credentialConfigFingerprint,
      pricingCatalogVersion: input.pricing?.catalogVersion,
      pricingCatalogHash: input.pricing?.catalogHash,
      inputRateUsdPerMillion: input.pricing?.inputRateUsdPerMillion,
      outputRateUsdPerMillion: input.pricing?.outputRateUsdPerMillion,
      cachedInputRateUsdPerMillion: input.pricing?.cachedInputRateUsdPerMillion,
      startedAt,
    });
    if (!result.inserted) {
      throw new ModelUsageDispatchUncertainError(
        `Provider dispatch identity already exists (${result.record.terminalOutcome}); advance dispatchGeneration before re-dispatch`,
        { eventId: result.record.eventId },
      );
    }
    return new ModelUsageDispatchReservation(
      this.repository,
      eventId,
      Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
      this.dispatchOwnerId,
      this.acceptedLeaseMs,
      Boolean(
        input.pricing &&
        input.pricing.inputRateUsdPerMillion === 0 &&
        input.pricing.outputRateUsdPerMillion === 0 &&
        input.pricing.cachedInputRateUsdPerMillion === 0,
      ),
      attribution.contextResolutionHash,
    );
  }
}

interface NormalizedAttribution {
  operationId: string;
  dispatchGeneration: string;
  callKind: NonNullable<ModelUsageAttributionContext["callKind"]>;
  attemptIndex: number;
  fallbackIndex: number;
  repairIndex: number;
  requestedReasoningLevel?: string;
  dispatchedReasoningEffort?: string;
  reasoningDisposition?: NonNullable<ModelUsageAttributionContext["reasoningDisposition"]>;
  reasoningReasonCode?: string;
  routeDecisionId?: string;
  contextSnapshotId?: string;
  contextIntentHash?: string;
  contextEntryRefId?: string;
  contextResolutionHash?: string;
  parentOperationId?: string;
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
}

function normalizeAttribution(input: ModelUsageAttributionContext): NormalizedAttribution {
  const operationId = normalizeOptionalText(input.operationId) ?? `unscoped:${randomUUID()}`;
  return {
    operationId,
    dispatchGeneration: normalizeOptionalText(input.dispatchGeneration) ?? randomUUID(),
    callKind: input.callKind ?? "utility",
    attemptIndex: normalizeOrdinal(input.attemptIndex),
    fallbackIndex: normalizeOrdinal(input.fallbackIndex),
    repairIndex: normalizeOrdinal(input.repairIndex),
    ...copyOptionalAttribution(input),
  };
}

function copyOptionalAttribution(input: ModelUsageAttributionContext): Partial<NormalizedAttribution> {
  return {
    ...(normalizeOptionalText(input.routeDecisionId) ? { routeDecisionId: input.routeDecisionId!.trim() } : {}),
    ...(normalizeOptionalText(input.requestedReasoningLevel)
      ? { requestedReasoningLevel: input.requestedReasoningLevel!.trim() }
      : {}),
    ...(normalizeOptionalText(input.dispatchedReasoningEffort)
      ? { dispatchedReasoningEffort: input.dispatchedReasoningEffort!.trim() }
      : {}),
    ...(input.reasoningDisposition ? { reasoningDisposition: input.reasoningDisposition } : {}),
    ...(normalizeOptionalText(input.reasoningReasonCode)
      ? { reasoningReasonCode: input.reasoningReasonCode!.trim() }
      : {}),
    ...(normalizeOptionalText(input.contextSnapshotId) ? { contextSnapshotId: input.contextSnapshotId!.trim() } : {}),
    ...(normalizeOptionalText(input.contextIntentHash) ? { contextIntentHash: input.contextIntentHash!.trim() } : {}),
    ...(normalizeOptionalText(input.contextEntryRefId) ? { contextEntryRefId: input.contextEntryRefId!.trim() } : {}),
    ...(normalizeOptionalText(input.contextResolutionHash)
      ? { contextResolutionHash: input.contextResolutionHash!.trim() }
      : {}),
    ...(normalizeOptionalText(input.parentOperationId) ? { parentOperationId: input.parentOperationId!.trim() } : {}),
    ...(normalizeOptionalText(input.workspaceId) ? { workspaceId: input.workspaceId!.trim() } : {}),
    ...(normalizeOptionalText(input.sessionId) ? { sessionId: input.sessionId!.trim() } : {}),
    ...(normalizeOptionalText(input.turnId) ? { turnId: input.turnId!.trim() } : {}),
    ...(normalizeOptionalText(input.durableRunId) ? { durableRunId: input.durableRunId!.trim() } : {}),
    ...(normalizeOptionalText(input.taskId) ? { taskId: input.taskId!.trim() } : {}),
    ...(normalizeOptionalText(input.agentId) ? { agentId: input.agentId!.trim() } : {}),
    ...(normalizeOptionalText(input.assemblyRunId) ? { assemblyRunId: input.assemblyRunId!.trim() } : {}),
    ...(input.assemblyRoundIndex === undefined
      ? {}
      : { assemblyRoundIndex: normalizeOrdinal(input.assemblyRoundIndex) }),
    ...(normalizeOptionalText(input.assemblyStage) ? { assemblyStage: input.assemblyStage!.trim() } : {}),
    ...(normalizeOptionalText(input.workerId) ? { workerId: input.workerId!.trim() } : {}),
    ...(normalizeOptionalText(input.utilityKind) ? { utilityKind: input.utilityKind!.trim() } : {}),
  };
}

export function normalizeUsageObservation(usage: unknown): ModelUsageObservation {
  if (!isRecord(usage)) return {};
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const costUsd = firstNumber(usage.cost_usd, usage.total_cost_usd, usage.costUsd);
  // Provider payloads cannot claim GoatCitadel's gateway_estimate provenance.
  // Any raw cost is provider-reported; only observeNormalized() may attach the
  // frozen local catalog lineage used for a gateway estimate.
  const source = costUsd === undefined ? undefined : "provider_reported";
  return normalizeObservation({
    inputTokens: firstNumber(usage.prompt_tokens, usage.input_tokens, usage.promptTokenCount),
    outputTokens: firstNumber(usage.completion_tokens, usage.output_tokens, usage.candidatesTokenCount),
    cachedInputTokens: firstNumber(
      usage.cached_prompt_tokens,
      usage.cached_input_tokens,
      usage.cache_read_input_tokens,
      promptDetails?.cached_tokens,
      inputDetails?.cached_tokens,
    ),
    costUsd,
    ...(source ? { costSource: source, pricingSource: source } : {}),
    effectiveModelId: firstText(usage.model, usage.model_id),
  });
}

function normalizeObservation(input: ModelUsageObservation): ModelUsageObservation {
  const hasCost = input.costUsd !== undefined && Number.isFinite(input.costUsd) && input.costUsd >= 0;
  return {
    ...optionalUsageNumber("inputTokens", input.inputTokens, true),
    ...optionalUsageNumber("outputTokens", input.outputTokens, true),
    ...optionalUsageNumber("cachedInputTokens", input.cachedInputTokens, true),
    ...optionalUsageNumber("costUsd", input.costUsd, false),
    ...(hasCost && input.costSource ? { costSource: input.costSource } : {}),
    ...(hasCost && input.pricingSource ? { pricingSource: input.pricingSource } : {}),
    ...(normalizeOptionalText(input.effectiveModelId) ? { effectiveModelId: input.effectiveModelId!.trim() } : {}),
  };
}

function mergeObservations(current: ModelUsageObservation, next: ModelUsageObservation): ModelUsageObservation {
  return {
    ...current,
    ...next,
    ...(next.inputTokens === undefined && current.inputTokens !== undefined
      ? { inputTokens: current.inputTokens }
      : {}),
    ...(next.outputTokens === undefined && current.outputTokens !== undefined
      ? { outputTokens: current.outputTokens }
      : {}),
    ...(next.cachedInputTokens === undefined && current.cachedInputTokens !== undefined
      ? { cachedInputTokens: current.cachedInputTokens }
      : {}),
    ...(next.costUsd === undefined && current.costUsd !== undefined ? { costUsd: current.costUsd } : {}),
  };
}

function hasAnyUsage(value: ModelUsageObservation): boolean {
  return (
    value.inputTokens !== undefined ||
    value.outputTokens !== undefined ||
    value.cachedInputTokens !== undefined ||
    value.costUsd !== undefined
  );
}

function classifyErrorCode(error: unknown): string {
  if (isCancellation(error)) return "cancelled";
  if (error instanceof Error) {
    const name = error.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/gu, "_")
      .slice(0, 80);
    return name || "provider_error";
  }
  return "provider_error";
}

function isCancellation(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "AbortError" || /\b(?:abort|cancel)(?:led|ed)?\b/iu.test(error.message);
  }
  return false;
}

function optionalUsageNumber<Key extends keyof ModelUsageNumbers>(
  key: Key,
  value: number | undefined,
  integer: boolean,
): Partial<Pick<ModelUsageNumbers, Key>> {
  if (value === undefined || !Number.isFinite(value) || value < 0) return {};
  const normalized = integer ? Math.floor(value) : value;
  return { [key]: normalized } as Partial<Pick<ModelUsageNumbers, Key>>;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeOrdinal(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
