import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { durableRoutes } from "./durable.js";

describe("durable routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns durable diagnostics", async () => {
    const getDurableDiagnostics = vi.fn(() => ({
      enabled: false,
      replayFoundationReady: true,
      runCount: 0,
      queuedCount: 0,
      runningCount: 0,
      waitingCount: 0,
      failedCount: 0,
      deadLetterCount: 0,
      recentRuns: [],
      recentDeadLetters: [],
      generatedAt: "2026-03-03T00:00:00.000Z",
    }));

    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("gateway", {
      getDurableDiagnostics,
    } as never);
    await app.register(durableRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/durable/diagnostics",
    });

    expect(response.statusCode).toBe(200);
    expect(getDurableDiagnostics).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({
      replayFoundationReady: true,
      runCount: 0,
    });
  });

  it("validates run checkpoint requests", async () => {
    const listDurableRunCheckpoints = vi.fn(() => []);

    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("gateway", {
      listDurableRunCheckpoints,
    } as never);
    await app.register(durableRoutes);

    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/durable/runs//checkpoints",
    });
    expect(invalid.statusCode).toBe(400);

    const valid = await app.inject({
      method: "GET",
      url: "/api/v1/durable/runs/run-1/checkpoints?limit=10",
    });
    expect(valid.statusCode).toBe(200);
    expect(listDurableRunCheckpoints).toHaveBeenCalledWith("run-1", 10);
  });
});
