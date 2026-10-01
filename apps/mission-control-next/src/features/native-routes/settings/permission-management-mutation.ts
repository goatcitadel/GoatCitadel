import {
  archivePermissionProfile,
  createLocalOperatorOverride,
  createPermissionProfile,
  fetchActiveLocalOperatorOverrides,
  fetchPermissionProfiles,
  fetchSettings,
  reviewPermissionProfileSelection,
  revokeLocalOperatorOverride,
  updatePermissionProfile,
  getGatewayApiBaseUrl,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  defaultSelectionRequest,
  permissionEqual,
  requireDefaultReview,
  requireEditableProfile,
  requireOverrideReceipt,
  requireProfileReceipt,
  type PermissionManagementOperation,
  type PermissionManagementReceipt,
} from "./permission-management-binding";

/** Reads are advisory. Profile/default CAS and all policy enforcement remain with Gateway. */
export async function readPermissionManagementReview(operation: PermissionManagementOperation, workspaceId: string) {
  if (!workspaceId.trim()) throw new Error("Select a workspace before reviewing this change.");
  const base = getGatewayApiBaseUrl();
  const settings = await fetchSettings();
  if (getGatewayApiBaseUrl() !== base) throw new Error("The Gateway connection changed.");
  if (!Number.isInteger(settings.revision) || settings.revision < 1 || !settings.deploymentProfile) {
    throw new Error("Current deployment settings are unavailable.");
  }
  if (
    (operation.kind === "override-create" || ("fields" in operation && operation.fields.approvalMode === "bypass")) &&
    settings.deploymentProfile === "remote_hardened"
  )
    throw new Error("Remote Hardened does not permit this change.");
  if ("fields" in operation && !operation.fields.label.trim()) throw new Error("Profile name is required.");
  const profiles = !operation.kind.startsWith("override-")
    ? (await fetchPermissionProfiles({ workspaceId, includeArchived: true })).items
    : undefined;
  if ("profile" in operation) {
    requireEditableProfile(operation.profile, workspaceId);
    const current = profiles?.find((item) => item.profileId === operation.profile.profileId);
    if (!permissionEqual(current, operation.profile))
      throw new Error("This profile changed. Refresh and explicitly rebase the draft before reviewing again.");
  }
  if (operation.kind === "override-create") {
    const input = operation.input;
    if (
      !input.reason.trim() ||
      !Number.isInteger(input.ttlSeconds) ||
      input.ttlSeconds < 60 ||
      input.ttlSeconds > 3600 ||
      (input.scope === "operator" ? input.scopeRef !== undefined : !input.scopeRef?.trim()) ||
      (input.scope === "workspace" && input.scopeRef !== workspaceId)
    )
      throw new Error("Review a reason, exact scope and expiry from 60 to 3600 seconds.");
  }
  const overrides = operation.kind.startsWith("override-")
    ? (await fetchActiveLocalOperatorOverrides()).items
    : undefined;
  if (
    operation.kind === "override-revoke" &&
    (operation.override.status !== "active" ||
      !permissionEqual(
        overrides?.find((item) => item.overrideId === operation.override.overrideId),
        operation.override,
      ))
  ) {
    throw new Error("This override changed or expired. Refresh before reviewing it again.");
  }
  const request = defaultSelectionRequest(operation, workspaceId);
  const selection = request ? await reviewPermissionProfileSelection(request) : undefined;
  if (request && selection)
    requireDefaultReview(selection, request, workspaceId, "profile" in operation ? operation.profile : undefined);
  if (getGatewayApiBaseUrl() !== base) throw new Error("The Gateway connection changed.");
  return {
    operation,
    workspaceId,
    base,
    settingsRevision: settings.revision,
    deploymentProfile: settings.deploymentProfile,
    existingProfileIds: operation.kind === "create" ? profiles?.map((item) => item.profileId).sort() : undefined,
    overrides,
    selection,
  };
}

export type PermissionManagementReview = Awaited<ReturnType<typeof readPermissionManagementReview>>;

export async function commitPermissionManagement(
  review: PermissionManagementReview,
): Promise<PermissionManagementReceipt> {
  const { operation, workspaceId, selection, base } = review;
  const requireOrigin = () => {
    if (getGatewayApiBaseUrl() !== base)
      throw new Error("The Gateway connection changed before the result could be verified.");
  };
  requireOrigin();
  if (operation.kind === "create" || operation.kind === "update") {
    const input = { ...operation.fields, expectedSelectionRevision: selection?.revision };
    const receipt =
      operation.kind === "create"
        ? await createPermissionProfile({ scope: "workspace", scopeRef: workspaceId, ...input })
        : await updatePermissionProfile(operation.profile.profileId, {
            ...input,
            expectedRevision: operation.profile.revision,
          });
    requireOrigin();
    requireProfileReceipt(receipt, operation, workspaceId);
    if (operation.kind === "create" && review.existingProfileIds?.includes(receipt.profileId))
      throw new Error("The create receipt reused an existing profile identity.");
    const current = (await fetchPermissionProfiles({ workspaceId, includeArchived: true })).items.find(
      (item) => item.profileId === receipt.profileId,
    );
    requireOrigin();
    if (!permissionEqual(current, receipt)) throw new Error("The saved profile could not be independently verified.");
    return receipt;
  }
  if (operation.kind === "archive") {
    const receipt = await archivePermissionProfile(operation.profile.profileId, {
      expectedRevision: operation.profile.revision,
    });
    requireOrigin();
    if (receipt.archived !== true || receipt.profileId !== operation.profile.profileId)
      throw new Error("The archive receipt does not match this profile.");
    const current = (await fetchPermissionProfiles({ workspaceId, includeArchived: true })).items.find(
      (item) => item.profileId === receipt.profileId,
    );
    requireOrigin();
    if (
      !current ||
      current.status !== "archived" ||
      !current.archivedAt ||
      current.revision === operation.profile.revision ||
      !permissionEqual(
        {
          ...current,
          status: "active",
          revision: operation.profile.revision,
          updatedAt: operation.profile.updatedAt,
          archivedAt: undefined,
        },
        operation.profile,
      )
    ) {
      throw new Error("The archived profile could not be independently verified.");
    }
    return current;
  }
  if (operation.kind === "override-create") {
    const receipt = await createLocalOperatorOverride(operation.input);
    requireOrigin();
    requireOverrideReceipt(receipt, operation.input);
    if (review.overrides?.some((item) => item.overrideId === receipt.overrideId))
      throw new Error("The create receipt reused an existing override identity.");
    const current = (await fetchActiveLocalOperatorOverrides()).items.find(
      (item) => item.overrideId === receipt.overrideId,
    );
    requireOrigin();
    if (!permissionEqual(current, receipt))
      throw new Error("The temporary override could not be independently verified.");
    return receipt;
  }
  const receipt = await revokeLocalOperatorOverride(operation.override.overrideId);
  requireOrigin();
  const current = receipt.override;
  if (
    receipt.revoked !== true ||
    receipt.overrideId !== operation.override.overrideId ||
    !current ||
    current.status !== "revoked" ||
    !current.revokedAt ||
    current.revokedBy !== operation.override.operatorId ||
    receipt.status !== current.status ||
    receipt.revokedAt !== current.revokedAt ||
    receipt.revokedBy !== current.revokedBy ||
    !permissionEqual({ ...current, status: "active", revokedAt: undefined, revokedBy: undefined }, operation.override)
  ) {
    throw new Error("The Gateway did not confirm the exact override revocation.");
  }
  const active = await fetchActiveLocalOperatorOverrides();
  requireOrigin();
  if (active.items.some((item) => item.overrideId === current.overrideId))
    throw new Error("The revoked override is still reported active.");
  return current;
}
