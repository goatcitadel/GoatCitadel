import { createHash } from "node:crypto";
import {
  GOVERNANCE_JOURNEY_EVENT_VERSION,
  canonicalJsonString,
  type ExternalSourceImportIntent,
  type ExternalSourceImportItem,
  type ExternalSourceImportPlan,
  type ExternalSourceImportSettlement,
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
