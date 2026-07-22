import { createHash } from "node:crypto";
import {
  GOVERNANCE_JOURNEY_EVENT_VERSION,
  canonicalJsonString,
  type ExternalSessionAttachmentRecord,
  type ExternalSourceImportIntent,
  type ExternalSourceImportItem,
  type ExternalSourceImportPlan,
  type ExternalSourceImportSettlement,
  type ExternalSourceKnowledgeSnapshotApprovalPayload,
  type GovernanceJourneyEventRecord,
} from "@goatcitadel/contracts";

export function buildExternalSourceDryRunJourneyEvent(input: {
  plan: ExternalSourceImportPlan;
  actorId: string;
}): GovernanceJourneyEventRecord {
  const { plan } = input;
  const action = "dry_run_completed";
  const fingerprint = digest({
    action,
    workspaceId: plan.workspaceId,
    sourceId: plan.sourceId,
    configRevision: plan.configRevision,
    configSha256: plan.configSha256,
    manifestSha256: plan.manifestSha256,
    selectedItemSetSha256: plan.selectedItemSetSha256,
    rawSetSha256: plan.rawSetSha256,
    normalizedSetSha256: plan.normalizedSetSha256,
    adapterVersions: plan.adapterVersions,
    disposition: plan.blockerCodes.length === 0 ? "evidence_only" : "blocked",
  });
  return {
    schemaVersion: GOVERNANCE_JOURNEY_EVENT_VERSION,
    eventId: eventId("dry-run", plan.workspaceId, plan.planId, plan.planSha256),
    idempotencyKey: operationIdempotencyKey("dry-run", plan.workspaceId, plan.planId, fingerprint),
    scopeKind: "workspace",
    workspaceId: plan.workspaceId,
    eventType: "external_session_import",
    subjectKind: "external_source_import_plan",
    subjectId: plan.planId,
    action,
    actorId: input.actorId,
    actorType: "operator",
    fingerprint,
    sourceKind: "external_source",
    sourceId: plan.sourceId,
    trustDisposition: plan.blockerCodes.length === 0 ? "evidence_only" : "blocked",
    poisoningStatus: plan.blockerCodes.length === 0 ? "clean" : "blocked",
    evidenceRefs: [{ owner: "external_source", refId: plan.planId }],
    provenance: {
      sourceRequired: true,
      approvalRequired: false,
      sourceWorkspaceId: plan.workspaceId,
      schemaVersion: plan.schemaVersion,
      scanId: plan.scanId,
      planSha256: plan.planSha256,
    },
    summary: {
      planId: plan.planId,
      sourceId: plan.sourceId,
      scanId: plan.scanId,
      selectedItemCount: plan.selectedItemIds.length,
      rawByteCount: plan.rawByteCount,
      normalizedByteCount: plan.normalizedByteCount,
      messageCount: plan.messageCount,
      selectedItemSetSha256: plan.selectedItemSetSha256,
      rawSetSha256: plan.rawSetSha256,
      normalizedSetSha256: plan.normalizedSetSha256,
      blockerCodes: plan.blockerCodes,
    },
    occurredAt: plan.createdAt,
    recordedAt: plan.createdAt,
  };
}

export function buildExternalSourceSettlementJourneyEvent(input: {
  plan: ExternalSourceImportPlan;
  intent: ExternalSourceImportIntent;
  settlement: ExternalSourceImportSettlement;
  items: readonly ExternalSourceImportItem[];
}): GovernanceJourneyEventRecord {
  const { plan, intent, settlement } = input;
  const action = settlement.disposition === "applied" ? "imported_read_only" : "blocked";
  const fingerprint = digest({
    action,
    workspaceId: intent.workspaceId,
    sourceId: intent.sourceId,
    configRevision: intent.configRevision,
    configSha256: intent.configSha256,
    manifestSha256: intent.manifestSha256,
    selectedItemSetSha256: intent.selectedItemSetSha256,
    rawSetSha256: plan.rawSetSha256,
    normalizedSetSha256: plan.normalizedSetSha256,
    adapterVersions: intent.adapterVersions,
    artifactEvidenceSha256: stableArtifactEvidenceSha256(input.items),
    disposition: settlement.disposition,
    blockerCodes: settlement.blockerCodes,
  });
  return {
    schemaVersion: GOVERNANCE_JOURNEY_EVENT_VERSION,
    eventId: eventId("settlement", intent.workspaceId, intent.importId, settlement.resultSha256),
    idempotencyKey: operationIdempotencyKey("settlement", intent.workspaceId, intent.importId, fingerprint),
    scopeKind: "workspace",
    workspaceId: intent.workspaceId,
    eventType: "external_session_import",
    subjectKind: "external_source_import",
    subjectId: intent.importId,
    action,
    actorId: intent.requestedByActorId,
    actorType: "operator",
    fingerprint,
    sourceKind: "external_source",
    sourceId: intent.sourceId,
    trustDisposition: settlement.disposition === "applied" ? "read_only_external" : "blocked",
    poisoningStatus: settlement.disposition === "applied" ? "clean" : "blocked",
    evidenceRefs: [{ owner: "external_source", refId: intent.importId }],
    provenance: {
      sourceRequired: true,
      approvalRequired: false,
      sourceWorkspaceId: intent.workspaceId,
      schemaVersion: intent.schemaVersion,
      planId: intent.planId,
      planSha256: intent.planSha256,
      requestSha256: intent.requestSha256,
    },
    summary: {
      importId: intent.importId,
      planId: intent.planId,
      sourceId: intent.sourceId,
      scanId: intent.scanId,
      disposition: settlement.disposition,
      itemCount: input.items.length,
      ...(settlement.artifactSetSha256 ? { artifactSetSha256: settlement.artifactSetSha256 } : {}),
      resultSha256: settlement.resultSha256,
      blockerCodes: settlement.blockerCodes,
    },
    occurredAt: settlement.settledAt,
    recordedAt: settlement.settledAt,
  };
}

/**
 * Content-free evidence for one read-only external attachment lifecycle
 * transition. Every field is an identifier, hash, count, or frozen enum; the
 * event never carries normalized artifact bytes or any transcript text. All
 * material derives from the immutable attachment record so exact replays
 * rebuild the identical event and never append recurrence.
 */
export function buildExternalSourceAttachmentJourneyEvent(input: {
  attachment: ExternalSessionAttachmentRecord;
  sessionIncarnationId: string;
}): GovernanceJourneyEventRecord {
  const { attachment } = input;
  const action = attachment.status === "attached" ? "attached_read_only" : "detached";
  const occurredAt = attachment.status === "attached" ? attachment.attachedAt : attachment.detachedAt;
  const actorId =
    attachment.status === "attached" ? attachment.attachedByActorId : (attachment.detachedByActorId ?? "");
  if (!occurredAt || !actorId) {
    throw new Error(`External attachment ${attachment.attachmentId} lacks lifecycle evidence for Journey emission.`);
  }
  const fingerprint = digest({
    action,
    workspaceId: attachment.workspaceId,
    sessionId: attachment.sessionId,
    sessionIncarnationId: input.sessionIncarnationId,
    sourceId: attachment.sourceId,
    importId: attachment.importId,
    itemId: attachment.itemId,
    normalizedArtifactSha256: attachment.normalizedArtifactSha256,
    mode: attachment.mode,
    disposition: "read_only_external",
  });
  return {
    schemaVersion: GOVERNANCE_JOURNEY_EVENT_VERSION,
    eventId: eventId(action, attachment.workspaceId, attachment.attachmentId, fingerprint),
    idempotencyKey: operationIdempotencyKey(action, attachment.workspaceId, attachment.attachmentId, fingerprint),
    scopeKind: "workspace",
    workspaceId: attachment.workspaceId,
    eventType: "external_session_import",
    subjectKind: "external_session_attachment",
    subjectId: attachment.attachmentId,
    action,
    actorId,
    actorType: "operator",
    sessionId: attachment.sessionId,
    fingerprint,
    sourceKind: "external_source",
    sourceId: attachment.sourceId,
    trustDisposition: "read_only_external",
    poisoningStatus: "clean",
    evidenceRefs: [{ owner: "external_source", refId: attachment.attachmentId }],
    provenance: {
      sourceRequired: true,
      approvalRequired: false,
      sourceWorkspaceId: attachment.workspaceId,
      schemaVersion: attachment.schemaVersion,
      sessionIncarnationId: input.sessionIncarnationId,
      importId: attachment.importId,
      itemId: attachment.itemId,
      normalizedArtifactSha256: attachment.normalizedArtifactSha256,
    },
    summary: {
      attachmentId: attachment.attachmentId,
      sessionId: attachment.sessionId,
      sourceId: attachment.sourceId,
      importId: attachment.importId,
      itemId: attachment.itemId,
      normalizedArtifactSha256: attachment.normalizedArtifactSha256,
      mode: attachment.mode,
      status: attachment.status,
      revision: attachment.revision,
    },
    occurredAt,
    recordedAt: occurredAt,
  };
}

export type ExternalSourceKnowledgeSnapshotJourneyAction = "approval_requested" | "snapshot_created" | "attached";

/**
 * Content-free evidence for the governed knowledge-snapshot lifecycle. The
 * request action shares the approval transaction; creation and attach share
 * the recovered approval-effect transaction. Every field derives from the
 * immutable approval payload plus server-derived materialized identities, so
 * exact replays rebuild the identical event and never append recurrence. The
 * `snapshot_created` and `attached` actions require the real approval and are
 * the only external-source events with `approvalRequired: true`.
 */
export function buildExternalSourceKnowledgeSnapshotJourneyEvent(input: {
  action: ExternalSourceKnowledgeSnapshotJourneyAction;
  payload: ExternalSourceKnowledgeSnapshotApprovalPayload;
  approvalId: string;
  actorId: string;
  occurredAt: string;
  materialized?: {
    linkId: string;
    knowledgeDocumentId: string;
    chunkCount: number;
    threadKnowledgeAttachmentId?: string;
  };
}): GovernanceJourneyEventRecord {
  const { action, payload } = input;
  if (action === "approval_requested" && input.materialized) {
    throw new Error("Knowledge-snapshot approval requests carry no materialized identities.");
  }
  if (action !== "approval_requested" && !input.materialized) {
    throw new Error(`Knowledge-snapshot ${action} evidence requires the materialized identities.`);
  }
  if (action === "attached" && !input.materialized?.threadKnowledgeAttachmentId) {
    throw new Error("Knowledge-snapshot attached evidence requires the thread attachment identity.");
  }
  const approvalRequired = action !== "approval_requested";
  const fingerprint = digest({
    action,
    approvalId: input.approvalId,
    workspaceId: payload.workspaceId,
    sourceId: payload.sourceId,
    importId: payload.importId,
    itemId: payload.itemId,
    normalizedArtifactSha256: payload.normalizedArtifactSha256,
    rawSha256: payload.rawSha256,
    sessionId: payload.sessionId,
    sessionIncarnationId: payload.sessionIncarnationId,
    attachmentId: payload.attachmentId,
    attachmentRevision: payload.attachmentRevision,
    ...(input.materialized
      ? {
          linkId: input.materialized.linkId,
          knowledgeDocumentId: input.materialized.knowledgeDocumentId,
          chunkCount: input.materialized.chunkCount,
          ...(input.materialized.threadKnowledgeAttachmentId
            ? { threadKnowledgeAttachmentId: input.materialized.threadKnowledgeAttachmentId }
            : {}),
        }
      : {}),
  });
  const subjectId = input.materialized ? input.materialized.linkId : input.approvalId;
  return {
    schemaVersion: GOVERNANCE_JOURNEY_EVENT_VERSION,
    eventId: eventId(action, payload.workspaceId, subjectId, fingerprint),
    idempotencyKey: `knowledge-snapshot-lifecycle:v1:${action}:${digest({
      workspaceId: payload.workspaceId,
      subjectId,
      fingerprint,
    })}`,
    scopeKind: "workspace",
    workspaceId: payload.workspaceId,
    eventType: "knowledge_snapshot_lifecycle",
    subjectKind: "external_source_knowledge_snapshot",
    subjectId,
    action,
    actorId: input.actorId,
    actorType: "operator",
    sessionId: payload.sessionId,
    approvalId: input.approvalId,
    fingerprint,
    sourceKind: "external_source",
    sourceId: payload.sourceId,
    trustDisposition: approvalRequired ? "approved_snapshot" : "evidence_only",
    poisoningStatus: "clean",
    evidenceRefs: [
      { owner: "approval", refId: input.approvalId },
      { owner: "external_source", refId: payload.importId },
    ],
    provenance: {
      sourceRequired: true,
      approvalRequired,
      sourceWorkspaceId: payload.workspaceId,
      sessionIncarnationId: payload.sessionIncarnationId,
      importId: payload.importId,
      itemId: payload.itemId,
      attachmentId: payload.attachmentId,
      attachmentRevision: payload.attachmentRevision,
      normalizedArtifactSha256: payload.normalizedArtifactSha256,
      rawSha256: payload.rawSha256,
    },
    summary: {
      approvalId: input.approvalId,
      sourceId: payload.sourceId,
      importId: payload.importId,
      itemId: payload.itemId,
      attachmentId: payload.attachmentId,
      normalizedArtifactSha256: payload.normalizedArtifactSha256,
      ...(input.materialized
        ? {
            linkId: input.materialized.linkId,
            knowledgeDocumentId: input.materialized.knowledgeDocumentId,
            chunkCount: input.materialized.chunkCount,
            ...(input.materialized.threadKnowledgeAttachmentId
              ? { threadKnowledgeAttachmentId: input.materialized.threadKnowledgeAttachmentId }
              : {}),
          }
        : {}),
    },
    occurredAt: input.occurredAt,
    recordedAt: input.occurredAt,
  };
}

function eventId(kind: string, workspaceId: string, subjectId: string, materialSha256: string): string {
  return `journey-external-source-${kind}-${digest({ workspaceId, subjectId, materialSha256 })}`;
}

function operationIdempotencyKey(kind: string, workspaceId: string, subjectId: string, fingerprint: string): string {
  return `external-session-import:v1:${kind}:${digest({ workspaceId, subjectId, fingerprint })}`;
}

function stableArtifactEvidenceSha256(items: readonly ExternalSourceImportItem[]): string {
  return digest(
    [...items]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((item) => ({
        itemId: item.itemId,
        ordinal: item.ordinal,
        adapterId: item.adapterId,
        adapterVersion: item.adapterVersion,
        ...(item.producerVersion ? { producerVersion: item.producerVersion } : {}),
        rawSha256: item.rawSha256,
        rawByteCount: item.rawByteCount,
        normalizedArtifactSha256: item.normalizedArtifactSha256,
        normalizedByteCount: item.normalizedByteCount,
        artifactRelativeKey: item.artifactRelativeKey,
      })),
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}
