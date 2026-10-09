import { canonicalJsonString, type ApprovalRequest, type OperatorInboxItem } from "@goatcitadel/contracts";

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
    approval,
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
    canonicalJsonString(current) === canonicalJsonString(reviewed) &&
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
): boolean {
  return (
    returned !== undefined &&
    matchesScope(item, returned, workspaceId) &&
    returned.status === (decision === "approve" ? "approved" : "rejected") &&
    actionBinding(returned) === actionBinding(reviewed)
  );
}
