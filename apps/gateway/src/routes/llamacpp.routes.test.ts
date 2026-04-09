import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { llamaCppRoutes } from "./llamacpp.js";

describe("llama.cpp runtime routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns runtime status and forwards advisor requests", async () => {
    const getLlamaCppStatus = vi.fn(() => ({
      enabled: true,
      desiredState: "running",
      processState: "running",
      baseUrl: "http://127.0.0.1:8080/v1",
      healthy: true,
      activeModelId: "gemma-4",
      commandSource: "path",
      updatedAt: "2026-04-09T00:00:00.000Z",
    }));
    const adviseLlamaCppRuntime = vi.fn(async () => ({
      profile: {
        platform: "win32",
        arch: "x64",
        cpuCoresLogical: 16,
        systemRamBytes: 64 * 1024 ** 3,
        systemRamFreeBytes: 32 * 1024 ** 3,
        gpus: [],
        notes: [],
      },
      recommended: {
        ctxSize: 8192,
        threads: 8,
        gpuLayers: 0,
        parallel: 1,
        batchSize: 512,
        ubatchSize: 256,
      },
      warnings: [],
    }));

    app = Fastify();
    app.decorate("gateway", {
      getLlamaCppStatus,
      adviseLlamaCppRuntime,
    } as never);
    await app.register(llamaCppRoutes);

    const statusResponse = await app.inject({
      method: "GET",
      url: "/api/v1/llamacpp/status",
    });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json()).toMatchObject({
      healthy: true,
      activeModelId: "gemma-4",
    });

    const advisorResponse = await app.inject({
      method: "POST",
      url: "/api/v1/llamacpp/advisor",
      payload: {
        modelPath: "models/gemma-4-q4.gguf",
        modelId: "gemma-4",
      },
    });
    expect(advisorResponse.statusCode).toBe(200);
    expect(adviseLlamaCppRuntime).toHaveBeenCalledWith({
      modelPath: "models/gemma-4-q4.gguf",
      modelId: "gemma-4",
    });
  });

  it("returns 503 when model discovery fails and rejects invalid advisor payloads", async () => {
    const listLlamaCppModels = vi.fn(async () => {
      throw new Error("llama.cpp offline");
    });

    app = Fastify();
    app.decorate("gateway", {
      listLlamaCppModels,
      adviseLlamaCppRuntime: vi.fn(),
    } as never);
    await app.register(llamaCppRoutes);

    const modelsResponse = await app.inject({
      method: "GET",
      url: "/api/v1/llamacpp/models",
    });
    expect(modelsResponse.statusCode).toBe(503);
    expect(modelsResponse.json()).toMatchObject({
      error: "llama.cpp offline",
    });

    const invalidAdvisorResponse = await app.inject({
      method: "POST",
      url: "/api/v1/llamacpp/advisor",
      payload: {
        modelPath: 42,
      },
    });
    expect(invalidAdvisorResponse.statusCode).toBe(400);
  });
});
