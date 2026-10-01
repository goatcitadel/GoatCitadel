import {
  canonicalJsonString,
  type CapabilityScopeKind,
  type CapabilityResourceType,
  type CapabilityScopeView,
  type CapabilityScopeSelectionReview,
  type CapabilityScopeSelectionReceipt,
} from "@goatcitadel/contracts";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";

export type CapabilitySelection = Record<string, boolean>;
export const sameCapabilityValue = (a: unknown, b: unknown) => canonicalJsonString(a) === canonicalJsonString(b);
export const capabilityOwnerPath = (kind: CapabilityScopeKind, id: string) =>
  `/api/v1/${kind === "citadel" ? "citadels" : "workspaces"}/${encodeURIComponent(id)}/capabilities/reviewed`;

export function validCapabilityView(
  view: CapabilityScopeView,
  kind: CapabilityScopeKind,
  id: string,
  type: CapabilityResourceType,
): boolean {
  return Boolean(
    view &&
    view.scopeKind === kind &&
    view.scopeId === id &&
    view.resourceType === type &&
    ["inherit", "curated"].includes(view.mode) &&
    Array.isArray(view.items) &&
    Array.isArray(view.effectiveRefs) &&
    view.items.every(
      (item) =>
        item &&
        typeof item.resourceRef === "string" &&
        typeof item.label === "string" &&
        typeof item.enabled === "boolean" &&
        typeof item.available === "boolean" &&
        typeof item.inherited === "boolean",
    ) &&
    new Set(view.items.map((item) => item.resourceRef)).size === view.items.length,
  );
}
export function validCapabilityReview(
  review: CapabilityScopeSelectionReview | undefined,
  view: Pick<CapabilityScopeView, "scopeKind" | "scopeId" | "resourceType">,
): review is CapabilityScopeSelectionReview {
  const validAssignments = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.length <= 1000 &&
    value.every(
      (item) =>
        item &&
        typeof item.resourceRef === "string" &&
        item.resourceRef.trim() &&
        item.resourceRef.length <= 512 &&
        typeof item.enabled === "boolean" &&
        Object.keys(item).sort().join() === "enabled,resourceRef",
    ) &&
    new Set(value.map((item) => item.resourceRef)).size === value.length;
  return Boolean(
    review &&
    review.version === "capability_scope_selection.v1" &&
    /^[a-f0-9]{64}$/.test(review.revision) &&
    review.scopeKind === view.scopeKind &&
    review.scopeId === view.scopeId &&
    review.resourceType === view.resourceType &&
    typeof review.citadelId === "string" &&
    review.citadelId &&
    ["active", "archived"].includes(review.scopeLifecycleStatus) &&
    ["active", "archived"].includes(review.citadelLifecycleStatus) &&
    validAssignments(review.assignments) &&
    (review.scopeKind === "workspace"
      ? validAssignments(review.parentAssignments)
      : review.parentAssignments === undefined && review.citadelId === review.scopeId),
  );
}
export function capabilitySelection(view: CapabilityScopeView | null): CapabilitySelection {
  if (!view) return {};
  const saved = new Map(view.selectionReview?.assignments.map((item) => [item.resourceRef, item.enabled]));
  return Object.fromEntries([
    ...view.items.map((item) => [
      item.resourceRef,
      saved.get(item.resourceRef) ?? (view.mode === "inherit" ? item.enabled : false),
    ]),
    ...saved.entries(),
  ]);
}
export function capabilityAssignments(selection: CapabilitySelection) {
  return Object.entries(selection)
    .map(([resourceRef, enabled]) => ({ resourceRef, enabled }))
    .sort((a, b) => (a.resourceRef < b.resourceRef ? -1 : a.resourceRef > b.resourceRef ? 1 : 0));
}
export function validCapabilityReceipt(
  receipt: CapabilityScopeSelectionReceipt,
  before: CapabilityScopeSelectionReview,
  assignments: CapabilityScopeSelectionReview["assignments"],
): boolean {
  const saved = receipt?.selectionReview;
  return Boolean(
    receipt &&
    receipt.version === "capability_scope_receipt.v1" &&
    receipt.previousRevision === before.revision &&
    validCapabilityReview(saved, before) &&
    saved.revision !== before.revision &&
    sameCapabilityValue(saved, { ...before, revision: saved.revision, assignments }),
  );
}
export function rejectedCapabilityWrite(
  error: unknown,
  kind: CapabilityScopeKind,
  id: string,
  reset: boolean,
): boolean {
  if (
    !isApiRequestError(error) ||
    error.method !== (reset ? "DELETE" : "PATCH") ||
    error.path !== capabilityOwnerPath(kind, id) ||
    error.status !== 409
  )
    return false;
  const body = error.body as {
    mutationCommitted?: unknown;
    committed?: unknown;
    code?: unknown;
    details?: { mutationCommitted?: unknown; committed?: unknown; reason?: unknown };
  } | null;
  return (
    body?.mutationCommitted !== true &&
    body?.committed !== true &&
    body?.details?.mutationCommitted !== true &&
    body?.details?.committed !== true &&
    body?.code === "WRITE_CONFLICT" &&
    ["CAPABILITY_SCOPE_REVISION_CONFLICT", "CAPABILITY_SCOPE_ARCHIVED"].includes(String(body?.details?.reason))
  );
}
