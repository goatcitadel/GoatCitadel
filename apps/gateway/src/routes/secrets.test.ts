import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { secretsRoutes } from "./secrets.js";

describe("secrets routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns provider secret status", async () => {
    const getProviderSecretStatus = vi.fn(() => ({
      providerId: "glm",
      hasSecret: true,
      source: "secure_store",
    }));
    app = Fastify();
    app.decorate("services", { secrets: { getProviderSecretStatus } } as never);
    await app.register(secretsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/secrets/providers/glm/status",
    });

    expect(response.statusCode).toBe(200);
    expect(getProviderSecretStatus).toHaveBeenCalledWith("glm");
  });

  it("validates API key payloads before saving", async () => {
    const saveProviderSecret = vi.fn();
    app = Fastify();
    app.decorate("services", { secrets: { saveProviderSecret } } as never);
    await app.register(secretsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/secrets/providers/glm",
      payload: { apiKey: "" },
    });

    expect(response.statusCode).toBe(400);
    expect(saveProviderSecret).not.toHaveBeenCalled();
  });

  it("deletes provider secrets through the gateway", async () => {
    const deleteProviderSecret = vi.fn(() => ({
      providerId: "glm",
      hasSecret: false,
    }));
    app = Fastify();
    app.decorate("services", { secrets: { deleteProviderSecret } } as never);
    await app.register(secretsRoutes);

    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/secrets/providers/glm",
    });

    expect(response.statusCode).toBe(200);
    expect(deleteProviderSecret).toHaveBeenCalledWith("glm");
  });

  it("applies route-level rate limits to secret mutations", async () => {
    const saveProviderSecret = vi.fn(() => ({ providerId: "glm", hasSecret: true }));
    app = Fastify();
    app.decorate("services", { secrets: { saveProviderSecret } } as never);
    await app.register(rateLimit, {
      global: false,
      timeWindow: "1 minute",
      keyGenerator: (request) => request.ip,
      allowList: [],
      max: 100,
    });
    await app.register(secretsRoutes);

    for (let i = 0; i < 10; i += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/secrets/providers/glm",
        payload: { apiKey: `key-${i}` },
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/v1/secrets/providers/glm",
      payload: { apiKey: "key-11" },
    });

    expect(limited.statusCode).toBe(429);
  });
});
