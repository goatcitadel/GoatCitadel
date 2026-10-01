import { canonicalJsonString } from "@goatcitadel/contracts";
import type { LlmRuntimeConfigResponse } from "@goatcitadel/mission-control-shared/api/client";
import { draftFromRequestConfig } from "@goatcitadel/mission-control-shared/components/LlmTransportFields";
import { matchesProviderSave, providerSaveInput, type ProviderSaveDraft } from "./provider-save-contract";

/** Hidden header values are acknowledged by the exact CAS command owner, never read back to this client. */
export function matchesProviderTransportReceipt(
  response: LlmRuntimeConfigResponse,
  current: LlmRuntimeConfigResponse,
  submitted: ProviderSaveDraft,
  expectedRevision: number,
): boolean {
  const input = providerSaveInput(submitted);
  const receipt = response.providerTransportReceipt;
  const saved = current.providerConfigs?.find((item) => item.providerId === input.providerId);
  const { headers, ...publicRequest } = input.request ?? {};
  const acceptedNames = [...new Set(Object.keys(headers ?? {}).map((name) => name.trim()).filter(Boolean))].sort();
  return Boolean(receipt && saved &&
    receipt.version === "llm.provider_transport_receipt.v1" && receipt.providerId === input.providerId &&
    receipt.expectedRevision === expectedRevision && receipt.appliedRevision === expectedRevision + 1 &&
    response.revision === receipt.appliedRevision && current.revision === receipt.appliedRevision &&
    canonicalJsonString(receipt.acceptedHeaderNames) === canonicalJsonString(acceptedNames) &&
    canonicalJsonString(receipt.publicRequest ?? null) === canonicalJsonString(saved.request ?? null) &&
    matchesProviderSave(current, { ...submitted, transport: draftFromRequestConfig(publicRequest) }));
}
