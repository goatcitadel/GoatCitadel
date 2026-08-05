import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  A2AJsonRpcResponse,
  ChatSendMessageResponse,
  TaskDeliverableRecord,
  TaskRecord,
} from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { projectA2AExternalValue } from "./a2a-public-projection.js";
import { A2ARouteService } from "./a2a-route-service.js";
import { buildInboundIdempotencyKey, normalizeInboundMessage } from "./a2a-route-utils.js";

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
    const firstTask = readResultTask(first);
    const localTaskId = String(firstTask.metadata.localTaskId);

    expect(firstTask).toMatchObject({
      id: expect.stringMatching(/^a2a_/),
      contextId: "ctx-1",
      metadata: {
        localTaskId,
        sessionId: "session-1",
        durableRunId: "durable-1",
      },
    });
    expect(readResultTask(second)).toMatchObject({
      id: readResultTask(first).id,
      metadata: {
        localTaskId,
        sessionId: "session-1",
        durableRunId: "durable-1",
      },
    });
    expect(harness.tasks.createTask).toHaveBeenCalledTimes(1);
    expect(harness.chatTurnRuntime.agentSendChatMessage).toHaveBeenCalledTimes(1);
    expect(harness.storage.a2aTaskBindings.listByPeer("peer-1")).toHaveLength(1);
    expect(harness.tasks.persistA2ADurableRunLink).toHaveBeenCalledWith(localTaskId, "durable-1");
    expect(harness.tasks.getTask(localTaskId).agenticContext?.durableRunId).toBe("durable-1");
    expect(harness.tasks.persistDelegationActivityOnce).toHaveBeenCalledTimes(2);
    expect(harness.tasks.persistDelegationActivityOnce.mock.calls[0]?.[0]).toBe(
      harness.tasks.persistDelegationActivityOnce.mock.calls[1]?.[0],
    );
    expect(harness.tasks.publishDelegationActivity).toHaveBeenCalledTimes(1);
  });

  it("links and cancels the canonical durable run from the production nested Chat response trace", async () => {
    const harness = createService();
    const turnId = "turn-contract-trace";
    const durableRunId = "durable-contract-trace";
    const response = {
      sessionId: "session-1",
      userMessage: {} as never,
      transport: "llm",
      turnId,
      trace: {
        turnId,
        sessionId: "session-1",
        userMessageId: "message-contract-trace",
        branchKind: "root",
        status: "running",
        mode: "chat",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        startedAt: "2026-06-01T00:00:00.000Z",
        toolRuns: [],
        citations: [],
        routing: {},
        durable: { runId: durableRunId, status: "running" },
      },
    } satisfies ChatSendMessageResponse;
    harness.chatTurnRuntime.agentSendChatMessage.mockResolvedValueOnce({
      ...response,
      durableRunId: "legacy-shadow-durable-run",
    } as never);

    const created = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-contract-trace",
        method: "SendMessage",
        params: {
          contextId: "ctx-contract-trace",
          messageId: "message-contract-trace",
          text: "Use canonical Chat response truth.",
        },
      },
      "2026-06-01T00:00:00.000Z",
    );
    const task = readResultTask(created);
    const localTaskId = String(task.metadata.localTaskId);

    expect(task).toMatchObject({ metadata: { durableRunId } });
    expect(harness.storage.a2aTaskBindings.get(task.id).durableRunId).toBe(durableRunId);
    expect(harness.tasks.getTask(localTaskId).agenticContext?.durableRunId).toBe(durableRunId);

    const cancelled = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      { jsonrpc: "2.0", id: "rpc-contract-trace-cancel", method: "CancelTask", params: { taskId: task.id } },
      "2026-06-01T00:01:00.000Z",
    );
    expect(readResultTask(cancelled)).toMatchObject({ status: { state: "canceled" } });
    expect(harness.storage.durableRuns.getRun(durableRunId).status).toBe("cancelled");
  });

  it("keeps a contract-valid response without durable truth retryable instead of marking dispatch applied", async () => {
    const harness = createService();
    harness.chatTurnRuntime.agentSendChatMessage.mockImplementationOnce(async (_sessionId, _input, options) => ({
      sessionId: "session-1",
      userMessage: {} as never,
      transport: "llm" as const,
      turnId: options?.turnIdentity?.turnId,
    }));
    const request = {
      jsonrpc: "2.0" as const,
      id: "rpc-missing-durable-truth",
      method: "SendMessage",
      params: {
        contextId: "ctx-missing-durable-truth",
        messageId: "message-missing-durable-truth",
        text: "Do not finalize without canonical durable truth.",
      },
    };

    const first = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      request,
      "2026-06-01T00:00:00.000Z",
    );
    const firstTask = readResultTask(first);
    const firstBinding = harness.storage.a2aTaskBindings.get(firstTask.id);

    expect(firstTask.metadata.durableRunId).toBeUndefined();
    expect(firstBinding.durableRunId).toBeUndefined();
    expect(firstBinding.metadata).toMatchObject({ dispatch: { status: "owned" } });
    expect(harness.tasks.persistA2ADurableRunLink).not.toHaveBeenCalled();

    const dispatch = firstBinding.metadata.dispatch as Record<string, unknown>;
    harness.storage.a2aTaskBindings.update(firstBinding.a2aTaskId, {
      metadata: {
        ...firstBinding.metadata,
        dispatch: { ...dispatch, claimExpiresAt: "1970-01-01T00:00:00.000Z" },
      },
    });
    const retried = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      { ...request, id: "rpc-missing-durable-truth-retry" },
      "2026-06-01T00:02:00.000Z",
    );

    expect(readResultTask(retried)).toMatchObject({ metadata: { durableRunId: "durable-1" } });
    expect(harness.chatTurnRuntime.agentSendChatMessage).toHaveBeenCalledTimes(2);
  });

  it("recovers durable linkage from the persisted canonical turn trace when the response omits trace", async () => {
    const harness = createService();
    const durableRunId = "durable-persisted-trace";
    harness.chatTurnRuntime.agentSendChatMessage.mockImplementationOnce(async (sessionId, _input, options) => {
      const turnIdentity = options?.turnIdentity;
      if (!turnIdentity) {
        throw new Error("Expected a stable A2A turn identity.");
      }
      harness.storage.chatTurnTraces.create({
        turnId: turnIdentity.turnId,
        sessionId,
        userMessageId: turnIdentity.userMessageId,
        assistantMessageId: turnIdentity.assistantMessageId,
        branchKind: "append",
        status: "running",
        mode: "chat",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        routing: {},
        durable: { runId: durableRunId, status: "running" },
        startedAt: "2026-06-01T00:00:00.000Z",
      });
      return {
        sessionId,
        userMessage: {} as never,
        transport: "llm" as const,
        turnId: turnIdentity.turnId,
      };
    });

    const created = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-persisted-trace-fallback",
        method: "SendMessage",
        params: {
          contextId: "ctx-persisted-trace-fallback",
          messageId: "message-persisted-trace-fallback",
          text: "Recover linkage from canonical trace storage.",
        },
      },
      "2026-06-01T00:00:00.000Z",
    );
    const task = readResultTask(created);

    expect(task).toMatchObject({ metadata: { durableRunId } });
    expect(harness.storage.a2aTaskBindings.get(task.id).durableRunId).toBe(durableRunId);
    expect(harness.tasks.persistA2ADurableRunLink).toHaveBeenCalledWith(
      String(task.metadata.localTaskId),
      durableRunId,
    );
  });

  it("reserves explicit task ownership before a reentrant cross-peer collision can create resources", async () => {
    const harness = createService();
    const originalCreateChatSession = harness.createChatSession.getMockImplementation()!;
    let collisionPromise: Promise<A2AJsonRpcResponse> | undefined;
    let reentered = false;
    const taskId = "shared-concurrent-peer-task";
    harness.createChatSession.mockImplementation((input) => {
      if (!reentered) {
        reentered = true;
        collisionPromise = harness.service.handleJsonRpc(
          { peerId: "peer-2", scopes: ["a2a:jsonrpc"] },
          {
            jsonrpc: "2.0",
            id: "rpc-concurrent-peer-two",
            method: "SendMessage",
            params: {
              taskId,
              contextId: "ctx-concurrent-peer-two",
              messageId: "message-concurrent-peer-two",
              text: "Peer two must lose without creating resources.",
            },
          },
        );
      }
      return originalCreateChatSession(input);
    });

    const winner = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-concurrent-peer-one",
        method: "SendMessage",
        params: {
          taskId,
          contextId: "ctx-concurrent-peer-one",
          messageId: "message-concurrent-peer-one",
          text: "Peer one reserves first.",
        },
      },
    );
    expect(collisionPromise).toBeDefined();
    const loser = await collisionPromise!;

    expect(readResultTask(winner)).toMatchObject({ id: taskId, metadata: { peerId: "peer-1" } });
    expect(loser).toMatchObject({
      error: { code: -32022, message: "A2A task is not owned by the authenticated peer." },
    });
    expect(harness.storage.a2aTaskBindings.get(taskId).peerId).toBe("peer-1");
    expect(harness.createChatSession).toHaveBeenCalledTimes(1);
    expect(harness.tasks.createTask).toHaveBeenCalledTimes(1);
    expect(harness.chatTurnRuntime.agentSendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("repairs a legitimately reserved binding whose canonical resource links are still nullable", async () => {
    const harness = createService();
    const params = {
      taskId: "a2a-reserved-restart",
      contextId: "ctx-reserved-restart",
      messageId: "message-reserved-restart",
      text: "Repair the reserved task after restart.",
    };
    const message = normalizeInboundMessage(params);
    const idempotencyKey = buildInboundIdempotencyKey("peer-1", params.contextId, message, params);
    harness.storage.a2aTaskBindings.createOrGet(
      {
        a2aTaskId: params.taskId,
        contextId: params.contextId,
        peerId: "peer-1",
        workspaceId: "default",
        state: "submitted",
        idempotencyKey,
        metadata: {
          inboundMessage: message,
          resourceInitialization: {
            status: "owned",
            attemptId: "resource-crashed-attempt",
            claimToken: "resource-crashed-owner",
            claimExpiresAt: "1970-01-01T00:00:00.000Z",
          },
          dispatch: { status: "pending" },
        },
      },
      "2026-06-01T00:00:00.000Z",
    );

    const repaired = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      { jsonrpc: "2.0", id: "rpc-reserved-restart", method: "SendMessage", params },
      "2026-06-01T00:01:00.000Z",
    );

    expect(readResultTask(repaired)).toMatchObject({
      id: params.taskId,
      status: { state: "working" },
      metadata: {
        sessionId: expect.stringMatching(/^session-/),
        localTaskId: expect.stringMatching(/^task_a2a_/),
        durableRunId: "durable-1",
      },
    });
    expect(harness.storage.a2aTaskBindings.get(params.taskId)).toMatchObject({
      state: "working",
      sessionId: expect.stringMatching(/^session-/),
      localTaskId: expect.stringMatching(/^task_a2a_/),
      durableRunId: "durable-1",
      metadata: {
        resourceInitialization: { status: "applied", attemptId: "resource-crashed-attempt" },
      },
    });
  });

  it("does not block canonical dispatch when acceptance-activity realtime publication fails", async () => {
    const harness = createService();
    harness.tasks.publishDelegationActivity.mockImplementationOnce(() => {
      throw new Error("task activity realtime unavailable");
    });

    const response = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-activity-postcommit-failure",
        method: "SendMessage",
        params: {
          contextId: "ctx-activity-postcommit",
          messageId: "activity-postcommit",
          text: "Keep dispatch independent from realtime activity publication.",
        },
      },
      "2026-06-01T00:00:00.000Z",
    );
    const task = readResultTask(response);

    expect(task).toMatchObject({ status: { state: "working" }, metadata: { durableRunId: "durable-1" } });
    expect(harness.storage.a2aTaskBindings.get(task.id)).toMatchObject({
      state: "working",
      durableRunId: "durable-1",
      metadata: { resourceInitialization: { status: "applied" }, dispatch: { status: "applied" } },
    });
    expect(harness.chatTurnRuntime.agentSendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("resumes a persisted pre-dispatch binding after restart instead of treating working as dispatched", async () => {
    const harness = createService();
    const params = {
      taskId: "a2a-restart",
      contextId: "ctx-restart",
      messageId: "message-restart",
      text: "Resume the accepted A2A turn.",
    };
    const message = normalizeInboundMessage(params);
    const idempotencyKey = buildInboundIdempotencyKey("peer-1", params.contextId, message, params);
    harness.seedTask({
      taskId: "task-restart",
      workspaceId: "default",
      title: "Restarted A2A task",
      status: "in_progress",
      priority: "normal",
      agenticContext: {
        runId: "a2a-restart",
        parentSessionId: "session-restart",
        surface: "chat",
        status: "running",
        providerId: "a2a",
        model: "peer-1",
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    harness.storage.chatSessionMeta.ensure("session-restart", "2026-06-01T00:00:00.000Z", "default");
    harness.storage.a2aTaskBindings.createOrGet(
      {
        a2aTaskId: "a2a-restart",
        contextId: params.contextId,
        peerId: "peer-1",
        workspaceId: "default",
        sessionId: "session-restart",
        localTaskId: "task-restart",
        state: "working",
        idempotencyKey,
        metadata: { inboundMessage: message, dispatch: { status: "pending" } },
      },
      "2026-06-01T00:00:00.000Z",
    );

    const response = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      { jsonrpc: "2.0", id: "rpc-restart", method: "SendMessage", params },
      "2026-06-01T00:01:00.000Z",
    );

    expect(readResultTask(response)).toMatchObject({
      id: "a2a-restart",
      metadata: { sessionId: "session-restart", localTaskId: "task-restart", durableRunId: "durable-1" },
    });
    expect(harness.chatTurnRuntime.agentSendChatMessage).toHaveBeenCalledTimes(1);
    expect(harness.chatTurnRuntime.agentSendChatMessage).toHaveBeenCalledWith(
      "session-restart",
      expect.objectContaining({ policyTaskId: "task-restart" }),
      expect.objectContaining({ turnIdentity: expect.any(Object) }),
    );
  });

  it("uses the canonical winner binding for all work after a concurrent creator loses createOrGet", async () => {
    const harness = createService();
    const params = {
      taskId: "a2a-winner",
      contextId: "ctx-winner",
      messageId: "message-winner",
      text: "Converge on the winner.",
    };
    const message = normalizeInboundMessage(params);
    const idempotencyKey = buildInboundIdempotencyKey("peer-1", params.contextId, message, params);
    harness.seedTask({
      taskId: "task-winner",
      workspaceId: "default",
      title: "Winning A2A task",
      status: "in_progress",
      priority: "normal",
      agenticContext: {
        runId: "a2a-winner",
        parentSessionId: "session-winner",
        surface: "chat",
        status: "running",
        providerId: "a2a",
        model: "peer-1",
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    harness.storage.chatSessionMeta.ensure("session-winner", "2026-06-01T00:00:00.000Z", "default");
    harness.storage.a2aTaskBindings.createOrGet({
      a2aTaskId: "a2a-winner",
      contextId: params.contextId,
      peerId: "peer-1",
      workspaceId: "default",
      sessionId: "session-winner",
      localTaskId: "task-winner",
      state: "working",
      idempotencyKey,
      metadata: { inboundMessage: message, dispatch: { status: "pending" } },
    });
    const findByIdempotency = harness.storage.a2aTaskBindings.findByIdempotency.bind(harness.storage.a2aTaskBindings);
    vi.spyOn(harness.storage.a2aTaskBindings, "findByIdempotency")
      .mockReturnValueOnce(undefined)
      .mockImplementation(findByIdempotency);
    const find = harness.storage.a2aTaskBindings.find.bind(harness.storage.a2aTaskBindings);
    vi.spyOn(harness.storage.a2aTaskBindings, "find").mockReturnValueOnce(undefined).mockImplementation(find);

    const response = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      { jsonrpc: "2.0", id: "rpc-winner", method: "SendMessage", params },
      "2026-06-01T00:01:00.000Z",
    );

    expect(readResultTask(response)).toMatchObject({
      id: "a2a-winner",
      metadata: { sessionId: "session-winner", localTaskId: "task-winner", durableRunId: "durable-1" },
    });
    expect(harness.chatTurnRuntime.agentSendChatMessage).toHaveBeenCalledWith(
      "session-winner",
      expect.objectContaining({ policyTaskId: "task-winner" }),
      expect.any(Object),
    );
    expect(harness.tasks.persistA2ADurableRunLink).toHaveBeenCalledWith("task-winner", "durable-1");
    expect(harness.tasks.appendTaskActivity).not.toHaveBeenCalled();
  });

  it("reuses one canonical turn identity when an ambiguous dispatch is reclaimed after lease expiry", async () => {
    const harness = createService();
    const identities: unknown[] = [];
    harness.chatTurnRuntime.agentSendChatMessage.mockImplementation(async (_sessionId, _input, options) => {
      identities.push(options?.turnIdentity);
      if (identities.length === 1) {
        throw new Error("connection dropped after provider dispatch");
      }
      return { sessionId: "session-1", turnId: "turn-1", durableRunId: "durable-1" };
    });
    const request = {
      jsonrpc: "2.0" as const,
      id: "rpc-ambiguous",
      method: "SendMessage",
      params: {
        contextId: "ctx-ambiguous",
        messageId: "message-ambiguous",
        text: "Dispatch exactly once canonically.",
      },
    };

    const first = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      request,
      "2026-06-01T00:00:00.000Z",
    );
    const firstBinding = harness.storage.a2aTaskBindings.listByPeer("peer-1")[0];
    const firstDispatch = firstBinding?.metadata.dispatch;
    expect(firstDispatch).toMatchObject({
      status: "owned",
      attemptId: expect.stringMatching(/^dispatch_a2a_/),
      claimToken: expect.any(String),
      claimedAt: expect.any(String),
      claimExpiresAt: expect.any(String),
    });
    const dispatchRecord = firstDispatch as Record<string, unknown>;
    expect(Math.abs(Date.parse(String(dispatchRecord.claimedAt)) - Date.now())).toBeLessThan(5_000);
    expect(Date.parse(String(dispatchRecord.claimExpiresAt)) - Date.parse(String(dispatchRecord.claimedAt))).toBe(
      60_000,
    );
    if (firstBinding && firstDispatch && typeof firstDispatch === "object" && !Array.isArray(firstDispatch)) {
      harness.storage.a2aTaskBindings.update(firstBinding.a2aTaskId, {
        metadata: {
          ...firstBinding.metadata,
          dispatch: { ...(firstDispatch as Record<string, unknown>), claimExpiresAt: "1970-01-01T00:00:00.000Z" },
        },
      });
    }
    const retried = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      { ...request, id: "rpc-ambiguous-retry" },
      "2026-06-01T00:02:00.000Z",
    );

    expect(readResultTask(first)).toMatchObject({ status: { state: "working" } });
    expect(readResultTask(retried)).toMatchObject({ metadata: { durableRunId: "durable-1" } });
    expect(identities).toHaveLength(2);
    expect(identities[0]).toEqual(identities[1]);
    expect(identities[0]).toMatchObject({
      turnId: expect.stringMatching(/^turn_a2a_/),
      userMessageId: expect.stringMatching(/^msg_a2a_user_/),
      assistantMessageId: expect.stringMatching(/^msg_a2a_assistant_/),
    });
  });

  it("fences a stale dispatch completion after an expired owner is taken over", async () => {
    const harness = createService();
    let resolveStale: ((value: { sessionId: string; turnId: string; durableRunId: string }) => void) | undefined;
    let callCount = 0;
    harness.chatTurnRuntime.agentSendChatMessage.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise((resolve) => {
          resolveStale = resolve;
        });
      }
      return { sessionId: "session-1", turnId: "turn-winner", durableRunId: "durable-winner" };
    });
    const request = {
      jsonrpc: "2.0" as const,
      id: "rpc-stale-owner",
      method: "SendMessage",
      params: { contextId: "ctx-stale-owner", messageId: "stale-owner", text: "Fence the old owner." },
    };
    const stale = harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      request,
      "2001-01-01T00:00:00.000Z",
    );
    await vi.waitFor(() => expect(callCount).toBe(1));
    const binding = harness.storage.a2aTaskBindings.listByPeer("peer-1")[0]!;
    const dispatch = binding.metadata.dispatch as Record<string, unknown>;
    harness.storage.a2aTaskBindings.update(binding.a2aTaskId, {
      metadata: { ...binding.metadata, dispatch: { ...dispatch, claimExpiresAt: "1970-01-01T00:00:00.000Z" } },
    });

    const winner = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      { ...request, id: "rpc-stale-owner-takeover" },
      "2099-01-01T00:00:00.000Z",
    );
    resolveStale?.({ sessionId: "session-1", turnId: "turn-stale", durableRunId: "durable-stale" });
    await stale;

    expect(readResultTask(winner)).toMatchObject({ metadata: { durableRunId: "durable-winner" } });
    expect(harness.storage.a2aTaskBindings.get(binding.a2aTaskId).durableRunId).toBe("durable-winner");
    expect(harness.tasks.persistA2ADurableRunLink).toHaveBeenCalledTimes(1);
    expect(harness.tasks.persistA2ADurableRunLink).toHaveBeenCalledWith(
      expect.stringMatching(/^task_a2a_/),
      "durable-winner",
    );
  });

  it("fails closed when another peer supplies an existing peer taskId", async () => {
    const harness = createService();
    const first = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-peer-one",
        method: "SendMessage",
        params: { taskId: "shared-peer-task", contextId: "ctx-one", messageId: "message-one", text: "Peer one." },
      },
    );
    const original = harness.storage.a2aTaskBindings.get("shared-peer-task");
    const dispatchCount = harness.chatTurnRuntime.agentSendChatMessage.mock.calls.length;
    const mutationCount = harness.tasks.updateTask.mock.calls.length;
    const taskCreateCount = harness.tasks.createTask.mock.calls.length;
    const sessionCreateCount = harness.createChatSession.mock.calls.length;
    const activityCount = harness.tasks.appendTaskActivity.mock.calls.length;

    const collision = await harness.service.handleJsonRpc(
      { peerId: "peer-2", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-peer-two",
        method: "SendMessage",
        params: { taskId: "shared-peer-task", contextId: "ctx-two", messageId: "message-two", text: "Peer two." },
      },
    );

    expect(readResultTask(first)).toMatchObject({ id: "shared-peer-task" });
    expect(collision).toMatchObject({
      error: { code: -32022, message: "A2A task is not owned by the authenticated peer." },
    });
    expect(harness.chatTurnRuntime.agentSendChatMessage).toHaveBeenCalledTimes(dispatchCount);
    expect(harness.tasks.updateTask).toHaveBeenCalledTimes(mutationCount);
    expect(harness.tasks.createTask).toHaveBeenCalledTimes(taskCreateCount);
    expect(harness.createChatSession).toHaveBeenCalledTimes(sessionCreateCount);
    expect(harness.tasks.appendTaskActivity).toHaveBeenCalledTimes(activityCount);
    expect(harness.storage.a2aTaskBindings.get("shared-peer-task")).toEqual(original);
  });

  it("routes A2A cancellation through the linked canonical run with a stable generation controlId", async () => {
    const harness = createService();
    const created = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-create-cancel",
        method: "SendMessage",
        params: {
          contextId: "ctx-cancel",
          messageId: "cancel-me",
          text: "Start cancellable work.",
          workspaceId: "workspace-a",
        },
      },
      "2026-06-01T00:00:00.000Z",
    );
    const taskId = readResultTask(created).id;
    const localTaskId = String(readResultTask(created).metadata.localTaskId);
    harness.tasks.appendTaskActivity.mockClear();

    const cancelled = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      { jsonrpc: "2.0", id: "rpc-cancel", method: "CancelTask", params: { taskId } },
      "2026-06-01T00:00:01.000Z",
    );
    const replay = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      { jsonrpc: "2.0", id: "rpc-cancel-replay", method: "CancelTask", params: { taskId } },
      "2026-06-01T00:00:02.000Z",
    );

    expect(readResultTask(cancelled)).toMatchObject({ id: taskId, status: { state: "canceled" } });
    expect(readResultTask(replay)).toMatchObject({ id: taskId, status: { state: "canceled" } });
    expect(harness.tasks.invokeAgenticControl).toHaveBeenCalledTimes(1);
    expect(harness.tasks.invokeAgenticControl).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        action: "cancel",
        actorId: "a2a:peer-1",
        controlId: expect.stringMatching(/^a2a-cancel-/),
      }),
      { workspaceId: "workspace-a" },
    );
    expect(harness.tasks.updateTask).not.toHaveBeenCalledWith(
      localTaskId,
      expect.objectContaining({ status: "blocked" }),
    );
    expect(harness.storage.a2aTaskBindings.get(taskId)).toEqual(
      expect.objectContaining({
        state: "canceled",
        metadata: expect.objectContaining({
          cancellation: expect.objectContaining({ status: "applied", runtimeEffect: "runtime_cancel" }),
        }),
      }),
    );
    expect(harness.tasks.appendTaskActivity).not.toHaveBeenCalled();
  });

  it("keeps A2A binding truth active and surfaces canonical cancellation failure for stable retry", async () => {
    const harness = createService();
    const created = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-create-failed-cancel",
        method: "SendMessage",
        params: { contextId: "ctx-failed-cancel", messageId: "failed-cancel", text: "Start fragile work." },
      },
      "2026-06-01T00:00:00.000Z",
    );
    const taskId = readResultTask(created).id;
    const localTaskId = String(readResultTask(created).metadata.localTaskId);
    harness.tasks.appendTaskActivity.mockClear();
    harness.tasks.invokeAgenticControl.mockImplementationOnce(() => {
      throw new Error("durable cancel receipt commit failed after the runtime effect");
    });

    const failed = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      { jsonrpc: "2.0", id: "rpc-cancel-failed", method: "CancelTask", params: { taskId } },
      "2026-06-01T00:00:01.000Z",
    );
    const failedControlId = harness.tasks.invokeAgenticControl.mock.calls[0]?.[1].controlId;

    expect(failed).toMatchObject({
      error: { code: -32025, message: expect.stringContaining("receipt commit failed after the runtime effect") },
    });
    expect(harness.storage.a2aTaskBindings.get(taskId)).toEqual(
      expect.objectContaining({
        state: "working",
        metadata: expect.objectContaining({ cancellation: expect.objectContaining({ status: "pending" }) }),
      }),
    );
    expect(harness.tasks.updateTask).not.toHaveBeenCalledWith(
      localTaskId,
      expect.objectContaining({ status: "blocked" }),
    );
    expect(harness.tasks.appendTaskActivity).not.toHaveBeenCalled();

    await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-cancel-poll",
        method: "SubscribeToTask",
        params: { taskId, lastEventSequence: 0 },
      },
      "2026-06-01T00:00:01.500Z",
    );

    const retried = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      { jsonrpc: "2.0", id: "rpc-cancel-retry", method: "CancelTask", params: { taskId } },
      "2026-06-01T00:00:02.000Z",
    );
    expect(readResultTask(retried)).toMatchObject({ status: { state: "canceled" } });
    expect(harness.tasks.invokeAgenticControl.mock.calls[1]?.[1].controlId).toBe(failedControlId);
    expect(harness.tasks.appendTaskActivity).not.toHaveBeenCalled();
  });

  it("advances the persisted cancellation attempt after a definite state-only refusal", async () => {
    const harness = createService();
    const created = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-create-definite-cancel",
        method: "SendMessage",
        params: { contextId: "ctx-definite-cancel", messageId: "definite-cancel", text: "Start work." },
      },
      "2026-06-01T00:00:00.000Z",
    );
    const taskId = readResultTask(created).id;
    const localTaskId = String(readResultTask(created).metadata.localTaskId);
    harness.tasks.invokeAgenticControl.mockImplementationOnce(() => ({
      action: "cancel",
      taskId: localTaskId,
      runId: taskId,
      status: "recorded",
      runtimeEffect: "state_only",
      message: "No runtime executor was attached.",
    }));

    const refused = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      { jsonrpc: "2.0", id: "rpc-cancel-state-only", method: "CancelTask", params: { taskId } },
      "2026-06-01T00:00:01.000Z",
    );
    const refusedControlId = harness.tasks.invokeAgenticControl.mock.calls[0]?.[1].controlId;
    expect(refused).toMatchObject({ error: { code: -32025 } });
    expect(harness.storage.a2aTaskBindings.get(taskId).metadata).toEqual(
      expect.objectContaining({ cancellation: expect.objectContaining({ status: "failed", attempt: 1 }) }),
    );

    const retried = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      { jsonrpc: "2.0", id: "rpc-cancel-state-only-retry", method: "CancelTask", params: { taskId } },
      "2026-06-01T00:00:02.000Z",
    );
    expect(readResultTask(retried)).toMatchObject({ status: { state: "canceled" } });
    expect(harness.tasks.invokeAgenticControl.mock.calls[1]?.[1].controlId).not.toBe(refusedControlId);
    expect(harness.storage.a2aTaskBindings.get(taskId).metadata).toEqual(
      expect.objectContaining({ cancellation: expect.objectContaining({ status: "applied", attempt: 2 }) }),
    );
  });

  it("does not let an ambiguous loser downgrade a concurrently applied cancellation", async () => {
    const harness = createService();
    const created = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-create-cancel-race",
        method: "SendMessage",
        params: { contextId: "ctx-cancel-race", messageId: "cancel-race", text: "Start racing work." },
      },
      "2026-06-01T00:00:00.000Z",
    );
    const taskId = readResultTask(created).id;
    const localTaskId = String(readResultTask(created).metadata.localTaskId);
    harness.tasks.invokeAgenticControl.mockImplementationOnce(() => {
      const currentBinding = harness.storage.a2aTaskBindings.get(taskId);
      const cancellation = currentBinding.metadata.cancellation as Record<string, unknown>;
      harness.tasks.updateTask(localTaskId, {
        status: "blocked",
        agenticContext: { ...harness.tasks.getTask(localTaskId).agenticContext!, status: "cancelled" },
      });
      harness.storage.a2aTaskBindings.update(taskId, {
        state: "canceled",
        metadata: {
          ...currentBinding.metadata,
          cancellation: { ...cancellation, status: "applied", runtimeEffect: "runtime_cancel" },
        },
      });
      throw new Error("losing caller observed an ambiguous post-effect failure");
    });

    const result = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      { jsonrpc: "2.0", id: "rpc-cancel-race", method: "CancelTask", params: { taskId } },
      "2026-06-01T00:00:01.000Z",
    );

    expect(readResultTask(result)).toMatchObject({ status: { state: "canceled" } });
    expect(harness.storage.a2aTaskBindings.get(taskId)).toEqual(
      expect.objectContaining({
        state: "canceled",
        metadata: expect.objectContaining({
          cancellation: expect.objectContaining({ status: "applied", runtimeEffect: "runtime_cancel" }),
        }),
      }),
    );
  });

  it("repairs a legacy binding durable link before canonical cancellation", async () => {
    const harness = createService();
    const created = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-create-legacy-link",
        method: "SendMessage",
        params: { contextId: "ctx-legacy-link", messageId: "legacy-link", text: "Start legacy work." },
      },
      "2026-06-01T00:00:00.000Z",
    );
    const taskId = readResultTask(created).id;
    const localTaskId = String(readResultTask(created).metadata.localTaskId);
    const current = harness.tasks.getTask(localTaskId);
    harness.tasks.updateTask(localTaskId, {
      agenticContext: { ...current.agenticContext!, durableRunId: undefined },
    });
    harness.tasks.persistA2ADurableRunLink.mockClear();

    const cancelled = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      { jsonrpc: "2.0", id: "rpc-cancel-legacy-link", method: "CancelTask", params: { taskId } },
      "2026-06-01T00:00:01.000Z",
    );

    expect(readResultTask(cancelled)).toMatchObject({ status: { state: "canceled" } });
    expect(harness.tasks.persistA2ADurableRunLink).toHaveBeenCalledWith(localTaskId, "durable-1");
    expect(harness.tasks.invokeAgenticControl).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ action: "cancel" }),
      { workspaceId: "default" },
    );
  });

  it("reconciles a legacy false-canceled binding against running canonical task truth", async () => {
    const harness = createService();
    const created = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-create-false-canceled",
        method: "SendMessage",
        params: { contextId: "ctx-false-canceled", messageId: "false-canceled", text: "Keep running." },
      },
      "2026-06-01T00:00:00.000Z",
    );
    const taskId = readResultTask(created).id;
    const binding = harness.storage.a2aTaskBindings.get(taskId);
    harness.storage.a2aTaskBindings.update(taskId, {
      state: "canceled",
      metadata: { ...binding.metadata, cancellation: undefined },
    });
    harness.tasks.invokeAgenticControl.mockClear();

    const cancelled = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      { jsonrpc: "2.0", id: "rpc-reconcile-false-canceled", method: "CancelTask", params: { taskId } },
      "2026-06-01T00:01:00.000Z",
    );

    expect(readResultTask(cancelled)).toMatchObject({ status: { state: "canceled" } });
    expect(harness.tasks.invokeAgenticControl).toHaveBeenCalledTimes(1);
    expect(harness.storage.a2aTaskBindings.get(taskId)).toEqual(
      expect.objectContaining({
        state: "canceled",
        metadata: expect.objectContaining({ cancellation: expect.objectContaining({ status: "applied" }) }),
      }),
    );
  });

  it("does not trust a stale cancelled task projection while its linked durable run is still running", async () => {
    const harness = createService();
    const created = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-create-stale-cancel-projection",
        method: "SendMessage",
        params: {
          contextId: "ctx-stale-cancel-projection",
          messageId: "stale-cancel-projection",
          text: "Keep durable truth authoritative.",
        },
      },
      "2026-06-01T00:00:00.000Z",
    );
    const taskId = readResultTask(created).id;
    const localTaskId = String(readResultTask(created).metadata.localTaskId);
    const task = harness.tasks.getTask(localTaskId);
    harness.tasks.updateTask(localTaskId, {
      agenticContext: { ...task.agenticContext!, status: "cancelled" },
    });
    expect(harness.storage.durableRuns.getRun("durable-1").status).toBe("running");
    harness.tasks.invokeAgenticControl.mockClear();

    const cancelled = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      { jsonrpc: "2.0", id: "rpc-cancel-stale-projection", method: "CancelTask", params: { taskId } },
      "2026-06-01T00:01:00.000Z",
    );

    expect(readResultTask(cancelled)).toMatchObject({ status: { state: "canceled" } });
    expect(harness.tasks.invokeAgenticControl).toHaveBeenCalledTimes(1);
    expect(harness.storage.durableRuns.getRun("durable-1").status).toBe("cancelled");
  });

  it("does not downgrade a committed durable link when postcommit realtime publication fails", async () => {
    const harness = createService();
    harness.tasks.publishA2ADurableRunLink.mockImplementationOnce(() => {
      throw new Error("realtime unavailable");
    });

    const response = await harness.service.handleJsonRpc(
      { peerId: "peer-1", scopes: ["a2a:jsonrpc"] },
      {
        jsonrpc: "2.0",
        id: "rpc-link-postcommit-failure",
        method: "SendMessage",
        params: { contextId: "ctx-link-postcommit", messageId: "link-postcommit", text: "Link durable truth." },
      },
      "2026-06-01T00:00:00.000Z",
    );
    const taskId = readResultTask(response).id;
    const localTaskId = String(readResultTask(response).metadata.localTaskId);

    expect(readResultTask(response)).toMatchObject({ status: { state: "working" } });
    expect(harness.storage.a2aTaskBindings.get(taskId)).toEqual(
      expect.objectContaining({ state: "working", durableRunId: "durable-1" }),
    );
    expect(harness.tasks.getTask(localTaskId).agenticContext?.durableRunId).toBe("durable-1");
    expect(harness.tasks.updateTask).not.toHaveBeenCalledWith(
      localTaskId,
      expect.objectContaining({ status: "blocked" }),
    );
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
    const events = await harness.service.getHttpJsonTaskEvents(
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
    const httpTask = await harness.service.getHttpJsonTask(
      { peerId: "peer-1", scopes: ["a2a:http-json"] },
      { taskId: jsonRpcTask.id },
      "2026-06-01T00:00:01.000Z",
    );
    const httpEvents = await harness.service.getHttpJsonTaskEvents(
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
    const asyncStorage = createSqliteAsyncStorage(storage);
    const taskRecords = new Map<string, TaskRecord>();
    const activityRecords = new Map<string, Record<string, unknown>>();
    let nextTaskNumber = 1;
    let activeTaskId = "task-1";
    const seedTask = (record: TaskRecord) => {
      taskRecords.set(record.taskId, record);
      activeTaskId = record.taskId;
    };
    const tasks = {
      appendTaskActivity: vi.fn(),
      createTask: vi.fn((input: Partial<TaskRecord>, options?: { taskId?: string }) => {
        const taskId = options?.taskId ?? `task-${nextTaskNumber++}`;
        if (taskRecords.has(taskId)) {
          throw new Error(`Task ${taskId} already exists.`);
        }
        const task = {
          taskId,
          workspaceId: "default",
          title: "A2A task",
          status: "in_progress",
          priority: "normal",
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          ...input,
        } as TaskRecord;
        seedTask(task);
        return task;
      }),
      getTask: vi.fn((taskId: string) => {
        const task = taskRecords.get(taskId);
        if (!task) {
          throw new Error(`Unknown task ${taskId}`);
        }
        return task;
      }),
      invokeAgenticControl: vi.fn((runId: string) => {
        const current =
          [...taskRecords.values()].find((candidate) => candidate.agenticContext?.runId === runId) ??
          taskRecords.get(activeTaskId);
        if (!current) {
          throw new Error(`Unknown A2A task ${runId}`);
        }
        const task = {
          ...current,
          status: "blocked" as const,
          agenticContext: { ...current.agenticContext!, status: "cancelled" as const },
        };
        seedTask(task);
        const durableRunId = task.agenticContext?.durableRunId;
        if (durableRunId) {
          const durable = storage!.durableRuns.getRun(durableRunId);
          storage!.durableRuns.updateRun({
            runId: durableRunId,
            status: "cancelled",
            expectedVersion: durable.version,
          });
        }
        return {
          action: "cancel" as const,
          taskId: task.taskId,
          runId: task.agenticContext?.runId,
          status: "applied" as const,
          runtimeEffect: "runtime_cancel" as const,
          message: "Durable cancellation applied.",
        };
      }),
      listTaskDeliverables: vi.fn(() => options.deliverables ?? []),
      persistDelegationActivityOnce: vi.fn(
        (activityId: string, taskId: string, input: Record<string, unknown>, createdAt: string) => {
          const existing = activityRecords.get(activityId);
          if (existing) {
            return { activity: existing, created: false };
          }
          const activity = { activityId, taskId, ...input, createdAt };
          activityRecords.set(activityId, activity);
          return { activity, created: true };
        },
      ),
      persistA2ADurableRunLink: vi.fn((taskId: string, durableRunId: string) => {
        const current = taskRecords.get(taskId);
        if (!current) {
          throw new Error(`Unknown task ${taskId}`);
        }
        const task = {
          ...current,
          agenticContext: { ...current.agenticContext!, durableRunId },
        };
        seedTask(task);
        try {
          storage!.durableRuns.getRun(durableRunId);
        } catch {
          storage!.durableRuns.createRun({
            runId: durableRunId,
            workflowKey: "a2a-test-turn",
            status: "running",
          });
        }
        return task;
      }),
      publishDelegationActivity: vi.fn(),
      publishA2ADurableRunLink: vi.fn(),
      updateTask: vi.fn((taskId: string, input: Partial<TaskRecord>) => {
        const current = taskRecords.get(taskId);
        if (!current) {
          throw new Error(`Unknown task ${taskId}`);
        }
        const task = { ...current, ...input } as TaskRecord;
        seedTask(task);
        return task;
      }),
    };
    const chatTurnRuntime = {
      agentSendChatMessage: vi.fn(
        async (
          _sessionId: string,
          _input: Record<string, unknown>,
          _options?: { turnIdentity?: { turnId: string; userMessageId: string; assistantMessageId: string } },
        ) => ({
          sessionId: "session-1",
          turnId: "turn-1",
          durableRunId: "durable-1",
        }),
      ),
    };
    let nextSessionNumber = 1;
    const stableSessions = new Map<string, string>();
    const createChatSession = vi.fn(async (input: { stableKey?: string; workspaceId?: string }) => {
      const stableKey = input.stableKey?.trim();
      if (stableKey) {
        const existing = stableSessions.get(stableKey);
        if (existing) {
          return { sessionId: existing };
        }
      }
      const sessionId = `session-${nextSessionNumber++}`;
      if (stableKey) {
        stableSessions.set(stableKey, sessionId);
      }
      await asyncStorage.chatSessionMeta.ensure(sessionId, "2026-06-01T00:00:00.000Z", input.workspaceId ?? "default");
      return { sessionId };
    });
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
      storage: asyncStorage,
      tasks,
      createChatSession,
      chatTurnRuntime,
      mutationIdempotencyStore: asyncStorage.mutationIdempotency,
      pushDeliveryFetch: options.pushDeliveryFetch,
    });
    return { service, storage, tasks, chatTurnRuntime, createChatSession, seedTask };
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
