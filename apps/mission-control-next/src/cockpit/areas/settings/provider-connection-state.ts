import { useSyncExternalStore } from "react";
import { canonicalJsonString, isChangePlanRequest, isChangePlanStatus, type ChangePlanProviderConnectionRequest, type ChangePlanRecord } from "@goatcitadel/contracts";

export interface ProviderConnectionAttempt {
  request: ChangePlanProviderConnectionRequest;
  baseRevision: number;
  plan?: ChangePlanRecord;
  busy: boolean;
  uncertain: boolean;
  verified?: boolean;
  message: string;
}

// Only public intent and owner receipts survive navigation in this app session.
// Credentials are owned by the existing secure-input dialog and never enter this map.
const attempts = new Map<string, ProviderConnectionAttempt>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useProviderConnectionAttempt(providerId: string) {
  return useSyncExternalStore(subscribe, () => attempts.get(providerId), () => undefined);
}
export function readProviderConnectionAttempt(providerId: string) { return attempts.get(providerId); }
export function setProviderConnectionAttempt(providerId: string, attempt: ProviderConnectionAttempt | undefined) {
  if (attempt) attempts.set(providerId, attempt); else attempts.delete(providerId);
  for (const listener of listeners) listener();
}
export function __resetProviderConnectionAttemptsForTests() {
  attempts.clear(); for (const listener of listeners) listener();
}

export const connectionPlanCompleted = (plan?: ChangePlanRecord) => plan?.status === "completed" || plan?.status === "applied";
export const connectionPlanStopped = (plan?: ChangePlanRecord) => Boolean(plan && ["failed", "cancelled", "rolled_back", "manual_required", "rollback_failed"].includes(plan.status));

export function matchesConnectionAttempt(plan: ChangePlanRecord, attempt: Pick<ProviderConnectionAttempt, "request" | "baseRevision" | "plan">): boolean {
  return Boolean(plan?.planId && Number.isSafeInteger(plan.revision) && plan.revision > 0 && isChangePlanStatus(plan.status)
    && plan.kind === "provider_connection" && plan.request.kind === "provider_connection"
    && plan.origin.workspaceId === "default" && plan.origin.surface === "settings" && !plan.origin.sessionId && !plan.origin.turnId
    && plan.target.ownerId === "provider_connection" && plan.target.resourceId === attempt.request.providerId
    && Number.isSafeInteger(plan.target.expectedRevision)
    && (attempt.plan
      ? plan.planId === attempt.plan.planId && plan.revision >= attempt.plan.revision
        && plan.target.expectedRevision! >= (attempt.plan.target.expectedRevision ?? attempt.baseRevision)
      : plan.target.expectedRevision === attempt.baseRevision)
    && canonicalJsonString(plan.request) === canonicalJsonString(attempt.request));
}

export function providerEndpointRequest(providerId: string, baseUrl: string): ChangePlanProviderConnectionRequest | null {
  const request: ChangePlanProviderConnectionRequest = { kind: "provider_connection", providerId, profile: { baseUrl: baseUrl.trim() } };
  // The contract rejects credentials, query strings, and fragments in public URLs.
  return isChangePlanRequest(request) ? request : null;
}

export function providerCredentialRequest(providerId: string, storage: "keychain" | "env", envVar: string): ChangePlanProviderConnectionRequest | null {
  const request: ChangePlanProviderConnectionRequest = { kind: "provider_connection", providerId, credentialAction: "replace_api_key",
    credentialStorage: storage, ...(storage === "env" ? { credentialEnvVar: envVar.trim() } : {}) };
  return isChangePlanRequest(request) ? request : null;
}

export function canReviewConnectionPlan(plan: ChangePlanRecord): boolean {
  const expiry = plan.requiredAction?.kind === "secure_input" ? plan.requiredAction.expiresAt : plan.expiresAt;
  return (!expiry || (Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) > Date.now()))
    && ((plan.status === "awaiting_confirmation" && plan.requiredAction?.kind === "confirmation")
      || (plan.status === "awaiting_input" && plan.requiredAction?.kind === "secure_input"));
}
