import { canonicalJsonString, type ChangePlanRecord } from "@goatcitadel/contracts";

export type SettingsApprovalOwner =
  | "gateway-auth"
  | "llama-setup"
  | "managed-runtime"
  | "provider-routing"
  | "provider-management"
  | "guided-model";
export type SettingsApprovalReceipt = Pick<ChangePlanRecord, "planId" | "revision" | "status" | "requiredAction">;

function identifier(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/** Inspection eligibility only; this cannot approve or apply the referenced plan. */
export function settingsApprovalOwnerBinding(
  plan: ChangePlanRecord | null | undefined,
  owner: SettingsApprovalOwner,
  workspaceId: string,
  receipt?: SettingsApprovalReceipt,
): { href: string; identity: string } | null {
  if (!plan || plan.schemaVersion !== 1 || !identifier(plan.planId) || !identifier(plan.intentHash)
    || !Number.isSafeInteger(plan.revision) || plan.revision < 1
    || plan.status !== "awaiting_approval" || plan.phase !== "authorization"
    || plan.origin?.surface !== "settings" || plan.origin.sessionId !== undefined || plan.origin.turnId !== undefined
    || !identifier(plan.origin.workspaceId) || !identifier(workspaceId)
    || !plan.target || !plan.request || !plan.adapter
    || typeof plan.target.expectedRevision !== "number"
    || !Number.isSafeInteger(plan.target.expectedRevision) || plan.target.expectedRevision < 0) return null;
  const action = plan.requiredAction;
  if (action?.kind !== "approval" || !identifier(action.approvalId)
    || !identifier(action.actionId) || !identifier(action.actionNonce)
    || !["caution", "danger"].includes(action.risk)
    || !Array.isArray(plan.approvalRefs) || !plan.approvalRefs.includes(action.approvalId)) return null;
  if (receipt && (receipt.planId !== plan.planId || receipt.revision !== plan.revision
    || receipt.status !== plan.status || canonicalJsonString(receipt.requiredAction) !== canonicalJsonString(action))) return null;

  let expectedWorkspace = workspaceId;
  let matches: boolean;
  if (["gateway-auth", "managed-runtime", "llama-setup"].includes(owner)) {
    const operation = owner === "gateway-auth" ? "gateway_auth_configuration"
      : owner === "managed-runtime" ? "llama_cpp_configuration" : "llama_cpp_setup";
    expectedWorkspace = owner === "llama-setup" ? workspaceId : "default";
    matches = plan.kind === "runtime_configuration" && plan.request.kind === "runtime_configuration"
      && plan.request.change.operation === operation && plan.target.ownerId === "runtime_settings"
      && plan.target.resourceId === operation && plan.adapter.adapterId === "runtime-configuration"
      && plan.adapter.version === 2 && plan.scope === "runtime";
  } else if (owner === "provider-routing") {
    expectedWorkspace = "default";
    matches = plan.kind === "installation_default_model" && plan.request.kind === "installation_default_model"
      && plan.target.ownerId === "runtime_settings" && plan.target.resourceId === "llm_defaults"
      && plan.adapter.adapterId === "model-selection" && plan.adapter.version === 1 && plan.scope === "installation";
  } else if (owner === "provider-management") {
    matches = plan.kind === "provider_connection" && plan.request.kind === "provider_connection"
      && identifier(plan.request.providerId) && plan.target.ownerId === "provider_connection"
      && plan.target.resourceId === plan.request.providerId && plan.adapter.adapterId === "provider-connection"
      && plan.adapter.version === 5 && plan.scope === "provider";
    if (plan.request.kind === "provider_connection") {
      // Compatibility profile/key mutations are installation-owned. Dedicated
      // Codex OAuth plans use the active workspace explicitly supplied by their owner.
      const workspaceOAuth = plan.request.providerId === "openai-codex" && !plan.request.profile
        && (!plan.request.credentialAction || ["replace_oauth", "remove_oauth"].includes(plan.request.credentialAction));
      expectedWorkspace = workspaceOAuth ? workspaceId : "default";
    }
  } else {
    matches = (plan.kind === "provider_connection" && plan.request.kind === "provider_connection"
      && identifier(plan.request.providerId) && plan.target.ownerId === "provider_connection"
      && plan.target.resourceId === plan.request.providerId && plan.adapter.adapterId === "provider-connection"
      && plan.adapter.version === 5 && plan.scope === "provider")
      || (plan.kind === "installation_default_model" && plan.request.kind === "installation_default_model"
        && plan.target.ownerId === "runtime_settings" && plan.target.resourceId === "llm_defaults"
        && plan.adapter.adapterId === "model-selection" && plan.adapter.version === 1 && plan.scope === "installation");
  }
  if (!matches || plan.origin.workspaceId !== expectedWorkspace) return null;
  return {
    href: `/ops/approvals?approvalId=${encodeURIComponent(action.approvalId)}&shell=classic`,
    identity: canonicalJsonString({ owner, workspaceId, planId: plan.planId, revision: plan.revision,
      origin: plan.origin, intentHash: plan.intentHash, target: plan.target, request: plan.request,
      adapter: plan.adapter, requiredAction: action }),
  };
}
