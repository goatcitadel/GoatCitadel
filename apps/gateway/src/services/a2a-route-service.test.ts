import { afterEach, describe, expect, it, vi } from "vitest";
import type { A2AJsonRpcResponse, TaskDeliverableRecord, TaskRecord } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { projectA2AExternalValue } from "./a2a-public-projection.js";
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

    const rawPushUrl = "https://peer.example/a2a/push/path-secret?token=query-secret";
    const configured = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-push-set",
        method: "SetTaskPushNotificationConfig",
        params: {
          taskId,
          pushNotificationConfig: {
            url: rawPushUrl,
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
      url: "[REDACTED]",
      lastDeliveryStatus: "delivered",
      auth: { scheme: "bearer", tokenPreview: "noti...oken" },
    });
    expect(JSON.stringify(config)).not.toContain("notify-token");
    expect(JSON.stringify(config)).not.toContain("path-secret");
    expect(JSON.stringify(config)).not.toContain("query-secret");
    expect(harness.storage.a2aTaskPushConfigs.get(taskId, "peer-1").authToken).toBe("notify-token");
    expect(harness.storage.a2aTaskPushConfigs.get(taskId, "peer-1").url).toBe(rawPushUrl);
    expect(pushDeliveryFetch).toHaveBeenCalledWith(
      rawPushUrl,
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

  it("projects local deliverables across JSON-RPC, HTTP+JSON, events, push payloads, and side-effect evidence", async () => {
    const rawDeliverable: TaskDeliverableRecord = {
      deliverableId: "deliverable-1",
      taskId: "task-1",
      deliverableType: "url",
      title: "Credentialed local artifact",
      path: "https://discord.com/api/webhooks/team-id/discord-short",
      description:
        "Authorization: Bearer tiny; inspect https://api.telegram.org/bottelegram-short/sendMessage and https://local.example/token/generic-short",
      createdAt: "2026-06-01T00:00:00.000Z",
    };
    const pushDeliveryFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 202 }));
    const harness = createService({
      bindings: ["JSONRPC", "HTTP_JSON"],
      deliverables: [rawDeliverable],
      pushDeliveryFetch,
      networkAllowlist: ["peer.example"],
    });
    const authoredText = "Peer-authored Authorization: Bearer keep-this-message";

    const created = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-local-artifact",
        method: "SendMessage",
        params: {
          contextId: "ctx-local-artifact",
          messageId: "message-local-artifact",
          message: { role: "user", parts: [{ kind: "text", text: authoredText }] },
        },
      },
      "2026-06-01T00:00:00.000Z",
    );
    const jsonRpcTask = readResultTask(created);
    const httpTask = harness.service.getHttpJsonTask(
      { peerId: "peer-1", scopes: ["a2a:http-json"] },
      { taskId: jsonRpcTask.id },
      "2026-06-01T00:00:01.000Z",
    );
    const httpEvents = harness.service.getHttpJsonTaskEvents(
      { peerId: "peer-1", scopes: ["a2a:http-json"] },
      { taskId: jsonRpcTask.id, lastEventSequence: 0 },
      "2026-06-01T00:00:01.000Z",
    );

    await harness.service.setTaskPushNotificationConfig(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        taskId: jsonRpcTask.id,
        pushNotificationConfig: {
          url: "https://peer.example/webhooks/team/push-short",
          events: ["task.artifact"],
          authentication: { token: "tiny" },
        },
      },
      "2026-06-01T00:00:02.000Z",
    );

    for (const outward of [jsonRpcTask, httpTask, httpEvents]) {
      const serialized = JSON.stringify(outward);
      expect(serialized).not.toContain("discord-short");
      expect(serialized).not.toContain("telegram-short");
      expect(serialized).not.toContain("generic-short");
      expect(serialized).not.toContain("Bearer tiny");
      expect(serialized).toContain(authoredText);
    }
    const pushBody = JSON.parse(
      String((pushDeliveryFetch.mock.calls[0]?.[1] as { init?: { body?: unknown } } | undefined)?.init?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(JSON.stringify(pushBody)).not.toContain("discord-short");
    expect(JSON.stringify(pushBody)).not.toContain("telegram-short");
    expect(JSON.stringify(pushBody)).not.toContain("generic-short");
    expect(JSON.stringify(pushBody)).not.toContain("Bearer tiny");
    expect(JSON.stringify(pushBody)).toContain(authoredText);
    expect(JSON.stringify(harness.storage.externalSideEffectRuns.listByConnection("peer-1"))).not.toContain(
      "discord-short",
    );
    expect(rawDeliverable.path).toContain("discord-short");
    expect(rawDeliverable.description).toContain("telegram-short");
    expect(harness.tasks.listTaskDeliverables).toHaveReturnedWith([rawDeliverable]);
  });

  it("projects outbound previews without changing the executable authored input", () => {
    const harness = createService();
    const authoredText = "Peer-authored Authorization: Bearer keep-this-message";
    const params = {
      message: { role: "user", parts: [{ kind: "text", text: authoredText }] },
      artifact: {
        description: "Authorization: Bearer tiny",
        uri: "https://discord.com/api/webhooks/team-id/preview-discord-short",
        fallback: "https://local.example/token/preview-generic-short",
      },
    };

    const preview = harness.service.previewOutbound({
      peerId: "peer-missing",
      method: "SendMessage",
      params,
    });

    expect(JSON.stringify(preview)).not.toContain("Bearer tiny");
    expect(JSON.stringify(preview)).not.toContain("preview-discord-short");
    expect(JSON.stringify(preview)).not.toContain("preview-generic-short");
    expect(preview.envelope.params?.message).toMatchObject({
      role: "user",
      parts: [expect.objectContaining({ kind: "text" })],
    });
    expect(JSON.stringify(preview)).not.toContain("keep-this-message");
    expect(JSON.stringify(params)).toContain("preview-discord-short");
  });

  it("projects push failures before they enter delivery results or side-effect evidence", async () => {
    const failure =
      "Authorization: Bearer tiny at https://api.telegram.org/botpush-error-short/sendMessage and https://local.example/token/push-generic-short";
    const postDispatchError = Object.assign(new Error(failure), {
      externalOutcome: "unknown_after_send" as const,
      manualReconciliationRequired: true,
    });
    const pushDeliveryFetch = vi.fn(async () => {
      throw postDispatchError;
    });
    const harness = createService({ pushDeliveryFetch, networkAllowlist: ["peer.example"] });
    const created = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-push-error-task",
        method: "SendMessage",
        params: { contextId: "ctx-push-error", messageId: "message-push-error", text: "Run push." },
      },
      "2026-06-01T00:00:00.000Z",
    );
    const taskId = readResultTask(created).id;

    const configured = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-push-error-config",
        method: "SetTaskPushNotificationConfig",
        params: {
          taskId,
          pushNotificationConfig: {
            url: "https://peer.example/webhooks/team/push-url-short",
            authentication: { token: "notify-short" },
          },
        },
      },
      "2026-06-01T00:00:01.000Z",
    );

    const publicConfig = readResult(configured).config;
    const rawEvidence = harness.storage.externalSideEffectRuns.listByConnection("peer-1");
    const publicEvidence = projectA2AExternalValue(rawEvidence);
    expect(JSON.stringify(publicConfig)).not.toContain("Bearer tiny");
    expect(JSON.stringify(publicConfig)).not.toContain("push-error-short");
    expect(JSON.stringify(publicConfig)).not.toContain("push-generic-short");
    expect(JSON.stringify(publicConfig)).toContain("[REDACTED]");
    expect(JSON.stringify(publicEvidence)).not.toContain("Bearer tiny");
    expect(JSON.stringify(publicEvidence)).not.toContain("push-error-short");
    expect(JSON.stringify(publicEvidence)).not.toContain("push-generic-short");
    expect(rawEvidence[0]).toMatchObject({
      status: "unknown_external_outcome",
      errorText: failure,
    });
    expect(postDispatchError).toMatchObject({
      externalOutcome: "unknown_after_send",
      manualReconciliationRequired: true,
    });
    expect(harness.storage.a2aTaskPushConfigs.get(taskId, "peer-1")).toMatchObject({
      url: "https://peer.example/webhooks/team/push-url-short",
      authToken: "notify-short",
    });
  });

  function createService(
    options: {
      bindings?: Array<"JSONRPC" | "HTTP_JSON">;
      pushDeliveryFetch?: A2ARouteServiceDependencies["pushDeliveryFetch"];
      networkAllowlist?: string[];
      deliverables?: TaskDeliverableRecord[];
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
      listTaskDeliverables: vi.fn(() => options.deliverables ?? []),
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
    messages: Array<Record<string, unknown>>;
    artifacts: Array<Record<string, unknown>>;
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
