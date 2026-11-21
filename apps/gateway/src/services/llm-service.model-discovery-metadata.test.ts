import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmConfigFile } from "@goatcitadel/contracts";
import { LlmService } from "./llm-service.js";
import { createNoopSecretStore } from "../test/llm-fixtures.js";

function buildConfig(): LlmConfigFile {
  return {
    activeProviderId: "openrouter",
    activeModel: "openai/gpt-5.4-mini",
    providers: [
      {
        providerId: "openrouter",
        label: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiStyle: "openai-chat-completions",
        authMode: "bearer",
        defaultModel: "openai/gpt-5.4-mini",
        apiKey: "sk-or-test",
      },
    ],
  };
}

function buildService(secretStore = createNoopSecretStore()): LlmService {
  return new LlmService(buildConfig(), process.env, {
    networkAllowlist: ["openrouter.ai"],
    enforceNetworkAllowlist: false,
    secretStore,
  });
}

// Shape mirrors OpenRouter GET /models: display name in `name`, context size in
// `context_length`, completion cap nested under `top_provider`.
// Keep provider fixtures explicit; real transport tests use the pinned implementation.
vi.mock("./llm-provider-fetch.js", () => ({
  fetchLlmProvider: (url: string, init: RequestInit) => globalThis.fetch(url, init),
}));

const OPENROUTER_MODELS_FIXTURE = {
  data: [
    {
      id: "openai/gpt-5.4-mini",
      name: "OpenAI: GPT-5.4 Mini",
      created: 1_760_000_000,
      context_length: 400_000,
      pricing: { prompt: "0.00000015", completion: "0.0000006" },
      top_provider: { context_length: 400_000, max_completion_tokens: 64_000 },
    },
    {
      id: "anthropic/claude-sonnet-5",
      name: "Anthropic: Claude Sonnet 5",
      context_length: 1_000_000,
      top_provider: { max_completion_tokens: 128_000 },
    },
    // Degenerate rows must not produce bogus metadata.
    { id: "broken/no-metadata", context_length: -5, top_provider: { max_completion_tokens: "many" } },
  ],
};

describe("LlmService model discovery metadata extraction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits for a saved provider key asynchronously before requesting the model catalog", async () => {
    let resolveCredential!: (key: string) => void;
    const credential = new Promise<string>((resolve) => {
      resolveCredential = resolve;
    });
    const store = Object.assign(createNoopSecretStore(), {
      getProviderApiKey: vi.fn(() => "sync-fixture-key"),
      getProviderApiKeyAsync: vi.fn(() => credential),
    });
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json(OPENROUTER_MODELS_FIXTURE));
    vi.stubGlobal("fetch", fetchMock);

    const discovery = buildService(store).listModelsWithSource("openrouter");
    try {
      expect(store.getProviderApiKey).not.toHaveBeenCalled();
      expect(store.getProviderApiKeyAsync).toHaveBeenCalledWith("openrouter");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      resolveCredential("async-fixture-key");
      await discovery;
    }
    expect(new Headers(fetchMock.mock.calls[0]?.[1].headers).get("authorization")).toBe("Bearer async-fixture-key");
  });

  it("rejects model discovery when the provider changes during the keychain read", async () => {
    let resolveCredential!: (key: string) => void;
    const credential = new Promise<string>((resolve) => {
      resolveCredential = resolve;
    });
    const store = Object.assign(createNoopSecretStore(), { getProviderApiKeyAsync: () => credential });
    const fetchMock = vi.fn(async () => Response.json(OPENROUTER_MODELS_FIXTURE));
    vi.stubGlobal("fetch", fetchMock);

    const service = buildService(store);
    const discovery = service.listModelsWithSource("openrouter");
    const config = buildConfig();
    config.providers[0]!.baseUrl = "https://openrouter.ai/changed/v1";
    service.replaceRuntimeConfig(config);
    resolveCredential("changed-provider-fixture-key");

    await expect(discovery).rejects.toMatchObject({ code: "STATE_CONFLICT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("extracts label, context window, and output cap from an OpenRouter-shaped /models payload", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(OPENROUTER_MODELS_FIXTURE), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildService().listModelsWithSource("openrouter");
    expect(result.source).toBe("live");

    const mini = result.items.find((item) => item.id === "openai/gpt-5.4-mini");
    expect(mini).toBeDefined();
    expect(mini?.label).toBe("OpenAI: GPT-5.4 Mini");
    expect(mini?.contextWindow).toBe(400_000);
    expect(mini?.outputTokenLimit).toBe(64_000);

    const sonnet = result.items.find((item) => item.id === "anthropic/claude-sonnet-5");
    expect(sonnet?.contextWindow).toBe(1_000_000);
    expect(sonnet?.outputTokenLimit).toBe(128_000);

    const broken = result.items.find((item) => item.id === "broken/no-metadata");
    expect(broken).toBeDefined();
    expect(broken?.contextWindow).toBeUndefined();
    expect(broken?.outputTokenLimit).toBeUndefined();
  });

  it("keeps openai-style snake_case fields working", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "gpt-x", owned_by: "openai", context_window: 200_000, max_output_tokens: 32_000 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildService().listModelsWithSource("openrouter");
    const model = result.items.find((item) => item.id === "gpt-x");
    expect(model?.ownedBy).toBe("openai");
    expect(model?.contextWindow).toBe(200_000);
    expect(model?.outputTokenLimit).toBe(32_000);
    expect(model?.label).toBeUndefined();
  });
});
