import { createHash } from "node:crypto";
import type {
  ExternalSideEffectRunRecord,
  ExternalSideEffectRunStatus,
  IntegrationExternalWritebackEnvelope,
  IntegrationExternalWritebackResumeState,
  IntegrationExternalWritebackReplayOutcome,
  IntegrationExternalWritebackReplayPolicy,
  OperatorActionReversibility,
  WardEffect,
} from "@goatcitadel/contracts";
import type { EvidenceEnvelopeService } from "./evidence-envelope-service.js";
import type { MutationIdempotencyStore } from "./mutation-idempotency-store.js";
import { wardRequiresDryRun } from "./dry-run-commit-service.js";

const EXTERNAL_SIDE_EFFECT_DIGEST_DOMAIN_KEY = "goatcitadel:external-side-effect-digest:v1";

export interface ExternalSideEffectRunStore {
  createOrGet(
    input: {
      workspaceId?: string;
      boundary: string;
      routePath: string;
      catalogId?: string;
      connectionId?: string;
      actionId?: string;
      actorScope?: string;
      idempotencyKey: string;
      payloadHash: string;
      status?: ExternalSideEffectRunStatus;
      replayOutcome?: IntegrationExternalWritebackReplayOutcome;
      replayAttempt?: ExternalSideEffectClaimResult["replayAttempt"];
      requestPayload?: Record<string, unknown>;
    },
    now?: string,
  ): ExternalSideEffectRunRecord;
  markExternalCallStarted(runId: string, input?: { attemptCount?: number }, now?: string): ExternalSideEffectRunRecord;
  markCompleted(
    runId: string,
    input?: {
      replayOutcome?: IntegrationExternalWritebackReplayOutcome;
      responsePayload?: Record<string, unknown>;
      externalReferenceId?: string;
      envelopeId?: string;
    },
    now?: string,
  ): ExternalSideEffectRunRecord;
  markFailure(
    runId: string,
    input: {
      status: "failed_before_boundary" | "unknown_external_outcome";
      errorText: string;
      responsePayload?: Record<string, unknown>;
    },
    now?: string,
  ): ExternalSideEffectRunRecord;
}

export interface ExternalSideEffectIntentInput {
  evidenceEnvelopeService?: Pick<EvidenceEnvelopeService, "createEnvelope">;
  boundary: string;
  checkedAt: string;
  status: string;
  message: string;
  blockedReason?: string;
  connectionId?: string;
  catalogId?: string;
  integrationKey?: string;
  actionId?: string;
  actionLabel?: string;
  actionCapability?: string;
  replayPolicy?: IntegrationExternalWritebackReplayPolicy;
  replayOutcome?: IntegrationExternalWritebackReplayOutcome;
  resumable?: boolean;
  resumeState?: IntegrationExternalWritebackResumeState;
  idempotencyKey?: string;
  payloadHash?: string;
  inputKeys?: string[];
  outputKeys?: string[];
  externalReferenceId?: string;
  reversibility?: OperatorActionReversibility;
}

export function recordAuditOnlyExternalSideEffectIntent(
  input: ExternalSideEffectIntentInput,
): IntegrationExternalWritebackEnvelope {
  const intentId = buildExternalSideEffectIntentId(input);
  const idempotencyKey = input.idempotencyKey ?? buildExternalSideEffectIdempotencyKey(input);
  const replayPolicy = input.replayPolicy ?? "audit_only";
  const resumable = input.resumable ?? false;
  const resumeState = input.resumeState ?? "not_resumable";
  const reversibility =
    input.reversibility ??
    deriveExternalSideEffectReversibility({
      replayPolicy,
      resumable,
      resumeState,
      status: input.status,
      intentId,
    });
  const common = {
    intentId,
    idempotencyKey,
    replayPolicy,
    replayOutcome: input.replayOutcome,
    payloadHash: input.payloadHash,
    resumable,
    resumeState,
    reversibility,
    checkedAt: input.checkedAt,
  };
  if (!input.evidenceEnvelopeService) {
    return {
      ...common,
      status: "unavailable",
      reason: "evidence_service_unavailable",
    };
  }
  try {
    const envelope = input.evidenceEnvelopeService.createEnvelope({
      eventKind: "external_writeback",
      metadata: {
        boundary: input.boundary,
        externalSideEffect: true,
        externalSideEffectIntentId: intentId,
        externalSideEffectIdempotencyKey: idempotencyKey,
        replayPolicy,
        replayOutcome: input.replayOutcome,
        payloadHash: input.payloadHash,
        resumable,
        resumeState,
        reversibilityStatus: reversibility.status,
        reversibilityDetail: reversibility.detail,
        reversibilityEvidenceRef: reversibility.evidenceRef,
        connectionId: input.connectionId,
        catalogId: input.catalogId,
        integrationKey: input.integrationKey,
        actionId: input.actionId,
        actionLabel: input.actionLabel,
        actionCapability: input.actionCapability,
        status: input.status,
        blockedReason: input.blockedReason,
        inputKeys: input.inputKeys ?? [],
        outputKeys: input.outputKeys ?? [],
        externalReferenceId: input.externalReferenceId,
        message: input.message,
      },
      createdAt: input.checkedAt,
    });
    return {
      ...common,
      status: "recorded",
      envelopeId: envelope.envelopeId,
      contentHash: envelope.contentHash,
      signatureStatus: envelope.signatureStatus,
      recordedAt: envelope.createdAt,
    };
  } catch (error) {
    return {
      ...common,
      status: "failed",
      reason: error instanceof Error ? error.message : "external_side_effect_envelope_failed",
    };
  }
}

export function deriveExternalSideEffectReversibility(input: {
  replayPolicy: IntegrationExternalWritebackReplayPolicy;
  resumable: boolean;
  resumeState: IntegrationExternalWritebackResumeState;
  status: string;
  intentId?: string;
}): OperatorActionReversibility {
  if (input.resumeState === "manual_review_unknown_external_outcome") {
    return {
      status: "manual_reconciliation",
      label: "Manual reconciliation",
      detail:
        "The external boundary may have been crossed. GoatCitadel cannot safely undo or retry without operator/provider confirmation.",
      evidenceRef: input.intentId,
    };
  }
  if (
    input.replayPolicy === "idempotent_external" &&
    (input.resumable ||
      input.resumeState === "manual_retry_after_recorded_failure" ||
      input.status === "claimed_not_sent" ||
      input.status === "failed_before_boundary")
  ) {
    return {
      status: "replay_audit_only",
      label: "Replay audit only",
      detail:
        "No inverse operation is available. Gateway can audit pre-boundary eligibility before any operator-triggered retry.",
      evidenceRef: input.intentId,
    };
  }
  return {
    status: "irreversible",
    label: "Cannot undo",
    detail:
      "No durable inverse operation is registered for this external action; completed or post-boundary effects remain provider/manual work.",
    evidenceRef: input.intentId,
  };
}

export interface ExternalSideEffectClaimInput {
  mutationStore?: MutationIdempotencyStore;
  sideEffectRunStore?: ExternalSideEffectRunStore;
  /** Atomically owns the mutation claim and its operator-visible side-effect run. */
  runClaimTransaction?<T>(work: () => T): T;
  workspaceId?: string;
  boundary: string;
  catalogId?: string;
  connectionId?: string;
  actionId?: string;
  checkedAt: string;
  idempotencyKey?: string;
  actorScope?: string;
  payload: unknown;
}

export interface ExternalSideEffectClaimResult {
  replayPolicy: "idempotent_external";
  replayOutcome: IntegrationExternalWritebackReplayOutcome;
  replayAttempt: "new" | "retry_after_failure" | "blocked" | "unavailable";
  resumable: boolean;
  resumeState: IntegrationExternalWritebackResumeState;
  idempotencyKey: string;
  payloadHash: string;
  actorScope: string;
  routePath: string;
  sideEffectRunId?: string;
}

export interface ExternalSideEffectExecutionContext extends ExternalSideEffectClaimResult {
  readonly externalCallStarted: boolean;
  readonly externalCallNotRequired: boolean;
  /** Call immediately before the provider or bridge request crosses the external side-effect boundary. */
  markExternalCallStarted(): void;
  /** Call only when preflight completed safely without crossing an external boundary. */
  markExternalCallNotRequired(): void;
}

export interface IdempotentExternalSideEffectRunInput<TValue> extends ExternalSideEffectClaimInput {
  label: string;
  output?: Record<string, unknown>;
  /**
   * Require the operator-visible side-effect ledger to record the boundary
   * before provider code runs. Intended for durable workflows where a missing
   * boundary marker must fail closed instead of creating a replay ambiguity.
   */
  requireDurableBoundaryRecord?: boolean;
  /**
   * The Citadel Ward effect resolved for this action (via evaluateWards()). When it is
   * `require_dry_run`, a direct execute is REFUSED before the boundary — the side-effect must
   * instead go through the provable dry-run → approve → commit flow (see dry-run-commit-service).
   * Absent / any other effect → behaves exactly as before (backward-compatible).
   */
  wardEffect?: WardEffect;
  execute(claim: ExternalSideEffectExecutionContext): Promise<TValue>;
  /** Optional canonical completion commit. When present it owns all terminal stores atomically. */
  commitCompleted?(claim: ExternalSideEffectExecutionContext, value: TValue): void;
}

export type IdempotentExternalSideEffectRunResult<TValue> =
  | {
      status: "executed";
      claim: ExternalSideEffectClaimResult;
      value: TValue;
    }
  | {
      status: "blocked";
      claim: ExternalSideEffectClaimResult;
      message: string;
      blockedReason: string;
      output: Record<string, unknown>;
    }
  | {
      status: "failed";
      claim: ExternalSideEffectClaimResult;
      error: Error;
      output: Record<string, unknown>;
    };

export type ExternalSideEffectReplayWorkerSkipReason =
  | "claimed_not_sent_not_stale"
  | "completed"
  | "external_boundary_already_crossed"
  | "blocked_or_unrecoverable"
  | "idempotency_unavailable"
  | "job_unavailable"
  | "job_identity_mismatch";

export type ExternalSideEffectReplayWorkerResult<TValue> =
  | {
      status: "executed";
      run: ExternalSideEffectRunRecord;
      result: Extract<IdempotentExternalSideEffectRunResult<TValue>, { status: "executed" }>;
    }
  | {
      status: "blocked";
      run: ExternalSideEffectRunRecord;
      result: Extract<IdempotentExternalSideEffectRunResult<TValue>, { status: "blocked" }>;
    }
  | {
      status: "failed";
      run: ExternalSideEffectRunRecord;
      result: Extract<IdempotentExternalSideEffectRunResult<TValue>, { status: "failed" }>;
    }
  | {
      status: "skipped";
      run: ExternalSideEffectRunRecord;
      reason: ExternalSideEffectReplayWorkerSkipReason;
      message: string;
    };

export interface ExternalSideEffectReplayWorkerInput<TValue> {
  runs: ExternalSideEffectRunRecord[];
  checkedAt: string;
  staleClaimedNotSentAfterMs?: number;
  limit?: number;
  buildJob(run: ExternalSideEffectRunRecord): IdempotentExternalSideEffectRunInput<TValue> | undefined;
}

export function claimIdempotentExternalSideEffect(input: ExternalSideEffectClaimInput): ExternalSideEffectClaimResult {
  const payloadHash = hashStableJson(input.payload);
  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    hashStableIntentParts([input.boundary, input.catalogId, input.connectionId, input.actionId, payloadHash]);
  const actorScope = input.actorScope?.trim() || input.connectionId || input.catalogId || "";
  const routePath = [
    "external_side_effect",
    input.boundary,
    input.catalogId ?? "unknown_catalog",
    input.connectionId ?? "unknown_connection",
    input.actionId ?? "unknown_action",
  ].join(":");

  if (!input.mutationStore) {
    return recordExternalSideEffectRun(input, {
      replayPolicy: "idempotent_external",
      replayOutcome: "idempotency_unavailable",
      replayAttempt: "unavailable",
      resumable: false,
      resumeState: "idempotency_unavailable",
      idempotencyKey,
      payloadHash,
      actorScope,
      routePath,
    });
  }

  const claimAndRecord = (): ExternalSideEffectClaimResult => {
    const claim = input.mutationStore!.claim({
      method: "POST",
      routePath,
      idempotencyKey,
      actorScope,
      payloadHash,
      now: input.checkedAt,
    });
    return recordExternalSideEffectRun(input, {
      replayPolicy: "idempotent_external",
      replayOutcome: claim.outcome,
      replayAttempt: claim.outcome === "claimed" ? (claim.claimKind ?? "new") : "blocked",
      resumable: false,
      resumeState: mapExternalSideEffectResumeState(claim.outcome),
      idempotencyKey,
      payloadHash,
      actorScope,
      routePath,
    });
  };
  return input.sideEffectRunStore && input.runClaimTransaction
    ? input.runClaimTransaction(claimAndRecord)
    : claimAndRecord();
}

export async function runReplaySafeExternalSideEffectWorker<TValue>(
  input: ExternalSideEffectReplayWorkerInput<TValue>,
): Promise<Array<ExternalSideEffectReplayWorkerResult<TValue>>> {
  const limit = clampReplayWorkerLimit(input.limit ?? input.runs.length);
  const results: Array<ExternalSideEffectReplayWorkerResult<TValue>> = [];
  for (const run of input.runs.slice(0, limit)) {
    const eligibility = readExternalSideEffectReplayEligibility(run, input.checkedAt, input.staleClaimedNotSentAfterMs);
    if (!eligibility.eligible) {
      results.push({
        status: "skipped",
        run,
        reason: eligibility.reason,
        message: eligibility.message,
      });
      continue;
    }
    const job = input.buildJob(run);
    if (!job) {
      results.push({
        status: "skipped",
        run,
        reason: "job_unavailable",
        message:
          "External side-effect replay requires the owning integration to reconstruct the original safe payload; no replay job was available.",
      });
      continue;
    }
    const identityMismatch = readReplayJobIdentityMismatch(run, job);
    if (identityMismatch) {
      results.push({
        status: "skipped",
        run,
        reason: "job_identity_mismatch",
        message: identityMismatch,
      });
      continue;
    }
    markPreBoundaryReplayReady(job.mutationStore, run, input.checkedAt);
    const result = await runIdempotentExternalSideEffect(job);
    if (result.status === "executed") {
      results.push({ status: "executed", run, result });
    } else if (result.status === "blocked") {
      results.push({ status: "blocked", run, result });
    } else {
      results.push({ status: "failed", run, result });
    }
  }
  return results;
}

export async function runIdempotentExternalSideEffect<TValue>(
  input: IdempotentExternalSideEffectRunInput<TValue>,
): Promise<IdempotentExternalSideEffectRunResult<TValue>> {
  // Citadel Ward enforcement: a `require_dry_run` Ward forbids executing this side-effect directly.
  // It must instead be routed through the provable dry-run → approve → commit flow. We refuse here,
  // BEFORE the idempotency claim or any boundary work, so a direct `execute` can never slip through.
  if (wardRequiresDryRun(input.wardEffect)) {
    const claim = recordExternalSideEffectRun(input, {
      replayPolicy: "idempotent_external",
      replayOutcome: "idempotency_unavailable",
      replayAttempt: "blocked",
      resumable: false,
      resumeState: "not_resumable",
      idempotencyKey:
        input.idempotencyKey?.trim() ||
        hashStableIntentParts([
          input.boundary,
          input.catalogId,
          input.connectionId,
          input.actionId,
          hashStableJson(input.payload),
        ]),
      payloadHash: hashStableJson(input.payload),
      actorScope: input.actorScope?.trim() || input.connectionId || input.catalogId || "",
      routePath: [
        "external_side_effect",
        input.boundary,
        input.catalogId ?? "unknown_catalog",
        input.connectionId ?? "unknown_connection",
        input.actionId ?? "unknown_action",
      ].join(":"),
    });
    return {
      status: "blocked",
      claim,
      message: `${input.label} requires a provable dry-run → approved commit (Citadel Ward "require_dry_run"); direct execution was refused before the external boundary.`,
      blockedReason: "external_side_effect_dry_run_required",
      output: buildExternalSideEffectReplayOutput(claim, {
        ...input.output,
        wardEffect: input.wardEffect,
        dryRunRequired: true,
      }),
    };
  }

  const claim = claimIdempotentExternalSideEffect(input);
  if (claim.replayOutcome !== "claimed") {
    return {
      status: "blocked",
      claim,
      message: formatExternalSideEffectReplayBlockMessage(input.label, claim.replayOutcome),
      blockedReason: `external_side_effect_${claim.replayOutcome}`,
      output: buildExternalSideEffectReplayOutput(claim, input.output),
    };
  }

  let externalCallStarted = false;
  let externalCallNotRequired = false;
  let boundaryClaimLost = false;
  const markExternalCallStarted = () => {
    if (!externalCallStarted) {
      if (input.requireDurableBoundaryRecord) {
        if (!input.sideEffectRunStore || !claim.sideEffectRunId) {
          throw new Error(`${input.label} requires a durable external-boundary record before execution.`);
        }
        try {
          markExternalSideEffectRunStarted(input.sideEffectRunStore, claim, input.checkedAt);
        } catch (error) {
          boundaryClaimLost = isExternalSideEffectBoundaryClaimLostError(error);
          throw error;
        }
        externalCallStarted = true;
        return;
      }
      externalCallStarted = true;
      try {
        markExternalSideEffectRunStarted(input.sideEffectRunStore, claim, input.checkedAt);
      } catch {
        // Legacy callers retain best-effort mirror behavior. Strict durable
        // callers opt into the fail-closed branch above.
      }
    }
  };
  const markExternalCallNotRequired = () => {
    if (externalCallStarted) {
      throw new Error(`${input.label} cannot skip an external boundary after the external call started.`);
    }
    externalCallNotRequired = true;
  };
  const executionClaim: ExternalSideEffectExecutionContext = {
    ...claim,
    get externalCallStarted() {
      return externalCallStarted;
    },
    get externalCallNotRequired() {
      return externalCallNotRequired;
    },
    markExternalCallStarted,
    markExternalCallNotRequired,
  };

  try {
    const value = await input.execute(executionClaim);
    if (input.requireDurableBoundaryRecord && !externalCallStarted && !externalCallNotRequired) {
      // The callback violated the strict contract. Treat the outcome as unknown:
      // provider code may have run, so never reopen the mutation for retry.
      externalCallStarted = true;
      throw new Error(`${input.label} crossed execution without recording its durable external boundary.`);
    }
    if (!externalCallStarted && !externalCallNotRequired) {
      markExternalCallStarted();
    }
    if (input.commitCompleted) {
      input.commitCompleted(executionClaim, value);
    } else {
      safeMarkIdempotentExternalSideEffectCompleted(input.mutationStore, claim, input.checkedAt);
      safeMarkExternalSideEffectRunCompleted(input.sideEffectRunStore, claim, value, input.checkedAt);
    }
    return {
      status: "executed",
      claim: {
        ...claim,
        resumable: false,
        resumeState: "completed",
      },
      value,
    };
  } catch (error) {
    const manualReconciliationRequired = externalCallStarted || boundaryClaimLost;
    if (!manualReconciliationRequired) {
      markIdempotentExternalSideEffectFailed(input.mutationStore, claim, input.checkedAt);
    }
    safeMarkExternalSideEffectRunFailed(
      input.sideEffectRunStore,
      claim,
      error,
      manualReconciliationRequired,
      input.checkedAt,
    );
    const failedClaim = {
      ...claim,
      resumable: false,
      resumeState: manualReconciliationRequired
        ? ("manual_review_unknown_external_outcome" as const)
        : ("manual_retry_after_recorded_failure" as const),
    };
    return {
      status: "failed",
      claim: failedClaim,
      error: error instanceof Error ? error : new Error("external_side_effect_failed"),
      output: buildExternalSideEffectReplayOutput(failedClaim, input.output),
    };
  }
}

function isExternalSideEffectBoundaryClaimLostError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EXTERNAL_SIDE_EFFECT_BOUNDARY_CLAIM_LOST"
  );
}

function readExternalSideEffectReplayEligibility(
  run: ExternalSideEffectRunRecord,
  checkedAt: string,
  staleClaimedNotSentAfterMs = 5 * 60 * 1000,
): { eligible: true } | { eligible: false; reason: ExternalSideEffectReplayWorkerSkipReason; message: string } {
  if (run.status === "failed_before_boundary") {
    return { eligible: true };
  }
  if (run.status === "claimed_not_sent") {
    const updatedAt = Date.parse(run.updatedAt);
    const now = Date.parse(checkedAt);
    if (Number.isFinite(updatedAt) && Number.isFinite(now) && now - updatedAt >= staleClaimedNotSentAfterMs) {
      return { eligible: true };
    }
    return {
      eligible: false,
      reason: "claimed_not_sent_not_stale",
      message: "Pre-boundary claim is still recent; the worker left it alone to avoid racing a live request.",
    };
  }
  if (run.status === "completed" || run.status === "blocked_duplicate") {
    return {
      eligible: false,
      reason: "completed",
      message: "External side-effect run is already completed or blocked as a duplicate.",
    };
  }
  if (run.status === "external_call_started" || run.status === "unknown_external_outcome") {
    return {
      eligible: false,
      reason: "external_boundary_already_crossed",
      message:
        "External boundary was already crossed; replay is blocked until an operator reconciles the external system.",
    };
  }
  if (run.status === "idempotency_unavailable") {
    return {
      eligible: false,
      reason: "idempotency_unavailable",
      message: "Replay-safe idempotency was unavailable for this run, so the worker will not retry it.",
    };
  }
  return {
    eligible: false,
    reason: "blocked_or_unrecoverable",
    message: "External side-effect run is not recoverable by the replay worker.",
  };
}

function markPreBoundaryReplayReady(
  mutationStore: MutationIdempotencyStore | undefined,
  run: ExternalSideEffectRunRecord,
  checkedAt: string,
): void {
  mutationStore?.markFailed({
    method: "POST",
    routePath: run.routePath,
    idempotencyKey: run.idempotencyKey,
    actorScope: run.actorScope,
    updatedAt: checkedAt,
  });
}

function readReplayJobIdentityMismatch<TValue>(
  run: ExternalSideEffectRunRecord,
  job: IdempotentExternalSideEffectRunInput<TValue>,
): string | undefined {
  if (job.idempotencyKey !== run.idempotencyKey) {
    return "Replay job must preserve the original external side-effect idempotency key.";
  }
  if (job.boundary !== run.boundary) {
    return "Replay job boundary does not match the recorded external side-effect run.";
  }
  if (job.catalogId !== run.catalogId || job.connectionId !== run.connectionId || job.actionId !== run.actionId) {
    return "Replay job capability identity does not match the recorded external side-effect run.";
  }
  return undefined;
}

export function buildExternalSideEffectReplayOutput(
  claim: ExternalSideEffectClaimResult,
  output: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...output,
    replayPolicy: claim.replayPolicy,
    replayOutcome: claim.replayOutcome,
    replayAttempt: claim.replayAttempt,
    resumable: claim.resumable,
    resumeState: claim.resumeState,
    ...(claim.sideEffectRunId ? { sideEffectRunId: claim.sideEffectRunId } : {}),
    idempotencyKey: claim.idempotencyKey,
    payloadHash: claim.payloadHash,
  };
}

function mapExternalSideEffectResumeState(
  outcome: IntegrationExternalWritebackReplayOutcome,
): IntegrationExternalWritebackResumeState {
  if (outcome === "duplicate") {
    return "completed";
  }
  if (outcome === "in_progress") {
    return "in_progress";
  }
  if (outcome === "payload_mismatch") {
    return "payload_mismatch";
  }
  if (outcome === "idempotency_unavailable") {
    return "idempotency_unavailable";
  }
  return "not_resumable";
}

function recordExternalSideEffectRun(
  input: ExternalSideEffectClaimInput,
  claim: ExternalSideEffectClaimResult,
): ExternalSideEffectClaimResult {
  if (!input.sideEffectRunStore) {
    return claim;
  }
  const run = input.sideEffectRunStore.createOrGet(
    {
      workspaceId: input.workspaceId,
      boundary: input.boundary,
      routePath: claim.routePath,
      catalogId: input.catalogId,
      connectionId: input.connectionId,
      actionId: input.actionId,
      actorScope: claim.actorScope,
      idempotencyKey: claim.idempotencyKey,
      payloadHash: claim.payloadHash,
      status: externalRunStatusForReplayOutcome(claim.replayOutcome),
      replayOutcome: claim.replayOutcome,
      replayAttempt: claim.replayAttempt,
      requestPayload: summarizeExternalSideEffectPayload(input.payload),
    },
    input.checkedAt,
  );
  return {
    ...claim,
    sideEffectRunId: run.runId,
  };
}

function externalRunStatusForReplayOutcome(
  outcome: IntegrationExternalWritebackReplayOutcome,
): ExternalSideEffectRunStatus {
  if (outcome === "duplicate") {
    return "blocked_duplicate";
  }
  if (outcome === "payload_mismatch") {
    return "payload_mismatch";
  }
  if (outcome === "idempotency_unavailable") {
    return "idempotency_unavailable";
  }
  return "claimed_not_sent";
}

function markExternalSideEffectRunStarted(
  store: ExternalSideEffectRunStore | undefined,
  claim: ExternalSideEffectClaimResult,
  checkedAt: string,
): void {
  if (claim.sideEffectRunId) {
    store?.markExternalCallStarted(claim.sideEffectRunId, undefined, checkedAt);
  }
}

function safeMarkIdempotentExternalSideEffectCompleted(
  mutationStore: MutationIdempotencyStore | undefined,
  claim: ExternalSideEffectClaimResult,
  checkedAt: string,
): void {
  try {
    markIdempotentExternalSideEffectCompleted(mutationStore, claim, checkedAt);
  } catch {
    // The external boundary has already been crossed. Do not reopen this
    // idempotency key for automatic retry just because local bookkeeping failed.
  }
}

function safeMarkExternalSideEffectRunCompleted(
  store: ExternalSideEffectRunStore | undefined,
  claim: ExternalSideEffectClaimResult,
  value: unknown,
  checkedAt: string,
): void {
  try {
    markExternalSideEffectRunCompleted(store, claim, value, checkedAt);
  } catch (error) {
    safeMarkExternalSideEffectRunFailed(store, claim, error, true, checkedAt);
  }
}

function safeMarkExternalSideEffectRunFailed(
  store: ExternalSideEffectRunStore | undefined,
  claim: ExternalSideEffectClaimResult,
  error: unknown,
  externalCallStarted: boolean,
  checkedAt: string,
): void {
  try {
    markExternalSideEffectRunFailed(store, claim, error, externalCallStarted, checkedAt);
  } catch {
    // Best effort only: callers still receive the original execution result.
  }
}

function markExternalSideEffectRunCompleted(
  store: ExternalSideEffectRunStore | undefined,
  claim: ExternalSideEffectClaimResult,
  value: unknown,
  checkedAt: string,
): void {
  if (claim.sideEffectRunId) {
    store?.markCompleted(
      claim.sideEffectRunId,
      {
        replayOutcome: claim.replayOutcome,
        responsePayload: summarizeExternalSideEffectPayload(value),
        externalReferenceId: readExternalReferenceId(value),
      },
      checkedAt,
    );
  }
}

function markExternalSideEffectRunFailed(
  store: ExternalSideEffectRunStore | undefined,
  claim: ExternalSideEffectClaimResult,
  error: unknown,
  externalCallStarted: boolean,
  checkedAt: string,
): void {
  if (claim.sideEffectRunId) {
    store?.markFailure(
      claim.sideEffectRunId,
      {
        status: externalCallStarted ? "unknown_external_outcome" : "failed_before_boundary",
        errorText: error instanceof Error ? error.message : "external_side_effect_failed",
      },
      checkedAt,
    );
  }
}

function summarizeExternalSideEffectPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return { valueKind: typeof value };
  }
  if (Array.isArray(value)) {
    return { valueKind: "array", itemCount: value.length };
  }
  const record = value as Record<string, unknown>;
  const source =
    record.output && typeof record.output === "object" && !Array.isArray(record.output)
      ? (record.output as Record<string, unknown>)
      : record;
  const workflowRunId = readFirstExternalSideEffectString(source, ["workflowRunId", "flowRunId", "runId", "run_id"]);
  const workflowRunStatus = readFirstExternalSideEffectString(source, ["workflowRunStatus", "flowRunStatus", "status"]);
  const workflowRunUrl = sanitizeExternalSideEffectUrl(
    readFirstExternalSideEffectString(source, ["workflowRunUrl", "flowRunUrl", "webUrl", "url"]),
  );
  return {
    valueKind: "object",
    keys: Object.keys(record).sort(),
    ...(workflowRunId ? { workflowRunId } : {}),
    ...(workflowRunStatus ? { workflowRunStatus } : {}),
    ...(workflowRunUrl ? { workflowRunUrl } : {}),
    ...(workflowRunStatus ? { workflowRunStatusSource: "webhook_response" } : {}),
  };
}

function readExternalReferenceId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const output =
    record.output && typeof record.output === "object" && !Array.isArray(record.output) ? record.output : record;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return undefined;
  }
  for (const key of ["workflowRunId", "flowRunId", "runId", "run_id", "id", "messageId", "threadId", "url", "webUrl"]) {
    const field = (output as Record<string, unknown>)[key];
    if (typeof field === "string" && field.trim()) {
      return `${key}:${field.trim().slice(0, 128)}`;
    }
  }
  return undefined;
}

function readFirstExternalSideEffectString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 512);
    }
  }
  return undefined;
}

function sanitizeExternalSideEffectUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function markIdempotentExternalSideEffectCompleted(
  mutationStore: MutationIdempotencyStore | undefined,
  claim: ExternalSideEffectClaimResult,
  updatedAt: string,
): void {
  mutationStore?.markCompleted({
    method: "POST",
    routePath: claim.routePath,
    idempotencyKey: claim.idempotencyKey,
    actorScope: claim.actorScope,
    updatedAt,
  });
}

export function markIdempotentExternalSideEffectFailed(
  mutationStore: MutationIdempotencyStore | undefined,
  claim: ExternalSideEffectClaimResult,
  updatedAt: string,
): void {
  mutationStore?.markFailed({
    method: "POST",
    routePath: claim.routePath,
    idempotencyKey: claim.idempotencyKey,
    actorScope: claim.actorScope,
    updatedAt,
  });
}

function formatExternalSideEffectReplayBlockMessage(
  label: string,
  outcome: IntegrationExternalWritebackReplayOutcome,
): string {
  if (outcome === "duplicate") {
    return `${label} already completed for this idempotency key; the external request was not sent again.`;
  }
  if (outcome === "in_progress") {
    return `${label} is already in progress for this idempotency key; the external request was not sent again.`;
  }
  if (outcome === "payload_mismatch") {
    return `${label} idempotency key was reused with a different payload; the external request was not sent.`;
  }
  return `${label} replay-safe idempotency is unavailable; the external request was not sent.`;
}

function buildExternalSideEffectIntentId(input: ExternalSideEffectIntentInput): string {
  return `external-side-effect-${hashStableIntentParts([input.boundary, input.catalogId, input.connectionId, input.actionId, input.checkedAt])}`;
}

function buildExternalSideEffectIdempotencyKey(input: ExternalSideEffectIntentInput): string {
  return hashStableIntentParts([
    input.boundary,
    input.catalogId,
    input.connectionId,
    input.actionId,
    input.externalReferenceId,
    ...(input.inputKeys ?? []),
    ...(input.outputKeys ?? []),
  ]);
}

function hashStableIntentParts(parts: Array<string | undefined>): string {
  return domainSeparatedDigestHex(JSON.stringify(parts.map((part) => part ?? ""))).slice(0, 24);
}

function domainSeparatedDigestHex(canonicalPayload: string): string {
  return createHash("sha256")
    .update(EXTERNAL_SIDE_EFFECT_DIGEST_DOMAIN_KEY)
    .update("\0")
    .update(canonicalPayload)
    .digest("hex");
}

function hashStableJson(value: unknown): string {
  return domainSeparatedDigestHex(stableStringify(value));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function clampReplayWorkerLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 100;
  }
  return Math.max(0, Math.min(500, Math.floor(value)));
}
