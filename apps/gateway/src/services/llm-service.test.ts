import { describe, expect, it, vi } from "vitest";
import type { LlmConfigFile } from "@goatcitadel/contracts";
import { LlmService } from "./llm-service.js";
import { SecretStoreService } from "./secret-store-service.js";

describe("LlmService", () => {
  it("blocks private metadata endpoints as provider baseUrl", () => {
    const config: LlmConfigFile = {
      activeProviderId: "bad",
      providers: [
        {
          providerId: "bad",
          label: "bad",
          baseUrl: "http://169.254.169.254/latest",
          apiStyle: "openai-chat-completions",
          defaultModel: "test",
        },
      ],
    };

    expect(() => new LlmService(config, process.env, { secretStore: createNoopSecretStore() })).toThrowError(/blocked/i);
  });

  it("allows loopback providers for local runtime", () => {
    const config: LlmConfigFile = {
      activeProviderId: "local",
      providers: [
        {
          providerId: "local",
          label: "local",
          baseUrl: "http://127.0.0.1:1234/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "test",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    expect(service.getRuntimeConfig().activeProviderId).toBe("local");
  });

  it("does not export plaintext apiKey values", () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-4.1-mini",
          apiKey: "secret",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const exported = service.exportConfigFile();
    expect(exported.providers[0]?.apiKey).toBeUndefined();
  });

  it("keeps provider-specific versioned base paths (z.ai v4) intact", () => {
    const config: LlmConfigFile = {
      activeProviderId: "glm",
      providers: [
        {
          providerId: "glm",
          label: "GLM",
          baseUrl: "https://api.z.ai/api/paas/v4",
          apiStyle: "openai-chat-completions",
          defaultModel: "glm-5",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const provider = service.listProviders().find((item) => item.providerId === "glm");
    expect(provider?.baseUrl).toBe("https://api.z.ai/api/paas/v4");
  });

  it("adds /v1 for bare OpenAI-style roots", () => {
    const config: LlmConfigFile = {
      activeProviderId: "custom",
      providers: [
        {
          providerId: "custom",
          label: "Custom",
          baseUrl: "https://example.com",
          apiStyle: "openai-chat-completions",
          defaultModel: "x",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const provider = service.listProviders().find((item) => item.providerId === "custom");
    expect(provider?.baseUrl).toBe("https://example.com/v1");
  });

  it("keeps Perplexity on the root API base without appending /v1", () => {
    const config: LlmConfigFile = {
      activeProviderId: "perplexity",
      providers: [
        {
          providerId: "perplexity",
          label: "Perplexity",
          baseUrl: "https://api.perplexity.ai",
          apiStyle: "openai-chat-completions",
          defaultModel: "sonar",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const provider = service.listProviders().find((item) => item.providerId === "perplexity");
    expect(provider?.baseUrl).toBe("https://api.perplexity.ai");
  });

  it("normalizes bare Google model ids to the models/ form at request time", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "google",
      providers: [
        {
          providerId: "google",
          label: "Google",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gemini-2.5-flash",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let payloadBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      payloadBody = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      return new Response(
        JSON.stringify({
          id: "cmpl_google",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      await service.chatCompletions({
        providerId: "google",
        messages: [{ role: "user", content: "hello" }],
      });
      expect(payloadBody?.model).toBe("models/gemini-2.5-flash");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses max_completion_tokens for OpenAI gpt-5 chat completions", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-5.4",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let payloadBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      payloadBody = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      return new Response(
        JSON.stringify({
          id: "cmpl_openai_gpt5",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      await service.chatCompletions({
        providerId: "openai",
        model: "gpt-5.4",
        max_tokens: 512,
        messages: [{ role: "user", content: "hello" }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(payloadBody?.max_completion_tokens).toBe(512);
    expect(payloadBody?.max_tokens).toBeUndefined();
  });

  it("uses max_completion_tokens for OpenAI gpt-5 streamed chat completions", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-5.4",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let payloadBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      payloadBody = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      return new Response(
        "data: {\"id\":\"chunk_openai_gpt5\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n",
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      for await (const _chunk of service.chatCompletionsStream({
        providerId: "openai",
        model: "gpt-5.4",
        max_tokens: 384,
        messages: [{ role: "user", content: "hello" }],
      })) {
        // consume stream
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(payloadBody?.max_completion_tokens).toBe(384);
    expect(payloadBody?.max_tokens).toBeUndefined();
  });

  it("preserves developer messages and forwards OpenAI GPT controls", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-5.4-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let payloadBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      payloadBody = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      return new Response(
        JSON.stringify({
          id: "cmpl_openai_gpt54_controls",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      await service.chatCompletions({
        providerId: "openai",
        model: "gpt-5.4-mini",
        messages: [
          { role: "developer", content: "Be terse." },
          { role: "user", content: "hello" },
        ],
        reasoning: { effort: "none" },
        verbosity: "low",
        service_tier: "flex",
        prompt_cache_retention: "in_memory",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(payloadBody?.messages).toEqual([
      { role: "developer", content: "Be terse." },
      { role: "user", content: "hello" },
    ]);
    expect(payloadBody?.reasoning_effort).toBe("none");
    expect(payloadBody?.verbosity).toBe("low");
    expect(payloadBody?.service_tier).toBe("flex");
    expect(payloadBody?.prompt_cache_retention).toBe("in_memory");
  });

  it("preserves OpenAI system messages for backward compatibility", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-5.4-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let payloadBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      payloadBody = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      return new Response(
        JSON.stringify({
          id: "cmpl_openai_gpt54_roles",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      await service.chatCompletions({
        providerId: "openai",
        model: "gpt-5.4-mini",
        messages: [
          { role: "system", content: "Follow policy." },
          { role: "user", content: "hello" },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(payloadBody?.messages).toEqual([
      { role: "system", content: "Follow policy." },
      { role: "user", content: "hello" },
    ]);
  });

  it("rejects sampling controls for GPT-5.4 when reasoning is not none", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-5.4",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });

    await expect(service.chatCompletions({
      providerId: "openai",
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      reasoning: { effort: "high" },
      temperature: 0.2,
    })).rejects.toThrowError(/reasoning effort is set to none/i);
  });

  it("rejects sampling controls for older GPT-5 chat models", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-5-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });

    await expect(service.chatCompletions({
      providerId: "openai",
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
    })).rejects.toThrowError(/older openai gpt-5 family models/i);
  });

  it("canonicalizes legacy Perplexity /v1 endpoints back to the root API base", () => {
    const config: LlmConfigFile = {
      activeProviderId: "perplexity",
      providers: [
        {
          providerId: "perplexity",
          label: "Perplexity",
          baseUrl: "https://api.perplexity.ai/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "sonar",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const provider = service.listProviders().find((item) => item.providerId === "perplexity");
    expect(provider?.baseUrl).toBe("https://api.perplexity.ai");
  });

  it("canonicalizes legacy MiniMax and Moonshot endpoints to current official bases", () => {
    const config: LlmConfigFile = {
      activeProviderId: "minimax",
      providers: [
        {
          providerId: "minimax",
          label: "MiniMax",
          baseUrl: "https://api.minimax.chat/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "MiniMax-M2.7",
        },
        {
          providerId: "moonshot",
          label: "Moonshot",
          baseUrl: "https://api.moonshot.ai/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "kimi-k2.5",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const minimax = service.listProviders().find((item) => item.providerId === "minimax");
    const moonshot = service.listProviders().find((item) => item.providerId === "moonshot");

    expect(minimax?.baseUrl).toBe("https://api.minimax.io/v1");
    expect(moonshot?.baseUrl).toBe("https://api.moonshot.ai/v1");
  });

  it("uses Anthropic-native auth headers for model discovery", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "anthropic",
      providers: [
        {
          providerId: "anthropic",
          label: "Anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "claude-sonnet-4-6",
          apiKeyEnv: "ANTHROPIC_API_KEY",
        },
      ],
    };

    const service = new LlmService(config, {
      ...process.env,
      ANTHROPIC_API_KEY: "anthropic-secret",
    }, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let receivedHeaders: Headers | undefined;

    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      receivedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          data: [{ id: "claude-sonnet-4-6" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const models = await service.listModels("anthropic");
      expect(models.map((model) => model.id)).toEqual(["claude-sonnet-4-6"]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(receivedHeaders?.get("x-api-key")).toBe("anthropic-secret");
    expect(receivedHeaders?.get("anthropic-version")).toBe("2023-06-01");
    expect(receivedHeaders?.get("authorization")).toBeNull();
  });

  it("falls back to known Perplexity models when model listing is unsupported", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "perplexity",
      providers: [
        {
          providerId: "perplexity",
          label: "Perplexity",
          baseUrl: "https://api.perplexity.ai",
          apiStyle: "openai-chat-completions",
          defaultModel: "sonar",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;

    try {
      const models = await service.listModels("perplexity");
      expect(models.map((model) => model.id)).toEqual([
        "sonar",
        "sonar-pro",
        "sonar-reasoning-pro",
        "sonar-deep-research",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses provider-template defaults for preview fallbacks when no provider is stored yet", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-4.1-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("preview failed");
    }) as unknown as typeof fetch;

    try {
      await expect(service.previewModels({
        providerId: "minimax",
        baseUrl: "https://api.minimax.io/v1",
      })).resolves.toMatchObject({
        source: "fallback",
        items: [{ id: "MiniMax-M2.7" }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("prefers explicit preview credentials over a saved keychain secret for model discovery", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "glm",
      providers: [
        {
          providerId: "glm",
          label: "GLM",
          baseUrl: "https://api.z.ai/api/paas/v4",
          apiStyle: "openai-chat-completions",
          defaultModel: "glm-5",
        },
      ],
    };

    const service = new LlmService(config, {
      ...process.env,
      GLM_API_KEY: "env-preview-token",
    }, { secretStore: createTrackedSecretStore({ glm: "stale-keychain-token" }) });
    const originalFetch = globalThis.fetch;
    let receivedHeaders: Headers | undefined;

    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      receivedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          data: [{ id: "glm-5" }, { id: "glm-5-turbo" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const result = await service.previewModels({
        providerId: "glm",
        baseUrl: "https://api.z.ai/api/paas/v4",
        apiKeyEnv: "GLM_API_KEY",
      });
      expect(result.items.map((item) => item.id)).toEqual(["glm-5", "glm-5-turbo"]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(receivedHeaders?.get("authorization")).toBe("Bearer env-preview-token");
  });

  it("uses provider-template defaults when upserting a new provider without an explicit default model", () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-4.1-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const updated = service.updateRuntimeConfig({
      upsertProvider: {
        providerId: "deepseek",
        label: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
      },
    });

    expect(updated.providers.find((provider) => provider.providerId === "deepseek")?.defaultModel).toBe("deepseek-chat");
  });

  it("enforces network allowlist for outbound model calls when configured", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-4.1-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, {
      secretStore: createNoopSecretStore(),
      networkAllowlist: ["example.com"],
    });
    await expect(service.listModels()).rejects.toThrowError(/allowlist/i);
  });

  it("probes keychain only for the active provider when building runtime settings", () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-4.1-mini",
        },
        {
          providerId: "moonshot",
          label: "Moonshot",
          baseUrl: "https://api.moonshot.ai/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "kimi-k2.5",
        },
      ],
    };

    const secretStore = createTrackedSecretStore({
      openai: "openai-secret",
      moonshot: "moonshot-secret",
    });
    const service = new LlmService(config, process.env, { secretStore });

    const first = service.getRuntimeConfig({
      includeKeychainForActiveProvider: true,
      useCache: true,
    });
    expect(secretStore.getCalls()).toBe(1);
    expect(first.providers.find((provider) => provider.providerId === "openai")?.apiKeySource).toBe("keychain");
    expect(first.providers.find((provider) => provider.providerId === "moonshot")?.apiKeySource).toBe("none");

    const second = service.getRuntimeConfig({
      includeKeychainForActiveProvider: true,
      useCache: true,
    });
    expect(secretStore.getCalls()).toBe(1);
    expect(second.providers.find((provider) => provider.providerId === "openai")?.apiKeySource).toBe("keychain");

    const explicitMoonshot = service.getProviderSecretStatus("moonshot", {
      includeKeychain: true,
      useCache: false,
    });
    expect(secretStore.getCalls()).toBe(2);
    expect(explicitMoonshot.apiKeySource).toBe("keychain");
  });

  it("adds reasoning_content for kimi assistant tool-call history messages", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "moonshot",
      providers: [
        {
          providerId: "moonshot",
          label: "Moonshot",
          baseUrl: "https://api.moonshot.ai/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "kimi-k2.5",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let payloadBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      payloadBody = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      return new Response(
        JSON.stringify({
          id: "cmpl_test",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      await service.chatCompletions({
        model: "kimi-k2.5",
        messages: [
          { role: "user", content: "what is the weather today?" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "browser_search",
                  arguments: "{\"query\":\"weather 91303\"}",
                },
              },
            ],
          } as unknown as { role: "assistant"; content: string },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: "{\"results\":[]}",
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const messages = Array.isArray(payloadBody?.messages)
      ? payloadBody.messages as Array<Record<string, unknown>>
      : [];
    const assistantToolCallMessage = messages.find((message) => (
      message.role === "assistant" && Array.isArray(message.tool_calls)
    ));
    expect(assistantToolCallMessage).toBeTruthy();
    expect(typeof assistantToolCallMessage?.reasoning_content).toBe("string");
    expect(String(assistantToolCallMessage?.reasoning_content)).not.toHaveLength(0);
  });

  it("retries without metadata when provider rejects metadata without store", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "moonshot",
      providers: [
        {
          providerId: "moonshot",
          label: "Moonshot",
          baseUrl: "https://api.moonshot.ai/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "kimi-k2.5",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    const payloads: Record<string, unknown>[] = [];

    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      payloads.push(payload);
      if (payloads.length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message: "The 'metadata' parameter is only allowed when 'store' is enabled.",
              type: "invalid_request_error",
            },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          id: "cmpl_test",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const completion = await service.chatCompletions({
        model: "kimi-k2.5",
        messages: [
          { role: "user", content: "hello" },
        ],
        metadata: { source: "test-suite" },
      });
      const message = completion.choices?.[0]?.message as Record<string, unknown> | undefined;
      expect(message?.content).toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.metadata).toBeTruthy();
    expect(payloads[1]?.metadata).toBeUndefined();
  });

  it("retries stream calls without metadata when provider rejects metadata without store", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "moonshot",
      providers: [
        {
          providerId: "moonshot",
          label: "Moonshot",
          baseUrl: "https://api.moonshot.ai/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "kimi-k2.5",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    const payloads: Record<string, unknown>[] = [];

    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      payloads.push(payload);
      if (payloads.length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message: "The 'metadata' parameter is only allowed when 'store' is enabled.",
              type: "invalid_request_error",
            },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        "data: {\"id\":\"chunk_1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n",
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    }) as unknown as typeof fetch;

    const chunks: Record<string, unknown>[] = [];
    try {
      for await (const chunk of service.chatCompletionsStream({
        model: "kimi-k2.5",
        messages: [
          { role: "user", content: "hello" },
        ],
        metadata: { source: "test-suite" },
      })) {
        chunks.push(chunk);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.metadata).toBeTruthy();
    expect(payloads[1]?.metadata).toBeUndefined();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.id).toBe("chunk_1");
  });

  it("rejects HTTP redirect responses to prevent SSRF", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-4.1-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("", {
      status: 301,
      headers: { Location: "http://169.254.169.254/latest/meta-data/" },
    })) as unknown as typeof fetch;

    try {
      await expect(service.chatCompletions({
        providerId: "openai",
        messages: [{ role: "user", content: "hello" }],
      })).rejects.toThrowError(/blocked redirect/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects when request times out", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-4.1-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      const err = new DOMException("The operation was aborted", "AbortError");
      throw err;
    }) as unknown as typeof fetch;

    try {
      await expect(service.chatCompletions({
        providerId: "openai",
        messages: [{ role: "user", content: "hello" }],
      })).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses SSE events whose JSON payload spans multiple data lines", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "glm",
      providers: [
        {
          providerId: "glm",
          label: "GLM",
          baseUrl: "https://api.z.ai/api/paas/v4",
          apiStyle: "openai-chat-completions",
          defaultModel: "glm-5",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn(async () => new Response(
      [
        "data: {\"id\":\"chunk_multiline\",",
        "data: \"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello from multiline sse\"}}]}",
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    )) as unknown as typeof fetch;

    const chunks: Record<string, unknown>[] = [];
    try {
      for await (const chunk of service.chatCompletionsStream({
        providerId: "glm",
        model: "glm-5",
        messages: [{ role: "user", content: "hello" }],
      })) {
        chunks.push(chunk);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.id).toBe("chunk_multiline");
    expect(((chunks[0]?.choices as Array<Record<string, unknown>>)[0]?.delta as Record<string, unknown>)?.content).toBe("hello from multiline sse");
  });
});

function createNoopSecretStore(): SecretStoreService {
  return {
    isAvailable: () => false,
    setProviderApiKey: () => undefined,
    getProviderApiKey: () => undefined,
    deleteProviderApiKey: () => undefined,
    status: (providerId: string) => ({ providerId, hasSecret: false, source: "none" }),
  } as unknown as SecretStoreService;
}

function createTrackedSecretStore(initial: Record<string, string>): SecretStoreService & {
  getCalls: () => number;
} {
  const secrets = new Map<string, string>(Object.entries(initial));
  let gets = 0;

  return {
    isAvailable: () => true,
    setProviderApiKey: (providerId: string, apiKey: string) => {
      secrets.set(providerId, apiKey);
    },
    getProviderApiKey: (providerId: string) => {
      gets += 1;
      return secrets.get(providerId);
    },
    deleteProviderApiKey: (providerId: string) => {
      secrets.delete(providerId);
    },
    status: (providerId: string) => ({
      providerId,
      hasSecret: secrets.has(providerId),
      source: secrets.has(providerId) ? "keychain" : "none",
    }),
    getCalls: () => gets,
  } as unknown as SecretStoreService & { getCalls: () => number };
}
