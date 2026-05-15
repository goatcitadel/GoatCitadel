import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { llmRoutes } from "./llm.js";

describe("llm route validation and error mapping loop 23", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("rejects invalid provider TLS shapes before updating runtime config", async () => {
    const updateLlmConfig = vi.fn();
    app = buildApp({ updateLlmConfig });

    const missingClientKey = await app.inject({
      method: "PATCH",
      url: "/api/v1/llm/config",
      payload: {
        upsertProvider: {
          providerId: "openai",
          baseUrl: "https://api.openai.com/v1",
          request: {
            tls: {
              clientCertPath: "cert.pem",
            },
          },
        },
      },
    });
    const conflictingTrust = await app.inject({
      method: "PATCH",
      url: "/api/v1/llm/config",
      payload: {
        upsertProvider: {
          providerId: "openai",
          baseUrl: "https://api.openai.com/v1",
          request: {
            tls: {
              insecureSkipVerify: true,
              caCertPath: "ca.pem",
            },
          },
        },
      },
    });

    expect(missingClientKey.statusCode).toBe(400);
    expect(conflictingTrust.statusCode).toBe(400);
    expect(updateLlmConfig).not.toHaveBeenCalled();
    expect(JSON.stringify(missingClientKey.json())).toContain("clientCertPath and clientKeyPath");
    expect(JSON.stringify(conflictingTrust.json())).toContain("caCertPath cannot be combined");
  });

  it("validates model preview auth, OAuth polling, and maps model discovery failures", async () => {
    const previewLlmModels = vi.fn();
    const pollOpenAICodexOAuthDeviceFlow = vi.fn();
    const listLlmModels = vi.fn(async () => {
      throw new Error("provider offline");
    });
    app = buildApp({
      listLlmModels,
      previewLlmModels,
      pollOpenAICodexOAuthDeviceFlow,
    });

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/llm/models/preview",
      payload: {
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
        request: {
          auth: {
            type: "header",
            valueEnv: "OPENAI_API_KEY",
          },
        },
      },
    });
    const poll = await app.inject({
      method: "POST",
      url: "/api/v1/llm/providers/openai-codex/oauth/device/poll",
      payload: {},
    });
    const models = await app.inject({
      method: "GET",
      url: "/api/v1/llm/models?providerId=openai",
    });

    expect(preview.statusCode).toBe(400);
    expect(poll.statusCode).toBe(400);
    expect(models.statusCode).toBe(400);
    expect(models.json()).toEqual({ error: "provider offline" });
    expect(previewLlmModels).not.toHaveBeenCalled();
    expect(pollOpenAICodexOAuthDeviceFlow).not.toHaveBeenCalled();
    expect(listLlmModels).toHaveBeenCalledWith("openai");
  });
});

function buildApp(llmOverrides: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", {
    llm: {
      createChatCompletion: vi.fn(),
      deleteOpenAICodexOAuthCredential: vi.fn(),
      generateImage: vi.fn(),
      getLlmConfigWithDetails: vi.fn(),
      getOpenAICodexOAuthStatus: vi.fn(),
      listLlmModels: vi.fn(),
      listLlmProviders: vi.fn(() => []),
      pollOpenAICodexOAuthDeviceFlow: vi.fn(),
      previewLlmModels: vi.fn(),
      startOpenAICodexOAuthDeviceFlow: vi.fn(),
      updateLlmConfig: vi.fn(),
      ...llmOverrides,
    },
  } as never);
  void next.register(llmRoutes);
  return next;
}
