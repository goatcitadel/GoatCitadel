import { describe, expect, it, vi } from "vitest";
import { createProviderRuntime, type ProviderRuntimeHost } from "./provider-runtime-service.js";

describe("provider-runtime-service", () => {
  it("delegates provider runtime operations through a bounded host", async () => {
    const host: ProviderRuntimeHost = {
      listProviders: vi.fn(() => [{ providerId: "openai", defaultModel: "gpt-5.4-mini" }] as never),
      getConfigWithDetails: vi.fn(() => ({
        activeProviderId: "openai",
        activeModel: "gpt-5.4-mini",
        providers: [],
        providerConfigs: [{ providerId: "openai" }],
      })),
      updateConfig: vi.fn((input) => ({
        activeProviderId: input.activeProviderId ?? "openai",
        activeModel: input.activeModel ?? "gpt-5.4-mini",
        providers: [],
      })),
      listModels: vi.fn(async () => [{ id: "gpt-5.4-mini" }]),
      previewModels: vi.fn(async () => ({ items: [{ id: "preview-model" }], source: "remote" as const })),
      generateImage: vi.fn(async () => ({ operation: "generate" as const, data: [] })),
      createChatCompletion: vi.fn(async () => ({ id: "cmpl-1", choices: [] })),
    };
    const runtime = createProviderRuntime(host);

    expect(runtime.listProviders()).toEqual([{ providerId: "openai", defaultModel: "gpt-5.4-mini" }]);
    expect(runtime.getConfigWithDetails()).toMatchObject({ activeProviderId: "openai" });
    expect(runtime.updateConfig({ activeModel: "gpt-5.4" })).toMatchObject({ activeModel: "gpt-5.4" });
    await expect(runtime.listModels("openai")).resolves.toEqual([{ id: "gpt-5.4-mini" }]);
    await expect(runtime.previewModels({ providerId: "openai", baseUrl: "https://api.openai.com/v1" })).resolves.toEqual(
      { items: [{ id: "preview-model" }], source: "remote" },
    );
    await expect(runtime.generateImage({ prompt: "hello" })).resolves.toEqual({ operation: "generate", data: [] });
    await expect(
      runtime.createChatCompletion({
        messages: [{ role: "user", content: "hello" }],
      }),
    ).resolves.toEqual({ id: "cmpl-1", choices: [] });
  });
});
