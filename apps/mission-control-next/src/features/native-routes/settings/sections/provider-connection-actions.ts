import { canonicalJsonString, isProviderProfileCheckpoint, type ChangePlanRecord } from "@goatcitadel/contracts";
import { confirmChangePlan, submitChangePlanProviderSecret } from "@goatcitadel/mission-control-shared/api/client";

function context(plan: ChangePlanRecord) {
  return { workspaceId: plan.origin.workspaceId, sessionId: plan.origin.sessionId, turnId: plan.origin.turnId };
}

export function assertSettingsPlanResponse(reviewed: ChangePlanRecord, next: ChangePlanRecord): void {
  if (
    next.planId !== reviewed.planId ||
    !Number.isSafeInteger(next.revision) ||
    next.revision <= reviewed.revision ||
    next.origin.workspaceId !== reviewed.origin.workspaceId ||
    next.origin.sessionId !== reviewed.origin.sessionId ||
    next.origin.turnId !== reviewed.origin.turnId ||
    next.origin.surface !== reviewed.origin.surface ||
    next.kind !== reviewed.kind ||
    next.intentHash !== reviewed.intentHash ||
    canonicalJsonString(next.request) !== canonicalJsonString(reviewed.request) ||
    next.target.ownerId !== reviewed.target.ownerId ||
    next.target.resourceId !== reviewed.target.resourceId
  ) {
    throw new Error("The response did not confirm the reviewed change. Refresh its status before another action.");
  }
  const checkpoint = next.result?.providerProfileCheckpoint;
  if (
    reviewed.result?.providerProfileCheckpoint &&
    canonicalJsonString(checkpoint) !== canonicalJsonString(reviewed.result.providerProfileCheckpoint)
  )
    throw new Error("The response did not confirm the reviewed committed profile checkpoint.");
  if (next.target.expectedRevision !== reviewed.target.expectedRevision) {
    if (
      reviewed.request.kind !== "provider_connection" ||
      !reviewed.request.profile ||
      !isProviderProfileCheckpoint(checkpoint) ||
      checkpoint.providerId !== reviewed.request.providerId ||
      checkpoint.intentHash !== reviewed.intentHash ||
      checkpoint.originalRevision !== reviewed.target.expectedRevision ||
      checkpoint.appliedRevision !== next.target.expectedRevision ||
      next.status !== "awaiting_input" ||
      !next.evidenceRefs.includes(
        `provider_profile:${checkpoint.providerId}:settings_revision:${checkpoint.appliedRevision}`,
      )
    )
      throw new Error("The response did not confirm the reviewed provider profile commit.");
  }
}

/** Shared by the existing provider editor and cockpit; the Gateway owns application. */
export async function confirmReviewedSettingsPlan(plan: ChangePlanRecord): Promise<ChangePlanRecord> {
  const action = plan.requiredAction;
  if (action?.kind !== "confirmation" || !action.actionNonce) throw new Error("Review the current confirmation first.");
  const next = await confirmChangePlan(plan.planId, context(plan), {
    expectedRevision: plan.revision,
    actionNonce: action.actionNonce,
  });
  assertSettingsPlanResponse(plan, next);
  return next;
}

export async function submitReviewedProviderCredential(
  plan: ChangePlanRecord,
  apiKey: string,
): Promise<ChangePlanRecord> {
  const action = plan.requiredAction;
  if (
    plan.request.kind !== "provider_connection" ||
    action?.kind !== "secure_input" ||
    action.targetId !== plan.request.providerId ||
    !action.actionNonce ||
    !apiKey.trim()
  ) {
    throw new Error("Refresh the provider's secure credential instructions before continuing.");
  }
  const next = await submitChangePlanProviderSecret(plan.planId, context(plan), {
    expectedRevision: plan.revision,
    actionId: action.actionId,
    actionNonce: action.actionNonce,
    apiKey,
  });
  assertSettingsPlanResponse(plan, next);
  return next;
}
