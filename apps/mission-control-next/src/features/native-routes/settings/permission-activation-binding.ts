import {
  canonicalJsonString,
  type PermissionProfileActivationRecord,
  type PermissionProfileSelectionReview,
  type PermissionProfileSelectionReviewRequest,
  type PermissionProfileSnapshotRecord,
} from "@goatcitadel/contracts";

export type ActivationRequest = Extract<PermissionProfileSelectionReviewRequest, { operation: "activate" }>;
const revision = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function profileCanBeSelected(profile: PermissionProfileSnapshotRecord | undefined, workspaceId: string) {
  return Boolean(
    profile &&
    workspaceId.trim() &&
    profile.status === "active" &&
    revision(profile.revision) &&
    (profile.scope !== "workspace" || profile.scopeRef === workspaceId),
  );
}

export function activationReviewMatches(
  review: PermissionProfileSelectionReview | undefined,
  input: ActivationRequest,
  profile: PermissionProfileSnapshotRecord | undefined,
): review is PermissionProfileSelectionReview {
  if (!review || !profile || !profileCanBeSelected(profile, input.workspaceId ?? "")) return false;
  return Boolean(
    revision(review.revision) &&
    review.profile?.revision === profile.revision &&
    review.profile.profileId === profile.profileId &&
    review.profile.status === "active" &&
    review.profile.scope === profile.scope &&
    review.profile.scopeRef === profile.scopeRef &&
    canonicalJsonString(review.input) === canonicalJsonString(input) &&
    review.target.workspaceId === input.workspaceId &&
    review.target.sessionId === undefined &&
    (profile.scope === "workspace" ? review.target.operatorId === undefined : Boolean(review.target.operatorId)) &&
    Array.isArray(review.activeProfiles),
  );
}

export function requireActivationReceipt(
  receipt: PermissionProfileActivationRecord,
  review: PermissionProfileSelectionReview,
) {
  if (
    review.input.operation !== "activate" ||
    !receipt?.activationId?.trim() ||
    receipt.active !== true ||
    receipt.profileId !== review.input.profileId ||
    receipt.workspaceId !== review.target.workspaceId ||
    receipt.sessionId !== review.target.sessionId ||
    receipt.operatorId !== review.target.operatorId ||
    receipt.surface !== review.input.surface ||
    !receipt.createdBy?.trim() ||
    !Number.isFinite(Date.parse(receipt.createdAt)) ||
    !Number.isFinite(Date.parse(receipt.updatedAt))
  ) {
    throw new Error("The Gateway did not confirm the reviewed permission selection.");
  }
}

export function isUncommittedActivationConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  const body = value.body as Record<string, unknown> | undefined;
  const details = body?.details as Record<string, unknown> | undefined;
  return (
    value.status === 409 &&
    body?.code === "WRITE_CONFLICT" &&
    ["PERMISSION_PROFILE_REVISION_CONFLICT", "PERMISSION_SELECTION_REVISION_CONFLICT"].includes(
      String(details?.reason),
    ) &&
    ![value, body, details].some((item) => item?.committed === true || item?.mutationCommitted === true)
  );
}
