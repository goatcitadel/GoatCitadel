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

  it("falls back to the request ip when recovering a dead letter without actorId", async () => {
    const recoverDurableDeadLetter = vi.fn(() => ({
      runId: "run-1",
      workflowKey: "connector.delivery",
      status: "queued",
      attemptCount: 1,
      maxAttempts: 3,
      version: 2,
      payload: {},
      metadata: {},
      createdAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:01:00.000Z",
    }));

    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("gateway", {
      recoverDurableDeadLetter,
    } as never);
    await app.register(durableRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/durable/dead-letters/dead-1/recover",
      payload: {
        maxAttempts: 5,
      },
      remoteAddress: "127.0.0.1",
    });

    expect(response.statusCode).toBe(200);
    expect(recoverDurableDeadLetter).toHaveBeenCalledWith("dead-1", "ip:127.0.0.1", {
      maxAttempts: 5,
    });
  });

  it("falls back to the request ip when retrying a durable run without actorId", async () => {
    const retryDurableRun = vi.fn(() => ({
      runId: "run-2",
      workflowKey: "connector.delivery",
      status: "queued",
      attemptCount: 1,
      maxAttempts: 3,
      version: 2,
      payload: {},
      metadata: {},
      createdAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:01:00.000Z",
    }));

    app = Fastify();
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("gateway", {
      retryDurableRun,
    } as never);
    await app.register(durableRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/durable/runs/run-2/retry",
      payload: {
        reason: "manual_retry",
      },
      remoteAddress: "127.0.0.1",
    });

    expect(response.statusCode).toBe(200);
    expect(retryDurableRun).toHaveBeenCalledWith("run-2", "manual_retry", "ip:127.0.0.1");
  });
});
