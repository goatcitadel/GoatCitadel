import { NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import type { LlmService } from "./llm-service.js";

export interface ProviderReadinessDependencies {
  getSettings(): Promise<Pick<RuntimeSettings, "llm">>;
  listModelsWithSource: LlmService["listModelsWithSource"];
}

export interface TemporaryProviderReadinessDependencies {
  readSecret(): string | undefined;
  exportConfigFile: LlmService["exportConfigFile"];
  previewModels: LlmService["previewModels"];
}

/** Uses staged custody for a catalog probe only. It never promotes the secret
 * or claims a successful inference from a successful catalog response. */
export async function verifyTemporaryProviderCredential(
  dependencies: TemporaryProviderReadinessDependencies, providerId: string,
): Promise<readonly string[]> {
  const secret = dependencies.readSecret();
  if (!secret?.trim()) throw new ValidationError({ message: "Temporary provider credential is unavailable." });
  const provider = dependencies.exportConfigFile().providers.find(candidate => candidate.providerId === providerId);
  if (!provider) throw new NotFoundError({ entity: "LLM provider", id: providerId });
  const preview = await dependencies.previewModels({ providerId, baseUrl: provider.baseUrl,
    apiStyle: provider.apiStyle, apiKey: secret, ...(provider.request ? { request: provider.request } : {}) });
  if (preview.source !== "live" || preview.items.length === 0)
    throw new ValidationError({ message: `Unable to verify ${providerId} against its live model catalog.` });
  return [`provider:${providerId}:temporary_credential_validated`];
}

/** Connection evidence proves authentication/catalog access, never a completed inference. */
export async function verifyProviderConnection(
  dependencies: ProviderReadinessDependencies,
  providerId: string,
): Promise<{ evidenceRefs: readonly string[] }> {
  const settings = await dependencies.getSettings();
  const provider = settings.llm.providers.find((candidate) => candidate.providerId === providerId);
  if (!provider) throw new NotFoundError({ entity: "LLM provider", id: providerId });
  const ready = provider.authReadiness
    ? ["configured", "ready"].includes(provider.authReadiness.status)
    : provider.hasApiKey || provider.oauthStatus?.connected === true || provider.authMode === "google-adc";
  if (!ready) throw new ValidationError({ message: `${provider.label} is not connected.` });
  const catalog = await dependencies.listModelsWithSource(providerId);
  if (catalog.items.length === 0 || (catalog.source !== "live" && provider.authMode !== "codex-oauth")) {
    throw new ValidationError({ message: `${provider.label} did not return a verifiable model catalog.` });
  }
  return {
    evidenceRefs: [
      `provider:${providerId}:auth_ready`,
      `provider:${providerId}:catalog:${catalog.source}:${catalog.items.length}`,
    ],
  };
}
