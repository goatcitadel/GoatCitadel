import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { DURABLE_CHILD_WATCHER_LIMITS } from "@goatcitadel/contracts";
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
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/pause", payload: {} }),
    ).resolves.toMatchObject({ statusCode: 409 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/resume", payload: { actorId: "" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/resume", payload: { actorId: "operator" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/resume", payload: {} }),
    ).resolves.toMatchObject({ statusCode: 409 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/cancel", payload: { actorId: "" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/cancel", payload: { actorId: "operator" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/cancel", payload: {} }),
    ).resolves.toMatchObject({ statusCode: 409 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/runs/run-1/retry", payload: { reason: "" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/durable/runs/run-1/retry",
        payload: { reason: "manual", actorId: "operator" },
      }),
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

  it("exposes child watcher attach, detach, reattach, close, and list projections", async () => {
    const durable = createDurableService();
    app = buildApp(durable);

    const watched = await app.inject({
      method: "POST",
      url: "/api/v1/durable/runs/parent-1/children/child-1/watch",
      payload: { source: "chat_delegation", metadata: { stepId: "step-1" } },
    });
    expect(watched.statusCode).toBe(201);
    expect(durable.watchChildRun).toHaveBeenCalledWith({
      parentRunId: "parent-1",
      childRunId: "child-1",
      source: "chat_delegation",
      metadata: { stepId: "step-1" },
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/durable/runs/parent-1/child-watchers?limit=7",
    });
    expect(listed.statusCode).toBe(200);
    expect(durable.listChildWatchers).toHaveBeenCalledWith("parent-1", 7);

    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/child-watchers/watcher-1/detach", payload: {} }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/child-watchers/watcher-1/reattach", payload: {} }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/durable/child-watchers/watcher-1/close", payload: {} }),
    ).resolves.toMatchObject({ statusCode: 200 });
    expect(durable.detachChildWatcher).toHaveBeenCalledWith("watcher-1");
    expect(durable.reattachChildWatcher).toHaveBeenCalledWith("watcher-1");
    expect(durable.closeChildWatcher).toHaveBeenCalledWith("watcher-1");

    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/durable/runs/parent-1/children/child-1/watch",
        payload: { source: "" },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
  });

  it("admits scoped background-task reads and CAS controls with no-store responses", async () => {
    const durable = createDurableService();
    app = buildApp(durable);

    const read = await app.inject({
      method: "GET",
      url: "/api/v1/durable/runs/parent-1/background-tasks?workspaceId=workspace-a&sessionId=session-a",
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("private, no-store");
    expect(durable.getBackgroundTaskRail).toHaveBeenCalledWith("parent-1", {
      workspaceId: "workspace-a",
      sessionId: "session-a",
    });

    const controlled = await app.inject({
      method: "POST",
      url: "/api/v1/durable/runs/parent-1/background-tasks/watcher-1/control",
      payload: {
        workspaceId: "workspace-a",
        sessionId: "session-a",
        action: "cancel",
        expectedWatcherRevision: 4,
        expectedChildVersion: 7,
        reason: "Operator request",
      },
    });
    expect(controlled.statusCode).toBe(200);
    expect(controlled.headers["cache-control"]).toBe("private, no-store");
    expect(durable.controlBackgroundTask).toHaveBeenCalledWith(
      "parent-1",
      "watcher-1",
      expect.objectContaining({ expectedWatcherRevision: 4, expectedChildVersion: 7 }),
      "ip:127.0.0.1",
    );

    for (const request of [
      { method: "GET" as const, url: "/api/v1/durable/runs/parent-1/background-tasks" },
      {
        method: "POST" as const,
        url: "/api/v1/durable/runs/parent-1/background-tasks/watcher-1/control",
        payload: { workspaceId: "workspace-a", sessionId: "session-a", action: "detach", expectedWatcherRevision: 0 },
      },
      {
        method: "POST" as const,
        url: "/api/v1/durable/runs/parent-1/background-tasks/watcher-1/control",
        payload: {
          workspaceId: "workspace-a",
          sessionId: "session-a",
          action: "detach",
          expectedWatcherRevision: 4,
          reason: "not valid for detach",
        },
      },
    ]) {
      await expect(app.inject(request)).resolves.toMatchObject({ statusCode: 400 });
    }
  });

  it("keeps background-task projection and controls behind operator authentication", async () => {
    const durable = createDurableService();
    app = buildApp(durable, async (_request, reply) => {
      await reply.code(403).send({ error: "operator required" });
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/durable/runs/parent-1/background-tasks?workspaceId=workspace-a&sessionId=session-a",
    });
    expect(response.statusCode).toBe(403);
    expect(durable.getBackgroundTaskRail).not.toHaveBeenCalled();
  });

  it("rejects oversized or deep watcher input before calling the durable service", async () => {
    const durable = createDurableService();
    app = buildApp(durable);

    const oversizedMetadata = await app.inject({
      method: "POST",
      url: "/api/v1/durable/runs/parent-1/children/child-1/watch",
      payload: { metadata: { value: "x".repeat(DURABLE_CHILD_WATCHER_LIMITS.metadataBytes + 1) } },
    });
    expect(oversizedMetadata.statusCode).toBe(400);

    let deep: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth <= DURABLE_CHILD_WATCHER_LIMITS.metadataMaxDepth; depth += 1) {
      deep = { nested: deep };
    }
    const deepMetadata = await app.inject({
      method: "POST",
      url: "/api/v1/durable/runs/parent-1/children/child-1/watch",
      payload: { metadata: deep },
    });
    expect(deepMetadata.statusCode).toBe(400);
    const secretIdentifier = "sk-secret-key-1234567890abcdef1234567890";
    const secretWatcherId = await app.inject({
      method: "POST",
      url: "/api/v1/durable/runs/parent-1/children/child-1/watch",
      payload: { watcherId: secretIdentifier },
    });
    expect(secretWatcherId.statusCode).toBe(400);
    const secretSource = await app.inject({
      method: "POST",
      url: "/api/v1/durable/runs/parent-1/children/child-1/watch",
      payload: { source: secretIdentifier },
    });
    expect(secretSource.statusCode).toBe(400);
    expect(durable.watchChildRun).not.toHaveBeenCalled();

    const oversizedWatcherId = encodeURIComponent("w".repeat(DURABLE_CHILD_WATCHER_LIMITS.watcherIdBytes + 1));
    const detached = await app.inject({
      method: "POST",
      url: `/api/v1/durable/child-watchers/${oversizedWatcherId}/detach`,
      payload: {},
    });
    // Fastify may reject an overlong path parameter at the router boundary
    // before the route-level byte validator runs. Both outcomes are fail-closed.
    expect([400, 404]).toContain(detached.statusCode);
    expect(durable.detachChildWatcher).not.toHaveBeenCalled();

    const oversizedRunId = encodeURIComponent("r".repeat(DURABLE_CHILD_WATCHER_LIMITS.runIdBytes + 1));
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/durable/runs/${oversizedRunId}/child-watchers`,
    });
    expect([400, 404]).toContain(listed.statusCode);
    expect(durable.listChildWatchers).not.toHaveBeenCalled();
  });

  it("redacts child watcher metadata in route projections", async () => {
    app = buildApp({
      listChildWatchers: vi.fn(() => [
        {
          watcherId: "watcher-secret",
          metadata: { apiToken: "sk-1234567890abcdef1234567890", note: "safe" },
        },
      ]),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/durable/runs/parent-1/child-watchers",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          watcherId: "watcher-secret",
          metadata: { apiToken: "[REDACTED]", note: "safe" },
        },
      ],
    });
    expect(response.body).not.toContain("sk-1234567890abcdef1234567890");
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
      payload: { maxAttempts: 3 },
    });
    expect(recovered.statusCode).toBe(200);
    expect(durable.recoverDeadLetter).toHaveBeenCalledWith("dead-1", "ip:127.0.0.1", { maxAttempts: 3 });

    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/durable/dead-letters/dead-2/recover",
        payload: { actorId: "operator", maxAttempts: 3 },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
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

function buildApp(
  overrides: Record<string, unknown> = {},
  requireOperatorAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> = async () => undefined,
): FastifyInstance {
  const next = Fastify();
  next.decorate("requireOperatorAuth", requireOperatorAuth);
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
    watchChildRun: vi.fn(() => ({ watcherId: "watcher-1", state: "attached" })),
    listChildWatchers: vi.fn(() => [{ watcherId: "watcher-1" }]),
    detachChildWatcher: vi.fn(() => ({ watcherId: "watcher-1", state: "detached" })),
    reattachChildWatcher: vi.fn(() => ({ watcher: { watcherId: "watcher-1", state: "attached" } })),
    closeChildWatcher: vi.fn(() => ({ watcherId: "watcher-1", state: "closed" })),
    getBackgroundTaskRail: vi.fn(() => ({ version: "durable.background_task_rail.v1" })),
    controlBackgroundTask: vi.fn(() => ({ version: "durable.background_task_control.v1" })),
    pauseRun: vi.fn(() => ({ status: "paused" })),
    resumeRun: vi.fn(() => ({ status: "queued" })),
    cancelRun: vi.fn(() => ({ status: "cancelled" })),
    retryRun: vi.fn(() => ({ status: "queued" })),
    wakeRun: vi.fn(() => ({ delivered: true })),
    recoverDeadLetter: vi.fn(() => ({ recovered: true })),
    ...overrides,
  };
}
