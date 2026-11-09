import { ConflictError, ValidationError, type ChangePlanRecord, type ChangePlanRequiredAction } from "@goatcitadel/contracts";
import type { EvolutionControlPlaneOwnerInputReceipt } from "./evolution-control-plane-adapter.js";

// Which action a Change Plan awaits, checked against the caller's nonce before the control plane acts on it.

export function requirePendingAction(
  plan: ChangePlanRecord,
  kind: "confirmation",
  actionNonce: string,
): Extract<ChangePlanRequiredAction, { kind: "confirmation" }>;
export function requirePendingAction(
  plan: ChangePlanRecord,
  kind: "public_form",
  actionNonce: string,
): Extract<ChangePlanRequiredAction, { kind: "public_form" }>;
export function requirePendingAction(
  plan: ChangePlanRecord,
  kind: "approval",
  actionNonce: string,
): Extract<ChangePlanRequiredAction, { kind: "approval" }>;
export function requirePendingAction(
  plan: ChangePlanRecord,
  kind: ChangePlanRequiredAction["kind"],
  actionNonce: string,
): ChangePlanRequiredAction {
  if (!plan.requiredAction || plan.requiredAction.kind !== kind) {
    throw new ConflictError({ message: `Change Plan is not awaiting ${kind.replaceAll("_", " ")}.` });
  }
  if (!actionNonce || actionNonce !== plan.requiredAction.actionNonce) {
    throw new ConflictError({ message: "Change Plan action nonce is missing or stale." });
  }
  return plan.requiredAction;
}

export function requireOwnerInputAction(
  plan: ChangePlanRecord,
  kind: EvolutionControlPlaneOwnerInputReceipt["actionKind"],
  actionNonce: string,
): Extract<ChangePlanRequiredAction, { kind: EvolutionControlPlaneOwnerInputReceipt["actionKind"] }> {
  const action = plan.requiredAction;
  if (!action || action.kind !== kind || !isOwnerInputActionKind(action.kind)) {
    throw new ConflictError({ message: `Change Plan is not awaiting ${kind.replaceAll("_", " ")}.` });
  }
  if (!actionNonce || action.actionNonce !== actionNonce) {
    throw new ConflictError({ message: "Change Plan action nonce is missing or stale." });
  }
  return action;
}

export function requireArtifactReviewAction(
  plan: ChangePlanRecord,
  actionNonce: string,
): Extract<ChangePlanRequiredAction, { kind: "artifact_review" }> {
  const action = plan.requiredAction;
  if (!action || action.kind !== "artifact_review") {
    throw new ConflictError({ message: "Change Plan is not awaiting artifact review." });
  }
  if (!actionNonce || action.actionNonce !== actionNonce) {
    throw new ConflictError({ message: "Change Plan action nonce is missing or stale." });
  }
  return action;
}

/**
 * Whether a plan still waits for its own apply confirmation, the one confirmation a route that makes and confirms a
 * plan in one request may give. A rollback confirmation, or a plan that has moved on, is answered with its receipt.
 */
export function awaitsApplyConfirmation(
  plan: ChangePlanRecord,
): plan is ChangePlanRecord & { readonly requiredAction: Extract<ChangePlanRequiredAction, { kind: "confirmation" }> } {
  const action = plan.requiredAction;
  return plan.status === "awaiting_confirmation" && action?.kind === "confirmation" && action.purpose !== "rollback";
}

export function isOwnerInputActionKind(value: string): value is EvolutionControlPlaneOwnerInputReceipt["actionKind"] {
  return value === "secure_input" || value === "oauth" || value === "native_path_picker";
}

export function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\r\n\0]/u.test(normalized)) {
    throw new ValidationError({ message: `Change Plan ${label} is invalid.` });
  }
  return normalized;
}

export function validateOwnerInputReceipt(receipt: EvolutionControlPlaneOwnerInputReceipt): void {
  requireIdentifier(receipt.actionId, "ownerInput.actionId");
  requireIdentifier(receipt.ownerId, "ownerInput.ownerId");
  requireIdentifier(receipt.ownerResourceId, "ownerInput.ownerResourceId");
  if (
    receipt.ownerRevision !== undefined &&
    (!Number.isSafeInteger(receipt.ownerRevision) || receipt.ownerRevision < 1)
  ) {
    throw new ValidationError({ message: "Change Plan owner input revision is invalid." });
  }
  if (
    receipt.evidenceRefs &&
    (receipt.evidenceRefs.length > 64 || receipt.evidenceRefs.some((ref) => !ref.trim() || ref.length > 512))
  ) {
    throw new ValidationError({ message: "Change Plan owner input evidence references are invalid." });
  }
}
