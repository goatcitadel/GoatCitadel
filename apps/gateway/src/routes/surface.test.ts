import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { surfaceRoutes } from "./surface.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(surfaceRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("POST /api/v1/surface/classify", () => {
  it("normalizes an explicit code prompt into Chat while keeping heuristic provenance", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/surface/classify",
      payload: { prompt: "fix the repo and run tests", hasBoundProject: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe("chat");
    expect(body.source).toBe("heuristic");
    expect(Array.isArray(body.alternatives)).toBe(true);
  });

  it("defaults an empty prompt to chat", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/surface/classify",
      payload: { prompt: "" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe("chat");
  });

  it("rejects a missing prompt with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/surface/classify",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
