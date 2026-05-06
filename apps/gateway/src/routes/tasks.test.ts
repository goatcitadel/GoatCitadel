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
  });

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
      registerTaskSubagent: vi.fn(),
      restoreTask: vi.fn(),
      softDeleteTask: vi.fn(),
      updateTask: vi.fn(),
      updateTaskSubagent: vi.fn(),
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
