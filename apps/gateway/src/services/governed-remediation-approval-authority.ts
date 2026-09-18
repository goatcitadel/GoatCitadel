import {
  GOVERNED_REMEDIATION_APPROVAL_SCHEMA_VERSION,
  canonicalJsonString,
  governedRemediationApprovalKind,
  type ApprovalRequest,
  type GovernedRemediationApprovalPayload,
  type GovernedRemediationApprovalPurpose,
  type GovernedRemediationRecipe,
} from "@goatcitadel/contracts";
import type { AsyncStorage, GovernedRemediationStoredState } from "@goatcitadel/storage";
import type { GovernedRemediationAuthorityRequest } from "./governed-remediation-coordinator.js";

/** Build only from a canonical stored repair and its allowlisted recipe. Never
 * accept a caller-supplied approval payload as the expected authorization. */
export function buildGovernedRemediationApprovalPayload(
  state: GovernedRemediationStoredState,
  recipe: GovernedRemediationRecipe,
  purpose: GovernedRemediationApprovalPurpose,
  application: { receiptId: string; ownerRevisionAfter: string } | null = null,
): GovernedRemediationApprovalPayload {
  const r = state.record;
  if (recipe.recipeId !== r.recipeId || recipe.recipeVersion !== r.recipeVersion || recipe.ownerId !== state.ownerId
    || (purpose === "activation") !== (application !== null)) throw new Error("Remediation approval recipe or application binding conflicts.");
  return Object.freeze({ schemaVersion: GOVERNED_REMEDIATION_APPROVAL_SCHEMA_VERSION, purpose,
    remediationId: r.remediationId, requesterActorId: r.requesterActorId, workspaceId: r.workspaceId,
    sessionId: r.sessionId, sourceTurnId: r.sourceTurnId, durableRunId: r.durableRunId,
    blockedCheckpointId: r.blockedCheckpointId, expectedWaitingRunVersion: r.expectedWaitingRunVersion,
    recipeId: r.recipeId, recipeVersion: r.recipeVersion, recipeSha256: r.recipeSha256,
    ownerId: state.ownerId, requestedCapabilityId: recipe.requestedCapabilityId, scope: r.scope,
    expectedOwnerRevision: application?.ownerRevisionAfter ?? r.expectedOwnerRevision,
    applicationReceiptId: application?.receiptId ?? null });
}

/** Approval evidence only: callers must separately verify current deny-wins
 * policy, canonical phase claims, registry binding, and current parent authority. */
export class GovernedRemediationApprovalAuthority {
  public constructor(private readonly storage: Pick<AsyncStorage, "approvals" | "durableRuns" | "governedRemediations">) {}

  public async verify(request: GovernedRemediationAuthorityRequest, state: GovernedRemediationStoredState,
    recipe: GovernedRemediationRecipe): Promise<boolean> {
    const r = state.record;
    if (request.remediationId !== r.remediationId || request.requesterActorId !== r.requesterActorId
      || request.workspaceId !== r.workspaceId || request.sessionId !== r.sessionId || request.sourceTurnId !== r.sourceTurnId
      || request.durableRunId !== r.durableRunId || request.blockedCheckpointId !== r.blockedCheckpointId
      || request.expectedWaitingRunVersion !== r.expectedWaitingRunVersion || request.stateRevision !== r.revision
      || request.recipeId !== r.recipeId || request.recipeVersion !== r.recipeVersion || request.recipeSha256 !== r.recipeSha256
      || request.ownerId !== state.ownerId || request.requestedCapabilityId !== recipe.requestedCapabilityId
      || canonicalJsonString(request.scope) !== canonicalJsonString(r.scope)) return false;
    const purpose = request.approvalPurpose;
    const activationPhase = request.phase === "activate" || (request.phase === "probe" && r.state === "activating");
    const required = activationPhase ? recipe.activationApproval === "required"
      : ["preflight", "apply", "probe"].includes(request.phase) && recipe.preEffectApproval !== "not_required";
    if (purpose === null) return request.approvalId === null && !required;
    if (!request.approvalId || !required || (purpose === "activation" ? !activationPhase
      : activationPhase || !["preflight", "apply", "probe"].includes(request.phase))) return false;
    const boundId = purpose === "activation" ? state.record.activationApprovalId : state.record.preEffectApprovalId;
    if (boundId !== null && boundId !== request.approvalId) return false;
    if (purpose === "activation" && request.approvalId === state.record.preEffectApprovalId) return false;
    let application: { receiptId: string; ownerRevisionAfter: string } | null = null;
    if (purpose === "activation") {
      if (!state.record.latestReceiptId) return false;
      const latest = await this.storage.governedRemediations.getReceipt(state.record.latestReceiptId);
      if (latest.kind !== "verification" || latest.remediationId !== state.record.remediationId) return false;
      const applied = await this.storage.governedRemediations.getReceipt(latest.applicationReceiptId);
      if (applied.kind !== "application" || applied.remediationId !== state.record.remediationId
        || applied.effectId !== state.record.effectId || applied.ownerId !== state.ownerId) return false;
      application = applied;
    }
    const expected = buildGovernedRemediationApprovalPayload(state, recipe, purpose, application);
    const approval = await this.storage.approvals.get(request.approvalId);
    const now = Date.parse(await this.storage.durableRuns.readDatabaseNow());
    return exactApproval(approval, expected, now);
  }
}

function exactApproval(approval: ApprovalRequest, expected: GovernedRemediationApprovalPayload, now: number): boolean {
  const expires = Date.parse(approval.expiresAt ?? "");
  const resolved = Date.parse(approval.resolvedAt ?? "");
  const created = Date.parse(approval.createdAt);
  const link = approval.linkage;
  return approval.kind === governedRemediationApprovalKind(expected.purpose) && approval.status === "approved"
    && approval.resolvedBy === expected.requesterActorId && Number.isFinite(now) && Number.isFinite(expires) && expires > now
    && Number.isFinite(created) && Number.isFinite(resolved) && created <= resolved && resolved <= now && resolved < expires
    && canonicalJsonString(approval.payload) === canonicalJsonString(expected)
    && link?.workspaceId === expected.workspaceId && link.sessionId === expected.sessionId
    && link.turnId === expected.sourceTurnId && link.runId === expected.durableRunId
    && (link.durableRunId === undefined || link.durableRunId === expected.durableRunId)
    && link.actionType === governedRemediationApprovalKind(expected.purpose)
    && link.operatorId === expected.requesterActorId;
}
