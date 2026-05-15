import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { durableRoutes } from "./durable.js";

describe("durable routes additional coverage", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("validates list, checkpoint, and create-run request shapes", async () => {
    app = buildApp();

    await expect(app.inject({ method: "GET", url: "/api/v1/durable/runs?limit=0" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(app.inject({ method: "GET", url: "/api/v1/durable/dead-letters?limit=0" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(
      app.inject({ method: "GET", url: "/api/v1/durable/runs/run-1/checkpoints?limit=0" }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: "POST", url: "/api/v1/durable/runs", payload: {} })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/durable/runs",
        payload: {
          workflowKey: "workflow",
          retryPolicy: { maxAttempts: 21 },
          waitForEvent: { eventKey: "" },
        },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
  });

  it("serves run details and timelines while preserving conflict mappings", async () => {
    const durable = createDurableService({
      getRun: vi
        .fn()
        .mockReturnValueOnce({ runId: "run-1" })
        .mockImplementationOnce(() => {
          throw new Error("storage unavailable");
        }),
      listRunTimeline: vi
        .fn()
        .mockReturnValueOnce([{ eventId: "event-1" }])
        .mockImplementationOnce(() => {
          throw new Error("timeline backend unavailable");
        }),
    });
    app = buildApp(durable);

    await expect(app.inject({ method: "GET", url: "/api/v1/durable/runs/run-1" })).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(app.inject({ method: "GET", url: "/api/v1/durable/runs/run-2" })).resolves.toMatchObject({
      statusCode: 409,
    });
    const timeline = await app.inject({ method: "GET", url: "/api/v1/durable/runs/run-1/timeline?limit=7" });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json()).toEqual({ items: [{ eventId: "event-1" }] });
    expect(durable.listRunTimeline).toHaveBeenCalledWith("run-1", 7);
    await expect(app.inject({ method: "GET", url: "/api/v1/durable/runs/run-1/timeline" })).resolves.toMatchObject({
      statusCode: 409,
    });
  });

  it("validates control bodies and maps pause/resume/cancel/retry/wake conflicts", async () => {
    const durable = createDurableService({
      pauseRun: vi.fn(() => {
        throw new Error("pause conflict");
      }),
      resumeRun: vi.fn(() => {
        throw new Error("resume conflict");
      }),
      cancelRun: vi.fn(() => {
        throw new Error("cancel conflict");
      }),
      retryRun: vi.fn(() => {
        throw new Error("retry conflict");
      }),
      wakeRun: vi.fn(() => {
        throw new Error("wake conflict");
      }),
    });
    app = buildApp(durable);

    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/pause", payload: { actorId: "" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/pause", payload: { actorId: "operator" } }),
    ).resolves.toMatchObject({ statusCode: 409 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/resume", payload: { actorId: "" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/resume", payload: { actorId: "operator" } }),
    ).resolves.toMatchObject({ statusCode: 409 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/cancel", payload: { actorId: "" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/cancel", payload: { actorId: "operator" } }),
    ).resolves.toMatchObject({ statusCode: 409 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/retry", payload: { reason: "" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/retry", payload: { reason: "manual" } }),
    ).resolves.toMatchObject({ statusCode: 409 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/durable/runs/run-1/events/wake",
        payload: { eventKey: "approval.resolved" },
      }),
    ).resolves.toMatchObject({ statusCode: 409 });
  });

  it("recovers dead letters with optional max attempts and maps validation/not-found/conflict errors", async () => {
    const durable = createDurableService({
      recoverDeadLetter: vi
        .fn()
        .mockReturnValueOnce({ entryId: "dead-1", recovered: true })
        .mockImplementationOnce(() => {
          throw new Error("dead letter not found");
        })
        .mockImplementationOnce(() => {
          throw new Error("recover conflict");
        }),
    });
    app = buildApp(durable);

    const recovered = await app.inject({
      method: "POST",
      url: "/api/v1/durable/dead-letters/dead-1/recover",
      payload: { actorId: "operator", maxAttempts: 3 },
    });
    expect(recovered.statusCode).toBe(200);
    expect(durable.recoverDeadLetter).toHaveBeenCalledWith("dead-1", "ip:127.0.0.1", { maxAttempts: 3 });

    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/dead-letters/dead-2/recover", payload: { maxAttempts: 0 } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/dead-letters/dead-2/recover", payload: {} }),
    ).resolves.toMatchObject({ statusCode: 404 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/dead-letters/dead-3/recover", payload: {} }),
    ).resolves.toMatchObject({ statusCode: 409 });
  });
});

function buildApp(overrides: Record<string, unknown> = {}): FastifyInstance {
  const next = Fastify();
  next.decorate("requireOperatorAuth", async () => undefined);
  next.decorate("services", { durable: createDurableService(overrides) } as never);
  void next.register(durableRoutes);
  return next;
}

function createDurableService(overrides: Record<string, unknown> = {}) {
  return {
    createRun: vi.fn(() => ({ runId: "run-created" })),
    getDiagnostics: vi.fn(() => ({ ok: true })),
    getRun: vi.fn(() => ({ runId: "run-1" })),
    listDeadLetters: vi.fn(() => []),
    listRunCheckpoints: vi.fn(() => []),
    listRuns: vi.fn(() => []),
    listRunTimeline: vi.fn(() => []),
    pauseRun: vi.fn(() => ({ status: "paused" })),
    resumeRun: vi.fn(() => ({ status: "queued" })),
    cancelRun: vi.fn(() => ({ status: "cancelled" })),
    retryRun: vi.fn(() => ({ status: "queued" })),
    wakeRun: vi.fn(() => ({ delivered: true })),
    recoverDeadLetter: vi.fn(() => ({ recovered: true })),
    ...overrides,
  };
}
