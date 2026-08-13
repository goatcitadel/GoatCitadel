import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  A2AJsonRpcResponse,
  A2AOutboundPeerConfig,
  TaskDeliverableRecord,
  TaskRecord,
} from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { A2AGrpcClient, type A2AGrpcClientPort } from "./a2a-grpc-client.js";
import { startA2AGrpcServer, type A2AGrpcServerHandle } from "./a2a-grpc-server.js";
import { A2AJsonRpcServiceError } from "./a2a-json-rpc-error.js";
import { A2ARouteService } from "./a2a-route-service.js";
import { SharedHostLifecycleService } from "./shared-host-lifecycle-service.js";

describe("A2A gRPC transport", () => {
  let storage: Storage | undefined;
  const grpcHandles: A2AGrpcServerHandle[] = [];
  const httpServers: Server[] = [];

  afterEach(async () => {
    await Promise.all(grpcHandles.splice(0).map((handle) => handle.close()));
    await Promise.all(httpServers.splice(0).map(closeHttpServer));
    storage?.close();
    storage = undefined;
  });

  it("accepts authenticated inbound gRPC task operations", async () => {
    const harness = createService({ bindings: ["GRPC"] });
    const lifecycle = new SharedHostLifecycleService({ enabled: true });
    lifecycle.markAccepting();
    const handle = await startA2AGrpcServer({
      config: harness.config,
      a2a: harness.service,
      sharedHostLifecycle: lifecycle,
    });
    grpcHandles.push(handle);

    const client = new A2AGrpcClient();
    const status = harness.service.getStatus({
      checkedAt: "2026-06-01T00:00:00.000Z",
      baseUrl: "http://127.0.0.1:8787",
    });
    expect(status.governance).toMatchObject({ inboundGrpcEnabled: true, callable: true });
    expect(status.agentCard.supportedInterfaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ protocolBinding: "GRPC", enabled: true })]),
    );

    const created = await client.call({
      grpcUrl: handle.address!,
      method: "SendMessage",
      id: "grpc-send",
      params: {
        contextId: "ctx-grpc",
        messageId: "message-grpc",
        text: "Prove the gRPC task path.",
      },
      peer: { token: "peer-token" },
      allowlist: ["127.0.0.1"],
    });
    const task = readTask(created);
    const localTaskId = String(task.metadata.localTaskId);
    const events = await client.call({
      grpcUrl: handle.address!,
      method: "SubscribeToTask",
      id: "grpc-subscribe",
      params: { taskId: task.id, lastEventSequence: 0 },
      peer: { token: "peer-token" },
      allowlist: ["127.0.0.1"],
    });

    expect(task).toMatchObject({
      contextId: "ctx-grpc",
      metadata: {
        localTaskId,
        sessionId: "session-1",
        durableRunId: "durable-1",
      },
    });
    expect(readEvents(events)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "task.status" })]));
    expect(harness.tasks.createTask).toHaveBeenCalledTimes(1);
    expect(harness.chatTurnRuntime.agentSendChatMessage).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ authActorSource: "a2a_peer" }),
      expect.objectContaining({ turnIdentity: expect.any(Object) }),
    );
    expect(lifecycle.snapshot()).toMatchObject({ activeCount: 0, activeByKind: { agent: 0, worker: 0 } });
  });

  it("rejects gRPC ingress when the peer credential only authorizes JSON-RPC", async () => {
    const harness = createService({ bindings: ["GRPC"], peerScopes: ["a2a:jsonrpc"] });
    const handle = await startA2AGrpcServer({ config: harness.config, a2a: harness.service });
    grpcHandles.push(handle);

    await expect(
      new A2AGrpcClient().call({
        grpcUrl: handle.address!,
        method: "SendMessage",
        params: { messageId: "wrong-grpc-scope", text: "must not dispatch" },
        peer: { token: "peer-token" },
        allowlist: ["127.0.0.1"],
      }),
    ).rejects.toMatchObject({ code: 7 });
    expect(harness.tasks.createTask).not.toHaveBeenCalled();
    expect(harness.chatTurnRuntime.agentSendChatMessage).not.toHaveBeenCalled();
  });

  it.each(["SendMessage", "SubscribeToTask"] as const)(
    "rejects late %s ingress with retryable UNAVAILABLE after admission closes",
    async (method) => {
      const harness = createService({ bindings: ["GRPC"] });
      const lifecycle = new SharedHostLifecycleService({ enabled: true });
      lifecycle.markAccepting();
      const handle = await startA2AGrpcServer({
        config: harness.config,
        a2a: harness.service,
        sharedHostLifecycle: lifecycle,
      });
      grpcHandles.push(handle);
      await lifecycle.drain({ mode: "pause", timeoutMs: 10, reason: "scale_down", actorId: "ops" });

      await expect(
        new A2AGrpcClient().call({
          grpcUrl: handle.address!,
          method,
          params: method === "SendMessage" ? { text: "late" } : { taskId: "task-late" },
          peer: { token: "peer-token" },
          allowlist: ["127.0.0.1"],
        }),
      ).rejects.toMatchObject({ code: 14 });
      expect(harness.tasks.createTask).not.toHaveBeenCalled();
      expect(lifecycle.snapshot()).toMatchObject({ state: "quiesced", activeCount: 0 });
    },
  );

  it("fences listener startup and leaves no reservation behind when admission is closed", async () => {
    const harness = createService({ bindings: ["GRPC"] });
    const lifecycle = new SharedHostLifecycleService({ enabled: true });
    lifecycle.markAccepting();
    await lifecycle.drain({ mode: "pause", timeoutMs: 10, reason: "startup_race", actorId: "ops" });

    await expect(
      startA2AGrpcServer({
        config: harness.config,
        a2a: harness.service,
        sharedHostLifecycle: lifecycle,
      }),
    ).rejects.toMatchObject({ code: "SHARED_HOST_ADMISSION_CLOSED" });
    expect(lifecycle.snapshot()).toMatchObject({ state: "quiesced", activeCount: 0 });
  });

  it("rejects inbound gRPC without peer bearer metadata", async () => {
    const harness = createService({ bindings: ["GRPC"] });
    const handle = await startA2AGrpcServer({ config: harness.config, a2a: harness.service });
    grpcHandles.push(handle);

    await expect(
      new A2AGrpcClient().call({
        grpcUrl: handle.address!,
        method: "SendMessage",
        params: { text: "Missing token." },
        peer: {},
        allowlist: ["127.0.0.1"],
      }),
    ).rejects.toThrow(/bearer credentials/i);
  });

  it("projects local artifacts in unary and streaming gRPC while preserving peer-authored messages", async () => {
    const rawDeliverable: TaskDeliverableRecord = {
      deliverableId: "deliverable-grpc",
      taskId: "task-1",
      deliverableType: "url",
      title: "gRPC artifact",
      path: "https://discord.com/api/webhooks/team-id/grpc-discord-short",
      description:
        "Authorization: Bearer tiny; https://api.telegram.org/botgrpc-telegram-short/sendMessage; https://local.example/secret/grpc-generic-short",
      createdAt: "2026-06-01T00:00:00.000Z",
    };
    const harness = createService({ bindings: ["GRPC"], deliverables: [rawDeliverable] });
    const handle = await startA2AGrpcServer({ config: harness.config, a2a: harness.service });
    grpcHandles.push(handle);
    const authoredText = "Peer-authored Authorization: Bearer keep-this-message";

    const response = await new A2AGrpcClient().call({
      grpcUrl: handle.address!,
      method: "SendStreamingMessage",
      id: "grpc-stream-secrets",
      params: {
        contextId: "ctx-grpc-secrets",
        messageId: "message-grpc-secrets",
        message: { role: "user", parts: [{ kind: "text", text: authoredText }] },
      },
      peer: { token: "peer-token" },
      allowlist: ["127.0.0.1"],
    });

    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("grpc-discord-short");
    expect(serialized).not.toContain("grpc-telegram-short");
    expect(serialized).not.toContain("grpc-generic-short");
    expect(serialized).not.toContain("Bearer tiny");
    expect(serialized).toContain(authoredText);
    expect(rawDeliverable.path).toContain("grpc-discord-short");
    expect(rawDeliverable.description).toContain("grpc-telegram-short");
  });

  it("projects credential-bearing gRPC error details while preserving the status code", async () => {
    const harness = createService({ bindings: ["GRPC"] });
    const a2a = {
      authenticatePeerRequest: vi.fn(() => ({ peerId: "peer-1", scopes: ["a2a:grpc"] })),
      getGrpcTask: vi.fn(() => {
        throw new A2AJsonRpcServiceError(
          -32004,
          "Authorization: Bearer tiny at https://api.telegram.org/botgrpc-error-short/sendMessage",
        );
      }),
    } as unknown as A2ARouteService;
    const handle = await startA2AGrpcServer({ config: harness.config, a2a });
    grpcHandles.push(handle);

    let failure: unknown;
    try {
      await new A2AGrpcClient().call({
        grpcUrl: handle.address!,
        method: "GetTask",
        params: { taskId: "task-error" },
        peer: { token: "peer-token" },
        allowlist: ["127.0.0.1"],
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 5 });
    expect(String(failure)).toContain("[REDACTED]");
    expect(String(failure)).not.toContain("tiny");
    expect(String(failure)).not.toContain("grpc-error-short");
  });

  it("uses Agent Card gRPC discovery before configured fallback and records the outbound side effect", async () => {
    const agentCard = await startAgentCardServer({
      supportedInterfaces: [
        {
          protocolBinding: "GRPC",
          protocolVersion: "1.0",
          enabled: true,
          url: "grpc://grpc.peer.example:9443",
        },
      ],
    });
    const rawPeerResponse: A2AJsonRpcResponse = {
      jsonrpc: "2.0",
      id: "grpc-outbound-1",
      result: {
        accepted: true,
        transport: "GRPC",
        artifact: {
          description: "Authorization: Bearer tiny",
          uri: "https://discord.com/api/webhooks/team-id/outbound-grpc-short",
        },
      },
    };
    const grpcClient: A2AGrpcClientPort = {
      call: vi.fn(async (input) => ({
        ...rawPeerResponse,
        jsonrpc: "2.0",
        id: input.id ?? null,
      })),
    };
    const harness = createService({
      grpcClient,
      networkAllowlist: ["127.0.0.1"],
      outboundEnabled: true,
      outboundPeers: [
        {
          peerId: "peer-remote",
          agentCardUrl: agentCard.url,
          grpcUrl: "grpc://fallback.peer.example:7443",
          token: "remote-token",
        },
      ],
    });

    const response = await harness.service.sendOutbound(
      {
        peerId: "peer-remote",
        method: "SendMessage",
        transport: "GRPC",
        params: { text: "Outbound gRPC task." },
        idempotencyKey: "grpc-outbound-1",
      },
      "operator-1",
      "2026-06-01T00:00:00.000Z",
    );

    expect(response).toMatchObject({
      status: "sent",
      transport: "GRPC",
      auditRef: expect.stringMatching(/^extfx_/),
    });
    expect(JSON.stringify(response)).not.toContain("Bearer tiny");
    expect(JSON.stringify(response)).not.toContain("outbound-grpc-short");
    expect(JSON.stringify(response)).toContain("[REDACTED]");
    expect(JSON.stringify(rawPeerResponse)).toContain("outbound-grpc-short");
    expect(grpcClient.call).toHaveBeenCalledWith(
      expect.objectContaining({
        grpcUrl: "grpc://grpc.peer.example:9443",
        method: "SendMessage",
        allowlist: ["127.0.0.1"],
        peer: expect.objectContaining({ token: "remote-token" }),
      }),
    );
    const storedRun = harness.storage.externalSideEffectRuns.listByConnection("peer-remote")[0];
    expect(storedRun).toMatchObject({
      boundary: "a2a_grpc_outbound",
      status: "completed",
    });
    expect(JSON.stringify(storedRun?.responsePayload)).not.toContain("Bearer tiny");
    expect(JSON.stringify(storedRun?.responsePayload)).not.toContain("outbound-grpc-short");
    expect(JSON.stringify(rawPeerResponse)).toContain("outbound-grpc-short");
  });

  it("preserves post-dispatch external-outcome errors while recording an ambiguous gRPC result", async () => {
    const agentCard = await startAgentCardServer({
      supportedInterfaces: [
        {
          protocolBinding: "GRPC",
          protocolVersion: "1.0",
          enabled: true,
          url: "grpc://grpc.peer.example:9443",
        },
      ],
    });
    const failureText =
      "unknown_after_send Authorization: Bearer tiny at https://api.telegram.org/botgrpc-outcome-short/sendMessage";
    const postDispatchError = Object.assign(new Error(failureText), {
      externalOutcome: "unknown_after_send" as const,
      manualReconciliationRequired: true,
    });
    const grpcClient: A2AGrpcClientPort = {
      call: vi.fn(async () => {
        throw postDispatchError;
      }),
    };
    const harness = createService({
      grpcClient,
      networkAllowlist: ["127.0.0.1"],
      outboundEnabled: true,
      outboundPeers: [{ peerId: "peer-remote", agentCardUrl: agentCard.url }],
    });

    const response = await harness.service.sendOutbound(
      {
        peerId: "peer-remote",
        method: "SendMessage",
        transport: "GRPC",
        params: { text: "Post-dispatch error." },
        idempotencyKey: "grpc-outbound-ambiguous",
      },
      "operator-1",
      "2026-06-01T00:00:00.000Z",
    );
    const run = harness.storage.externalSideEffectRuns.listByConnection("peer-remote")[0];

    expect(response).toMatchObject({ status: "blocked", transport: "GRPC" });
    expect(grpcClient.call).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({ status: "unknown_external_outcome", errorText: failureText });
    expect(postDispatchError).toMatchObject({
      externalOutcome: "unknown_after_send",
      manualReconciliationRequired: true,
    });
  });

  it("blocks outbound sends when a personal-citadel ward matches a2a.outbound.*, before the runner", async () => {
    const grpcClient: A2AGrpcClientPort = {
      call: vi.fn(async () => ({ jsonrpc: "2.0", id: null, result: {} })),
    };
    const harness = createService({
      grpcClient,
      networkAllowlist: ["127.0.0.1"],
      outboundEnabled: true,
      outboundPeers: [{ peerId: "peer-remote", agentCardUrl: "http://127.0.0.1:1/agent-card.json" }],
    });
    // a2a peers carry no workspace binding, so outbound evaluates against the
    // default personal citadel — a ward there is a global a2a hook.
    harness.storage.citadels.addWard({
      citadelId: "personal",
      name: "Block outbound a2a",
      actionPattern: "a2a.outbound.*",
      effect: "deny",
    });

    const response = await harness.service.sendOutbound(
      {
        peerId: "peer-remote",
        method: "SendMessage",
        transport: "GRPC",
        params: { text: "Ward-gated task." },
        idempotencyKey: "grpc-outbound-warded",
      },
      "operator-1",
      "2026-06-01T00:00:00.000Z",
    );

    expect(response).toMatchObject({
      status: "blocked",
      warnings: expect.arrayContaining([expect.stringContaining("Citadel Ward denies a2a.outbound.grpc.SendMessage")]),
    });
    expect(grpcClient.call).not.toHaveBeenCalled();
    // Blocked BEFORE the runner: no side-effect run is recorded at all.
    expect(harness.storage.externalSideEffectRuns.listByConnection("peer-remote")).toEqual([]);
  });

  it("blocks outbound gRPC before the external client when discovery is not allowlisted", async () => {
    const agentCard = await startAgentCardServer({ supportedInterfaces: [] });
    const grpcClient: A2AGrpcClientPort = {
      call: vi.fn(async () => ({ jsonrpc: "2.0", id: null, result: {} })),
    };
    const harness = createService({
      grpcClient,
      networkAllowlist: [],
      outboundEnabled: true,
      outboundPeers: [{ peerId: "peer-remote", agentCardUrl: agentCard.url }],
    });

    const response = await harness.service.sendOutbound(
      {
        peerId: "peer-remote",
        method: "SendMessage",
        transport: "GRPC",
        params: { text: "Blocked gRPC task." },
        idempotencyKey: "grpc-outbound-blocked",
      },
      "operator-1",
      "2026-06-01T00:00:00.000Z",
    );

    expect(response).toMatchObject({
      status: "blocked",
      transport: "GRPC",
      warnings: expect.arrayContaining([
        "Outbound A2A gRPC send failed; error details are stored in the external side-effect ledger.",
      ]),
    });
    expect(grpcClient.call).not.toHaveBeenCalled();
    expect(harness.storage.externalSideEffectRuns.listByConnection("peer-remote")[0]).toMatchObject({
      boundary: "a2a_grpc_outbound",
      status: "failed_before_boundary",
    });
  });

  function createService(
    options: {
      bindings?: Array<"JSONRPC" | "GRPC" | "HTTP_JSON">;
      grpcClient?: A2AGrpcClientPort;
      networkAllowlist?: string[];
      outboundEnabled?: boolean;
      outboundPeers?: A2AOutboundPeerConfig[];
      deliverables?: TaskDeliverableRecord[];
      peerScopes?: string[];
    } = {},
  ) {
    storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: ".",
      auditDir: ".",
    });
    const asyncStorage = createSqliteAsyncStorage(storage);
    let task: TaskRecord = {
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
      createTask: vi.fn((input: Partial<TaskRecord>, createOptions?: { taskId?: string }) => {
        task = { ...task, ...input, taskId: createOptions?.taskId ?? task.taskId } as TaskRecord;
        return task;
      }),
      getTask: vi.fn(() => task),
      invokeAgenticControl: vi.fn(),
      listTaskDeliverables: vi.fn(() => options.deliverables ?? []),
      persistDelegationActivityOnce: vi.fn(
        (activityId: string, taskId: string, input: Record<string, unknown>, createdAt: string) => ({
          activity: { activityId, taskId, ...input, createdAt },
          created: true,
        }),
      ),
      persistA2ADurableRunLink: vi.fn((_taskId: string, durableRunId: string) => {
        task = { ...task, agenticContext: { ...task.agenticContext!, durableRunId } };
        return task;
      }),
      publishDelegationActivity: vi.fn(),
      publishA2ADurableRunLink: vi.fn(),
      updateTask: vi.fn((_taskId: string, input: Partial<TaskRecord>) => {
        task = { ...task, ...input } as TaskRecord;
        return task;
      }),
    };
    const chatTurnRuntime = {
      agentSendChatMessage: vi.fn(async () => ({
        sessionId: "session-1",
        turnId: "turn-1",
        durableRunId: "durable-1",
      })),
    };
    const config = {
      assistant: {
        a2a: {
          enabled: true,
          publicDiscoveryEnabled: false,
          protocolVersion: "1.0",
          bindings: options.bindings ?? ["GRPC"],
          inbound: {
            enabled: true,
            grpc: {
              enabled: true,
              host: "127.0.0.1",
              port: 0,
            },
            peerCredentials: [
              {
                peerId: "peer-1",
                token: "peer-token",
                scopes: options.peerScopes ?? ["a2a:grpc"],
                allowedWorkspaceIds: ["default"],
              },
            ],
          },
          outbound: {
            enabled: options.outboundEnabled ?? false,
            peers: options.outboundPeers ?? [],
          },
        },
      },
      toolPolicy: {
        sandbox: {
          networkAllowlist: options.networkAllowlist ?? [],
        },
      },
    } as never;
    const service = new A2ARouteService({
      config,
      storage: asyncStorage,
      tasks,
      createChatSession: vi.fn(async (input) => {
        await asyncStorage.chatSessionMeta.ensure(
          "session-1",
          "2026-06-01T00:00:00.000Z",
          input.workspaceId ?? "default",
        );
        return { sessionId: "session-1" };
      }),
      chatTurnRuntime,
      mutationIdempotencyStore: asyncStorage.mutationIdempotency,
      grpcClient: options.grpcClient,
    });
    return { config, service, storage, tasks, chatTurnRuntime };
  }

  async function startAgentCardServer(payload: Record<string, unknown>): Promise<{ url: string }> {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
    httpServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Agent Card test server did not expose a TCP port.");
    }
    return { url: `http://127.0.0.1:${address.port}/.well-known/agent-card.json` };
  }
});

function readTask(response: A2AJsonRpcResponse): { id: string; contextId: string; metadata: Record<string, unknown> } {
  if ("error" in response) {
    throw new Error(response.error.message);
  }
  return (response.result as { task: unknown }).task as {
    id: string;
    contextId: string;
    metadata: Record<string, unknown>;
  };
}

function readEvents(response: A2AJsonRpcResponse): Array<Record<string, unknown>> {
  if ("error" in response) {
    throw new Error(response.error.message);
  }
  return (response.result as { events: Array<Record<string, unknown>> }).events;
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
