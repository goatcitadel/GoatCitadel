import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LlmConfigFile } from "@goatcitadel/contracts";
import { Agent, ProxyAgent } from "undici";
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

    expect(() => new LlmService(config, process.env, { secretStore: createNoopSecretStore() })).toThrowError(
      /blocked/i,
    );
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

  it("restores and exports the configured active model for the active provider", () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      activeModel: "gpt-5.4",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
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

    expect(service.getRuntimeConfig()).toMatchObject({
      activeProviderId: "openai",
      activeModel: "gpt-5.4",
    });
    expect(service.exportConfigFile()).toMatchObject({
      activeProviderId: "openai",
      activeModel: "gpt-5.4",
    });
  });

  it("keeps runtime selection empty when no active provider is configured", () => {
    const config: LlmConfigFile = {
      activeProviderId: "",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });

    expect(service.getRuntimeConfig()).toMatchObject({
      activeProviderId: "",
      activeModel: "",
    });
  });

  it("rejects updating runtime config with a model from a different provider", () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      activeModel: "gpt-5.4-mini",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
        {
          providerId: "anthropic",
          label: "Anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          apiStyle: "anthropic-messages",
          defaultModel: "claude-sonnet-4-6",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });

    expect(() =>
      service.updateRuntimeConfig({
        activeProviderId: "openai",
        activeModel: "claude-sonnet-4-6",
      }),
    ).toThrowError(/belongs to anthropic/i);
  });

  it("rejects chat requests that pair a model with the wrong provider", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      activeModel: "gpt-5.4-mini",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
        {
          providerId: "anthropic",
          label: "Anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          apiStyle: "anthropic-messages",
          defaultModel: "claude-sonnet-4-6",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });

    await expect(
      service.chatCompletions({
        providerId: "openai",
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrowError(/belongs to anthropic/i);
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
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
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
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
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
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return new Response(
        'data: {"id":"chunk_openai_gpt5","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
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
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
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
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
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

    await expect(
      service.chatCompletions({
        providerId: "openai",
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
        reasoning: { effort: "high" },
        temperature: 0.2,
      }),
    ).rejects.toThrowError(/reasoning effort is set to none/i);
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

    await expect(
      service.chatCompletions({
        providerId: "openai",
        model: "gpt-5-mini",
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.2,
      }),
    ).rejects.toThrowError(/older openai gpt-5 family models/i);
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

    const service = new LlmService(
      config,
      {
        ...process.env,
        ANTHROPIC_API_KEY: "anthropic-secret",
      },
      { secretStore: createNoopSecretStore() },
    );
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
      const result = await service.previewModels({
        providerId: "minimax",
        baseUrl: "https://api.minimax.io/v1",
      });
      expect(result.source).toBe("fallback");
      expect(result.items.some((item) => item.id === "MiniMax-M2.7")).toBe(true);
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

    const service = new LlmService(
      config,
      {
        ...process.env,
        GLM_API_KEY: "env-preview-token",
      },
      { secretStore: createTrackedSecretStore({ glm: "stale-keychain-token" }) },
    );
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
      expect(result.items.map((item) => item.id)).toEqual([
        "glm-5",
        "glm-5-turbo",
        "glm-5-air",
        "glm-5-flash",
        "glm-5v-turbo",
      ]);
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

    expect(updated.providers.find((provider) => provider.providerId === "deepseek")?.defaultModel).toBe(
      "deepseek-chat",
    );
  });

  it("preserves explicit apiStyle values when updating runtime config", () => {
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
        providerId: "anthropic",
        label: "Anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiStyle: "anthropic-messages",
        defaultModel: "claude-sonnet-4-6",
      },
    });

    expect(updated.providers.find((provider) => provider.providerId === "anthropic")?.apiStyle).toBe(
      "anthropic-messages",
    );
  });

  it("reports resolved execution api styles in runtime config", () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
        {
          providerId: "anthropic",
          label: "Anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          apiStyle: "anthropic-messages",
          defaultModel: "claude-sonnet-4-6",
        },
        {
          providerId: "openrouter",
          label: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "openai/gpt-5.4-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const runtime = service.getRuntimeConfig();

    expect(runtime.providers.find((provider) => provider.providerId === "openai")?.resolvedApiStyle).toBe(
      "openai-responses",
    );
    expect(runtime.providers.find((provider) => provider.providerId === "anthropic")?.resolvedApiStyle).toBe(
      "anthropic-messages",
    );
    expect(runtime.providers.find((provider) => provider.providerId === "openrouter")?.resolvedApiStyle).toBe(
      "openai-chat-completions",
    );
  });

  it("uses the OpenAI Responses API for GPT-5 native providers", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let payloadBody: Record<string, unknown> | undefined;

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return new Response(
        JSON.stringify({
          id: "resp_openai_native",
          model: "gpt-5.4-mini",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            total_tokens: 15,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const completion = await service.chatCompletions({
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
        max_tokens: 256,
      });

      expect((completion.choices?.[0]?.message as Record<string, unknown> | undefined)?.content).toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestUrl).toBe("https://api.openai.com/v1/responses");
    expect(payloadBody?.instructions).toBe("Be terse.");
    expect(payloadBody?.reasoning).toEqual({ effort: "none" });
    expect(payloadBody?.text).toEqual({ verbosity: "low" });
    expect(payloadBody?.service_tier).toBe("flex");
    expect(payloadBody?.prompt_cache_retention).toBe("in_memory");
    expect(payloadBody?.max_output_tokens).toBe(256);
    expect(payloadBody?.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ]);
  });

  it("injects a json hint into OpenAI Responses input when using json_object output", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let payloadBody: Record<string, unknown> | undefined;

    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return new Response(
        JSON.stringify({
          id: "resp_openai_json_object",
          model: "gpt-5.4-mini",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: '{"ok":true}' }],
            },
          ],
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
          { role: "developer", content: "Return strict JSON." },
          { role: "user", content: '{"task":"plan this"}' },
        ],
        response_format: {
          type: "json_object",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(payloadBody?.text).toEqual({
      format: {
        type: "json_object",
      },
    });
    expect(payloadBody?.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: 'Return json.\n\n{"task":"plan this"}' }],
      },
    ]);
  });

  it("normalizes function tools and tool_choice for OpenAI Responses payloads", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let payloadBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return new Response(
        JSON.stringify({
          id: "resp_openai_tool_payload",
          model: "gpt-5.4-mini",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const completion = await service.chatCompletions({
        providerId: "openai",
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "function",
            function: {
              name: "browser.search",
              description: "Search the web",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string" },
                },
                required: ["query"],
              },
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: {
            name: "browser.search",
          },
        },
      });

      expect((completion.choices?.[0]?.message as Record<string, unknown> | undefined)?.content).toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(payloadBody?.tools).toEqual([
      {
        type: "function",
        name: "browser.search",
        description: "Search the web",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    ]);
    expect(payloadBody?.tool_choice).toEqual({
      type: "function",
      name: "browser.search",
    });
  });

  it("falls back to chat completions for legacy OpenAI models on native-first providers", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      requestUrl = String(url);
      return new Response(
        JSON.stringify({
          id: "cmpl_legacy_openai",
          model: "gpt-4.1-mini",
          choices: [{ index: 0, message: { role: "assistant", content: "legacy" } }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const completion = await service.chatCompletions({
        providerId: "openai",
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: "hello" }],
      });
      expect((completion.choices?.[0]?.message as Record<string, unknown> | undefined)?.content).toBe("legacy");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestUrl).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("uses the Anthropic Messages API for native Anthropic providers", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "anthropic",
      providers: [
        {
          providerId: "anthropic",
          label: "Anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          apiStyle: "anthropic-messages",
          defaultModel: "claude-sonnet-4-6",
          apiKeyEnv: "ANTHROPIC_API_KEY",
        },
      ],
    };

    const service = new LlmService(
      config,
      {
        ...process.env,
        ANTHROPIC_API_KEY: "anthropic-secret",
      },
      { secretStore: createNoopSecretStore() },
    );
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let payloadBody: Record<string, unknown> | undefined;
    let receivedHeaders: Headers | undefined;

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      receivedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          id: "msg_native_anthropic",
          model: "claude-sonnet-4-6",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 9,
            output_tokens: 3,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const completion = await service.chatCompletions({
        providerId: "anthropic",
        model: "claude-sonnet-4-6",
        messages: [
          { role: "system", content: "Answer in one sentence." },
          { role: "user", content: "hello" },
        ],
        reasoning: { effort: "low" },
        response_format: {
          type: "json_schema",
          name: "answer",
          schema: { type: "object" },
        },
        max_tokens: 128,
      });

      expect((completion.choices?.[0]?.message as Record<string, unknown> | undefined)?.content).toBe("ok");
      expect(completion.choices?.[0]?.finish_reason).toBe("stop");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(receivedHeaders?.get("x-api-key")).toBe("anthropic-secret");
    expect(receivedHeaders?.get("anthropic-version")).toBe("2023-06-01");
    expect(receivedHeaders?.get("authorization")).toBeNull();
    expect(payloadBody?.system).toBe("Answer in one sentence.");
    expect(payloadBody?.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(payloadBody?.thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024,
    });
    expect(payloadBody?.output_config).toEqual({
      format: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object" },
      },
    });
  });

  it("round-trips tool calls and tool results through OpenAI Responses and dedupes duplicate call ids", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let payloadBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return new Response(
        JSON.stringify({
          id: "resp_openai_tool_roundtrip",
          model: "gpt-5.4-mini",
          output: [
            {
              type: "function_call",
              call_id: "call_weather",
              name: "lookup_weather",
              arguments: '{"zip":"91303"}',
            },
            {
              type: "function_call",
              call_id: "call_weather",
              name: "lookup_weather",
              arguments: '{"zip":"91303"}',
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const completion = await service.chatCompletions({
        providerId: "openai",
        model: "gpt-5.4-mini",
        messages: [
          { role: "user", content: "What is the weather in 91303?" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_weather",
                type: "function",
                function: {
                  name: "lookup_weather",
                  arguments: '{"zip":"91303"}',
                },
              },
            ],
          } as unknown as { role: "assistant"; content: string },
          {
            role: "tool",
            tool_call_id: "call_weather",
            content: '{"temp":72}',
          },
        ],
      });

      expect(completion.choices?.[0]?.finish_reason).toBe("tool_calls");
      expect(
        ((completion.choices?.[0]?.message as Record<string, unknown> | undefined)?.tool_calls as unknown[])?.length,
      ).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(payloadBody?.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "What is the weather in 91303?" }],
      },
      {
        type: "function_call",
        call_id: "call_weather",
        name: "lookup_weather",
        arguments: '{"zip":"91303"}',
      },
      {
        type: "function_call_output",
        call_id: "call_weather",
        output: '{"temp":72}',
      },
    ]);
  });

  it("encodes assistant conversation history as output_text for OpenAI Responses payloads", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let payloadBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return new Response(
        JSON.stringify({
          id: "resp_openai_assistant_history",
          model: "gpt-5.4-mini",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
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
          { role: "user", content: "First prompt" },
          { role: "assistant", content: "First answer" },
          { role: "user", content: "Follow-up" },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(payloadBody?.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "First prompt" }],
      },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "First answer" }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: "Follow-up" }],
      },
    ]);
  });

  it("round-trips tool calls and tool results through Anthropic Messages", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "anthropic",
      providers: [
        {
          providerId: "anthropic",
          label: "Anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          apiStyle: "anthropic-messages",
          defaultModel: "claude-sonnet-4-6",
          apiKeyEnv: "ANTHROPIC_API_KEY",
        },
      ],
    };

    const service = new LlmService(
      config,
      {
        ...process.env,
        ANTHROPIC_API_KEY: "anthropic-secret",
      },
      { secretStore: createNoopSecretStore() },
    );
    const originalFetch = globalThis.fetch;
    let payloadBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return new Response(
        JSON.stringify({
          id: "msg_anthropic_tool_roundtrip",
          model: "claude-sonnet-4-6",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_weather",
              name: "lookup_weather",
              input: { zip: "91303" },
            },
          ],
          stop_reason: "tool_use",
          usage: {
            input_tokens: 14,
            output_tokens: 5,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const completion = await service.chatCompletions({
        providerId: "anthropic",
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: "What is the weather in 91303?" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_weather",
                type: "function",
                function: {
                  name: "lookup_weather",
                  arguments: '{"zip":"91303"}',
                },
              },
            ],
          } as unknown as { role: "assistant"; content: string },
          {
            role: "tool",
            tool_call_id: "call_weather",
            content: '{"temp":72}',
          },
        ],
      });

      expect(completion.choices?.[0]?.finish_reason).toBe("tool_calls");
      expect(
        ((completion.choices?.[0]?.message as Record<string, unknown> | undefined)?.tool_calls as unknown[])?.length,
      ).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(payloadBody?.messages).toEqual([
      { role: "user", content: "What is the weather in 91303?" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_weather",
            name: "lookup_weather",
            input: { zip: "91303" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_weather",
            content: '{"temp":72}',
          },
        ],
      },
    ]);
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

  it("skips outbound model allowlist enforcement when explicitly disabled", async () => {
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
      enforceNetworkAllowlist: false,
    });
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      requestUrl = String(url);
      return new Response(
        JSON.stringify({
          data: [{ id: "gpt-4.1-mini", object: "model", created: 0, owned_by: "openai" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const models = await service.listModels();
      expect(models.some((model) => model.id === "gpt-4.1-mini")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestUrl).toBe("https://api.openai.com/v1/models");
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

  it("does not probe the keychain when resolving execution api style", () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
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

    expect(service.resolveExecutionApiStyle("openai", "gpt-5.4-mini")).toBe("openai-responses");
    expect(service.resolveExecutionApiStyle("moonshot", "kimi-k2.5")).toBe("openai-chat-completions");
    expect(secretStore.getCalls()).toBe(0);
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
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
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
                  arguments: '{"query":"weather 91303"}',
                },
              },
            ],
          } as unknown as { role: "assistant"; content: string },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: '{"results":[]}',
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const messages = Array.isArray(payloadBody?.messages)
      ? (payloadBody.messages as Array<Record<string, unknown>>)
      : [];
    const assistantToolCallMessage = messages.find(
      (message) => message.role === "assistant" && Array.isArray(message.tool_calls),
    );
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
      const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
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
        messages: [{ role: "user", content: "hello" }],
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
      const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
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
        'data: {"id":"chunk_1","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n',
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
        messages: [{ role: "user", content: "hello" }],
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
    globalThis.fetch = vi.fn(
      async () =>
        new Response("", {
          status: 301,
          headers: { Location: "http://169.254.169.254/latest/meta-data/" },
        }),
    ) as unknown as typeof fetch;

    try {
      await expect(
        service.chatCompletions({
          providerId: "openai",
          messages: [{ role: "user", content: "hello" }],
        }),
      ).rejects.toThrowError(/blocked redirect/i);
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
      await expect(
        service.chatCompletions({
          providerId: "openai",
          messages: [{ role: "user", content: "hello" }],
        }),
      ).rejects.toThrow();
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

    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          [
            'data: {"id":"chunk_multiline",',
            'data: "choices":[{"index":0,"delta":{"content":"hello from multiline sse"}}]}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    ) as unknown as typeof fetch;

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
    expect(((chunks[0]?.choices as Array<Record<string, unknown>>)[0]?.delta as Record<string, unknown>)?.content).toBe(
      "hello from multiline sse",
    );
  });

  it("merges the OpenAI shortlist into preview results even when /models is partial", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "gpt-5.4-mini" }, { id: "gpt-4.1-mini" }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;

    try {
      const result = await service.previewModels({
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
      });
      expect(result.source).toBe("remote");
      expect(result.items.map((item) => item.id)).toEqual([
        "gpt-5.4-mini",
        "gpt-4.1-mini",
        "gpt-5.4",
        "gpt-5-mini",
        "gpt-4o-mini",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("estimates missing usage cost for chat completions responses", async () => {
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

    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "cmpl_estimated_cost",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
            usage: {
              prompt_tokens: 1_000,
              completion_tokens: 500,
              cached_prompt_tokens: 200,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;

    try {
      const response = await service.chatCompletions({
        providerId: "openai",
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: "hello" }],
      });

      expect(response.usage?.cost_usd).toBe(0.00114);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to known GLM models when model listing returns auth errors", async () => {
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

    globalThis.fetch = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

    try {
      const models = await service.listModels("glm");
      expect(models.map((model) => model.id)).toEqual([
        "glm-5",
        "glm-5-air",
        "glm-5-flash",
        "glm-5-turbo",
        "glm-5v-turbo",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts alternative model listing payload shapes from compatible endpoints", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "custom",
      providers: [
        {
          providerId: "custom",
          label: "Custom",
          baseUrl: "https://example.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "fallback-model",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [{ name: "custom-alpha" }, { model: "custom-beta" }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;

    try {
      const models = await service.listModels("custom");
      expect(models.map((model) => model.id)).toEqual(["custom-alpha", "custom-beta"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to an OpenAI shortlist when /models returns an empty payload", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    try {
      const models = await service.listModels("openai");
      expect(models.map((model) => model.id)).toEqual([
        "gpt-5.4-mini",
        "gpt-5.4",
        "gpt-5-mini",
        "gpt-4.1-mini",
        "gpt-4o-mini",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes legacy headers into canonical request headers on export", () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
          headers: { "X-Legacy": "1" },
          request: {
            headers: { "X-Canonical": "1" },
          },
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const exported = service.exportConfigFile();

    expect(exported.providers[0]?.request?.headers).toEqual({
      "X-Legacy": "1",
      "X-Canonical": "1",
    });
    expect(exported.providers[0]?.headers).toBeUndefined();
  });

  it("keeps vendor-compatible providers on chat completions even when configured as openai-responses", () => {
    const config: LlmConfigFile = {
      activeProviderId: "moonshot",
      providers: [
        {
          providerId: "moonshot",
          label: "Moonshot",
          baseUrl: "https://api.moonshot.ai/v1",
          apiStyle: "openai-responses",
          defaultModel: "kimi-k2-0905-preview",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    expect(service.resolveExecutionApiStyle("moonshot", "kimi-k2-0905-preview")).toBe("openai-chat-completions");
  });

  it("posts JSON image generations to the OpenAI generations endpoint", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let payloadBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (input, init) => {
      requestedUrl = String(input);
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return new Response(
        JSON.stringify({
          created: 123,
          data: [{ b64_json: "image-bytes" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const response = await service.generateImage({
        providerId: "openai",
        prompt: "Generate a goat citadel poster",
        size: "1024x1024",
        responseFormat: "b64_json",
      });
      expect(response.operation).toBe("generate");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestedUrl).toBe("https://api.openai.com/v1/images/generations");
    expect(payloadBody).toMatchObject({
      model: "gpt-image-2",
      prompt: "Generate a goat citadel poster",
      size: "1024x1024",
    });
    expect(payloadBody).not.toHaveProperty("response_format");
  });

  it("uses multipart image edits without inferring a size", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let bodyEntries: Array<[string, unknown]> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      requestedUrl = String(input);
      const formData = init?.body as FormData;
      bodyEntries = [];
      formData.forEach((value, key) => {
        bodyEntries.push([key, value]);
      });
      return new Response(
        JSON.stringify({
          created: 456,
          data: [{ b64_json: "edited-image" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const response = await service.generateImage({
        providerId: "openai",
        prompt: "Edit the uploaded reference image",
        responseFormat: "b64_json",
        referenceImages: [
          {
            bytesBase64: "aGVsbG8=",
            mimeType: "image/png",
            fileName: "reference.png",
          },
        ],
      });
      expect(response.operation).toBe("edit");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestedUrl).toBe("https://api.openai.com/v1/images/edits");
    expect(bodyEntries).toEqual(
      expect.arrayContaining([
        ["model", "gpt-image-2"],
        ["prompt", "Edit the uploaded reference image"],
      ]),
    );
    expect(bodyEntries.some(([key]) => key === "response_format")).toBe(false);
    expect(bodyEntries.some(([key]) => key === "size")).toBe(false);
    expect(bodyEntries.some(([key]) => key === "image" || key === "image[]")).toBe(true);
  });

  it("supports Google-compatible image generation routes", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "google",
      providers: [
        {
          providerId: "google",
          label: "Google",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          apiStyle: "openai-chat-completions",
          defaultModel: "models/gemini-2.5-flash",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let payloadBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (input, init) => {
      requestedUrl = String(input);
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return new Response(
        JSON.stringify({
          created: 789,
          data: [{ b64_json: "google-image-bytes" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const response = await service.generateImage({
        providerId: "google",
        model: "gemini-3.1-flash-image-preview",
        prompt: "Generate a neon goat citadel skyline",
        responseFormat: "b64_json",
      });
      expect(response.operation).toBe("generate");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestedUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai/images/generations");
    expect(payloadBody).toMatchObject({
      model: "gemini-3.1-flash-image-preview",
      prompt: "Generate a neon goat citadel skyline",
      response_format: "b64_json",
    });
  });

  it("routes provider requests through a proxy dispatcher when configured", async () => {
    const tlsDir = mkdtempSync(join(tmpdir(), "llm-service-proxy-"));
    const caPath = join(tlsDir, "ca.pem");
    const proxyCaPath = join(tlsDir, "proxy-ca.pem");
    writeFileSync(caPath, "test-ca");
    writeFileSync(proxyCaPath, "proxy-ca");

    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-5.4-mini",
          request: {
            proxy: {
              url: "http://proxy.internal:8080",
              auth: {
                type: "header",
                headerName: "Proxy-Authorization",
                valueEnv: "TEST_PROXY_AUTH",
                scheme: "Bearer",
              },
              tls: {
                caCertPath: proxyCaPath,
                serverName: "proxy.internal",
              },
            },
            tls: {
              caCertPath: caPath,
              serverName: "api.openai.com",
            },
          },
        },
      ],
    };

    const service = new LlmService(
      config,
      { ...process.env, TEST_PROXY_AUTH: "proxy-secret" },
      { secretStore: createNoopSecretStore() },
    );
    const originalFetch = globalThis.fetch;
    let dispatcher: unknown;
    globalThis.fetch = vi.fn(async (_input, init) => {
      dispatcher = init?.dispatcher;
      return new Response(
        JSON.stringify({
          id: "cmpl_proxy",
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
        messages: [{ role: "user", content: "hello" }],
      });
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(tlsDir, { recursive: true, force: true });
    }

    expect(dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it("bypasses the proxy and uses a direct TLS dispatcher for configured bypass hosts", async () => {
    const tlsDir = mkdtempSync(join(tmpdir(), "llm-service-bypass-"));
    const certPath = join(tlsDir, "client-cert.pem");
    const keyPath = join(tlsDir, "client-key.pem");
    writeFileSync(certPath, "test-cert");
    writeFileSync(keyPath, "test-key");

    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-5.4-mini",
          request: {
            proxy: {
              url: "http://proxy.internal:8080",
              bypassHosts: ["api.openai.com"],
            },
            tls: {
              clientCertPath: certPath,
              clientKeyPath: keyPath,
              insecureSkipVerify: true,
            },
          },
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let dispatcher: unknown;
    globalThis.fetch = vi.fn(async (_input, init) => {
      dispatcher = init?.dispatcher;
      return new Response(
        JSON.stringify({
          id: "cmpl_bypass",
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
        messages: [{ role: "user", content: "hello" }],
      });
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(tlsDir, { recursive: true, force: true });
    }

    expect(dispatcher).toBeInstanceOf(Agent);
    expect(dispatcher).not.toBeInstanceOf(ProxyAgent);
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
