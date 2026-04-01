import { describe, expect, it, vi } from "vitest";
import type {
  ChannelTypingResult,
  DiscordPairingRecord,
  DiscordRuntimeStatus,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { GatewayService } from "./gateway-service.js";

vi.mock("sqlite", () => ({}));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

function createDiscordConnection(
  overrides: Partial<IntegrationConnection> = {},
): IntegrationConnection {
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
    integrationConnections: {
      get: vi.fn(),
    },
    systemSettings: {
      get: vi.fn((key: string) => settings.has(key) ? { value: settings.get(key) } : undefined),
      set: vi.fn((key: string, value: unknown) => {
        settings.set(key, value);
      }),
    },
  };
  return { gateway, settings };
}

function createPairing(
  overrides: Partial<DiscordPairingRecord> = {},
): DiscordPairingRecord {
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
    gateway.getIntegrationConnection = vi.fn(() => connection);
    gateway.emitDiscordTyping = vi.fn(async () => result);

    const typing = await gateway.commsTyping({
      connectionId: connection.connectionId,
      target: "channel_1",
      durationMs: 3_000,
    });

    expect(gateway.getIntegrationConnection).toHaveBeenCalledWith(connection.connectionId);
    expect(gateway.emitDiscordTyping).toHaveBeenCalledWith(connection, expect.objectContaining({
      connectionId: connection.connectionId,
      target: "channel_1",
      durationMs: 3_000,
    }));
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
    gateway.getDiscordRuntimeStatus = vi.fn(() => runtime);

    const status = gateway.getIntegrationConnectionChannelRuntimeStatus(connection.connectionId);

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
    expect(gateway.getIntegrationConnectionChannelCapabilities(connection.connectionId).supportedActions)
      .not.toContain("channel.presence");
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
    gateway.getIntegrationConnection = vi.fn(() => connection);
    gateway.getDiscordRuntimeStatus = vi.fn(() => undefined);

    const listed = gateway.listDiscordPairings(connection.connectionId);
    expect((listed.items as DiscordPairingRecord[]).map((item: DiscordPairingRecord) => item.pairingId))
      .toEqual(["pairing-new", "pairing-old"]);

    const approved = gateway.approveDiscordPairing(connection.connectionId, "pairing-new");
    expect(approved.status).toBe("approved");
    const storedAfterApprove = settings.get("discord_pairings_v1") as DiscordPairingRecord[];
    expect(storedAfterApprove.find((item) => item.pairingId === "pairing-new")?.status).toBe("approved");
    expect(storedAfterApprove.find((item) => item.pairingId === "pairing-old")?.status).toBe("revoked");

    const revoked = gateway.revokeDiscordPairing(connection.connectionId, "pairing-new");
    expect(revoked.status).toBe("revoked");
    const storedAfterRevoke = settings.get("discord_pairings_v1") as DiscordPairingRecord[];
    expect(storedAfterRevoke.find((item) => item.pairingId === "pairing-new")?.status).toBe("revoked");
  });

  it("persists a Discord route session and rewrites future inbound thread ids onto that logical session", () => {
    const { gateway, settings } = createGatewayHarness();
    const ensureDiscordChatSession = vi.fn()
      .mockReturnValueOnce({ sessionId: "session-source" })
      .mockReturnValueOnce({ sessionId: "session-new" });
    gateway.ensureDiscordChatSession = ensureDiscordChatSession;
    gateway.cloneChatSessionContext = vi.fn();
    gateway.updateChatSession = vi.fn();
    gateway.requireChatSession = vi.fn((sessionId: string) => ({ sessionId }));

    const created = gateway.startNewDiscordRouteSession({
      connectionId: "11111111-1111-1111-1111-111111111111",
      target: "dm_1",
      displayName: "Goat User",
      threadId: "thread_1",
      title: "Fresh Discord Session",
    });

    expect(created).toEqual({ sessionId: "session-new" });
    const storedRoutes = settings.get("discord_route_sessions_v1") as Array<Record<string, string>>;
    expect(storedRoutes).toHaveLength(1);
    expect(storedRoutes[0]?.sessionId).toBe("session-new");
    expect(storedRoutes[0]?.logicalSessionKey).toHaveLength(12);
    expect(gateway.cloneChatSessionContext).toHaveBeenCalledWith("session-source", "session-new");
    expect(gateway.updateChatSession).toHaveBeenCalledWith("session-new", { title: "Fresh Discord Session" });

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
