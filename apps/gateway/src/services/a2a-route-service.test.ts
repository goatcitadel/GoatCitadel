import { afterEach, describe, expect, it, vi } from "vitest";
import type { A2AJsonRpcResponse, TaskRecord } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { A2ARouteService } from "./a2a-route-service.js";

describe("A2ARouteService", () => {
  let storage: Storage | undefined;

  afterEach(() => {
    storage?.close();
    storage = undefined;
  });

  it("rejects missing peer credentials before JSON-RPC dispatch", () => {
    const harness = createService();

    expect(harness.service.authenticatePeerRequest({ headers: {} })).toMatchObject({
      statusCode: 401,
      reason: "a2a_peer_token_required",
    });
    expect(
      harness.service.authenticatePeerRequest({
        headers: { authorization: "Bearer peer-token" },
      }),
    ).toMatchObject({
      peerId: "peer-1",
      scopes: ["a2a:jsonrpc"],
    });
  });

  it("binds duplicate inbound SendMessage calls to the existing local task", async () => {
    const harness = createService();
    const payload = {
      jsonrpc: "2.0",
      id: "rpc-1",
      method: "SendMessage",
      params: {
        contextId: "ctx-1",
        messageId: "message-1",
        message: {
          role: "user",
          parts: [{ kind: "text", text: "Summarize the runtime proof." }],
        },
      },
    };

    const first = await harness.service.handleJsonRpc({ peerId: "peer-1", scopes: ["a2a:jsonrpc"] }, payload);
    const second = await harness.service.handleJsonRpc({ peerId: "peer-1", scopes: ["a2a:jsonrpc"] }, payload);

    expect(readResultTask(first)).toMatchObject({
      id: expect.stringMatching(/^a2a_/),
      contextId: "ctx-1",
      metadata: {
        localTaskId: "task-1",
        sessionId: "session-1",
        durableRunId: "durable-1",
      },
    });
    expect(readResultTask(second)).toMatchObject({
      id: readResultTask(first).id,
      metadata: {
        localTaskId: "task-1",
        sessionId: "session-1",
        durableRunId: "durable-1",
      },
    });
    expect(harness.tasks.createTask).toHaveBeenCalledTimes(1);
    expect(harness.chatTurnRuntime.agentSendChatMessage).toHaveBeenCalledTimes(1);
    expect(harness.storage.a2aTaskBindings.listByPeer("peer-1")).toHaveLength(1);
  });

  it("serves authenticated extended cards and HTTP+JSON tasks through peer credentials", async () => {
    const harness = createService({ bindings: ["HTTP_JSON"] });

    const card = harness.service.getAuthenticatedExtendedAgentCard(
      { peerId: "peer-1", scopes: ["a2a:http-json"] },
      { checkedAt: "2026-06-01T00:00:00.000Z", baseUrl: "http://127.0.0.1:8787" },
    );
    const task = await harness.service.sendHttpJsonMessage(
      { peerId: "peer-1", scopes: ["a2a:http-json"] },
      {
        contextId: "ctx-http",
        messageId: "message-http",
        message: { role: "user", parts: [{ kind: "text", text: "Review HTTP+JSON bridge." }] },
      },
      "2026-06-01T00:00:00.000Z",
    );
    const events = harness.service.getHttpJsonTaskEvents(
      { peerId: "peer-1", scopes: ["a2a:http-json"] },
      { taskId: task.id, lastEventSequence: 0 },
      "2026-06-01T00:00:00.000Z",
    );

    expect(card).toMatchObject({
      capabilities: {
        extendedAgentCard: true,
      },
      authenticatedPeer: {
        peerId: "peer-1",
        scopes: ["a2a:http-json"],
      },
      boundary: "gateway_peer_authenticated",
    });
    expect(card.supportedInterfaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ protocolBinding: "HTTP_JSON", enabled: true })]),
    );
    expect(task).toMatchObject({
      contextId: "ctx-http",
      metadata: {
        durableRunId: "durable-1",
      },
    });
    expect(events.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "task.status" })]));
  });

  it("persists peer push configs and delivers status updates through the allowlisted side-effect path", async () => {
    const pushDeliveryFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 202 }));
    const harness = createService({ pushDeliveryFetch, networkAllowlist: ["peer.example"] });

    const created = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-create",
        method: "SendMessage",
        params: {
          contextId: "ctx-push",
          messageId: "message-push",
          message: { role: "user", parts: [{ kind: "text", text: "Track push delivery." }] },
        },
      },
      "2026-06-01T00:00:00.000Z",
    );
    const taskId = readResultTask(created).id;

    const configured = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-push-set",
        method: "SetTaskPushNotificationConfig",
        params: {
          taskId,
          pushNotificationConfig: {
            url: "https://peer.example/a2a/push",
            events: ["task.status"],
            authentication: { token: "notify-token" },
            maxAttempts: 2,
          },
        },
      },
      "2026-06-01T00:00:01.000Z",
    );

    const config = readResult(configured).config;
    expect(config).toMatchObject({
      taskId,
      peerId: "peer-1",
      url: "https://peer.example/a2a/push",
      lastDeliveryStatus: "delivered",
      auth: { scheme: "bearer", tokenPreview: "noti...oken" },
    });
    expect(JSON.stringify(config)).not.toContain("notify-token");
    expect(harness.storage.a2aTaskPushConfigs.get(taskId, "peer-1").authToken).toBe("notify-token");
    expect(pushDeliveryFetch).toHaveBeenCalledWith(
      "https://peer.example/a2a/push",
      expect.objectContaining({
        allowlist: ["peer.example"],
        init: expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ authorization: "Bearer notify-token" }),
        }),
      }),
    );

    const listed = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-push-list",
        method: "ListTaskPushNotificationConfig",
        params: {},
      },
      "2026-06-01T00:00:02.000Z",
    );
    expect(readResult(listed).configs).toHaveLength(1);

    await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-cancel",
        method: "CancelTask",
        params: { taskId },
      },
      "2026-06-01T00:00:03.000Z",
    );
    expect(pushDeliveryFetch).toHaveBeenCalledTimes(2);
    expect(harness.storage.a2aTaskPushConfigs.get(taskId, "peer-1")).toMatchObject({
      lastDeliveryStatus: "delivered",
      attemptCount: 2,
    });
  });

  it("keeps A2A task reads, cancellation, and push configs scoped to the authenticated peer", async () => {
    const harness = createService();
    const created = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-create",
        method: "SendMessage",
        params: { contextId: "ctx-owned", messageId: "owned", text: "Owned by peer 1." },
      },
    );
    const taskId = readResultTask(created).id;

    for (const method of ["GetTask", "CancelTask", "SetTaskPushNotificationConfig"] as const) {
      const response = await harness.service.handleJsonRpc(
        { peerId: "peer-2", scopes: ["a2a:jsonrpc"] },
        {
          jsonrpc: "2.0",
          id: `rpc-${method}`,
          method,
          params: {
            taskId,
            pushNotificationConfig: { url: "https://peer.example/a2a/push" },
          },
        },
      );
      expect(response).toMatchObject({
        error: {
          code: -32022,
          message: "A2A task is not owned by the authenticated peer.",
        },
      });
    }
  });

  function createService(
    options: {
      bindings?: Array<"JSONRPC" | "HTTP_JSON">;
      pushDeliveryFetch?: A2ARouteServiceDependencies["pushDeliveryFetch"];
      networkAllowlist?: string[];
    } = {},
  ) {
    storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: ".",
      auditDir: ".",
    });
    const task: TaskRecord = {
      taskId: "task-1",
      workspaceId: "default",
      title: "A2A task",
      status: "in_progress",
      priority: "normal",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const tasks = {
      appendTaskActivity: vi.fn(),
      createTask: vi.fn((input: Partial<TaskRecord>) => ({ ...task, ...input })),
      getTask: vi.fn(() => task),
      invokeAgenticControl: vi.fn(),
      listTaskDeliverables: vi.fn(() => []),
      updateTask: vi.fn((_taskId: string, input: Partial<TaskRecord>) => ({ ...task, ...input })),
    };
    const chatTurnRuntime = {
      agentSendChatMessage: vi.fn(async () => ({
        sessionId: "session-1",
        turnId: "turn-1",
        durableRunId: "durable-1",
      })),
    };
    const service = new A2ARouteService({
      config: {
        assistant: {
          a2a: {
            enabled: true,
            publicDiscoveryEnabled: false,
            protocolVersion: "1.0",
            bindings: options.bindings ?? ["JSONRPC"],
            inbound: {
              enabled: true,
              peerCredentials: [{ peerId: "peer-1", token: "peer-token" }],
            },
            outbound: {
              enabled: false,
              peers: [],
            },
          },
        },
        toolPolicy: {
          sandbox: {
            networkAllowlist: options.networkAllowlist ?? [],
          },
        },
      } as never,
      storage,
      tasks,
      createChatSession: vi.fn(() => ({ sessionId: "session-1" })),
      chatTurnRuntime,
      mutationIdempotencyStore: storage.mutationIdempotency,
      pushDeliveryFetch: options.pushDeliveryFetch,
    });
    return { service, storage, tasks, chatTurnRuntime };
  }
});

type A2ARouteServiceDependencies = ConstructorParameters<typeof A2ARouteService>[0];

function readResultTask(response: A2AJsonRpcResponse) {
  if ("error" in response) {
    throw new Error(response.error.message);
  }
  return (response.result as { task: unknown }).task as {
    id: string;
    contextId: string;
    metadata: Record<string, unknown>;
  };
}

function readResult(response: A2AJsonRpcResponse) {
  if ("error" in response) {
    throw new Error(response.error.message);
  }
  return response.result as {
    config: Record<string, unknown>;
    configs: Array<Record<string, unknown>>;
  };
}
