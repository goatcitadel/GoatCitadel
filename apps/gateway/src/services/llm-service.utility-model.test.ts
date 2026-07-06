import { describe, expect, it } from "vitest";
import { LlmService } from "./llm-service.js";
import type { SecretStoreService } from "./secret-store-service.js";

function createNoopSecretStore(): SecretStoreService {
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

const PROVIDERS = [
  {
    providerId: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    apiStyle: "anthropic-messages" as const,
    defaultModel: "claude-sonnet-5",
  },
  {
    providerId: "glm",
    label: "GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiStyle: "openai-chat-completions" as const,
    defaultModel: "glm-5",
  },
];

function createService(config: { utilityProviderId?: string; utilityModel?: string } = {}) {
  return new LlmService(
    {
      activeProviderId: "anthropic",
      activeModel: "claude-sonnet-5",
      providers: PROVIDERS,
      ...config,
    },
    {},
    { secretStore: createNoopSecretStore() },
  );
}

describe("LlmService utility-model slot", () => {
  it("loads the utility slot from config and exposes it in runtime config", () => {
    const service = createService({ utilityProviderId: "glm", utilityModel: "glm-4-flash" });
    const runtime = service.getRuntimeConfig();
    expect(runtime.utilityProviderId).toBe("glm");
    expect(runtime.utilityModel).toBe("glm-4-flash");
  });

  it("omits the utility slot when unset", () => {
    const runtime = createService().getRuntimeConfig();
    expect(runtime.utilityProviderId).toBeUndefined();
    expect(runtime.utilityModel).toBeUndefined();
  });

  it("ignores a configured utility provider that is not in the provider list", () => {
    const runtime = createService({ utilityProviderId: "missing", utilityModel: "x" }).getRuntimeConfig();
    expect(runtime.utilityProviderId).toBeUndefined();
    expect(runtime.utilityModel).toBeUndefined();
  });

  it("sets and clears the utility slot through updateRuntimeConfig", () => {
    const service = createService();
    const updated = service.updateRuntimeConfig({ utilityProviderId: "glm", utilityModel: "glm-4-flash" });
    expect(updated.utilityProviderId).toBe("glm");
    expect(updated.utilityModel).toBe("glm-4-flash");

    const cleared = service.updateRuntimeConfig({ utilityProviderId: "" });
    expect(cleared.utilityProviderId).toBeUndefined();
    expect(cleared.utilityModel).toBeUndefined();
  });

  it("rejects an unknown utility provider in updateRuntimeConfig", () => {
    const service = createService();
    expect(() => service.updateRuntimeConfig({ utilityProviderId: "nope" })).toThrow(/Unknown LLM provider: nope/);
  });

  it("rejects a utility model without a utility provider", () => {
    const service = createService();
    expect(() => service.updateRuntimeConfig({ utilityModel: "glm-4-flash" })).toThrow(/Select a utility LLM provider/);
  });

  it("round-trips the utility slot through exportConfigFile", () => {
    const service = createService({ utilityProviderId: "glm", utilityModel: "glm-4-flash" });
    const exported = service.exportConfigFile();
    expect(exported.utilityProviderId).toBe("glm");
    expect(exported.utilityModel).toBe("glm-4-flash");

    const rehydrated = new LlmService(exported, {}, { secretStore: createNoopSecretStore() });
    const runtime = rehydrated.getRuntimeConfig();
    expect(runtime.utilityProviderId).toBe("glm");
    expect(runtime.utilityModel).toBe("glm-4-flash");
  });
});
