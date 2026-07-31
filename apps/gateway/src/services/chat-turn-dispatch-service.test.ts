import { describe, expect, it, vi } from "vitest";
import { NotFoundError, type ChatTurnTraceRecord, type DurableRunRecord } from "@goatcitadel/contracts";
import type { ChatTurnDispatchHost } from "./chat-turn-dispatch-service.js";
import { ChatTurnExecutionRegistry } from "./chat-turn-execution-registry.js";

vi.mock("./chat-turn-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-turn-helpers.js")>()),
  dedupeChatCitations: (items: unknown[]) => items,
  splitIntoChunks: (value: string) => [value],
}));

const {
  buildDurableChatCanonicalWriteFence,
  executePreparedAgentChatTurnBackground,
  launchPreparedAgentChatTurnStream,
  shouldUseDurableExecution,
} = await import("./chat-turn-dispatch-service.js");
const chatTurnStreamService = await import("./chat-turn-stream-service.js");
const { sendPreparedIntegrationChatTurn, streamPreparedIntegrationChatTurn } =
  await import("./chat-turn-dispatch-service.js");

describe("chat turn dispatch durable ownership", () => {
  it("treats shipped chat, cowork, and code surfaces as durable-owned when the 1.0 defaults are on", () => {
    const host = createHost();
    expect(shouldUseDurableExecution(host, createPrepared("chat"), { content: "hello" })).toBe(true);
    expect(shouldUseDurableExecution(host, createPrepared("cowork"), { content: "hello" })).toBe(true);
    expect(shouldUseDurableExecution(host, createPrepared("code"), { content: "hello" })).toBe(true);
  });

  it("keeps quick-web turns on the inline fast path instead of durable execution", () => {
    const host = createHost();
    expect(
      shouldUseDurableExecution(host, createPrepared("chat", { normalizationProfile: "quick_web" }), {
        content: "please look up the best way to eat sushi",
      }),
    ).toBe(false);
  });

  it("forces routed quick-web turns through durable admission", () => {
    const durableRun = { runId: "run-routed-quick-web" } as DurableRunRecord;
    const host = createHost({ beginDurableChatRun: vi.fn(() => durableRun) });
    const input = {
      content: "use the routed source for a quick lookup",
      contextRefs: [{ kind: "attachment" as const, ref: "attachment-quick-web" }],
    };
    const prepared = createPrepared("chat", { normalizationProfile: "quick_web" });
    const snapshotPrepared = createPrepared("chat", { normalizationProfile: "quick_web" }) as unknown as {
      routedContextSnapshot?: unknown;
    };
    snapshotPrepared.routedContextSnapshot = { snapshotId: "snapshot-quick-web" };

    expect(shouldUseDurableExecution(host, prepared, input)).toBe(true);
    expect(
      shouldUseDurableExecution(host, snapshotPrepared as never, { content: "use the already-resolved snapshot" }),
    ).toBe(true);
    launchPreparedAgentChatTurnStream(host, "session-1", input, prepared, "chat_thread_turn_appended");

    expect(host.beginDurableChatRun).toHaveBeenCalledTimes(1);
    expect(host.registerActiveChatTurnStream).toHaveBeenCalledWith("session-1", "turn-1", durableRun.runId, {
      reservation: true,
    });
    expect(host.backgroundTasks.size).toBe(0);
  });

  it("rejects routed turns before dispatch when durable execution is disabled", () => {
    const host = createHost();
    host.config.assistant.durable.enabled = false;
    host.isFeatureEnabled = vi.fn(() => false);
    const input = {
      content: "use the routed source",
      contextRefs: [{ kind: "memory_item" as const, ref: "memory-disabled" }],
    };
    const prepared = createPrepared("chat");

    expect(() => shouldUseDurableExecution(host, prepared, input)).toThrow(/routed chat context requires durable/i);
    expect(() =>
      launchPreparedAgentChatTurnStream(host, "session-1", input, prepared, "chat_thread_turn_appended"),
    ).toThrow(/routed chat context requires durable/i);
    expect(host.beginDurableChatRun).not.toHaveBeenCalled();
    expect(host.registerActiveChatTurnStream).not.toHaveBeenCalled();
    expect(host.backgroundTasks.size).toBe(0);
  });

  it("commits a non-durable streamed retry trace before background execution can outlive the request", async () => {
    const host = createHost();
    const getTrace = vi.mocked(host.storage.chatTurnTraces.get);
    const readExisting = getTrace.getMockImplementation()!;
    getTrace.mockImplementationOnce(() => {
      throw new NotFoundError({ entity: "chat turn trace", id: "turn-1" });
    });
    getTrace.mockImplementation(readExisting);
    const markCommitted = vi.fn();
    const prepared = createPrepared("chat", { normalizationProfile: "quick_web" });
    prepared.branchKind = "retry";
    prepared.sourceTurnId = "turn-earlier-source";
    prepared.parentTurnId = "turn-source-parent";
    prepared.branchSelectionBaseTurnId = "turn-later-active-leaf";

    launchPreparedAgentChatTurnStream(
      host,
      "session-1",
      { content: "quick retry", mode: "chat" },
      prepared,
      "chat_thread_turn_retried",
      undefined,
      { mutationLifecycle: { markCommitted } },
    );

    expect(host.storage.chatTurnTraces.create).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: "turn-1",
        status: "running",
        branchKind: "retry",
        sourceTurnId: "turn-earlier-source",
        parentTurnId: "turn-source-parent",
      }),
    );
    expect(host.updateActiveLeafOrThrow).toHaveBeenCalledWith("session-1", "turn-later-active-leaf", "turn-1");
    expect(markCommitted).toHaveBeenCalledTimes(1);
    await Promise.allSettled([...host.backgroundTasks]);
  });

  it("registers the active stream against the durable run when one is created", () => {
    const durableRun = { runId: "run-1" } as DurableRunRecord;
    const host = createHost({
      beginDurableChatRun: vi.fn(() => durableRun),
    });

    launchPreparedAgentChatTurnStream(
      host,
      "session-1",
      { content: "hello", mode: "chat" },
      createPrepared("chat"),
      "chat_thread_turn_appended",
    );

    expect(host.registerActiveChatTurnStream).toHaveBeenCalledWith("session-1", "turn-1", "run-1", {
      reservation: true,
    });
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.dispatch.stream_registered",
        sessionId: "session-1",
        turnId: "turn-1",
        context: expect.objectContaining({
          durableRequested: true,
          durableRunId: "run-1",
        }),
      }),
    );
    expect(host.backgroundTasks.size).toBe(0);
    expect(host.persistChatStreamChunk).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("checks delegated dispatch ownership immediately before allocating the deterministic durable run", () => {
    const assertDispatchOwnership = vi.fn();
    const beginDurableChatRun = vi.fn(() => {
      expect(assertDispatchOwnership).toHaveBeenCalledTimes(1);
      return { runId: "durable-chat-stable" } as DurableRunRecord;
    });
    const host = createHost({ beginDurableChatRun });

    launchPreparedAgentChatTurnStream(
      host,
      "session-1",
      { content: "hello", mode: "chat" },
      createPrepared("chat"),
      "chat_thread_turn_appended",
      undefined,
      { assertDispatchOwnership, durableRunId: "durable-chat-stable" },
    );

    expect(beginDurableChatRun).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      "chat_thread_turn_appended",
      expect.objectContaining({ runId: "durable-chat-stable" }),
    );
  });

  it("forces a deterministic delegated quick-web turn through durable allocation", () => {
    const durableRun = { runId: "durable-chat-stable" } as DurableRunRecord;
    const host = createHost({ beginDurableChatRun: vi.fn(() => durableRun) });

    launchPreparedAgentChatTurnStream(
      host,
      "session-1",
      { content: "quick delegated lookup", mode: "chat", policyRunId: "delegation-run-1" },
      createPrepared("chat", { normalizationProfile: "quick_web" }),
      "chat_thread_turn_appended",
      undefined,
      { durableRunId: durableRun.runId, requireDurableExecution: true },
    );

    expect(host.beginDurableChatRun).toHaveBeenCalledTimes(1);
    expect(host.backgroundTasks.size).toBe(0);
  });

  it("fails a required delegated durable turn closed before any dispatch when the durable kernel is disabled", () => {
    const host = createHost();
    host.config.assistant.durable.enabled = false;
    host.isFeatureEnabled = vi.fn(() => false);
    const assertDispatchOwnership = vi.fn();

    expect(() =>
      launchPreparedAgentChatTurnStream(
        host,
        "session-1",
        { content: "delegated work", mode: "chat", policyRunId: "delegation-run-1" },
        createPrepared("chat"),
        "chat_thread_turn_appended",
        undefined,
        {
          assertDispatchOwnership,
          durableRunId: "durable-chat-stable",
          requireDurableExecution: true,
        },
      ),
    ).toThrow(/requires durable execution/i);

    expect(assertDispatchOwnership).not.toHaveBeenCalled();
    expect(host.beginDurableChatRun).not.toHaveBeenCalled();
    expect(host.registerActiveChatTurnStream).not.toHaveBeenCalled();
    expect(host.backgroundTasks.size).toBe(0);
  });

  it("fails closed instead of silently falling back to background execution when a shipped durable send cannot allocate a run", () => {
    const traceState = {
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      status: "running",
      routing: {},
      startedAt: "2026-04-11T00:00:00.000Z",
    } as unknown as ChatTurnTraceRecord;
    const host = createHost({
      beginDurableChatRun: vi.fn(() => undefined),
      traceState,
    });

    launchPreparedAgentChatTurnStream(
      host,
      "session-1",
      { content: "hello", mode: "chat" },
      createPrepared("chat"),
      "chat_thread_turn_appended",
    );

    expect(host.backgroundTasks.size).toBe(0);
    expect(host.registerActiveChatTurnStream.mock.invocationCallOrder[0]).toBeLessThan(
      (host.storage.chatTurnTraces.patchIfStatus as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ??
        Number.MAX_SAFE_INTEGER,
    );
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.dispatch.durable_unavailable",
        level: "warn",
        context: expect.objectContaining({
          providerCallStarted: false,
        }),
      }),
    );
    expect(host.storage.chatTurnTraces.patchIfStatus).toHaveBeenCalledWith(
      "turn-1",
      expect.arrayContaining(["running"]),
      expect.objectContaining({
        status: "failed",
      }),
    );
    expect(host.persistChatStreamChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        error: expect.stringContaining("durable_unavailable"),
      }),
      undefined,
      expect.objectContaining({ sessionId: "session-1", turnId: "turn-1" }),
    );
    expect(host.getActiveChatTurnStream("turn-1")?.completed).toBe(true);
  });

  it("still completes a durable-unavailable stream when no trace was persisted", () => {
    const host = createHost({
      beginDurableChatRun: vi.fn(() => undefined),
    });
    vi.mocked(host.storage.chatTurnTraces.get).mockImplementation(() => {
      throw new NotFoundError({ entity: "chat turn trace", id: "turn-1" });
    });

    expect(() =>
      launchPreparedAgentChatTurnStream(
        host,
        "session-1",
        { content: "hello", mode: "chat" },
        createPrepared("chat"),
        "chat_thread_turn_appended",
      ),
    ).not.toThrow();

    expect(host.getActiveChatTurnStream("turn-1")?.completed).toBe(true);
    expect(host.persistChatStreamChunk).not.toHaveBeenCalled();
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "chat.dispatch.durable_unavailable", turnId: "turn-1" }),
    );
  });

  it("releases a durable-unavailable stream when trace storage is unavailable", () => {
    const host = createHost({
      beginDurableChatRun: vi.fn(() => undefined),
    });
    vi.mocked(host.storage.chatTurnTraces.get).mockImplementation(() => {
      throw new Error("trace read unavailable");
    });

    expect(() =>
      launchPreparedAgentChatTurnStream(
        host,
        "session-1",
        { content: "hello", mode: "chat" },
        createPrepared("chat"),
        "chat_thread_turn_appended",
      ),
    ).toThrow("trace read unavailable");

    expect(host.getActiveChatTurnStream("turn-1")?.completed).toBe(true);
  });

  it("releases a durable-unavailable stream when its failure diagnostic sink is unavailable", () => {
    const host = createHost({
      beginDurableChatRun: vi.fn(() => undefined),
    });
    host.recordDevDiagnostic
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("diagnostic sink unavailable");
      });

    expect(() =>
      launchPreparedAgentChatTurnStream(
        host,
        "session-1",
        { content: "hello", mode: "chat" },
        createPrepared("chat"),
        "chat_thread_turn_appended",
      ),
    ).not.toThrow();

    expect(host.getActiveChatTurnStream("turn-1")?.completed).toBe(true);
    expect(host.storage.chatTurnTraces.get).toHaveBeenCalled();
  });

  it("does not leak a registered stream when the initial dispatch diagnostic sink is unavailable", () => {
    const host = createHost({
      beginDurableChatRun: vi.fn(() => undefined),
    });
    host.recordDevDiagnostic.mockImplementationOnce(() => {
      throw new Error("diagnostic sink unavailable");
    });

    expect(() =>
      launchPreparedAgentChatTurnStream(
        host,
        "session-1",
        { content: "hello", mode: "chat" },
        createPrepared("chat"),
        "chat_thread_turn_appended",
      ),
    ).not.toThrow();

    expect(host.getActiveChatTurnStream("turn-1")?.completed).toBe(true);
  });

  it("releases a durable-unavailable stream when the failure trace cannot be patched", () => {
    const host = createHost({
      beginDurableChatRun: vi.fn(() => undefined),
    });
    vi.mocked(host.storage.chatTurnTraces.patchIfStatus).mockImplementation(() => {
      throw new Error("trace patch unavailable");
    });

    expect(() =>
      launchPreparedAgentChatTurnStream(
        host,
        "session-1",
        { content: "hello", mode: "chat" },
        createPrepared("chat"),
        "chat_thread_turn_appended",
      ),
    ).toThrow("trace patch unavailable");

    expect(host.getActiveChatTurnStream("turn-1")?.completed).toBe(true);
  });

  it("records completed integration writeback traces without allocating a durable run", async () => {
    const host = createHost();
    const response = await sendPreparedIntegrationChatTurn(
      host,
      "session-1",
      {
        mode: "chat",
        operatorId: "operator-1",
        authActorId: "actor-1",
        authActorSource: "token",
        policyRunId: "run-1",
        policyTaskId: "task-1",
        permissionProfileId: "profile-safe",
        localOperatorOverrideId: "override-1",
      },
      createPrepared("chat"),
      createBinding(),
      "chat_thread_turn_appended",
    );

    expect(host.beginDurableChatRun).not.toHaveBeenCalled();
    expect(host.storage.chatTurnTraces.create).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: "turn-1",
        sessionId: "session-1",
        status: "running",
      }),
    );
    expect(host.commsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-1",
        target: "target-1",
        sessionId: "session-1",
        message: "hello",
        agentId: "operator-1",
        operatorId: "operator-1",
        authActorId: "actor-1",
        authActorSource: "token",
        runId: "run-1",
        taskId: "task-1",
        permissionProfileId: "profile-safe",
        localOperatorOverrideId: "override-1",
        surface: "chat",
      }),
    );
    expect(host.storage.chatTurnTraces.patchIfStatus).toHaveBeenCalledWith(
      "turn-1",
      ["running"],
      expect.objectContaining({
        status: "completed",
        assistantMessageId: "assistant-1",
      }),
    );
    expect(response.transport).toBe("integration");
    expect(response.trace?.status).toBe("completed");
  });

  it("rejects routed integration sends before admission, trace creation, or external delivery", async () => {
    const host = createHost();

    await expect(
      sendPreparedIntegrationChatTurn(
        host,
        "session-1",
        {
          content: "do not deliver routed bytes",
          contextRefs: [{ kind: "attachment", ref: "attachment-integration" }],
        },
        createPrepared("chat"),
        createBinding(),
        "chat_thread_turn_appended",
      ),
    ).rejects.toThrow(/cannot use integration delivery/i);

    expect(host.beginActiveChatTurnExecution).not.toHaveBeenCalled();
    expect(host.storage.chatTurnTraces.create).not.toHaveBeenCalled();
    expect(host.ensureSessionInternalToolGrant).not.toHaveBeenCalled();
    expect(host.commsSend).not.toHaveBeenCalled();
  });

  it("rejects a prepared routed snapshot before a streamed integration envelope starts", async () => {
    const host = createHost();
    const prepared = createPrepared("chat") as unknown as { routedContextSnapshot?: unknown };
    prepared.routedContextSnapshot = { snapshotId: "snapshot-integration" };
    const stream = streamPreparedIntegrationChatTurn(
      host,
      "session-1",
      { content: "do not stream routed bytes" },
      prepared as never,
      createBinding(),
      "chat_thread_turn_retried",
    );

    await expect(stream.next()).rejects.toThrow(/cannot use integration delivery/i);
    expect(host.beginActiveChatTurnExecution).not.toHaveBeenCalled();
    expect(host.storage.chatTurnTraces.create).not.toHaveBeenCalled();
    expect(host.commsSend).not.toHaveBeenCalled();
  });

  it("releases integration execution ownership when trace creation fails", async () => {
    const host = createHost();
    vi.mocked(host.storage.chatTurnTraces.create).mockImplementationOnce(() => {
      throw new Error("trace store unavailable");
    });
    const externalController = new AbortController();
    const removeListener = vi.spyOn(externalController.signal, "removeEventListener");

    await expect(
      sendPreparedIntegrationChatTurn(
        host,
        "session-1",
        {},
        createPrepared("chat"),
        createBinding(),
        "chat_thread_turn_appended",
        { abortSignal: externalController.signal },
      ),
    ).rejects.toThrow("trace store unavailable");

    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(host.endActiveChatTurnExecution).toHaveBeenCalledWith("turn-1", expect.any(AbortController));
    expect(host.storage.chatTurnTraces.get).not.toHaveBeenCalled();
    expect(host.storage.chatTurnTraces.patchIfStatus).not.toHaveBeenCalled();
    expect(host.commsSend).not.toHaveBeenCalled();
  });

  it("signals integration commit after trace creation even when execution fails before the next stream yield", async () => {
    const host = createHost();
    const markCommitted = vi.fn();

    await expect(
      sendPreparedIntegrationChatTurn(
        host,
        "session-1",
        {},
        createPrepared("chat"),
        { ...createBinding(), target: undefined },
        "chat_thread_turn_retried",
        { mutationLifecycle: { markCommitted } },
      ),
    ).rejects.toThrow("missing connectionId or target");

    expect(host.storage.chatTurnTraces.create).toHaveBeenCalled();
    expect(markCommitted).toHaveBeenCalledTimes(1);
    expect(host.commsSend).not.toHaveBeenCalled();
  });

  it("marks committed delivery as non-retryable when bookkeeping breaks after the external side effect", async () => {
    const host = createHost({
      ingestEvent: vi.fn(async () => {
        throw new Error("local ingest failed");
      }),
    });
    host.requireExecutedToolResult.mockReturnValue({
      status: "sent",
      deliveryStatus: "sent",
      deliveryId: "delivery-1",
      providerMessageId: "provider-message-1",
    });

    await expect(
      sendPreparedIntegrationChatTurn(
        host,
        "session-1",
        {},
        createPrepared("chat"),
        createBinding(),
        "chat_thread_turn_appended",
      ),
    ).rejects.toMatchObject({
      name: "IntegrationDeliveryPostCommitError",
      mutationCommitted: true,
      turnId: "turn-1",
      deliveryEvidence: {
        status: "sent",
        deliveryStatus: "sent",
        deliveryId: "delivery-1",
        providerMessageId: "provider-message-1",
      },
    });

    expect(host.commsSend).toHaveBeenCalled();
    expect(host.storage.chatTurnTraces.patchIfStatus).toHaveBeenLastCalledWith(
      "turn-1",
      expect.arrayContaining(["running"]),
      expect.objectContaining({
        status: "failed",
        failure: expect.objectContaining({
          retryable: false,
          message: expect.stringContaining("delivery committed"),
          provider: expect.objectContaining({
            status: "sent",
            responseId: "provider-message-1",
            type: "integration_delivery_committed",
          }),
        }),
      }),
    );
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.integration_delivery.bookkeeping_failed",
        context: expect.objectContaining({
          deliveryCommitted: true,
          reconciliationRequired: true,
          deliveryId: "delivery-1",
          providerMessageId: "provider-message-1",
        }),
      }),
    );
  });

  it("streams integration writeback through the one-shot delivery path", async () => {
    const host = createHost();
    const chunks = [];
    for await (const chunk of streamPreparedIntegrationChatTurn(
      host,
      "session-1",
      {},
      createPrepared("chat"),
      createBinding(),
      "chat_thread_turn_appended",
    )) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "message_start",
      "delta",
      "message_done",
      "trace_update",
      "done",
    ]);
    expect(chunks[1]).toEqual(
      expect.objectContaining({
        type: "delta",
        delta: "Delivered via integration conn-1 to target-1.",
      }),
    );
    expect(chunks[3]).toEqual(
      expect.objectContaining({
        type: "trace_update",
        trace: expect.objectContaining({
          status: "completed",
        }),
      }),
    );
  });

  it("terminalizes exact system-heartbeat approval drift without approval-wait or stream projections", async () => {
    const blocked = new Error("heartbeat_interactive_approval_forbidden");
    blocked.name = "SystemHeartbeatToolInvocationBlockedError";
    const streamSpy = vi
      .spyOn(chatTurnStreamService, "streamPreparedAgentChatTurn")
      .mockImplementation(async function* () {
        yield* [];
        throw blocked;
      });
    const host = createHost();
    const prepared = {
      ...(createPrepared("chat") as Record<string, unknown>),
      serverOnlyPosture: {
        kind: "system_heartbeat",
        actorId: "system-heartbeat",
        operation: "chat_system_heartbeat",
        occurrenceId: "heartbeat-occurrence-1",
        claimSha256: "a".repeat(64),
        durableRunId: "durable-heartbeat-1",
      },
    } as never;
    const streamRegistration = host.registerActiveChatTurnStream("session-1", "turn-1", "durable-heartbeat-1");

    try {
      await executePreparedAgentChatTurnBackground(
        host,
        "session-1",
        { content: "heartbeat" },
        prepared,
        "chat_thread_turn_appended",
        "durable-heartbeat-1",
        undefined,
        {
          streamRegistration,
          skipMessageStart: true,
          durableLeaseOwnerId: "heartbeat-worker-1",
        },
      );
    } finally {
      streamSpy.mockRestore();
    }

    expect(host.storage.chatTurnTraces.get("turn-1")).toMatchObject({
      status: "failed",
      failure: {
        failureClass: "approval_required",
        retryable: false,
      },
      completion: { status: "interrupted" },
    });
    expect(host.persistChatStreamChunk).not.toHaveBeenCalled();
    expect(host.recordDevDiagnostic).not.toHaveBeenCalled();
    expect(host.storage.chatMessages.upsert).not.toHaveBeenCalled();
    expect(host.storage.approvals.create).not.toHaveBeenCalled();
    expect(host.finalizeDurableChatRun).toHaveBeenCalledTimes(1);
    expect(host.finalizeDurableChatRun).toHaveBeenCalledWith(
      "durable-heartbeat-1",
      prepared,
      expect.objectContaining({ status: "failed" }),
      "heartbeat-worker-1",
    );
  });

  it("translates only exact heartbeat admission supersession into durable interruption before callback writes", () => {
    const host = createHost();
    vi.mocked(host.sessionControlRuntimeOwner.assertActiveTurnWrite).mockImplementation(() => {
      throw new Error("authority_superseded");
    });
    const prepared = {
      ...(createPrepared("chat") as Record<string, unknown>),
      serverOnlyPosture: {
        kind: "system_heartbeat",
        actorId: "system-heartbeat",
        operation: "chat_system_heartbeat",
        occurrenceId: "heartbeat-occurrence-1",
        claimSha256: "a".repeat(64),
        durableRunId: "durable-heartbeat-1",
      },
    } as never;
    const streamRegistration = host.registerActiveChatTurnStream("session-1", "turn-1", "durable-heartbeat-1");
    const fence = buildDurableChatCanonicalWriteFence(host, prepared, "durable-heartbeat-1", {
      streamRegistration,
      durableLeaseOwnerId: "heartbeat-worker-1",
    });
    const work = vi.fn();

    expect(() => fence!(work)).toThrow(
      expect.objectContaining({
        name: "DurableWorkerInterruptionError",
        message: expect.stringMatching(/superseded/i),
      }),
    );
    expect(work).not.toHaveBeenCalled();
  });
});

function createHost(
  overrides: {
    beginDurableChatRun?: (...args: unknown[]) => DurableRunRecord | undefined;
    traceState?: ChatTurnTraceRecord;
    ingestEvent?: (...args: unknown[]) => Promise<unknown>;
  } = {},
): ChatTurnDispatchHost & {
  registerActiveChatTurnStream: ReturnType<typeof vi.fn>;
  persistChatStreamChunk: ReturnType<typeof vi.fn>;
  completeActiveChatTurnStream: ReturnType<typeof vi.fn>;
  beginDurableChatRun: ReturnType<typeof vi.fn>;
  recordDevDiagnostic: ReturnType<typeof vi.fn>;
} {
  let traceState =
    overrides.traceState ??
    ({
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      status: "running",
      routing: {},
      startedAt: "2026-04-11T00:00:00.000Z",
    } as unknown as ChatTurnTraceRecord);
  const executionRegistry = new ChatTurnExecutionRegistry();
  const registerActiveChatTurnStream = vi.fn((sessionId: string, turnId: string, runId?: string) =>
    executionRegistry.registerActiveStream(sessionId, turnId, 0, runId),
  );
  const persistChatStreamChunk = vi.fn();
  const completeActiveChatTurnStream = vi.fn();
  const closeActiveChatTurnStream = vi.fn();
  const beginDurableChatRun = overrides.beginDurableChatRun ?? vi.fn(() => undefined);
  const createTrace = vi.fn((input: Partial<ChatTurnTraceRecord>) => {
    traceState = { ...traceState, ...input } as ChatTurnTraceRecord;
    return traceState;
  });
  const patchTrace = vi.fn((_turnId: string, patch: Partial<ChatTurnTraceRecord>) => {
    traceState = { ...traceState, ...patch } as ChatTurnTraceRecord;
    return traceState;
  });
  const activeController = new AbortController();
  return {
    config: {
      assistant: {
        durable: {
          enabled: true,
          executionEnabled: true,
          chatAutoPromoteEnabled: true,
        },
      },
    },
    storage: {
      runImmediateTransaction: <T>(work: () => T): T => work(),
      durableRuns: {
        getRun: vi.fn(() => ({ status: "running" })),
        lockFreshActiveLeaseForUpdate: vi.fn(() => ({ status: "running" })),
      },
      chatMessages: {
        get: vi.fn(() => undefined),
        upsert: vi.fn(),
      },
      approvals: {
        create: vi.fn(),
      },
      chatTurnTraces: {
        create: createTrace,
        patch: patchTrace,
        patchIfStatus: vi.fn(
          (_turnId: string, expected: ChatTurnTraceRecord["status"][], patch: Partial<ChatTurnTraceRecord>) => {
            if (!expected.includes(traceState.status)) {
              return undefined;
            }
            traceState = { ...traceState, ...patch } as ChatTurnTraceRecord;
            return traceState;
          },
        ),
        get: vi.fn(() => traceState),
      },
    } as never,
    sessionControlRuntimeOwner: {
      assertActiveTurnWrite: vi.fn(),
    },
    backgroundTasks: new Set(),
    isFeatureEnabled: vi.fn((flag: string) => flag === "durableKernelV1Enabled"),
    streamPersistedChatTurnEvents: vi.fn(async function* () {}),
    persistChatStreamChunk,
    createHydratedChatTurnTrace: vi.fn((_turnId: string, trace: ChatTurnTraceRecord) => trace),
    recordDevDiagnostic: vi.fn(),
    finalizeDurableChatRun: vi.fn(),
    completeActiveChatTurnStream,
    closeActiveChatTurnStream,
    getActiveChatTurnStream: vi.fn((turnId: string) => executionRegistry.getActiveStream(turnId)),
    beginDurableChatRun,
    registerActiveChatTurnStream,
    ensureSessionInternalToolGrant: vi.fn(),
    requireExecutedToolResult: vi.fn(),
    commsSend: vi.fn(),
    ingestEvent:
      overrides.ingestEvent ??
      vi.fn(async (_idempotencyKey, _payload, options?: { onCommit?: () => void }) => {
        options?.onCommit?.();
      }),
    updateActiveLeafOrThrow: vi.fn(),
    publishRealtime: vi.fn(),
    beginActiveChatTurnExecution: vi.fn(() => activeController),
    endActiveChatTurnExecution: vi.fn(),
    getActiveChatTurnExecution: vi.fn(() => ({ sessionId: "session-1", controller: activeController })),
    markChatTurnCancelled: vi.fn((_sessionId, turnId) => {
      traceState = { ...traceState, turnId, status: "cancelled" } as ChatTurnTraceRecord;
      return traceState;
    }),
  } as unknown as ChatTurnDispatchHost & {
    registerActiveChatTurnStream: ReturnType<typeof vi.fn>;
    persistChatStreamChunk: ReturnType<typeof vi.fn>;
    completeActiveChatTurnStream: ReturnType<typeof vi.fn>;
    beginDurableChatRun: ReturnType<typeof vi.fn>;
    recordDevDiagnostic: ReturnType<typeof vi.fn>;
  };
}

function createPrepared(mode: "chat" | "cowork" | "code", normalizedOverrides: Record<string, unknown> = {}) {
  return {
    session: {
      sessionId: "session-1",
    },
    turnId: "turn-1",
    userEventId: "user-1",
    userMessage: {
      messageId: "user-1",
      sessionId: "session-1",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "hello",
      timestamp: "2026-04-11T00:00:00.000Z",
    },
    turnAdmission: {
      identity: {
        admissionId: "admission:turn-1",
        sessionIncarnationId: "incarnation:session-1",
        workspaceId: "default",
        sessionId: "session-1",
        turnId: "turn-1",
        aggregateRevision: 1,
        controllerGeneration: 1,
        materialSha256: "a".repeat(64),
      },
      admittedRequest: { content: "hello" },
      requestActor: { actorKind: "operator", actorId: "operator" },
    },
    assistantMessageId: "assistant-1",
    parentTurnId: "turn-0",
    branchKind: "append",
    content: "hello",
    route: {
      provider: "openai",
      model: "gpt-5.4",
    },
    normalized: {
      mode,
      ...normalizedOverrides,
    },
    prefs: {
      mode,
    },
    autonomy: {
      reflectionMode: "off",
      proactiveMode: "manual",
      lastProactiveRunId: undefined,
    },
    effectiveToolAutonomy: "manual",
    retrievalTrace: undefined,
    workspaceId: "default",
    resolvedGuidance: {
      globalFilesUsed: [],
      workspaceFilesUsed: [],
      truncated: false,
    },
  } as never;
}

function createBinding() {
  return {
    transport: "integration",
    connectionId: "conn-1",
    target: "target-1",
    writable: true,
  } as never;
}
