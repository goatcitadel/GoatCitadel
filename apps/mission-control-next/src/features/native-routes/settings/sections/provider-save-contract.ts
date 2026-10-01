import {
  canonicalJsonString,
  isProviderProfileCheckpoint,
  type ChangePlanRecord,
  type ChangePlanProviderConnectionRequest,
} from "@goatcitadel/contracts";
import type { LlmRuntimeConfigResponse, patchSettings } from "@goatcitadel/mission-control-shared/api/client";
import {
  requestConfigFromDraft,
  type LlmTransportDraft,
} from "@goatcitadel/mission-control-shared/components/LlmTransportFields";
import { type ProviderEditorDraft } from "../helpers/provider-drafts";
export type ProviderSaveDraft = {
  provider: ProviderEditorDraft;
  transport: LlmTransportDraft;
  credentialStorage?: "keychain" | "env";
  governedCreation?: boolean;
};
type ProviderInput = NonNullable<NonNullable<Parameters<typeof patchSettings>[0]["llm"]>["upsertProvider"]>;
export function providerSaveInput({ provider: draft, transport }: ProviderSaveDraft): ProviderInput {
  const codex = draft.providerId.trim().toLowerCase() === "openai-codex" || draft.authMode === "codex-oauth";
  const google = draft.authMode === "google-adc" || draft.authMode === "google-service-account";
  return {
    providerId: draft.providerId.trim(),
    label: draft.label.trim() || undefined,
    baseUrl: draft.baseUrl.trim(),
    apiStyle: draft.apiStyle,
    authMode: codex ? "codex-oauth" : draft.authMode || undefined,
    defaultModel: draft.defaultModel.trim() || undefined,
    apiKeyEnv: codex || draft.authMode === "google-adc" ? undefined : draft.apiKeyEnv.trim() || undefined,
    googleCloud: google
      ? {
          projectId: draft.googleProjectId.trim() || undefined,
          projectIdEnv: draft.googleProjectIdEnv.trim() || undefined,
          location: draft.googleLocation.trim() || undefined,
          locationEnv: draft.googleLocationEnv.trim() || undefined,
          endpointId: draft.googleEndpointId.trim() || undefined,
        }
      : undefined,
    request: requestConfigFromDraft(transport),
  };
}
function containsFields(actual: unknown, requested: unknown): boolean {
  if (requested === undefined) return true;
  if (requested === null || typeof requested !== "object") return actual === requested;
  if (Array.isArray(requested))
    return (
      Array.isArray(actual) &&
      requested.length === actual.length &&
      requested.every((value, index) => containsFields(actual[index], value))
    );
  return Boolean(
    actual &&
    typeof actual === "object" &&
    Object.entries(requested).every(([key, value]) => containsFields((actual as Record<string, unknown>)[key], value)),
  );
}
export function matchesProviderSave(config: LlmRuntimeConfigResponse, submitted: ProviderSaveDraft): boolean {
  const requested = providerSaveInput(submitted);
  const actual = config.providerConfigs?.find((item) => item.providerId === requested.providerId);
  return Boolean(actual && containsFields(actual, requested));
}
export function matchesProviderSavePlan(plan: ChangePlanRecord, submitted: ProviderSaveDraft): boolean {
  const { providerId, request: _unchangedTransport, ...profile } = providerSaveInput(submitted);
  // A public-profile plan retains the saved transport. Transport edits never enter this receipt path.
  return (
    plan.request.kind === "provider_connection" &&
    plan.request.providerId === providerId &&
    plan.target.ownerId === "provider_connection" &&
    plan.target.resourceId === providerId &&
    canonicalJsonString(plan.request) ===
      canonicalJsonString(
        submitted.governedCreation
          ? providerProfilePlanRequest(submitted)
          : { kind: "provider_connection", providerId, profile },
      )
  );
}

export function providerProfilePlanRequest(submitted: ProviderSaveDraft): ChangePlanProviderConnectionRequest {
  const { providerId, request: _transport, ...profile } = providerSaveInput(submitted);
  const oauth = profile.authMode === "codex-oauth" || providerId === "openai-codex";
  const credentialStorage = submitted.credentialStorage ?? "keychain";
  if (!oauth && credentialStorage === "env" && !/^[A-Z_][A-Z0-9_]*$/u.test(profile.apiKeyEnv ?? ""))
    throw new Error("Choose a valid API key environment variable before reviewing plaintext credential storage.");
  return {
    kind: "provider_connection",
    providerId,
    profile,
    ...(!oauth
      ? {
          credentialStorage,
          ...(credentialStorage === "env" ? { credentialEnvVar: profile.apiKeyEnv } : {}),
        }
      : {}),
  };
}

export function matchesProviderTargetRevision(
  plan: ChangePlanRecord,
  submitted: ProviderSaveDraft,
  baseRevision: number,
): boolean {
  if (plan.origin.sessionId || plan.origin.turnId || !matchesProviderSavePlan(plan, submitted)) return false;
  const checkpoint = plan.result?.providerProfileCheckpoint;
  if (!checkpoint) return plan.target.expectedRevision === baseRevision;
  return (
    isProviderProfileCheckpoint(checkpoint) &&
    checkpoint.providerId === submitted.provider.providerId.trim() &&
    checkpoint.intentHash === plan.intentHash &&
    checkpoint.originalRevision === baseRevision &&
    checkpoint.appliedRevision === plan.target.expectedRevision &&
    plan.evidenceRefs.includes(
      `provider_profile:${checkpoint.providerId}:settings_revision:${checkpoint.appliedRevision}`,
    )
  );
}
