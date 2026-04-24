import type { LlmConfigFile, LlmProviderConfig } from "@goatcitadel/contracts";
import { LlmService } from "../services/llm-service.js";
import { SecretStoreService } from "../services/secret-store-service.js";

export function createNoopSecretStore(): SecretStoreService {
  return {
    isAvailable: () => false,
    setProviderApiKey: () => undefined,
    getProviderApiKey: () => undefined,
    deleteProviderApiKey: () => undefined,
    setSecret: () => undefined,
    getSecret: () => undefined,
    deleteSecret: () => undefined,
    status: (providerId: string) => ({ providerId, hasSecret: false, source: "none" }),
  } as unknown as SecretStoreService;
}

export interface OpenAiCompatibleLlmServiceOptions {
  providerId?: string;
  label?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  provider?: Partial<LlmProviderConfig>;
}

export function createOpenAiCompatibleLlmService(
  baseUrl: string,
  options: OpenAiCompatibleLlmServiceOptions = {},
): LlmService {
  const providerId = options.providerId ?? "fake-openai";
  const model = options.model ?? "fake-chat";
  const provider: LlmProviderConfig = {
    providerId,
    label: options.label ?? "Fake OpenAI",
    baseUrl,
    apiStyle: "openai-chat-completions",
    defaultModel: model,
    apiKeyEnv: options.apiKeyEnv,
    headers: options.headers,
    ...options.provider,
  };
  const config: LlmConfigFile = {
    activeProviderId: providerId,
    activeModel: model,
    providers: [provider],
  };

  return new LlmService(config, options.env ?? {}, {
    secretStore: createNoopSecretStore(),
  });
}
