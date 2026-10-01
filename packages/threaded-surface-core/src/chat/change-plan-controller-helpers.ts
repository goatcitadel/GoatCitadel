import type { ChangePlanRecord } from "@goatcitadel/contracts";
import type { OpenAICodexDeviceStartResponse } from "@goatcitadel/mission-control-shared/api/client";

export function changePlanClientContext(workspaceId: string, plan: ChangePlanRecord) {
  return {
    workspaceId,
    ...(plan.origin.sessionId ? { sessionId: plan.origin.sessionId } : {}),
    ...(plan.origin.turnId ? { turnId: plan.origin.turnId } : {}),
  };
}

export function isTerminalChangePlanStatus(status: ChangePlanRecord["status"]): boolean {
  return ["completed", "applied", "manual_required", "failed", "cancelled", "rolled_back", "rollback_failed"].includes(
    status,
  );
}

export function changePlanReceiptKey(plan: Pick<ChangePlanRecord, "planId" | "revision" | "status">): string {
  return `${plan.planId}:${plan.revision}:${plan.status}`;
}

export function changePlanContextNote(
  plan: ChangePlanRecord | null,
  turnCount: number,
  oauthFlow: {
    planId: string;
    flow: OpenAICodexDeviceStartResponse;
  } | null,
): string | undefined {
  const continuity = changePlanContinuityNote(plan, turnCount);
  const oauth =
    plan && oauthFlow?.planId === plan.planId
      ? `Open ${oauthFlow.flow.verificationUrl}${oauthFlow.flow.userCode ? ` and enter code ${oauthFlow.flow.userCode}` : ""}. GoatCitadel is polling the dedicated provider owner; OAuth tokens never enter Chat.`
      : undefined;
  const notes = [continuity, oauth].filter((value): value is string => Boolean(value));
  return notes.length ? notes.join("\n\n") : undefined;
}

export function changePlanContinuityNote(plan: ChangePlanRecord | null, turnCount: number): string | undefined {
  if (!plan || plan.request.kind !== "session_model" || turnCount < 1) return undefined;
  return `This conversation already has ${turnCount} turn${turnCount === 1 ? "" : "s"}. The thread remains available to the new model, but hidden reasoning state does not transfer. Restate any critical instruction after switching.`;
}

export function requireExactLinkedConfirmation(expected: ChangePlanRecord, current: ChangePlanRecord): void {
  if (
    current.revision !== expected.revision ||
    current.intentHash !== expected.intentHash ||
    current.actionSnapshotHash !== expected.actionSnapshotHash ||
    current.requiredAction?.kind !== "confirmation" ||
    current.requiredAction.actionNonce !== expected.requiredAction?.actionNonce ||
    current.target.expectedRevision !== expected.target.expectedRevision ||
    current.target.expectedHash !== expected.target.expectedHash
  ) {
    throw new Error(
      "One of the linked model plans changed. Nothing was applied; review the refreshed exact revisions.",
    );
  }
}
