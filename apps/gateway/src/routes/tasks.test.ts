import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ConflictError, ValidationError, type A2ATaskExportPreviewRequest } from "@goatcitadel/contracts";
import { buildA2ABridgeStatus, buildA2ATaskExportPreview } from "../services/a2a-bridge-service.js";
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
        revision: 7,
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
      items: [{ taskId: "task-1", revision: 7 }],
      nextCursor: "2026-04-24T01:00:00.000Z|task-1",
      view: "active",
    });
  });

  it("requires a confirmation token for hard delete", async () => {
    const hardDeleteTaskWithRevision = vi.fn(() => true);
    const softDeleteTaskWithRevision = vi.fn(() => true);

    app = buildApp({ hardDeleteTaskWithRevision, softDeleteTaskWithRevision });
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/tasks/task-1?mode=hard",
      payload: { expectedRevision: 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(hardDeleteTaskWithRevision).not.toHaveBeenCalled();
    expect(softDeleteTaskWithRevision).not.toHaveBeenCalled();
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
    expect(appendTaskActivity).toHaveBeenCalledWith(
      "task-1",
      {
        activityType: "comment",
        message: "Moved task ownership out of the gateway.",
      },
      { workspaceId: undefined },
    );
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
      providers: [
        expect.objectContaining({
          runtimeId: "provider-openai",
          status: "not_configured",
          manifestSource: "https://api.openai.com/access-token/[REDACTED]?token=[REDACTED]",
        }),
      ],
      plugins: [
        expect.objectContaining({
          runtimeId: "plugin-corrupt",
          status: "unavailable",
          manifestSource: "URL: https://plugins.example.test/api-key/[REDACTED]?token=[REDACTED]",
        }),
      ],
      channels: [expect.objectContaining({ capabilityId: "channel:telegram", status: "callable", callable: true })],
      scalability: expect.arrayContaining([
        expect.objectContaining({
          trackId: "openai_agents_sdk",
          status: "blocked",
          callable: false,
          implementationStatus: "partial",
        }),
        expect.objectContaining({
          trackId: "a2a_protocol",
          status: "blocked",
          callable: false,
          implementationStatus: "partial",
        }),
      ]),
    });
    expect(response.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "provider:provider-openai",
          status: "not_configured",
          callable: false,
        }),
        expect.objectContaining({ capabilityId: "plugin:plugin-corrupt", status: "unavailable", callable: false }),
        expect.objectContaining({
          capabilityId: "scalability:a2a_protocol",
          family: "agent_protocol",
          status: "blocked",
          callable: false,
        }),
      ]),
    );
  }, 15_000);

  it("exposes governed A2A agent-card and task-export preview routes without external sends", async () => {
    app = buildApp({});
    await app.register(tasksRoutes);

    const card = await app.inject({
      method: "GET",
      url: "/api/v1/a2a/agent-card",
      headers: { host: "127.0.0.1:8787" },
    });
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/a2a/task-preview",
      payload: {
        goal: "Review the release evidence and summarize blockers.",
        sourceSurface: "cowork",
        workspaceId: "default",
        sessionId: "session-1",
        artifactRefs: ["evidence:env-1", "artifact:report-1"],
      },
    });

    expect(card.statusCode).toBe(200);
    const cardJson = card.json();
    expect(cardJson).toMatchObject({
      status: "preview_ready",
      agentCard: {
        name: "GoatCitadel Mission Control",
        publicationStatus: "draft_operator_preview",
        discoveryPublished: false,
        capabilities: {
          streaming: false,
          pushNotifications: false,
        },
      },
      previewRoutes: {
        taskPreview: "http://127.0.0.1:8787/api/v1/a2a/task-preview",
      },
      governance: {
        exposure: "operator_api_only",
        callable: false,
        outboundNetworkEnabled: false,
        inboundJsonRpcEnabled: false,
        inboundHttpJsonEnabled: false,
      },
    });
    expect(cardJson.agentCard.supportedInterfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "http://127.0.0.1:8787/api/v1/a2a/jsonrpc",
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
          enabled: false,
        }),
        expect.objectContaining({
          protocolBinding: "GRPC",
          enabled: false,
        }),
        expect.objectContaining({
          protocolBinding: "HTTP_JSON",
          enabled: false,
        }),
      ]),
    );
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      status: "preview",
      task: {
        contextId: "session-1",
        status: { state: "submitted" },
        messages: [
          {
            role: "user",
            parts: [{ kind: "text", text: "Review the release evidence and summarize blockers." }],
          },
        ],
        artifacts: [
          expect.objectContaining({ uri: "evidence:env-1" }),
          expect.objectContaining({ uri: "artifact:report-1" }),
        ],
      },
      governance: {
        replayPolicy: "preview_only",
        outboundNetworkEnabled: false,
      },
      warnings: expect.arrayContaining([expect.stringContaining("no A2A client request")]),
    });
  });

  it("keeps public A2A discovery disabled by default", async () => {
    app = buildApp({});
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/.well-known/agent-card.json",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "A2A public discovery is disabled." });
  });

  it("protects inbound A2A JSON-RPC with peer credentials", async () => {
    const authenticatePeerRequest = vi
      .fn()
      .mockReturnValueOnce({ statusCode: 401, reason: "a2a_peer_token_required", message: "token required" })
      .mockReturnValueOnce({ peerId: "peer-1", scopes: ["a2a:jsonrpc"] })
      .mockReturnValueOnce({ peerId: "peer-1", scopes: ["a2a:jsonrpc"] });
    const handleJsonRpc = vi.fn(async () => ({ jsonrpc: "2.0", id: "1", result: { ok: true } }));
    app = buildApp(
      {},
      {
        a2a: {
          ...createDefaultA2AService(),
          authenticatePeerRequest,
          handleJsonRpc,
        },
      },
    );
    await app.register(tasksRoutes);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/a2a/jsonrpc",
      payload: { jsonrpc: "2.0", id: "1", method: "GetTask", params: { taskId: "task-1" } },
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/a2a/jsonrpc",
      headers: { authorization: "Bearer peer-token" },
      payload: { jsonrpc: "2.0", id: "1", method: "GetTask", params: { taskId: "task-1" } },
    });

    expect(rejected.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ result: { ok: true } });
    expect(handleJsonRpc).toHaveBeenCalledWith(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      expect.objectContaining({ method: "GetTask" }),
      expect.any(String),
    );
  });

  it("protects A2A HTTP+JSON and authenticated extended cards with peer credentials", async () => {
    const authenticatePeerRequest = vi.fn().mockReturnValue({ peerId: "peer-1", scopes: ["a2a:http-json"] });
    const task = {
      id: "a2a-task-1",
      contextId: "ctx-1",
      status: { state: "working", timestamp: "2026-06-01T00:00:00.000Z" },
      messages: [],
      artifacts: [],
      metadata: { bridge: "goatcitadel-a2a" },
    };
    const getAuthenticatedExtendedAgentCard = vi.fn(() => ({
      name: "GoatCitadel Mission Control",
      capabilities: { extendedAgentCard: true },
      authenticatedPeer: { peerId: "peer-1", scopes: ["a2a:http-json"] },
      boundary: "gateway_peer_authenticated",
    }));
    const sendHttpJsonMessage = vi.fn(async () => task);
    const getHttpJsonTask = vi.fn(() => task);
    const cancelHttpJsonTask = vi.fn(async () => ({ ...task, status: { ...task.status, state: "canceled" } }));
    const getHttpJsonTaskEvents = vi.fn(() => ({
      task,
      events: [
        {
          sequence: 1,
          taskId: "a2a-task-1",
          contextId: "ctx-1",
          kind: "task.status",
          timestamp: task.status.timestamp,
        },
      ],
    }));
    app = buildApp(
      {},
      {
        a2a: {
          ...createDefaultA2AService(),
          authenticatePeerRequest,
          getAuthenticatedExtendedAgentCard,
          sendHttpJsonMessage,
          getHttpJsonTask,
          cancelHttpJsonTask,
          getHttpJsonTaskEvents,
        },
      },
    );
    await app.register(tasksRoutes);

    const headers = { authorization: "Bearer peer-token" };
    const card = await app.inject({ method: "GET", url: "/api/v1/a2a/extended-agent-card", headers });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/a2a/http-json/tasks",
      headers,
      payload: { contextId: "ctx-1", message: { parts: [{ kind: "text", text: "Run it." }] } },
    });
    const read = await app.inject({ method: "GET", url: "/api/v1/a2a/http-json/tasks/a2a-task-1", headers });
    const events = await app.inject({
      method: "GET",
      url: "/api/v1/a2a/http-json/tasks/a2a-task-1/events?lastEventSequence=0",
      headers,
    });
    const canceled = await app.inject({
      method: "POST",
      url: "/api/v1/a2a/http-json/tasks/a2a-task-1/cancel",
      headers,
    });

    expect(card.statusCode).toBe(200);
    expect(card.json()).toMatchObject({ boundary: "gateway_peer_authenticated" });
    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({ task: { id: "a2a-task-1" } });
    expect(read.statusCode).toBe(200);
    expect(events.json()).toMatchObject({ events: [expect.objectContaining({ kind: "task.status" })] });
    expect(canceled.json()).toMatchObject({ task: { status: { state: "canceled" } } });
    expect(sendHttpJsonMessage).toHaveBeenCalledWith(
      { peerId: "peer-1", scopes: ["a2a:http-json"] },
      expect.objectContaining({ contextId: "ctx-1" }),
      expect.any(String),
    );
    expect(getHttpJsonTask).toHaveBeenCalledWith(
      { peerId: "peer-1", scopes: ["a2a:http-json"] },
      { taskId: "a2a-task-1" },
      expect.any(String),
    );
    expect(getHttpJsonTaskEvents).toHaveBeenCalledWith(
      { peerId: "peer-1", scopes: ["a2a:http-json"] },
      { taskId: "a2a-task-1", lastEventSequence: 0 },
      expect.any(String),
    );
    expect(cancelHttpJsonTask).toHaveBeenCalledWith(
      { peerId: "peer-1", scopes: ["a2a:http-json"] },
      { taskId: "a2a-task-1" },
      expect.any(String),
    );
  });

  it("projects authenticated A2A HTTP, JSON-RPC, outbound, and error boundaries without reshaping authored messages", async () => {
    const authoredText = "Peer-authored Authorization: Bearer keep-this-message";
    const artifact = {
      artifactId: "artifact-secret",
      name: "Local artifact",
      uri: "https://discord.com/api/webhooks/team-id/route-discord-short",
      parts: [
        {
          kind: "data",
          data: {
            description: "Authorization: Bearer tiny at https://api.telegram.org/botroute-telegram-short/sendMessage",
            path: "https://local.example/token/route-generic-short",
          },
        },
      ],
      metadata: { authorization: "Bearer tiny" },
    };
    const message = { role: "user", parts: [{ kind: "text", text: authoredText }] };
    const task = {
      id: "a2a-task-secret",
      contextId: "ctx-secret",
      status: { state: "working", timestamp: "2026-06-01T00:00:00.000Z" },
      messages: [message],
      artifacts: [artifact],
      metadata: { bridge: "goatcitadel-a2a", authorization: "Bearer tiny" },
    };
    const routeError = Object.assign(
      new Error("Authorization: Bearer tiny at https://api.telegram.org/botroute-error-short/sendMessage"),
      { statusCode: 400, reason: "a2a_task_failed" },
    );
    const authenticatePeerRequest = vi.fn(() => ({ peerId: "peer-1", scopes: ["a2a:http-json"] }));
    app = buildApp(
      {},
      {
        a2a: {
          ...createDefaultA2AService(),
          authenticatePeerRequest,
          handleJsonRpc: vi.fn(async () => ({ jsonrpc: "2.0", id: "rpc-secret", result: { task } })),
          getHttpJsonTask: vi.fn(() => task),
          getHttpJsonTaskEvents: vi.fn(() => ({
            task,
            events: [
              {
                sequence: 1,
                taskId: task.id,
                contextId: task.contextId,
                kind: "task.message",
                timestamp: task.status.timestamp,
                message,
              },
              {
                sequence: 2,
                taskId: task.id,
                contextId: task.contextId,
                kind: "task.artifact",
                timestamp: task.status.timestamp,
                artifact,
              },
            ],
          })),
          cancelHttpJsonTask: vi.fn(async () => {
            throw routeError;
          }),
          previewOutbound: vi.fn(() => ({
            checkedAt: "2026-06-01T00:00:00.000Z",
            peerId: "peer-remote",
            method: "SendMessage",
            transport: "JSONRPC",
            callable: true,
            governance: {},
            warnings: [],
            envelope: {
              jsonrpc: "2.0",
              id: "outbound-preview",
              method: "SendMessage",
              params: { message, artifact },
            },
          })),
          sendOutbound: vi.fn(async () => ({
            checkedAt: "2026-06-01T00:00:00.000Z",
            peerId: "peer-remote",
            method: "SendMessage",
            transport: "JSONRPC",
            status: "sent",
            idempotencyKey: "outbound-send",
            warnings: [],
            response: { jsonrpc: "2.0", id: "outbound-send", result: { task } },
          })),
        },
      },
    );
    await app.register(tasksRoutes);
    const headers = { authorization: "Bearer peer-token" };

    const jsonRpc = await app.inject({
      method: "POST",
      url: "/api/v1/a2a/jsonrpc",
      headers,
      payload: { jsonrpc: "2.0", id: "rpc-secret", method: "GetTask", params: { taskId: task.id } },
    });
    const httpTask = await app.inject({
      method: "GET",
      url: `/api/v1/a2a/http-json/tasks/${task.id}`,
      headers,
    });
    const events = await app.inject({
      method: "GET",
      url: `/api/v1/a2a/http-json/tasks/${task.id}/events?lastEventSequence=0`,
      headers,
    });
    const failed = await app.inject({
      method: "POST",
      url: `/api/v1/a2a/http-json/tasks/${task.id}/cancel`,
      headers,
    });
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/a2a/outbound/preview",
      payload: { peerId: "peer-remote", method: "SendMessage", params: { message, artifact } },
    });
    const sent = await app.inject({
      method: "POST",
      url: "/api/v1/a2a/outbound/send",
      payload: { peerId: "peer-remote", method: "SendMessage", params: { message, artifact } },
    });

    for (const response of [jsonRpc, httpTask, events, preview, sent]) {
      expect(response.body).not.toContain("route-discord-short");
      expect(response.body).not.toContain("route-telegram-short");
      expect(response.body).not.toContain("route-generic-short");
      expect(response.body).not.toContain("Bearer tiny");
    }
    for (const response of [jsonRpc, httpTask, events, sent]) {
      expect(response.body).toContain(authoredText);
    }
    expect(preview.json().envelope.params.message).toMatchObject({
      role: "user",
      parts: [expect.objectContaining({ kind: "text" })],
    });
    expect(preview.body).not.toContain("keep-this-message");
    expect(failed.statusCode).toBe(400);
    expect(failed.body).toContain("[REDACTED]");
    expect(failed.body).not.toContain("Bearer tiny");
    expect(failed.body).not.toContain("route-error-short");
    expect(JSON.stringify(task)).toContain("route-discord-short");
    expect(JSON.stringify(message)).toContain(authoredText);
  });

  it("keeps A2A peer routes with literal rate limits visible to CodeQL", () => {
    const source = readFileSync(new URL("./tasks.ts", import.meta.url), "utf8");

    expect(source).toMatch(
      /fastify\.get\(\s*"\/api\/v1\/a2a\/extended-agent-card"[\s\S]*?rateLimit: \{ max: KANBAN_GENERAL_RATE_LIMIT_MAX \}/,
    );
    expect(source).toMatch(
      /fastify\.get\(\s*"\/api\/v1\/a2a\/http-json\/tasks\/:taskId"[\s\S]*?rateLimit: \{ max: KANBAN_GENERAL_RATE_LIMIT_MAX \}/,
    );
    expect(source).toMatch(
      /fastify\.post\(\s*"\/api\/v1\/a2a\/http-json\/tasks\/:taskId\/cancel"[\s\S]*?rateLimit: \{ max: KANBAN_MUTATION_RATE_LIMIT_MAX \}/,
    );
    expect(source).toMatch(
      /fastify\.get\(\s*"\/api\/v1\/a2a\/http-json\/tasks\/:taskId\/events"[\s\S]*?rateLimit: \{ max: KANBAN_GENERAL_RATE_LIMIT_MAX \}/,
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

  it("accepts contract-valid subagent depth metadata on create and update", async () => {
    const registerTaskSubagent = vi.fn((_taskId: string, input: Record<string, unknown>) => ({
      agentSessionId: input.agentSessionId,
      metadata: input.metadata,
    }));
    const updateTaskSubagent = vi.fn((_agentSessionId: string, input: Record<string, unknown>) => ({
      agentSessionId: "agent-session-1",
      ...input,
    }));

    app = buildApp({ registerTaskSubagent, updateTaskSubagent });
    await app.register(tasksRoutes);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-1/subagents",
      payload: {
        agentSessionId: "agent-session-1",
        metadata: {
          runId: "run-child",
          parentRunId: "run-parent",
          index: 1,
          depth: 2,
          contextMode: "fork",
        },
      },
    });
    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/subagents/agent-session-1",
      payload: {
        metadata: {
          depth: 3,
          contextMode: "isolated",
        },
      },
    });

    expect(created.statusCode).toBe(201);
    expect(updated.statusCode).toBe(200);
    expect(registerTaskSubagent).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        metadata: expect.objectContaining({ depth: 2 }),
      }),
      { workspaceId: undefined },
    );
    expect(updateTaskSubagent).toHaveBeenCalledWith(
      "agent-session-1",
      expect.objectContaining({
        metadata: expect.objectContaining({ depth: 3 }),
      }),
      { workspaceId: undefined },
    );
  });

  it("creates, updates, soft-deletes, restores, and hard-deletes tasks through the service contract", async () => {
    const createTask = vi.fn((input: Record<string, unknown>) => ({ taskId: "task-1", ...input }));
    const updateTaskWithRevision = vi.fn((taskId: string, input: Record<string, unknown>, revision: number) => ({
      taskId,
      revision,
      ...input,
    }));
    const softDeleteTaskWithRevision = vi.fn(() => true);
    const restoreTaskWithRevision = vi.fn(() => true);
    const hardDeleteTaskWithRevision = vi.fn(() => true);

    app = buildApp({
      createTask,
      updateTaskWithRevision,
      softDeleteTaskWithRevision,
      restoreTaskWithRevision,
      hardDeleteTaskWithRevision,
    });
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
        expectedRevision: 1,
        title: "Runtime validation updated",
        assignedAgentId: null,
      },
    });
    const softDeleted = await app.inject({
      method: "DELETE",
      url: "/api/v1/tasks/task-1",
      payload: {
        expectedRevision: 2,
        deletedBy: "operator",
        deleteReason: "cleanup",
      },
    });
    const restored = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-1/restore",
      payload: { expectedRevision: 3 },
    });
    const hardDeleted = await app.inject({
      method: "DELETE",
      url: "/api/v1/tasks/task-1?mode=hard",
      payload: {
        expectedRevision: 4,
        confirmToken: "PERMANENT_DELETE",
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ taskId: "task-1", title: "Runtime validation" });
    expect(updateTaskWithRevision).toHaveBeenCalledWith(
      "task-1",
      {
        title: "Runtime validation updated",
        assignedAgentId: null,
      },
      1,
      { workspaceId: undefined },
    );
    expect(updated.json()).toMatchObject({ taskId: "task-1", title: "Runtime validation updated" });
    expect(softDeleted.json()).toEqual({ deleted: true, taskId: "task-1", mode: "soft" });
    expect(softDeleteTaskWithRevision).toHaveBeenCalledWith("task-1", 2, "operator", "cleanup", {
      workspaceId: undefined,
    });
    expect(restored.json()).toEqual({ restored: true, taskId: "task-1" });
    expect(hardDeleted.json()).toEqual({ deleted: true, taskId: "task-1", mode: "hard" });
  });

  it("returns not-found responses for task delete and restore misses", async () => {
    app = buildApp({
      softDeleteTaskWithRevision: vi.fn(() => false),
      restoreTaskWithRevision: vi.fn(() => false),
    });
    await app.register(tasksRoutes);

    await expect(
      app.inject({ method: "DELETE", url: "/api/v1/tasks/missing", payload: { expectedRevision: 1 } }),
    ).resolves.toMatchObject({ statusCode: 404 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/tasks/missing/restore", payload: { expectedRevision: 1 } }),
    ).resolves.toMatchObject({ statusCode: 404 });
  });

  it("requires a positive revision and returns a structured 409 for stale task patches", async () => {
    const updateTaskWithRevision = vi.fn(() => {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: "Task task-1 changed since revision 2.",
        details: {
          resourceKind: "task",
          resourceId: "task-1",
          expectedRevision: 2,
          currentRevision: 3,
        },
      });
    });
    app = buildApp({ updateTaskWithRevision });
    await app.register(tasksRoutes);

    const missingRevision = await app.inject({
      method: "PATCH",
      url: "/api/v1/tasks/task-1",
      payload: { title: "Unsafe overwrite" },
    });
    const stale = await app.inject({
      method: "PATCH",
      url: "/api/v1/tasks/task-1",
      payload: { expectedRevision: 2, title: "Stale overwrite" },
    });

    expect(missingRevision.statusCode).toBe(400);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: "WRITE_CONFLICT",
      details: {
        resourceKind: "task",
        resourceId: "task-1",
        expectedRevision: 2,
        currentRevision: 3,
      },
    });
    expect(updateTaskWithRevision).toHaveBeenCalledTimes(1);
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
    const tree = await app.inject({ method: "GET", url: "/api/v1/agentic/runs/run-1/tree?workspaceId=default" });
    const control = await app.inject({
      method: "POST",
      url: "/api/v1/agentic/runs/run-1/control?workspaceId=default",
      payload: {
        action: "steer",
        expectedRevision: 5,
        instruction: "stay scoped",
        actorId: "spoofed-client",
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
    const timeoutDiagnostic = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-1/agentic/diagnostics",
      payload: {
        code: "timeout_exceeded",
        severity: "critical",
        title: "Child timed out",
        summary: "The child worker exceeded the configured execution timeout.",
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
    expect(getAgenticRunTree).toHaveBeenCalledWith("run-1", { workspaceId: "default" });
    expect(control.json()).toMatchObject({ accepted: true, action: "steer", instruction: "stay scoped" });
    expect(invokeAgenticControl).toHaveBeenCalledWith("run-1", expect.objectContaining({ actorId: "operator-test" }), {
      workspaceId: "default",
    });
    expect(diagnostic.statusCode).toBe(201);
    expect(timeoutDiagnostic.statusCode).toBe(201);
    expect(appendTaskDiagnostic).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        code: "missing_claimed_test",
        severity: "warning",
      }),
      { workspaceId: undefined },
    );
    expect(appendTaskDiagnostic).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        code: "timeout_exceeded",
        severity: "critical",
      }),
      { workspaceId: undefined },
    );
  });

  it("maps invalid agentic run list workspace errors through the route error handler", async () => {
    const listAgenticRuns = vi.fn(() => {
      throw new ValidationError({ field: "workspaceId", message: "workspaceId contains unsupported characters" });
    });

    app = buildApp({ listAgenticRuns });
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agentic/runs?workspaceId=bad%2Fworkspace",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "workspaceId contains unsupported characters",
      code: "FIELD_INVALID",
    });
  });

  it("defaults agentic run list requests to the default workspace", async () => {
    const listAgenticRuns = vi.fn(() => ({ items: [] }));

    app = buildApp({ listAgenticRuns });
    await app.register(tasksRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/agentic/runs?surface=cowork" });

    expect(response.statusCode).toBe(200);
    expect(listAgenticRuns).toHaveBeenCalledWith({ workspaceId: "default", surface: "cowork", limit: 100 });
  });

  it("awaits workspace lookup before enforcing Citadel-scoped task access", async () => {
    const listTasks = vi.fn(() => []);
    const getWorkspace = vi.fn(async (workspaceId: string) => ({
      workspaceId,
      citadelId: "personal",
    }));
    app = buildApp({ listTasks }, { workspaces: { getWorkspace } });
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/tasks?citadelId=company&workspaceId=default",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "workspace default belongs to citadel personal, not company",
    });
    expect(getWorkspace).toHaveBeenCalledWith("default");
    expect(listTasks).not.toHaveBeenCalled();
  });

  it("emits a distress signal through the task route service", async () => {
    const emitDistressSignalWithRevision = vi.fn((_taskId: string, input: Record<string, unknown>) => ({
      taskId: "task-1",
      distressSignals: [{ signalId: "signal-1", code: input.code, severity: input.severity }],
    }));

    app = buildApp({ emitDistressSignalWithRevision });
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-1/distress",
      payload: {
        expectedRevision: 3,
        code: "worker_crash",
        severity: "critical",
        title: "Worker crashed unexpectedly",
        summary: "The worker process exited without closing the task.",
        emittedBy: "durable-runner",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(emitDistressSignalWithRevision).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ code: "worker_crash", severity: "critical" }),
      3,
      { workspaceId: undefined },
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
    const resolveDistressSignalWithRevision = vi.fn(() => ({ taskId: "task-1", distressSignals: [] }));

    app = buildApp({ resolveDistressSignalWithRevision });
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/tasks/task-1/distress/signal-1",
      payload: { expectedRevision: 4, resolvedBy: "spoofed-client" },
    });

    expect(response.statusCode).toBe(200);
    expect(resolveDistressSignalWithRevision).toHaveBeenCalledWith(
      "task-1",
      "signal-1",
      { resolvedBy: "operator-test" },
      4,
      {
        workspaceId: undefined,
      },
    );
    expect(response.json()).toMatchObject({ taskId: "task-1", distressSignals: [] });
  });

  it("sets the retry budget through the task route service", async () => {
    const setRetryBudgetWithRevision = vi.fn((_taskId: string, maxRetries: number) => ({
      taskId: "task-1",
      retryBudget: { maxRetries, retryCount: 0 },
    }));

    app = buildApp({ setRetryBudgetWithRevision });
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-1/retry-budget",
      payload: { expectedRevision: 5, maxRetries: 3 },
    });

    expect(response.statusCode).toBe(200);
    expect(setRetryBudgetWithRevision).toHaveBeenCalledWith("task-1", 3, 5, { workspaceId: undefined });
    expect(response.json()).toMatchObject({ retryBudget: { maxRetries: 3 } });
  });

  it("verifies task artifacts through the task route service", async () => {
    const verifyTaskArtifactsWithRevision = vi.fn(() =>
      Promise.resolve({ taskId: "task-1", artifactVerification: "ok" }),
    );

    app = buildApp({ verifyTaskArtifactsWithRevision });
    await app.register(tasksRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-1/verify-artifacts",
      payload: {
        expectedRevision: 6,
        claims: [{ kind: "file", value: "dist/output.js", label: "build output" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(verifyTaskArtifactsWithRevision).toHaveBeenCalledWith(
      "task-1",
      [expect.objectContaining({ kind: "file", value: "dist/output.js" })],
      6,
      { workspaceId: undefined },
    );
  });

  it("passes workspace expectations to direct task routes and caps artifact batches", async () => {
    const getTask = vi.fn(() => ({ taskId: "task-1", workspaceId: "workspace-a" }));
    const verifyTaskArtifactsWithRevision = vi.fn(() =>
      Promise.resolve({ taskId: "task-1", workspaceId: "workspace-a" }),
    );

    app = buildApp({ getTask, verifyTaskArtifactsWithRevision });
    await app.register(tasksRoutes);

    const task = await app.inject({
      method: "GET",
      url: "/api/v1/tasks/task-1?workspaceId=workspace-a",
    });
    const verified = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-1/verify-artifacts?workspaceId=workspace-a",
      payload: {
        expectedRevision: 7,
        claims: [{ kind: "file", value: "dist/output.js" }],
      },
    });
    const tooManyClaims = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/task-1/verify-artifacts?workspaceId=workspace-a",
      payload: {
        expectedRevision: 7,
        claims: Array.from({ length: 26 }, (_value, index) => ({
          kind: "file",
          value: `dist/output-${index}.js`,
        })),
      },
    });

    expect(task.statusCode).toBe(200);
    expect(verified.statusCode).toBe(200);
    expect(tooManyClaims.statusCode).toBe(400);
    expect(getTask).toHaveBeenCalledWith("task-1", { workspaceId: "workspace-a" });
    expect(verifyTaskArtifactsWithRevision).toHaveBeenCalledWith(
      "task-1",
      [expect.objectContaining({ kind: "file", value: "dist/output.js" })],
      7,
      { workspaceId: "workspace-a" },
    );
    expect(verifyTaskArtifactsWithRevision).toHaveBeenCalledTimes(1);
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
        expectedRevisionsByTaskId: {
          "task-1": 8,
          "task-2": 11,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(bulkUpdateTasks).toHaveBeenCalledWith(
      {
        action: "reassign",
        taskIds: ["task-1", "task-2"],
        assignedAgentId: "agent-2",
        expectedRevisionsByTaskId: {
          "task-1": 8,
          "task-2": 11,
        },
      },
      { workspaceId: undefined },
    );
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

function buildApp(
  taskOverrides: Record<string, unknown>,
  serviceOverrides: {
    a2a?: ReturnType<typeof createDefaultA2AService>;
    workspaces?: { getWorkspace: (workspaceId: string) => Promise<{ workspaceId: string; citadelId?: string }> };
  } = {},
): FastifyInstance {
  const next = Fastify();
  next.decorate("requireOperatorAuth", async () => undefined);
  next.decorateRequest("authActorId", "operator-test");
  next.decorateRequest("authActorSource", "loopback");
  next.decorate("services", {
    a2a: serviceOverrides.a2a ?? createDefaultA2AService(),
    workspaces: serviceOverrides.workspaces,
    tasks: {
      appendTaskActivity: vi.fn(),
      appendTaskDeliverable: vi.fn(),
      createTask: vi.fn(),
      getTask: vi.fn(),
      hardDeleteTask: vi.fn(),
      hardDeleteTaskWithRevision: vi.fn(),
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
      restoreTaskWithRevision: vi.fn(),
      softDeleteTask: vi.fn(),
      softDeleteTaskWithRevision: vi.fn(),
      updateTask: vi.fn(),
      updateTaskWithRevision: vi.fn(),
      updateTaskSubagent: vi.fn(),
      emitDistressSignal: vi.fn((_taskId: string, input: Record<string, unknown>) => ({
        taskId: "task-1",
        distressSignals: [{ signalId: "signal-1", ...input }],
      })),
      emitDistressSignalWithRevision: vi.fn((_taskId: string, input: Record<string, unknown>) => ({
        taskId: "task-1",
        distressSignals: [{ signalId: "signal-1", ...input }],
      })),
      resolveDistressSignal: vi.fn((_taskId: string, _signalId: string) => ({
        taskId: "task-1",
        distressSignals: [],
      })),
      resolveDistressSignalWithRevision: vi.fn((_taskId: string, _signalId: string) => ({
        taskId: "task-1",
        distressSignals: [],
      })),
      setRetryBudget: vi.fn((_taskId: string, maxRetries: number) => ({
        taskId: "task-1",
        retryBudget: { maxRetries, retryCount: 0 },
      })),
      setRetryBudgetWithRevision: vi.fn((_taskId: string, maxRetries: number) => ({
        taskId: "task-1",
        retryBudget: { maxRetries, retryCount: 0 },
      })),
      verifyTaskArtifacts: vi.fn((_taskId: string) => Promise.resolve({ taskId: "task-1" })),
      verifyTaskArtifactsWithRevision: vi.fn((_taskId: string) => Promise.resolve({ taskId: "task-1" })),
      bulkUpdateTasks: vi.fn((input: { taskIds: string[] }) => input.taskIds.map((taskId) => ({ taskId }))),
      ...taskOverrides,
    },
    llm: {
      listLlmProviders: vi.fn(() => [
        {
          providerId: "provider-openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/access-token/provider-availability-path?token=provider-availability-query",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-5.1",
          hasApiKey: false,
          apiKeySource: "none",
        },
      ]),
    },
    integrations: {
      listIntegrationPlugins: vi.fn(async () => [
        {
          pluginId: "plugin-corrupt",
          label: "Corrupt Plugin",
          version: "1.0.0",
          enabled: true,
          installedAt: "2026-05-05T00:00:00.000Z",
          updatedAt: "2026-05-05T00:00:00.000Z",
          capabilities: ["channel.send"],
          integrityStatus: "mismatch",
          sourceMetadata: {
            type: "url",
            display:
              "URL: https://plugins.example.test/api-key/plugin-availability-path?token=plugin-availability-query",
            integrityStatus: "mismatch",
          },
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
      listIntegrationConnections: vi.fn(async () => [
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

function createDefaultA2AService() {
  return {
    getStatus: vi.fn(({ checkedAt, baseUrl }: { checkedAt: string; baseUrl?: string }) =>
      buildA2ABridgeStatus({ checkedAt, baseUrl }),
    ),
    getPublicAgentCard: vi.fn(() => undefined),
    previewTaskExport: vi.fn((input: A2ATaskExportPreviewRequest, options: { checkedAt: string }) =>
      buildA2ATaskExportPreview(input, options),
    ),
    authenticatePeerRequest: vi.fn(() => ({
      statusCode: 503,
      reason: "a2a_inbound_disabled",
      message: "A2A inbound peer access is not enabled.",
    })),
    handleJsonRpc: vi.fn(),
    getAuthenticatedExtendedAgentCard: vi.fn(),
    sendHttpJsonMessage: vi.fn(),
    getHttpJsonTask: vi.fn(),
    cancelHttpJsonTask: vi.fn(),
    getHttpJsonTaskEvents: vi.fn(),
    previewOutbound: vi.fn(() => ({ checkedAt: "now", warnings: [], envelope: { jsonrpc: "2.0" } })),
    sendOutbound: vi.fn(),
    getBinding: vi.fn(),
  };
}
