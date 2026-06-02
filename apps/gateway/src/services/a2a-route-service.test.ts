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

  function createService() {
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
            bindings: ["JSONRPC"],
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
            networkAllowlist: [],
          },
        },
      } as never,
      storage,
      tasks,
      createChatSession: vi.fn(() => ({ sessionId: "session-1" })),
      chatTurnRuntime,
    });
    return { service, storage, tasks, chatTurnRuntime };
  }
});

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
