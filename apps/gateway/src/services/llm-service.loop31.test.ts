import { describe, expect, it } from "vitest";
import type { LlmConfigFile } from "@goatcitadel/contracts";
import { LlmService } from "./llm-service.js";

describe("LlmService loop31 provider URL hardening", () => {
  it("blocks local-domain provider calls while preserving explicit IPv6 loopback support", () => {
    const blocked: LlmConfigFile = {
      activeProviderId: "local-domain",
      providers: [
        {
          providerId: "local-domain",
          label: "Local Domain",
          baseUrl: "https://provider.local/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "test-model",
          apiKey: "test-key",
        },
      ],
    };

    expect(() => new LlmService(blocked, process.env, { secretStore: createNoopSecretStore() })).toThrow(
      /local network domain/,
    );

    const local: LlmConfigFile = {
      activeProviderId: "local-ipv6",
      providers: [
        {
          providerId: "local-ipv6",
          label: "Local IPv6",
          baseUrl: "http://[::1]:1234/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "local-model",
        },
      ],
    };

    expect(
      new LlmService(local, process.env, { secretStore: createNoopSecretStore() }).getRuntimeConfig(),
    ).toMatchObject({
      activeProviderId: "local-ipv6",
      activeModel: "local-model",
    });
  });
});

function createNoopSecretStore() {
  return {
    getProviderApiKey: () => undefined,
    setProviderApiKey: () => undefined,
    deleteProviderApiKey: () => undefined,
    getStatus: () => ({ available: false }),
  };
}
