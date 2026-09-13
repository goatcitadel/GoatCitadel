import type { ChangePlanRecord } from "@goatcitadel/contracts";
import type { LlmRuntimeConfigResponse, patchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { requestConfigFromDraft, type LlmTransportDraft } from "@goatcitadel/mission-control-shared/components/LlmTransportFields";
import type { ProviderEditorDraft } from "../../SettingsNativePage";
export type ProviderSaveDraft = { provider: ProviderEditorDraft; transport: LlmTransportDraft };
type ProviderInput = NonNullable<NonNullable<Parameters<typeof patchSettings>[0]["llm"]>["upsertProvider"]>;
export function providerSaveInput({ provider: draft, transport }: ProviderSaveDraft): ProviderInput {
  const codex = draft.providerId.trim().toLowerCase() === "openai-codex" || draft.authMode === "codex-oauth";
  const google = draft.authMode === "google-adc" || draft.authMode === "google-service-account";
  return {
    providerId: draft.providerId.trim(), label: draft.label.trim() || undefined, baseUrl: draft.baseUrl.trim(),
    apiStyle: draft.apiStyle, authMode: codex ? "codex-oauth" : draft.authMode || undefined,
    defaultModel: draft.defaultModel.trim() || undefined,
    apiKeyEnv: codex || draft.authMode === "google-adc" ? undefined : draft.apiKeyEnv.trim() || undefined,
    googleCloud: google ? { projectId: draft.googleProjectId.trim() || undefined, projectIdEnv: draft.googleProjectIdEnv.trim() || undefined,
      location: draft.googleLocation.trim() || undefined, locationEnv: draft.googleLocationEnv.trim() || undefined,
      endpointId: draft.googleEndpointId.trim() || undefined } : undefined,
    request: requestConfigFromDraft(transport),
  };
}
function containsFields(actual: unknown, requested: unknown): boolean {
  if (requested === undefined) return true;
  if (requested === null || typeof requested !== "object") return actual === requested;
  if (Array.isArray(requested)) return Array.isArray(actual) && requested.length === actual.length && requested.every((value, index) => containsFields(actual[index], value));
  return Boolean(actual && typeof actual === "object" && Object.entries(requested).every(([key, value]) => containsFields((actual as Record<string, unknown>)[key], value)));
}
export function matchesProviderSave(config: LlmRuntimeConfigResponse, submitted: ProviderSaveDraft): boolean {
  const requested = providerSaveInput(submitted);
  const actual = config.providerConfigs?.find((item) => item.providerId === requested.providerId);
  return Boolean(actual && containsFields(actual, requested));
}
export function matchesProviderSavePlan(plan: ChangePlanRecord, submitted: ProviderSaveDraft): boolean {
  const { providerId, request: _transport, ...profile } = providerSaveInput(submitted);
  return plan.request.kind === "provider_connection" && plan.request.providerId === providerId &&
    plan.target.ownerId === "provider_connection" && plan.target.resourceId === providerId &&
    containsFields(plan.request.profile, profile);
}
