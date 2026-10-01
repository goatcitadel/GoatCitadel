import {
  canonicalJsonString,
  type LocalOperatorOverrideRecord,
  type PermissionProfileSelectionReview,
  type PermissionProfileSelectionReviewRequest,
  type PermissionProfileSnapshotRecord,
} from "@goatcitadel/contracts";
import type { createLocalOperatorOverride } from "@goatcitadel/mission-control-shared/api/client";
import { permissionProfileDraftToMutation } from "./helpers/permission-helpers";

export type ProfileFields = ReturnType<typeof permissionProfileDraftToMutation>;
export type PermissionManagementOperation =
  | { kind: "create"; fields: ProfileFields }
  | { kind: "update"; profile: PermissionProfileSnapshotRecord; fields: ProfileFields }
  | { kind: "archive"; profile: PermissionProfileSnapshotRecord }
  | { kind: "override-create"; input: Parameters<typeof createLocalOperatorOverride>[0] }
  | { kind: "override-revoke"; override: LocalOperatorOverrideRecord };
export type PermissionManagementReceipt = PermissionProfileSnapshotRecord | LocalOperatorOverrideRecord;
export const permissionEqual = (left: unknown, right: unknown) =>
  canonicalJsonString(left) === canonicalJsonString(right);
export const permissionRevision = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function hasProfileRevisionConflictReason(error: unknown) {
  if (!error || typeof error !== "object" || !("body" in error)) return false;
  const body = error.body;
  if (!body || typeof body !== "object" || !("details" in body)) return false;
  const details = body.details;
  return Boolean(
    details &&
    typeof details === "object" &&
    "reason" in details &&
    details.reason === "PERMISSION_PROFILE_REVISION_CONFLICT",
  );
}
const unique = (items: string[]) => [...new Set(items.map((item) => item.trim()).filter(Boolean))];

export function permissionOperationKey(base: string, workspaceId: string, operation: PermissionManagementOperation) {
  return JSON.stringify([
    base,
    operation.kind.startsWith("override-")
      ? "local-operator-overrides"
      : "profile" in operation
        ? operation.profile.profileId
        : `create:${workspaceId}`,
  ]);
}

export function defaultSelectionRequest(
  operation: PermissionManagementOperation,
  workspaceId: string,
): PermissionProfileSelectionReviewRequest | undefined {
  if (operation.kind === "create" && operation.fields.defaultForSurfaces.length) {
    return {
      operation: "defaults",
      scope: "workspace",
      scopeRef: workspaceId,
      defaultForSurfaces: operation.fields.defaultForSurfaces,
    };
  }
  if (
    operation.kind === "update" &&
    !permissionEqual(
      [...operation.fields.defaultForSurfaces].sort(),
      [...(operation.profile.defaultForSurfaces ?? [])].sort(),
    )
  ) {
    return {
      operation: "defaults",
      profileId: operation.profile.profileId,
      scope: operation.profile.scope === "operator" ? "operator" : "workspace",
      scopeRef: operation.profile.scopeRef,
      defaultForSurfaces: operation.fields.defaultForSurfaces,
    };
  }
}

export function requireDefaultReview(
  review: PermissionProfileSelectionReview,
  input: PermissionProfileSelectionReviewRequest,
  workspaceId: string,
  profile?: PermissionProfileSnapshotRecord,
) {
  if (
    !permissionRevision(review.revision) ||
    !permissionEqual(review.input, input) ||
    !Array.isArray(review.activeProfiles) ||
    review.target.sessionId !== undefined ||
    (profile ? !permissionEqual(review.profile, profile) : review.profile !== undefined) ||
    (profile?.scope === "operator"
      ? review.target.operatorId !== profile.scopeRef || review.target.workspaceId !== undefined
      : review.target.workspaceId !== workspaceId || review.target.operatorId !== undefined)
  ) {
    throw new Error("The Gateway default-selection review does not match this profile and scope.");
  }
}

export function requireEditableProfile(profile: PermissionProfileSnapshotRecord, workspaceId: string) {
  if (
    !profile.profileId ||
    profile.builtin ||
    profile.status !== "active" ||
    !permissionRevision(profile.revision) ||
    (profile.scope === "workspace"
      ? profile.scopeRef !== workspaceId
      : profile.scope !== "operator" || !profile.scopeRef)
  ) {
    throw new Error("Refresh and select an active custom profile in the current scope.");
  }
}

export function requireProfileReceipt(
  receipt: PermissionProfileSnapshotRecord,
  operation: Extract<PermissionManagementOperation, { kind: "create" | "update" }>,
  workspaceId: string,
) {
  const previous = operation.kind === "update" ? operation.profile : undefined;
  const fields = operation.fields;
  const expected = {
    label: fields.label.trim(),
    description: fields.description ?? previous?.description,
    approvalMode: fields.approvalMode,
    toolPatterns: unique(fields.toolPatterns),
    allow: unique(fields.allow),
    deny: unique(fields.deny),
    readAccessMode: fields.readAccessMode ?? previous?.readAccessMode,
    defaultForSurfaces: unique(fields.defaultForSurfaces),
  };
  const actual = {
    label: receipt.label,
    description: receipt.description,
    approvalMode: receipt.approvalMode,
    toolPatterns: receipt.toolPatterns,
    allow: receipt.allow,
    deny: receipt.deny,
    readAccessMode: receipt.readAccessMode,
    defaultForSurfaces: receipt.defaultForSurfaces ?? [],
  };
  requireEditableProfile(receipt, workspaceId);
  if (
    !permissionEqual(actual, expected) ||
    !receipt.createdBy ||
    !Number.isFinite(Date.parse(receipt.createdAt)) ||
    !Number.isFinite(Date.parse(receipt.updatedAt)) ||
    (previous
      ? receipt.profileId !== previous.profileId ||
        receipt.scope !== previous.scope ||
        receipt.scopeRef !== previous.scopeRef ||
        receipt.createdBy !== previous.createdBy ||
        receipt.createdAt !== previous.createdAt ||
        receipt.revision === previous.revision
      : receipt.scope !== "workspace" || receipt.scopeRef !== workspaceId)
  ) {
    throw new Error("The Gateway did not return the exact reviewed permission profile.");
  }
}

export function requireOverrideReceipt(
  receipt: LocalOperatorOverrideRecord,
  input: Parameters<typeof createLocalOperatorOverride>[0],
) {
  if (
    !receipt.overrideId ||
    !receipt.operatorId ||
    receipt.createdBy !== receipt.operatorId ||
    receipt.status !== "active" ||
    receipt.scope !== input.scope ||
    receipt.scopeRef !== input.scopeRef ||
    receipt.reason !== input.reason.trim() ||
    !Number.isFinite(Date.parse(receipt.createdAt)) ||
    Math.abs(Date.parse(receipt.expiresAt) - Date.parse(receipt.createdAt) - input.ttlSeconds * 1000) > 1
  ) {
    throw new Error("The Gateway did not return the reviewed temporary override and expiry.");
  }
}
