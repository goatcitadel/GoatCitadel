import { describe, expect, it, vi } from "vitest";
import type {
  ChannelTypingResult,
  DiscordPairingRecord,
  DiscordRuntimeStatus,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { GatewayService } from "./gateway-service.js";
import { createIntegrationChannelServiceForGateway } from "./gateway-route-service-composition.js";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

function createDiscordConnection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    connectionId: "11111111-1111-1111-1111-111111111111",
    catalogId: "channel.discord",
    kind: "channel",
    key: "discord",
    label: "Discord Primary",
    enabled: true,
    status: "connected",
    config: {
      runtimeMode: "gateway",
      botTokenEnv: "DISCORD_BOT_TOKEN",
      defaultChannelId: "channel_1",
      inboundDmPolicy: "pairing",
      guildPolicy: "allowlist",
    },
    createdAt: "2026-03-31T00:00:00.000Z",
    updatedAt: "2026-03-31T00:00:00.000Z",
    ...overrides,
  };
}

function createGatewayHarness() {
  const settings = new Map<string, unknown>();
  const gateway = Object.create(GatewayService.prototype) as any;
  gateway.storage = {
    gatewaySql: {
      prepare: vi.fn(() => ({
        run: vi.fn(),
      })),
    },
    sessions: {
      upsert: vi.fn(),
    },
    chatSessionMeta: {
      ensure: vi.fn(),
    },
    chatSessionPrefs: {
      ensure: vi.fn(),
    },
    chatSessionBindings: {
      upsert: vi.fn(),
    },
    chatSessionProjects: {
      get: vi.fn(() => undefined),
    },
    integrationConnections: {
      get: vi.fn(),
    },
    systemSettings: {
      get: vi.fn((key: string) => (settings.has(key) ? { value: settings.get(key) } : undefined)),
      set: vi.fn((key: string, value: unknown) => {
        settings.set(key, value);
      }),
    },
  };
  gateway.operatorSummaryCache = {
    invalidate: vi.fn(),
  };
  gateway.config = {
    toolPolicy: {
      tools: {
        profile: "minimal",
      },
      sandbox: {
        networkAllowlist: [],
      },
    },
  };
  gateway.discordRuntimeService = {
    getConnectionStatus: vi.fn(),
    reconnectConnection: vi.fn(),
    sendTyping: vi.fn(),
  };
  gateway.publishRealtime = vi.fn();
  gateway.requireFeatureEnabled = vi.fn();
  gateway.fetchWithDiagnosticsTimeout = vi.fn();
  gateway.ensureChatSessionRuntimeGrants = vi.fn();
  gateway.getChatSessionPrefs = vi.fn((sessionId: string) => ({
    sessionId,
    mode: "chat",
    planningMode: "off",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    orchestrationEnabled: true,
    orchestrationIntensity: "balanced",
    orchestrationVisibility: "summarized",
    orchestrationProviderPreference: "balanced",
    orchestrationReviewDepth: "standard",
    orchestrationParallelism: "auto",
    codeAutoApply: "aggressive_auto",
    createdAt: "2026-03-31T00:00:00.000Z",
    updatedAt: "2026-03-31T00:00:00.000Z",
  }));
  gateway.updateChatSessionPrefs = vi.fn();
  gateway.assignChatSessionProject = vi.fn();
  return { gateway, settings };
}

function createPairing(overrides: Partial<DiscordPairingRecord> = {}): DiscordPairingRecord {
  return {
    pairingId: "pairing-1",
    connectionId: "11111111-1111-1111-1111-111111111111",
    userId: "user-1",
    code: "PAIR12",
    status: "pending",
    createdAt: "2026-03-31T00:00:00.000Z",
    updatedAt: "2026-03-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("GatewayService Discord parity seams", () => {
  it("routes commsTyping through the Discord runtime adapter", async () => {
    const { gateway } = createGatewayHarness();
    const connection = createDiscordConnection();
    const result: ChannelTypingResult = {
      channelKey: "discord",
      connectionId: connection.connectionId,
      target: "channel_1",
      supported: true,
      status: "sent",
    };
    gateway.storage.integrationConnections.get.mockReturnValue(connection);
    gateway.discordRuntimeService.sendTyping.mockResolvedValue(result);

    const typing = await gateway.commsTyping({
      connectionId: connection.connectionId,
      target: "channel_1",
      durationMs: 3_000,
    });

    expect(gateway.storage.integrationConnections.get).toHaveBeenCalledWith(connection.connectionId);
    expect(gateway.discordRuntimeService.sendTyping).toHaveBeenCalledWith(
      connection.connectionId,
      "channel_1",
      3_000,
      undefined,
    );
    expect(typing).toEqual(result);
  });

  it("merges Discord runtime metadata into channel runtime status without advertising presence as an action", () => {
    const { gateway } = createGatewayHarness();
    const connection = createDiscordConnection({
      lastSyncAt: "2026-03-31T00:05:00.000Z",
    });
    const runtime: DiscordRuntimeStatus = {
      connectionId: connection.connectionId,
      runtimeMode: "gateway",
      enabled: true,
      ready: true,
      connectedBotId: "bot-1",
      connectedBotTag: "GoatBot#1234",
      guildIds: ["guild-1"],
      lastReadyAt: "2026-03-31T00:06:00.000Z",
      lastInboundAt: "2026-03-31T00:07:00.000Z",
      lastReconnectAt: "2026-03-31T00:08:00.000Z",
    };
    gateway.storage.integrationConnections.get.mockReturnValue(connection);
    gateway.discordRuntimeService.getConnectionStatus.mockReturnValue(runtime);
    const integrationChannel = createIntegrationChannelServiceForGateway(gateway);

    const status = integrationChannel.getIntegrationConnectionChannelRuntimeStatus(connection.connectionId);

    expect(status.ready).toBe(true);
    expect(status.runtimePolicy).toMatchObject({
      pairing: true,
      allowlist: true,
      mentionGating: true,
      typing: true,
      presence: true,
    });
    expect(status.metadata).toMatchObject({
      connectedBotId: "bot-1",
      connectedBotTag: "GoatBot#1234",
      guildIds: ["guild-1"],
      runtimeMode: "gateway",
    });
    expect(status.lastReadyAt).toBe("2026-03-31T00:06:00.000Z");
    expect(status.lastInboundAt).toBe("2026-03-31T00:07:00.000Z");
    expect(
      integrationChannel.getIntegrationConnectionChannelCapabilities(connection.connectionId).supportedActions,
    ).not.toContain("channel.presence");
  });

  it("lists, approves, and revokes Discord pairings through the service layer", () => {
    const { gateway, settings } = createGatewayHarness();
    const connection = createDiscordConnection();
    const approvedExisting = createPairing({
      pairingId: "pairing-old",
      status: "approved",
      approvedAt: "2026-03-31T00:01:00.000Z",
      userId: "user-1",
    });
    const pending = createPairing({
      pairingId: "pairing-new",
      status: "pending",
      userId: "user-1",
      updatedAt: "2026-03-31T00:02:00.000Z",
    });
    settings.set("discord_pairings_v1", [approvedExisting, pending]);
    gateway.storage.integrationConnections.get.mockReturnValue(connection);
    gateway.discordRuntimeService.getConnectionStatus.mockReturnValue(undefined);
    const integrationChannel = createIntegrationChannelServiceForGateway(gateway);

    const listed = integrationChannel.listDiscordPairings(connection.connectionId);
    expect((listed.items as DiscordPairingRecord[]).map((item: DiscordPairingRecord) => item.pairingId)).toEqual([
      "pairing-new",
      "pairing-old",
    ]);

    const approved = integrationChannel.approveDiscordPairing(connection.connectionId, "pairing-new");
    expect(approved.status).toBe("approved");
    const storedAfterApprove = settings.get("discord_pairings_v1") as DiscordPairingRecord[];
    expect(storedAfterApprove.find((item) => item.pairingId === "pairing-new")?.status).toBe("approved");
    expect(storedAfterApprove.find((item) => item.pairingId === "pairing-old")?.status).toBe("revoked");

    const revoked = integrationChannel.revokeDiscordPairing(connection.connectionId, "pairing-new");
    expect(revoked.status).toBe("revoked");
    const storedAfterRevoke = settings.get("discord_pairings_v1") as DiscordPairingRecord[];
    expect(storedAfterRevoke.find((item) => item.pairingId === "pairing-new")?.status).toBe("revoked");
  });

  it("persists a Discord route session and rewrites future inbound thread ids onto that logical session", () => {
    const { gateway, settings } = createGatewayHarness();
    let ensureCalls = 0;
    gateway.requireChatSession = vi.fn((sessionId: string) => ({ sessionId }));
    gateway.updateChatSession = vi.fn();
    gateway.storage.sessions.upsert.mockImplementation(({ sessionId: _sessionId }: { sessionId: string }) => {
      ensureCalls += 1;
      if (ensureCalls === 1) {
        return { sessionId: "session-source" };
      }
      return { sessionId: "session-new" };
    });

    const created = gateway.startNewDiscordRouteSession({
      connectionId: "11111111-1111-1111-1111-111111111111",
      target: "dm_1",
      displayName: "Goat User",
      threadId: "thread_1",
      title: "Fresh Discord Session",
    });

    expect(created).toMatchObject({ sessionId: expect.any(String) });
    const storedRoutes = settings.get("discord_route_sessions_v1") as Array<Record<string, string>>;
    expect(storedRoutes).toHaveLength(1);
    expect(storedRoutes[0]?.sessionId).toBe(created.sessionId);
    expect(storedRoutes[0]?.logicalSessionKey).toHaveLength(12);
    expect(gateway.updateChatSessionPrefs).toHaveBeenCalledWith(
      created.sessionId,
      expect.objectContaining({
        mode: "chat",
        planningMode: "off",
      }),
    );
    expect(gateway.updateChatSession).toHaveBeenCalledWith(created.sessionId, { title: "Fresh Discord Session" });

    const resolved = gateway.resolveDiscordInboundRoute({
      connectionId: "11111111-1111-1111-1111-111111111111",
      target: "dm_1",
      room: "dm_1",
      threadId: "thread_1",
    });
    expect(resolved).toEqual({
      room: "dm_1",
      threadId: `discord_thread_1_${storedRoutes[0]?.logicalSessionKey}`,
    });
  });
});
