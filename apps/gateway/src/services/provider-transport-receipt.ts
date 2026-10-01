import type { LlmProviderTransportReceipt } from "@goatcitadel/contracts";
import type { GatewayRouteCompositionPort } from "./gateway-route-composition-port.js";
import type { UpdateSettingsInput } from "./settings-auth-service.js";
import { matchesAppliedProviderTransport } from "./llm-service.js";

type Input = NonNullable<UpdateSettingsInput["llm"]> & { expectedRevision: number };
type Owner = Pick<GatewayRouteCompositionPort, "updateSettings" | "readSettingsRevision" | "llmService">;

/** Attests only an exact transport-only CAS command after the raw owner confirms it. */
export async function updateLlmConfigWithTransportReceipt(owner: Owner, input: Input) {
  const { expectedRevision, ...llm } = input;
  const updated = await owner.updateSettings({ expectedRevision, llm });
  const response = { revision: updated.revision, ...updated.llm };
  const upsert = llm.upsertProvider;
  if (!upsert?.request || Object.keys(llm).some((key) => key !== "upsertProvider") ||
    Object.keys(upsert).some((key) => key !== "providerId" && key !== "request")) return response;

  // The update may have committed even if concurrent activity prevents this receipt.
  // Omit the attestation on mismatch; clients must retain an uncertain outcome.
  if (updated.revision !== expectedRevision + 1 || owner.readSettingsRevision() !== updated.revision) return response;
  const provider = owner.llmService.snapshotRuntimeConfigForPersistence().providers
    .find((item) => item.providerId === upsert.providerId);
  if (!provider || !matchesAppliedProviderTransport(provider.request, upsert.request)) return response;
  const publicProvider = owner.llmService.exportConfigFile().providers
    .find((item) => item.providerId === upsert.providerId);
  if (!publicProvider || owner.readSettingsRevision() !== updated.revision) return response;
  const providerTransportReceipt: LlmProviderTransportReceipt = {
    version: "llm.provider_transport_receipt.v1",
    providerId: upsert.providerId,
    expectedRevision,
    appliedRevision: updated.revision,
    acceptedHeaderNames: [...new Set(Object.keys(upsert.request.headers ?? {}).map((name) => name.trim()).filter(Boolean))].sort(),
    publicRequest: publicProvider.request,
  };
  return { ...response, providerTransportReceipt };
}
