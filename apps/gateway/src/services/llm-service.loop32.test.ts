import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmConfigFile } from "@goatcitadel/contracts";
import { LlmService } from "./llm-service.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LlmService loop32 runtime coverage", () => {
  it("normalizes provider URLs, active model ids, and execution API styles without mutating exports", () => {
    const service = new LlmService(baseConfig(), {}, { secretStore: createNoopSecretStore() });

    const runtime = service.getRuntimeConfig();
    const google = runtime.providers.find((provider) => provider.providerId === "google");
    const codex = runtime.providers.find((provider) => provider.providerId === "openai-codex");

    expect(runtime.activeProviderId).toBe("google");
    expect(runtime.activeModel).toBe("models/gemini-2.5-pro");
    expect(google).toMatchObject({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      resolvedApiStyle: "openai-chat-completions",
    });
    expect(codex).toMatchObject({
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "codex-oauth",
      resolvedApiStyle: "openai-codex-responses",
    });
    expect(service.resolveExecutionApiStyle("openai", "gpt-5")).toBe("openai-responses");
    expect(service.resolveExecutionApiStyle("openai", "gpt-4.1")).toBe("openai-chat-completions");
    expect(service.exportConfigFile().providers.every((provider) => provider.apiKey === undefined)).toBe(true);
  });

  it("merges live model discovery with fallback defaults and reports redirect fallbacks", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const text = String(url);
      if (text === "http://127.0.0.1:4321/v1/models") {
        return new Response(
          JSON.stringify({
            data: [
              { id: " live-model ", owned_by: "local", created: 123 },
              { model: "named-model", ownedBy: "operator", createdAt: 456 },
              { id: "" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("moved", {
        status: 302,
        statusText: "Found",
        headers: { location: "http://127.0.0.1:4321/elsewhere" },
      });
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const service = new LlmService(
      {
        activeProviderId: "local",
        activeModel: "local-default",
        providers: [
          {
            providerId: "local",
            label: "Local",
            baseUrl: "http://127.0.0.1:4321",
            apiStyle: "openai-chat-completions",
            defaultModel: "local-default",
          },
          {
            providerId: "fallback",
            label: "Fallback",
            baseUrl: "http://127.0.0.1:9999/v1",
            apiStyle: "openai-chat-completions",
            defaultModel: "fallback-default",
          },
        ],
      },
      {},
      { secretStore: createNoopSecretStore() },
    );

    await expect(service.listModelsWithSource("local")).resolves.toEqual({
      source: "live",
      items: [
        { id: "live-model", ownedBy: "local", created: 123 },
        { id: "named-model", ownedBy: "operator", created: 456 },
      ],
    });
    await expect(service.listModelsWithSource("fallback")).resolves.toMatchObject({
      source: "error_fallback",
      items: [{ id: "fallback-default" }],
      warning: expect.stringContaining("model listing blocked redirect (302)"),
    });
  });
});

function baseConfig(): LlmConfigFile {
  return {
    activeProviderId: "google",
    activeModel: "gemini-2.5-pro",
    providers: [
      {
        providerId: "google",
        label: "Google",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/v1/",
        defaultModel: "gemini-2.5-pro",
      },
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com",
        apiStyle: "openai-responses",
        defaultModel: "gpt-5",
        apiKey: "inline-key",
      },
      {
        providerId: "openai-codex",
        label: "Codex",
        baseUrl: "https://ignored.example.test",
        apiStyle: "openai-chat-completions",
        defaultModel: "gpt-5",
        apiKey: "ignored-inline-key",
      },
    ],
  };
}

function createNoopSecretStore() {
  return {
    isAvailable: () => false,
    getSecret: () => undefined,
    setSecret: () => undefined,
    deleteSecret: () => undefined,
    getProviderApiKey: () => undefined,
    setProviderApiKey: () => undefined,
    deleteProviderApiKey: () => undefined,
    getStatus: () => ({ available: false }),
  };
}
