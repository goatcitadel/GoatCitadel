import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import { GatewayService } from "./gateway-service.js";

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
      quality: { reason: "fresh", status: "ready" },
      scope: "workspace",
    };

    GatewayService.prototype.persistContextManifestForCompletionRequest.call(gateway, {
      memoryContext,
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
      GatewayService.prototype.consumeRemoteActionToken.call(gateway, " raw-token ", "approval.resolve"),
    ).toMatchObject({
      tokenId: "token-1",
      state: "consumed",
      consumedBy: "connector:conn-1",
    });
    expect(
      GatewayService.prototype.consumeRemoteActionTokenById.call(gateway, " token-2 ", "approval.resolve"),
    ).toMatchObject({
      tokenId: "token-2",
      state: "consumed",
      consumedBy: "connector:conn-1",
    });

    gateway.storage.remoteActionTokens.get = vi.fn(() => ({
      ...pending,
      expiresAt: "2026-05-14T23:59:00.000Z",
      tokenId: "expired-token",
    }));
    expect(() =>
      GatewayService.prototype.consumeRemoteActionTokenById.call(gateway, "expired-token", "approval.resolve"),
    ).toThrow("expired");
    expect(gateway.storage.remoteActionTokens.updateState).toHaveBeenCalledWith("expired-token", "expired");
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

    expect(GatewayService.prototype.readMcpServers.call(gateway)).toMatchObject([
      expect.objectContaining({
        serverId: "server-1",
        category: "automation",
        trustTier: "restricted",
        costTier: "unknown",
      }),
    ]);
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
