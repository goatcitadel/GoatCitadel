import {
  canonicalJsonString,
  CHANGE_PLAN_STATUSES,
  type ApprovalReplaySnapshot,
  type ChangePlanRecord,
} from "@goatcitadel/contracts";

export function planSnapshot(plan?: ChangePlanRecord): string | undefined {
  if (!plan) return undefined;
  try {
    return canonicalJsonString(plan);
  } catch {
    return undefined;
  }
}

export function continuationAction(plan: ChangePlanRecord | undefined, workspaceId: string) {
  const action = plan?.requiredAction;
  if (
    !plan ||
    !workspaceId.trim() ||
    plan.schemaVersion !== 1 ||
    plan.origin?.surface !== "settings" ||
    plan.origin.workspaceId !== workspaceId ||
    plan.kind !== plan.request?.kind ||
    !plan.planId?.trim() ||
    !plan.intentHash?.trim() ||
    !plan.target?.ownerId?.trim() ||
    !plan.target.resourceId?.trim() ||
    !plan.adapter?.adapterId?.trim() ||
    !Number.isSafeInteger(plan.adapter.version) ||
    plan.adapter.version < 1 ||
    !Number.isSafeInteger(plan.revision) ||
    plan.revision < 1 ||
    plan.status !== "awaiting_approval" ||
    plan.phase !== "authorization" ||
    plan.result?.failureCode === "rollback_approval_pending" ||
    action?.kind !== "approval" ||
    !action.approvalId?.trim() ||
    !action.actionId?.trim() ||
    !action.actionNonce?.trim() ||
    !Array.isArray(plan.approvalRefs) ||
    !plan.approvalRefs.includes(action.approvalId) ||
    (plan.expiresAt && !(Date.parse(plan.expiresAt) > Date.now()))
  )
    return undefined;
  return { ...action, approvalId: action.approvalId };
}

function approvalPayloadBinding(plan: ChangePlanRecord) {
  return {
    planId: plan.planId,
    kind: plan.kind,
    scope: plan.scope,
    intentHash: plan.intentHash,
    targetOwnerId: plan.target.ownerId,
    targetResourceId: plan.target.resourceId,
    targetRevision: plan.target.expectedRevision,
    targetHash: plan.target.expectedHash,
    adapterId: plan.adapter.adapterId,
    adapterVersion: plan.adapter.version,
  };
}

/** The approval is authored before the awaiting action, so its action hash can differ. */
export function requireApprovedBinding(plan: ChangePlanRecord, replay: ApprovalReplaySnapshot) {
  const approval = replay?.approval;
  const action = continuationAction(plan, plan.origin.workspaceId);
  const expected = approvalPayloadBinding(plan);
  if (
    !action ||
    approval?.approvalId !== action.approvalId ||
    approval.kind !== "change_plan_effect" ||
    approval.linkage?.workspaceId !== plan.origin.workspaceId ||
    approval.linkage.actionType !== "change_plan_effect" ||
    !approval.payload ||
    canonicalJsonString(Object.fromEntries(Object.keys(expected).map((key) => [key, approval.payload[key]]))) !==
      canonicalJsonString(expected)
  )
    throw new Error("Approval evidence does not match this Settings change. Refresh and review its required approval.");
  if (approval.status === "pending") {
    throw new Error("The approval is not approved yet. Review the required approval first.");
  }
  if (approval.status !== "approved" || (approval.resolutionOutcome && approval.resolutionOutcome !== "approved")) {
    throw new Error("The required approval is not approved. Review its recorded decision before continuing.");
  }
}

function immutableBinding(plan: ChangePlanRecord) {
  return canonicalJsonString({
    schemaVersion: plan.schemaVersion,
    planId: plan.planId,
    origin: plan.origin,
    adapter: plan.adapter,
    kind: plan.kind,
    scope: plan.scope,
    request: plan.request,
    intentHash: plan.intentHash,
    target: plan.target,
    createdAt: plan.createdAt,
  });
}

export function requireContinuationReceipt(reviewed: ChangePlanRecord, receipt: ChangePlanRecord) {
  const action = reviewed.requiredAction;
  if (
    !receipt ||
    action?.kind !== "approval" ||
    !action.approvalId ||
    immutableBinding(receipt) !== immutableBinding(reviewed) ||
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision <= reviewed.revision ||
    !CHANGE_PLAN_STATUSES.includes(receipt.status) ||
    !Array.isArray(receipt.approvalRefs) ||
    !receipt.approvalRefs.includes(action.approvalId) ||
    receipt.requiredAction?.actionNonce === action.actionNonce
  )
    throw new Error("The response did not confirm a new result for the reviewed Settings change.");
}
