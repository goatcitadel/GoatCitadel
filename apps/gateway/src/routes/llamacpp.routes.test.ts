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
      activeModelId: "gemma-4-local",
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
    const detectLlamaCppInstall = vi.fn(async () => ({
      found: true,
      command: "C:\\llama\\llama-server.exe",
      source: "standard-windows",
      version: "version: 8683 (d0a6dfeb2)",
      recommendedBaseUrl: "http://127.0.0.1:8080/v1",
    }));
    const startLlamaCppHuggingFaceDownload = vi.fn(async () => ({
      jobId: "job-123",
      status: "queued",
      stage: "model",
      repo: "foo/bar",
      alias: "gemma-4-local",
      filename: "model.gguf",
      sourceUrl: "https://huggingface.co/foo/bar/resolve/main/model.gguf",
      bytesDownloaded: 0,
      startedAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:00:00.000Z",
    }));
    const getLlamaCppHuggingFaceDownload = vi.fn(() => ({
      jobId: "job-123",
      status: "completed",
      stage: "done",
      repo: "foo/bar",
      alias: "gemma-4-local",
      filename: "model.gguf",
      sourceUrl: "https://huggingface.co/foo/bar/resolve/main/model.gguf",
      bytesDownloaded: 1234,
      modelBytes: 1234,
      modelPath: "F:\\code\\personal-ai\\models\\llamacpp\\foo_bar\\model.gguf",
      startedAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:02:00.000Z",
      completedAt: "2026-04-12T00:02:00.000Z",
    }));
    const cancelLlamaCppHuggingFaceDownload = vi.fn(() => ({
      jobId: "job-123",
      status: "cancelled",
      stage: "done",
      repo: "foo/bar",
      alias: "gemma-4-local",
      filename: "model.gguf",
      sourceUrl: "https://huggingface.co/foo/bar/resolve/main/model.gguf",
      bytesDownloaded: 256,
      startedAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:01:00.000Z",
      completedAt: "2026-04-12T00:01:00.000Z",
      error: "Cancelled by user.",
    }));

    app = Fastify();
    app.decorate("gateway", {
      getLlamaCppStatus,
      adviseLlamaCppRuntime,
      detectLlamaCppInstall,
      startLlamaCppHuggingFaceDownload,
      getLlamaCppHuggingFaceDownload,
      cancelLlamaCppHuggingFaceDownload,
    } as never);
    await app.register(llamaCppRoutes);

    const statusResponse = await app.inject({
      method: "GET",
      url: "/api/v1/llamacpp/status",
    });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json()).toMatchObject({
      healthy: true,
      activeModelId: "gemma-4-local",
    });

    const advisorResponse = await app.inject({
      method: "POST",
      url: "/api/v1/llamacpp/advisor",
      payload: {
        modelPath: "models/gemma-4-q4.gguf",
        modelId: "gemma-4-local",
      },
    });
    expect(advisorResponse.statusCode).toBe(200);
    expect(adviseLlamaCppRuntime).toHaveBeenCalledWith({
      modelPath: "models/gemma-4-q4.gguf",
      modelId: "gemma-4-local",
    });

    const installResponse = await app.inject({
      method: "GET",
      url: "/api/v1/llamacpp/install",
    });
    expect(installResponse.statusCode).toBe(200);
    expect(installResponse.json()).toMatchObject({
      found: true,
      source: "standard-windows",
    });

    const downloadResponse = await app.inject({
      method: "POST",
      url: "/api/v1/llamacpp/huggingface/download",
      payload: {
        repo: "foo/bar",
        filename: "model.gguf",
        alias: "gemma-4-local",
      },
    });
    expect(downloadResponse.statusCode).toBe(202);
    expect(startLlamaCppHuggingFaceDownload).toHaveBeenCalledWith({
      repo: "foo/bar",
      filename: "model.gguf",
      alias: "gemma-4-local",
    });

    const downloadStatusResponse = await app.inject({
      method: "GET",
      url: "/api/v1/llamacpp/huggingface/downloads/job-123",
    });
    expect(downloadStatusResponse.statusCode).toBe(200);
    expect(downloadStatusResponse.json()).toMatchObject({
      jobId: "job-123",
      status: "completed",
    });

    const cancelResponse = await app.inject({
      method: "POST",
      url: "/api/v1/llamacpp/huggingface/downloads/job-123/cancel",
    });
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json()).toMatchObject({
      jobId: "job-123",
      status: "cancelled",
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
