import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { healthRoute } from "./health.js";

describe("health route", () => {
  it("returns ready when the database snapshot is reachable and clean", async () => {
    const app = Fastify();
    app.decorate("services", {
      health: {
        getDatabaseHealthSnapshot: vi.fn(async () => ({
          driver: "sqlite",
          configured: true,
          reachable: true,
          issues: [],
        })),
      },
    } as never);
    await app.register(healthRoute);

    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "ok",
        readiness: "ready",
        service: "gateway",
        database: {
          driver: "sqlite",
          configured: true,
          reachable: true,
          issues: [],
        },
      });
    } finally {
      await app.close();
    }
  });

  it("returns degraded when the database snapshot is unreachable", async () => {
    const app = Fastify();
    app.decorate("services", {
      health: {
        getDatabaseHealthSnapshot: vi.fn(async () => ({
          driver: "postgres",
          configured: true,
          reachable: false,
          issues: ["connection refused"],
        })),
      },
    } as never);
    await app.register(healthRoute);

    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: "degraded",
        readiness: "degraded",
        service: "gateway",
        database: {
          driver: "postgres",
          configured: true,
          reachable: false,
          issues: ["connection refused"],
        },
      });
    } finally {
      await app.close();
    }
  });

  it("returns degraded when the database reports issues despite being reachable", async () => {
    const app = Fastify();
    app.decorate("services", {
      health: {
        getDatabaseHealthSnapshot: vi.fn(async () => ({
          driver: "sqlite",
          configured: true,
          reachable: true,
          issues: ["migration drift detected"],
        })),
      },
    } as never);
    await app.register(healthRoute);

    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: "degraded",
        readiness: "degraded",
        database: {
          reachable: true,
          issues: ["migration drift detected"],
        },
      });
    } finally {
      await app.close();
    }
  });
});
