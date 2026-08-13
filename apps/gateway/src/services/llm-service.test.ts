import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LlmConfigFile, LlmProviderConfig } from "@goatcitadel/contracts";
import { Agent, ProxyAgent } from "undici";
import {
  absorbCompletionStreamChunk,
  buildCompletionFromAggregate,
  createCompletionStreamAggregate,
} from "./chat-agent-completion-adapters.js";
import { LlmService } from "./llm-service.js";
import { projectLlmConfigPublicValue } from "./provider-settings-public-projection.js";
import { SecretStoreService, SecretStoreUnavailableError } from "./secret-store-service.js";

describe("LlmService", () => {
  it("rejects empty configs and unknown configured active providers", () => {
    expect(
      () =>
        new LlmService(
          {
            activeProviderId: "",
            providers: [],
          },
          process.env,
          { secretStore: createNoopSecretStore() },
        ),
    ).toThrow(/must include at least one provider/i);

    expect(
      () =>
        new LlmService(
          {
            activeProviderId: "missing",
            providers: [
              {
                providerId: "openai",
                label: "OpenAI",
                baseUrl: "https://api.openai.com/v1",
                apiStyle: "openai-chat-completions",
                defaultModel: "gpt-4.1-mini",
              },
            ],
          },
          process.env,
          { secretStore: createNoopSecretStore() },
        ),
    ).toThrow(/Unknown LLM provider: missing/);
  });

  it("rejects runtime provider calls until activation and then falls back to the provider default model", async () => {
    const service = new LlmService(
      {
        activeProviderId: "",
        providers: [
          {
            providerId: "openai",
            label: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            apiStyle: "openai-chat-completions",
            defaultModel: "gpt-4.1-mini",
          },
        ],
      },
      process.env,
      { secretStore: createNoopSecretStore() },
    );

    await expect(service.listModels()).rejects.toThrow(/No active LLM provider/);
    await expect(
      service.chatCompletions({
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow(/No active LLM provider/);
    await expect(service.listModels("missing")).rejects.toThrow(/Unknown LLM provider: missing/);

    expect(service.updateRuntimeConfig({ activeProviderId: "openai" })).toMatchObject({
      activeProviderId: "openai",
      activeModel: "gpt-4.1-mini",
    });
  });

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

  it("preserves hidden provider transport credentials during public config edits", () => {
    const config: LlmConfigFile = {
      activeProviderId: "custom",
      providers: [
        {
          providerId: "custom",
          label: "Custom",
          baseUrl: "https://provider.example.test/token/status",
          apiStyle: "openai-chat-completions",
          defaultModel: "custom-model",
          headers: {
            Authorization: "Bearer top-level-secret",
            "X-Tenant": "acme",
          },
          request: {
            headers: {
              Authorization: "Bearer request-secret",
              "X-Trace": "trace-1",
            },
            auth: { type: "bearer", token: "inline-auth-secret" },
            proxy: {
              url: "https://proxy.example.test/token/path-secret?token=query-secret",
              bypassHosts: ["old.example.test"],
              auth: { type: "bearer", token: "proxy-auth-secret" },
              tls: { clientCertPath: "cert.pem", clientKeyPath: "key.pem", serverName: "proxy.example.test" },
            },
          },
        },
      ],
    };
    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const displayed = projectLlmConfigPublicValue(service.exportConfigFile());
    const displayedProvider = displayed.providers[0]!;

    service.updateRuntimeConfig({
      upsertProvider: {
        ...displayedProvider,
        label: "Renamed",
        apiKey: "[REDACTED]",
        request: {
          ...displayedProvider.request,
          proxy: {
            ...displayedProvider.request?.proxy,
            url: displayedProvider.request!.proxy!.url,
            bypassHosts: ["new.example.test"],
          },
        },
      },
    });

    const raw = (service as unknown as { providers: Map<string, LlmProviderConfig> }).providers.get("custom")!;
    expect(raw).toMatchObject({
      label: "Renamed",
      baseUrl: "https://provider.example.test/token/status/v1",
      headers: undefined,
      request: {
        headers: {
          Authorization: "Bearer request-secret",
          "X-Trace": "trace-1",
          "X-Tenant": "acme",
        },
        auth: { type: "bearer", token: "inline-auth-secret" },
        proxy: {
          url: "https://proxy.example.test/token/path-secret?token=query-secret",
          bypassHosts: ["new.example.test"],
          auth: { type: "bearer", token: "proxy-auth-secret" },
          tls: {
            clientCertPath: "cert.pem",
            clientKeyPath: "key.pem",
            serverName: "proxy.example.test",
          },
        },
      },
    });
    expect(raw.apiKey).not.toBe("[REDACTED]");
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

  it("accepts supported shared GPT models and rejects API-only models for the OpenAI Codex OAuth provider", () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai-codex",
      activeModel: "gpt-5.5",
      providers: [
        {
          providerId: "openai-codex",
          label: "OpenAI Codex (ChatGPT OAuth)",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          apiStyle: "openai-codex-responses",
          defaultModel: "gpt-5.5",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });

    expect(() =>
      service.updateRuntimeConfig({
        activeProviderId: "openai-codex",
        activeModel: "gpt-5.4",
      }),
    ).not.toThrow();
    expect(service.getRuntimeConfig()).toMatchObject({
      activeProviderId: "openai-codex",
      activeModel: "gpt-5.4",
    });
    expect(() =>
      service.updateRuntimeConfig({
        activeProviderId: "openai-codex",
        activeModel: "gpt-5.6",
      }),
    ).toThrowError(/belongs to openai/i);
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

  it("rejects sampling controls for GPT-5.4 reasoning on the default Responses path", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
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
        reasoning: { effort: "xhigh" },
        temperature: 0.1,
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
          defaultModel: "kimi-k2.6",
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
      expect(result.source).toBe("error_fallback");
      expect(result.warning).toContain("preview failed");
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
          apiKeyEnv: "GLM_API_KEY",
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

  it("rejects unbound preview environment credentials before any outbound request", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "glm",
      providers: [
        {
          providerId: "glm",
          label: "GLM",
          baseUrl: "https://api.z.ai/api/paas/v4",
          apiStyle: "openai-chat-completions",
          defaultModel: "glm-5",
          apiKeyEnv: "GLM_API_KEY",
          request: {
            auth: { type: "bearer", tokenEnv: "GLM_REQUEST_TOKEN" },
            proxy: {
              url: "https://saved-proxy.example.test",
              auth: { type: "header", headerName: "Proxy-Authorization", valueEnv: "GLM_PROXY_TOKEN" },
            },
          },
        },
      ],
    };
    const service = new LlmService(
      config,
      {
        ...process.env,
        GLM_API_KEY: "glm-secret",
        GLM_REQUEST_TOKEN: "request-secret",
        GLM_PROXY_TOKEN: "proxy-secret",
        GOATCITADEL_AUTH_BASIC_PASSWORD: "gateway-secret",
      },
      { secretStore: createNoopSecretStore() },
    );
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        service.previewModels({
          providerId: "glm",
          baseUrl: "https://attacker.example.test/v1",
          apiKeyEnv: "GLM_API_KEY",
        }),
      ).rejects.toThrow(/matching saved provider origin/i);
      await expect(
        service.previewModels({
          providerId: "glm",
          baseUrl: "https://api.z.ai/api/paas/v4",
          apiKeyEnv: "GOATCITADEL_AUTH_BASIC_PASSWORD",
        }),
      ).rejects.toThrow(/apiKeyEnv must match/i);
      await expect(
        service.previewModels({
          providerId: "glm",
          baseUrl: "https://api.z.ai/api/paas/v4",
          request: { auth: { type: "bearer", tokenEnv: "GOATCITADEL_AUTH_BASIC_PASSWORD" } },
        }),
      ).rejects.toThrow(/request auth environment reference must match/i);
      await expect(
        service.previewModels({
          providerId: "glm",
          baseUrl: "https://api.z.ai/api/paas/v4",
          request: {
            proxy: {
              url: "https://attacker-proxy.example.test",
              auth: {
                type: "header",
                headerName: "Proxy-Authorization",
                valueEnv: "GLM_PROXY_TOKEN",
              },
            },
          },
        }),
      ).rejects.toThrow(/proxy auth environment reference must match/i);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not inherit saved provider credentials when preview proxy routing changes", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-4.1-mini",
          apiKey: "stored-provider-secret",
          headers: { "x-stored-secret": "stored-header-secret" },
        },
      ],
    };
    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    let receivedHeaders: Headers | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      receivedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ data: [{ id: "gpt-4.1-mini" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      await service.previewModels({
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
        request: { proxy: { url: "https://attacker-proxy.example.test" } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(receivedHeaders?.get("authorization")).toBeNull();
    expect(receivedHeaders?.get("x-stored-secret")).toBeNull();
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
      "deepseek-v4-pro",
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

    const bedrock = service.updateRuntimeConfig({
      upsertProvider: {
        providerId: "bedrock",
        label: "Amazon Bedrock",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        apiStyle: "bedrock-messages",
        defaultModel: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      },
    });

    expect(bedrock.providers.find((provider) => provider.providerId === "bedrock")?.apiStyle).toBe("bedrock-messages");
  });

  it("rejects raw API-key storage for the OpenAI Codex OAuth provider", () => {
    const secretStore = createTrackedSecretStore({});
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });

    service.updateRuntimeConfig({
      upsertProvider: {
        providerId: "openai-codex",
        label: "OpenAI Codex (ChatGPT OAuth)",
        baseUrl: "https://api.openai.com/v1",
        apiStyle: "openai-chat-completions",
        authMode: "api-key",
        defaultModel: "gpt-5.5",
        apiKey: "sk-ignored",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    });

    const exportedProvider = service
      .exportConfigFile()
      .providers.find((provider) => provider.providerId === "openai-codex");
    expect(exportedProvider?.apiKey).toBeUndefined();
    expect(exportedProvider?.apiKeyEnv).toBeUndefined();
    expect(exportedProvider?.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(exportedProvider?.apiStyle).toBe("openai-codex-responses");
    expect(exportedProvider?.authMode).toBe("codex-oauth");
    expect(service.getProviderSecretStatus("openai-codex").hasApiKey).toBe(false);
    expect(() => service.setProviderApiKey("openai-codex", "sk-test")).toThrow(/ChatGPT OAuth/);
    expect(() => service.deleteProviderApiKey("openai-codex")).toThrow(/ChatGPT OAuth/);
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
          {
            role: "developer",
            content: [
              { type: "text", text: "Stable doctrine.", cache_control: { type: "ephemeral" } },
              { type: "text", text: "Volatile runtime." },
            ] as never,
          },
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
    expect(payloadBody?.instructions).toBe("Stable doctrine.\nVolatile runtime.");
    expect(JSON.stringify(payloadBody?.instructions)).not.toContain("cache_control");
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
        max_tokens: 2_048,
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
    // Always-on Anthropic caching converts the stable string system prompt to
    // block form so it can carry an ephemeral cache breakpoint, and marks the
    // (only, therefore most-recent) user message likewise.
    expect(payloadBody?.system).toEqual([
      { type: "text", text: "Answer in one sentence.", cache_control: { type: "ephemeral" } },
    ]);
    expect(payloadBody?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] },
    ]);
    expect(payloadBody?.thinking).toEqual({ type: "adaptive" });
    expect(payloadBody?.output_config).toEqual({
      effort: "low",
      format: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object" },
      },
    });
  });

  it("uses Claude Code OAuth headers for Claude subscription provider requests", async () => {
    const config: LlmConfigFile = {
      activeProviderId: "claude-code",
      providers: [
        {
          providerId: "claude-code",
          label: "Claude Code (Claude subscription)",
          baseUrl: "https://api.anthropic.com/v1",
          apiStyle: "anthropic-messages",
          authMode: "claude-code-oauth",
          defaultModel: "claude-sonnet-4-6",
          apiKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN",
        },
      ],
    };

    const service = new LlmService(
      config,
      {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: "claude-code-oauth-secret",
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
          id: "msg_claude_code_oauth",
          model: "claude-sonnet-4-6",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      await service.chatCompletions({
        providerId: "claude-code",
        model: "claude-code/claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(payloadBody?.model).toBe("claude-sonnet-4-6");
    expect(receivedHeaders?.get("authorization")).toBe("Bearer claude-code-oauth-secret");
    expect(receivedHeaders?.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(receivedHeaders?.get("anthropic-version")).toBe("2023-06-01");
    expect(receivedHeaders?.get("x-api-key")).toBeNull();
  });

  it("maps OpenAI-style tool_choice values for Anthropic Messages payloads", async () => {
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
          id: "msg_native_anthropic_tool_choice",
          model: "claude-sonnet-4-6",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      await service.chatCompletions({
        providerId: "anthropic",
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup_weather",
              description: "Look up weather.",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: "auto",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(payloadBody?.tool_choice).toEqual({ type: "auto" });
    expect(payloadBody?.tools).toEqual([
      {
        name: "lookup_weather",
        description: "Look up weather.",
        input_schema: { type: "object", properties: {} },
      },
    ]);
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

  it("keeps streamed OpenAI Responses function calls on distinct aggregate indexes", async () => {
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
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        [
          'data: {"type":"response.output_item.done","item":{"id":"item_alpha","type":"function_call","call_id":"call_alpha","name":"lookup_alpha","arguments":"{\\"alpha\\":1}"}}',
          "",
          'data: {"type":"response.output_text.delta","delta":"checking","response_id":"resp_stream_tools"}',
          "",
          'data: {"type":"response.output_item.done","item":{"id":"item_beta","type":"function_call","call_id":"call_beta","name":"lookup_beta","arguments":"{\\"beta\\":2}"}}',
          "",
          'data: {"type":"response.completed","response":{"id":"resp_stream_tools","model":"gpt-5.4-mini","output":[]}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const aggregate = createCompletionStreamAggregate();
      for await (const chunk of service.chatCompletionsStream({
        providerId: "openai",
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: "Call both tools." }],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup_alpha",
              description: "Lookup alpha.",
              parameters: { type: "object", properties: {} },
            },
          },
          {
            type: "function",
            function: {
              name: "lookup_beta",
              description: "Lookup beta.",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      })) {
        absorbCompletionStreamChunk(aggregate, chunk);
      }

      const completion = buildCompletionFromAggregate(aggregate);
      const toolCalls =
        ((completion.choices?.[0]?.message as Record<string, unknown> | undefined)?.tool_calls as
          | Array<{ id: string; function: { name: string; arguments: string } }>
          | undefined) ?? [];

      expect(toolCalls).toHaveLength(2);
      expect(toolCalls.map((call) => call.id)).toEqual(["call_alpha", "call_beta"]);
      expect(toolCalls.map((call) => call.function.name)).toEqual(["lookup_alpha", "lookup_beta"]);
      expect(toolCalls.map((call) => call.function.arguments)).toEqual(['{"alpha":1}', '{"beta":2}']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves provider details from OpenAI Responses stream failures", async () => {
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
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        [
          'data: {"type":"response.failed","response":{"id":"resp_failed_1","status":"failed","error":{"code":"invalid_request_error","type":"invalid_request_error","message":"Unsupported service_tier: auto"}}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      let caught: unknown;
      try {
        for await (const _chunk of service.chatCompletionsStream({
          providerId: "openai",
          model: "gpt-5.4-mini",
          messages: [{ role: "user", content: "hello" }],
        })) {
          // consume stream
        }
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("Unsupported service_tier: auto");
      expect((caught as Error & { providerFailure?: Record<string, unknown> }).providerFailure).toMatchObject({
        code: "invalid_request_error",
        message: "Unsupported service_tier: auto",
        status: "failed",
        responseId: "resp_failed_1",
        type: "invalid_request_error",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
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

    // Anthropic prompt caching is always on: the last two non-system messages
    // each carry an ephemeral cache_control breakpoint on their final block.
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
            cache_control: { type: "ephemeral" },
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
            cache_control: { type: "ephemeral" },
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

  it("updates the outbound network allowlist and can disable enforcement at runtime", async () => {
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
      service.updateNetworkAllowlist(["api.openai.com"]);
      await expect(service.listModels()).resolves.toEqual([expect.objectContaining({ id: "gpt-4.1-mini" })]);
      expect(requestUrl).toBe("https://api.openai.com/v1/models");

      service.updateNetworkAllowlist(["example.com"], { enforce: false });
      await expect(service.listModels()).resolves.toEqual([expect.objectContaining({ id: "gpt-4.1-mini" })]);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
          defaultModel: "kimi-k2.6",
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

  it("clears inline provider API keys without touching keychain-backed providers", () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-4.1-mini",
          apiKey: "inline-secret",
        },
        {
          providerId: "moonshot",
          label: "Moonshot",
          baseUrl: "https://api.moonshot.ai/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "kimi-k2.6",
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    expect(service.getProviderSecretStatus("openai", { includeKeychain: false }).apiKeySource).toBe("inline");

    service.clearInlineProviderApiKey("moonshot");
    expect(service.getProviderSecretStatus("moonshot", { includeKeychain: false }).apiKeySource).toBe("none");

    service.clearInlineProviderApiKey("openai");
    expect(service.getProviderSecretStatus("openai", { includeKeychain: false }).apiKeySource).toBe("none");
    expect(() => service.clearInlineProviderApiKey("missing")).toThrowError(/Unknown LLM provider/);
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
          defaultModel: "kimi-k2.6",
        },
      ],
    };

    const secretStore = createTrackedSecretStore({
      openai: "openai-secret",
      moonshot: "moonshot-secret",
    });
    const service = new LlmService(config, process.env, { secretStore });

    expect(service.resolveExecutionApiStyle("openai", "gpt-5.4-mini")).toBe("openai-responses");
    expect(service.resolveExecutionApiStyle("moonshot", "kimi-k2.6")).toBe("openai-chat-completions");
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
          defaultModel: "kimi-k2.6",
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
        model: "kimi-k2.6",
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
          defaultModel: "kimi-k2.6",
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
        model: "kimi-k2.6",
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
          defaultModel: "kimi-k2.6",
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
        model: "kimi-k2.6",
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
      expect(result.source).toBe("live");
      expect(result.items.map((item) => item.id)).toEqual([
        "gpt-5.4-mini",
        "gpt-4.1-mini",
        "gpt-5.6",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.4",
        "gpt-5-mini",
        "gpt-4o-mini",
        "chat-latest",
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
      expect(response.usage?.cost_source).toBe("estimated");
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
        "gpt-5.6",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.4",
        "gpt-5-mini",
        "gpt-4.1-mini",
        "gpt-4o-mini",
        "chat-latest",
      ]);

      const discovery = await service.listModelsWithSource("openai");
      expect(discovery.source).toBe("template_fallback");
      expect(discovery.warning).toContain("returned no models");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes OpenAI Codex as an OAuth Responses provider without appending /v1", () => {
    const service = new LlmService(createCodexConfig(), process.env, { secretStore: createNoopSecretStore() });

    const codexProvider = service
      .getRuntimeConfig()
      .providers.find((provider) => provider.providerId === "openai-codex");
    const summary = service.listProviders().find((provider) => provider.providerId === "openai-codex");

    expect(codexProvider).toMatchObject({
      providerId: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      apiStyle: "openai-codex-responses",
      authMode: "codex-oauth",
    });
    expect(service.resolveExecutionApiStyle("openai-codex", "openai-codex/gpt-5.5")).toBe("openai-codex-responses");
    expect(summary).toMatchObject({
      providerId: "openai-codex",
      apiStyle: "openai-codex-responses",
      resolvedApiStyle: "openai-codex-responses",
      authMode: "codex-oauth",
      hasApiKey: false,
      apiKeySource: "none",
      oauthStatus: {
        connected: false,
      },
    });
  });

  it("returns local OpenAI Codex models without calling upstream /models", async () => {
    const service = new LlmService(createCodexConfig(), process.env, { secretStore: createNoopSecretStore() });
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const models = await service.listModels("openai-codex");
      expect(models.map((model) => model.id)).toEqual([
        "gpt-5.5",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5-pro",
        "gpt-5.4",
        "gpt-5.4-pro",
        "gpt-5.4-mini",
      ]);
      expect(models.map((model) => model.id)).not.toContain("gpt-5.3-codex-spark");
      expect(models.map((model) => model.id)).not.toContain("gpt-5.3-codex");
      expect(models.map((model) => model.id)).not.toContain("gpt-5.2-codex");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("marks OpenAI Codex model discovery as fallback-only", async () => {
    const service = new LlmService(createCodexConfig(), process.env, { secretStore: createNoopSecretStore() });

    const result = await service.listModelsWithSource("openai-codex");

    expect(result.source).toBe("template_fallback");
    expect(result.warning).toContain("template");
    expect(result.items.map((model) => model.id)).toContain("gpt-5.6-sol");
    expect(result.items.map((model) => model.id)).toContain("gpt-5.6-terra");
    expect(result.items.map((model) => model.id)).toContain("gpt-5.6-luna");
    expect(result.items.map((model) => model.id)).toContain("gpt-5.5");
  });

  it("can report and delete orphan OpenAI Codex OAuth credentials without provider config", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(
      {
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
        ],
      },
      process.env,
      { secretStore },
    );

    expect(service.getOpenAICodexOAuthStatus()).toMatchObject({
      providerId: "openai-codex",
      connected: true,
    });
    expect(service.deleteOpenAICodexOAuthCredential()).toMatchObject({
      providerId: "openai-codex",
      connected: false,
    });
    await expect(service.startOpenAICodexOAuthDeviceFlow()).rejects.toThrow(/Unknown LLM provider: openai-codex/);
    await expect(service.pollOpenAICodexOAuthDeviceFlow("flow-1")).rejects.toThrow(
      /Unknown LLM provider: openai-codex/,
    );
  });

  it("posts OpenAI Codex chat through Responses with OAuth bearer auth and Codex defaults", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let authorizationHeader = "";
    let payloadBody: Record<string, unknown> | undefined;

    globalThis.fetch = vi.fn(async (input, init) => {
      requestedUrl = String(input);
      const headers = new Headers(init?.headers);
      authorizationHeader = headers.get("authorization") ?? "";
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"ok","response_id":"resp_codex_chat"}',
          "",
          'data: {"type":"response.completed","response":{"id":"resp_codex_chat","model":"gpt-5.5","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":11,"output_tokens":2,"total_tokens":13}}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const completion = await service.chatCompletions({
        providerId: "openai-codex",
        model: "openai-codex/gpt-5.5",
        max_tokens: 256,
        messages: [
          { role: "developer", content: "Be concise." },
          { role: "user", content: "hello" },
        ],
        temperature: 0.2,
        top_p: 0.9,
        service_tier: "auto",
        response_format: { type: "json_object" },
        tools: [
          {
            type: "function",
            function: {
              name: "lookup_status",
              description: "Look up runtime status.",
              parameters: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
          },
        ],
      });
      expect((completion.choices?.[0]?.message as Record<string, unknown> | undefined)?.content).toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
    }

    const tools = Array.isArray(payloadBody?.tools) ? (payloadBody.tools as Array<Record<string, unknown>>) : [];

    expect(requestedUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(authorizationHeader).toBe("Bearer codex-access-token");
    expect(payloadBody).toMatchObject({
      model: "gpt-5.5",
      instructions: "Be concise.",
      stream: true,
      store: false,
      parallel_tool_calls: true,
      text: { verbosity: "low" },
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    });
    expect(tools[0]).toMatchObject({
      type: "function",
      name: "lookup_status",
      description: "Look up runtime status.",
    });
    expect(payloadBody?.max_output_tokens).toBeUndefined();
    expect(payloadBody?.temperature).toBeUndefined();
    expect(payloadBody?.top_p).toBeUndefined();
    expect(payloadBody?.service_tier).toBeUndefined();
    expect(payloadBody?.text).toEqual({ verbosity: "low" });
  });

  it("uses the Codex Responses Lite envelope for GPT-5.6 subscription tools", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;
    let payloadBody: Record<string, unknown> | undefined;
    let responsesLiteHeader: string | null = null;

    globalThis.fetch = vi.fn(async (_input, init) => {
      const headers = new Headers(init?.headers);
      responsesLiteHeader = headers.get("x-openai-internal-codex-responses-lite");
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return new Response(
        [
          'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_status","name":"lookup_status","arguments":""}}',
          "",
          'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_status","name":"lookup_status","arguments":"{}"}}',
          "",
          'data: {"type":"response.completed","response":{"id":"resp_codex_lite","model":"gpt-5.6-sol","output":[],"usage":{"input_tokens":8,"output_tokens":2,"total_tokens":10}}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    try {
      const completion = await service.chatCompletions({
        providerId: "openai-codex",
        model: "openai-codex/gpt-5.6-sol",
        messages: [
          { role: "developer", content: "Use the supplied tool." },
          { role: "user", content: "Check status." },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup_status",
              description: "Look up runtime status.",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
          },
        ],
        tool_choice: "required",
        parallel_tool_calls: true,
      });

      expect((completion.choices?.[0]?.message as Record<string, unknown> | undefined)?.tool_calls).toEqual([
        {
          id: "call_status",
          type: "function",
          function: { name: "lookup_status", arguments: "{}" },
        },
      ]);

      const streamChunks: Array<Record<string, unknown>> = [];
      for await (const chunk of service.chatCompletionsStream({
        providerId: "openai-codex",
        model: "openai-codex/gpt-5.6-sol",
        messages: [
          { role: "developer", content: "Use the supplied tool." },
          { role: "user", content: "Check status." },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup_status",
              description: "Look up runtime status.",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
          },
        ],
      })) {
        streamChunks.push(chunk);
      }
      expect(streamChunks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            choices: [
              expect.objectContaining({
                delta: expect.objectContaining({
                  tool_calls: [expect.objectContaining({ function: { name: "lookup_status", arguments: "{}" } })],
                }),
              }),
            ],
          }),
          expect.objectContaining({
            choices: [expect.objectContaining({ finish_reason: "tool_calls" })],
          }),
        ]),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(responsesLiteHeader).toBe("true");
    expect(payloadBody?.instructions).toBeUndefined();
    expect(payloadBody?.tools).toBeUndefined();
    expect(payloadBody).toMatchObject({
      model: "gpt-5.6-sol",
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { context: "all_turns" },
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [expect.objectContaining({ type: "function", name: "lookup_status" })],
        },
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Use the supplied tool." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Check status." }],
        },
      ],
    });
  });

  it("allows bounded Codex Responses Lite streams with more than 2048 reasoning events", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;
    const reasoningEvents = Array.from(
      { length: 2_049 },
      (_entry, index) =>
        `data: {"type":"response.reasoning_summary_text.delta","sequence_number":${index},"delta":"r"}`,
    );

    globalThis.fetch = vi.fn(async () => {
      return new Response(
        [
          ...reasoningEvents,
          'data: {"type":"response.output_text.delta","delta":"ok","response_id":"resp_codex_long_reasoning"}',
          'data: {"type":"response.completed","response":{"id":"resp_codex_long_reasoning","model":"gpt-5.6-sol","output":[],"usage":{"input_tokens":8,"output_tokens":2,"total_tokens":10}}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    try {
      const chunks: Array<Record<string, unknown>> = [];
      for await (const chunk of service.chatCompletionsStream({
        providerId: "openai-codex",
        model: "openai-codex/gpt-5.6-sol",
        messages: [{ role: "user", content: "Research a complex topic." }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toMatchObject({ choices: [{ delta: { content: "ok" } }] });
      expect(chunks[1]).toMatchObject({ choices: [{ finish_reason: "stop" }] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("collects bounded Codex Responses Lite streams with more than 2048 reasoning events", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;
    const reasoningEvents = Array.from(
      { length: 2_049 },
      (_entry, index) =>
        `data: {"type":"response.reasoning_summary_text.delta","sequence_number":${index},"delta":"r"}`,
    );

    globalThis.fetch = vi.fn(async () => {
      return new Response(
        [
          ...reasoningEvents,
          'data: {"type":"response.output_text.delta","delta":"ok","response_id":"resp_codex_long_reasoning"}',
          'data: {"type":"response.completed","response":{"id":"resp_codex_long_reasoning","model":"gpt-5.6-sol","output":[],"usage":{"input_tokens":8,"output_tokens":2,"total_tokens":10}}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    try {
      const completion = await service.chatCompletions({
        providerId: "openai-codex",
        model: "openai-codex/gpt-5.6-sol",
        messages: [{ role: "user", content: "Research a complex topic." }],
      });

      expect(completion.choices?.[0]?.message).toMatchObject({ content: "ok" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retains the default event limit for non-Lite Codex Responses streams", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;
    const reasoningEvents = Array.from(
      { length: 2_049 },
      (_entry, index) =>
        `data: {"type":"response.reasoning_summary_text.delta","sequence_number":${index},"delta":"r"}`,
    );

    globalThis.fetch = vi.fn(async () => {
      return new Response(
        [
          ...reasoningEvents,
          'data: {"type":"response.completed","response":{"id":"resp_codex_guard","model":"gpt-5.5","output":[]}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    try {
      const consume = async (): Promise<void> => {
        for await (const _chunk of service.chatCompletionsStream({
          providerId: "openai-codex",
          model: "openai-codex/gpt-5.5",
          messages: [{ role: "user", content: "hello" }],
        })) {
          // Consume the provider stream to exercise its event guard.
        }
      };

      await expect(consume()).rejects.toThrow("provider stream exceeded 2048 events.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("adapts non-stream OpenAI Codex chat calls from the stream-only Responses bridge", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;
    let payloadBody: Record<string, unknown> | undefined;

    globalThis.fetch = vi.fn(async (_input, init) => {
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"hel","response_id":"resp_codex_chat"}',
          "",
          'data: {"type":"response.output_text.delta","delta":"lo","response_id":"resp_codex_chat"}',
          "",
          'data: {"type":"response.completed","response":{"id":"resp_codex_chat","model":"gpt-5.5","output":[],"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const completion = await service.chatCompletions({
        providerId: "openai-codex",
        model: "openai-codex/gpt-5.5",
        messages: [{ role: "user", content: "hello" }],
      });

      expect((completion.choices?.[0]?.message as Record<string, unknown> | undefined)?.content).toBe("hello");
      expect(completion.usage?.total_tokens).toBe(6);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(payloadBody).toMatchObject({
      model: "gpt-5.5",
      stream: true,
      store: false,
    });
  });

  it("parses named OpenAI Codex SSE events even when the bridge omits an event-stream content type", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn(async () => {
      return new Response(
        [
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"ok","response_id":"resp_codex_chat"}',
          "",
          "event: response.completed",
          'data: {"type":"response.completed","response":{"id":"resp_codex_chat","model":"gpt-5.5","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const chunks: Array<Record<string, unknown>> = [];
      for await (const chunk of service.chatCompletionsStream({
        providerId: "openai-codex",
        model: "openai-codex/gpt-5.5",
        messages: [{ role: "user", content: "hello" }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toMatchObject({
        choices: [{ delta: { content: "ok" } }],
      });
      expect(chunks.at(-1)).toMatchObject({
        choices: [{ finish_reason: "stop" }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves explicit OpenAI Codex Responses verbosity and parallel tool call settings", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;
    let payloadBody: Record<string, unknown> | undefined;

    globalThis.fetch = vi.fn(async (_input, init) => {
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"ok","response_id":"resp_codex_chat"}',
          "",
          'data: {"type":"response.completed","response":{"id":"resp_codex_chat","model":"gpt-5.5","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      await service.chatCompletions({
        providerId: "openai-codex",
        model: "openai-codex/gpt-5.5",
        messages: [{ role: "user", content: "hello" }],
        verbosity: "high",
        parallel_tool_calls: false,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(payloadBody).toMatchObject({
      store: false,
      parallel_tool_calls: false,
      text: { verbosity: "high" },
    });
  });

  // SECURITY (codex finding #15): `exportConfigFile` is called by the GET
  // /api/v1/llm/config endpoint, which is reachable to device/companion
  // tokens. Previously the export included `provider.request.headers`,
  // which can hold `Authorization`/`X-API-Key` values. The export must
  // now strip headers entirely. The legacy normalisation still merges
  // `headers` into `request.headers` internally, but the export must
  // hide both.
  it("scrubs legacy and canonical headers from exported provider config (codex #15)", () => {
    const config: LlmConfigFile = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
          headers: { "X-Legacy": "1", Authorization: "Bearer secret-legacy-bearer" },
          request: {
            headers: { "X-Canonical": "1", Authorization: "Bearer secret-canonical-bearer" },
          },
        },
      ],
    };

    const service = new LlmService(config, process.env, { secretStore: createNoopSecretStore() });
    const exported = service.exportConfigFile();

    expect(exported.providers[0]?.request?.headers).toBeUndefined();
    expect(exported.providers[0]?.headers).toBeUndefined();
    // Defence in depth — the exported JSON must not contain either bearer
    // value as a substring, even via some unexpected pass-through field.
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain("secret-legacy-bearer");
    expect(serialized).not.toContain("secret-canonical-bearer");
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
          data: [{ b64_json: "aW1hZ2UtYnl0ZXM=" }],
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
          data: [{ b64_json: "ZWRpdGVkLWltYWdl" }],
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
          data: [{ b64_json: "Z29vZ2xlLWltYWdlLWJ5dGVz" }],
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

  it("posts OpenAI Codex image requests through Responses with OAuth bearer auth", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let authorizationHeader = "";
    let payloadBody: Record<string, unknown> | undefined;

    globalThis.fetch = vi.fn(async (input, init) => {
      requestedUrl = String(input);
      const headers = new Headers(init?.headers);
      authorizationHeader = headers.get("authorization") ?? "";
      payloadBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      return new Response(
        [
          'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"aW1hZ2UtYnl0ZXM=","revised_prompt":"Rendered prompt"}}',
          'data: {"type":"response.completed","response":{"model":"gpt-image-2","output":[],"usage":{"input_tokens":0,"output_tokens":0,"cost_usd":0}}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const response = await service.generateImage({
        providerId: "openai-codex",
        prompt: "Generate a neon operations console",
        size: "1024x1024",
        responseFormat: "b64_json",
        referenceImages: [
          {
            bytesBase64: "cmVmZXJlbmNl",
            mimeType: "image/png",
            fileName: "reference.png",
          },
        ],
      });
      expect(response.operation).toBe("edit");
      expect(response.model).toBe("gpt-image-2");
      expect(response.data).toEqual([
        {
          b64Json: "aW1hZ2UtYnl0ZXM=",
          revisedPrompt: "Rendered prompt",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const tools = payloadBody?.tools as Array<Record<string, unknown>>;
    const input = payloadBody?.input as Array<Record<string, unknown>>;

    expect(requestedUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(authorizationHeader).toBe("Bearer codex-access-token");
    expect(payloadBody).toMatchObject({
      model: "gpt-5.4",
      instructions: "You are an image generation assistant.",
      stream: true,
      store: false,
      tool_choice: { type: "image_generation" },
    });
    expect(tools[0]).toMatchObject({
      type: "image_generation",
      model: "gpt-image-2",
      size: "1024x1024",
    });
    expect(input[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "input_text", text: "Generate a neon operations console" }),
        expect.objectContaining({ type: "input_image", image_url: "data:image/png;base64,cmVmZXJlbmNl" }),
      ]),
    );
  });

  it("rejects OpenAI Codex image responses whose content-length exceeds the bounded reader limit", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn(
      async () =>
        new Response("", {
          status: 200,
          headers: {
            "content-length": String(64 * 1024 * 1024 + 1),
            "content-type": "text/event-stream",
          },
        }),
    ) as unknown as typeof fetch;

    try {
      await expect(
        service.generateImage({
          providerId: "openai-codex",
          prompt: "Generate a bounded response proof",
          responseFormat: "b64_json",
        }),
      ).rejects.toMatchObject({
        code: "EXTERNAL_SERVICE_FAILED",
        httpStatus: 502,
        message: "OpenAI Codex image generation returned a response larger than the supported limit.",
        details: {
          service: "openai-codex",
          operation: "image_generation",
          reason: "response_body_limit",
          retryable: false,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects malformed OpenAI Codex image response bodies", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn(
      async () =>
        new Response(["data: {not-json}", "data: [DONE]", ""].join("\n\n"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ) as unknown as typeof fetch;

    try {
      await expect(
        service.generateImage({
          providerId: "openai-codex",
          prompt: "Generate malformed response proof",
          responseFormat: "b64_json",
        }),
      ).rejects.toMatchObject({
        code: "EXTERNAL_SERVICE_FAILED",
        httpStatus: 502,
        message: "OpenAI Codex image generation returned a malformed response.",
        details: {
          reason: "response_body_malformed",
          retryable: true,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps OpenAI Codex image timeouts before response headers to a typed provider failure", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => reject(new DOMException("The operation timed out", "TimeoutError")), {
            once: true,
          });
        }),
    ) as unknown as typeof fetch;

    try {
      await expect(
        service.generateImage({
          providerId: "openai-codex",
          prompt: "Generate dispatch timeout proof",
          responseFormat: "b64_json",
          timeoutMs: 20,
        }),
      ).rejects.toMatchObject({
        code: "EXTERNAL_SERVICE_FAILED",
        httpStatus: 502,
        message: "OpenAI Codex image generation timed out before the provider finished sending the response.",
        details: {
          reason: "response_body_timeout",
          retryable: true,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps incomplete OpenAI Codex image event streams to a typed provider failure", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn(
      async () =>
        new Response(["data: [DONE]", ""].join("\n\n"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ) as unknown as typeof fetch;

    try {
      await expect(
        service.generateImage({
          providerId: "openai-codex",
          prompt: "Generate incomplete response proof",
          responseFormat: "b64_json",
        }),
      ).rejects.toMatchObject({
        code: "EXTERNAL_SERVICE_FAILED",
        httpStatus: 502,
        message: "OpenAI Codex image generation returned an incomplete response.",
        details: {
          reason: "response_body_incomplete",
          retryable: true,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps completed OpenAI Codex image responses without image payloads to a typed provider failure", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          [
            'data: {"type":"response.completed","response":{"id":"resp_no_image","model":"gpt-image-2","output":[]}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    ) as unknown as typeof fetch;

    try {
      await expect(
        service.generateImage({
          providerId: "openai-codex",
          prompt: "Generate no payload response proof",
          responseFormat: "b64_json",
        }),
      ).rejects.toMatchObject({
        code: "EXTERNAL_SERVICE_FAILED",
        httpStatus: 502,
        message: "OpenAI Codex image generation returned no image payload.",
        details: {
          reason: "response_body_no_payload",
          retryable: true,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps oversized OpenAI Codex image event streams to a typed provider failure", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;
    const eventLines = Array.from(
      { length: 514 },
      (_entry, index) =>
        `data: {"type":"response.output_text.delta","sequence_number":${index},"delta":"event-${index}"}`,
    );

    globalThis.fetch = vi.fn(
      async () =>
        new Response([...eventLines, "data: [DONE]", ""].join("\n\n"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ) as unknown as typeof fetch;

    try {
      await expect(
        service.generateImage({
          providerId: "openai-codex",
          prompt: "Generate event limit response proof",
          responseFormat: "b64_json",
        }),
      ).rejects.toMatchObject({
        code: "EXTERNAL_SERVICE_FAILED",
        httpStatus: 502,
        message: "OpenAI Codex image generation returned too many response events.",
        details: {
          reason: "response_body_event_limit",
          retryable: false,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the configured OpenAI Codex image timeout while reading the response body", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Intentionally leave the body open so the configured reader deadline owns the failure.
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    ) as unknown as typeof fetch;

    try {
      await expect(
        service.generateImage({
          providerId: "openai-codex",
          prompt: "Generate timeout response proof",
          responseFormat: "b64_json",
          timeoutMs: 20,
        }),
      ).rejects.toMatchObject({
        code: "EXTERNAL_SERVICE_FAILED",
        httpStatus: 502,
        message: "OpenAI Codex image generation timed out before the provider finished sending the response.",
        details: {
          reason: "response_body_timeout",
          retryable: true,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps empty OpenAI Codex image response bodies to a typed provider failure", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ) as unknown as typeof fetch;

    try {
      await expect(
        service.generateImage({
          providerId: "openai-codex",
          prompt: "Generate empty response proof",
          responseFormat: "b64_json",
        }),
      ).rejects.toMatchObject({
        code: "EXTERNAL_SERVICE_FAILED",
        httpStatus: 502,
        message: "OpenAI Codex image generation returned an empty response.",
        details: {
          reason: "response_body_missing",
          retryable: true,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps an aborted OpenAI Codex image response read to the same typed timeout", async () => {
    const secretStore = createTrackedSecretStore({
      "provider:openai-codex:oauth": JSON.stringify({
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: Date.now() + 10 * 60_000,
        updatedAt: Date.now(),
      }),
    });
    const service = new LlmService(createCodexConfig(), process.env, { secretStore });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              queueMicrotask(() => controller.error(new DOMException("The operation timed out", "TimeoutError")));
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    ) as unknown as typeof fetch;

    try {
      await expect(
        service.generateImage({
          providerId: "openai-codex",
          prompt: "Generate aborted response proof",
          responseFormat: "b64_json",
        }),
      ).rejects.toMatchObject({
        code: "EXTERNAL_SERVICE_FAILED",
        httpStatus: 502,
        details: {
          reason: "response_body_timeout",
          retryable: true,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects malformed provider image base64 and data URLs", async () => {
    const service = new LlmService(
      {
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
      },
      process.env,
      { secretStore: createNoopSecretStore() },
    );
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ b64_json: "not-base64!" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ) as unknown as typeof fetch;
      await expect(
        service.generateImage({
          providerId: "openai",
          prompt: "bad base64",
          responseFormat: "b64_json",
        }),
      ).rejects.toThrow("image generation result must be valid base64");

      globalThis.fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ url: "data:image/png;base64,not-base64!" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ) as unknown as typeof fetch;
      await expect(
        service.generateImage({
          providerId: "openai",
          prompt: "bad data URL",
        }),
      ).rejects.toThrow("image generation data URL must be a valid base64 data URL");
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  it("rejects TLS material paths outside configured read roots before fetching", async () => {
    const allowedDir = mkdtempSync(join(tmpdir(), "llm-service-tls-allowed-"));
    const disallowedDir = mkdtempSync(join(tmpdir(), "llm-service-tls-disallowed-"));
    const caPath = join(disallowedDir, "ca.pem");
    writeFileSync(caPath, "test-ca");

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
            tls: {
              caCertPath: caPath,
            },
          },
        },
      ],
    };

    const service = new LlmService(config, process.env, {
      networkAllowlist: ["api.openai.com"],
      secretStore: createNoopSecretStore(),
      tlsPathPolicy: {
        writeJailRoots: [],
        readOnlyRoots: [allowedDir],
      },
    });
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      await expect(
        service.chatCompletions({
          providerId: "openai",
          messages: [{ role: "user", content: "hello" }],
        }),
      ).rejects.toThrow(/outside read allowlist/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(allowedDir, { recursive: true, force: true });
      rmSync(disallowedDir, { recursive: true, force: true });
    }
  });

  it("stores submitted provider keys in the secret store and clears plaintext runtime config", () => {
    const secretStore = createTrackedSecretStore({});
    const service = new LlmService(
      {
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
      },
      process.env,
      { secretStore },
    );

    const runtime = service.updateRuntimeConfig({
      upsertProvider: {
        providerId: "openai",
        apiKey: " sk-live ",
      },
    });

    expect(secretStore.getProviderApiKey("openai")).toBe("sk-live");
    expect(runtime.providers[0]).toMatchObject({
      providerId: "openai",
      hasApiKey: true,
      apiKeySource: "keychain",
    });
    expect(service.exportConfigFile().providers[0]?.apiKey).toBeUndefined();
  });

  it("reports keychain failures and rejects active model selection without a provider", () => {
    const unavailableSecretStore = {
      ...createNoopSecretStore(),
      setProviderApiKey: () => {
        throw new SecretStoreUnavailableError("PasswordVault unavailable");
      },
    } as SecretStoreService;
    const service = new LlmService(
      {
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
      },
      process.env,
      { secretStore: unavailableSecretStore },
    );

    expect(() => service.setProviderApiKey("openai", "sk-live")).toThrow(/Secure keychain is unavailable/);
    expect(() => service.updateRuntimeConfig({ activeModel: "gpt-5.4-mini" })).toThrow(
      "Select an active LLM provider before choosing a model.",
    );

    expect(service.updateRuntimeConfig({ activeModel: "   " })).toMatchObject({
      activeProviderId: "",
      activeModel: "",
    });
  });

  it("falls back to default model catalogs when provider model discovery fails or returns empty", async () => {
    const service = new LlmService(
      {
        activeProviderId: "openai",
        providers: [
          {
            providerId: "openai",
            label: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            apiStyle: "openai-responses",
            defaultModel: "gpt-5.4-mini",
            apiKey: "inline-key",
          },
        ],
      },
      process.env,
      { secretStore: createNoopSecretStore() },
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("models offline");
    }) as unknown as typeof fetch;

    try {
      await expect(service.listModelsWithSource("openai")).resolves.toMatchObject({
        source: "error_fallback",
        warning: "models offline",
        items: expect.arrayContaining([expect.objectContaining({ id: "gpt-5.4-mini" })]),
      });

      globalThis.fetch = vi.fn(
        async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
      ) as unknown as typeof fetch;
      await expect(service.listModelsWithSource("openai")).resolves.toMatchObject({
        source: "template_fallback",
        warning: "Provider returned no models. Falling back to GoatCitadel's provider template.",
        items: expect.arrayContaining([expect.objectContaining({ id: "gpt-5.4-mini" })]),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function createCodexConfig(): LlmConfigFile {
  return {
    activeProviderId: "openai-codex",
    activeModel: "openai-codex/gpt-5.5",
    providers: [
      {
        providerId: "openai-codex",
        label: "OpenAI Codex (ChatGPT OAuth)",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        apiStyle: "openai-codex-responses",
        defaultModel: "gpt-5.5",
        authMode: "codex-oauth",
      },
    ],
  };
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
    setSecret: (account: string, secret: string) => {
      secrets.set(account, secret);
    },
    getSecret: (account: string) => {
      gets += 1;
      return secrets.get(account);
    },
    deleteSecret: (account: string) => {
      secrets.delete(account);
    },
    status: (providerId: string) => ({
      providerId,
      hasSecret: secrets.has(providerId),
      source: secrets.has(providerId) ? "keychain" : "none",
    }),
    getCalls: () => gets,
  } as unknown as SecretStoreService & { getCalls: () => number };
}
