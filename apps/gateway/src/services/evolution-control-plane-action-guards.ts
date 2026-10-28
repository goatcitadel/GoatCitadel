import { ConflictError, type ChangePlanRecord, type ChangePlanRequiredAction } from "@goatcitadel/contracts";
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

export function isOwnerInputActionKind(value: string): value is EvolutionControlPlaneOwnerInputReceipt["actionKind"] {
  return value === "secure_input" || value === "oauth" || value === "native_path_picker";
}
