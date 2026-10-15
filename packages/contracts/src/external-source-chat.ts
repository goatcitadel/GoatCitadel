/** Eager Chat attachment and original approval-payload validation. */
import {
  EXTERNAL_SOURCE_LIMITS,
  EXTERNAL_SOURCE_SESSION_INCARNATION_MAX_LENGTH,
  assertCanonicalJsonBytes,
  assertExactKeys,
  assertIso,
  assertPositiveInteger,
  assertRecord,
  assertSha256,
  assertText,
  assertVersion,
  normalizeInputText,
  normalizePositiveInteger,
} from "./external-source-validation.js";
import type {
  ExternalSessionAttachmentRecord,
  ExternalSourceAttachmentCandidateRecord,
  ExternalSessionAttachInput,
  ExternalSessionDetachInput,
  ExternalSourceKnowledgeSnapshotRequestInput,
  ExternalSourceKnowledgeSnapshotApprovalPayload,
  ExternalSourceAttachmentCandidateListResponse,
} from "./external-sources.js";
export {
  EXTERNAL_SOURCE_LIMITS,
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  EXTERNAL_SOURCE_SESSION_INCARNATION_MAX_LENGTH,
} from "./external-source-validation.js";

/** Content-free operator preview for the knowledge-snapshot approval inbox. */
export const EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_CONSEQUENCE =
  "Create a Knowledge document and retrieval chunks from this verified imported snapshot. This does not include the source in the next Chat turn or activate a skill. Approval alone does not prove the copy completed.";

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

export function assertExternalSourceAttachmentCandidate(value: ExternalSourceAttachmentCandidateRecord): void {
  assertRecord(value, "external attachment candidate");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "workspaceId",
      "sourceId",
      "sourceLabel",
      "sourceRevision",
      "importId",
      "itemId",
      "normalizedArtifactSha256",
      "normalizedByteCount",
      "importedAt",
      "artifactsVerifiedAt",
    ],
    new Set(),
  );
  assertVersion(value.schemaVersion);
  for (const [name, input] of [
    ["workspaceId", value.workspaceId],
    ["sourceId", value.sourceId],
    ["importId", value.importId],
    ["itemId", value.itemId],
  ] as const)
    assertText(input, name, 256);
  assertText(value.sourceLabel, "sourceLabel", 512);
  assertPositiveInteger(value.sourceRevision, "sourceRevision");
  assertSha256(value.normalizedArtifactSha256);
  if (!Number.isSafeInteger(value.normalizedByteCount) || value.normalizedByteCount < 0)
    throw new Error("External attachment candidate byte count is invalid.");
  assertIso(value.importedAt);
  assertIso(value.artifactsVerifiedAt);
  assertCanonicalJsonBytes(value, EXTERNAL_SOURCE_LIMITS.canonicalJsonBytes);
}

export function assertExternalSourceAttachmentCandidateListResponse(
  value: ExternalSourceAttachmentCandidateListResponse,
): void {
  assertRecord(value, "external attachment candidate list");
  assertExactKeys(value, ["schemaVersion", "workspaceId", "sessionId", "items"], new Set());
  assertVersion(value.schemaVersion);
  assertText(value.workspaceId, "workspaceId", 256);
  assertText(value.sessionId, "sessionId", 256);
  if (!Array.isArray(value.items) || value.items.length > EXTERNAL_SOURCE_LIMITS.maxPageSize)
    throw new Error("External attachment candidate list item count is invalid.");
  value.items.forEach(assertExternalSourceAttachmentCandidate);
  assertCanonicalJsonBytes(value, EXTERNAL_SOURCE_LIMITS.canonicalJsonBytes);
}
