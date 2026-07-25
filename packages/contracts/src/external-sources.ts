/* eslint-disable max-lines -- External-source protocol contracts remain colocated through the parity schema freeze. */
import { canonicalJsonString } from "./canonical-json.js";
import type { WorkspacePathFlavor } from "./workspace-path-bridge.js";

export const EXTERNAL_SOURCE_SCHEMA_VERSION = "goatcitadel.external-source.v1" as const;
export const EXTERNAL_SOURCE_CURSOR_VERSION = "goatcitadel.external-source-cursor.v1" as const;

/**
 * The dedicated approval kind for copying one imported external item into a
 * GoatCitadel knowledge snapshot. C1 owns only the request contract; the
 * approval-effect execution is a separate governed tranche.
 */
export const EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_KIND = "external_source.knowledge_snapshot" as const;
/** The sole approval-effect kind the knowledge-snapshot approval may enqueue. */
export const EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_KIND = "external_source_knowledge_snapshot_apply" as const;
/** The sole approval-effect target kind for the knowledge-snapshot effect. */
export const EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_TARGET_KIND = "external_source_import_item" as const;
/**
 * Bounded lifetime of one deterministic knowledge-snapshot approval. The apply
 * effect fails closed once this window elapses; a fresh request is required.
 */
export const EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_TTL_MS = 24 * 60 * 60_000;
/**
 * Deterministic chunking bound for approved knowledge-snapshot materialization.
 * Chunk boundaries derive only from the immutable normalized artifact text, so
 * one approved request always yields byte-identical chunk content.
 */
export const EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_CHUNK_MAX_CHARS = 4_000;
/** Session incarnation identifiers follow the chat lifecycle column bound. */
export const EXTERNAL_SOURCE_SESSION_INCARNATION_MAX_LENGTH = 320;

export const EXTERNAL_SOURCE_LIMITS = Object.freeze({
  rootPathBytes: 2_048,
  activeRootsPerWorkspace: 16,
  directoryDepth: 12,
  directoryEntriesPerScan: 10_000,
  catalogItemsPerScan: 5_000,
  scanWallTimeMs: 60_000,
  concurrentFileReads: 4,
  sourceFileBytes: 16 * 1024 * 1024,
  jsonlLineBytes: 1024 * 1024,
  normalizedMessageBytes: 256 * 1024,
  messagesPerSessionItem: 10_000,
  messagesPerImport: 50_000,
  normalizedSessionArtifactBytes: 8 * 1024 * 1024,
  markdownItemBytes: 1024 * 1024,
  selectedItemsPerImport: 100,
  rawBytesPerPlan: 25 * 1024 * 1024,
  normalizedBytesPerImport: 25 * 1024 * 1024,
  stagingLeaseMs: 30 * 60 * 1000,
  lineageNodes: 10_000,
  lineageDepth: 64,
  defaultPageSize: 50,
  maxPageSize: 100,
  encodedCursorBytes: 8_192,
  canonicalJsonBytes: 64 * 1024,
});

export type ExternalSourceKind = "codex_sessions" | "codex_memory" | "claude_sessions" | "claude_memory";
export type ExternalSourceAdapterId =
  | "codex.rollout-jsonl.v1"
  | "codex.memory-markdown.v1"
  | "claude.project-jsonl.v1"
  | "claude.memory-markdown.v1";
export type ExternalSourceStatus = "active" | "disabled" | "revoked";
export type ExternalSourceAuthActorSource = "token" | "basic" | "loopback" | "device_grant" | "none";
export type ExternalSourceCatalogDisposition =
  | "supported"
  | "unsupported_variant"
  | "quarantined"
  | "conflicting"
  | "blocked";
export type ExternalSourceImportDisposition = "applied" | "blocked" | "manual_reconciliation";

export interface ExternalSourceAdapterPolicy {
  unknownVariantDisposition: "block";
  followLinks: false;
  followMarkdownImports: false;
  retainRawBytes: false;
  acceptedProducerVersions: string[];
}

export interface ExternalSourceRecord {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  sourceId: string;
  workspaceId: string;
  kind: ExternalSourceKind;
  label: string;
  ownerActorId: string;
  authActorId: string;
  authActorSource: ExternalSourceAuthActorSource;
  canonicalRootPath: string;
  rootIdentitySha256: string;
  pathBridgeSnapshotId: string;
  pathBridgeSnapshotSha256: string;
  allowedRootsSha256: string;
  inputFlavor: WorkspacePathFlavor;
  targetFlavor: WorkspacePathFlavor;
  distro?: string;
  requireGitIdentity: boolean;
  gitIdentitySha256?: string;
  rootGrantApprovalId?: string;
  ownershipAttestationSha256: string;
  adapterId: ExternalSourceAdapterId;
  adapterVersion: string;
  adapterPolicy: ExternalSourceAdapterPolicy;
  revision: number;
  configSha256: string;
  status: ExternalSourceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalSourceScanHighWater {
  observedMtimeNs: string;
  itemId: string;
}

export interface ExternalSourceScanRecord {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  scanId: string;
  workspaceId: string;
  sourceId: string;
  configRevision: number;
  configSha256: string;
  rootIdentitySha256: string;
  pathBridgeSnapshotSha256: string;
  adapterId: ExternalSourceAdapterId;
  adapterVersion: string;
  manifestSha256: string;
  highWater?: ExternalSourceScanHighWater;
  examinedEntryCount: number;
  itemCount: number;
  supportedItemCount: number;
  quarantinedItemCount: number;
  blockerCodes: string[];
  status: "sealed" | "blocked";
  startedAt: string;
  completedAt: string;
}

export interface ExternalSourceCatalogItem {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  workspaceId: string;
  sourceId: string;
  scanId: string;
  itemId: string;
  adapterId: ExternalSourceAdapterId;
  adapterVersion: string;
  normalizedRelativePath: string;
  aliasRelativePaths: string[];
  foreignIdSha256: string;
  producerVersion?: string;
  observedMtimeNs: string;
  fileIdentitySha256: string;
  statFingerprintSha256: string;
  rawSha256: string;
  rawByteCount: number;
  messageCount: number;
  lineageNodeCount: number;
  lineageDepth: number;
  lineageSha256: string;
  disposition: ExternalSourceCatalogDisposition;
  reasonCodes: string[];
  catalogItemSha256: string;
}

export interface ExternalSourceCursorV1 {
  version: typeof EXTERNAL_SOURCE_CURSOR_VERSION;
  workspaceId: string;
  sourceId: string;
  scanId: string;
  configRevision: number;
  adapterVersion: string;
  filterSha256: string;
  manifestSha256: string;
  highWater: ExternalSourceScanHighWater;
  position: ExternalSourceScanHighWater;
}

export interface ExternalSourcePage {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  workspaceId: string;
  sourceId: string;
  scanId: string;
  items: ExternalSourceCatalogItem[];
  nextCursor?: string;
}

export interface ExternalSourceImportPlan {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  planId: string;
  workspaceId: string;
  sourceId: string;
  scanId: string;
  configRevision: number;
  configSha256: string;
  manifestSha256: string;
  adapterVersions: string[];
  selectedItemIds: string[];
  selectedItemSetSha256: string;
  rawSetSha256: string;
  rawByteCount: number;
  normalizedSetSha256: string;
  normalizedByteCount: number;
  messageCount: number;
  blockerCodes: string[];
  stagingLeaseId: string;
  stagingExpiresAt: string;
  planSha256: string;
  createdAt: string;
}

export interface ExternalSourceImportIntent {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  importId: string;
  idempotencyKey: string;
  workspaceId: string;
  sourceId: string;
  scanId: string;
  planId: string;
  configRevision: number;
  configSha256: string;
  manifestSha256: string;
  planSha256: string;
  selectedItemSetSha256: string;
  adapterVersions: string[];
  requestedByActorId: string;
  requestSha256: string;
  admittedAt: string;
}

export interface ExternalSourceImportItem {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  workspaceId: string;
  importId: string;
  scanId: string;
  itemId: string;
  ordinal: number;
  adapterId: ExternalSourceAdapterId;
  adapterVersion: string;
  producerVersion?: string;
  rawSha256: string;
  rawByteCount: number;
  normalizedArtifactSha256: string;
  normalizedByteCount: number;
  artifactRelativeKey: string;
  provenanceSha256: string;
  createdAt: string;
}

export interface ExternalSourceImportSettlement {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  settlementId: string;
  workspaceId: string;
  importId: string;
  disposition: ExternalSourceImportDisposition;
  artifactSetSha256?: string;
  artifactsVerifiedAt?: string;
  blockerCodes: string[];
  resultSha256: string;
  journeyEventId?: string;
  settledAt: string;
}

export interface ExternalSessionAttachmentRecord {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  attachmentId: string;
  workspaceId: string;
  sessionId: string;
  sourceId: string;
  importId: string;
  itemId: string;
  normalizedArtifactSha256: string;
  mode: "read_only_external";
  status: "attached" | "detached";
  revision: number;
  attachedByActorId: string;
  attachedAt: string;
  detachedByActorId?: string;
  detachedAt?: string;
}

export interface ExternalSourceKnowledgeLinkRecord {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  linkId: string;
  workspaceId: string;
  sourceId: string;
  importId: string;
  itemId: string;
  normalizedArtifactSha256: string;
  approvalId: string;
  knowledgeDocumentId: string;
  threadKnowledgeAttachmentId?: string;
  provenanceSha256: string;
  createdAt: string;
}

/** Authenticated actor identity is deliberately absent and must be supplied by the Gateway request. */
export interface ExternalSourceCreateInput {
  workspaceId: string;
  expectedWorkspaceRevision: number;
  kind: ExternalSourceKind;
  label: string;
  canonicalRootPath: string;
  pathBridgeSnapshotId: string;
  pathBridgeSnapshotSha256: string;
  inputFlavor: WorkspacePathFlavor;
  targetFlavor: WorkspacePathFlavor;
  distro?: string;
  requireGitIdentity: boolean;
  gitIdentitySha256?: string;
  acceptedProducerVersions: string[];
}

/** Source identity and the authenticated actor remain path/request owned. */
export interface ExternalSourceUpdateInput {
  workspaceId: string;
  label?: string;
  status?: ExternalSourceStatus;
  acceptedProducerVersions?: string[];
  expectedRevision: number;
}

export interface ExternalSourceScanInput {
  workspaceId: string;
  expectedRevision: number;
}

export interface ExternalSourceCatalogListInput {
  workspaceId: string;
  scanId: string;
  dispositions?: ExternalSourceCatalogDisposition[];
  cursor?: string;
  limit?: number;
}

/** Exact dry-run selection. Source identity remains server-owned. */
export interface ExternalSourceImportPlanInput {
  workspaceId: string;
  sourceId: string;
  scanId: string;
  selectedItemIds: string[];
  expectedRevision: number;
}

/** Retry-safe apply request over one immutable dry-run plan. */
export interface ExternalSourceImportApplyInput {
  workspaceId: string;
  planId: string;
  expectedPlanSha256: string;
  idempotencyKey: string;
}

/**
 * Attach one applied import item to a chat session read-only. The actor and
 * every hash are server-derived; a request can never smuggle either.
 */
export interface ExternalSessionAttachInput {
  workspaceId: string;
  sessionId: string;
  expectedSessionIncarnationId: string;
  sourceId: string;
  importId: string;
  itemId: string;
}

export interface ExternalSessionAttachmentListInput {
  workspaceId: string;
  sessionId: string;
  limit?: number;
}

/** Exact CAS detach of one read-only external attachment. */
export interface ExternalSessionDetachInput {
  workspaceId: string;
  sessionId: string;
  attachmentId: string;
  expectedRevision: number;
  expectedSessionIncarnationId: string;
}

/**
 * Request material for the dedicated knowledge-snapshot approval. It carries
 * identifiers and the expected attachment revision only; the server derives
 * every artifact hash. Client-supplied hash material fails the exact-key gate.
 */
export interface ExternalSourceKnowledgeSnapshotRequestInput {
  workspaceId: string;
  sessionId: string;
  expectedSessionIncarnationId: string;
  attachmentId: string;
  importId: string;
  itemId: string;
  expectedAttachmentRevision: number;
}

/** Server-derived deterministic approval payload for one knowledge snapshot. */
export interface ExternalSourceKnowledgeSnapshotApprovalPayload {
  workspaceId: string;
  sourceId: string;
  importId: string;
  itemId: string;
  normalizedArtifactSha256: string;
  rawSha256: string;
  sessionId: string;
  sessionIncarnationId: string;
  attachmentId: string;
  attachmentRevision: number;
}

/** Content-free operator preview for the knowledge-snapshot approval inbox. */
export interface ExternalSourceKnowledgeSnapshotApprovalPreview {
  sourceId: string;
  importId: string;
  itemId: string;
  attachmentId: string;
  normalizedArtifactSha256: string;
  normalizedByteCount: number;
}

/**
 * The full deterministic approval-request material. C1 builds and validates it;
 * approval creation and the recovered effect remain a later governed tranche.
 */
export interface ExternalSourceKnowledgeSnapshotRequestMaterial {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  approvalKind: typeof EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_KIND;
  effectKind: typeof EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_KIND;
  effectTargetKind: typeof EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_TARGET_KIND;
  payload: ExternalSourceKnowledgeSnapshotApprovalPayload;
  preview: ExternalSourceKnowledgeSnapshotApprovalPreview;
}

/**
 * Apply request for one approved knowledge-snapshot effect. It carries the
 * approval identity only; every hash, artifact byte, and materialized identity
 * is server-derived from the immutable approval payload and import evidence.
 */
export interface ExternalSourceKnowledgeSnapshotApplyInput {
  workspaceId: string;
  approvalId: string;
  includeThreadAttachment?: boolean;
}

export interface ExternalSessionAttachmentResponse {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  attachment: ExternalSessionAttachmentRecord;
  disposition: "created" | "replayed";
}

/** Durable content-free attachment truth for one workspace-bound session. */
export interface ExternalSessionAttachmentListResponse {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  workspaceId: string;
  sessionId: string;
  /**
   * Current server-owned session incarnation id (C4 composition). Attach,
   * detach, and knowledge requests require the exact expected incarnation, so
   * the durable reload surface is the one sanctioned place clients learn it.
   * Optional because pre-C4 producers and typed fixtures omit it.
   */
  sessionIncarnationId?: string;
  items: ExternalSessionAttachmentRecord[];
}

export interface ExternalSessionDetachResponse {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  attachment: ExternalSessionAttachmentRecord;
  disposition: "detached" | "replayed";
}

export interface ExternalSourceScanSummary {
  scanId: string;
  status: ExternalSourceScanRecord["status"];
  manifestSha256: string;
  itemCount: number;
  supportedItemCount: number;
  quarantinedItemCount: number;
  blockerCodes: string[];
  completedAt: string;
}

/** Content-free projection used by workspace list surfaces. */
export interface ExternalSourceSummary {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  sourceId: string;
  workspaceId: string;
  kind: ExternalSourceKind;
  label: string;
  adapterId: ExternalSourceAdapterId;
  adapterVersion: string;
  revision: number;
  configSha256: string;
  status: ExternalSourceStatus;
  updatedAt: string;
  latestScan?: ExternalSourceScanSummary;
}

export interface ExternalSourceListResponse {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  workspaceId: string;
  items: ExternalSourceSummary[];
}

/** Operator-only detail is the sole projection that may expose the exact registered root. */
export interface ExternalSourceDetailResponse {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  source: ExternalSourceRecord;
  latestScan?: ExternalSourceScanSummary;
}

export interface ExternalSourceImportPlanResponse {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  plan: ExternalSourceImportPlan;
  idempotencyKey: string;
}

export interface ExternalSourceImportDetailResponse {
  schemaVersion: typeof EXTERNAL_SOURCE_SCHEMA_VERSION;
  plan: ExternalSourceImportPlan;
  intent: ExternalSourceImportIntent;
  items: ExternalSourceImportItem[];
  settlement?: ExternalSourceImportSettlement;
}

export interface ExternalSourceImportApplyResponse extends ExternalSourceImportDetailResponse {
  applyDisposition: "created" | "replayed";
}

export function normalizeExternalSourceCreateInput(value: unknown): ExternalSourceCreateInput {
  assertRecord(value, "create input");
  assertExactKeys(
    value,
    [
      "workspaceId",
      "expectedWorkspaceRevision",
      "kind",
      "label",
      "canonicalRootPath",
      "pathBridgeSnapshotId",
      "pathBridgeSnapshotSha256",
      "inputFlavor",
      "targetFlavor",
      "distro",
      "requireGitIdentity",
      "gitIdentitySha256",
      "acceptedProducerVersions",
    ],
    new Set(["distro", "gitIdentitySha256"]),
  );
  const workspaceId = normalizeInputText(value.workspaceId, "workspaceId", 256);
  const label = normalizeInputText(value.label, "label", 256);
  const canonicalRootPath = normalizeInputText(
    value.canonicalRootPath,
    "canonicalRootPath",
    EXTERNAL_SOURCE_LIMITS.rootPathBytes,
    true,
  );
  assertRootPath(canonicalRootPath);
  const pathBridgeSnapshotId = normalizeInputText(value.pathBridgeSnapshotId, "pathBridgeSnapshotId", 256);
  const pathBridgeSnapshotSha256 = normalizeSha256(value.pathBridgeSnapshotSha256);
  if (!SOURCE_KINDS.has(value.kind as ExternalSourceKind)) throw new Error("External source kind is invalid.");
  if (
    !PATH_FLAVORS.has(value.inputFlavor as WorkspacePathFlavor) ||
    !PATH_FLAVORS.has(value.targetFlavor as WorkspacePathFlavor)
  ) {
    throw new Error("External source flavor is invalid.");
  }
  if (typeof value.requireGitIdentity !== "boolean")
    throw new Error("External source Git identity posture is invalid.");
  const distro = value.distro === undefined ? undefined : normalizeInputText(value.distro, "distro", 64);
  if ((value.inputFlavor === "wsl" || value.targetFlavor === "wsl") !== (distro !== undefined)) {
    throw new Error("External source distro binding is invalid.");
  }
  const gitIdentitySha256 =
    value.gitIdentitySha256 === undefined ? undefined : normalizeSha256(value.gitIdentitySha256);
  if (value.requireGitIdentity !== (gitIdentitySha256 !== undefined)) {
    throw new Error("External source Git identity posture is invalid.");
  }
  const acceptedProducerVersions = normalizeStringList(
    value.acceptedProducerVersions,
    "acceptedProducerVersions",
    64,
    128,
  );
  return {
    workspaceId,
    expectedWorkspaceRevision: normalizePositiveInteger(value.expectedWorkspaceRevision, "expectedWorkspaceRevision"),
    kind: value.kind as ExternalSourceKind,
    label,
    canonicalRootPath,
    pathBridgeSnapshotId,
    pathBridgeSnapshotSha256,
    inputFlavor: value.inputFlavor as WorkspacePathFlavor,
    targetFlavor: value.targetFlavor as WorkspacePathFlavor,
    ...(distro ? { distro } : {}),
    requireGitIdentity: value.requireGitIdentity,
    ...(gitIdentitySha256 ? { gitIdentitySha256 } : {}),
    acceptedProducerVersions,
  };
}

export function normalizeExternalSourceUpdateInput(value: unknown): ExternalSourceUpdateInput {
  assertRecord(value, "update input");
  assertExactKeys(
    value,
    ["workspaceId", "label", "status", "acceptedProducerVersions", "expectedRevision"],
    new Set(["label", "status", "acceptedProducerVersions"]),
  );
  if (!["label", "status", "acceptedProducerVersions"].some((key) => Object.hasOwn(value, key))) {
    throw new Error("External source update must contain a mutable field.");
  }
  const status = value.status as ExternalSourceStatus | undefined;
  if (status !== undefined && !SOURCE_STATUSES.has(status)) throw new Error("External source status is invalid.");
  return {
    workspaceId: normalizeInputText(value.workspaceId, "workspaceId", 256),
    ...(value.label === undefined ? {} : { label: normalizeInputText(value.label, "label", 256) }),
    ...(status === undefined ? {} : { status }),
    ...(value.acceptedProducerVersions === undefined
      ? {}
      : {
          acceptedProducerVersions: normalizeStringList(
            value.acceptedProducerVersions,
            "acceptedProducerVersions",
            64,
            128,
          ),
        }),
    expectedRevision: normalizePositiveInteger(value.expectedRevision, "expectedRevision"),
  };
}

export function normalizeExternalSourceScanInput(value: unknown): ExternalSourceScanInput {
  assertRecord(value, "scan input");
  assertExactKeys(value, ["workspaceId", "expectedRevision"], new Set());
  return {
    workspaceId: normalizeInputText(value.workspaceId, "workspaceId", 256),
    expectedRevision: normalizePositiveInteger(value.expectedRevision, "expectedRevision"),
  };
}

export function normalizeExternalSourceCatalogListInput(value: unknown): ExternalSourceCatalogListInput {
  assertRecord(value, "catalog list input");
  assertExactKeys(
    value,
    ["workspaceId", "scanId", "dispositions", "cursor", "limit"],
    new Set(["dispositions", "cursor", "limit"]),
  );
  const dispositions = value.dispositions === undefined ? undefined : normalizeDispositions(value.dispositions);
  const cursor =
    value.cursor === undefined
      ? undefined
      : normalizeInputText(value.cursor, "cursor", EXTERNAL_SOURCE_LIMITS.encodedCursorBytes, true);
  const limit =
    value.limit === undefined
      ? undefined
      : normalizeIntegerRange(value.limit, "limit", 1, EXTERNAL_SOURCE_LIMITS.maxPageSize);
  return {
    workspaceId: normalizeInputText(value.workspaceId, "workspaceId", 256),
    scanId: normalizeInputText(value.scanId, "scanId", 256),
    ...(dispositions ? { dispositions } : {}),
    ...(cursor ? { cursor } : {}),
    ...(limit ? { limit } : {}),
  };
}

export function normalizeExternalSourceImportPlanInput(value: unknown): ExternalSourceImportPlanInput {
  assertRecord(value, "import plan input");
  assertExactKeys(value, ["workspaceId", "sourceId", "scanId", "selectedItemIds", "expectedRevision"], new Set());
  if (!Array.isArray(value.selectedItemIds)) throw new Error("External source import selection is invalid.");
  const selectedItemIds = value.selectedItemIds.map((itemId) => normalizeInputText(itemId, "selectedItemId", 256));
  if (
    selectedItemIds.length < 1 ||
    selectedItemIds.length > EXTERNAL_SOURCE_LIMITS.selectedItemsPerImport ||
    new Set(selectedItemIds).size !== selectedItemIds.length
  ) {
    throw new Error("External source import selection is invalid.");
  }
  return {
    workspaceId: normalizeInputText(value.workspaceId, "workspaceId", 256),
    sourceId: normalizeInputText(value.sourceId, "sourceId", 256),
    scanId: normalizeInputText(value.scanId, "scanId", 256),
    selectedItemIds,
    expectedRevision: normalizePositiveInteger(value.expectedRevision, "expectedRevision"),
  };
}

export function normalizeExternalSourceImportApplyInput(value: unknown): ExternalSourceImportApplyInput {
  assertRecord(value, "import apply input");
  assertExactKeys(value, ["workspaceId", "planId", "expectedPlanSha256", "idempotencyKey"], new Set());
  return {
    workspaceId: normalizeInputText(value.workspaceId, "workspaceId", 256),
    planId: normalizeInputText(value.planId, "planId", 256),
    expectedPlanSha256: normalizeSha256(value.expectedPlanSha256),
    idempotencyKey: normalizeInputText(value.idempotencyKey, "idempotencyKey", 512),
  };
}

export function normalizeExternalSessionAttachInput(value: unknown): ExternalSessionAttachInput {
  assertRecord(value, "attach input");
  assertExactKeys(
    value,
    ["workspaceId", "sessionId", "expectedSessionIncarnationId", "sourceId", "importId", "itemId"],
    new Set(),
  );
  return {
    workspaceId: normalizeInputText(value.workspaceId, "workspaceId", 256),
    sessionId: normalizeInputText(value.sessionId, "sessionId", 256),
    expectedSessionIncarnationId: normalizeInputText(
      value.expectedSessionIncarnationId,
      "expectedSessionIncarnationId",
      EXTERNAL_SOURCE_SESSION_INCARNATION_MAX_LENGTH,
    ),
    sourceId: normalizeInputText(value.sourceId, "sourceId", 256),
    importId: normalizeInputText(value.importId, "importId", 256),
    itemId: normalizeInputText(value.itemId, "itemId", 256),
  };
}

export function normalizeExternalSessionAttachmentListInput(value: unknown): ExternalSessionAttachmentListInput {
  assertRecord(value, "attachment list input");
  assertExactKeys(value, ["workspaceId", "sessionId", "limit"], new Set(["limit"]));
  const limit =
    value.limit === undefined
      ? undefined
      : normalizeIntegerRange(value.limit, "limit", 1, EXTERNAL_SOURCE_LIMITS.maxPageSize);
  return {
    workspaceId: normalizeInputText(value.workspaceId, "workspaceId", 256),
    sessionId: normalizeInputText(value.sessionId, "sessionId", 256),
    ...(limit ? { limit } : {}),
  };
}

export function normalizeExternalSessionDetachInput(value: unknown): ExternalSessionDetachInput {
  assertRecord(value, "detach input");
  assertExactKeys(
    value,
    ["workspaceId", "sessionId", "attachmentId", "expectedRevision", "expectedSessionIncarnationId"],
    new Set(),
  );
  return {
    workspaceId: normalizeInputText(value.workspaceId, "workspaceId", 256),
    sessionId: normalizeInputText(value.sessionId, "sessionId", 256),
    attachmentId: normalizeInputText(value.attachmentId, "attachmentId", 256),
    expectedRevision: normalizePositiveInteger(value.expectedRevision, "expectedRevision"),
    expectedSessionIncarnationId: normalizeInputText(
      value.expectedSessionIncarnationId,
      "expectedSessionIncarnationId",
      EXTERNAL_SOURCE_SESSION_INCARNATION_MAX_LENGTH,
    ),
  };
}

export function normalizeExternalSourceKnowledgeSnapshotRequestInput(
  value: unknown,
): ExternalSourceKnowledgeSnapshotRequestInput {
  assertRecord(value, "knowledge snapshot request input");
  assertExactKeys(
    value,
    [
      "workspaceId",
      "sessionId",
      "expectedSessionIncarnationId",
      "attachmentId",
      "importId",
      "itemId",
      "expectedAttachmentRevision",
    ],
    new Set(),
  );
  return {
    workspaceId: normalizeInputText(value.workspaceId, "workspaceId", 256),
    sessionId: normalizeInputText(value.sessionId, "sessionId", 256),
    expectedSessionIncarnationId: normalizeInputText(
      value.expectedSessionIncarnationId,
      "expectedSessionIncarnationId",
      EXTERNAL_SOURCE_SESSION_INCARNATION_MAX_LENGTH,
    ),
    attachmentId: normalizeInputText(value.attachmentId, "attachmentId", 256),
    importId: normalizeInputText(value.importId, "importId", 256),
    itemId: normalizeInputText(value.itemId, "itemId", 256),
    expectedAttachmentRevision: normalizePositiveInteger(
      value.expectedAttachmentRevision,
      "expectedAttachmentRevision",
    ),
  };
}

export function normalizeExternalSourceKnowledgeSnapshotApplyInput(
  value: unknown,
): ExternalSourceKnowledgeSnapshotApplyInput {
  assertRecord(value, "knowledge snapshot apply input");
  assertExactKeys(
    value,
    ["workspaceId", "approvalId", "includeThreadAttachment"],
    new Set(["includeThreadAttachment"]),
  );
  if (value.includeThreadAttachment !== undefined && typeof value.includeThreadAttachment !== "boolean")
    throw new Error("External source record contains unsupported or missing fields.");
  return {
    workspaceId: normalizeInputText(value.workspaceId, "workspaceId", 256),
    approvalId: normalizeInputText(value.approvalId, "approvalId", 256),
    ...(value.includeThreadAttachment === undefined ? {} : { includeThreadAttachment: value.includeThreadAttachment }),
  };
}

export function assertExternalSourceKnowledgeSnapshotApprovalPayload(
  value: ExternalSourceKnowledgeSnapshotApprovalPayload,
): void {
  assertRecord(value, "knowledge snapshot payload");
  assertExactKeys(
    value,
    [
      "workspaceId",
      "sourceId",
      "importId",
      "itemId",
      "normalizedArtifactSha256",
      "rawSha256",
      "sessionId",
      "sessionIncarnationId",
      "attachmentId",
      "attachmentRevision",
    ],
    new Set(),
  );
  for (const [name, input, max] of [
    ["workspaceId", value.workspaceId, 256],
    ["sourceId", value.sourceId, 256],
    ["importId", value.importId, 256],
    ["itemId", value.itemId, 256],
    ["sessionId", value.sessionId, 256],
    ["sessionIncarnationId", value.sessionIncarnationId, EXTERNAL_SOURCE_SESSION_INCARNATION_MAX_LENGTH],
    ["attachmentId", value.attachmentId, 256],
  ] as const)
    assertText(input, name, max);
  assertSha256(value.normalizedArtifactSha256);
  assertSha256(value.rawSha256);
  assertPositiveInteger(value.attachmentRevision, "attachmentRevision");
  assertCanonicalJsonBytes(value, 16 * 1024);
}

export function projectExternalSourceSummary(
  source: ExternalSourceRecord,
  latestScan?: ExternalSourceScanRecord,
): ExternalSourceSummary {
  assertExternalSourceRecord(source);
  if (latestScan) {
    assertExternalSourceScanRecord(latestScan);
    if (latestScan.workspaceId !== source.workspaceId || latestScan.sourceId !== source.sourceId) {
      throw new Error("External source summary scan binding is invalid.");
    }
  }
  const summary: ExternalSourceSummary = {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    sourceId: source.sourceId,
    workspaceId: source.workspaceId,
    kind: source.kind,
    label: source.label,
    adapterId: source.adapterId,
    adapterVersion: source.adapterVersion,
    revision: source.revision,
    configSha256: source.configSha256,
    status: source.status,
    updatedAt: source.updatedAt,
    ...(latestScan ? { latestScan: projectScanSummary(latestScan) } : {}),
  };
  assertExternalSourceSummary(summary);
  return summary;
}

export function assertExternalSourceSummary(value: ExternalSourceSummary): void {
  assertRecord(value, "summary");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "sourceId",
      "workspaceId",
      "kind",
      "label",
      "adapterId",
      "adapterVersion",
      "revision",
      "configSha256",
      "status",
      "updatedAt",
      "latestScan",
    ],
    new Set(["latestScan"]),
  );
  assertVersion(value.schemaVersion);
  assertText(value.sourceId, "sourceId", 256);
  assertText(value.workspaceId, "workspaceId", 256);
  assertText(value.label, "label", 256);
  if (!SOURCE_KINDS.has(value.kind) || !SOURCE_STATUSES.has(value.status) || !ADAPTER_IDS.has(value.adapterId)) {
    throw new Error("External source summary enum is invalid.");
  }
  assertAdapterKind(value.kind, value.adapterId);
  assertText(value.adapterVersion, "adapterVersion", 128);
  assertPositiveInteger(value.revision, "revision");
  assertSha256(value.configSha256);
  assertIso(value.updatedAt);
  if (value.latestScan) assertExternalSourceScanSummary(value.latestScan);
  assertCanonicalJsonBytes(value, EXTERNAL_SOURCE_LIMITS.canonicalJsonBytes);
}

export function assertExternalSourceScanSummary(value: ExternalSourceScanSummary): void {
  assertRecord(value, "scan summary");
  assertExactKeys(
    value,
    [
      "scanId",
      "status",
      "manifestSha256",
      "itemCount",
      "supportedItemCount",
      "quarantinedItemCount",
      "blockerCodes",
      "completedAt",
    ],
    new Set(),
  );
  assertText(value.scanId, "scanId", 256);
  if (value.status !== "sealed" && value.status !== "blocked")
    throw new Error("External source scan status is invalid.");
  assertSha256(value.manifestSha256);
  assertBoundedCount(value.itemCount, "itemCount", EXTERNAL_SOURCE_LIMITS.catalogItemsPerScan);
  assertBoundedCount(value.supportedItemCount, "supportedItemCount", EXTERNAL_SOURCE_LIMITS.catalogItemsPerScan);
  assertBoundedCount(value.quarantinedItemCount, "quarantinedItemCount", EXTERNAL_SOURCE_LIMITS.catalogItemsPerScan);
  assertCodes(value.blockerCodes);
  assertIso(value.completedAt);
}

function projectScanSummary(scan: ExternalSourceScanRecord): ExternalSourceScanSummary {
  return {
    scanId: scan.scanId,
    status: scan.status,
    manifestSha256: scan.manifestSha256,
    itemCount: scan.itemCount,
    supportedItemCount: scan.supportedItemCount,
    quarantinedItemCount: scan.quarantinedItemCount,
    blockerCodes: [...scan.blockerCodes],
    completedAt: scan.completedAt,
  };
}

export function assertExternalSourceRecord(value: ExternalSourceRecord): void {
  assertRecord(value, "source config");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "sourceId",
      "workspaceId",
      "kind",
      "label",
      "ownerActorId",
      "authActorId",
      "authActorSource",
      "canonicalRootPath",
      "rootIdentitySha256",
      "pathBridgeSnapshotId",
      "pathBridgeSnapshotSha256",
      "allowedRootsSha256",
      "inputFlavor",
      "targetFlavor",
      "distro",
      "requireGitIdentity",
      "gitIdentitySha256",
      "rootGrantApprovalId",
      "ownershipAttestationSha256",
      "adapterId",
      "adapterVersion",
      "adapterPolicy",
      "revision",
      "configSha256",
      "status",
      "createdAt",
      "updatedAt",
    ],
    new Set(["distro", "gitIdentitySha256", "rootGrantApprovalId"]),
  );
  assertVersion(value.schemaVersion);
  for (const [name, input, max] of [
    ["sourceId", value.sourceId, 256],
    ["workspaceId", value.workspaceId, 256],
    ["label", value.label, 256],
    ["ownerActorId", value.ownerActorId, 256],
    ["authActorId", value.authActorId, 256],
    ["pathBridgeSnapshotId", value.pathBridgeSnapshotId, 256],
    ["adapterVersion", value.adapterVersion, 128],
  ] as const)
    assertText(input, name, max);
  assertRootPath(value.canonicalRootPath);
  for (const hash of [
    value.rootIdentitySha256,
    value.pathBridgeSnapshotSha256,
    value.allowedRootsSha256,
    value.ownershipAttestationSha256,
    value.configSha256,
  ])
    assertSha256(hash);
  assertOptionalSha256(value.gitIdentitySha256);
  if (!SOURCE_KINDS.has(value.kind) || !SOURCE_STATUSES.has(value.status) || !AUTH_SOURCES.has(value.authActorSource)) {
    throw new Error("External source config enum is invalid.");
  }
  assertAdapterKind(value.kind, value.adapterId);
  if (!PATH_FLAVORS.has(value.inputFlavor) || !PATH_FLAVORS.has(value.targetFlavor))
    throw new Error("External source flavor is invalid.");
  if ((value.inputFlavor === "wsl" || value.targetFlavor === "wsl") !== (value.distro !== undefined)) {
    throw new Error("External source distro binding is invalid.");
  }
  if (value.distro !== undefined) assertText(value.distro, "distro", 64);
  if (
    typeof value.requireGitIdentity !== "boolean" ||
    value.requireGitIdentity !== (value.gitIdentitySha256 !== undefined)
  ) {
    throw new Error("External source Git identity posture is invalid.");
  }
  if (value.rootGrantApprovalId !== undefined) assertText(value.rootGrantApprovalId, "rootGrantApprovalId", 256);
  assertAdapterPolicy(value.adapterPolicy);
  assertPositiveInteger(value.revision, "revision");
  assertIso(value.createdAt);
  assertIso(value.updatedAt);
  assertCanonicalJsonBytes(value, EXTERNAL_SOURCE_LIMITS.canonicalJsonBytes);
}

export function assertExternalSourceScanRecord(value: ExternalSourceScanRecord): void {
  assertRecord(value, "scan");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "scanId",
      "workspaceId",
      "sourceId",
      "configRevision",
      "configSha256",
      "rootIdentitySha256",
      "pathBridgeSnapshotSha256",
      "adapterId",
      "adapterVersion",
      "manifestSha256",
      "highWater",
      "examinedEntryCount",
      "itemCount",
      "supportedItemCount",
      "quarantinedItemCount",
      "blockerCodes",
      "status",
      "startedAt",
      "completedAt",
    ],
    new Set(["highWater"]),
  );
  assertVersion(value.schemaVersion);
  for (const [name, input] of [
    ["scanId", value.scanId],
    ["workspaceId", value.workspaceId],
    ["sourceId", value.sourceId],
  ] as const)
    assertText(input, name, 256);
  assertPositiveInteger(value.configRevision, "configRevision");
  for (const hash of [
    value.configSha256,
    value.rootIdentitySha256,
    value.pathBridgeSnapshotSha256,
    value.manifestSha256,
  ])
    assertSha256(hash);
  if (!ADAPTER_IDS.has(value.adapterId)) throw new Error("External source scan adapter is invalid.");
  assertText(value.adapterVersion, "adapterVersion", 128);
  for (const [name, input, max] of [
    ["examinedEntryCount", value.examinedEntryCount, EXTERNAL_SOURCE_LIMITS.directoryEntriesPerScan],
    ["itemCount", value.itemCount, EXTERNAL_SOURCE_LIMITS.catalogItemsPerScan],
    ["supportedItemCount", value.supportedItemCount, EXTERNAL_SOURCE_LIMITS.catalogItemsPerScan],
    ["quarantinedItemCount", value.quarantinedItemCount, EXTERNAL_SOURCE_LIMITS.catalogItemsPerScan],
  ] as const)
    assertBoundedCount(input, name, max);
  if (value.supportedItemCount + value.quarantinedItemCount > value.itemCount)
    throw new Error("External source scan counts are inconsistent.");
  assertCodes(value.blockerCodes);
  if (value.status !== "sealed" && value.status !== "blocked")
    throw new Error("External source scan status is invalid.");
  if ((value.status === "blocked") !== value.blockerCodes.length > 0)
    throw new Error("External source scan terminal status is inconsistent with its blockers.");
  if (value.itemCount > 0 !== (value.highWater !== undefined))
    throw new Error("External source scan high-water is inconsistent.");
  if (value.examinedEntryCount < value.itemCount)
    throw new Error("External source scan examined-entry count is inconsistent.");
  if (value.highWater) assertHighWater(value.highWater);
  assertIso(value.startedAt);
  assertIso(value.completedAt);
  const elapsedMs = Date.parse(value.completedAt) - Date.parse(value.startedAt);
  if (elapsedMs < 0 || elapsedMs > EXTERNAL_SOURCE_LIMITS.scanWallTimeMs)
    throw new Error("External source scan exceeded its frozen wall-time limit.");
  assertCanonicalJsonBytes(value, EXTERNAL_SOURCE_LIMITS.canonicalJsonBytes);
}

export function assertExternalSourceCatalogItem(value: ExternalSourceCatalogItem): void {
  assertRecord(value, "catalog item");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "workspaceId",
      "sourceId",
      "scanId",
      "itemId",
      "adapterId",
      "adapterVersion",
      "normalizedRelativePath",
      "aliasRelativePaths",
      "foreignIdSha256",
      "producerVersion",
      "observedMtimeNs",
      "fileIdentitySha256",
      "statFingerprintSha256",
      "rawSha256",
      "rawByteCount",
      "messageCount",
      "lineageNodeCount",
      "lineageDepth",
      "lineageSha256",
      "disposition",
      "reasonCodes",
      "catalogItemSha256",
    ],
    new Set(["producerVersion"]),
  );
  assertVersion(value.schemaVersion);
  for (const [name, input] of [
    ["workspaceId", value.workspaceId],
    ["sourceId", value.sourceId],
    ["scanId", value.scanId],
    ["itemId", value.itemId],
  ] as const)
    assertText(input, name, 256);
  if (!ADAPTER_IDS.has(value.adapterId) || !CATALOG_DISPOSITIONS.has(value.disposition))
    throw new Error("External source catalog enum is invalid.");
  assertText(value.adapterVersion, "adapterVersion", 128);
  assertRelativePath(value.normalizedRelativePath);
  assertRelativePaths(value.aliasRelativePaths);
  if (value.producerVersion !== undefined) assertText(value.producerVersion, "producerVersion", 128);
  for (const hash of [
    value.foreignIdSha256,
    value.fileIdentitySha256,
    value.statFingerprintSha256,
    value.rawSha256,
    value.lineageSha256,
    value.catalogItemSha256,
  ])
    assertSha256(hash);
  assertMtimeNs(value.observedMtimeNs);
  assertBoundedCount(value.rawByteCount, "rawByteCount", EXTERNAL_SOURCE_LIMITS.sourceFileBytes);
  assertBoundedCount(value.messageCount, "messageCount", EXTERNAL_SOURCE_LIMITS.messagesPerSessionItem);
  assertBoundedCount(value.lineageNodeCount, "lineageNodeCount", EXTERNAL_SOURCE_LIMITS.lineageNodes);
  assertBoundedCount(value.lineageDepth, "lineageDepth", EXTERNAL_SOURCE_LIMITS.lineageDepth);
  assertCodes(value.reasonCodes);
  if (value.disposition === "supported" && value.reasonCodes.length > 0)
    throw new Error("Supported external source item cannot contain blockers.");
  assertCanonicalJsonBytes(value, EXTERNAL_SOURCE_LIMITS.canonicalJsonBytes);
}

export function assertExternalSourceImportPlan(value: ExternalSourceImportPlan): void {
  assertRecord(value, "import plan");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "planId",
      "workspaceId",
      "sourceId",
      "scanId",
      "configRevision",
      "configSha256",
      "manifestSha256",
      "adapterVersions",
      "selectedItemIds",
      "selectedItemSetSha256",
      "rawSetSha256",
      "rawByteCount",
      "normalizedSetSha256",
      "normalizedByteCount",
      "messageCount",
      "blockerCodes",
      "stagingLeaseId",
      "stagingExpiresAt",
      "planSha256",
      "createdAt",
    ],
    new Set(),
  );
  assertVersion(value.schemaVersion);
  for (const [name, input] of [
    ["planId", value.planId],
    ["workspaceId", value.workspaceId],
    ["sourceId", value.sourceId],
    ["scanId", value.scanId],
    ["stagingLeaseId", value.stagingLeaseId],
  ] as const)
    assertText(input, name, 256);
  assertPositiveInteger(value.configRevision, "configRevision");
  for (const hash of [
    value.configSha256,
    value.manifestSha256,
    value.selectedItemSetSha256,
    value.rawSetSha256,
    value.normalizedSetSha256,
    value.planSha256,
  ])
    assertSha256(hash);
  assertStringList(value.adapterVersions, "adapterVersions", 16, 128, true);
  assertStringList(value.selectedItemIds, "selectedItemIds", EXTERNAL_SOURCE_LIMITS.selectedItemsPerImport, 256, false);
  if (value.selectedItemIds.length < 1) throw new Error("External source plan selection is empty.");
  assertBoundedCount(value.rawByteCount, "rawByteCount", EXTERNAL_SOURCE_LIMITS.rawBytesPerPlan);
  assertBoundedCount(value.normalizedByteCount, "normalizedByteCount", EXTERNAL_SOURCE_LIMITS.normalizedBytesPerImport);
  assertBoundedCount(value.messageCount, "messageCount", EXTERNAL_SOURCE_LIMITS.messagesPerImport);
  assertCodes(value.blockerCodes);
  assertIso(value.stagingExpiresAt);
  assertIso(value.createdAt);
  assertCanonicalJsonBytes(value, EXTERNAL_SOURCE_LIMITS.canonicalJsonBytes);
}

export function assertExternalSourceImportIntent(value: ExternalSourceImportIntent): void {
  assertRecord(value, "import intent");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "importId",
      "idempotencyKey",
      "workspaceId",
      "sourceId",
      "scanId",
      "planId",
      "configRevision",
      "configSha256",
      "manifestSha256",
      "planSha256",
      "selectedItemSetSha256",
      "adapterVersions",
      "requestedByActorId",
      "requestSha256",
      "admittedAt",
    ],
    new Set(),
  );
  assertVersion(value.schemaVersion);
  for (const [name, input, max] of [
    ["importId", value.importId, 256],
    ["idempotencyKey", value.idempotencyKey, 512],
    ["workspaceId", value.workspaceId, 256],
    ["sourceId", value.sourceId, 256],
    ["scanId", value.scanId, 256],
    ["planId", value.planId, 256],
    ["requestedByActorId", value.requestedByActorId, 256],
  ] as const)
    assertText(input, name, max);
  assertPositiveInteger(value.configRevision, "configRevision");
  for (const hash of [
    value.configSha256,
    value.manifestSha256,
    value.planSha256,
    value.selectedItemSetSha256,
    value.requestSha256,
  ])
    assertSha256(hash);
  assertStringList(value.adapterVersions, "adapterVersions", 16, 128, true);
  assertIso(value.admittedAt);
  assertCanonicalJsonBytes(value, EXTERNAL_SOURCE_LIMITS.canonicalJsonBytes);
}

export function assertExternalSourceImportItem(value: ExternalSourceImportItem): void {
  assertRecord(value, "import item");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "workspaceId",
      "importId",
      "scanId",
      "itemId",
      "ordinal",
      "adapterId",
      "adapterVersion",
      "producerVersion",
      "rawSha256",
      "rawByteCount",
      "normalizedArtifactSha256",
      "normalizedByteCount",
      "artifactRelativeKey",
      "provenanceSha256",
      "createdAt",
    ],
    new Set(["producerVersion"]),
  );
  assertVersion(value.schemaVersion);
  for (const [name, input] of [
    ["workspaceId", value.workspaceId],
    ["importId", value.importId],
    ["scanId", value.scanId],
    ["itemId", value.itemId],
  ] as const)
    assertText(input, name, 256);
  assertBoundedCount(value.ordinal, "ordinal", EXTERNAL_SOURCE_LIMITS.selectedItemsPerImport - 1);
  if (!ADAPTER_IDS.has(value.adapterId)) throw new Error("External source import item adapter is invalid.");
  assertText(value.adapterVersion, "adapterVersion", 128);
  if (value.producerVersion !== undefined) assertText(value.producerVersion, "producerVersion", 128);
  assertSha256(value.rawSha256);
  assertSha256(value.normalizedArtifactSha256);
  assertSha256(value.provenanceSha256);
  assertBoundedCount(value.rawByteCount, "rawByteCount", EXTERNAL_SOURCE_LIMITS.sourceFileBytes);
  assertBoundedCount(
    value.normalizedByteCount,
    "normalizedByteCount",
    EXTERNAL_SOURCE_LIMITS.normalizedSessionArtifactBytes,
  );
  assertManagedRelativeKey(value.artifactRelativeKey);
  assertIso(value.createdAt);
  assertCanonicalJsonBytes(value, EXTERNAL_SOURCE_LIMITS.canonicalJsonBytes);
}

export function assertExternalSourceImportSettlement(value: ExternalSourceImportSettlement): void {
  assertRecord(value, "import settlement");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "settlementId",
      "workspaceId",
      "importId",
      "disposition",
      "artifactSetSha256",
      "artifactsVerifiedAt",
      "blockerCodes",
      "resultSha256",
      "journeyEventId",
      "settledAt",
    ],
    new Set(["artifactSetSha256", "artifactsVerifiedAt", "journeyEventId"]),
  );
  assertVersion(value.schemaVersion);
  for (const [name, input] of [
    ["settlementId", value.settlementId],
    ["workspaceId", value.workspaceId],
    ["importId", value.importId],
  ] as const)
    assertText(input, name, 256);
  if (!IMPORT_DISPOSITIONS.has(value.disposition))
    throw new Error("External source settlement disposition is invalid.");
  assertOptionalSha256(value.artifactSetSha256);
  assertSha256(value.resultSha256);
  assertCodes(value.blockerCodes);
  if (value.artifactsVerifiedAt !== undefined) assertIso(value.artifactsVerifiedAt);
  if (value.journeyEventId !== undefined) assertText(value.journeyEventId, "journeyEventId", 256);
  if (
    value.disposition === "applied" &&
    (!value.artifactSetSha256 || !value.artifactsVerifiedAt || value.blockerCodes.length > 0)
  )
    throw new Error("Applied external source settlement lacks verified artifacts.");
  if (
    value.disposition !== "applied" &&
    (value.blockerCodes.length < 1 || value.artifactSetSha256 !== undefined || value.artifactsVerifiedAt !== undefined)
  )
    throw new Error("Non-applied external source settlement requires a blocker and cannot claim verified artifacts.");
  assertIso(value.settledAt);
  assertCanonicalJsonBytes(value, EXTERNAL_SOURCE_LIMITS.canonicalJsonBytes);
}

export function assertExternalSessionAttachment(value: ExternalSessionAttachmentRecord): void {
  assertRecord(value, "external attachment");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "attachmentId",
      "workspaceId",
      "sessionId",
      "sourceId",
      "importId",
      "itemId",
      "normalizedArtifactSha256",
      "mode",
      "status",
      "revision",
      "attachedByActorId",
      "attachedAt",
      "detachedByActorId",
      "detachedAt",
    ],
    new Set(["detachedByActorId", "detachedAt"]),
  );
  assertVersion(value.schemaVersion);
  for (const [name, input] of [
    ["attachmentId", value.attachmentId],
    ["workspaceId", value.workspaceId],
    ["sessionId", value.sessionId],
    ["sourceId", value.sourceId],
    ["importId", value.importId],
    ["itemId", value.itemId],
    ["attachedByActorId", value.attachedByActorId],
  ] as const)
    assertText(input, name, 256);
  assertSha256(value.normalizedArtifactSha256);
  if (value.mode !== "read_only_external" || (value.status !== "attached" && value.status !== "detached"))
    throw new Error("External attachment mode/status is invalid.");
  assertPositiveInteger(value.revision, "revision");
  assertIso(value.attachedAt);
  if (
    value.status === "attached" &&
    (value.revision !== 1 || value.detachedAt !== undefined || value.detachedByActorId !== undefined)
  )
    throw new Error("Attached external source contains invalid revision or detach evidence.");
  if (value.status === "detached") {
    if (value.revision !== 2 || !value.detachedAt || !value.detachedByActorId)
      throw new Error("Detached external source lacks actor or CAS evidence.");
    assertIso(value.detachedAt);
    assertText(value.detachedByActorId, "detachedByActorId", 256);
  }
  assertCanonicalJsonBytes(value, EXTERNAL_SOURCE_LIMITS.canonicalJsonBytes);
}

export function assertExternalSourceKnowledgeLink(value: ExternalSourceKnowledgeLinkRecord): void {
  assertRecord(value, "knowledge link");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "linkId",
      "workspaceId",
      "sourceId",
      "importId",
      "itemId",
      "normalizedArtifactSha256",
      "approvalId",
      "knowledgeDocumentId",
      "threadKnowledgeAttachmentId",
      "provenanceSha256",
      "createdAt",
    ],
    new Set(["threadKnowledgeAttachmentId"]),
  );
  assertVersion(value.schemaVersion);
  for (const [name, input] of [
    ["linkId", value.linkId],
    ["workspaceId", value.workspaceId],
    ["sourceId", value.sourceId],
    ["importId", value.importId],
    ["itemId", value.itemId],
    ["approvalId", value.approvalId],
    ["knowledgeDocumentId", value.knowledgeDocumentId],
  ] as const)
    assertText(input, name, 256);
  if (value.threadKnowledgeAttachmentId !== undefined)
    assertText(value.threadKnowledgeAttachmentId, "threadKnowledgeAttachmentId", 256);
  assertSha256(value.normalizedArtifactSha256);
  assertSha256(value.provenanceSha256);
  assertIso(value.createdAt);
  assertCanonicalJsonBytes(value, EXTERNAL_SOURCE_LIMITS.canonicalJsonBytes);
}

export function assertExternalSourcePage(value: ExternalSourcePage): void {
  assertRecord(value, "page");
  assertExactKeys(
    value,
    ["schemaVersion", "workspaceId", "sourceId", "scanId", "items", "nextCursor"],
    new Set(["nextCursor"]),
  );
  assertVersion(value.schemaVersion);
  for (const [name, input] of [
    ["workspaceId", value.workspaceId],
    ["sourceId", value.sourceId],
    ["scanId", value.scanId],
  ] as const)
    assertText(input, name, 256);
  if (!Array.isArray(value.items) || value.items.length > EXTERNAL_SOURCE_LIMITS.maxPageSize)
    throw new Error("External source page item count is invalid.");
  value.items.forEach(assertExternalSourceCatalogItem);
  if (value.nextCursor !== undefined) {
    assertText(value.nextCursor, "nextCursor", EXTERNAL_SOURCE_LIMITS.encodedCursorBytes, true);
  }
  assertCanonicalJsonBytes(value, EXTERNAL_SOURCE_LIMITS.canonicalJsonBytes);
}

export function isExternalSourceCursorV1(value: unknown): value is ExternalSourceCursorV1 {
  if (!isRecord(value) || value.version !== EXTERNAL_SOURCE_CURSOR_VERSION) return false;
  const cursor = value as unknown as ExternalSourceCursorV1;
  try {
    assertExactKeys(
      value,
      [
        "version",
        "workspaceId",
        "sourceId",
        "scanId",
        "configRevision",
        "adapterVersion",
        "filterSha256",
        "manifestSha256",
        "highWater",
        "position",
      ],
      new Set(),
    );
    assertText(cursor.workspaceId, "workspaceId", 256);
    assertText(cursor.sourceId, "sourceId", 256);
    assertText(cursor.scanId, "scanId", 256);
    assertText(cursor.adapterVersion, "adapterVersion", 128);
    assertPositiveInteger(cursor.configRevision, "configRevision");
    assertSha256(cursor.filterSha256);
    assertSha256(cursor.manifestSha256);
    assertHighWater(cursor.highWater);
    assertHighWater(cursor.position);
    return compareExternalSourcePositions(cursor.position, cursor.highWater) <= 0;
  } catch {
    return false;
  }
}

export function compareExternalSourcePositions(
  left: ExternalSourceScanHighWater,
  right: ExternalSourceScanHighWater,
): number {
  const mtime = left.observedMtimeNs.localeCompare(right.observedMtimeNs);
  return mtime === 0 ? left.itemId.localeCompare(right.itemId) : mtime;
}

export function canonicalExternalSourceFilterMaterial(
  dispositions?: readonly ExternalSourceCatalogDisposition[],
): string {
  const normalized = dispositions === undefined ? [] : [...new Set(dispositions)];
  if (normalized.some((value) => !CATALOG_DISPOSITIONS.has(value)))
    throw new Error("External source filter is invalid.");
  return canonicalJsonString({ dispositions: normalized.sort() });
}

const SOURCE_KINDS = new Set<ExternalSourceKind>([
  "codex_sessions",
  "codex_memory",
  "claude_sessions",
  "claude_memory",
]);
const ADAPTER_IDS = new Set<ExternalSourceAdapterId>([
  "codex.rollout-jsonl.v1",
  "codex.memory-markdown.v1",
  "claude.project-jsonl.v1",
  "claude.memory-markdown.v1",
]);
const SOURCE_STATUSES = new Set<ExternalSourceStatus>(["active", "disabled", "revoked"]);
const AUTH_SOURCES = new Set<ExternalSourceAuthActorSource>(["token", "basic", "loopback", "device_grant", "none"]);
const CATALOG_DISPOSITIONS = new Set<ExternalSourceCatalogDisposition>([
  "supported",
  "unsupported_variant",
  "quarantined",
  "conflicting",
  "blocked",
]);
const IMPORT_DISPOSITIONS = new Set<ExternalSourceImportDisposition>(["applied", "blocked", "manual_reconciliation"]);
const PATH_FLAVORS = new Set<WorkspacePathFlavor>(["windows_native", "windows_forward", "msys", "wsl"]);
const SHA256 = /^[a-f0-9]{64}$/u;
const MTIME_NS = /^\d{20}$/u;
const UTF8 = new TextEncoder();

function assertAdapterKind(kind: ExternalSourceKind, adapterId: ExternalSourceAdapterId): void {
  const expected: Record<ExternalSourceKind, ExternalSourceAdapterId> = {
    codex_sessions: "codex.rollout-jsonl.v1",
    codex_memory: "codex.memory-markdown.v1",
    claude_sessions: "claude.project-jsonl.v1",
    claude_memory: "claude.memory-markdown.v1",
  };
  if (expected[kind] !== adapterId) throw new Error("External source kind/adapter binding is invalid.");
}

function assertAdapterPolicy(value: ExternalSourceAdapterPolicy): void {
  assertRecord(value, "adapter policy");
  assertExactKeys(
    value,
    ["unknownVariantDisposition", "followLinks", "followMarkdownImports", "retainRawBytes", "acceptedProducerVersions"],
    new Set(),
  );
  if (
    value.unknownVariantDisposition !== "block" ||
    value.followLinks !== false ||
    value.followMarkdownImports !== false ||
    value.retainRawBytes !== false
  )
    throw new Error("External source adapter policy weakens frozen safety.");
  assertStringList(value.acceptedProducerVersions, "acceptedProducerVersions", 64, 128, true);
  assertCanonicalJsonBytes(value, 16 * 1024);
}

function assertHighWater(value: ExternalSourceScanHighWater): void {
  assertRecord(value, "high water");
  assertExactKeys(value, ["observedMtimeNs", "itemId"], new Set());
  assertMtimeNs(value.observedMtimeNs);
  assertText(value.itemId, "itemId", 256);
}

function assertRootPath(value: string): void {
  assertText(value, "canonicalRootPath", EXTERNAL_SOURCE_LIMITS.rootPathBytes, true);
  if (value === "/" || /^[A-Za-z]:[\\/]?$/u.test(value))
    throw new Error("External source root cannot be a filesystem root.");
}

function assertRelativePath(value: string): void {
  assertText(value, "normalizedRelativePath", EXTERNAL_SOURCE_LIMITS.rootPathBytes, true);
  const normalized = value.replaceAll("\\", "/");
  if (
    value !== normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("External source relative path is invalid.");
}

function assertRelativePaths(value: string[]): void {
  if (!Array.isArray(value) || value.length > 32) throw new Error("External source alias paths are invalid.");
  value.forEach(assertRelativePath);
  if (
    new Set(value).size !== value.length ||
    value.some((entry, index) => index > 0 && entry.localeCompare(value[index - 1] ?? "") < 0)
  )
    throw new Error("External source alias paths must be unique and sorted.");
  assertCanonicalJsonBytes(value, 16 * 1024);
}

function assertManagedRelativeKey(value: string): void {
  assertRelativePath(value);
  if (!value.startsWith("external-sources/sha256/"))
    throw new Error("External source artifact key is outside the managed prefix.");
}

function assertCodes(value: string[]): void {
  assertStringList(value, "reasonCodes", 64, 128, true);
  assertCanonicalJsonBytes(value, 8 * 1024);
}

function assertStringList(value: string[], name: string, maxItems: number, maxLength: number, sorted: boolean): void {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`External source ${name} is invalid.`);
  value.forEach((entry) => assertText(entry, name, maxLength));
  if (
    new Set(value).size !== value.length ||
    (sorted && value.some((entry, index) => index > 0 && entry.localeCompare(value[index - 1] ?? "") < 0))
  )
    throw new Error(`External source ${name} must be unique${sorted ? " and sorted" : ""}.`);
}

function normalizeStringList(value: unknown, name: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`External source ${name} is invalid.`);
  const normalized = value.map((entry) => normalizeInputText(entry, name, maxLength)).sort();
  if (new Set(normalized).size !== normalized.length) throw new Error(`External source ${name} must be unique.`);
  return normalized;
}

function normalizeDispositions(value: unknown): ExternalSourceCatalogDisposition[] {
  if (!Array.isArray(value) || value.length > CATALOG_DISPOSITIONS.size) {
    throw new Error("External source dispositions are invalid.");
  }
  const normalized = [...new Set(value as ExternalSourceCatalogDisposition[])].sort();
  if (normalized.some((entry) => !CATALOG_DISPOSITIONS.has(entry))) {
    throw new Error("External source dispositions are invalid.");
  }
  return normalized;
}

function normalizeInputText(value: unknown, name: string, max: number, byteLimit = false): string {
  if (typeof value !== "string") throw new Error(`External source ${name} is invalid.`);
  const normalized = value.normalize("NFKC").trim();
  assertText(normalized, name, max, byteLimit);
  return normalized;
}

function normalizeSha256(value: unknown): string {
  if (typeof value !== "string") throw new Error("External source SHA-256 is invalid.");
  assertSha256(value);
  return value;
}

function normalizePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`External source ${name} is invalid.`);
  return Number(value);
}

function normalizeIntegerRange(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`External source ${name} is invalid.`);
  }
  return Number(value);
}

function assertMtimeNs(value: string): void {
  if (!MTIME_NS.test(value)) throw new Error("External source mtime must be a 20-digit nanosecond value.");
}
function assertSha256(value: string): void {
  if (!SHA256.test(value)) throw new Error("External source SHA-256 is invalid.");
}
function assertOptionalSha256(value: string | undefined): void {
  if (value !== undefined) assertSha256(value);
}
function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`External source ${name} is invalid.`);
}
function assertBoundedCount(value: number, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max)
    throw new Error(`External source ${name} exceeds its hard limit.`);
}
function assertIso(value: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    throw new Error("External source timestamp is invalid.");
}
function assertVersion(value: string): void {
  if (value !== EXTERNAL_SOURCE_SCHEMA_VERSION) throw new Error("External source schema version is unsupported.");
}
function assertText(value: string, name: string, max: number, byteLimit = false): void {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value !== value.normalize("NFKC") ||
    containsAsciiControlCharacter(value) ||
    (byteLimit ? UTF8.encode(value).byteLength : value.length) > max
  )
    throw new Error(`External source ${name} is invalid.`);
}
function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}
function assertCanonicalJsonBytes(value: unknown, max: number): void {
  if (UTF8.encode(canonicalJsonString(value)).byteLength > max)
    throw new Error("External source canonical JSON exceeds its hard limit.");
}
function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`External source ${name} is malformed.`);
}
function assertExactKeys(value: object, keys: readonly string[], optional: ReadonlySet<string>): void {
  const actual = Object.keys(value);
  const allowed = new Set(keys);
  if (actual.some((key) => !allowed.has(key)) || keys.some((key) => !optional.has(key) && !actual.includes(key)))
    throw new Error("External source record contains unsupported or missing fields.");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
