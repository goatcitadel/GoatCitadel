import { isProviderProfileCheckpoint, type ChangePlanRecord } from "@goatcitadel/contracts";
import type { ChangePlanRepositoryTransitionInput } from "./change-plan-repo.js";

/** This exception is only for an adapter-acknowledged partial commit, never generic retry authority. */
export function isProviderProfileInputCheckpoint(
  current: ChangePlanRecord,
  input: ChangePlanRepositoryTransitionInput,
): boolean {
  const checkpoint = input.result?.providerProfileCheckpoint;
  const action = input.requiredAction;
  return (
    input.internal === true &&
    current.status === "applying" &&
    input.status === "awaiting_input" &&
    current.adapter.adapterId === "provider-connection" &&
    current.kind === "provider_connection" &&
    current.request.kind === "provider_connection" &&
    Boolean(current.request.profile) &&
    !current.request.credentialAction &&
    current.target.ownerId === "provider_connection" &&
    current.target.resourceId === current.request.providerId &&
    isProviderProfileCheckpoint(checkpoint) &&
    checkpoint.providerId === current.request.providerId &&
    checkpoint.intentHash === current.intentHash &&
    checkpoint.originalRevision === current.target.expectedRevision &&
    checkpoint.appliedRevision === input.target?.expectedRevision &&
    input.result?.appliedRevision === checkpoint.appliedRevision &&
    input.target?.ownerId === current.target.ownerId &&
    input.target.resourceId === current.target.resourceId &&
    !current.result?.providerProfileCheckpoint &&
    (action?.kind === "secure_input" || action?.kind === "oauth") &&
    action.targetId === checkpoint.providerId &&
    Boolean(action.actionId && action.actionNonce) &&
    Boolean(
      input.evidenceRefs?.includes(
        `provider_profile:${checkpoint.providerId}:settings_revision:${checkpoint.appliedRevision}`,
      ),
    )
  );
}
