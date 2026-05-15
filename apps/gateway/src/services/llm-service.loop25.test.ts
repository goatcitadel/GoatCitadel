import { describe, expect, it, vi } from "vitest";
import type { LlmConfigFile } from "@goatcitadel/contracts";
import { LlmService } from "./llm-service.js";
import { SecretStoreService } from "./secret-store-service.js";

describe("LlmService loop25 fallback and host checks", () => {
  it("allows IPv6 local runtime URLs but blocks reserved IPv4 provider hosts", async () => {
    expect(createService("http://[::1]:1234/v1").getRuntimeConfig()).toMatchObject({
      activeProviderId: "openai",
      activeModel: "gpt-5.4-mini",
    });
    await expect(createService("http://[fd00::1]:1234/v1").listModelsWithSource("openai")).resolves.toMatchObject({
      source: "error_fallback",
      warning: expect.any(String),
      items: expect.arrayContaining([expect.objectContaining({ id: "gpt-5.4-mini" })]),
    });
    expect(() => createService("http://224.0.0.1:1234/v1")).toThrow(/private\/reserved IPv4/);
  });

  it("falls back to the provider template when model listing returns an empty catalog", async () => {
    const service = createService("https://api.openai.com/v1");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    try {
      await expect(service.listModelsWithSource("openai")).resolves.toMatchObject({
        source: "template_fallback",
        warning: "Provider returned no models. Falling back to GoatCitadel's provider template.",
        items: expect.arrayContaining([expect.objectContaining({ id: "gpt-5.4-mini" })]),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back on model listing HTTP errors while preserving the active runtime selection", async () => {
    const service = createService("https://api.openai.com/v1");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    try {
      await expect(service.listModelsWithSource("openai")).resolves.toMatchObject({
        source: "error_fallback",
        warning: expect.stringContaining("model listing failed (429"),
        items: expect.arrayContaining([expect.objectContaining({ id: "gpt-5.4-mini" })]),
      });
      expect(service.getRuntimeConfig()).toMatchObject({
        activeProviderId: "openai",
        activeModel: "gpt-5.4-mini",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function createService(baseUrl: string): LlmService {
  const config: LlmConfigFile = {
    activeProviderId: "openai",
    activeModel: "gpt-5.4-mini",
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl,
        apiStyle: "openai-responses",
        defaultModel: "gpt-5.4-mini",
      },
    ],
  };
  return new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
}

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
