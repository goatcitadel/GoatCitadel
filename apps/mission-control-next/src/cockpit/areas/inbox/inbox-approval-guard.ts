import {
  canonicalJsonString,
  hasSealedApprovalLinkage,
  type ApprovalRequest,
  type OperatorInboxItem,
} from "@goatcitadel/contracts";

/** Shown when the click-time re-read finds the reviewed approval changed, decided, expired or gone; nothing is sent. */
export const CHANGED_APPROVAL_RECORD =
  "This approval changed or is no longer in the current pending queue. Refresh it before deciding.";

/** Advisory explanations can arrive during a decision on an exact, structured tool preview. */
export function approvalReviewRecord(approval: ApprovalRequest) {
  if (
    !(approval.kind.startsWith("mcp.") && approval.preview?.reviewKind === "mcp.operation") &&
    !(approval.preview?.reviewKind === "knowledge.operation" && approval.preview.toolName === approval.kind)
  )
    return approval;
  const { explanation: _explanation, explanationStatus: _status, explanationError: _error, ...review } = approval;
  return review;
}

export function inboxApprovalReviewKey(
  item: OperatorInboxItem | undefined,
  approval: ApprovalRequest,
  workspaceId: string,
  activeWorkspaceId: string,
): string {
  return canonicalJsonString({
    workspaceId,
    activeWorkspaceId,
    itemId: item?.id,
    kind: item?.kind,
    source: item?.source,
    approval: approvalReviewRecord(approval),
  });
}

function matchesScope(item: OperatorInboxItem | undefined, approval: ApprovalRequest, workspaceId: string): boolean {
  return (
    Boolean(workspaceId.trim()) &&
    (!item ||
      (item.kind === "approval" &&
        item.source.workspaceId === workspaceId &&
        item.source.approvalId === approval.approvalId)) &&
    (!approval.linkage?.workspaceId || approval.linkage.workspaceId === workspaceId)
  );
}

/** A queue result must still be the exact pending record the operator reviewed. */
export function canResolveInboxApproval(
  item: OperatorInboxItem | undefined,
  reviewed: ApprovalRequest,
  current: ApprovalRequest | undefined,
  workspaceId: string,
  now = Date.now(),
  specialistReviewed = false,
): boolean {
  return (
    matchesScope(item, reviewed, workspaceId) &&
    reviewed.status === "pending" &&
    (specialistReviewed || (reviewed.kind !== "remote_worker.native_runtime" && reviewed.kind !== "code_mode.run")) &&
    !reviewed.mcpElicitation &&
    current !== undefined &&
    current.status === "pending" &&
    canonicalJsonString(approvalReviewRecord(current)) === canonicalJsonString(approvalReviewRecord(reviewed)) &&
    (!current.expiresAt || Date.parse(current.expiresAt) > now)
  );
}

function actionBinding(approval: ApprovalRequest): string {
  return canonicalJsonString({
    approvalId: approval.approvalId,
    kind: approval.kind,
    riskLevel: approval.riskLevel,
    payload: approval.payload,
    preview: approval.preview,
    linkage: approval.linkage,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    rollbackNote: approval.rollbackNote,
    mcpElicitation: approval.mcpElicitation,
    shellExplanations: approval.shellExplanations,
  });
}

/** Resolution and follow-on fields may advance; the reviewed action must not change. */
export function matchesInboxApprovalDecision(
  item: OperatorInboxItem | undefined,
  reviewed: ApprovalRequest,
  returned: ApprovalRequest | undefined,
  workspaceId: string,
  decision: "approve" | "reject",
  wakeRunId?: string,
): boolean {
  if (
    !returned ||
    !matchesScope(item, returned, workspaceId) ||
    returned.status !== (decision === "approve" ? "approved" : "rejected")
  ) {
    return false;
  }
  if (actionBinding(returned) === actionBinding(reviewed)) return true;
  if (!returned.linkage || hasSealedApprovalLinkage(reviewed.kind)) return false;

  // A readback can add a wait run. Replacing an existing run also requires
  // the explicit wake-run ID from the same resolution response.
  const { durableRunId, ...linkage } = returned.linkage;
  const originalRunId = reviewed.linkage?.durableRunId;
  if (!durableRunId?.trim()) return false;
  if (wakeRunId === undefined ? originalRunId !== undefined : durableRunId !== wakeRunId) return false;
  const originalLinkage =
    !reviewed.linkage && Object.keys(linkage).length === 0 ? undefined : { ...linkage, durableRunId: originalRunId };
  return actionBinding({ ...returned, linkage: originalLinkage }) === actionBinding(reviewed);
}
