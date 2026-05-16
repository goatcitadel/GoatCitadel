import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { tasksRoutes } from "./tasks.js";

describe("tasks routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("lists tasks through the task route service", async () => {
    const listTasks = vi.fn(() => [
      {
        taskId: "task-1",
        title: "Plan slice",
        status: "in_progress",
        priority: "normal",
        workspaceId: "default",
        updatedAt: "2026-04-24T01:00:00.000Z",
      },
    ]);

    app = buildApp({ listTasks });
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/tasks?limit=1&status=in_progress&workspaceId=default",
    });

    expect(response.statusCode).toBe(200);
    expect(listTasks).toHaveBeenCalledWith(1, "in_progress", undefined, "active", "default");
    expect(response.json()).toMatchObject({
      items: [{ taskId: "task-1" }],
      nextCursor: "2026-04-24T01:00:00.000Z|task-1",
      view: "active",
    });
  });

  it("requires a confirmation token for hard delete", async () => {
    const hardDeleteTask = vi.fn(() => true);
    const softDeleteTask = vi.fn(() => true);

    app = buildApp({ hardDeleteTask, softDeleteTask });
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/tasks/task-1?mode=hard",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(hardDeleteTask).not.toHaveBeenCalled();
    expect(softDeleteTask).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      error: "Hard delete requires confirmToken=PERMANENT_DELETE",
    });
  });

  it("appends task activity through the task route service", async () => {
    const appendTaskActivity = vi.fn((_taskId: string, input: Record<string, unknown>) => ({
      activityId: "activity-1",
      taskId: "task-1",
      ...input,
      createdAt: "2026-04-24T01:00:00.000Z",
    }));

    app = buildApp({ appendTaskActivity });
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-1/activities",
      payload: {
        activityType: "comment",
        message: "Moved task ownership out of the gateway.",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(appendTaskActivity).toHaveBeenCalledWith("task-1", {
      activityType: "comment",
      message: "Moved task ownership out of the gateway.",
    });
    expect(response.json()).toMatchObject({
      activityId: "activity-1",
      taskId: "task-1",
      activityType: "comment",
    });
  });

  it("exposes normalized agentic runtime availability", async () => {
    app = buildApp({});
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agentic/availability",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      harnesses: expect.any(Array),
      providers: [expect.objectContaining({ runtimeId: "provider-openai", status: "not_configured" })],
      plugins: [expect.objectContaining({ runtimeId: "plugin-corrupt", status: "unavailable" })],
      channels: [expect.objectContaining({ capabilityId: "channel:telegram", status: "callable", callable: true })],
    });
    expect(response.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "provider:provider-openai",
          status: "not_configured",
          callable: false,
        }),
        expect.objectContaining({ capabilityId: "plugin:plugin-corrupt", status: "unavailable", callable: false }),
      ]),
    );
  }, 15_000);

  it("rejects malformed subagent metadata instead of persisting arbitrary payloads", async () => {
    const registerTaskSubagent = vi.fn();

    app = buildApp({ registerTaskSubagent });
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-1/subagents",
      payload: {
        agentSessionId: "agent-session-1",
        metadata: "not-object",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(registerTaskSubagent).not.toHaveBeenCalled();
  });

  it("creates, updates, soft-deletes, restores, and hard-deletes tasks through the service contract", async () => {
    const createTask = vi.fn((input: Record<string, unknown>) => ({ taskId: "task-1", ...input }));
    const updateTask = vi.fn((taskId: string, input: Record<string, unknown>) => ({ taskId, ...input }));
    const softDeleteTask = vi.fn(() => true);
    const restoreTask = vi.fn(() => true);
    const hardDeleteTask = vi.fn(() => true);

    app = buildApp({ createTask, updateTask, softDeleteTask, restoreTask, hardDeleteTask });
    await app.register(tasksRoutes);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        workspaceId: "default",
        title: "Runtime validation",
        status: "planning",
        priority: "high",
      },
    });
    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/tasks/task-1",
      payload: {
        title: "Runtime validation updated",
        assignedAgentId: null,
      },
    });
    const softDeleted = await app.inject({
      method: "DELETE",
      url: "/api/v1/tasks/task-1",
      payload: {
        deletedBy: "operator",
        deleteReason: "cleanup",
      },
    });
    const restored = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-1/restore",
    });
    const hardDeleted = await app.inject({
      method: "DELETE",
      url: "/api/v1/tasks/task-1?mode=hard",
      payload: {
        confirmToken: "PERMANENT_DELETE",
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ taskId: "task-1", title: "Runtime validation" });
    expect(updateTask).toHaveBeenCalledWith("task-1", {
      title: "Runtime validation updated",
      assignedAgentId: null,
    });
    expect(updated.json()).toMatchObject({ taskId: "task-1", title: "Runtime validation updated" });
    expect(softDeleted.json()).toEqual({ deleted: true, taskId: "task-1", mode: "soft" });
    expect(softDeleteTask).toHaveBeenCalledWith("task-1", "operator", "cleanup");
    expect(restored.json()).toEqual({ restored: true, taskId: "task-1" });
    expect(hardDeleted.json()).toEqual({ deleted: true, taskId: "task-1", mode: "hard" });
  });

  it("returns not-found responses for task delete and restore misses", async () => {
    app = buildApp({
      softDeleteTask: vi.fn(() => false),
      restoreTask: vi.fn(() => false),
    });
    await app.register(tasksRoutes);

    await expect(app.inject({ method: "DELETE", url: "/api/v1/tasks/missing", payload: {} })).resolves.toMatchObject({
      statusCode: 404,
    });
    await expect(app.inject({ method: "POST", url: "/api/v1/tasks/missing/restore" })).resolves.toMatchObject({
      statusCode: 404,
    });
  });

  it("dispatches deliverables, subagent updates, agentic runs, controls, and diagnostics", async () => {
    const appendTaskDeliverable = vi.fn((_taskId: string, input: Record<string, unknown>) => ({
      deliverableId: "deliverable-1",
      ...input,
    }));
    const updateTaskSubagent = vi.fn((_agentSessionId: string, input: Record<string, unknown>) => ({
      agentSessionId: "agent-session-1",
      ...input,
    }));
    const listAgenticRuns = vi.fn(() => ({ items: [{ runId: "run-1" }] }));
    const getAgenticRunTree = vi.fn(() => ({ runId: "run-1", children: [] }));
    const invokeAgenticControl = vi.fn((_runId: string, input: Record<string, unknown>) => ({
      accepted: true,
      ...input,
    }));
    const appendTaskDiagnostic = vi.fn((_taskId: string, input: Record<string, unknown>) => ({
      diagnosticId: "diagnostic-1",
      ...input,
    }));

    app = buildApp({
      appendTaskDeliverable,
      updateTaskSubagent,
      listAgenticRuns,
      getAgenticRunTree,
      invokeAgenticControl,
      appendTaskDiagnostic,
    });
    await app.register(tasksRoutes);

    const deliverable = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-1/deliverables",
      payload: {
        deliverableType: "file",
        title: "Proof file",
        path: "artifacts/proof.md",
      },
    });
    const subagent = await app.inject({
      method: "PATCH",
      url: "/api/v1/subagents/agent-session-1",
      payload: {
        status: "completed",
        metadata: null,
      },
    });
    const runs = await app.inject({
      method: "GET",
      url: "/api/v1/agentic/runs?workspaceId=default&status=running&surface=code&limit=25",
    });
    const tree = await app.inject({ method: "GET", url: "/api/v1/agentic/runs/run-1/tree" });
    const control = await app.inject({
      method: "POST",
      url: "/api/v1/agentic/runs/run-1/control",
      payload: {
        action: "steer",
        instruction: "stay scoped",
      },
    });
    const diagnostic = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-1/agentic/diagnostics",
      payload: {
        code: "missing_claimed_test",
        severity: "warning",
        title: "Missing proof",
        summary: "The worker claimed a test that was not present.",
      },
    });

    expect(deliverable.statusCode).toBe(201);
    expect(subagent.statusCode).toBe(200);
    expect(runs.json()).toEqual({ items: [{ runId: "run-1" }] });
    expect(listAgenticRuns).toHaveBeenCalledWith({
      workspaceId: "default",
      status: "running",
      surface: "code",
      limit: 25,
    });
    expect(tree.json()).toEqual({ runId: "run-1", children: [] });
    expect(control.json()).toMatchObject({ accepted: true, action: "steer", instruction: "stay scoped" });
    expect(diagnostic.statusCode).toBe(201);
    expect(appendTaskDiagnostic).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        code: "missing_claimed_test",
        severity: "warning",
      }),
    );
  });

  it("emits a distress signal through the task route service", async () => {
    const emitDistressSignal = vi.fn((_taskId: string, input: Record<string, unknown>) => ({
      taskId: "task-1",
      distressSignals: [{ signalId: "signal-1", code: input.code, severity: input.severity }],
    }));

    app = buildApp({ emitDistressSignal });
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-1/distress",
      payload: {
        code: "worker_crash",
        severity: "critical",
        title: "Worker crashed unexpectedly",
        summary: "The worker process exited without closing the task.",
        emittedBy: "durable-runner",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(emitDistressSignal).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ code: "worker_crash", severity: "critical" }),
    );
    expect(response.json()).toMatchObject({
      distressSignals: [expect.objectContaining({ code: "worker_crash" })],
    });
  });

  it("returns 400 when emitting distress with missing required fields", async () => {
    app = buildApp({});
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-1/distress",
      payload: { severity: "critical" }, // missing code and title
    });

    expect(response.statusCode).toBe(400);
  });

  it("resolves a distress signal through the task route service", async () => {
    const resolveDistressSignal = vi.fn(() => ({ taskId: "task-1", distressSignals: [] }));

    app = buildApp({ resolveDistressSignal });
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/tasks/task-1/distress/signal-1",
      payload: { resolvedBy: "operator" },
    });

    expect(response.statusCode).toBe(200);
    expect(resolveDistressSignal).toHaveBeenCalledWith("task-1", "signal-1", { resolvedBy: "operator" });
    expect(response.json()).toMatchObject({ taskId: "task-1", distressSignals: [] });
  });

  it("sets the retry budget through the task route service", async () => {
    const setRetryBudget = vi.fn((_taskId: string, maxRetries: number) => ({
      taskId: "task-1",
      retryBudget: { maxRetries, retryCount: 0 },
    }));

    app = buildApp({ setRetryBudget });
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-1/retry-budget",
      payload: { maxRetries: 3 },
    });

    expect(response.statusCode).toBe(200);
    expect(setRetryBudget).toHaveBeenCalledWith("task-1", 3);
    expect(response.json()).toMatchObject({ retryBudget: { maxRetries: 3 } });
  });

  it("verifies task artifacts through the task route service", async () => {
    const verifyTaskArtifacts = vi.fn(() => Promise.resolve({ taskId: "task-1", artifactVerification: "ok" }));

    app = buildApp({ verifyTaskArtifacts });
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-1/verify-artifacts",
      payload: {
        claims: [{ kind: "file", value: "dist/output.js", label: "build output" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(verifyTaskArtifacts).toHaveBeenCalledWith("task-1", [
      expect.objectContaining({ kind: "file", value: "dist/output.js" }),
    ]);
  });

  it("bulk updates tasks via reassign action", async () => {
    const bulkUpdateTasks = vi.fn(() => [
      { taskId: "task-1", assignedAgentId: "agent-2" },
      { taskId: "task-2", assignedAgentId: "agent-2" },
    ]);

    app = buildApp({ bulkUpdateTasks });
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/bulk",
      payload: {
        action: "reassign",
        taskIds: ["task-1", "task-2"],
        assignedAgentId: "agent-2",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(bulkUpdateTasks).toHaveBeenCalledWith({
      action: "reassign",
      taskIds: ["task-1", "task-2"],
      assignedAgentId: "agent-2",
    });
    expect(response.json()).toMatchObject({
      tasks: [expect.objectContaining({ taskId: "task-1" }), expect.objectContaining({ taskId: "task-2" })],
    });
  });

  it("returns 400 for bulk action with missing required fields", async () => {
    app = buildApp({});
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/bulk",
      payload: { action: "reassign", taskIds: ["task-1"] }, // missing assignedAgentId
    });

    expect(response.statusCode).toBe(400);
  });

  it("validates agentic controls and maps thrown service errors through route error handling", async () => {
    app = buildApp({
      getAgenticRunTree: vi.fn(() => {
        throw new Error("run tree unavailable");
      }),
      invokeAgenticControl: vi.fn(),
      appendTaskDiagnostic: vi.fn(),
    });
    await app.register(tasksRoutes);

    await expect(
      app.inject({ method: "POST", url: "/api/v1/agentic/runs/run-1/control", payload: { action: "not-real" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: "GET", url: "/api/v1/agentic/runs/run-1/tree" })).resolves.toMatchObject({
      statusCode: 500,
    });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/tasks/task-1/agentic/diagnostics", payload: { code: "bad" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
  });
});

function buildApp(taskOverrides: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", {
    tasks: {
      appendTaskActivity: vi.fn(),
      appendTaskDeliverable: vi.fn(),
      createTask: vi.fn(),
      getTask: vi.fn(),
      hardDeleteTask: vi.fn(),
      listTaskActivities: vi.fn(() => []),
      listTaskDeliverables: vi.fn(() => []),
      listTasks: vi.fn(() => []),
      listTaskSubagents: vi.fn(() => []),
      listAgenticRuns: vi.fn(() => ({ items: [] })),
      getAgenticRunTree: vi.fn(() => ({ runId: "run-1", children: [] })),
      invokeAgenticControl: vi.fn(() => ({ accepted: true })),
      appendTaskDiagnostic: vi.fn(),
      registerTaskSubagent: vi.fn(),
      restoreTask: vi.fn(),
      softDeleteTask: vi.fn(),
      updateTask: vi.fn(),
      updateTaskSubagent: vi.fn(),
      emitDistressSignal: vi.fn((_taskId: string, input: Record<string, unknown>) => ({
        taskId: "task-1",
        distressSignals: [{ signalId: "signal-1", ...input }],
      })),
      resolveDistressSignal: vi.fn((_taskId: string, _signalId: string) => ({
        taskId: "task-1",
        distressSignals: [],
      })),
      setRetryBudget: vi.fn((_taskId: string, maxRetries: number) => ({
        taskId: "task-1",
        retryBudget: { maxRetries, retryCount: 0 },
      })),
      verifyTaskArtifacts: vi.fn((_taskId: string) => Promise.resolve({ taskId: "task-1" })),
      bulkUpdateTasks: vi.fn((input: { taskIds: string[] }) => input.taskIds.map((taskId) => ({ taskId }))),
      ...taskOverrides,
    },
    llm: {
      listLlmProviders: vi.fn(() => [
        {
          providerId: "provider-openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-5.1",
          hasApiKey: false,
          apiKeySource: "none",
        },
      ]),
    },
    integrations: {
      listIntegrationPlugins: vi.fn(() => [
        {
          pluginId: "plugin-corrupt",
          label: "Corrupt Plugin",
          version: "1.0.0",
          enabled: true,
          installedAt: "2026-05-05T00:00:00.000Z",
          updatedAt: "2026-05-05T00:00:00.000Z",
          capabilities: ["channel.send"],
          integrityStatus: "mismatch",
        },
      ]),
      listIntegrationCatalog: vi.fn(() => [
        {
          catalogId: "channel.telegram",
          kind: "channel",
          key: "telegram",
          label: "Telegram",
          description: "Telegram",
          maturity: "native",
          runtimeAvailability: "runnable",
          authMethods: ["token"],
          capabilities: ["channel.send"],
        },
      ]),
      listIntegrationConnections: vi.fn(() => [
        {
          connectionId: "conn-telegram",
          catalogId: "channel.telegram",
          kind: "channel",
          key: "telegram",
          label: "Telegram",
          enabled: true,
          status: "connected",
          config: {},
          createdAt: "2026-05-05T00:00:00.000Z",
          updatedAt: "2026-05-05T00:00:00.000Z",
        },
      ]),
    },
  } as never);
  return next;
}
