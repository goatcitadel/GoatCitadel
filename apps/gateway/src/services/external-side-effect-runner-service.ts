import { createHash } from "node:crypto";
import type {
  IntegrationExternalWritebackEnvelope,
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
  const common = {
    intentId,
    idempotencyKey,
    replayPolicy,
    replayOutcome: input.replayOutcome,
    payloadHash: input.payloadHash,
    resumable: false as const,
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
        resumable: common.resumable,
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
  idempotencyKey: string;
  payloadHash: string;
  actorScope: string;
  routePath: string;
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
    return {
      replayPolicy: "idempotent_external",
      replayOutcome: "idempotency_unavailable",
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
    idempotencyKey,
    payloadHash,
    actorScope,
    routePath,
  };
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
