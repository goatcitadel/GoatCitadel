import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { localAiRoutes } from "./local-ai.js";

describe("local AI routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns readiness from the local AI service", async () => {
    const getReadiness = vi.fn(async () => ({
      hardware: { checkedAt: "2026-06-05T12:00:00.000Z" },
      catalog: [],
      recommendations: [],
      downloads: [],
      serveJobs: [],
      endpoints: [],
    }));
    app = buildApp({ getReadiness });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/local-ai/readiness",
    });

    expect(response.statusCode).toBe(200);
    expect(getReadiness).toHaveBeenCalled();
    expect(response.json()).toMatchObject({ catalog: [], recommendations: [] });
  });

  it("validates and creates approval-required download and serve jobs", async () => {
    const startDownload = vi.fn(() => ({ jobId: "download-1", status: "requires_approval" }));
    const startServe = vi.fn(() => ({ jobId: "serve-1", status: "requires_approval" }));
    const requestServeStop = vi.fn(() => ({ jobId: "serve-1", status: "requires_approval" }));
    app = buildApp({ startDownload, startServe, requestServeStop });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/local-ai/downloads",
      payload: { modelId: "", backend: "ollama" },
    });
    const download = await app.inject({
      method: "POST",
      url: "/api/v1/local-ai/downloads",
      payload: { modelId: "llama3.2:3b-instruct-q4_K_M", backend: "ollama" },
    });
    const serve = await app.inject({
      method: "POST",
      url: "/api/v1/local-ai/serve",
      payload: { modelId: "llama3.2:3b-instruct-q4_K_M", backend: "ollama", port: 11435 },
    });
    const stop = await app.inject({
      method: "POST",
      url: "/api/v1/local-ai/serve/serve-1/stop",
    });

    expect(invalid.statusCode).toBe(400);
    expect(download.statusCode).toBe(201);
    expect(serve.statusCode).toBe(201);
    expect(stop.statusCode).toBe(200);
    expect(startDownload).toHaveBeenCalledWith({ modelId: "llama3.2:3b-instruct-q4_K_M", backend: "ollama" });
    expect(startServe).toHaveBeenCalledWith({
      modelId: "llama3.2:3b-instruct-q4_K_M",
      backend: "ollama",
      port: 11435,
    });
    expect(requestServeStop).toHaveBeenCalledWith("serve-1");
  });

  it("validates endpoint registration requests", async () => {
    const registerEndpoint = vi.fn(() => ({
      endpointId: "endpoint-1",
      providerId: "local-ai-ollama",
      smokeStatus: "pending",
    }));
    app = buildApp({ registerEndpoint });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/local-ai/endpoints/register",
      payload: {
        label: "bad endpoint",
        backend: "ollama",
        baseUrl: "not-a-url",
        model: "llama3.2",
      },
    });
    const valid = await app.inject({
      method: "POST",
      url: "/api/v1/local-ai/endpoints/register",
      payload: {
        label: "Ollama",
        backend: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "llama3.2",
        providerId: "local-ollama",
      },
    });

    expect(invalid.statusCode).toBe(400);
    expect(valid.statusCode).toBe(201);
    expect(registerEndpoint).toHaveBeenCalledWith({
      label: "Ollama",
      backend: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "llama3.2",
      providerId: "local-ollama",
    });
  });
});

function buildApp(localAi: Record<string, unknown>): FastifyInstance {
  const fastify = Fastify();
  fastify.decorate("services", { localAi } as never);
  fastify.register(localAiRoutes);
  return fastify;
}
