import { createHash } from "node:crypto";
import type {
  ExternalSideEffectRunRecord,
  ExternalSideEffectRunStatus,
  IntegrationExternalWritebackEnvelope,
  IntegrationExternalWritebackResumeState,
  IntegrationExternalWritebackReplayOutcome,
  IntegrationExternalWritebackReplayPolicy,
} from "@goatcitadel/contracts";
import type { EvidenceEnvelopeService } from "./evidence-envelope-service.js";
import type { MutationIdempotencyStore } from "./mutation-idempotency-store.js";

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
}

export function recordAuditOnlyExternalSideEffectIntent(
  input: ExternalSideEffectIntentInput,
): IntegrationExternalWritebackEnvelope {
  const intentId = buildExternalSideEffectIntentId(input);
  const idempotencyKey = input.idempotencyKey ?? buildExternalSideEffectIdempotencyKey(input);
  const replayPolicy = input.replayPolicy ?? "audit_only";
  const resumable = input.resumable ?? false;
  const resumeState = input.resumeState ?? "not_resumable";
  const common = {
    intentId,
    idempotencyKey,
    replayPolicy,
    replayOutcome: input.replayOutcome,
    payloadHash: input.payloadHash,
    resumable,
    resumeState,
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

export interface ExternalSideEffectClaimInput {
  mutationStore?: MutationIdempotencyStore;
  sideEffectRunStore?: ExternalSideEffectRunStore;
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
  /** Call immediately before the provider or bridge request crosses the external side-effect boundary. */
  markExternalCallStarted(): void;
}

export interface IdempotentExternalSideEffectRunInput<TValue> extends ExternalSideEffectClaimInput {
  label: string;
  output?: Record<string, unknown>;
  execute(claim: ExternalSideEffectExecutionContext): Promise<TValue>;
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

  const claim = input.mutationStore.claim({
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
  const markExternalCallStarted = () => {
    if (!externalCallStarted) {
      markExternalSideEffectRunStarted(input.sideEffectRunStore, claim, input.checkedAt);
      externalCallStarted = true;
    }
  };
  const executionClaim: ExternalSideEffectExecutionContext = {
    ...claim,
    get externalCallStarted() {
      return externalCallStarted;
    },
    markExternalCallStarted,
  };

  try {
    const value = await input.execute(executionClaim);
    markExternalCallStarted();
    markIdempotentExternalSideEffectCompleted(input.mutationStore, claim, input.checkedAt);
    markExternalSideEffectRunCompleted(input.sideEffectRunStore, claim, value, input.checkedAt);
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
    markIdempotentExternalSideEffectFailed(input.mutationStore, claim, input.checkedAt);
    markExternalSideEffectRunFailed(input.sideEffectRunStore, claim, error, externalCallStarted, input.checkedAt);
    const failedClaim = {
      ...claim,
      resumable: false,
      resumeState: "manual_retry_after_recorded_failure" as const,
    };
    return {
      status: "failed",
      claim: failedClaim,
      error: error instanceof Error ? error : new Error("external_side_effect_failed"),
      output: buildExternalSideEffectReplayOutput(failedClaim, input.output),
    };
  }
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
  return {
    valueKind: "object",
    keys: Object.keys(record).sort(),
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
  for (const key of ["id", "messageId", "threadId", "url", "webUrl"]) {
    const field = (output as Record<string, unknown>)[key];
    if (typeof field === "string" && field.trim()) {
      return `${key}:${field.trim().slice(0, 128)}`;
    }
  }
  return undefined;
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
  return createHash("sha256")
    .update(JSON.stringify(parts.map((part) => part ?? "")))
    .digest("hex")
    .slice(0, 24);
}

function hashStableJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
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
