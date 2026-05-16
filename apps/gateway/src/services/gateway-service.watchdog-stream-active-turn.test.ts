import { describe, expect, it, vi } from "vitest";
import type { ChatStreamChunk, ChatStreamChunkDraft, ChatTurnTraceRecord } from "@goatcitadel/contracts";
import { GatewayService } from "./gateway-service.js";
import { ChatTurnExecutionRegistry } from "./chat-turn-execution-registry.js";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

async function collectStream(stream: AsyncGenerator<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const chunks: ChatStreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function createTrace(overrides: Partial<ChatTurnTraceRecord> = {}): ChatTurnTraceRecord {
  return {
    turnId: "turn-1",
    sessionId: "session-1",
    userMessageId: "user-message-1",
    branchKind: "append",
    status: "running",
    mode: "chat",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    startedAt: "2026-05-14T00:00:00.000Z",
    toolRuns: [],
    citations: [],
    routing: {},
    ...overrides,
  } as ChatTurnTraceRecord;
}

function createGatewayHarness(overrides: Record<string, unknown> = {}) {
  const gateway = Object.create(GatewayService.prototype) as Record<string, unknown>;
  Object.assign(gateway, {
    closing: false,
    backgroundTasks: new Set<Promise<unknown>>(),
    config: {
      assistant: {
        durable: { enabled: true },
      },
    },
    recordDevDiagnostic: vi.fn(),
  });
  Object.assign(gateway, overrides);
  return gateway as GatewayService & Record<string, unknown>;
}

describe("GatewayService watchdog facade behavior", () => {
  it("reports watchdog posture and records failed home-channel notifications", async () => {
    const commsSend = vi.fn(async () => {
      throw new Error("channel offline");
    });
    const recordDevDiagnostic = vi.fn();
    const gateway = createGatewayHarness({
      commsSend,
      recordDevDiagnostic,
      storage: {
        durableRuns: {
          listDeadLetters: vi.fn(() => [
            { runId: "dead-1" },
            { runId: "dead-2", resolvedAt: "2026-05-14T00:01:00.000Z" },
          ]),
        },
        integrationConnections: {
          list: vi.fn(() => [
            {
              connectionId: "conn-1",
              enabled: true,
              kind: "channel",
              config: { defaultChannelId: "ops-room" },
            },
          ]),
        },
      },
    });

    const runtimeOk = (GatewayService.prototype as any).runRuntimeHealthWatchdog.call(gateway);
    expect(runtimeOk).toMatchObject({
      status: "ok",
      checkId: "runtime_health",
      details: {
        backgroundTaskCount: 0,
        durableEnabled: true,
      },
    });

    gateway.closing = true;
    const runtimeClosing = (GatewayService.prototype as any).runRuntimeHealthWatchdog.call(gateway);
    expect(runtimeClosing).toMatchObject({
      status: "error",
      summary: "Gateway runtime is closing.",
    });
    gateway.closing = false;

    const durableResult = await (GatewayService.prototype as any).runCronWatchdog.call(gateway, {
      jobId: "job-1",
      name: "Durable watchdog",
      actionConfig: {
        watchdog: {
          checkId: "durable_dead_letters",
          notifyHomeChannel: true,
        },
      },
    });

    expect(durableResult).toMatchObject({
      status: "warning",
      checkId: "durable_dead_letters",
      notifyHomeChannel: true,
      details: {
        unresolvedCount: 1,
        sampleRunIds: ["dead-1"],
      },
    });
    expect(commsSend).toHaveBeenCalledWith({
      connectionId: "conn-1",
      target: "ops-room",
      message: "Watchdog attention needed: Durable watchdog\n\n1 unresolved durable dead letter(s) need review.",
    });
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "watchdog.home_channel_notify_failed",
        context: expect.objectContaining({
          jobId: "job-1",
          checkId: "durable_dead_letters",
          error: "channel offline",
        }),
      }),
    );
  });

  it("classifies channel queue and MCP posture watchdog states without notifying when no target exists", async () => {
    const commsSend = vi.fn();
    const gateway = createGatewayHarness({
      commsSend,
      storage: {
        integrationConnections: {
          list: vi.fn(() => []),
        },
      },
      listChannelDeliveryRuntime: vi.fn(),
      readMcpServers: vi.fn(),
    });

    gateway.listChannelDeliveryRuntime = vi.fn(() => []);
    expect((GatewayService.prototype as any).runChannelDeliveryQueueWatchdog.call(gateway)).toMatchObject({
      status: "ok",
      summary: "Channel delivery queue is clear.",
      details: {
        blockedCount: 0,
        retryingCount: 0,
        sampleDeliveryIds: [],
      },
    });

    gateway.listChannelDeliveryRuntime = vi.fn(() => [{ deliveryId: "retry-1", deliveryStatus: "retrying" }]);
    expect((GatewayService.prototype as any).runChannelDeliveryQueueWatchdog.call(gateway)).toMatchObject({
      status: "warning",
      details: {
        retryingCount: 1,
        sampleDeliveryIds: ["retry-1"],
      },
    });

    gateway.listChannelDeliveryRuntime = vi.fn(() => [
      { deliveryId: "blocked-1", deliveryStatus: "blocked" },
      { deliveryId: "missing-1", deliveryStatus: "not_available" },
      { deliveryId: "degraded-1", deliveryStatus: "degraded" },
      { deliveryId: "retry-1", deliveryStatus: "retrying" },
    ]);
    expect((GatewayService.prototype as any).runChannelDeliveryQueueWatchdog.call(gateway)).toMatchObject({
      status: "error",
      details: {
        blockedCount: 3,
        retryingCount: 1,
        sampleDeliveryIds: ["blocked-1", "missing-1", "degraded-1", "retry-1"],
      },
    });

    gateway.readMcpServers = vi.fn(() => [
      { serverId: "healthy", enabled: true, status: "connected", trustTier: "trusted", transport: "stdio" },
    ]);
    expect((GatewayService.prototype as any).runMcpPostureWatchdog.call(gateway)).toMatchObject({
      status: "ok",
      summary: "MCP posture is healthy for enabled servers.",
      details: {
        enabledCount: 1,
        hardIssueServerIds: [],
        softIssueServerIds: [],
      },
    });

    gateway.readMcpServers = vi.fn(() => [
      {
        serverId: "needs-url",
        enabled: true,
        status: "connected",
        trustTier: "restricted",
        transport: "http",
        url: " ",
      },
      {
        serverId: "oauth-needs-url",
        enabled: true,
        status: "connected",
        trustTier: "restricted",
        transport: "stdio",
        authType: "oauth2",
        url: "",
      },
    ]);
    expect((GatewayService.prototype as any).runMcpPostureWatchdog.call(gateway)).toMatchObject({
      status: "warning",
      details: {
        softIssueServerIds: ["needs-url", "oauth-needs-url"],
      },
    });

    gateway.readMcpServers = vi.fn(() => [
      { serverId: "quarantined", enabled: true, status: "connected", trustTier: "quarantined", transport: "stdio" },
      { serverId: "errored", enabled: true, status: "error", trustTier: "restricted", transport: "stdio" },
      { serverId: "stale", enabled: true, status: "disconnected", trustTier: "restricted", transport: "sse", url: "" },
      { serverId: "disabled", enabled: false, status: "error", trustTier: "quarantined", transport: "stdio" },
    ]);
    expect((GatewayService.prototype as any).runMcpPostureWatchdog.call(gateway)).toMatchObject({
      status: "error",
      details: {
        enabledCount: 3,
        hardIssueServerIds: ["quarantined", "errored"],
        softIssueServerIds: ["errored", "stale"],
      },
    });

    await (GatewayService.prototype as any).notifyWatchdogHomeChannel.call(
      gateway,
      { name: "No channel" },
      { summary: "Nothing to send." },
    );
    expect(commsSend).not.toHaveBeenCalled();
  });
});

describe("GatewayService maintenance scheduler facade behavior", () => {
  it("runs due scheduler collaborators and skips work while closing", async () => {
    const runPrivateBetaBackupSchedulerIfDue = vi.fn(async () => undefined);
    const runMemoryFlushSchedulerIfDue = vi.fn(async () => undefined);
    const runCostReportSchedulerIfDue = vi.fn(async () => undefined);
    const runUpdateReviewSchedulerIfDue = vi.fn(async () => undefined);
    const runDueTaskCronJobs = vi.fn(async () => undefined);
    const runDueEvaluation = vi.fn(async () => undefined);
    const drainDueChannelDeliveries = vi.fn(async () => []);
    const gateway = createGatewayHarness({
      closing: true,
      runPrivateBetaBackupSchedulerIfDue,
      runMemoryFlushSchedulerIfDue,
      runCostReportSchedulerIfDue,
      runUpdateReviewSchedulerIfDue,
      curatorService: { runCuratorWeeklyIfDue: vi.fn(async () => undefined) },
      cronAutomationService: { runDueTaskCronJobs },
      memoryLifecycleService: { runDueEvaluation },
      drainDueChannelDeliveries,
    });

    await (GatewayService.prototype as any).runMaintenanceSchedulerTick.call(gateway);
    expect(runPrivateBetaBackupSchedulerIfDue).not.toHaveBeenCalled();

    gateway.closing = false;
    await (GatewayService.prototype as any).runMaintenanceSchedulerTick.call(gateway);

    expect(runPrivateBetaBackupSchedulerIfDue).toHaveBeenCalledTimes(1);
    expect(runMemoryFlushSchedulerIfDue).toHaveBeenCalledTimes(1);
    expect(runCostReportSchedulerIfDue).toHaveBeenCalledTimes(1);
    expect(runUpdateReviewSchedulerIfDue).toHaveBeenCalledTimes(1);
    expect(runDueTaskCronJobs).toHaveBeenCalledTimes(1);
    expect(runDueEvaluation).toHaveBeenCalledTimes(1);
    expect(drainDueChannelDeliveries).toHaveBeenCalledTimes(1);
  });

  it("schedules root-turn memory maintenance and chat memory prewarm only when useful", async () => {
    const noteSuccessfulRootTurn = vi.fn(async () => undefined);
    const prewarmContext = vi.fn(async () => ({ contextId: "ctx-1" }));
    const resolveMemoryWorkspaceRelativeDir = vi.fn(() => "memory/workspace/session-1");
    const gateway = createGatewayHarness({
      backgroundTasks: new Set<Promise<unknown>>(),
      memoryLifecycleService: {
        noteSuccessfulRootTurn,
        prewarmContext,
      },
      resolveMemoryWorkspaceRelativeDir,
    });

    GatewayService.prototype.scheduleMemoryMaintenancePostTurnEvaluation.call(gateway, "session-1", "parent-turn");
    expect(noteSuccessfulRootTurn).not.toHaveBeenCalled();

    GatewayService.prototype.scheduleMemoryMaintenancePostTurnEvaluation.call(gateway, "session-1");
    expect(noteSuccessfulRootTurn).toHaveBeenCalledWith("session-1");

    GatewayService.prototype.scheduleChatMemoryContextPrewarm.call(gateway, {
      sessionId: "session-1",
      prompt: "   ",
    });
    expect(prewarmContext).not.toHaveBeenCalled();

    GatewayService.prototype.scheduleChatMemoryContextPrewarm.call(gateway, {
      sessionId: "session-1",
      prompt: "Summarize the current thread",
      relationScope: "project",
    });
    expect(prewarmContext).toHaveBeenCalledWith({
      scope: "chat",
      sessionId: "session-1",
      prompt: "Summarize the current thread",
      relationScope: "project",
      workspace: "memory/workspace/session-1",
      forceRefresh: true,
    });

    gateway.closing = true;
    GatewayService.prototype.scheduleMemoryMaintenancePostTurnEvaluation.call(gateway, "session-2");
    GatewayService.prototype.scheduleChatMemoryContextPrewarm.call(gateway, {
      sessionId: "session-2",
      prompt: "Ignored while closing",
    });
    expect(noteSuccessfulRootTurn).toHaveBeenCalledTimes(1);
    expect(prewarmContext).toHaveBeenCalledTimes(1);
  });
});

describe("GatewayService active-turn cancellation facade behavior", () => {
  it("reports running turns and forwards execution registry operations", () => {
    const gateway = createGatewayHarness({
      storage: {
        chatTurnTraces: {
          listBySession: vi
            .fn()
            .mockReturnValueOnce([])
            .mockReturnValueOnce([createTrace({ status: "queued" })])
            .mockReturnValueOnce([createTrace({ status: "completed" })]),
        },
      },
      chatTurnExecutionRegistry: new ChatTurnExecutionRegistry(),
    });

    expect(GatewayService.prototype.hasRunningTurn.call(gateway, "session-1")).toBe(false);
    expect(GatewayService.prototype.hasRunningTurn.call(gateway, "session-1")).toBe(true);
    expect(GatewayService.prototype.hasRunningTurn.call(gateway, "session-1")).toBe(false);

    const controller = GatewayService.prototype.beginActiveChatTurnExecution.call(
      gateway,
      "session-1",
      "turn-1",
      "stream",
    );
    expect(GatewayService.prototype.getActiveChatTurnExecution.call(gateway, "turn-1")).toMatchObject({
      sessionId: "session-1",
      turnId: "turn-1",
      operation: "stream",
      controller,
    });

    controller.abort("operator");
    expect((GatewayService.prototype as any).isChatTurnCancellationRequested.call(gateway, "turn-1")).toBe(true);

    GatewayService.prototype.endActiveChatTurnExecution.call(gateway, "turn-1", new AbortController());
    expect(GatewayService.prototype.getActiveChatTurnExecution.call(gateway, "turn-1")).toBeDefined();

    GatewayService.prototype.endActiveChatTurnExecution.call(gateway, "turn-1", controller);
    expect(GatewayService.prototype.getActiveChatTurnExecution.call(gateway, "turn-1")).toBeUndefined();
  });

  it("cancels the latest active turn and reports durable cancellation outcomes", async () => {
    const activeTrace = createTrace({
      turnId: "turn-active",
      durable: { runId: "trace-run", status: "running" },
    });
    const cancelledTrace = createTrace({
      turnId: "turn-active",
      status: "cancelled",
      durable: { runId: "runtime-run", status: "cancelled" },
    });
    const cancelChatTurn = vi.fn(async () => ({ trace: cancelledTrace }));
    const cancelDurableRun = vi.fn();
    const gateway = createGatewayHarness({
      storage: {
        chatTurnTraces: {
          listBySession: vi
            .fn()
            .mockReturnValueOnce([])
            .mockReturnValueOnce([createTrace({ status: "completed" }), activeTrace])
            .mockReturnValueOnce([activeTrace])
            .mockReturnValueOnce([activeTrace]),
        },
      },
      chatTurnRuntime: {
        cancelChatTurn,
      },
      cancelDurableRun,
    });

    await expect(
      GatewayService.prototype.cancelLatestActiveChatTurnForSession.call(gateway, "session-1"),
    ).resolves.toEqual({
      status: "no_active_run",
      sessionId: "session-1",
    });

    await expect(
      GatewayService.prototype.cancelLatestActiveChatTurnForSession.call(gateway, "session-1", "tester"),
    ).resolves.toMatchObject({
      status: "cancelled",
      sessionId: "session-1",
      turnId: "turn-active",
      durableRunId: "runtime-run",
      durableCancelled: true,
      trace: cancelledTrace,
    });
    expect(cancelChatTurn).toHaveBeenCalledWith("session-1", "turn-active", "tester");
    expect(cancelDurableRun).toHaveBeenCalledWith("runtime-run", "tester");

    cancelDurableRun.mockImplementationOnce(() => {
      throw new Error("durable offline");
    });
    await expect(
      GatewayService.prototype.cancelLatestActiveChatTurnForSession.call(gateway, "session-1", "tester"),
    ).resolves.toMatchObject({
      status: "cancelled",
      durableCancelled: false,
    });

    cancelChatTurn.mockRejectedValueOnce(new Error("cancel failed"));
    await expect(
      GatewayService.prototype.cancelLatestActiveChatTurnForSession.call(gateway, "session-1", "tester"),
    ).resolves.toMatchObject({
      status: "failed",
      sessionId: "session-1",
      turnId: "turn-active",
      durableRunId: "trace-run",
      error: "cancel failed",
    });
  });
});

describe("GatewayService retained stream facade behavior", () => {
  it("registers active streams, persists ordered chunks, and purges stale stream events", () => {
    const append = vi.fn();
    const purgeBefore = vi.fn();
    const gateway = createGatewayHarness({
      lastChatStreamPurgeAt: Date.now(),
      chatTurnExecutionRegistry: new ChatTurnExecutionRegistry(),
      storage: {
        chatStreamEvents: {
          getLatestSequence: vi.fn(() => 7),
          append,
          purgeBefore,
        },
      },
    });

    const active = GatewayService.prototype.registerActiveChatTurnStream.call(gateway, "session-1", "turn-1", "run-1");
    expect(active).toMatchObject({
      sessionId: "session-1",
      turnId: "turn-1",
      runId: "run-1",
      nextSequence: 8,
      completed: false,
    });

    const persisted = GatewayService.prototype.persistChatStreamChunk.call(
      gateway,
      {
        type: "delta",
        sessionId: "session-1",
        turnId: "turn-1",
        delta: "hello",
      },
      "run-1",
    );
    expect(persisted).toMatchObject({
      type: "delta",
      sessionId: "session-1",
      turnId: "turn-1",
      delta: "hello",
      sequence: 8,
      runId: "run-1",
    });
    expect(active.nextSequence).toBe(9);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-1",
        sequence: 8,
        runId: "run-1",
        chunkType: "delta",
        payload: expect.objectContaining({ delta: "hello", sequence: 8 }),
      }),
    );
    expect(purgeBefore).not.toHaveBeenCalled();

    GatewayService.prototype.completeActiveChatTurnStream.call(gateway, "turn-1");
    expect(active.completed).toBe(true);
    GatewayService.prototype.closeActiveChatTurnStream.call(gateway, "turn-1");
    expect((gateway.chatTurnExecutionRegistry as ChatTurnExecutionRegistry).getActiveStream("turn-1")).toBeUndefined();

    gateway.lastChatStreamPurgeAt = 0;
    GatewayService.prototype.persistChatStreamChunk.call(gateway, {
      type: "delta",
      sessionId: "session-1",
      turnId: "turn-2",
      delta: "later",
    });
    expect(purgeBefore).toHaveBeenCalledWith(expect.stringMatching(/T.*Z$/));
  });

  it("streams persisted chunks, falls back from mismatched cursors, and envelopes ephemeral chunks", async () => {
    const gateway = createGatewayHarness({
      chatTurnExecutionRegistry: new ChatTurnExecutionRegistry(),
      storage: {
        chatStreamEvents: {
          getByEventId: vi.fn(() => undefined),
          getLatestSequence: vi.fn(() => 3),
          listByTurn: vi.fn((_turnId: string, afterSequence: number) =>
            afterSequence === 0
              ? [
                  {
                    sequence: 1,
                    payload: { type: "delta", sessionId: "session-1", turnId: "turn-1" },
                  },
                  {
                    sequence: 2,
                    payload: {
                      type: "delta",
                      sessionId: "session-1",
                      turnId: "turn-1",
                      eventId: "event-2",
                      sequence: 2,
                      delta: "hello",
                    },
                  },
                  {
                    sequence: 3,
                    payload: {
                      type: "done",
                      sessionId: "session-1",
                      turnId: "turn-1",
                      eventId: "event-3",
                      sequence: 3,
                      messageId: "assistant-message-1",
                    },
                  },
                ]
              : [],
          ),
        },
        chatTurnTraces: {
          get: vi.fn(() =>
            createTrace({
              status: "completed",
              assistantMessageId: "assistant-message-1",
              durable: { runId: "run-fallback", status: "completed" },
              completion: { status: "completed", finishReason: "stop", repaired: true },
            }),
          ),
        },
        chatMessages: {
          get: vi.fn(() => ({
            messageId: "assistant-message-1",
            content: "final answer",
          })),
        },
      },
      createHydratedChatTurnTrace: vi.fn((_turnId: string, trace: ChatTurnTraceRecord) => trace),
      persistChatStreamChunk: vi.fn((chunk: ChatStreamChunkDraft, runId?: string) => ({
        ...chunk,
        eventId: `event-${chunk.type}`,
        sequence: 99,
        ...(runId ? { runId } : {}),
      })),
    });

    await expect(
      collectStream(GatewayService.prototype.streamPersistedChatTurnEvents.call(gateway, "session-1", "turn-1")),
    ).resolves.toMatchObject([
      { type: "delta", delta: "hello", sequence: 2 },
      { type: "done", messageId: "assistant-message-1", sequence: 3 },
    ]);

    gateway.storage.chatStreamEvents.getByEventId = vi.fn(() => ({ turnId: "other-turn", sequence: 1 }));
    await expect(
      collectStream(
        GatewayService.prototype.streamPersistedChatTurnEvents.call(gateway, "session-1", "turn-1", {
          sinceEventId: "event-other",
        }),
      ),
    ).resolves.toMatchObject([
      { type: "trace_update", runId: "run-fallback" },
      { type: "message_done", content: "final answer", repaired: true, runId: "run-fallback" },
      { type: "done", messageId: "assistant-message-1", runId: "run-fallback" },
    ]);

    gateway.storage.chatStreamEvents.getByEventId = vi.fn(() => ({ turnId: "turn-1", sequence: 2 }));
    gateway.storage.chatStreamEvents.listByTurn = vi.fn((_turnId: string, afterSequence: number) =>
      afterSequence === 2
        ? [
            {
              sequence: 3,
              payload: {
                type: "done",
                sessionId: "session-1",
                turnId: "turn-1",
                eventId: "event-3",
                sequence: 3,
                messageId: "assistant-message-1",
              },
            },
          ]
        : [],
    );
    await expect(
      collectStream(
        GatewayService.prototype.streamPersistedChatTurnEvents.call(gateway, "session-1", "turn-1", {
          sinceEventId: "event-2",
        }),
      ),
    ).resolves.toMatchObject([{ type: "done", sequence: 3 }]);

    async function* source(): AsyncGenerator<ChatStreamChunkDraft> {
      yield { type: "delta", sessionId: "session-1", turnId: "turn-1", delta: "one" };
      yield { type: "done", sessionId: "session-1", turnId: "turn-1", messageId: "assistant-message-1" };
    }

    await expect(
      collectStream(GatewayService.prototype.withEphemeralStreamEnvelope.call(gateway, source(), "run-ephemeral")),
    ).resolves.toMatchObject([
      { type: "delta", sequence: 1, runId: "run-ephemeral" },
      { type: "done", sequence: 2, runId: "run-ephemeral" },
    ]);
  });

  it("uses SQL stream events and trace fallback to decide whether durable streaming is still pending", () => {
    let sqlRunId: string | null = "run-sql";
    const durableRuns = {
      getRun: vi.fn((runId: string) => ({
        runId,
        status: runId === "run-sql" ? "paused" : "completed",
      })),
    };
    const gateway = createGatewayHarness({
      storage: {
        gatewaySql: {
          prepare: vi.fn(() => ({
            get: vi.fn(() => ({ run_id: sqlRunId })),
          })),
        },
        durableRuns,
        chatTurnTraces: {
          get: vi.fn(() =>
            createTrace({
              durable: { runId: "run-trace", status: "running" },
            }),
          ),
        },
      },
    });

    expect((GatewayService.prototype as any).isDurableTurnStillStreaming.call(gateway, "turn-1")).toBe(true);

    sqlRunId = null;
    expect((GatewayService.prototype as any).isDurableTurnStillStreaming.call(gateway, "turn-1")).toBe(false);
    expect(durableRuns.getRun).toHaveBeenLastCalledWith("run-trace");

    gateway.storage.durableRuns.getRun = vi.fn(() => {
      throw new Error("missing run");
    });
    expect((GatewayService.prototype as any).isDurableTurnStillStreaming.call(gateway, "turn-1")).toBe(false);

    gateway.storage.chatTurnTraces.get = vi.fn(() => {
      throw new Error("missing trace");
    });
    expect((GatewayService.prototype as any).isDurableTurnStillStreaming.call(gateway, "turn-1")).toBe(false);
  });
});
