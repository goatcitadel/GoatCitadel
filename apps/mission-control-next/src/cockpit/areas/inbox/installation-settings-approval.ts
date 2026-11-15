import type { ApprovalRequest } from "@goatcitadel/contracts";

/**
 * A Settings change plan's effect approval. The Gateway creates every one with the "default" workspace as its origin,
 * with no session or turn, and aimed at the runtime settings, so it is install-wide in practice although it is linked
 * to that workspace. This recognises exactly that shape and nothing wider (a capability plan that also uses a
 * Settings surface, or any approval from a conversation, is not it).
 */
export function isInstallationSettingsApproval(
  approval: Pick<ApprovalRequest, "kind" | "linkage" | "payload">,
): boolean {
  const linkage = approval.linkage;
  const payload = approval.payload as { targetOwnerId?: unknown } | undefined;
  return (
    approval.kind === "change_plan_effect" &&
    linkage?.workspaceId === "default" &&
    !linkage.sessionId &&
    !linkage.turnId &&
    payload?.targetOwnerId === "runtime_settings"
  );
}

/**
 * Whether the selected workspace differs from the one the approval is decided in. This is the one check an install-wide
 * Settings approval skips, and only when the caller opted in, the record has the exact shape above and the bar itself
 * reads and decides in the default workspace.
 */
export function scopeDiffers(
  installationSetting: boolean,
  approval: Pick<ApprovalRequest, "kind" | "linkage" | "payload">,
  activeWorkspaceId: string,
  workspaceId: string,
): boolean {
  if (installationSetting && workspaceId === "default" && isInstallationSettingsApproval(approval)) return false;
  return activeWorkspaceId !== workspaceId;
}
