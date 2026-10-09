import {
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_CONSEQUENCE,
  assertExternalSourceKnowledgeSnapshotApprovalPayload,
  type ApprovalRequest,
  type ExternalSourceKnowledgeSnapshotApprovalPayload,
  type ExternalSourceKnowledgeSnapshotApprovalPreview,
} from "@goatcitadel/contracts";
import type { ApprovalEvidenceModel } from "./approval-helpers.js";

/** Review only original stored approval material, with explicit legacy support. */
export function externalSourceKnowledgeApprovalEvidence(approval: ApprovalRequest): ApprovalEvidenceModel | null {
  const payload = approval.payload as unknown as ExternalSourceKnowledgeSnapshotApprovalPayload;
  try {
    assertExternalSourceKnowledgeSnapshotApprovalPayload(payload);
  } catch {
    return null;
  }
  const preview = approval.preview as unknown as ExternalSourceKnowledgeSnapshotApprovalPreview | undefined;
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) return null;
  const keys = ["sourceId", "importId", "itemId", "attachmentId", "normalizedArtifactSha256", "normalizedByteCount"];
  if (
    Object.keys(preview).some(key => !keys.includes(key) && key !== "review") ||
    keys.some(key => !(key in preview)) ||
    ["sourceId", "importId", "itemId", "attachmentId", "normalizedArtifactSha256"].some(
      key => preview[key as keyof typeof preview] !== payload[key as keyof typeof payload],
    ) ||
    !Number.isSafeInteger(preview.normalizedByteCount) || preview.normalizedByteCount < 0 ||
    approval.linkage?.workspaceId !== payload.workspaceId || approval.linkage?.sessionId !== payload.sessionId
  ) return null;
  const scopeSummary = `Workspace ${payload.workspaceId}; conversation ${payload.sessionId}.`;
  const review = preview.review;
  if (review !== undefined && (
    !review || typeof review !== "object" || Array.isArray(review) || review.version !== 1 ||
    Object.keys(review).sort().join(",") !== "consequence,itemPath,scopeSummary,sourceLabel,target,version" ||
    typeof review.sourceLabel !== "string" || !review.sourceLabel.trim() ||
    typeof review.itemPath !== "string" || !review.itemPath.trim() ||
    review.target !== `Knowledge copy of ${review.itemPath} from ${review.sourceLabel}` ||
    review.scopeSummary !== scopeSummary || review.consequence !== EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_CONSEQUENCE
  )) return null;
  return {
    targets: [review?.target ?? `Knowledge copy of imported item ${payload.itemId}`],
    scopeSummary,
    consequence: review?.consequence ?? EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_CONSEQUENCE,
    commands: [],
    supporting: review
      ? [`Source: ${review.sourceLabel}`, `Imported path: ${review.itemPath}`]
      : ["The original approval did not record a readable source label or item path."],
    changes: [],
    technicalDetails: [{ label: "Snapshot provenance", content: [
      `Source ID: ${preview.sourceId}`, `Import ID: ${preview.importId}`, `Item ID: ${preview.itemId}`,
      `Attachment ID: ${preview.attachmentId}`, `Normalized SHA-256: ${preview.normalizedArtifactSha256}`,
      `Normalized bytes: ${preview.normalizedByteCount}`,
    ].join("\n") }],
  };
}
