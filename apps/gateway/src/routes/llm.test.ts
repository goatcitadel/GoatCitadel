import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { llmRoutes } from "./llm.js";

describe("llm routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("accepts developer messages and OpenAI chat controls", async () => {
    const createChatCompletion = vi.fn(async (request) => ({
      id: "cmpl-1",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
      echo: request,
    }));

    app = Fastify();
    app.decorate("services", {
      llm: {
        createChatCompletion,
        getLlmConfig: vi.fn(),
        listLlmProviders: vi.fn(),
        updateLlmConfig: vi.fn(),
        listLlmModels: vi.fn(),
        previewLlmModels: vi.fn(),
      },
    } as never);
    await app.register(llmRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat-completions",
      headers: {
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
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
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "developer", content: "Be terse." },
          { role: "user", content: "hello" },
        ],
        reasoning: { effort: "none" },
        verbosity: "low",
        service_tier: "flex",
        prompt_cache_retention: "in_memory",
      }),
    );
  });

  it("rejects invalid reasoning controls", async () => {
    app = Fastify();
    app.decorate("services", {
      llm: {
        createChatCompletion: vi.fn(),
        getLlmConfig: vi.fn(),
        listLlmProviders: vi.fn(),
        updateLlmConfig: vi.fn(),
        listLlmModels: vi.fn(),
        previewLlmModels: vi.fn(),
      },
    } as never);
    await app.register(llmRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat-completions",
      headers: {
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
        providerId: "openai",
        model: "gpt-5.4-mini",
        messages: [
          { role: "developer", content: "Be terse." },
          { role: "user", content: "hello" },
        ],
        reasoning: { effort: "max" },
      }),
    });

    expect(response.statusCode).toBe(400);
  });

  it("accepts apiStyle in config update payloads", async () => {
    const updateLlmConfig = vi.fn(async (request) => request);

    app = Fastify();
    app.decorate("services", {
      llm: {
        createChatCompletion: vi.fn(),
        getLlmConfig: vi.fn(),
        listLlmProviders: vi.fn(),
        updateLlmConfig,
        listLlmModels: vi.fn(),
        previewLlmModels: vi.fn(),
      },
    } as never);
    await app.register(llmRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/llm/config",
      headers: {
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
        upsertProvider: {
          providerId: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          apiStyle: "anthropic-messages",
          defaultModel: "claude-sonnet-4-6",
          request: {
            headers: { "X-Trace": "1" },
            auth: { type: "header", headerName: "X-API-Key", valueEnv: "ANTHROPIC_API_KEY" },
            proxy: {
              url: "http://proxy.internal:8080",
              auth: { type: "bearer", tokenEnv: "PROXY_TOKEN" },
              tls: { serverName: "proxy.internal" },
            },
          },
        },
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(updateLlmConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        upsertProvider: expect.objectContaining({
          apiStyle: "anthropic-messages",
          request: expect.objectContaining({
            headers: { "X-Trace": "1" },
            proxy: expect.objectContaining({
              url: "http://proxy.internal:8080",
            }),
          }),
        }),
      }),
    );
  });

  it("accepts OpenAI Codex provider config updates", async () => {
    const updateLlmConfig = vi.fn(async (request) => request);

    app = Fastify();
    app.decorate("services", {
      llm: {
        createChatCompletion: vi.fn(),
        getLlmConfig: vi.fn(),
        listLlmProviders: vi.fn(),
        updateLlmConfig,
        listLlmModels: vi.fn(),
        previewLlmModels: vi.fn(),
      },
    } as never);
    await app.register(llmRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/llm/config",
      headers: {
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
        upsertProvider: {
          providerId: "openai-codex",
          label: "OpenAI Codex (ChatGPT OAuth)",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          apiStyle: "openai-codex-responses",
          authMode: "codex-oauth",
          defaultModel: "gpt-5.5",
        },
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(updateLlmConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        upsertProvider: expect.objectContaining({
          providerId: "openai-codex",
          apiStyle: "openai-codex-responses",
          authMode: "codex-oauth",
        }),
      }),
    );
  });

  it("accepts apiStyle in model preview payloads", async () => {
    const previewLlmModels = vi.fn(async (request) => request);

    app = Fastify();
    app.decorate("services", {
      llm: {
        createChatCompletion: vi.fn(),
        getLlmConfig: vi.fn(),
        listLlmProviders: vi.fn(),
        updateLlmConfig: vi.fn(),
        listLlmModels: vi.fn(),
        previewLlmModels,
      },
    } as never);
    await app.register(llmRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/models/preview",
      headers: {
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiStyle: "openai-responses",
        request: {
          headers: { "X-Preview": "1" },
          proxy: {
            url: "http://proxy.internal:8080",
            auth: { type: "header", headerName: "Proxy-Authorization", valueEnv: "PROXY_AUTH", scheme: "Bearer" },
          },
        },
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(previewLlmModels).toHaveBeenCalledWith(
      expect.objectContaining({
        apiStyle: "openai-responses",
        request: expect.objectContaining({
          headers: { "X-Preview": "1" },
          proxy: expect.objectContaining({
            url: "http://proxy.internal:8080",
          }),
        }),
      }),
    );
  });

  it("returns provider config details on llm config reads", async () => {
    const getLlmConfigWithDetails = vi.fn(() => ({
      activeProviderId: "openai",
      activeModel: "gpt-5.4-mini",
      providers: [],
      providerConfigs: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
          request: {
            proxy: {
              url: "http://proxy.internal:8080",
              auth: { type: "bearer", tokenEnv: "PROXY_TOKEN" },
            },
          },
        },
      ],
    }));

    app = Fastify();
    app.decorate("services", {
      llm: {
        createChatCompletion: vi.fn(),
        getLlmConfigWithDetails,
        listLlmProviders: vi.fn(),
        updateLlmConfig: vi.fn(),
        listLlmModels: vi.fn(),
        previewLlmModels: vi.fn(),
      },
    } as never);
    await app.register(llmRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/llm/config",
    });

    expect(response.statusCode).toBe(200);
    expect(getLlmConfigWithDetails).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({
      providerConfigs: [
        {
          providerId: "openai",
          request: {
            proxy: {
              url: "http://proxy.internal:8080",
            },
          },
        },
      ],
    });
  });

  it("returns model discovery source with model lists", async () => {
    const listLlmModels = vi.fn(async () => ({
      items: [{ id: "gpt-5.5" }],
      source: "fallback" as const,
    }));

    app = Fastify();
    app.decorate("services", {
      llm: {
        createChatCompletion: vi.fn(),
        getLlmConfig: vi.fn(),
        listLlmProviders: vi.fn(),
        updateLlmConfig: vi.fn(),
        listLlmModels,
        previewLlmModels: vi.fn(),
      },
    } as never);
    await app.register(llmRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/llm/models?providerId=openai-codex",
    });

    expect(response.statusCode).toBe(200);
    expect(listLlmModels).toHaveBeenCalledWith("openai-codex");
    expect(response.json()).toEqual({
      items: [{ id: "gpt-5.5" }],
      source: "fallback",
    });
  });

  it("accepts image generation requests", async () => {
    const generateImage = vi.fn(async (request) => ({
      operation: "edit",
      providerId: request.providerId,
      model: request.model,
      data: [],
    }));

    app = Fastify();
    app.decorate("services", {
      llm: {
        createChatCompletion: vi.fn(),
        getLlmConfig: vi.fn(),
        listLlmProviders: vi.fn(),
        updateLlmConfig: vi.fn(),
        listLlmModels: vi.fn(),
        previewLlmModels: vi.fn(),
        generateImage,
      },
    } as never);
    await app.register(llmRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/images",
      headers: {
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
        providerId: "openai",
        model: "gpt-image-2",
        prompt: "Edit this image",
        referenceImages: [
          {
            bytesBase64: "aGVsbG8=",
            mimeType: "image/png",
            fileName: "reference.png",
          },
        ],
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openai",
        model: "gpt-image-2",
        referenceImages: [
          expect.objectContaining({
            fileName: "reference.png",
          }),
        ],
      }),
    );
  });

  it("exposes OpenAI Codex OAuth status, start, poll, and disconnect routes", async () => {
    const getOpenAICodexOAuthStatus = vi.fn(() => ({
      providerId: "openai-codex",
      available: true,
      connected: false,
    }));
    const startOpenAICodexOAuthDeviceFlow = vi.fn(async () => ({
      providerId: "openai-codex",
      flowId: "flow-1",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: "2026-04-24T12:00:00.000Z",
      pollAfterMs: 5000,
    }));
    const pollOpenAICodexOAuthDeviceFlow = vi.fn(async (flowId: string) => ({
      providerId: "openai-codex",
      flowId,
      status: "connected",
      accountLabel: "user@example.com",
    }));
    const deleteOpenAICodexOAuthCredential = vi.fn(() => ({
      providerId: "openai-codex",
      available: true,
      connected: false,
      requiresReauth: false,
    }));

    app = Fastify();
    app.decorate("services", {
      llm: {
        createChatCompletion: vi.fn(),
        getLlmConfig: vi.fn(),
        listLlmProviders: vi.fn(),
        updateLlmConfig: vi.fn(),
        listLlmModels: vi.fn(),
        previewLlmModels: vi.fn(),
        getOpenAICodexOAuthStatus,
        startOpenAICodexOAuthDeviceFlow,
        pollOpenAICodexOAuthDeviceFlow,
        deleteOpenAICodexOAuthCredential,
      },
    } as never);
    await app.register(llmRoutes);

    const status = await app.inject({
      method: "GET",
      url: "/api/v1/llm/providers/openai-codex/oauth/status",
    });
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/llm/providers/openai-codex/oauth/device/start",
    });
    const poll = await app.inject({
      method: "POST",
      url: "/api/v1/llm/providers/openai-codex/oauth/device/poll",
      headers: {
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({ flowId: "flow-1" }),
    });
    const disconnect = await app.inject({
      method: "DELETE",
      url: "/api/v1/llm/providers/openai-codex/oauth",
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ providerId: "openai-codex", connected: false });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({
      providerId: "openai-codex",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    expect(poll.statusCode).toBe(200);
    expect(pollOpenAICodexOAuthDeviceFlow).toHaveBeenCalledWith("flow-1");
    expect(poll.json()).toMatchObject({ status: "connected", accountLabel: "user@example.com" });
    expect(disconnect.statusCode).toBe(200);
    expect(deleteOpenAICodexOAuthCredential).toHaveBeenCalledTimes(1);
  });
});
