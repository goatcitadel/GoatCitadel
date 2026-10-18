import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateChannelInboundAccess,
  type IntegrationConnection,
  type IntegrationPluginRecord,
} from "@goatcitadel/contracts";
import {
  createIntegrationConnection,
  getIntegrationConnectionChannelRuntimeStatus,
  installIntegrationPlugin,
  PluginPackageStorageError,
  setIntegrationPluginEnabled,
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
    readIntegrationPlugins: vi.fn(() => []),
    writeIntegrationPlugins: vi.fn(),
    verifyIntegrationPluginPackage: vi.fn(async () => ({ status: "unknown" as const, warnings: [] })),
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
  it("ignores a legacy Signal inboundEnabled value: no blocked branch, no retired feature flag read", async () => {
    const deps = createDeps();
    const latestAcceptedInboundAt = vi.fn(async () => "2026-07-05T12:30:00.000Z");
    Object.assign(deps, { latestAcceptedInboundAt });
    const connection = await createIntegrationConnection(deps, {
      catalogId: "channel.signal",
      label: "Signal",
      config: {
        baseUrl: "http://127.0.0.1:8080",
        accountId: "+15550001111",
        defaultRecipient: "+15550002222",
        inboundEnabled: " TRUE ",
      },
    });
    await updateIntegrationConnection(deps, connection.connectionId, {
      status: "connected",
      lastSyncAt: "2026-07-05T12:00:00.000Z",
    });

    const status = await getIntegrationConnectionChannelRuntimeStatus(deps, connection.connectionId);

    expect(status.ready).toBe(true);
    expect(status.inboundModes).toEqual(["none"]);
    expect(status.runtimePosture).toMatchObject({
      outboundTransport: "api",
      lifecycle: "stateless",
      inboundReadiness: "unsupported",
    });
    expect(status.metadata.readinessSource).toBe("last_live_probe");
    expect(status.metadata).not.toHaveProperty("featureFlag");
    // Signal is no longer special-cased out of the accepted-inbound timestamp.
    expect(status.lastInboundAt).toBe("2026-07-05T12:30:00.000Z");
    expect(deps.isFeatureEnabled).not.toHaveBeenCalledWith("signalInboundV1Enabled");
  });

  it("reports Signal receiveEvents inbound from the live stream runtime", async () => {
    const deps = createDeps();
    const connection = await createIntegrationConnection(deps, {
      catalogId: "channel.signal",
      label: "Signal",
      config: {
        baseUrl: "http://127.0.0.1:8080",
        accountId: "+15550001111",
        defaultRecipient: "+15550003333",
        receiveEvents: true,
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
      channelKey: "signal",
      ready: true,
      lastReadyAt: "2026-10-16T12:01:00.000Z",
      lastInboundAt: "2026-10-16T12:02:00.000Z",
    });
    const live = await getIntegrationConnectionChannelRuntimeStatus(deps, connection.connectionId);
    expect(live.ready).toBe(true);
    expect(live.lastInboundAt).toBe("2026-10-16T12:02:00.000Z");
    expect(live.runtimePosture).toMatchObject({
      lifecycle: "persistent",
      inboundTransport: "stream",
      inboundReadiness: "ready",
    });
  });

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
});

describe("integration plugin package integrity at install", () => {
  function withPluginStore(deps: IntegrationChannelPort, initial: IntegrationPluginRecord[] = []) {
    let plugins = initial;
    vi.mocked(deps.readIntegrationPlugins).mockImplementation(async () => plugins);
    vi.mocked(deps.writeIntegrationPlugins).mockImplementation(async (next) => {
      plugins = next;
    });
    return () => plugins;
  }

  it("install records verified integrity from the verifier", async () => {
    const deps = createDeps();
    const read = withPluginStore(deps);
    vi.mocked(deps.verifyIntegrationPluginPackage).mockResolvedValue({
      status: "verified",
      actualIntegrity: "sha512-actual",
      integritySource: "registry",
      verifiedAt: "2026-10-18T00:00:00.000Z",
      artifactPath: "integration-plugins/goat-plugin/abc.tgz",
      warnings: [{ code: "integrity_not_pinned", severity: "warning", message: "pin it" }],
    });

    const record = await installIntegrationPlugin(deps, { source: "goat-plugin", pluginId: "goat-plugin" });

    expect(record.integrityStatus).toBe("verified");
    expect(record.enabled).toBe(true);
    expect(record.sourceMetadata).toMatchObject({
      type: "npm",
      integrityStatus: "verified",
      actualIntegrity: "sha512-actual",
      integritySource: "registry",
      verifiedAt: "2026-10-18T00:00:00.000Z",
      artifactPath: "integration-plugins/goat-plugin/abc.tgz",
    });
    expect(record.sourceMetadata?.expectedIntegrity).toBeUndefined();
    expect(record.trustWarnings?.map((warning) => warning.code)).toContain("integrity_not_pinned");
    expect(read()).toHaveLength(1);
  });

  it("install quarantines and disables on mismatch", async () => {
    const deps = createDeps();
    withPluginStore(deps);
    vi.mocked(deps.verifyIntegrationPluginPackage).mockResolvedValue({
      status: "quarantined",
      actualIntegrity: "sha512-actual",
      expectedIntegrity: "sha512-wanted",
      warnings: [{ code: "integrity_mismatch", severity: "critical", message: "mismatch" }],
    });

    const record = await installIntegrationPlugin(deps, { source: "goat-plugin", pluginId: "goat-plugin" });

    expect(record.enabled).toBe(false);
    expect(record.integrityStatus).toBe("quarantined");
    expect(record.sourceMetadata?.actualIntegrity).toBe("sha512-actual");
    expect(record.trustWarnings?.map((warning) => warning.code)).toContain("integrity_mismatch");
  });

  it("never persists an empty string as the operator pin", async () => {
    const deps = createDeps();
    withPluginStore(deps);
    vi.mocked(deps.verifyIntegrationPluginPackage).mockResolvedValue({
      status: "quarantined",
      expectedIntegrity: "",
      warnings: [{ code: "integrity_manifest_invalid", severity: "critical", message: "bad tree" }],
    });

    const record = await installIntegrationPlugin(deps, {
      source: "./local-plugin",
      sourceType: "local",
      pluginId: "lp",
    });

    expect(record.sourceMetadata?.expectedIntegrity).toBeUndefined();
    expect(record.integrityStatus).toBe("quarantined");
  });

  it("enabling a quarantined plugin is refused", async () => {
    const deps = createDeps();
    const base = {
      label: "Q",
      version: "1.0.0",
      enabled: false,
      installedAt: "2026-10-18T00:00:00.000Z",
      updatedAt: "2026-10-18T00:00:00.000Z",
      capabilities: ["channel.adapter"],
    };
    const read = withPluginStore(deps, [
      { ...base, pluginId: "q1", integrityStatus: "quarantined" },
      { ...base, pluginId: "q2", integrityStatus: "mismatch" },
      { ...base, pluginId: "ok", integrityStatus: "verified" },
    ] as IntegrationPluginRecord[]);

    await expect(setIntegrationPluginEnabled(deps, "q1", true)).rejects.toThrow(
      /quarantined after an integrity failure/,
    );
    await expect(setIntegrationPluginEnabled(deps, "q2", true)).rejects.toThrow(
      /quarantined after an integrity failure/,
    );
    expect((await setIntegrationPluginEnabled(deps, "ok", true)).enabled).toBe(true);
    // disabling a quarantined plugin stays allowed
    expect((await setIntegrationPluginEnabled(deps, "q1", false)).enabled).toBe(false);
    expect(read().find((item) => item.pluginId === "q1")?.enabled).toBe(false);
  });

  it("install passes sourceType and expectedIntegrity to the verifier", async () => {
    const deps = createDeps();
    withPluginStore(deps);
    const expected = `sha512-${"A".repeat(86)}==`;

    await installIntegrationPlugin(deps, {
      source: "npm:@goat/plugin@1.2.3",
      pluginId: "goat-plugin",
      expectedIntegrity: expected,
    });

    expect(deps.verifyIntegrationPluginPackage).toHaveBeenCalledWith({
      pluginId: "goat-plugin",
      source: "npm:@goat/plugin@1.2.3",
      sourceType: "npm",
      expectedIntegrity: expected,
    });
  });

  it("fails the install without recording when the verifier throws a storage failure", async () => {
    const deps = createDeps();
    const read = withPluginStore(deps);
    vi.mocked(deps.verifyIntegrationPluginPackage).mockRejectedValue(new Error("EACCES: C:/secret/path"));

    await expect(installIntegrationPlugin(deps, { source: "goat-plugin", pluginId: "goat-plugin" })).rejects.toThrow(
      /could not be stored/,
    );
    expect(read()).toHaveLength(0);
    expect(deps.writeIntegrationPlugins).not.toHaveBeenCalled();
  });

  it("publishes a realtime update when an existing plugin is reinstalled", async () => {
    const deps = createDeps();
    withPluginStore(deps);
    await installIntegrationPlugin(deps, { source: "goat-plugin", pluginId: "goat-plugin" });
    await installIntegrationPlugin(deps, { source: "goat-plugin", pluginId: "goat-plugin" });
    expect(vi.mocked(deps.publishRealtime).mock.calls.map((call) => (call[2] as { type: string }).type)).toEqual([
      "integration_plugin_installed",
      "integration_plugin_updated",
    ]);
  });

  it("serializes list writes: a slow install does not revert a concurrent disable", async () => {
    const deps = createDeps();
    const base = {
      label: "B",
      version: "1.0.0",
      installedAt: "2026-10-18T00:00:00.000Z",
      updatedAt: "2026-10-18T00:00:00.000Z",
      capabilities: ["channel.adapter"],
      integrityStatus: "verified",
    };
    const read = withPluginStore(deps, [{ ...base, pluginId: "other", enabled: true }] as IntegrationPluginRecord[]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(deps.verifyIntegrationPluginPackage).mockImplementationOnce(async () => {
      await gate;
      return { status: "unknown", warnings: [] };
    });

    const slow = installIntegrationPlugin(deps, { source: "slow-plugin", pluginId: "slow-plugin" });
    await setIntegrationPluginEnabled(deps, "other", false);
    release();
    await slow;
    const fast = await installIntegrationPlugin(deps, { source: "fast-plugin", pluginId: "fast-plugin" });

    const ids = read().map((item) => [item.pluginId, item.enabled]);
    expect(ids).toEqual(
      expect.arrayContaining([
        ["other", false],
        ["slow-plugin", true],
        [fast.pluginId, true],
      ]),
    );
    expect(read()).toHaveLength(3);
  });

  it("disables an npm install whose package could not be verified or validated", async () => {
    const deps = createDeps();
    withPluginStore(deps);
    vi.mocked(deps.verifyIntegrationPluginPackage).mockResolvedValue({
      status: "unknown",
      warnings: [{ code: "integrity_unverifiable", severity: "critical", message: "blocked" }],
    });
    const record = await installIntegrationPlugin(deps, { source: "npm:goat-plugin", pluginId: "goat-plugin" });
    expect(record.enabled).toBe(false);
    expect(record.integrityStatus).toBe("unknown");
  });

  it("includes integrityStatus in install and update realtime payloads", async () => {
    const deps = createDeps();
    withPluginStore(deps);
    vi.mocked(deps.verifyIntegrationPluginPackage).mockResolvedValue({
      status: "quarantined",
      expectedIntegrity: "sha512-x",
      warnings: [],
    });
    await installIntegrationPlugin(deps, { source: "goat-plugin", pluginId: "goat-plugin" });
    await installIntegrationPlugin(deps, { source: "goat-plugin", pluginId: "goat-plugin" });
    expect(
      vi
        .mocked(deps.publishRealtime)
        .mock.calls.map((call) => (call[2] as { integrityStatus: string }).integrityStatus),
    ).toEqual(["quarantined", "quarantined"]);
  });

  it("keeps the previous operator pin when an update supplies none", async () => {
    const deps = createDeps();
    withPluginStore(deps);
    const pin = `sha512-${"A".repeat(86)}==`;
    vi.mocked(deps.verifyIntegrationPluginPackage).mockResolvedValue({
      status: "verified",
      actualIntegrity: pin,
      integritySource: "operator",
      verifiedAt: "2026-10-18T00:00:00.000Z",
      warnings: [],
    });
    await installIntegrationPlugin(deps, {
      source: "npm:goat-plugin",
      pluginId: "goat-plugin",
      expectedIntegrity: pin,
    });
    const updated = await installIntegrationPlugin(deps, { source: "npm:goat-plugin", pluginId: "goat-plugin" });
    expect(vi.mocked(deps.verifyIntegrationPluginPackage).mock.calls[1]![0].expectedIntegrity).toBe(pin);
    expect(updated.sourceMetadata?.expectedIntegrity).toBe(pin);
  });

  it("hashes the plugin folder when the local source is the descriptor file", async () => {
    const deps = createDeps();
    withPluginStore(deps);
    const folder = path.resolve(process.cwd(), "../../templates/integration-plugins/reference-integration-plugin");
    await installIntegrationPlugin(deps, {
      source: path.join(folder, "goatcitadel.integration-plugin.json"),
      sourceType: "local",
    });
    expect(vi.mocked(deps.verifyIntegrationPluginPackage).mock.calls[0]![0].source).toBe(folder);
  });

  it("wraps verifier storage failures in PluginPackageStorageError", async () => {
    const deps = createDeps();
    withPluginStore(deps);
    vi.mocked(deps.verifyIntegrationPluginPackage).mockRejectedValue(new Error("EACCES"));
    await expect(
      installIntegrationPlugin(deps, { source: "npm:goat-plugin", pluginId: "goat-plugin" }),
    ).rejects.toBeInstanceOf(PluginPackageStorageError);
  });

  it("returns the committed record when the realtime publish rejects (create and update)", async () => {
    const deps = createDeps();
    const read = withPluginStore(deps);
    vi.mocked(deps.publishRealtime).mockRejectedValue(new Error("bus down"));
    const record = vi.fn();
    (deps as { recordDevDiagnostic?: unknown }).recordDevDiagnostic = record;

    const created = await installIntegrationPlugin(deps, { source: "goat-plugin", pluginId: "goat-plugin" });
    const updated = await installIntegrationPlugin(deps, { source: "goat-plugin", pluginId: "goat-plugin" });

    expect(created.pluginId).toBe("goat-plugin");
    expect(updated.pluginId).toBe("goat-plugin");
    expect(read()).toHaveLength(1);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("refuses to enable plugins whose package could not be verified or found", async () => {
    const deps = createDeps();
    const base = {
      label: "U",
      version: "1.0.0",
      enabled: false,
      installedAt: "2026-10-18T00:00:00.000Z",
      updatedAt: "2026-10-18T00:00:00.000Z",
      capabilities: ["channel.adapter"],
      integrityStatus: "unknown",
    };
    withPluginStore(deps, [
      {
        ...base,
        pluginId: "npm-u",
        sourceMetadata: { type: "npm", display: "x", integrityStatus: "unknown" },
        trustWarnings: [{ code: "integrity_unverifiable", severity: "critical", message: "m" }],
      },
      {
        ...base,
        pluginId: "local-u",
        sourceMetadata: { type: "local", display: "x", integrityStatus: "unknown" },
        trustWarnings: [{ code: "integrity_manifest_invalid", severity: "critical", message: "m" }],
      },
      {
        ...base,
        pluginId: "git-u",
        sourceMetadata: { type: "git", display: "x", integrityStatus: "unknown" },
        trustWarnings: [{ code: "integrity_not_verified", severity: "warning", message: "m" }],
      },
    ] as IntegrationPluginRecord[]);

    await expect(setIntegrationPluginEnabled(deps, "npm-u", true)).rejects.toThrow(/could not be verified/);
    await expect(setIntegrationPluginEnabled(deps, "local-u", true)).rejects.toThrow(/could not be verified/);
    expect((await setIntegrationPluginEnabled(deps, "git-u", true)).enabled).toBe(true);
  });

  it("records a local install with a missing path disabled", async () => {
    const deps = createDeps();
    withPluginStore(deps);
    vi.mocked(deps.verifyIntegrationPluginPackage).mockResolvedValue({
      status: "unknown",
      warnings: [{ code: "integrity_manifest_invalid", severity: "critical", message: "manifest_path_missing" }],
    });
    const record = await installIntegrationPlugin(deps, {
      source: path.resolve("definitely-missing-plugin-dir"),
      sourceType: "local",
      pluginId: "gone",
    });
    expect(record.enabled).toBe(false);
  });

  it("does not inherit the previous pin when the source changed (version bump)", async () => {
    const deps = createDeps();
    withPluginStore(deps);
    const pin = `sha512-${"A".repeat(86)}==`;
    vi.mocked(deps.verifyIntegrationPluginPackage).mockResolvedValue({
      status: "verified",
      actualIntegrity: pin,
      integritySource: "operator",
      verifiedAt: "2026-10-18T00:00:00.000Z",
      warnings: [],
    });
    await installIntegrationPlugin(deps, {
      source: "npm:goat-plugin@1.0.0",
      pluginId: "goat-plugin",
      expectedIntegrity: pin,
    });
    await installIntegrationPlugin(deps, { source: "npm:goat-plugin@2.0.0", pluginId: "goat-plugin" });
    expect(vi.mocked(deps.verifyIntegrationPluginPackage).mock.calls[1]![0].expectedIntegrity).toBeUndefined();
  });

  it("keeps the operator pin as evidence when verification is unknown, so a retry inherits it", async () => {
    const deps = createDeps();
    withPluginStore(deps);
    const pin = `sha512-${"A".repeat(86)}==`;
    vi.mocked(deps.verifyIntegrationPluginPackage).mockResolvedValue({
      status: "unknown",
      warnings: [{ code: "integrity_unverifiable", severity: "critical", message: "blocked" }],
    });
    const first = await installIntegrationPlugin(deps, {
      source: "npm:goat-plugin",
      pluginId: "goat-plugin",
      expectedIntegrity: pin,
    });
    expect(first.sourceMetadata).toMatchObject({ expectedIntegrity: pin, integritySource: "operator" });
    await installIntegrationPlugin(deps, { source: "npm:goat-plugin", pluginId: "goat-plugin" });
    expect(vi.mocked(deps.verifyIntegrationPluginPackage).mock.calls[1]![0].expectedIntegrity).toBe(pin);
  });
});
