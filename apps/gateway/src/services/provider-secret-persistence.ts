import { deleteLocalEnvVar, upsertLocalEnvVar } from "../env-file.js";
import { isSecretStoreUnavailableLikeError } from "./secret-store-service.js";

type ProviderSecretSource = "none" | "keychain" | "env" | "inline";

interface ProviderRuntimeSummary {
  providerId: string;
  apiKeyRef?: string;
}

interface ProviderSecretStatus {
  providerId: string;
  hasApiKey: boolean;
  apiKeySource: ProviderSecretSource;
}

interface ProviderSecretPersistenceService {
  setProviderApiKey(providerId: string, apiKey: string): void;
  deleteProviderApiKey(providerId: string): void;
  getProviderSecretStatus(providerId: string): ProviderSecretStatus;
  getRuntimeConfig(): { providers: ProviderRuntimeSummary[] };
}

interface PersistProviderApiKeyInput {
  providerId: string;
  apiKey: string;
  rootDir: string;
  llmService: ProviderSecretPersistenceService;
  env?: NodeJS.ProcessEnv;
  preferredEnvVar?: string;
  persistToEnv?: boolean;
  allowEnvFallback?: boolean;
}

interface DeleteProviderApiKeyInput {
  providerId: string;
  rootDir: string;
  llmService: ProviderSecretPersistenceService;
  env?: NodeJS.ProcessEnv;
}

export function persistProviderApiKeyWithFallback(input: PersistProviderApiKeyInput): {
  providerId: string;
  hasSecret: boolean;
  source: ProviderSecretSource;
} {
  if (!input.persistToEnv) {
    try {
      input.llmService.setProviderApiKey(input.providerId, input.apiKey);
      const status = input.llmService.getProviderSecretStatus(input.providerId);
      return {
        providerId: status.providerId,
        hasSecret: status.hasApiKey,
        source: status.apiKeySource,
      };
    } catch (error) {
      if (!isKeychainUnavailableError(error)) {
        throw error;
      }
      // The keychain is unavailable. Only downgrade to a plaintext .env file when the
      // operator has explicitly opted in — never silently write secrets to disk.
      if (!isEnvFallbackAllowed(input)) {
        throw new Error(
          `Secure keychain is unavailable on this host and writing the secret for provider ${input.providerId} ` +
            "to a plaintext .env file is disabled. Set GOATCITADEL_ALLOW_ENV_SECRET_FALLBACK=1 " +
            "(or pass allowEnvFallback) to opt in to env-backed secrets.",
          { cause: error },
        );
      }
    }
  }

  const envVar = resolveProviderEnvVar(input.llmService, input.providerId, input.preferredEnvVar);
  if (!envVar) {
    throw new Error(
      `Secure keychain is unavailable on this host, and no env var is configured for provider ${input.providerId}.`,
    );
  }

  return persistProviderApiKeyToEnv(input.providerId, envVar, input.apiKey, input.rootDir, input.env);
}

export function deleteProviderApiKeyWithFallback(input: DeleteProviderApiKeyInput): {
  providerId: string;
  hasSecret: boolean;
  source: ProviderSecretSource;
} {
  const status = input.llmService.getProviderSecretStatus(input.providerId);
  if (status.apiKeySource === "env") {
    const envVar = resolveProviderEnvVar(input.llmService, input.providerId);
    if (envVar) {
      delete (input.env ?? process.env)[envVar];
      deleteLocalEnvVar(envVar, { rootDir: input.rootDir });
    }
    return {
      providerId: input.providerId,
      hasSecret: false,
      source: "none",
    };
  }

  input.llmService.deleteProviderApiKey(input.providerId);
  const nextStatus = input.llmService.getProviderSecretStatus(input.providerId);
  return {
    providerId: nextStatus.providerId,
    hasSecret: nextStatus.hasApiKey,
    source: nextStatus.apiKeySource,
  };
}

function resolveProviderEnvVar(
  llmService: ProviderSecretPersistenceService,
  providerId: string,
  preferredEnvVar?: string,
): string | undefined {
  const preferred = preferredEnvVar?.trim();
  if (preferred) {
    return preferred;
  }
  const provider = llmService.getRuntimeConfig().providers.find((entry) => entry.providerId === providerId);
  const ref = provider?.apiKeyRef?.trim();
  if (!ref || ref.startsWith("keychain:")) {
    return undefined;
  }
  return ref;
}

function isKeychainUnavailableError(error: unknown): boolean {
  return isSecretStoreUnavailableLikeError(error);
}

function isEnvFallbackAllowed(input: PersistProviderApiKeyInput): boolean {
  if (typeof input.allowEnvFallback === "boolean") {
    return input.allowEnvFallback;
  }
  const flag = (input.env ?? process.env).GOATCITADEL_ALLOW_ENV_SECRET_FALLBACK?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

function persistProviderApiKeyToEnv(
  providerId: string,
  envVar: string,
  apiKey: string,
  rootDir: string,
  env?: NodeJS.ProcessEnv,
): {
  providerId: string;
  hasSecret: boolean;
  source: ProviderSecretSource;
} {
  const writeResult = upsertLocalEnvVar(envVar, apiKey, { rootDir });
  if (!writeResult.updated) {
    throw new Error(
      `Secure keychain is unavailable on this host, and GoatCitadel could not persist ${envVar} to the local .env file.`,
    );
  }

  (env ?? process.env)[envVar] = apiKey;
  return {
    providerId,
    hasSecret: true,
    source: "env",
  };
}
