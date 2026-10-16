import { fetchLlmConfig, fetchProviderSecretStatus } from "@goatcitadel/mission-control-shared/api/client";
import type { ProviderConnectionAttempt } from "./provider-connection-state";

/**
 * Reads the saved provider and credential storage after a completed change and throws unless both confirm what the
 * reviewed request asked for. Returns the current LLM config so the caller can accept the saved endpoint.
 */
export async function confirmSavedProviderConnection(providerId: string, next: ProviderConnectionAttempt) {
  const current = await fetchLlmConfig();
  const saved = current.providers.find((item) => item.providerId === providerId);
  if (
    !Number.isSafeInteger(current.revision) ||
    current.revision <= next.baseRevision ||
    !saved ||
    (next.request.profile?.baseUrl && saved.baseUrl !== next.request.profile.baseUrl)
  ) {
    throw new Error("The current provider does not confirm the completed change.");
  }
  if (next.request.credentialAction === "replace_api_key") {
    const status = await fetchProviderSecretStatus(providerId);
    const storage = next.request.credentialStorage ?? "keychain";
    if (
      status.providerId !== providerId ||
      !status.hasSecret ||
      status.source !== storage ||
      saved.apiKeySource !== storage ||
      (storage === "env" && saved.apiKeyRef !== next.request.credentialEnvVar)
    ) {
      throw new Error("Credential storage has not confirmed the selected location.");
    }
  }
  return current;
}
