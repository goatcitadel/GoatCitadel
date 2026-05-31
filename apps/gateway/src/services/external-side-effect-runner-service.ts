import { createHash } from "node:crypto";
import type { IntegrationExternalWritebackEnvelope } from "@goatcitadel/contracts";
import type { EvidenceEnvelopeService } from "./evidence-envelope-service.js";

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
  inputKeys?: string[];
  outputKeys?: string[];
  externalReferenceId?: string;
}

export function recordAuditOnlyExternalSideEffectIntent(
  input: ExternalSideEffectIntentInput,
): IntegrationExternalWritebackEnvelope {
  const intentId = buildExternalSideEffectIntentId(input);
  const idempotencyKey = buildExternalSideEffectIdempotencyKey(input);
  const common = {
    intentId,
    idempotencyKey,
    replayPolicy: "audit_only" as const,
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
        replayPolicy: common.replayPolicy,
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
