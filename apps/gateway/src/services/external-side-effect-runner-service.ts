import { createHash } from "node:crypto";
import type {
  IntegrationExternalWritebackEnvelope,
  IntegrationExternalWritebackResumeState,
  IntegrationExternalWritebackReplayOutcome,
  IntegrationExternalWritebackReplayPolicy,
} from "@goatcitadel/contracts";
import type { EvidenceEnvelopeService } from "./evidence-envelope-service.js";
import type { MutationIdempotencyStore } from "./mutation-idempotency-store.js";

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
}

export interface IdempotentExternalSideEffectRunInput<TValue> extends ExternalSideEffectClaimInput {
  label: string;
  output?: Record<string, unknown>;
  execute(claim: ExternalSideEffectClaimResult): Promise<TValue>;
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
    return {
      replayPolicy: "idempotent_external",
      replayOutcome: "idempotency_unavailable",
      replayAttempt: "unavailable",
      resumable: false,
      resumeState: "idempotency_unavailable",
      idempotencyKey,
      payloadHash,
      actorScope,
      routePath,
    };
  }

  const claim = input.mutationStore.claim({
    method: "POST",
    routePath,
    idempotencyKey,
    actorScope,
    payloadHash,
    now: input.checkedAt,
  });
  return {
    replayPolicy: "idempotent_external",
    replayOutcome: claim.outcome,
    replayAttempt: claim.outcome === "claimed" ? (claim.claimKind ?? "new") : "blocked",
    resumable: false,
    resumeState: mapExternalSideEffectResumeState(claim.outcome),
    idempotencyKey,
    payloadHash,
    actorScope,
    routePath,
  };
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

  try {
    const value = await input.execute(claim);
    markIdempotentExternalSideEffectCompleted(input.mutationStore, claim, input.checkedAt);
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
