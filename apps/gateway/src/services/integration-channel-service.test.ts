import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  NotFoundError,
  evaluateChannelInboundAccess,
  type DiscordPairingRecord,
  type IntegrationConnection,
} from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { ChannelSecretCustodyService } from "./channel-secret-custody-service.js";
import {
  collectConnectionSecretRefs,
  createIntegrationConnection,
  deleteIntegrationConnection,
  getIntegrationConnectionChannelRuntimeStatus,
  updateIntegrationConnection,
  type IntegrationChannelPort,
} from "./integration-channel-service.js";

function createDeps(): IntegrationChannelPort {
  const connections = new Map<string, IntegrationConnection>();
  let sequence = 0;
  return {
    storage: {
      integrationConnections: {
        list: vi.fn(() => [...connections.values()]),
        get: vi.fn((connectionId: string) => {
          const connection = connections.get(connectionId);
          if (!connection) {
            throw new Error(`Unknown integration connection: ${connectionId}`);
          }
          return connection;
        }),
        create: vi.fn((input) => {
          const now = "2026-06-18T00:00:00.000Z";
          const connection: IntegrationConnection = {
            revision: "a".repeat(64),
            connectionId: `11111111-1111-1111-1111-${String(++sequence).padStart(12, "0")}`,
            catalogId: input.catalogId,
            kind: input.kind,
            key: input.key,
            label: input.label,
            enabled: input.enabled ?? true,
            status: input.status ?? "connected",
            config: input.config ?? {},
            pluginId: input.pluginId,
            createdAt: now,
            updatedAt: now,
          };
          connections.set(connection.connectionId, connection);
          return connection;
        }),
        update: vi.fn((connectionId: string, input) => {
          const current = connections.get(connectionId);
          if (!current) {
            throw new Error(`Unknown integration connection: ${connectionId}`);
          }
          const updated: IntegrationConnection = {
            ...current,
            ...input,
            config: input.config ?? current.config,
            updatedAt: "2026-06-18T00:00:01.000Z",
          };
          connections.set(connectionId, updated);
          return updated;
        }),
        delete: vi.fn((connectionId: string) => connections.delete(connectionId)),
      },
    },
    publishRealtime: vi.fn(),
    requireFeatureEnabled: vi.fn(),
    isFeatureEnabled: vi.fn(() => true),
    buildIntegrationConnectionChecks: vi.fn(() => []),
    runIntegrationConnectionLiveChecks: vi.fn(async () => ({ checks: [] })),
    pickConnectorDiagnosticAction: vi.fn(),
    recordConnectorHealthRun: vi.fn(),
    syncChannelRuntimes: vi.fn(async () => undefined),
    getDiscordRuntimeStatus: vi.fn(),
    getChannelStreamRuntimeStatus: vi.fn(),
    getIntegrationConnection: (connectionId: string) =>
      connections.get(connectionId) ??
      (() => {
        throw new Error(`Unknown integration connection: ${connectionId}`);
      })(),
    assertDiscordConnection: vi.fn(),
    readDiscordPairings: vi.fn(() => []),
    writeDiscordPairings: vi.fn(),
    discordRuntimeService: {
      reconnectConnection: vi.fn(async () => undefined),
      sendTyping: vi.fn(async () => ({
        channelKey: "discord",
        connectionId: "connection-1",
        target: "target",
        supported: false,
        status: "unsupported",
        reason: "test",
      })),
    },
    resolveConnectionSecret: vi.fn(),
    readConnectionConfigValue: vi.fn((config: Record<string, unknown>, key: string) => {
      const value = config[key];
      return typeof value === "string" ? value : undefined;
    }),
    isConnectionUrlAllowlisted: vi.fn(() => true),
    fetchWithDiagnosticsTimeout: vi.fn(async () => new Response("{}")),
  };
}

describe("integration-channel-service inbound access defaults", () => {
  it("keeps repository and runtime connection configs raw for secret resolution", async () => {
    const deps = createDeps();

    const connection = await createIntegrationConnection(deps, {
      catalogId: "channel.slack",
      label: "Slack",
      config: {
        botToken: "bot-short",
        webhookUrl: "https://hooks.example.test/events?token=hook-short",
        botTokenEnv: "SLACK_BOT_TOKEN",
      },
    });

    expect(connection.config).toMatchObject({
      botToken: "bot-short",
      webhookUrl: "https://hooks.example.test/events?token=hook-short",
      botTokenEnv: "SLACK_BOT_TOKEN",
    });
    expect((await deps.storage.integrationConnections.get(connection.connectionId)).config).toMatchObject({
      botToken: "bot-short",
      webhookUrl: "https://hooks.example.test/events?token=hook-short",
      botTokenEnv: "SLACK_BOT_TOKEN",
    });
  });

  it("creates a Google Chat connection with no plugin id", async () => {
    const deps = createDeps();

    const connection = await createIntegrationConnection(deps, {
      catalogId: "channel.google-chat",
      label: "Google Chat",
      config: { webhookUrlEnv: "GOOGLE_CHAT_WEBHOOK_URL" },
    });

    const created = vi.mocked(deps.storage.integrationConnections.create).mock.calls[0]?.[0];
    expect(created).toMatchObject({ catalogId: "channel.google-chat", key: "google-chat" });
    expect(created).not.toHaveProperty("pluginId");
    expect(connection.pluginId).toBeUndefined();
  });

  it("defaults new generic webhook channel connections to allowlist mode", async () => {
    const deps = createDeps();

    const connection = await createIntegrationConnection(deps, {
      catalogId: "channel.slack",
      label: "Slack",
      config: {
        botTokenEnv: "SLACK_BOT_TOKEN",
        signingSecretEnv: "SLACK_SIGNING_SECRET",
      },
    });

    expect(connection.config).toMatchObject({
      botTokenEnv: "SLACK_BOT_TOKEN",
      signingSecretEnv: "SLACK_SIGNING_SECRET",
      inboundAccessMode: "allowlist",
    });
  });

  it("preserves explicit legacy-open mode when an operator chooses it", async () => {
    const deps = createDeps();

    const connection = await createIntegrationConnection(deps, {
      catalogId: "channel.line",
      label: "LINE",
      config: {
        channelSecretEnv: "LINE_CHANNEL_SECRET",
        inboundAccessMode: "open_legacy",
      },
    });

    expect(connection.config.inboundAccessMode).toBe("open_legacy");
  });

  it("defaults new Telegram and Discord connections to allowlist (deny unknown senders)", async () => {
    const deps = createDeps();

    const telegram = await createIntegrationConnection(deps, {
      catalogId: "channel.telegram",
      label: "Telegram",
      config: {
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
        webhookSecretEnv: "TELEGRAM_WEBHOOK_SECRET",
      },
    });
    const discord = await createIntegrationConnection(deps, {
      catalogId: "channel.discord",
      label: "Discord",
      config: {
        runtimeMode: "gateway",
        botTokenEnv: "DISCORD_BOT_TOKEN",
      },
    });

    expect(telegram.config.inboundAccessMode).toBe("allowlist");
    expect(discord.config.inboundAccessMode).toBe("allowlist");

    // Default-safe: an unknown sender is denied until explicitly allowlisted.
    expect(evaluateChannelInboundAccess({ config: telegram.config, actorId: "tg-stranger" })).toMatchObject({
      allowed: false,
      mode: "allowlist",
      reason: "allowlist_empty",
    });
    expect(evaluateChannelInboundAccess({ config: discord.config, actorId: "dc-stranger" })).toMatchObject({
      allowed: false,
      mode: "allowlist",
      reason: "allowlist_empty",
    });
  });

  it("keeps local channels open (tui) while ntfy defaults to allowlist", async () => {
    const deps = createDeps();

    const tui = await createIntegrationConnection(deps, {
      catalogId: "channel.tui",
      label: "Terminal",
      config: {},
    });
    const ntfy = await createIntegrationConnection(deps, {
      catalogId: "channel.ntfy",
      label: "ntfy",
      config: {
        baseUrl: "https://ntfy.sh",
        topic: "goatcitadel-ops",
      },
    });

    expect(tui.config.inboundAccessMode).toBeUndefined();
    expect(ntfy.config.inboundAccessMode).toBe("allowlist");
  });

  it("stamps a non-guided stream-enabled ntfy connection as allowlist, denying unknown topic senders", async () => {
    const deps = createDeps();
    const ntfy = await createIntegrationConnection(deps, {
      catalogId: "channel.ntfy",
      label: "ntfy",
      config: {
        baseUrl: "https://ntfy.sh",
        topic: "goatcitadel-ops",
        tokenEnv: "NTFY_TOKEN",
        inboundStreamEnabled: true,
      },
    });

    expect(ntfy.config.inboundAccessMode).toBe("allowlist");
    expect(evaluateChannelInboundAccess({ config: ntfy.config, actorId: "ntfy-topic:goatcitadel-ops" }).allowed).toBe(
      false,
    );
  });

  it("lets an operator pick an explicit open ('allow all') posture for an inbound channel", async () => {
    const deps = createDeps();

    const discord = await createIntegrationConnection(deps, {
      catalogId: "channel.discord",
      label: "Discord",
      config: {
        runtimeMode: "gateway",
        botTokenEnv: "DISCORD_BOT_TOKEN",
        inboundAccessMode: "open_legacy",
      },
    });

    expect(discord.config.inboundAccessMode).toBe("open_legacy");
    expect(evaluateChannelInboundAccess({ config: discord.config, actorId: "anyone" })).toMatchObject({
      allowed: true,
      mode: "open_legacy",
      reason: "legacy_open_explicit",
    });
  });

  it("does not retroactively lock out a legacy connection persisted without a mode", async () => {
    const deps = createDeps();

    // Simulate a pre-existing connection that predates default-safe inbound
    // access: no inboundAccessMode was ever stamped on it.
    const legacy = await deps.storage.integrationConnections.create({
      catalogId: "channel.slack",
      kind: "channel",
      key: "slack",
      label: "Legacy Slack",
      config: { botTokenEnv: "SLACK_BOT_TOKEN" },
    });
    expect(legacy.config.inboundAccessMode).toBeUndefined();

    // Replacing its config (without choosing a mode) must NOT silently flip it
    // to a denying allowlist — it stays legacy-open with a migration warning.
    const updated = await updateIntegrationConnection(deps, legacy.connectionId, {
      config: { botTokenEnv: "SLACK_BOT_TOKEN_V2" },
    });
    expect(updated.config.inboundAccessMode).toBeUndefined();
    expect(evaluateChannelInboundAccess({ config: updated.config, actorId: "anyone" })).toMatchObject({
      allowed: true,
      mode: "open_legacy",
      reason: "legacy_open_unset",
    });
  });

  it("preserves an existing inbound access mode when replacing connection config", async () => {
    const deps = createDeps();
    const connection = await createIntegrationConnection(deps, {
      catalogId: "channel.whatsapp",
      label: "WhatsApp",
      config: {
        accessTokenEnv: "WHATSAPP_TOKEN",
        inboundAccessMode: "open_legacy",
      },
    });

    const updated = await updateIntegrationConnection(deps, connection.connectionId, {
      config: {
        accessTokenEnv: "WHATSAPP_TOKEN_V2",
      },
    });

    expect(updated.config).toEqual({
      accessTokenEnv: "WHATSAPP_TOKEN_V2",
      inboundAccessMode: "open_legacy",
    });
  });
});

describe("integration-channel-service runtime status", () => {
  it.each([
    [
      "channel.signal",
      "signal",
      { baseUrl: "http://127.0.0.1:8080", defaultRecipient: "+15550002222", receiveEvents: true },
    ],
    [
      "channel.imessage",
      "imessage",
      { bridgeUrl: "http://127.0.0.1:1234", passwordEnv: "BB_PASSWORD", defaultHandle: "imessage:+15550002222" },
    ],
  ] as const)(
    "refuses a new %s connection, keeps a saved one readable and not ready, and still deletes it",
    async (catalogId, key, config) => {
      const deps = createDeps();
      await expect(createIntegrationConnection(deps, { catalogId, label: key, config })).rejects.toThrow(
        `Unknown integration catalog id: ${catalogId}`,
      );

      const saved = await deps.storage.integrationConnections.create({
        catalogId,
        kind: "channel",
        key,
        label: key,
        config,
        status: "connected",
      });
      await updateIntegrationConnection(deps, saved.connectionId, {
        status: "connected",
        lastSyncAt: "2026-10-27T12:00:00.000Z",
      });

      const status = await getIntegrationConnectionChannelRuntimeStatus(deps, saved.connectionId);
      expect(status.ready).toBe(false);
      expect(status.inboundModes).toEqual(["none"]);
      expect(status.runtimePosture.inboundReadiness).toBe("unsupported");
      expect(status.metadata.setupDiagnostics).toEqual([expect.stringMatching(/is not supported anymore/)]);
      expect(deps.getChannelStreamRuntimeStatus).not.toHaveBeenCalled();

      expect(await deleteIntegrationConnection(deps, saved.connectionId)).toBe(true);
      expect(await deps.storage.integrationConnections.list()).toEqual([]);
    },
  );

  it("reports ntfy stream inbound from the live stream runtime, not the last probe", async () => {
    const deps = createDeps();
    const connection = await createIntegrationConnection(deps, {
      catalogId: "channel.ntfy",
      label: "ntfy",
      config: {
        baseUrl: "https://ntfy.example.test",
        topic: "ops",
        tokenEnv: "NTFY_TOKEN",
        inboundStreamEnabled: true,
      },
    });
    await updateIntegrationConnection(deps, connection.connectionId, {
      status: "connected",
      lastSyncAt: "2026-10-16T12:00:00.000Z",
    });

    vi.mocked(deps.getChannelStreamRuntimeStatus).mockReturnValue(undefined);
    const notStarted = await getIntegrationConnectionChannelRuntimeStatus(deps, connection.connectionId);
    expect(notStarted.ready).toBe(false);
    expect(notStarted.inboundModes).toEqual(["stream"]);
    expect(notStarted.metadata).toMatchObject({ readinessSource: "live_runtime", authoritative: true });

    vi.mocked(deps.getChannelStreamRuntimeStatus).mockReturnValue({
      connectionId: connection.connectionId,
      channelKey: "ntfy",
      ready: true,
      lastReadyAt: "2026-10-16T12:01:00.000Z",
      lastInboundAt: "2026-10-16T12:02:00.000Z",
    });
    const live = await getIntegrationConnectionChannelRuntimeStatus(deps, connection.connectionId);
    expect(live.ready).toBe(true);
    expect(live.lastReadyAt).toBe("2026-10-16T12:01:00.000Z");
    expect(live.lastInboundAt).toBe("2026-10-16T12:02:00.000Z");
    expect(live.runtimePosture).toMatchObject({ lifecycle: "persistent", inboundTransport: "stream" });

    vi.mocked(deps.getChannelStreamRuntimeStatus).mockReturnValue({
      connectionId: connection.connectionId,
      channelKey: "ntfy",
      ready: false,
      lastError: "ntfy rejected the subscription token (401)",
      stoppedReason: "auth_failed",
    });
    const failed = await getIntegrationConnectionChannelRuntimeStatus(deps, connection.connectionId);
    expect(failed.ready).toBe(false);
    expect(failed.lastError).toContain("401");
    expect(failed.metadata.streamStoppedReason).toBe("auth_failed");
  });

  it("reports Telegram polling readiness from the live stream runtime, not the last probe", async () => {
    const deps = createDeps();
    const connection = await createIntegrationConnection(deps, {
      catalogId: "channel.telegram",
      label: "Telegram",
      config: {
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
        defaultChatId: "-1001234567890",
        receiveMode: "poll",
      },
    });
    await updateIntegrationConnection(deps, connection.connectionId, {
      status: "connected",
      lastSyncAt: "2026-10-26T12:00:00.000Z",
    });

    vi.mocked(deps.getChannelStreamRuntimeStatus).mockReturnValue(undefined);
    const notStarted = await getIntegrationConnectionChannelRuntimeStatus(deps, connection.connectionId);
    expect(notStarted.ready).toBe(false);
    expect(notStarted.inboundModes).toEqual(["poll"]);
    expect(notStarted.metadata).toMatchObject({ readinessSource: "live_runtime", authoritative: true });

    vi.mocked(deps.getChannelStreamRuntimeStatus).mockReturnValue({
      connectionId: connection.connectionId,
      channelKey: "telegram",
      ready: true,
      lastReadyAt: "2026-10-26T12:01:00.000Z",
      lastInboundAt: "2026-10-26T12:02:00.000Z",
    });
    const live = await getIntegrationConnectionChannelRuntimeStatus(deps, connection.connectionId);
    expect(live.ready).toBe(true);
    expect(live.lastReadyAt).toBe("2026-10-26T12:01:00.000Z");
    expect(live.lastInboundAt).toBe("2026-10-26T12:02:00.000Z");
    expect(live.runtimePosture).toMatchObject({ lifecycle: "persistent", inboundTransport: "poll" });

    vi.mocked(deps.getChannelStreamRuntimeStatus).mockReturnValue({
      connectionId: connection.connectionId,
      channelKey: "telegram",
      ready: false,
      lastError: "Telegram rejected the bot token (401)",
      stoppedReason: "auth_failed",
    });
    const failed = await getIntegrationConnectionChannelRuntimeStatus(deps, connection.connectionId);
    expect(failed.ready).toBe(false);
    expect(failed.lastError).toContain("401");
    expect(failed.metadata.streamStoppedReason).toBe("auth_failed");
  });

  it("does not consult the stream runtime for a Telegram connection that receives nothing", async () => {
    const deps = createDeps();
    const connection = await createIntegrationConnection(deps, {
      catalogId: "channel.telegram",
      label: "Telegram",
      config: {
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
        defaultChatId: "-1001234567890",
        receiveMode: "off",
      },
    });
    await updateIntegrationConnection(deps, connection.connectionId, {
      status: "connected",
      lastSyncAt: "2026-10-26T12:00:00.000Z",
    });

    const status = await getIntegrationConnectionChannelRuntimeStatus(deps, connection.connectionId);

    expect(status.inboundModes).toEqual(["none"]);
    expect(status.ready).toBe(true);
    expect(status.metadata.readinessSource).toBe("last_live_probe");
    expect(deps.getChannelStreamRuntimeStatus).not.toHaveBeenCalled();
  });
});

describe("integration-channel-service removing a channel", () => {
  const SECRET_VALUE = "synthetic-bot-token-value";
  const OTHER_CONNECTION = "22222222-2222-2222-2222-222222222222";

  /** A custody service over an in-memory keychain, plus the keys that stay in it. */
  function createCustody() {
    const values = new Map<string, string>();
    const store = {
      setSecret: vi.fn((account: string, value: string) => void values.set(account, value)),
      getSecret: vi.fn((account: string) => values.get(account)),
      deleteSecret: vi.fn((account: string) => void values.delete(account)),
    };
    const custody = new ChannelSecretCustodyService(store as never);
    /** Promotes a draft key the way finalizing a setup does: the connection keeps its own copy. */
    const keyFor = (connectionId: string, field: string): string => {
      const temporary = custody.storeTemporary("draft-1", field, SECRET_VALUE);
      const promoted = custody.copyToConnection(temporary, connectionId, field);
      custody.deleteTemporary(temporary);
      store.deleteSecret.mockClear();
      return promoted;
    };
    return { values, store, custody, keyFor };
  }

  /** Deps whose connection config already carries its keys, with pairings in an array and a diagnostic sink. */
  async function createRemovalDeps(input: {
    catalogId: string;
    config: (keyFor: ReturnType<typeof createCustody>["keyFor"], connectionId: string) => Record<string, unknown>;
  }) {
    const keychain = createCustody();
    const deps = createDeps();
    const created = await createIntegrationConnection(deps, {
      catalogId: input.catalogId,
      label: "Fixture",
      config: {},
    });
    const connection = await updateIntegrationConnection(deps, created.connectionId, {
      config: input.config(keychain.keyFor, created.connectionId),
    });
    let pairings: DiscordPairingRecord[] = [];
    const recordDevDiagnostic = vi.fn();
    Object.assign(deps, {
      channelSecrets: keychain.custody,
      recordDevDiagnostic,
      readDiscordPairings: vi.fn(async () => pairings),
      writeDiscordPairings: vi.fn(async (next: DiscordPairingRecord[]) => {
        pairings = next;
      }),
    });
    return {
      ...keychain,
      deps,
      connection,
      recordDevDiagnostic,
      setPairings: (next: DiscordPairingRecord[]) => {
        pairings = next;
      },
      pairings: () => pairings,
    };
  }

  const pairing = (connectionId: string, pairingId: string): DiscordPairingRecord => ({
    pairingId,
    connectionId,
    userId: `user-${pairingId}`,
    code: "ABC123",
    status: "approved",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });

  it("deletes the connection's stored keys when it is removed", async () => {
    const fixture = await createRemovalDeps({
      catalogId: "channel.slack",
      config: (keyFor, id) => ({ botToken: keyFor(id, "botToken"), signingSecret: keyFor(id, "signingSecret") }),
    });
    const { botToken, signingSecret } = fixture.connection.config as { botToken: string; signingSecret: string };
    const refs = [botToken, signingSecret];
    expect(fixture.values.size).toBe(2);

    const deleted = await deleteIntegrationConnection(
      fixture.deps,
      fixture.connection.connectionId,
      fixture.connection.revision,
    );

    expect(deleted).toBe(true);
    expect(fixture.values.size).toBe(0);
    expect(fixture.store.deleteSecret).toHaveBeenCalledTimes(2);
    for (const ref of refs) expect(() => fixture.custody.resolve(ref)).toThrow(/unavailable/);
  });

  it("removes the connection's Discord pairings", async () => {
    const fixture = await createRemovalDeps({
      catalogId: "channel.discord",
      config: (keyFor, id) => ({ botToken: keyFor(id, "botToken") }),
    });
    const id = fixture.connection.connectionId;
    fixture.setPairings([pairing(id, "mine-1"), pairing(OTHER_CONNECTION, "other"), pairing(id, "mine-2")]);

    await deleteIntegrationConnection(fixture.deps, id, fixture.connection.revision);

    expect(fixture.pairings().map((item) => item.pairingId)).toEqual(["other"]);
  });

  it("keeps the connection's conversations when it is removed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-channel-removal-"));
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    try {
      const connection = storage.integrationConnections.create({
        catalogId: "channel.telegram",
        kind: "channel",
        key: "telegram",
        label: "Telegram",
        config: {},
      });
      const sessionId = "session-removed-channel";
      storage.sessions.upsert({
        sessionId,
        sessionKey: `agent:main:telegram:${connection.connectionId}:peer:42`,
        kind: "dm",
        channel: "telegram",
        account: connection.connectionId,
        displayName: "Sam Lee",
        timestamp: "2026-10-01T00:00:00.000Z",
      });
      storage.chatSessionBindings.upsert({
        sessionId,
        transport: "integration",
        connectionId: connection.connectionId,
        target: "telegram:42",
        conversation: { kind: "direct", counterpartActorId: "42", title: "Sam Lee" },
      });
      storage.chatMessages.upsert({
        messageId: "message-1",
        sessionId,
        role: "user",
        actorType: "user",
        actorId: "42",
        sourceAuthority: "external_channel",
        content: "Are we still on for Friday?",
        timestamp: "2026-10-01T00:00:01.000Z",
      });
      const deps = {
        storage: createSqliteAsyncStorage(storage),
        publishRealtime: vi.fn(async () => undefined),
        syncChannelRuntimes: vi.fn(async () => undefined),
      } as unknown as IntegrationChannelPort;

      const deleted = await deleteIntegrationConnection(deps, connection.connectionId, connection.revision);

      expect(deleted).toBe(true);
      expect(storage.integrationConnections.list().map((item) => item.connectionId)).not.toContain(
        connection.connectionId,
      );
      expect(storage.sessions.getBySessionId(sessionId)).toMatchObject({ sessionId, account: connection.connectionId });
      expect(storage.chatSessionBindings.get(sessionId)).toMatchObject({
        connectionId: connection.connectionId,
        target: "telegram:42",
        conversation: { title: "Sam Lee" },
      });
      expect(storage.chatMessages.list(sessionId).map((item) => item.content)).toEqual(["Are we still on for Friday?"]);
    } finally {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("finishes the removal when deleting a key fails", async () => {
    const fixture = await createRemovalDeps({
      catalogId: "channel.slack",
      config: (keyFor, id) => ({ botToken: keyFor(id, "botToken"), signingSecret: keyFor(id, "signingSecret") }),
    });
    const { botToken, signingSecret } = fixture.connection.config as { botToken: string; signingSecret: string };
    fixture.store.deleteSecret.mockImplementationOnce(() => {
      throw new Error(`keychain refused ${botToken} ${SECRET_VALUE}`);
    });

    const deleted = await deleteIntegrationConnection(
      fixture.deps,
      fixture.connection.connectionId,
      fixture.connection.revision,
    );

    expect(deleted).toBe(true);
    expect(fixture.deps.storage.integrationConnections.delete).toHaveBeenCalledOnce();
    expect(fixture.deps.publishRealtime).toHaveBeenCalledWith(
      "system",
      "integrations",
      expect.objectContaining({ type: "integration_connection_deleted" }),
    );
    expect(() => fixture.custody.resolve(signingSecret)).toThrow(/unavailable/);
    expect(fixture.recordDevDiagnostic).toHaveBeenCalledOnce();
    const logged = JSON.stringify(fixture.recordDevDiagnostic.mock.calls[0]);
    expect(logged).toContain("botToken");
    expect(logged).not.toContain(botToken);
    expect(logged).not.toContain(botToken.split(":").at(-1)!);
    expect(logged).not.toContain(SECRET_VALUE);
  });

  it("finishes the removal when removing the Discord pairings fails", async () => {
    const fixture = await createRemovalDeps({
      catalogId: "channel.discord",
      config: (keyFor, id) => ({ botToken: keyFor(id, "botToken") }),
    });
    vi.mocked(fixture.deps.readDiscordPairings).mockRejectedValueOnce(new Error("settings unavailable"));

    const deleted = await deleteIntegrationConnection(
      fixture.deps,
      fixture.connection.connectionId,
      fixture.connection.revision,
    );

    expect(deleted).toBe(true);
    expect(fixture.values.size).toBe(0);
    expect(fixture.recordDevDiagnostic).toHaveBeenCalledOnce();
  });

  it("keeps the keys when the removal is refused", async () => {
    const fixture = await createRemovalDeps({
      catalogId: "channel.slack",
      config: (keyFor, id) => ({ botToken: keyFor(id, "botToken") }),
    });
    vi.mocked(fixture.deps.storage.integrationConnections.delete).mockRejectedValueOnce(
      new ConflictError({ code: "WRITE_CONFLICT", message: "The integration connection changed." }),
    );

    await expect(
      deleteIntegrationConnection(fixture.deps, fixture.connection.connectionId, "b".repeat(64)),
    ).rejects.toThrow(/changed/);

    expect(fixture.values.size).toBe(1);
    expect(fixture.store.deleteSecret).not.toHaveBeenCalled();
  });

  it("reports false and deletes nothing when the connection is already gone", async () => {
    const fixture = await createRemovalDeps({ catalogId: "channel.slack", config: () => ({}) });
    const { connectionId } = fixture.connection;
    await deleteIntegrationConnection(fixture.deps, connectionId);
    // The repository names a missing connection with this error, whether it is read or deleted.
    vi.mocked(fixture.deps.storage.integrationConnections.get).mockImplementationOnce(() => {
      throw new NotFoundError({ entity: "Integration connection", id: connectionId });
    });

    const again = await deleteIntegrationConnection(fixture.deps, connectionId);

    expect(again).toBe(false);
    expect(fixture.store.deleteSecret).not.toHaveBeenCalled();
  });

  it("never deletes a draft key or another connection's key", async () => {
    const keychain = createCustody();
    const draftRef = keychain.custody.storeTemporary("draft-9", "botToken", SECRET_VALUE);
    const otherRef = keychain.keyFor(OTHER_CONNECTION, "botToken");
    const deps = createDeps();
    const created = await createIntegrationConnection(deps, { catalogId: "channel.slack", label: "Slack", config: {} });
    const ownRef = keychain.keyFor(created.connectionId, "botToken");
    const connection = await updateIntegrationConnection(deps, created.connectionId, {
      config: { botToken: ownRef, staleDraft: draftRef, borrowed: otherRef },
    });
    Object.assign(deps, { channelSecrets: keychain.custody });

    await deleteIntegrationConnection(deps, connection.connectionId, connection.revision);

    expect(keychain.store.deleteSecret).toHaveBeenCalledOnce();
    expect(() => keychain.custody.resolve(ownRef)).toThrow(/unavailable/);
    expect(keychain.custody.resolve(draftRef)).toBe(SECRET_VALUE);
    expect(keychain.custody.resolve(otherRef)).toBe(SECRET_VALUE);
  });

  it("still removes the connection when no keychain is available", async () => {
    const fixture = await createRemovalDeps({
      catalogId: "channel.slack",
      config: (keyFor, id) => ({ botToken: keyFor(id, "botToken") }),
    });
    Object.assign(fixture.deps, { channelSecrets: undefined });

    const deleted = await deleteIntegrationConnection(
      fixture.deps,
      fixture.connection.connectionId,
      fixture.connection.revision,
    );

    expect(deleted).toBe(true);
    expect(fixture.recordDevDiagnostic).toHaveBeenCalledOnce();
  });

  describe("collectConnectionSecretRefs", () => {
    const id = "11111111-1111-1111-1111-000000000001";
    const own = `keychain:goatcitadel:channel-connection:${id}:botToken:abc-123`;

    it("finds every key reference of the connection at any depth, once each", () => {
      const legacy = `keychain:goatcitadel:channel-connection:${id}:signingSecret`;
      const refs = collectConnectionSecretRefs(id, {
        botToken: own,
        again: own,
        nested: { deeper: [{ key: legacy }, "plain text"], count: 3, flag: true, none: null },
      });

      expect(refs).toEqual([own, legacy]);
    });

    it("ignores draft keys, other connections' keys and look-alike values", () => {
      const refs = collectConnectionSecretRefs(id, {
        draft: `keychain:goatcitadel:channel-draft:${id}:botToken:abc`,
        longer: `keychain:goatcitadel:channel-connection:${id}0:botToken:abc`,
        shorter: `keychain:goatcitadel:channel-connection:${id.slice(0, -1)}:botToken:abc`,
        prose: `see ${own}`,
        bare: "keychain:goatcitadel:channel-connection:",
      });

      expect(refs).toEqual([]);
    });

    it("returns nothing for an empty config and survives a self-referencing one", () => {
      expect(collectConnectionSecretRefs(id, {})).toEqual([]);
      const cyclic: Record<string, unknown> = { botToken: own };
      cyclic.self = cyclic;
      expect(collectConnectionSecretRefs(id, cyclic)).toEqual([own]);
    });
  });
});
