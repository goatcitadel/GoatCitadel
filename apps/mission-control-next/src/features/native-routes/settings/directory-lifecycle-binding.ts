import type { CitadelRecord, WorkspaceRecord } from "@goatcitadel/contracts";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { hasWorkspaceBinding, isWorkspaceRevisionConflict } from "./workspace-editor-state";

export type DirectoryLifecycleReview = { action: "archive" | "restore" } & (
  | { kind: "workspace"; record: WorkspaceRecord; scope: string }
  | { kind: "citadel"; record: CitadelRecord }
);
export function directoryRecordId(review: DirectoryLifecycleReview): string {
  return review.kind === "workspace" ? review.record.workspaceId : review.record.citadelId;
}
export function directoryAttemptKey(review: DirectoryLifecycleReview): string {
  return review.kind === "workspace"
    ? `workspace:${review.scope}:${review.record.workspaceId}:edit`
    : `citadel:${review.record.citadelId}:edit`;
}
export function hasCitadelRecord(record: CitadelRecord | undefined | null): record is CitadelRecord {
  return Boolean(record?.citadelId && /^[a-f0-9]{64}$/.test(record.revision) && record.name?.trim() && record.slug
    && ["active", "archived"].includes(record.lifecycleStatus));
}
export function sameDirectoryRecord(review: DirectoryLifecycleReview, current: WorkspaceRecord | CitadelRecord): boolean {
  const before = review.record;
  // hasCharter is a directory projection; it is not part of the persisted profile revision.
  const profile = (value: WorkspaceRecord | CitadelRecord) => {
    const { hasCharter: _hasCharter, ...persisted } = value as CitadelRecord;
    return persisted;
  };
  return (review.kind === "workspace" ? hasWorkspaceBinding(current as WorkspaceRecord, review.scope)
    : hasCitadelRecord(current as CitadelRecord)) && JSON.stringify(profile(before)) === JSON.stringify(profile(current));
}
export function directoryLifecycleReceiptMatches(review: DirectoryLifecycleReview, receipt: WorkspaceRecord | CitadelRecord): boolean {
  const before = review.record;
  const status = review.action === "archive" ? "archived" : "active";
  if (before.lifecycleStatus === status || receipt.lifecycleStatus !== status
    || !Number.isFinite(Date.parse(receipt.updatedAt))
    || (review.action === "archive" ? receipt.archivedAt !== receipt.updatedAt : receipt.archivedAt !== undefined)) return false;
  const preserved = ["name", "description", "slug", "createdAt"] as const;
  if (preserved.some((field) => receipt[field] !== before[field])) return false;
  if (review.kind === "workspace") {
    const saved = receipt as WorkspaceRecord;
    return hasWorkspaceBinding(saved, review.scope) && saved.workspaceId === review.record.workspaceId
      && saved.revision === review.record.revision + 1
      && JSON.stringify(saved.workspacePrefs ?? {}) === JSON.stringify(review.record.workspacePrefs ?? {});
  }
  const saved = receipt as CitadelRecord;
  return hasCitadelRecord(saved) && saved.citadelId === review.record.citadelId
    && saved.revision !== review.record.revision && saved.kind === review.record.kind
    && saved.defaultWorkspaceId === review.record.defaultWorkspaceId
    && Date.parse(saved.updatedAt) > Date.parse(review.record.updatedAt);
}
export function directoryLifecycleConflict(error: unknown, review: DirectoryLifecycleReview): boolean {
  if (review.kind === "workspace") return isWorkspaceRevisionConflict(error, review.record.workspaceId, review.record.revision);
  if (!isApiRequestError(error) || error.status !== 409 || !error.body || typeof error.body !== "object") return false;
  const body = error.body as Record<string, unknown>, details = body.details as Record<string, unknown> | undefined;
  return body.code === "WRITE_CONFLICT" && details?.reason === "CITADEL_RECORD_REVISION_CONFLICT"
    && body.committed !== true && body.mutationCommitted !== true
    && details.committed !== true && details.mutationCommitted !== true;
}
