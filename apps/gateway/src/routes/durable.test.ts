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

    app = buildDurableApp({
      getDiagnostics: getDurableDiagnostics,
    });
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

    app = buildDurableApp({
      listRunCheckpoints: listDurableRunCheckpoints,
    });
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

    app = buildDurableApp({
      recoverDeadLetter: recoverDurableDeadLetter,
    });
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

    app = buildDurableApp({
      retryRun: retryDurableRun,
    });
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

  it("lists durable runs and dead letters with normalized limits", async () => {
    const listRuns = vi.fn(() => [{ runId: "run-1" }]);
    const listDeadLetters = vi.fn(() => [{ entryId: "dead-1" }]);
    app = buildDurableApp({ listRuns, listDeadLetters });
    await app.register(durableRoutes);

    const runs = await app.inject({ method: "GET", url: "/api/v1/durable/runs?limit=3" });
    const deadLetters = await app.inject({ method: "GET", url: "/api/v1/durable/dead-letters?limit=2" });

    expect(runs.statusCode).toBe(200);
    expect(runs.json()).toEqual({ items: [{ runId: "run-1" }] });
    expect(deadLetters.statusCode).toBe(200);
    expect(deadLetters.json()).toEqual({ items: [{ entryId: "dead-1" }] });
    expect(listRuns).toHaveBeenCalledWith(3);
    expect(listDeadLetters).toHaveBeenCalledWith(2);
  });

  it("creates runs with validated retry and wait-event payloads and reports conflicts", async () => {
    const createRun = vi
      .fn()
      .mockReturnValueOnce({
        runId: "run-created",
        workflowKey: "connector.delivery",
        status: "queued",
      })
      .mockImplementationOnce(() => {
        throw new Error("duplicate idempotency key");
      });
    app = buildDurableApp({ createRun });
    await app.register(durableRoutes);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/durable/runs",
      payload: {
        workflowKey: "connector.delivery",
        payload: { connectionId: "conn-1" },
        metadata: { source: "test" },
        retryPolicy: { maxAttempts: 4, baseDelayMs: 1000 },
        waitForEvent: { eventKey: "provider.ready", correlationId: "conn-1" },
      },
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/durable/runs",
      payload: {
        workflowKey: "connector.delivery",
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ runId: "run-created" });
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowKey: "connector.delivery",
        retryPolicy: { maxAttempts: 4, baseDelayMs: 1000 },
        waitForEvent: { eventKey: "provider.ready", correlationId: "conn-1" },
      }),
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: "duplicate idempotency key" });
  });

  it("maps get/timeline not-found errors to 404 and other durable control errors to 409", async () => {
    const pauseRun = vi.fn(() => {
      throw new Error("run cannot be paused from completed");
    });
    app = buildDurableApp({
      getRun: vi.fn(() => {
        throw new Error("run not found");
      }),
      listRunTimeline: vi.fn(() => {
        throw new Error("timeline not found");
      }),
      pauseRun,
    });
    await app.register(durableRoutes);

    await expect(app.inject({ method: "GET", url: "/api/v1/durable/runs/run-missing" })).resolves.toMatchObject({
      statusCode: 404,
    });
    await expect(
      app.inject({ method: "GET", url: "/api/v1/durable/runs/run-missing/timeline" }),
    ).resolves.toMatchObject({
      statusCode: 404,
    });
    const pause = await app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/pause", payload: {} });
    expect(pause.statusCode).toBe(409);
    expect(pause.json()).toEqual({ error: "run cannot be paused from completed" });
    expect(pauseRun).toHaveBeenCalledWith("run-1", expect.stringMatching(/^ip:/));
  });

  it("validates and dispatches pause, resume, cancel, and wake controls", async () => {
    const pauseRun = vi.fn(() => ({ runId: "run-1", status: "paused" }));
    const resumeRun = vi.fn(() => ({ runId: "run-1", status: "queued" }));
    const cancelRun = vi.fn(() => ({ runId: "run-1", status: "cancelled" }));
    const wakeRun = vi.fn(() => ({ delivered: true }));
    app = buildDurableApp({ pauseRun, resumeRun, cancelRun, wakeRun });
    await app.register(durableRoutes);

    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/pause", payload: { actorId: "operator:1" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/pause", payload: {} }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/resume", payload: {} }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/cancel", payload: {} }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/cancel", payload: {} }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/durable/runs/run-1/events/wake",
        payload: { eventKey: "approval.resolved", payload: { ok: true }, correlationId: "approval-1" },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/events/wake", payload: {} }),
    ).resolves.toMatchObject({ statusCode: 400 });

    expect(pauseRun).toHaveBeenCalledWith("run-1", "ip:127.0.0.1");
    expect(resumeRun).toHaveBeenCalledWith("run-1", "ip:127.0.0.1");
    expect(cancelRun).toHaveBeenCalledTimes(2);
    expect(cancelRun).toHaveBeenCalledWith("run-1", "ip:127.0.0.1");
    expect(wakeRun).toHaveBeenCalledWith("run-1", {
      eventKey: "approval.resolved",
      payload: { ok: true },
      correlationId: "approval-1",
    });
  });

  it("projects arbitrary durable response state across read and control routes without mutating backing records", async () => {
    const rawRecord = createSecretBearingDurableRecord();
    const diagnostics = {
      enabled: true,
      recentRuns: [rawRecord],
      recentDeadLetters: [rawRecord],
      state: structuredClone(rawRecord.state),
    };
    app = buildDurableApp({
      getDiagnostics: vi.fn(() => diagnostics),
      listRuns: vi.fn(() => [rawRecord]),
      listDeadLetters: vi.fn(() => [rawRecord]),
      listRunCheckpoints: vi.fn(() => [rawRecord]),
      createRun: vi.fn(() => rawRecord),
      getRun: vi.fn(() => rawRecord),
      listRunTimeline: vi.fn(() => [rawRecord]),
      pauseRun: vi.fn(() => rawRecord),
      resumeRun: vi.fn(() => rawRecord),
      cancelRun: vi.fn(() => rawRecord),
      retryRun: vi.fn(() => rawRecord),
      wakeRun: vi.fn(() => rawRecord),
      recoverDeadLetter: vi.fn(() => rawRecord),
    });
    await app.register(durableRoutes);

    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/durable/diagnostics" }),
      app.inject({ method: "GET", url: "/api/v1/durable/runs" }),
      app.inject({ method: "GET", url: "/api/v1/durable/dead-letters" }),
      app.inject({ method: "GET", url: "/api/v1/durable/runs/run-secret/checkpoints" }),
      app.inject({ method: "POST", url: "/api/v1/durable/runs", payload: { workflowKey: "connector.delivery" } }),
      app.inject({ method: "GET", url: "/api/v1/durable/runs/run-secret" }),
      app.inject({ method: "GET", url: "/api/v1/durable/runs/run-secret/timeline" }),
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-secret/pause", payload: {} }),
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-secret/resume", payload: {} }),
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-secret/cancel", payload: {} }),
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-secret/retry", payload: {} }),
      app.inject({
        method: "POST",
        url: "/api/v1/durable/runs/run-secret/events/wake",
        payload: { eventKey: "provider.ready" },
      }),
      app.inject({ method: "POST", url: "/api/v1/durable/dead-letters/dead-secret/recover", payload: {} }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBeLessThan(300);
      expect(response.body).not.toContain("path-secret");
      expect(response.body).not.toContain("query-short");
      expect(response.body).not.toContain("Bearer tiny");
      expect(response.body).not.toContain("db-short");
      expect(response.body).not.toContain("grat_aaaaaaaa");
      expect(response.body).toContain("[REDACTED]");
      expect(response.body).toContain("token-id-safe");
      expect(response.body).toContain("keychain:durable-safe");
    }

    const run = responses[5]!.json();
    expect(run).toMatchObject({
      runId: "run-secret",
      status: "queued",
      budget: { tokenBudget: 1200 },
      linkage: { tokenId: "token-id-safe", secretRef: "keychain:durable-safe", requestCount: 7 },
      payload: {
        webhookUrl: "[REDACTED]",
        authorization: "[REDACTED]",
        DATABASE_PASSWORD: "[REDACTED]",
      },
    });
    expect(rawRecord.payload.webhookUrl).toContain("path-secret");
    expect(rawRecord.payload.authorization).toBe("Bearer tiny");
    expect(rawRecord.payload.DATABASE_PASSWORD).toBe("db-short");
    expect(diagnostics.recentRuns[0]).toBe(rawRecord);
  });
});

function createSecretBearingDurableRecord() {
  return {
    runId: "run-secret",
    entryId: "dead-secret",
    checkpointId: "checkpoint-secret",
    eventId: "event-secret",
    status: "queued",
    budget: { tokenBudget: 1200 },
    linkage: {
      tokenId: "token-id-safe",
      secretRef: "keychain:durable-safe",
      requestCount: 7,
    },
    payload: {
      webhookUrl: "https://hooks.example.test/services/team/path-secret?token=query-short",
      authorization: "Bearer tiny",
      DATABASE_PASSWORD: "db-short",
      interactiveActions: {
        buttons: [
          {
            label: "Approve",
            callbackData: `gca:grat_${"a".repeat(43)}:a`,
          },
        ],
      },
    },
    metadata: {
      callbackUrl: "https://callback.example.test/result?token=query-short",
      tokenId: "token-id-safe",
    },
    state: {
      response: "Authorization: Bearer tiny",
      requestCount: 7,
    },
    errorText: "password=db-short",
  };
}

function buildDurableApp(durableOverrides: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("requireOperatorAuth", async () => undefined);
  next.decorate("services", {
    durable: {
      createRun: vi.fn(),
      getDiagnostics: vi.fn(),
      getRun: vi.fn(),
      listDeadLetters: vi.fn(() => []),
      listRunCheckpoints: vi.fn(() => []),
      listRuns: vi.fn(() => []),
      listRunTimeline: vi.fn(() => []),
      pauseRun: vi.fn(),
      resumeRun: vi.fn(),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
      wakeRun: vi.fn(),
      recoverDeadLetter: vi.fn(),
      ...durableOverrides,
    },
  } as never);
  return next;
}
