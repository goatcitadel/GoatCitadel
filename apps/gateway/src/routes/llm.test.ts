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
      expect.objectContaining({
        operationId: expect.stringMatching(/^http:llm:chat:/),
        dispatchGeneration: expect.any(String),
        callKind: "chat_initial",
        workspaceId: "default",
        taskId: expect.stringMatching(/^http:llm:chat:/),
      }),
    );
  });

  it("projects direct model completions without mutating provider results", async () => {
    const rawResult = {
      id: "cmpl-secret",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Authorization: Bearer direct-model-secret" },
        },
      ],
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    };
    const createChatCompletion = vi.fn(async () => rawResult);
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
      payload: {
        providerId: "openai",
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("direct-model-secret");
    expect(response.json()).toMatchObject({
      choices: [{ message: { content: "Authorization: [REDACTED]" } }],
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });
    expect(rawResult.choices[0]!.message.content).toContain("direct-model-secret");
  });

  it("derives replay-stable secret-free usage identity from the idempotency key", async () => {
    const createChatCompletion = vi.fn(async () => ({
      id: "cmpl-stable",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
    }));
    app = Fastify();
    app.decorateRequest("idempotencyKey", "");
    app.addHook("onRequest", async (request) => {
      const value = request.headers["idempotency-key"];
      request.idempotencyKey = typeof value === "string" ? value : "";
    });
    app.decorate("services", { llm: { createChatCompletion } } as never);
    await app.register(llmRoutes);

    const payload = { messages: [{ role: "user", content: "hello" }] };
    const rawKey = "operator-secret-idempotency-key";
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat-completions",
      headers: { "idempotency-key": rawKey },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat-completions",
      headers: { "idempotency-key": rawKey },
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstAttribution = createChatCompletion.mock.calls[0]?.[1];
    const secondAttribution = createChatCompletion.mock.calls[1]?.[1];
    expect(firstAttribution).toEqual(secondAttribution);
    expect(firstAttribution).toMatchObject({
      operationId: expect.stringMatching(/^http:llm:chat:[a-f0-9]{64}$/),
      dispatchGeneration: expect.stringMatching(/^http-idempotency:[a-f0-9]{64}$/),
      workspaceId: "default",
    });
    expect(JSON.stringify(firstAttribution)).not.toContain(rawKey);
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
        reasoning: { effort: "extreme" },
      }),
    });

    expect(response.statusCode).toBe(400);
  });

  it("accepts max and ultra for model-metadata validation at the Gateway owner", async () => {
    const createChatCompletion = vi.fn(async (request) => ({ id: "reasoning", choices: [], echo: request }));
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

    for (const effort of ["max", "ultra"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/llm/chat-completions",
        payload: { messages: [{ role: "user", content: "think" }], reasoning: { effort } },
      });
      expect(response.statusCode).toBe(200);
    }
    expect(createChatCompletion.mock.calls.map(([request]) => request.reasoning?.effort)).toEqual(["max", "ultra"]);
  });

  it("accepts secret-free Vertex auth posture without credential material", async () => {
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
      payload: {
        expectedRevision: 5,
        upsertProvider: {
          providerId: "vertex",
          baseUrl:
            "https://us-central1-aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/us-central1/endpoints/openapi",
          authMode: "google-adc",
          defaultModel: "google/gemini-2.5-flash",
          googleCloud: {
            projectIdEnv: "GOOGLE_CLOUD_PROJECT",
            location: "us-central1",
            endpointId: "openapi",
          },
          capabilities: { reasoning: true, reasoningEfforts: ["low", "medium", "high"] },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateLlmConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        upsertProvider: expect.objectContaining({
          authMode: "google-adc",
          googleCloud: { projectIdEnv: "GOOGLE_CLOUD_PROJECT", location: "us-central1", endpointId: "openapi" },
        }),
      }),
    );
    expect(JSON.stringify(updateLlmConfig.mock.calls)).not.toMatch(/private_key|refresh_token|access_token/u);
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
        expectedRevision: 5,
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
        expectedRevision: 5,
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
        expectedRevision: 5,
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
        expectedRevision: 5,
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
      source: "template_fallback" as const,
      warning: "template catalog",
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
      source: "template_fallback",
      warning: "template catalog",
    });
  });

  it("returns provider advice as an advisory no-mutation response", async () => {
    const getProviderAdvice = vi.fn(() => ({
      generatedAt: "2026-05-22T00:00:00.000Z",
      preference: "low_cost",
      candidates: [
        {
          providerId: "openai",
          providerLabel: "OpenAI",
          model: "gpt-5.4-mini",
          configured: true,
          estimatedCostUsd: 0.1,
          costSource: "estimated",
          fitScore: 0.8,
          riskNotes: ["No immediate advisory risk noted."],
          requiredKeys: [],
        },
      ],
      advisoryOnly: true,
      mutationPerformed: false,
      warnings: ["Provider advice is advisory only; no provider settings or keys were changed."],
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
        getProviderAdvice,
      },
    } as never);
    await app.register(llmRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/provider-advice",
      headers: {
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
        preference: "low_cost",
        requireConfiguredKey: true,
        maxCandidates: 2,
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(getProviderAdvice).toHaveBeenCalledWith({
      preference: "low_cost",
      requireConfiguredKey: true,
      maxCandidates: 2,
    });
    expect(response.json()).toMatchObject({
      advisoryOnly: true,
      mutationPerformed: false,
      candidates: [expect.objectContaining({ providerId: "openai" })],
    });
  });

  it("exposes runtime measurements, local engines, and eval proof records", async () => {
    const listLlmRuntimeMeasurements = vi.fn(() => ({
      generatedAt: "2026-05-29T00:00:00.000Z",
      items: [{ measurementId: "measure-1", providerId: "openai", model: "gpt-5", metrics: {} }],
      warnings: [],
    }));
    const listLlmLocalEngines = vi.fn(() => ({
      generatedAt: "2026-05-29T00:00:00.000Z",
      items: [{ engineKind: "ollama", label: "Ollama", configured: true }],
      warnings: [],
    }));
    const listLlmEvalProofRuns = vi.fn(() => ({
      generatedAt: "2026-05-29T00:00:00.000Z",
      items: [{ runId: "proof-1", status: "completed" }],
    }));
    const exportLlmEvalProofRuns = vi.fn(() => ({
      version: "llm.eval_proof_export.v1",
      generatedAt: "2026-05-29T00:00:00.000Z",
      format: "json",
      contentType: "application/json",
      filename: "goatcitadel-llm-eval-proof.json",
      sourceEndpoint: "/api/v1/llm/eval-proof?limit=2",
      posture: {
        readOnly: true,
        sideEffectPosture: "audit_only",
        note: "read-only",
      },
      runs: [{ runId: "proof-1", status: "completed" }],
      content: "{}",
    }));
    const runLlmEvalProof = vi.fn(() => ({
      generatedAt: "2026-05-29T00:00:00.000Z",
      run: { runId: "proof-2", status: "completed", results: [] },
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
        listLlmRuntimeMeasurements,
        listLlmLocalEngines,
        listLlmEvalProofRuns,
        exportLlmEvalProofRuns,
        runLlmEvalProof,
      },
    } as never);
    await app.register(llmRoutes);

    const measurements = await app.inject({
      method: "GET",
      url: "/api/v1/llm/runtime-measurements?providerId=openai&limit=3",
    });
    const engines = await app.inject({ method: "GET", url: "/api/v1/llm/local-engines" });
    const proofRuns = await app.inject({ method: "GET", url: "/api/v1/llm/eval-proof?limit=2" });
    const proofExport = await app.inject({ method: "GET", url: "/api/v1/llm/eval-proof/export?limit=2" });
    const proofRun = await app.inject({
      method: "POST",
      url: "/api/v1/llm/eval-proof",
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify({ prompt: "compare", candidates: [{ providerId: "openai", model: "gpt-5" }] }),
    });

    expect(measurements.statusCode).toBe(200);
    expect(listLlmRuntimeMeasurements).toHaveBeenCalledWith({ providerId: "openai", limit: 3 });
    expect(engines.statusCode).toBe(200);
    expect(listLlmLocalEngines).toHaveBeenCalledTimes(1);
    expect(proofRuns.statusCode).toBe(200);
    expect(listLlmEvalProofRuns).toHaveBeenCalledWith(2);
    expect(proofExport.statusCode).toBe(200);
    expect(exportLlmEvalProofRuns).toHaveBeenCalledWith(2);
    expect(proofExport.json()).toMatchObject({
      version: "llm.eval_proof_export.v1",
      posture: { readOnly: true, sideEffectPosture: "audit_only" },
    });
    expect(proofRun.statusCode).toBe(200);
    expect(runLlmEvalProof).toHaveBeenCalledWith({
      prompt: "compare",
      candidates: [{ providerId: "openai", model: "gpt-5" }],
    });
  });

  it("accepts image generation requests", async () => {
    const generatedBytes =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const rawResult = {
      operation: "edit",
      providerId: "openai",
      model: "gpt-image-2",
      data: [
        {
          b64Json: generatedBytes,
          revisedPrompt: "Authorization: Bearer generated-image-secret",
        },
      ],
    };
    const generateImage = vi.fn(async () => rawResult);

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
    expect(response.body).not.toContain("generated-image-secret");
    expect(response.json()).toMatchObject({
      data: [{ b64Json: generatedBytes, revisedPrompt: "Authorization: [REDACTED]" }],
    });
    expect(rawResult.data[0]!.revisedPrompt).toContain("generated-image-secret");
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
      expect.objectContaining({
        operationId: expect.stringMatching(/^http:llm:image:/),
        dispatchGeneration: expect.any(String),
        callKind: "image_generation",
        workspaceId: "default",
        taskId: expect.stringMatching(/^http:llm:image:/),
      }),
    );
  });

  it.each([
    ["/api/v1/llm/chat-completions", "createChatCompletion", { messages: [{ role: "user", content: "hello" }] }],
    ["/api/v1/llm/images", "generateImage", { prompt: "draw a goat" }],
  ] as const)(
    "maps authoritative accounting faults from %s through shared route handling",
    async (url, method, payload) => {
      const accountingError = Object.assign(new Error("canonical usage persistence failed with secret-token"), {
        name: "ModelUsageSettlementError",
      });
      const createChatCompletion = vi.fn(async () => {
        throw accountingError;
      });
      const generateImage = vi.fn(async () => {
        throw accountingError;
      });
      app = Fastify();
      app.decorate("services", {
        llm: {
          createChatCompletion,
          generateImage,
        },
      } as never);
      await app.register(llmRoutes);

      const response = await app.inject({ method: "POST", url, payload });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "Internal server error" });
      expect(response.body).not.toContain("secret-token");
      const invoked = method === "createChatCompletion" ? createChatCompletion : generateImage;
      expect(invoked).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ workspaceId: "default", dispatchGeneration: expect.any(String) }),
      );
    },
  );

  it("projects provider config, discovery, and runtime diagnostics without hiding safe metadata", async () => {
    const rawProvider = {
      providerId: "custom-provider",
      label: "Custom Provider",
      baseUrl: "https://provider.example.test/access-token/provider-path?token=provider-query",
      apiStyle: "openai-chat-completions",
      defaultModel: "custom-model",
      hasApiKey: true,
      apiKeySource: "env",
      authReadiness: {
        status: "configured",
        source: "adc_file",
        liveVerified: false,
        reasonCode: "adc_file_configured",
      },
      diagnostic: {
        authorization: "Bearer provider-short",
        tokenId: "provider-token-id",
        requestCount: 17,
      },
    };
    const rawConfig = {
      activeProviderId: "custom-provider",
      activeModel: "custom-model",
      providers: [rawProvider],
      providerConfigs: [
        {
          providerId: "custom-provider",
          label: "Custom Provider",
          baseUrl: "https://provider.example.test/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "custom-model",
          request: {
            auth: {
              type: "bearer",
              token: "provider-inline-short",
              tokenEnv: "CUSTOM_PROVIDER_TOKEN",
              headerName: "Authorization",
            },
            proxy: {
              url: "https://proxy.example.test/client-secret/proxy-path?token=proxy-query",
              auth: {
                type: "header",
                headerName: "Proxy-Authorization",
                value: "proxy-inline-short",
                valueEnv: "CUSTOM_PROXY_AUTH",
                scheme: "Bearer",
              },
            },
          },
        },
      ],
    };
    const rawModels = {
      items: [{ id: "custom-model" }],
      source: "error_fallback",
      warning:
        "Discovery https://provider.example.test/api-key/model-path?token=model-query failed with Bearer model-short",
      metadata: {
        tokenId: "model-token-id",
        retryCount: 2,
      },
    };
    const rawMeasurements = {
      generatedAt: "2026-07-09T00:00:00.000Z",
      items: [
        {
          measurementId: "measurement-1",
          providerId: "custom-provider",
          model: "custom-model",
          metrics: { promptTokens: 11, completionTokens: 7 },
          error: "Authorization: Bearer measurement-short",
        },
      ],
      warnings: ["Retry https://provider.example.test/token/measurement-path?token=measurement-query"],
    };

    app = Fastify();
    app.decorate("services", {
      llm: {
        listLlmProviders: vi.fn(() => [rawProvider]),
        getLlmConfigWithDetails: vi.fn(() => rawConfig),
        listLlmModels: vi.fn(async () => rawModels),
        listLlmRuntimeMeasurements: vi.fn(() => rawMeasurements),
      },
    } as never);
    await app.register(llmRoutes);

    const providers = await app.inject({ method: "GET", url: "/api/v1/llm/providers" });
    const config = await app.inject({ method: "GET", url: "/api/v1/llm/config" });
    const models = await app.inject({ method: "GET", url: "/api/v1/llm/models?providerId=custom-provider" });
    const measurements = await app.inject({ method: "GET", url: "/api/v1/llm/runtime-measurements" });

    expect(providers.statusCode).toBe(200);
    expect(providers.json().items[0]).toMatchObject({
      providerId: "custom-provider",
      baseUrl: "https://provider.example.test/access-token/[REDACTED]?token=[REDACTED]",
      hasApiKey: true,
      apiKeySource: "env",
      authReadiness: {
        status: "configured",
        source: "adc_file",
        liveVerified: false,
        reasonCode: "adc_file_configured",
      },
      diagnostic: {
        authorization: "[REDACTED]",
        tokenId: "provider-token-id",
        requestCount: 17,
      },
    });
    expect(config.statusCode).toBe(200);
    expect(config.json().providerConfigs[0].request).toMatchObject({
      auth: {
        type: "bearer",
        tokenEnv: "CUSTOM_PROVIDER_TOKEN",
        headerName: "Authorization",
      },
      proxy: {
        url: "https://proxy.example.test/client-secret/[REDACTED]?token=[REDACTED]",
        auth: {
          type: "header",
          headerName: "Proxy-Authorization",
          valueEnv: "CUSTOM_PROXY_AUTH",
          scheme: "Bearer",
        },
      },
    });
    expect(JSON.stringify(config.json())).not.toContain("provider-inline-short");
    expect(JSON.stringify(config.json())).not.toContain("proxy-inline-short");
    expect(models.statusCode).toBe(200);
    expect(models.json()).toMatchObject({
      warning:
        "Discovery https://provider.example.test/api-key/[REDACTED]?token=[REDACTED] failed with Bearer [REDACTED]",
      metadata: { tokenId: "model-token-id", retryCount: 2 },
    });
    expect(measurements.statusCode).toBe(200);
    expect(measurements.json()).toMatchObject({
      items: [
        expect.objectContaining({
          measurementId: "measurement-1",
          metrics: { promptTokens: 11, completionTokens: 7 },
          error: "Authorization: [REDACTED]",
        }),
      ],
      warnings: ["Retry https://provider.example.test/token/[REDACTED]?token=[REDACTED]"],
    });
    expect(rawProvider.diagnostic.authorization).toBe("Bearer provider-short");
    expect(rawConfig.providerConfigs[0]!.request.auth.token).toBe("provider-inline-short");
    expect(rawModels.warning).toContain("model-path");
    expect(rawMeasurements.items[0]!.error).toContain("measurement-short");
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
