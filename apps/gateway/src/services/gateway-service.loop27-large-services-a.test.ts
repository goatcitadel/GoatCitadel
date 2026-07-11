import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import { GatewayService } from "./gateway-service.js";
import { McpServerStore } from "./mcp-server-store.js";

function createGatewayHarness(overrides: Record<string, unknown> = {}) {
  const settings = new Map<string, unknown>();
  const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
  Object.assign(gateway, {
    backgroundTasks: new Set<Promise<unknown>>(),
    chatMessageProjectionBackfillAttempted: new Set<string>(),
    closing: false,
    config: {
      rootDir: "F:/code/personal-ai",
      assistant: {
        auth: { mode: "token", allowLoopbackBypass: false, token: { queryParam: "token" } },
        deploymentProfile: "local_dev",
        web: {
          firecrawl: {
            enabled: false,
            baseUrl: "https://firecrawl.example.test",
          },
        },
      },
      toolPolicy: {
        sandbox: {
          networkAllowlist: ["api.example.test", "firecrawl.example.test"],
          readOnlyRoots: [],
          writeJailRoots: [],
        },
      },
    },
    getGitHead: vi.fn(() => "git-head"),
    isFeatureEnabled: vi.fn(() => true),
    listToolGrants: vi.fn(() => []),
    publishRealtime: vi.fn((_eventType: string, _source: string, payload: Record<string, unknown>) => ({
      eventId: "event-1",
      payload,
    })),
    storage: {
      approvals: { get: vi.fn() },
      chatGeneratedArtifacts: { listBySession: vi.fn(() => []) },
      chatMessages: { countBySession: vi.fn(() => 0), upsertMany: vi.fn() },
      chatProjects: { find: vi.fn(() => ({ projectId: "project-1", name: "Project", workspaceId: "workspace-a" })) },
      chatSessionMeta: {
        ensure: vi.fn((_sessionId: string, _title?: string, workspaceId = "default") => ({
          workspaceId,
          title: "Ensured session",
        })),
        get: vi.fn(() => ({ workspaceId: "workspace-a", title: "[Replay scratch] run" })),
      },
      chatSessionPrefs: { get: vi.fn(() => ({ mode: "cowork" })) },
      chatSessionProjects: { get: vi.fn(() => ({ projectId: "project-1" })) },
      commsDeliveries: { list: vi.fn(() => []) },
      contextManifests: {
        appendEntry: vi.fn(),
        ensure: vi.fn(() => ({ manifestId: "manifest-1" })),
      },
      cronJobs: { list: vi.fn(() => []) },
      gatewaySql: { prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(), run: vi.fn() })) },
      integrationConnections: {
        get: vi.fn(() => ({ connectionId: "conn-1", key: "slack" })),
        list: vi.fn(() => []),
      },
      orchestration: {
        createCheckpoint: vi.fn((input: Record<string, unknown>) => ({ checkpointId: "cp-1", ...input })),
      },
      remoteActionTokens: {
        findByTokenHash: vi.fn(),
        get: vi.fn(),
        updateState: vi.fn((tokenId: string, state: string, patch?: Record<string, unknown>) => ({
          tokenId,
          state,
          ...patch,
        })),
      },
      sessions: { getBySessionId: vi.fn((sessionId: string) => ({ sessionId, sessionKey: `mission:${sessionId}` })) },
      systemSettings: {
        get: vi.fn((key: string) => (settings.has(key) ? { value: settings.get(key) } : undefined)),
        set: vi.fn((key: string, value: unknown) => settings.set(key, value)),
      },
      transcripts: { read: vi.fn(async () => []) },
    },
  });
  Object.assign(gateway, overrides);
  if (!gateway.mcpServerStore) {
    // Real store over the harness's map-backed systemSettings (B5a): MCP
    // read/write behavior assertions keep flowing through `settings`.
    gateway.mcpServerStore = new McpServerStore({ systemSettings: gateway.storage.systemSettings });
  }
  return { gateway, settings };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("GatewayService loop 27 large service coverage", () => {
  it("records context manifests for non-memory system prompts and linked memory context", () => {
    const { gateway } = createGatewayHarness();
    const memoryContext = {
      citations: [{ source: "memory" }],
      contextId: "context-1",
      contextText: "Memory context body",
      createdAt: "2026-05-15T00:00:00.000Z",
      distilledTokenEstimate: 5,
      expiresAt: "2026-05-15T01:00:00.000Z",
      originalTokenEstimate: 10,
      quality: {
        reason: "fresh",
        status: "ready",
        assembly: {
          availableCandidateCount: 4,
          selectedCandidateCount: 2,
          droppedCandidateCount: 2,
          availableTokenEstimate: 100,
          selectedTokenEstimate: 40,
          evidenceTokenBudget: 2_000,
        },
      },
      scope: "workspace",
    };

    GatewayService.prototype.persistContextManifestForCompletionRequest.call(gateway, {
      memoryContext,
      memoryContextPlacement: {
        position: "before_final_user_message",
        insertedIndex: 1,
        finalUserMessageIndex: 1,
        leadingSystemMessageCount: 1,
        copyMode: "retrieved_non_authoritative",
      },
      request: {
        memory: { sessionId: "session-1", taskId: "task-1", turnId: "turn-1" },
        messages: [
          { role: "system", content: "Operator guidance\nsecond line" },
          { role: "user", content: "Skip user content" },
          { role: "system", content: "   " },
        ],
      },
    } as never);

    expect(gateway.storage.contextManifests.ensure).toHaveBeenCalledWith({
      scope: "chat_turn",
      turnId: "turn-1",
      sessionId: "session-1",
      taskId: "task-1",
    });
    expect(gateway.storage.contextManifests.appendEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "system_message",
        title: "Operator guidance",
        sourceRef: "system:0",
        contentText: "Operator guidance\nsecond line",
      }),
    );
    expect(gateway.storage.contextManifests.appendEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "memory_context",
        entryIndex: 1,
        sourceRef: "context-1",
        metadata: expect.objectContaining({
          status: "ready",
          citationsCount: 1,
          originalTokenEstimate: 10,
          assembly: {
            availableCandidateCount: 4,
            selectedCandidateCount: 2,
            droppedCandidateCount: 2,
            availableTokenEstimate: 100,
            selectedTokenEstimate: 40,
            evidenceTokenBudget: 2_000,
          },
          placement: expect.objectContaining({
            position: "before_final_user_message",
            copyMode: "retrieved_non_authoritative",
          }),
        }),
      }),
    );

    GatewayService.prototype.persistContextManifestForCompletionRequest.call(gateway, {
      request: { memory: { turnId: "   " }, messages: [{ role: "system", content: "ignored" }] },
    } as never);
    expect(gateway.storage.contextManifests.ensure).toHaveBeenCalledTimes(1);
  });

  it("consumes remote action tokens by hash and id while preserving expired-token evidence", () => {
    vi.setSystemTime(new Date("2026-05-15T00:00:00.000Z"));
    const pending = {
      actionType: "approval.resolve",
      connectorId: "conn-1",
      expiresAt: "2026-05-15T00:05:00.000Z",
      state: "pending",
      tokenId: "token-1",
    };
    const { gateway } = createGatewayHarness({
      storage: {
        remoteActionTokens: {
          findByTokenHash: vi.fn(() => pending),
          get: vi.fn(() => ({ ...pending, tokenId: "token-2" })),
          consumePending: vi.fn((tokenId: string, patch?: Record<string, unknown>) => ({
            ...pending,
            tokenId,
            state: "consumed",
            ...patch,
          })),
          expirePendingAtOrBefore: vi.fn((tokenId: string) =>
            tokenId === "expired-token" ? { ...pending, tokenId, state: "expired" } : { ...pending, tokenId },
          ),
          updateState: vi.fn((tokenId: string, state: string, patch?: Record<string, unknown>) => ({
            ...pending,
            tokenId,
            state,
            ...patch,
          })),
        },
      },
    });

    expect(
      GatewayService.prototype.consumeRemoteActionToken.call(gateway, " raw-token ", "approval.resolve", {
        expectedConnectorId: "conn-1",
      }),
    ).toMatchObject({
      tokenId: "token-1",
      state: "consumed",
      consumedBy: "connector:conn-1",
    });
    expect(
      GatewayService.prototype.consumeRemoteActionTokenById.call(gateway, " token-2 ", "approval.resolve", {
        expectedConnectorId: "conn-1",
      }),
    ).toMatchObject({
      tokenId: "token-2",
      state: "consumed",
      consumedBy: "connector:conn-1",
    });
    expect(gateway.storage.remoteActionTokens.consumePending).toHaveBeenCalledWith(
      "token-1",
      expect.objectContaining({ consumedBy: "connector:conn-1" }),
    );
    expect(gateway.storage.remoteActionTokens.consumePending).toHaveBeenCalledWith(
      "token-2",
      expect.objectContaining({ consumedBy: "connector:conn-1" }),
    );

    gateway.storage.remoteActionTokens.findByTokenHash = vi.fn(() => pending);
    gateway.storage.remoteActionTokens.consumePending = vi.fn(() => undefined);
    expect(() =>
      GatewayService.prototype.consumeRemoteActionToken.call(gateway, "raw-token", "approval.resolve", {
        expectedConnectorId: "conn-1",
      }),
    ).toThrow("already been consumed");

    gateway.storage.remoteActionTokens.get = vi.fn(() => ({
      ...pending,
      expiresAt: "2026-05-14T23:59:00.000Z",
      tokenId: "expired-token",
    }));
    expect(() =>
      GatewayService.prototype.consumeRemoteActionTokenById.call(gateway, "expired-token", "approval.resolve", {
        expectedConnectorId: "conn-1",
      }),
    ).toThrow("expired");
    expect(gateway.storage.remoteActionTokens.expirePendingAtOrBefore).toHaveBeenCalledWith(
      "expired-token",
      expect.any(String),
    );
  });

  it("rejects remote action tokens that are empty, unknown, mismatched, or already consumed (security invariants)", () => {
    vi.setSystemTime(new Date("2026-05-15T00:00:00.000Z"));
    const { gateway } = createGatewayHarness({
      storage: {
        remoteActionTokens: {
          findByTokenHash: vi.fn(() => undefined),
          get: vi.fn(),
          updateState: vi.fn(),
        },
      },
    });

    // Empty token is rejected before any lookup.
    expect(() => GatewayService.prototype.consumeRemoteActionToken.call(gateway, "   ", "approval.resolve")).toThrow(
      /required/i,
    );

    // Unknown token hash cannot resolve anything (the public /remote-resolve endpoint
    // is safe only because it requires an unguessable, server-minted token).
    expect(() =>
      GatewayService.prototype.consumeRemoteActionToken.call(gateway, "bogus-token", "approval.resolve"),
    ).toThrow();
    expect(gateway.storage.remoteActionTokens.updateState).not.toHaveBeenCalled();

    // A token minted for a different action type cannot be used to resolve approvals.
    gateway.storage.remoteActionTokens.findByTokenHash = vi.fn(() => ({
      actionType: "connector.mutation",
      connectorId: "conn-1",
      expiresAt: "2026-05-15T00:05:00.000Z",
      state: "pending",
      tokenId: "token-x",
    }));
    expect(() =>
      GatewayService.prototype.consumeRemoteActionToken.call(gateway, "wrong-action", "approval.resolve"),
    ).toThrow(/bound to/i);

    // An already-consumed token cannot be replayed (single-use).
    gateway.storage.remoteActionTokens.findByTokenHash = vi.fn(() => ({
      actionType: "approval.resolve",
      connectorId: "conn-1",
      expiresAt: "2026-05-15T00:05:00.000Z",
      state: "consumed",
      tokenId: "token-y",
    }));
    expect(() =>
      GatewayService.prototype.consumeRemoteActionToken.call(gateway, "replayed-token", "approval.resolve", {
        expectedConnectorId: "conn-1",
      }),
    ).toThrow(/already been consumed/i);
  });

  it("guards connector lookup and runtime profile updates with explicit operator-facing errors", () => {
    const { gateway } = createGatewayHarness({
      listConnectorRecords: vi.fn(() => [{ connectorId: "conn-1", connectorType: "integration_connection" }]),
    });

    expect(GatewayService.prototype.requireConnectorRecord.call(gateway, " conn-1 ")).toMatchObject({
      connectorId: "conn-1",
    });
    expect(() => GatewayService.prototype.requireConnectorRecord.call(gateway, "   ")).toThrow(
      "connectorId is required",
    );
    expect(() => GatewayService.prototype.requireConnectorRecord.call(gateway, "missing")).toThrow(
      "Connector missing not found",
    );

    expect(() =>
      GatewayService.prototype.assertDeploymentProfileUpdate.call(gateway, {
        auth: { allowLoopbackBypass: true, mode: "none" },
        deploymentProfile: "remote_hardened",
        networkAllowlist: ["*"],
      }),
    ).toThrow(/requires token or basic auth.*loopback bypass.*wildcard/u);

    expect(() =>
      GatewayService.prototype.assertFirecrawlRuntimeUpdate.call(gateway, {
        networkAllowlist: ["api.example.test"],
        web: { firecrawl: { enabled: true, baseUrl: "https://blocked.example.test" } },
      }),
    ).toThrow("web.firecrawl.baseUrl must be present");
  });

  it("normalizes MCP records, patches server state, filters tools, and overlays browser fallback approvals", () => {
    const { gateway, settings } = createGatewayHarness();
    settings.set("mcp_servers_v1", [
      {
        enabled: true,
        label: "Browser MCP",
        policy: { requireFirstToolApproval: true },
        serverId: "server-1",
        status: "connected",
        transport: "http",
      },
      undefined,
    ]);
    settings.set("mcp_tools_v1", [
      { enabled: true, serverId: "server-1", toolName: "browser.search" },
      { enabled: true, serverId: "server-1", toolName: "browser.navigate" },
      { serverId: "", toolName: "invalid" },
    ]);
    settings.set("mcp_tool_first_approval_v1", { "server-1": ["browser.search"] });

    expect(GatewayService.prototype.readMcpServers.call(gateway)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serverId: "goatcitadel-internal-approval-inbox",
          url: "goatcitadel://approval-inbox",
          status: "connected",
        }),
        expect.objectContaining({
          serverId: "goatcitadel-internal-durable-tasks",
          url: "goatcitadel://durable-tasks",
          status: "connected",
        }),
        expect.objectContaining({
          serverId: "server-1",
          category: "automation",
          trustTier: "restricted",
          costTier: "unknown",
        }),
      ]),
    );
    expect(
      GatewayService.prototype.patchMcpServerState.call(gateway, "server-1", { status: "connected" }),
    ).toMatchObject({
      serverId: "server-1",
      status: "connected",
    });
    expect(GatewayService.prototype.listMcpTools.call(gateway, "server-1").map((tool: any) => tool.toolName)).toEqual([
      "browser.navigate",
      "browser.search",
    ]);
    expect(GatewayService.prototype.listMcpBrowserFallbackTargets.call(gateway)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serverId: "server-1",
          searchToolName: "browser.search",
        }),
      ]),
    );
  });

  it("queues channel sends, merges persisted and runtime delivery truth, and drains asynchronously", async () => {
    let resolveDrain: (value: Array<{ deliveryId: string }>) => void = () => undefined;
    const drainTask = new Promise<Array<{ deliveryId: string }>>((resolve) => {
      resolveDrain = resolve;
    });
    const { gateway } = createGatewayHarness({
      backgroundTasks: new Set<Promise<unknown>>(),
      channelDeliveryRuntimeService: {
        drainDue: vi.fn(() => drainTask),
        enqueue: vi.fn(() => ({
          channelKey: "slack",
          connectionId: "conn-1",
          createdAt: "2026-05-15T00:00:00.000Z",
          deliveryId: "delivery-1",
          deliveryStatus: "retrying",
          nextAttemptAt: "2026-05-15T00:01:00.000Z",
          status: "queued",
          target: { channelId: "C1" },
          updatedAt: "2026-05-15T00:00:00.000Z",
        })),
        list: vi.fn(() => [
          {
            attempts: 1,
            channelKey: "slack",
            connectionId: "conn-1",
            createdAt: "2026-05-15T00:02:00.000Z",
            deliveryId: "runtime-1",
            idempotencyKey: "runtime-key",
            maxAttempts: 3,
            payloadHash: "hash",
            status: "retrying",
            target: { channelId: "C2" },
            updatedAt: "2026-05-15T00:02:00.000Z",
          },
        ]),
      },
      storage: {
        commsDeliveries: {
          list: vi.fn(() => [
            {
              attempts: 2,
              channelKey: "slack",
              connectionId: "conn-1",
              createdAt: "2026-05-15T00:00:00.000Z",
              deliveryId: "persisted-1",
              deliveryStatus: "failed",
              error: "network",
              fallbackReason: "network",
              idempotencyKey: "persisted-key",
              maxAttempts: 3,
              payloadHash: "hash",
              status: "failed",
              target: { channelId: "C0" },
              updatedAt: "2026-05-15T00:00:00.000Z",
            },
          ]),
        },
        integrationConnections: {
          get: vi.fn(() => ({ connectionId: "conn-1", key: "slack" })),
        },
      },
    });

    await expect(
      GatewayService.prototype.commsSend.call(gateway, {
        connectionId: "conn-1",
        message: "hello",
        target: { channelId: "C1" },
      } as never),
    ).resolves.toMatchObject({
      deliveryId: "delivery-1",
      status: "queued",
      deliveryStatus: "retrying",
      nextAttemptAt: "2026-05-15T00:01:00.000Z",
    });
    expect(gateway.channelDeliveryRuntimeService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channelKey: "slack",
        connectionId: "conn-1",
        target: { channelId: "C1" },
      }),
    );
    expect(gateway.backgroundTasks.size).toBe(1);
    resolveDrain([{ deliveryId: "runtime-1" }]);
    await Promise.allSettled([...gateway.backgroundTasks]);
    expect(gateway.backgroundTasks.size).toBe(0);

    expect(
      GatewayService.prototype.listChannelDeliveryRuntime.call(gateway).map((record: any) => record.deliveryId),
    ).toEqual(["runtime-1", "persisted-1"]);
  });

  it("queues unicode-safe channel chunks with delivery diagnostics", async () => {
    const enqueue = vi.fn((input: Record<string, any>) => ({
      channelKey: input.channelKey,
      connectionId: input.connectionId,
      createdAt: "2026-05-15T00:00:00.000Z",
      deliveryDiagnostics: input.payload.deliveryDiagnostics,
      deliveryId: "delivery-chunked",
      deliveryStatus: "retrying",
      maxAttempts: 3,
      status: "queued",
      target: input.target,
      updatedAt: "2026-05-15T00:00:00.000Z",
    }));
    const { gateway } = createGatewayHarness({
      channelDeliveryRuntimeService: {
        drainDue: vi.fn(async () => []),
        enqueue,
        list: vi.fn(() => []),
      },
      storage: {
        integrationConnections: {
          get: vi.fn(() => ({ connectionId: "conn-1", key: "discord" })),
        },
      },
    });

    const message = `${"🙂".repeat(1_000)}tail`;
    const result = await GatewayService.prototype.commsSend.call(gateway, {
      connectionId: "conn-1",
      message,
      target: "channel-1",
    } as never);

    const queuedPayload = enqueue.mock.calls[0]?.[0].payload as Record<string, unknown>;
    expect(queuedPayload.messageParts).toHaveLength(2);
    expect((queuedPayload.messageParts as string[])[0]).toHaveLength(1_900);
    expect([...((queuedPayload.messageParts as string[])[0] ?? "")]).toHaveLength(950);
    expect(queuedPayload.deliveryDiagnostics).toMatchObject({
      chunking: {
        mode: "unicode_safe",
        maxPartUtf16Length: 1900,
        partCount: 2,
      },
    });
    expect(result).toMatchObject({
      deliveryId: "delivery-chunked",
      deliveryDiagnostics: expect.objectContaining({
        chunking: expect.objectContaining({ partCount: 2 }),
      }),
    });
  });

  it("reports an idempotent manual-reconciliation delivery replay as failed", async () => {
    const enqueue = vi.fn((input: Record<string, unknown>) => ({
      channelKey: input.channelKey,
      connectionId: input.connectionId,
      createdAt: "2026-05-15T00:00:00.000Z",
      deliveryId: "delivery-manual-replay",
      deliveryStatus: "manual_reconciliation_required",
      error: "The prior dispatch outcome is unknown.",
      idempotencyKey: input.idempotencyKey,
      maxAttempts: 3,
      status: "manual_reconciliation_required",
      target: input.target,
      updatedAt: "2026-05-15T00:01:00.000Z",
    }));
    const drainDue = vi.fn(async () => []);
    const { gateway } = createGatewayHarness({
      channelDeliveryRuntimeService: {
        drainDue,
        enqueue,
        list: vi.fn(() => []),
      },
      storage: {
        integrationConnections: {
          get: vi.fn(() => ({ connectionId: "conn-1", key: "slack" })),
        },
      },
    });

    await expect(
      GatewayService.prototype.commsSend.call(gateway, {
        connectionId: "conn-1",
        message: "Send this once.",
        target: "C123",
        taskId: "task-idempotent-replay",
      } as never),
    ).resolves.toMatchObject({
      deliveryId: "delivery-manual-replay",
      status: "failed",
      deliveryStatus: "manual_reconciliation_required",
      error: "The prior dispatch outcome is unknown.",
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: expect.stringContaining("task-idempotent-replay") }),
    );
  });

  it("sends chunked channel deliveries without duplicating attachments or interactive actions", async () => {
    const sentArgs: Array<Record<string, unknown>> = [];
    const invokeAndUnwrap = vi.fn(async (request: { args: Record<string, unknown> }) => {
      sentArgs.push(request.args);
      return {
        channelKey: "discord",
        createdAt: "2026-05-15T00:00:00.000Z",
        deliveryId: `part-${sentArgs.length}`,
        providerMessageId: `provider-${sentArgs.length}`,
        status: "sent",
        target: "channel-1",
        updatedAt: "2026-05-15T00:00:00.000Z",
      };
    });
    const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
    Object.assign(gateway, {
      buildCommsHost: vi.fn(() => ({
        emitChannelActivity: vi.fn(),
        emitDiscordTyping: vi.fn(),
        emitTelegramTyping: vi.fn(),
        getIntegrationConnection: vi.fn(() => ({ connectionId: "conn-1", key: "discord" })),
        invokeAndUnwrap,
        readChatAttachmentContent: vi.fn(),
      })),
    });
    const sendQueuedChannelDelivery = (
      GatewayService.prototype as unknown as {
        sendQueuedChannelDelivery(this: typeof gateway, input: Record<string, any>): Promise<Record<string, unknown>>;
      }
    ).sendQueuedChannelDelivery;

    const result = await sendQueuedChannelDelivery.call(gateway, {
      attempts: 1,
      channelKey: "discord",
      connectionId: "conn-1",
      createdAt: "2026-05-15T00:00:00.000Z",
      deliveryId: "delivery-1",
      maxAttempts: 3,
      payload: {
        attachments: [{ title: "Evidence", url: "https://example.test/evidence.txt" }],
        connectionId: "conn-1",
        deliveryDiagnostics: { chunking: { mode: "unicode_safe", partCount: 2 } },
        interactiveActions: {
          platform: "discord",
          buttons: [{ label: "Approve", callbackData: "approve:token" }],
        },
        message: "part one",
        messageParts: ["part one", "part two"],
        target: "channel-1",
      },
      status: "running",
      target: "channel-1",
      updatedAt: "2026-05-15T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      providerMessageId: "provider-2",
      deliveryDiagnostics: expect.objectContaining({ chunking: expect.objectContaining({ partCount: 2 }) }),
    });
    expect(sentArgs).toHaveLength(2);
    expect(sentArgs[0]).toMatchObject({
      message: "part one",
      attachments: [expect.objectContaining({ title: "Evidence" })],
      replyToPartIndex: 0,
    });
    expect(sentArgs[0]?.interactiveActions).toBeUndefined();
    expect(sentArgs[1]).toMatchObject({
      message: "part two",
      interactiveActions: expect.objectContaining({ platform: "discord" }),
      replyToMessageId: "provider-1",
      replyToPartIndex: 1,
    });
    expect(sentArgs[1]?.attachments).toBeUndefined();
  });

  it("sends runtime-planned delivery chunks when queued payloads use the deliveryChunks compatibility field", async () => {
    const sentArgs: Array<Record<string, unknown>> = [];
    const invokeAndUnwrap = vi.fn(async (request: { args: Record<string, unknown> }) => {
      sentArgs.push(request.args);
      return {
        channelKey: "discord",
        createdAt: "2026-05-15T00:00:00.000Z",
        deliveryId: `part-${sentArgs.length}`,
        providerMessageId: `provider-${sentArgs.length}`,
        status: "sent",
        target: "channel-1",
        updatedAt: "2026-05-15T00:00:00.000Z",
      };
    });
    const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
    Object.assign(gateway, {
      buildCommsHost: vi.fn(() => ({
        emitChannelActivity: vi.fn(),
        emitDiscordTyping: vi.fn(),
        getIntegrationConnection: vi.fn(() => ({ connectionId: "conn-1", key: "discord" })),
        invokeAndUnwrap,
        readChatAttachmentContent: vi.fn(),
      })),
    });
    const sendQueuedChannelDelivery = (
      GatewayService.prototype as unknown as {
        sendQueuedChannelDelivery(this: typeof gateway, input: Record<string, any>): Promise<Record<string, unknown>>;
      }
    ).sendQueuedChannelDelivery;

    await sendQueuedChannelDelivery.call(gateway, {
      attempts: 1,
      channelKey: "discord",
      connectionId: "conn-1",
      createdAt: "2026-05-15T00:00:00.000Z",
      deliveryId: "delivery-legacy-chunks",
      maxAttempts: 3,
      payload: {
        connectionId: "conn-1",
        deliveryChunks: ["part one", "part two"],
        message: "part one part two",
        target: "channel-1",
      },
      status: "running",
      target: "channel-1",
      updatedAt: "2026-05-15T00:00:00.000Z",
    });

    expect(sentArgs.map((args) => args.message)).toEqual(["part one", "part two"]);
  });

  it.each(["throws", "returns a blocked tool outcome"])(
    "marks a chunked partial delivery for manual reconciliation when the second chunk %s",
    async (failureMode) => {
      const invokeAndUnwrap = vi.fn(async () => {
        if (invokeAndUnwrap.mock.calls.length === 1) {
          return {
            channelKey: "discord",
            createdAt: "2026-05-15T00:00:00.000Z",
            deliveryId: "part-1",
            providerMessageId: "provider-1",
            status: "sent",
            target: "channel-1",
            updatedAt: "2026-05-15T00:00:00.000Z",
          };
        }
        if (failureMode === "throws") {
          throw new Error("second chunk transport failed");
        }
        return {
          auditEventId: "audit-second-chunk-blocked",
          outcome: "blocked",
          policyReason: "second chunk blocked by policy",
        };
      });
      const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
      Object.assign(gateway, {
        buildCommsHost: vi.fn(() => ({
          emitChannelActivity: vi.fn(),
          emitDiscordTyping: vi.fn(),
          getIntegrationConnection: vi.fn(() => ({ connectionId: "conn-1", key: "discord" })),
          invokeAndUnwrap,
          readChatAttachmentContent: vi.fn(),
        })),
      });
      const sendQueuedChannelDelivery = (
        GatewayService.prototype as unknown as {
          sendQueuedChannelDelivery(this: typeof gateway, input: Record<string, any>): Promise<Record<string, unknown>>;
        }
      ).sendQueuedChannelDelivery;

      const send = sendQueuedChannelDelivery.call(gateway, {
        attempts: 1,
        channelKey: "discord",
        connectionId: "conn-1",
        createdAt: "2026-05-15T00:00:00.000Z",
        deliveryId: `delivery-partial-${failureMode}`,
        maxAttempts: 3,
        payload: {
          connectionId: "conn-1",
          message: "part one",
          messageParts: ["part one", "part two"],
          target: "channel-1",
        },
        status: "running",
        target: "channel-1",
        updatedAt: "2026-05-15T00:00:00.000Z",
      });

      await expect(send).rejects.toMatchObject({
        message: expect.stringContaining("partial_channel_delivery_sent: 1 of 2"),
        deliveryStatus: "manual_reconciliation_required",
        providerMessageId: "provider-1",
      });
      expect(invokeAndUnwrap).toHaveBeenCalledTimes(2);
    },
  );

  it("reports every accepted chunk when the second chunk fails only during sent-state bookkeeping", async () => {
    const invokeAndUnwrap = vi.fn(async () =>
      invokeAndUnwrap.mock.calls.length === 1
        ? {
            channelKey: "discord",
            createdAt: "2026-05-15T00:00:00.000Z",
            deliveryId: "part-1",
            providerMessageId: "provider-1",
            status: "sent",
            target: "channel-1",
            updatedAt: "2026-05-15T00:00:00.000Z",
          }
        : {
            channelKey: "discord",
            createdAt: "2026-05-15T00:00:01.000Z",
            deliveryId: "part-2",
            deliveryStatus: "manual_reconciliation_required",
            error: "post_send_bookkeeping_failed: provider dispatch completed as provider-2, but finalization failed",
            providerMessageId: "provider-2",
            status: "failed",
            target: "channel-1",
            updatedAt: "2026-05-15T00:00:01.000Z",
          },
    );
    const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
    Object.assign(gateway, {
      buildCommsHost: vi.fn(() => ({
        emitChannelActivity: vi.fn(),
        emitDiscordTyping: vi.fn(),
        getIntegrationConnection: vi.fn(() => ({ connectionId: "conn-1", key: "discord" })),
        invokeAndUnwrap,
        readChatAttachmentContent: vi.fn(),
      })),
    });
    const sendQueuedChannelDelivery = (
      GatewayService.prototype as unknown as {
        sendQueuedChannelDelivery(this: typeof gateway, input: Record<string, any>): Promise<Record<string, unknown>>;
      }
    ).sendQueuedChannelDelivery;

    const send = sendQueuedChannelDelivery.call(gateway, {
      attempts: 1,
      channelKey: "discord",
      connectionId: "conn-1",
      createdAt: "2026-05-15T00:00:00.000Z",
      deliveryId: "delivery-partial-post-send-bookkeeping",
      maxAttempts: 3,
      payload: {
        connectionId: "conn-1",
        message: "part one",
        messageParts: ["part one", "part two"],
        target: "channel-1",
      },
      status: "running",
      target: "channel-1",
      updatedAt: "2026-05-15T00:00:00.000Z",
    });

    await expect(send).rejects.toMatchObject({
      message: expect.stringContaining("partial_channel_delivery_sent: 2 of 2"),
      deliveryStatus: "manual_reconciliation_required",
      providerMessageId: "provider-2",
    });
    expect(invokeAndUnwrap).toHaveBeenCalledTimes(2);
  });

  it("preserves manual-reconciliation status from a failed underlying channel send", async () => {
    const invokeAndUnwrap = vi.fn(async () => ({
      channelKey: "slack",
      createdAt: "2026-05-15T00:00:00.000Z",
      deliveryId: "provider-delivery-1",
      deliveryStatus: "manual_reconciliation_required",
      error: "provider timed out after dispatch",
      status: "failed",
      target: "C123",
      updatedAt: "2026-05-15T00:00:01.000Z",
    }));
    const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
    Object.assign(gateway, {
      buildCommsHost: vi.fn(() => ({
        emitChannelActivity: vi.fn(),
        emitDiscordTyping: vi.fn(),
        emitTelegramTyping: vi.fn(),
        getIntegrationConnection: vi.fn(() => ({ connectionId: "conn-1", key: "slack" })),
        invokeAndUnwrap,
        readChatAttachmentContent: vi.fn(),
      })),
    });
    const sendQueuedChannelDelivery = (
      GatewayService.prototype as unknown as {
        sendQueuedChannelDelivery(this: typeof gateway, input: Record<string, any>): Promise<Record<string, unknown>>;
      }
    ).sendQueuedChannelDelivery;

    await expect(
      sendQueuedChannelDelivery.call(gateway, {
        attempts: 1,
        channelKey: "slack",
        connectionId: "conn-1",
        createdAt: "2026-05-15T00:00:00.000Z",
        deliveryId: "delivery-1",
        maxAttempts: 3,
        payload: {
          connectionId: "conn-1",
          message: "hello",
          target: "C123",
        },
        status: "running",
        target: "C123",
        updatedAt: "2026-05-15T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      message: "provider timed out after dispatch",
      deliveryStatus: "manual_reconciliation_required",
    });
    expect(invokeAndUnwrap).toHaveBeenCalledTimes(1);
  });

  it("rejects a failed tool outcome instead of accepting the durable delivery as sent", async () => {
    const invokeAndUnwrap = vi.fn(async () => ({
      auditEventId: "audit-failed-send-1",
      outcome: "failed",
      policyReason: "execution error: synthetic channel tool failure",
    }));
    const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
    Object.assign(gateway, {
      buildCommsHost: vi.fn(() => ({
        emitChannelActivity: vi.fn(),
        emitDiscordTyping: vi.fn(),
        emitTelegramTyping: vi.fn(),
        getIntegrationConnection: vi.fn(() => ({ connectionId: "conn-1", key: "slack" })),
        invokeAndUnwrap,
        readChatAttachmentContent: vi.fn(),
      })),
    });
    const sendQueuedChannelDelivery = (
      GatewayService.prototype as unknown as {
        sendQueuedChannelDelivery(this: typeof gateway, input: Record<string, any>): Promise<Record<string, unknown>>;
      }
    ).sendQueuedChannelDelivery;

    await expect(
      sendQueuedChannelDelivery.call(gateway, {
        attempts: 1,
        channelKey: "slack",
        connectionId: "conn-1",
        createdAt: "2026-05-15T00:00:00.000Z",
        deliveryId: "delivery-tool-failed",
        maxAttempts: 3,
        payload: {
          connectionId: "conn-1",
          message: "must not be marked sent",
          target: "C123",
        },
        status: "running",
        target: "C123",
        updatedAt: "2026-05-15T00:00:00.000Z",
      }),
    ).rejects.toThrow("execution error: synthetic channel tool failure");
    expect(invokeAndUnwrap).toHaveBeenCalledTimes(1);
  });

  it("creates internal tool grants, respects deny-wins, and reports failed tool payloads precisely", async () => {
    const createdGrant = vi.fn();
    const publishRealtime = vi.fn();
    const { gateway } = createGatewayHarness({
      listToolGrants: vi.fn((scope: string) =>
        scope === "global"
          ? []
          : [
              {
                decision: "allow",
                expiresAt: "2099-05-15T00:05:00.000Z",
                grantId: "existing",
                grantType: "persistent",
                scope: "session",
                scopeRef: "other",
                toolPattern: "shell.exec",
              },
            ],
      ),
      invokeTool: vi.fn(async () => ({ outcome: "executed", result: undefined })),
      policyEngine: { createGrant: createdGrant },
      publishRealtime,
    });

    GatewayService.prototype.ensureSessionInternalToolGrant.call(gateway, "session-1", "browser.search", "runtime");
    expect(createdGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        toolPattern: "browser.search",
        decision: "allow",
        scope: "session",
        scopeRef: "session-1",
        grantType: "ttl",
      }),
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "tools",
      expect.objectContaining({ type: "internal_tool_grant_created", toolName: "browser.search" }),
    );

    gateway.listToolGrants = vi.fn((scope: string) =>
      scope === "global"
        ? [
            {
              decision: "deny",
              expiresAt: "2099-05-15T00:05:00.000Z",
              grantType: "persistent",
              toolPattern: "browser.*",
            },
          ]
        : [],
    );
    expect(() =>
      GatewayService.prototype.ensureSessionInternalToolGrant.call(gateway, "session-1", "browser.search", "runtime"),
    ).toThrow("deny policy");
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "tools",
      expect.objectContaining({ type: "internal_tool_grant_blocked", reason: "deny-wins" }),
    );

    gateway.listToolGrants = vi.fn((scope: string) =>
      scope === "workspace"
        ? [
            {
              decision: "deny",
              expiresAt: "2099-05-15T00:05:00.000Z",
              grantType: "persistent",
              toolPattern: "*",
            },
          ]
        : [],
    );
    createdGrant.mockClear();
    GatewayService.prototype.ensureChatSessionRuntimeGrants.call(gateway, "session-1");
    expect(createdGrant).not.toHaveBeenCalled();
    expect(() =>
      GatewayService.prototype.ensureSessionInternalToolGrant.call(gateway, "session-1", "browser.search", "runtime"),
    ).toThrow("deny policy");

    await expect(
      GatewayService.prototype.invokeAndUnwrap.call(
        gateway,
        { toolName: "browser.search", sessionId: "session-1" },
        "tool_done",
      ),
    ).resolves.toEqual({});

    expect(() =>
      GatewayService.prototype.requireExecutedToolResult.call(gateway, "slack.send", {
        deliveryStatus: "failed",
        error: "provider down",
        status: "failed",
      }),
    ).toThrow("slack.send failed: provider down");
    expect(() =>
      GatewayService.prototype.requireExecutedToolResult.call(gateway, "browser.search", {
        outcome: "blocked",
        policyReason: "approval required",
      }),
    ).toThrow("browser.search failed: approval required");
  });

  it("publishes approval and orchestration background failures without leaking pending tasks", async () => {
    const approval = { approvalId: "approval-1", linkage: { runId: "run-1" } };
    const publishRealtime = vi.fn();
    const { gateway } = createGatewayHarness({
      approvalExplainer: {
        explainApproval: vi.fn(async () => {
          throw new Error("explain failed");
        }),
      },
      approvalWaitRunService: {
        buildApprovalRealtimeLinks: vi.fn(() => ({ approvalId: "approval-1" })),
      },
      backgroundTasks: new Set<Promise<unknown>>(),
      memoryLifecycleService: {
        composeContext: vi.fn(async () => {
          throw new Error("memory failed");
        }),
      },
      publishRealtime,
    });

    GatewayService.prototype.scheduleApprovalExplanation.call(gateway, approval as never);
    await Promise.allSettled([...gateway.backgroundTasks]);
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "approvals",
      expect.objectContaining({
        type: "approval_explainer_error",
        approvalId: "approval-1",
        error: "explain failed",
      }),
      expect.objectContaining({ eventAuthority: "retained_stream" }),
    );
    expect(gateway.backgroundTasks.size).toBe(0);

    GatewayService.prototype.scheduleOrchestrationMemoryContext.call(
      gateway,
      {
        goal: "Ship",
        waves: [
          {
            waveId: "wave-1",
            phases: [
              {
                loopMode: "single_pass",
                ownerAgentId: "qa",
                phaseId: "phase-1",
                specPath: "phase.md",
              },
            ],
          },
        ],
      } as never,
      { currentPhaseId: "phase-1", currentWaveId: "wave-1", runId: "run-1" } as never,
    );
    await Promise.allSettled([...gateway.backgroundTasks]);
    expect(publishRealtime).toHaveBeenCalledWith(
      "memory_qmd_failed",
      "orchestration",
      expect.objectContaining({ runId: "run-1", phaseId: "phase-1", error: "memory failed" }),
      expect.objectContaining({ links: { runId: "run-1" } }),
    );
    expect(gateway.backgroundTasks.size).toBe(0);
  });

  it("resolves workspace/session routing and chat session truth from storage fallbacks", async () => {
    const { gateway } = createGatewayHarness();
    const chatSession = GatewayService.prototype.requireChatSession.call(gateway, "session-1");
    expect(chatSession).toMatchObject({
      sessionId: "session-1",
      workspaceId: "workspace-a",
      projectId: "project-1",
      mode: "cowork",
    });

    expect(GatewayService.prototype.resolveMemoryWorkspaceRelativeDir.call(gateway, undefined, "session-1")).toBe(
      "workspaces/workspace-a/memory",
    );
    expect(
      GatewayService.prototype.resolveChatCompletionHookWorkspaceId.call(gateway, {
        memory: { sessionId: "session-1" },
      } as never),
    ).toBe("workspace-a");
    expect(GatewayService.prototype.resolveApprovalHookWorkspaceId.call(gateway, { sessionId: "session-1" })).toBe(
      "workspace-a",
    );
    expect(GatewayService.prototype.isReplayScratchSession.call(gateway, "session-1")).toBe(true);
    expect(
      GatewayService.prototype.routeFromSession.call(gateway, {
        account: "acct",
        channel: "slack",
        kind: "thread",
        sessionKey: "slack:acct:room-1:thread-1",
      } as never),
    ).toEqual({ account: "acct", channel: "slack", room: "room-1", threadId: "thread-1" });

    gateway.storage.transcripts.read = vi.fn(async () => [
      {
        actorId: "operator",
        actorType: "user",
        eventId: "message-user",
        payload: {
          message: { content: "hello", role: "user" },
        },
        sessionId: "session-1",
        timestamp: "2026-05-15T00:00:00.000Z",
        type: "message.user",
      },
    ]);
    await (GatewayService.prototype as any).ensureChatMessageProjection.call(gateway, "session-1");
    expect(gateway.storage.chatMessages.upsertMany).toHaveBeenCalledWith([
      expect.objectContaining({ messageId: "message-user", role: "user" }),
    ]);
    await (GatewayService.prototype as any).ensureChatMessageProjection.call(gateway, "session-1");
    expect(gateway.storage.chatMessages.upsertMany).toHaveBeenCalledTimes(1);
  });
});
