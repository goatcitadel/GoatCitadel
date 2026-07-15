import { createHash } from "node:crypto";
import {
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION,
  canonicalJsonString,
  type ExternalSessionAttachmentRecord,
  type ExternalSourceCatalogItem,
  type ExternalSourceImportIntent,
  type ExternalSourceImportItem,
  type ExternalSourceImportPlan,
  type ExternalSourceImportSettlement,
  type ExternalSourceRecord,
  type ExternalSourceScanRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import {
  deriveExternalSourceImportIdempotencyKey,
  computeExternalSourceArtifactSetSha256,
  computeExternalSourceNormalizedSetSha256,
  computeExternalSourceRawSetSha256,
  computeExternalSourceSelectedItemSetSha256,
  sealExternalSourceImportIntent,
  sealExternalSourceImportItem,
  sealExternalSourceImportPlan,
  sealExternalSourceImportSettlement,
} from "./external-source-import-repo.js";
import { sealExternalSourceRecord } from "./external-source-config-repo.js";
import { sealExternalSourceCatalogItem, sealExternalSourceScanRecord } from "./external-source-scan-repo.js";
import { buildExternalSourceKnowledgeDocumentBinding } from "./external-session-attachment-repo.js";
import {
  WorkspacePathBridgeSnapshotRepository,
  sealWorkspacePathBridgeSnapshot,
} from "./workspace-path-bridge-snapshot-repo.js";

export const EXTERNAL_SOURCE_TEST_WORKSPACE_ID = "default";
export const EXTERNAL_SOURCE_TEST_TIMESTAMP = "2026-07-14T08:00:00.000Z";

export interface ExternalSourceCatalogFixture {
  config: ExternalSourceRecord;
  scan: ExternalSourceScanRecord;
  items: ExternalSourceCatalogItem[];
}

export interface ExternalSourceImportFixture extends ExternalSourceCatalogFixture {
  plan: ExternalSourceImportPlan;
  intent: ExternalSourceImportIntent;
  importItems: ExternalSourceImportItem[];
  settlement: ExternalSourceImportSettlement;
  attachment: ExternalSessionAttachmentRecord;
}

export function seedExternalSourceCatalog(
  db: DatabaseClient,
  options: { sourceId?: string; scanId?: string; rootSuffix?: string; itemCount?: number } = {},
): ExternalSourceCatalogFixture {
  const sourceId = options.sourceId ?? "source-1";
  const scanId = options.scanId ?? "scan-1";
  const rootSuffix = options.rootSuffix ?? sourceId;
  const canonicalRootPath = `F:\\synthetic\\codex\\${rootSuffix}`;
  const snapshotId = `path-${sourceId}`;
  const allowedRootsSha256 = digest(`allowed-roots:${sourceId}`);
  const snapshot = sealWorkspacePathBridgeSnapshot({
    schemaVersion: WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION,
    snapshotId,
    requestHash: digest(`request:${sourceId}`),
    workspaceId: EXTERNAL_SOURCE_TEST_WORKSPACE_ID,
    inputFlavor: "windows_native",
    targetFlavor: "windows_native",
    gitIdentityRequired: false,
    inputPathHash: digest(canonicalRootPath),
    allowedRootsHash: allowedRootsSha256,
    canonicalHostPath: canonicalRootPath,
    canonicalTargetPath: canonicalRootPath,
    roundTrip: {
      attempted: true,
      converter: "native",
      inputHostPathSha256: digest(`input:${sourceId}`),
      targetPathSha256: digest(`target:${sourceId}`),
      roundTripHostPathSha256: digest(`input:${sourceId}`),
      equal: true,
    },
    gitIdentity: { status: "not_repository" },
    status: "verified",
    callable: true,
    createdAt: EXTERNAL_SOURCE_TEST_TIMESTAMP,
  });
  new WorkspacePathBridgeSnapshotRepository(db).create(snapshot);

  const config = sealExternalSourceRecord({
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    sourceId,
    workspaceId: EXTERNAL_SOURCE_TEST_WORKSPACE_ID,
    kind: "codex_sessions",
    label: `Synthetic ${sourceId}`,
    ownerActorId: "operator-1",
    authActorId: "operator-1",
    authActorSource: "token",
    canonicalRootPath,
    rootIdentitySha256: digest(`root:${sourceId}`),
    pathBridgeSnapshotId: snapshot.snapshotId,
    pathBridgeSnapshotSha256: snapshot.snapshotSha256,
    allowedRootsSha256,
    inputFlavor: "windows_native",
    targetFlavor: "windows_native",
    requireGitIdentity: false,
    rootGrantApprovalId: `root-grant-${sourceId}`,
    ownershipAttestationSha256: digest(`attestation:${sourceId}`),
    adapterId: "codex.rollout-jsonl.v1",
    adapterVersion: "codex-synthetic-v1",
    adapterPolicy: {
      unknownVariantDisposition: "block",
      followLinks: false,
      followMarkdownImports: false,
      retainRawBytes: false,
      acceptedProducerVersions: ["codex-synthetic-v1"],
    },
    revision: 1,
    status: "active",
    createdAt: EXTERNAL_SOURCE_TEST_TIMESTAMP,
    updatedAt: EXTERNAL_SOURCE_TEST_TIMESTAMP,
  });

  const items = Array.from({ length: options.itemCount ?? 3 }, (_, index) =>
    sealExternalSourceCatalogItem({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      workspaceId: EXTERNAL_SOURCE_TEST_WORKSPACE_ID,
      sourceId,
      scanId,
      itemId: `item-${index + 1}`,
      adapterId: config.adapterId,
      adapterVersion: config.adapterVersion,
      normalizedRelativePath: `sessions/2026/07/14/synthetic-${index + 1}.jsonl`,
      aliasRelativePaths: [],
      foreignIdSha256: digest(`foreign:${sourceId}:${index}`),
      producerVersion: "codex-synthetic-v1",
      observedMtimeNs: (1_720_800_000_000_000_000n + BigInt(index)).toString().padStart(20, "0"),
      fileIdentitySha256: digest(`file:${sourceId}:${index}`),
      statFingerprintSha256: digest(`stat:${sourceId}:${index}`),
      rawSha256: digest(`raw:${sourceId}:${index}`),
      rawByteCount: 128 + index,
      messageCount: 2 + index,
      lineageNodeCount: 2 + index,
      lineageDepth: 1,
      lineageSha256: digest(`lineage:${sourceId}:${index}`),
      disposition: "supported",
      reasonCodes: [],
    }),
  );
  const scan = sealExternalSourceScanRecord(
    {
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      scanId,
      workspaceId: EXTERNAL_SOURCE_TEST_WORKSPACE_ID,
      sourceId,
      configRevision: config.revision,
      configSha256: config.configSha256,
      rootIdentitySha256: config.rootIdentitySha256,
      pathBridgeSnapshotSha256: config.pathBridgeSnapshotSha256,
      adapterId: config.adapterId,
      adapterVersion: config.adapterVersion,
      examinedEntryCount: items.length,
      blockerCodes: [],
      status: "sealed",
      startedAt: "2026-07-14T08:01:00.000Z",
      completedAt: "2026-07-14T08:01:01.000Z",
    },
    items,
  );
  return { config, scan, items };
}

export function buildExternalSourceImportFixture(catalog: ExternalSourceCatalogFixture): ExternalSourceImportFixture {
  const selectedItems = catalog.items.slice(0, 2);
  const importId = "import-1";
  const importItems = selectedItems.map((item, ordinal) => {
    const normalizedArtifactSha256 = digest(`normalized:${item.itemId}`);
    return sealExternalSourceImportItem({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      workspaceId: item.workspaceId,
      importId,
      scanId: item.scanId,
      itemId: item.itemId,
      ordinal,
      adapterId: item.adapterId,
      adapterVersion: item.adapterVersion,
      producerVersion: item.producerVersion,
      rawSha256: item.rawSha256,
      rawByteCount: item.rawByteCount,
      normalizedArtifactSha256,
      normalizedByteCount: 64 + ordinal,
      artifactRelativeKey: `external-sources/sha256/${normalizedArtifactSha256}`,
      createdAt: "2026-07-14T08:03:00.000Z",
    });
  });
  const plan = sealExternalSourceImportPlan({
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    planId: "plan-1",
    workspaceId: catalog.config.workspaceId,
    sourceId: catalog.config.sourceId,
    scanId: catalog.scan.scanId,
    configRevision: catalog.config.revision,
    configSha256: catalog.config.configSha256,
    manifestSha256: catalog.scan.manifestSha256,
    adapterVersions: [catalog.config.adapterVersion],
    selectedItemIds: selectedItems.map((item) => item.itemId),
    selectedItemSetSha256: computeExternalSourceSelectedItemSetSha256(selectedItems.map((item) => item.itemId)),
    rawSetSha256: computeExternalSourceRawSetSha256(selectedItems),
    rawByteCount: selectedItems.reduce((total, item) => total + item.rawByteCount, 0),
    normalizedSetSha256: computeExternalSourceNormalizedSetSha256(importItems),
    normalizedByteCount: importItems.reduce((total, item) => total + item.normalizedByteCount, 0),
    messageCount: selectedItems.reduce((total, item) => total + item.messageCount, 0),
    blockerCodes: [],
    stagingLeaseId: "staging-1",
    stagingExpiresAt: "2026-07-14T09:00:00.000Z",
    createdAt: "2026-07-14T08:02:00.000Z",
  });
  const intent = sealExternalSourceImportIntent({
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    importId,
    idempotencyKey: deriveExternalSourceImportIdempotencyKey(plan),
    workspaceId: plan.workspaceId,
    sourceId: plan.sourceId,
    scanId: plan.scanId,
    planId: plan.planId,
    configRevision: plan.configRevision,
    configSha256: plan.configSha256,
    manifestSha256: plan.manifestSha256,
    planSha256: plan.planSha256,
    selectedItemSetSha256: plan.selectedItemSetSha256,
    adapterVersions: plan.adapterVersions,
    requestedByActorId: "operator-1",
    admittedAt: "2026-07-14T08:04:00.000Z",
  });
  const settlement = sealExternalSourceImportSettlement(
    {
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      settlementId: "settlement-1",
      workspaceId: plan.workspaceId,
      importId,
      disposition: "applied",
      artifactSetSha256: computeExternalSourceArtifactSetSha256(importItems),
      artifactsVerifiedAt: "2026-07-14T08:05:00.000Z",
      blockerCodes: [],
      settledAt: "2026-07-14T08:05:01.000Z",
    },
    importItems,
  );
  const attachment: ExternalSessionAttachmentRecord = {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    attachmentId: "external-attachment-1",
    workspaceId: plan.workspaceId,
    sessionId: "session-1",
    sourceId: plan.sourceId,
    importId,
    itemId: importItems[0]!.itemId,
    normalizedArtifactSha256: importItems[0]!.normalizedArtifactSha256,
    mode: "read_only_external",
    status: "attached",
    revision: 1,
    attachedByActorId: "operator-1",
    attachedAt: "2026-07-14T08:06:00.000Z",
  };
  return { ...catalog, plan, intent, importItems, settlement, attachment };
}

export function insertSyntheticChatSession(db: DatabaseClient, sessionId = "session-1"): void {
  db.prepare(
    `
    INSERT INTO chat_session_meta (session_id, workspace_id, created_at, updated_at)
    VALUES (@sessionId, @workspaceId, @createdAt, @updatedAt)
  `,
  ).run({
    sessionId,
    workspaceId: EXTERNAL_SOURCE_TEST_WORKSPACE_ID,
    createdAt: EXTERNAL_SOURCE_TEST_TIMESTAMP,
    updatedAt: EXTERNAL_SOURCE_TEST_TIMESTAMP,
  });
}

export function insertApprovedKnowledgeEffect(
  db: DatabaseClient,
  input: {
    approvalId: string;
    sourceId: string;
    importId: string;
    itemId: string;
    normalizedArtifactSha256: string;
    knowledgeDocumentId: string;
  },
): void {
  const payload = {
    workspaceId: EXTERNAL_SOURCE_TEST_WORKSPACE_ID,
    sourceId: input.sourceId,
    importId: input.importId,
    itemId: input.itemId,
    normalizedArtifactSha256: input.normalizedArtifactSha256,
  };
  const document = buildExternalSourceKnowledgeDocumentBinding({
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    ...payload,
    approvalId: input.approvalId,
  });
  db.prepare(
    `
    INSERT INTO approvals (
      approval_id, kind, risk_level, status, payload_json, preview_json, explanation_status,
      created_at, resolved_at, resolved_by
    ) VALUES (
      @approvalId, 'external_source.knowledge_snapshot', 'high', 'approved', @payloadJson, '{}',
      'not_requested', @createdAt, @resolvedAt, 'operator-1'
    )
  `,
  ).run({
    approvalId: input.approvalId,
    payloadJson: canonicalJsonString(payload),
    createdAt: EXTERNAL_SOURCE_TEST_TIMESTAMP,
    resolvedAt: "2026-07-14T08:07:00.000Z",
  });
  db.prepare(
    `
    INSERT INTO knowledge_documents (doc_id, namespace, source_type, source_ref, title, metadata_json, created_at)
    VALUES (@docId, @namespace, @sourceType, @sourceRef, 'Synthetic snapshot', @metadataJson, @createdAt)
  `,
  ).run({
    docId: input.knowledgeDocumentId,
    namespace: document.namespace,
    sourceType: document.sourceType,
    sourceRef: document.sourceRef,
    metadataJson: document.metadataJson,
    createdAt: "2026-07-14T08:07:01.000Z",
  });
}

export function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
