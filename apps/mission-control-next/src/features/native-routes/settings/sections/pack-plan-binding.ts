import {
  canonicalJsonString,
  isChangePlanRequest,
  isChangePlanStatus,
  type ApprovalReplaySnapshot,
  type CapabilityPackManifest,
  type ChangePlanCapabilityPackRequest,
  type ChangePlanRecord,
} from "@goatcitadel/contracts";

export const samePackPlan = (a: unknown, b: unknown) => canonicalJsonString(a) === canonicalJsonString(b);
export type PackPlanAction = "confirm" | "cancel" | "rollback" | "verify" | "continue";
export function validWorkspacePlan(plan: ChangePlanRecord, workspaceId: string): boolean {
  return Boolean(
    plan &&
    plan.schemaVersion === 1 &&
    plan.planId &&
    plan.origin?.surface === "settings" &&
    plan.origin.workspaceId === workspaceId &&
    !plan.origin.sessionId &&
    !plan.origin.turnId &&
    isChangePlanRequest(plan.request) &&
    plan.kind === plan.request.kind &&
    isChangePlanStatus(plan.status) &&
    Number.isSafeInteger(plan.revision) &&
    plan.revision > 0 &&
    /^[a-f0-9]{64}$/.test(plan.intentHash) &&
    plan.target?.ownerId &&
    plan.target.resourceId &&
    plan.adapter?.adapterId &&
    Number.isSafeInteger(plan.adapter.version) &&
    Array.isArray(plan.evidenceRefs) &&
    Array.isArray(plan.rollbackRefs) &&
    Array.isArray(plan.approvalRefs),
  );
}
export function validParentPackPlan(plan: ChangePlanRecord, manifest: CapabilityPackManifest, workspaceId: string) {
  return (
    validWorkspacePlan(plan, workspaceId) &&
    plan.request.kind === "capability_pack" &&
    plan.request.packId === manifest.packId &&
    plan.request.manifestHash === manifest.provenance.contentHash &&
    plan.scope === "capability" &&
    plan.target.ownerId === "capability_pack" &&
    plan.target.resourceId === `${workspaceId}:${manifest.packId}` &&
    plan.adapter.adapterId === "capability-pack-execution" &&
    plan.adapter.version === 1
  );
}
export function setupRequest(
  manifest: CapabilityPackManifest,
  assetIds: string[],
): ChangePlanCapabilityPackRequest | undefined {
  if (
    manifest.provenance.source !== "bundled" ||
    !/^[a-f0-9]{64}$/.test(manifest.provenance.contentHash ?? "") ||
    !assetIds.length ||
    assetIds.length > 32 ||
    new Set(assetIds).size !== assetIds.length ||
    assetIds.some(
      (id) =>
        !manifest.assets.some(
          (asset) =>
            asset.id === id &&
            asset.binding &&
            ["mcp", "capability_candidate", "runtime_configuration"].includes(asset.binding.owner) &&
            asset.binding.revision &&
            /^[a-f0-9]{64}$/.test(asset.binding.sha256),
        ),
    )
  )
    return undefined;
  return { kind: "capability_pack", packId: manifest.packId, manifestHash: manifest.provenance.contentHash!, assetIds };
}
export function requireCreatedPackPlan(
  plan: ChangePlanRecord,
  manifest: CapabilityPackManifest,
  workspaceId: string,
  request: ChangePlanCapabilityPackRequest,
  priorIds: string[],
) {
  if (
    !validParentPackPlan(plan, manifest, workspaceId) ||
    !samePackPlan(plan.request, request) ||
    priorIds.includes(plan.planId) ||
    plan.status !== "awaiting_confirmation" ||
    plan.requiredAction?.kind !== "confirmation" ||
    plan.requiredAction.purpose === "rollback" ||
    !plan.requiredAction.actionNonce ||
    !plan.requiredAction.actionId
  )
    throw new Error("The returned setup plan does not match the selected manifest, assets and workspace.");
}
export function canPackPlanAction(plan: ChangePlanRecord, action: PackPlanAction): boolean {
  if (plan.kind !== "capability_pack") return false;
  if (action === "verify") return plan.status === "monitoring";
  if (action === "rollback")
    return ["completed", "applied", "manual_required", "failed"].includes(plan.status) && plan.rollbackRefs.length > 0;
  const required = plan.requiredAction;
  if (!required?.actionId || !required.actionNonce) return false;
  if (action === "cancel")
    return ["awaiting_input", "awaiting_confirmation", "awaiting_approval"].includes(plan.status);
  if (plan.expiresAt && !(Date.parse(plan.expiresAt) > Date.now())) return false;
  if (action === "confirm") return plan.status === "awaiting_confirmation" && required.kind === "confirmation";
  if (action === "continue")
    return (
      plan.status === "awaiting_approval" &&
      required.kind === "approval" &&
      Boolean(required.approvalId && plan.approvalRefs.includes(required.approvalId))
    );
  return false;
}
const immutable = (plan: ChangePlanRecord) => ({
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
export function requirePackPlanReceipt(before: ChangePlanRecord, receipt: ChangePlanRecord, action: PackPlanAction) {
  if (
    !validWorkspacePlan(receipt, before.origin.workspaceId) ||
    !samePackPlan(immutable(before), immutable(receipt)) ||
    receipt.revision <= before.revision ||
    (["confirm", "continue", "cancel"].includes(action) &&
      Boolean(before.requiredAction) &&
      receipt.requiredAction?.actionNonce === before.requiredAction?.actionNonce) ||
    (action === "continue" &&
      before.requiredAction?.kind === "approval" &&
      !receipt.approvalRefs.includes(before.requiredAction.approvalId ?? "")) ||
    (action === "cancel" && receipt.status !== "cancelled") ||
    (action === "rollback" &&
      (receipt.status !== "awaiting_confirmation" ||
        receipt.requiredAction?.kind !== "confirmation" ||
        receipt.requiredAction.purpose !== "rollback"))
  )
    throw new Error("The plan result could not be bound to the reviewed owner action.");
}
export function requirePackApproval(plan: ChangePlanRecord, replay: ApprovalReplaySnapshot) {
  const approval = replay?.approval,
    action = plan.requiredAction;
  const expected = {
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
  if (
    !canPackPlanAction(plan, "continue") ||
    action?.kind !== "approval" ||
    approval?.approvalId !== action.approvalId ||
    approval.kind !== "change_plan_effect" ||
    approval.linkage?.workspaceId !== plan.origin.workspaceId ||
    approval.linkage.sessionId ||
    approval.linkage.turnId ||
    approval.linkage.actionType !== "change_plan_effect" ||
    !samePackPlan(Object.fromEntries(Object.keys(expected).map((key) => [key, approval.payload?.[key]])), expected)
  )
    throw new Error("The approval is not bound to this exact pack plan.");
  if (approval.status !== "approved" || (approval.resolutionOutcome && approval.resolutionOutcome !== "approved"))
    throw new Error("Review and approve the separate canonical approval before continuing this pack plan.");
}
