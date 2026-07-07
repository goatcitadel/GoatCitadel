import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { A2AJsonRpcResponse, A2AOutboundPeerConfig, TaskRecord } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { A2AGrpcClient, type A2AGrpcClientPort } from "./a2a-grpc-client.js";
import { startA2AGrpcServer, type A2AGrpcServerHandle } from "./a2a-grpc-server.js";
import { A2ARouteService } from "./a2a-route-service.js";

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
    const handle = await startA2AGrpcServer({ config: harness.config, a2a: harness.service });
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
        localTaskId: "task-1",
        sessionId: "session-1",
        durableRunId: "durable-1",
      },
    });
    expect(readEvents(events)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "task.status" })]));
    expect(harness.tasks.createTask).toHaveBeenCalledTimes(1);
    expect(harness.chatTurnRuntime.agentSendChatMessage).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ authActorSource: "a2a_peer" }),
    );
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
    const grpcClient: A2AGrpcClientPort = {
      call: vi.fn(async (input) => ({
        jsonrpc: "2.0",
        id: input.id ?? null,
        result: { accepted: true, transport: "GRPC" },
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
    expect(grpcClient.call).toHaveBeenCalledWith(
      expect.objectContaining({
        grpcUrl: "grpc://grpc.peer.example:9443",
        method: "SendMessage",
        allowlist: ["127.0.0.1"],
        peer: expect.objectContaining({ token: "remote-token" }),
      }),
    );
    expect(harness.storage.externalSideEffectRuns.listByConnection("peer-remote")[0]).toMatchObject({
      boundary: "a2a_grpc_outbound",
      status: "completed",
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
            peerCredentials: [{ peerId: "peer-1", token: "peer-token" }],
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
      storage,
      tasks,
      createChatSession: vi.fn(() => ({ sessionId: "session-1" })),
      chatTurnRuntime,
      mutationIdempotencyStore: storage.mutationIdempotency,
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
