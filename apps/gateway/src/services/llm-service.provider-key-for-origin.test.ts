import { describe, expect, it } from "vitest";
import type { LlmConfigFile } from "@goatcitadel/contracts";
import { LlmService } from "./llm-service.js";
import { SecretStoreService } from "./secret-store-service.js";

function createSecretStore(keys: Record<string, string>): SecretStoreService {
  return {
    isAvailable: () => true,
    setProviderApiKey: () => undefined,
    getProviderApiKey: (providerId: string) => keys[providerId],
    deleteProviderApiKey: () => undefined,
    setSecret: () => undefined,
    getSecret: () => undefined,
    deleteSecret: () => undefined,
    status: (providerId: string) => ({ providerId, hasSecret: Boolean(keys[providerId]), source: "keychain" }),
  } as unknown as SecretStoreService;
}

function buildOpenAIConfig(baseUrl: string): LlmConfigFile {
  return {
    activeProviderId: "openai",
    activeModel: "gpt-5.4",
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl,
        apiStyle: "openai-responses",
        defaultModel: "gpt-5.4",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    ],
  };
}

const OPENAI_ORIGIN = "https://api.openai.com";

describe("LlmService.resolveProviderApiKeyForOrigin", () => {
  it("returns the keychain key when the provider points at the requested origin", () => {
    const service = new LlmService(
      buildOpenAIConfig("https://api.openai.com/v1"),
      { OPENAI_API_KEY: "sk-env" },
      { secretStore: createSecretStore({ openai: "sk-keychain" }) },
    );
    expect(service.resolveProviderApiKeyForOrigin("openai", OPENAI_ORIGIN)).toBe("sk-keychain");
  });

  it("falls back to the provider's env var when the keychain has no key", () => {
    const service = new LlmService(
      buildOpenAIConfig("https://api.openai.com/v1"),
      { OPENAI_API_KEY: "sk-env" },
      { secretStore: createSecretStore({}) },
    );
    expect(service.resolveProviderApiKeyForOrigin("openai", OPENAI_ORIGIN)).toBe("sk-env");
  });

  it("withholds the key when the provider points at another endpoint", () => {
    const service = new LlmService(
      buildOpenAIConfig("https://proxy.example.test/v1"),
      { OPENAI_API_KEY: "sk-env" },
      { secretStore: createSecretStore({ openai: "sk-proxy" }) },
    );
    expect(service.resolveProviderApiKeyForOrigin("openai", OPENAI_ORIGIN)).toBeUndefined();
  });

  it("returns nothing for an unknown provider", () => {
    const service = new LlmService(
      buildOpenAIConfig("https://api.openai.com/v1"),
      {},
      { secretStore: createSecretStore({ openai: "sk-keychain" }) },
    );
    expect(service.resolveProviderApiKeyForOrigin("missing", OPENAI_ORIGIN)).toBeUndefined();
  });
});
