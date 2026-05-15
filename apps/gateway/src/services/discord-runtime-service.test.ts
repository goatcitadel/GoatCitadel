import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordPairingRecord, IntegrationConnection } from "@goatcitadel/contracts";
import { DiscordRuntimeService, __discordRuntimeServiceInternals } from "./discord-runtime-service.js";

function createConnection(config: Record<string, unknown> = {}): IntegrationConnection {
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
      guildPolicy: "allowlist",
      guilds: {
        guild_1: {
          requireMention: true,
          channels: ["channel_1"],
        },
      },
      ...config,
    },
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z",
  };
}

function createService(overrides: Partial<ConstructorParameters<typeof DiscordRuntimeService>[0]> = {}) {
  return new DiscordRuntimeService({
    listConnections: () => [],
    findApprovedPairing: () => undefined,
    ensurePendingPairing: () => {
      throw new Error("unexpected pairing request");
    },
    touchPairing: () => {},
    onInboundMessage: vi.fn(),
    onSlashCommand: vi.fn(async () => "ok"),
    listModelSuggestions: async () => [],
    publishDiagnostic: () => {},
    ...overrides,
  });
}

function createPairingRecord(overrides: Partial<DiscordPairingRecord> = {}): DiscordPairingRecord {
  return {
    pairingId: "pairing_1",
    connectionId: "11111111-1111-1111-1111-111111111111",
    userId: "user_1",
    code: "ABC123",
    status: "pending",
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("DiscordRuntimeService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks accepted guild messages as seen and keeps typing while the inbound turn runs", async () => {
    vi.useFakeTimers();

    let resolveInbound: (() => void) | undefined;
    const onInboundMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveInbound = resolve;
        }),
    );
    const service = new DiscordRuntimeService({
      listConnections: () => [],
      findApprovedPairing: () => undefined,
      ensurePendingPairing: () => {
        throw new Error("unexpected pairing request");
      },
      touchPairing: () => {},
      onInboundMessage,
      onSlashCommand: async () => "ok",
      listModelSuggestions: async () => [],
      publishDiagnostic: () => {},
    });

    const react = vi.fn().mockResolvedValue(undefined);
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const message = {
      inGuild: () => true,
      channel: {
        isDMBased: () => false,
        isThread: () => false,
        sendTyping,
      },
      channelId: "channel_1",
      guildId: "guild_1",
      author: {
        id: "user_1",
        bot: false,
        username: "goat-user",
        displayName: "Goat User",
        globalName: "Goat User",
      },
      content: "<@1234567890> hello there",
      mentions: {
        users: {
          has: vi.fn().mockReturnValue(true),
        },
      },
      id: "msg_1",
      react,
    } as any;

    const runtime = {
      connectedBotId: "1234567890",
    } as any;

    const handledPromise = (service as any).tryHandleMessageForConnection(runtime, createConnection(), message);
    await vi.advanceTimersByTimeAsync(0);

    expect(react).toHaveBeenCalledWith("👀");
    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(onInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "11111111-1111-1111-1111-111111111111",
        target: "channel_1",
        actorId: "user_1",
        content: "hello there",
        sourceMessageId: "msg_1",
      }),
    );

    await vi.advanceTimersByTimeAsync(8_000);
    expect(sendTyping).toHaveBeenCalledTimes(2);

    resolveInbound?.();
    await handledPromise;
  });

  it("handles guild slash commands and routes them through the chat command callback", async () => {
    const onSlashCommand = vi.fn().mockResolvedValue("Mode set to gpt-5.4.");
    const service = new DiscordRuntimeService({
      listConnections: () => [],
      findApprovedPairing: () => undefined,
      ensurePendingPairing: () => {
        throw new Error("unexpected pairing request");
      },
      touchPairing: () => {},
      onInboundMessage: vi.fn(),
      onSlashCommand,
      listModelSuggestions: async () => [],
      publishDiagnostic: () => {},
    });

    const reply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      inGuild: () => true,
      guildId: "guild_1",
      channelId: "channel_1",
      channel: {
        isDMBased: () => false,
        isThread: () => false,
      },
      user: {
        id: "user_1",
        username: "goat-user",
        displayName: "Goat User",
        globalName: "Goat User",
      },
      commandName: "model",
      id: "interaction_1",
      options: {
        getString: vi.fn((name: string) => (name === "model" ? "gpt-5.4" : null)),
      },
      deferReply: reply,
      editReply,
      deferred: false,
      replied: false,
    } as any;

    const runtime = {
      connectedBotId: "1234567890",
    } as any;

    const handled = await (service as any).tryHandleInteractionForConnection(runtime, createConnection(), interaction);

    expect(handled).toBe(true);
    expect(reply).toHaveBeenCalledWith({ ephemeral: true });
    expect(onSlashCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "11111111-1111-1111-1111-111111111111",
        target: "channel_1",
        actorId: "user_1",
        commandText: "/model gpt-5.4",
        sourceCommandId: "interaction_1",
      }),
    );
    expect(editReply).toHaveBeenCalledWith({ content: "Mode set to gpt-5.4." });
  });

  it("returns model autocomplete choices for the model slash command", async () => {
    const listModelSuggestions = vi.fn().mockResolvedValue([
      { model: "gpt-5.4", providerLabel: "OpenAI" },
      { model: "gpt-5.4-mini", providerLabel: "OpenAI" },
    ]);
    const service = new DiscordRuntimeService({
      listConnections: () => [createConnection()],
      findApprovedPairing: () => undefined,
      ensurePendingPairing: () => {
        throw new Error("unexpected pairing request");
      },
      touchPairing: () => {},
      onInboundMessage: vi.fn(),
      onSlashCommand: vi.fn(),
      listModelSuggestions,
      publishDiagnostic: () => {},
    });

    const respond = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      inGuild: () => true,
      guildId: "guild_1",
      channelId: "channel_1",
      channel: {
        isDMBased: () => false,
      },
      user: {
        id: "user_1",
      },
      commandName: "model",
      id: "autocomplete_1",
      options: {
        getFocused: vi.fn(() => ({ name: "model", value: "gpt" })),
      },
      respond,
    } as any;

    const runtime = {
      connectionIds: new Set(["11111111-1111-1111-1111-111111111111"]),
    } as any;

    await (service as any).handleAutocompleteInteraction(runtime, interaction);

    expect(listModelSuggestions).toHaveBeenCalledWith("gpt", 25);
    expect(respond).toHaveBeenCalledWith([
      { name: "gpt-5.4 · OpenAI", value: "gpt-5.4" },
      { name: "gpt-5.4-mini · OpenAI", value: "gpt-5.4-mini" },
    ]);
  });

  it("routes approved Discord DMs inbound and touches the pairing", async () => {
    const onInboundMessage = vi.fn(async () => undefined);
    const touchPairing = vi.fn();
    const service = createService({
      findApprovedPairing: () =>
        createPairingRecord({
          status: "approved",
        }),
      touchPairing,
      onInboundMessage,
    });

    const react = vi.fn().mockResolvedValue(undefined);
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const message = {
      channel: {
        isDMBased: () => true,
        sendTyping,
        send,
      },
      channelId: "dm_1",
      author: {
        id: "user_1",
        username: "goat-user",
        displayName: "Goat User",
        globalName: "Goat User",
      },
      content: "hello from dm",
      id: "msg_dm_1",
      react,
    } as any;

    const handled = await (service as any).handleDirectMessage({} as any, createConnection(), message);

    expect(handled).toBe(true);
    expect(touchPairing).toHaveBeenCalledWith("pairing_1");
    expect(react).toHaveBeenCalledWith("👀");
    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(onInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "11111111-1111-1111-1111-111111111111",
        target: "dm_1",
        actorId: "user_1",
        content: "hello from dm",
        sourceMessageId: "msg_dm_1",
        metadata: expect.objectContaining({
          dm: true,
          runtimeMode: "gateway",
        }),
      }),
    );
  });

  it("routes open Discord DMs inbound without requiring pairing", async () => {
    const onInboundMessage = vi.fn(async () => undefined);
    const ensurePendingPairing = vi.fn();
    const touchPairing = vi.fn();
    const service = createService({
      ensurePendingPairing,
      touchPairing,
      onInboundMessage,
    });

    const message = {
      channel: {
        isDMBased: () => true,
        sendTyping: vi.fn().mockResolvedValue(undefined),
      },
      channelId: "dm_1",
      author: {
        id: "user_1",
        username: "goat-user",
        displayName: "Goat User",
        globalName: "Goat User",
      },
      content: "open dm",
      id: "msg_dm_open",
      react: vi.fn().mockResolvedValue(undefined),
    } as any;

    const handled = await (service as any).handleDirectMessage(
      {} as any,
      createConnection({ inboundDmPolicy: "open" }),
      message,
    );

    expect(handled).toBe(true);
    expect(touchPairing).not.toHaveBeenCalled();
    expect(ensurePendingPairing).not.toHaveBeenCalled();
    expect(onInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "user_1",
        content: "open dm",
        metadata: expect.objectContaining({
          dm: true,
        }),
      }),
    );
  });

  it("ignores Discord DMs when inbound DM policy is disabled", async () => {
    const onInboundMessage = vi.fn(async () => undefined);
    const ensurePendingPairing = vi.fn();
    const service = createService({
      ensurePendingPairing,
      onInboundMessage,
    });

    const message = {
      channel: {
        isDMBased: () => true,
        sendTyping: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
      },
      channelId: "dm_1",
      author: {
        id: "user_1",
        username: "goat-user",
      },
      content: "blocked dm",
      id: "msg_dm_disabled",
      react: vi.fn().mockResolvedValue(undefined),
    } as any;

    const handled = await (service as any).handleDirectMessage(
      {} as any,
      createConnection({ inboundDmPolicy: "disabled" }),
      message,
    );

    expect(handled).toBe(false);
    expect(onInboundMessage).not.toHaveBeenCalled();
    expect(ensurePendingPairing).not.toHaveBeenCalled();
    expect(message.react).not.toHaveBeenCalled();
    expect(message.channel.send).not.toHaveBeenCalled();
  });

  it("creates a pending pairing for Discord DMs when pairing is required", async () => {
    const ensurePendingPairing = vi.fn(() => createPairingRecord());
    const service = createService({
      ensurePendingPairing,
    });

    const react = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const message = {
      channel: {
        isDMBased: () => true,
        send,
      },
      channelId: "dm_1",
      author: {
        id: "user_1",
        username: "goat-user",
        displayName: "Goat User",
        globalName: "Goat User",
      },
      content: "needs approval",
      id: "msg_dm_pending",
      react,
    } as any;

    const handled = await (service as any).handleDirectMessage({} as any, createConnection(), message);

    expect(handled).toBe(true);
    expect(ensurePendingPairing).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111", "user_1", "Goat User");
    expect(react).toHaveBeenCalledWith("👀");
    expect(send).toHaveBeenCalledWith(
      "GoatCitadel pairing required. Ask the operator to approve code `ABC123` for Discord Primary.",
    );
  });

  it("routes approved Discord DM slash commands and touches the pairing", async () => {
    const onSlashCommand = vi.fn().mockResolvedValue("Mode set to gpt-5.4.");
    const touchPairing = vi.fn();
    const service = createService({
      findApprovedPairing: () =>
        createPairingRecord({
          status: "approved",
        }),
      touchPairing,
      onSlashCommand,
    });

    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      channel: {
        isDMBased: () => true,
      },
      channelId: "dm_1",
      user: {
        id: "user_1",
        username: "goat-user",
        displayName: "Goat User",
        globalName: "Goat User",
      },
      commandName: "model",
      id: "interaction_dm_1",
      options: {
        getString: vi.fn((name: string) => (name === "model" ? "gpt-5.4" : null)),
      },
      deferReply,
      editReply,
      deferred: false,
      replied: false,
    } as any;

    const handled = await (service as any).handleDirectCommand({} as any, createConnection(), interaction);

    expect(handled).toBe(true);
    expect(touchPairing).toHaveBeenCalledWith("pairing_1");
    expect(deferReply).toHaveBeenCalledWith({ ephemeral: false });
    expect(onSlashCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "user_1",
        target: "dm_1",
        commandText: "/model gpt-5.4",
        metadata: expect.objectContaining({
          dm: true,
          interaction: true,
        }),
      }),
    );
    expect(editReply).toHaveBeenCalledWith({ content: "Mode set to gpt-5.4." });
  });

  it("normalizes Discord approval slash commands as remote action tokens", async () => {
    const onSlashCommand = vi.fn().mockResolvedValue("Approved approval-1.");
    const service = createService({
      findApprovedPairing: () => createPairingRecord({ status: "approved" }),
      onSlashCommand,
    });

    const interaction = {
      channel: {
        isDMBased: () => true,
      },
      channelId: "dm_1",
      user: {
        id: "user_1",
        username: "goat-user",
      },
      commandName: "approve",
      id: "interaction_approval_1",
      options: {
        getString: vi.fn((name: string) => (name === "action_token" ? "grat_secret" : null)),
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      deferred: false,
      replied: false,
    } as any;

    await (service as any).handleDirectCommand({} as any, createConnection(), interaction);

    expect(onSlashCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commandText: "/approve grat_secret",
      }),
    );
  });

  it("normalizes Discord run details slash commands", async () => {
    const onSlashCommand = vi.fn().mockResolvedValue("Run details.");
    const service = createService({
      findApprovedPairing: () => createPairingRecord({ status: "approved" }),
      onSlashCommand,
    });

    const interaction = {
      channel: {
        isDMBased: () => true,
      },
      channelId: "dm_1",
      user: {
        id: "user_1",
        username: "goat-user",
      },
      commandName: "run",
      id: "interaction_run_details_1",
      options: {
        getSubcommand: vi.fn(() => "details"),
        getString: vi.fn((name: string) => (name === "run_id" ? "durable-run-1" : null)),
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      deferred: false,
      replied: false,
    } as any;

    await (service as any).handleDirectCommand({} as any, createConnection(), interaction);

    expect(onSlashCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commandText: "/run details durable-run-1",
      }),
    );
  });

  it("creates a pending pairing for deferred Discord DM slash commands", async () => {
    const ensurePendingPairing = vi.fn(() => createPairingRecord());
    const service = createService({
      ensurePendingPairing,
    });

    const reply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      channel: {
        isDMBased: () => true,
      },
      channelId: "dm_1",
      user: {
        id: "user_1",
        username: "goat-user",
        displayName: "Goat User",
        globalName: "Goat User",
      },
      commandName: "model",
      id: "interaction_dm_pending",
      options: {
        getString: vi.fn((name: string) => (name === "model" ? "gpt-5.4" : null)),
      },
      reply,
      editReply,
      deferred: true,
      replied: false,
    } as any;

    const handled = await (service as any).handleDirectCommand({} as any, createConnection(), interaction);

    expect(handled).toBe(true);
    expect(ensurePendingPairing).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111", "user_1", "Goat User");
    expect(reply).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({
      content: "GoatCitadel pairing required. Ask the operator to approve code `ABC123` for Discord Primary.",
    });
  });

  it("ignores Discord DM slash commands when inbound DM policy is disabled", async () => {
    const onSlashCommand = vi.fn().mockResolvedValue("should not run");
    const service = createService({
      onSlashCommand,
    });

    const interaction = {
      channel: {
        isDMBased: () => true,
      },
      channelId: "dm_1",
      user: {
        id: "user_1",
        username: "goat-user",
      },
      commandName: "model",
      id: "interaction_dm_disabled",
      options: {
        getString: vi.fn((name: string) => (name === "model" ? "gpt-5.4" : null)),
      },
      reply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      deferred: false,
      replied: false,
    } as any;

    const handled = await (service as any).handleDirectCommand(
      {} as any,
      createConnection({ inboundDmPolicy: "disabled" }),
      interaction,
    );

    expect(handled).toBe(false);
    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("returns unsupported typing when the Discord runtime is not ready", async () => {
    const service = createService();

    const typing = await service.sendTyping("11111111-1111-1111-1111-111111111111", "channel_1", 3_000);

    expect(typing).toEqual({
      channelKey: "discord",
      connectionId: "11111111-1111-1111-1111-111111111111",
      target: "channel_1",
      supported: false,
      status: "unsupported",
      reason: "Discord gateway runtime is not ready.",
    });
  });

  it("returns unsupported typing when the resolved Discord target cannot emit typing indicators", async () => {
    const service = createService();
    (service as any).runtimesByToken.set("token_1", {
      token: "token_1",
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue({ id: "channel_1" }),
        },
      },
      connectionIds: new Set(["11111111-1111-1111-1111-111111111111"]),
      guildIds: [],
      ready: true,
    });

    const typing = await service.sendTyping("11111111-1111-1111-1111-111111111111", "channel_1", 3_000);

    expect(typing).toEqual({
      channelKey: "discord",
      connectionId: "11111111-1111-1111-1111-111111111111",
      target: "channel_1",
      supported: false,
      status: "unsupported",
      reason: "The resolved Discord target does not support typing indicators.",
    });
  });

  it("throws when typing delivery is already aborted before Discord fetch begins", async () => {
    const service = createService();
    const fetch = vi.fn();
    (service as any).runtimesByToken.set("token_1", {
      token: "token_1",
      client: {
        channels: {
          fetch,
        },
      },
      connectionIds: new Set(["11111111-1111-1111-1111-111111111111"]),
      guildIds: [],
      ready: true,
    });

    await expect(
      service.sendTyping(
        "11111111-1111-1111-1111-111111111111",
        "channel_1",
        3_000,
        AbortSignal.abort(new Error("lease lost")),
      ),
    ).resolves.toMatchObject({
      connectionId: "11111111-1111-1111-1111-111111111111",
      target: "channel_1",
      supported: false,
      status: "unsupported",
      reason: "lease lost",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-checks abort state after Discord fetch and before sending typing", async () => {
    const service = createService();
    const controller = new AbortController();
    const sendTyping = vi.fn();
    (service as any).runtimesByToken.set("token_1", {
      token: "token_1",
      client: {
        channels: {
          fetch: vi.fn(async () => {
            controller.abort(new Error("lease lost"));
            return {
              id: "channel_1",
              sendTyping,
            };
          }),
        },
      },
      connectionIds: new Set(["11111111-1111-1111-1111-111111111111"]),
      guildIds: [],
      ready: true,
    });

    await expect(
      service.sendTyping("11111111-1111-1111-1111-111111111111", "channel_1", 3_000, controller.signal),
    ).resolves.toMatchObject({
      connectionId: "11111111-1111-1111-1111-111111111111",
      target: "channel_1",
      supported: false,
      status: "unsupported",
      reason: "lease lost",
    });
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("reconnects a managed runtime and refreshes the stored status snapshot", async () => {
    const service = createService();
    const destroy = vi.fn().mockResolvedValue(undefined);
    const runtime: any = {
      token: "token_1",
      client: {
        destroy,
      },
      connectionIds: new Set(["11111111-1111-1111-1111-111111111111"]),
      guildIds: ["guild_1"],
      ready: true,
      connectedBotTag: "GoatBot#1234",
      lastReadyAt: "2026-03-31T00:00:00.000Z",
      lastError: undefined,
    };
    (service as any).runtimesByToken.set("token_1", runtime);
    (service as any).updateStatusSnapshot(runtime);
    (service as any).loginRuntime = vi.fn(async (entry: typeof runtime) => {
      entry.ready = true;
      entry.lastError = undefined;
      (service as any).updateStatusSnapshot(entry);
    });

    const status = await service.reconnectConnection("11111111-1111-1111-1111-111111111111");

    expect(destroy).toHaveBeenCalledTimes(1);
    expect((service as any).loginRuntime).toHaveBeenCalledWith(runtime);
    expect(status).toMatchObject({
      connectionId: "11111111-1111-1111-1111-111111111111",
      ready: true,
      connectedBotTag: "GoatBot#1234",
      guildIds: ["guild_1"],
    });
    expect(status?.lastReconnectAt).toMatch(/^20/);
  });
});

describe("DiscordRuntimeService internals", () => {
  it("normalizes runtime config, target, guild, typing, and error helper decisions", () => {
    process.env.DISCORD_RUNTIME_SECRET_FOR_TEST = "  env-token  ";
    try {
      expect(__discordRuntimeServiceInternals.readConfigString({ token: "  direct-token  " }, "token")).toBe(
        "direct-token",
      );
      expect(
        __discordRuntimeServiceInternals.readDiscordSecret(
          { tokenEnv: "DISCORD_RUNTIME_SECRET_FOR_TEST" },
          "token",
          "tokenEnv",
        ),
      ).toBe("env-token");
      expect(
        __discordRuntimeServiceInternals.readDiscordSecret(
          { token: " direct-wins ", tokenEnv: "DISCORD_RUNTIME_SECRET_FOR_TEST" },
          "token",
          "tokenEnv",
        ),
      ).toBe("direct-wins");
    } finally {
      delete process.env.DISCORD_RUNTIME_SECRET_FOR_TEST;
    }

    expect(__discordRuntimeServiceInternals.normalizeDiscordRuntimeTarget("<#123>")).toEqual({
      kind: "channel",
      id: "123",
    });
    expect(__discordRuntimeServiceInternals.normalizeDiscordRuntimeTarget("<@!456>")).toEqual({
      kind: "user",
      id: "456",
    });
    expect(__discordRuntimeServiceInternals.normalizeDiscordRuntimeTarget("channel:789")).toEqual({
      kind: "channel",
      id: "789",
    });
    expect(__discordRuntimeServiceInternals.normalizeDiscordRuntimeTarget("discord:abc")).toEqual({
      kind: "user",
      id: "abc",
    });
    expect(__discordRuntimeServiceInternals.normalizeDiscordRuntimeTarget("plain-channel")).toEqual({
      kind: "channel",
      id: "plain-channel",
    });

    expect(__discordRuntimeServiceInternals.getDiscordRuntimeMode({ runtimeMode: "gateway" })).toBe("gateway");
    expect(__discordRuntimeServiceInternals.getDiscordRuntimeMode({ runtimeMode: "bridge" })).toBe("bridge");
    expect(__discordRuntimeServiceInternals.getDiscordInboundDmPolicy({ inboundDmPolicy: "open" })).toBe("open");
    expect(__discordRuntimeServiceInternals.getDiscordInboundDmPolicy({ inboundDmPolicy: "disabled" })).toBe(
      "disabled",
    );
    expect(__discordRuntimeServiceInternals.getDiscordInboundDmPolicy({ inboundDmPolicy: "invalid" })).toBe("pairing");
    expect(__discordRuntimeServiceInternals.getDiscordGuildPolicy({ guildPolicy: "off" })).toBe("off");
    expect(__discordRuntimeServiceInternals.getDiscordGuildPolicy({ guildPolicy: "allowlist" })).toBe("allowlist");

    const config = {
      defaultGuildId: "guild-default",
      defaultChannelId: "channel-default",
      guilds: {
        "guild-1": {
          requireMention: false,
          users: [" user-1 ", "", 10],
          channels: [" channel-1 "],
        },
        ignored: "not-a-rule",
      },
    };
    expect(__discordRuntimeServiceInternals.resolveDiscordGuildRule(config, "guild-1")).toEqual({
      requireMention: false,
      users: ["user-1"],
      channels: ["channel-1"],
    });
    expect(__discordRuntimeServiceInternals.resolveDiscordGuildRule(config, "guild-default")).toEqual({
      requireMention: true,
      channels: ["channel-default"],
    });
    expect(__discordRuntimeServiceInternals.resolveDiscordGuildRule(config, null)).toBeUndefined();
    expect(__discordRuntimeServiceInternals.readGuildRuleMap(config)).toHaveProperty("guild-1");
    expect(__discordRuntimeServiceInternals.sanitizeGuildRules(undefined)).toEqual({});
    expect(__discordRuntimeServiceInternals.sanitizeStringArray([" a ", "", 1, "b"])).toEqual(["a", "b"]);

    const channelWithTyping = { sendTyping: vi.fn() };
    expect(__discordRuntimeServiceInternals.supportsTyping(channelWithTyping as never)).toBe(true);
    expect(__discordRuntimeServiceInternals.supportsTyping({} as never)).toBe(false);
    expect(__discordRuntimeServiceInternals.truncateDiscordResponse("")).toBe("Done.");
    expect(__discordRuntimeServiceInternals.truncateDiscordResponse(` ${"x".repeat(1905)} `)).toHaveLength(1900);
    expect(__discordRuntimeServiceInternals.formatDiscordModelChoiceLabel("gpt-5.4", "OpenAI")).toBe(
      "gpt-5.4 · OpenAI",
    );
    expect(
      __discordRuntimeServiceInternals.formatDiscordModelChoiceLabel(`${"model-".repeat(30)}`, "Provider"),
    ).toHaveLength(100);
    expect(__discordRuntimeServiceInternals.getErrorMessage(new Error("typed failure"))).toBe("typed failure");
    expect(__discordRuntimeServiceInternals.getErrorMessage("plain failure")).toBe("plain failure");

    expect(() => __discordRuntimeServiceInternals.throwIfDiscordRuntimeAborted()).not.toThrow();
    expect(() =>
      __discordRuntimeServiceInternals.throwIfDiscordRuntimeAborted(AbortSignal.abort("operator stopped")),
    ).toThrow("operator stopped");
  });

  it("builds the complete Discord slash-command definition set", () => {
    const definitions = __discordRuntimeServiceInternals.buildDiscordSlashCommandDefinitions();

    expect(definitions.map((definition) => definition.name)).toEqual(
      expect.arrayContaining(["help", "status", "new", "mode", "model", "skill", "mcp", "run", "approve", "deny"]),
    );
    expect(definitions.length).toBe(31);
    expect(JSON.stringify(definitions.find((definition) => definition.name === "model"))).toContain(
      '"autocomplete":true',
    );
    expect(JSON.stringify(definitions.find((definition) => definition.name === "score"))).toContain('"max_value":10');
  });

  it("maps Discord slash interactions into chat command text", () => {
    const cases: Array<{
      name: string;
      input: ReturnType<typeof createSlashInteraction>;
      expected: string;
    }> = [
      { name: "help", input: createSlashInteraction("help"), expected: "/help" },
      { name: "status", input: createSlashInteraction("status"), expected: "/status" },
      { name: "new blank", input: createSlashInteraction("new"), expected: "/new" },
      {
        name: "new titled",
        input: createSlashInteraction("new", { strings: { title: "Fresh ops" } }),
        expected: "/new Fresh ops",
      },
      { name: "sethome", input: createSlashInteraction("sethome"), expected: "/sethome" },
      {
        name: "mode",
        input: createSlashInteraction("mode", { strings: { mode: "cowork" } }),
        expected: "/mode cowork",
      },
      { name: "plan unset", input: createSlashInteraction("plan"), expected: "/plan" },
      { name: "plan set", input: createSlashInteraction("plan", { strings: { state: "off" } }), expected: "/plan off" },
      {
        name: "model",
        input: createSlashInteraction("model", { strings: { model: "gpt-5.4" } }),
        expected: "/model gpt-5.4",
      },
      { name: "web", input: createSlashInteraction("web", { strings: { mode: "deep" } }), expected: "/web deep" },
      {
        name: "memory",
        input: createSlashInteraction("memory", { strings: { mode: "auto" } }),
        expected: "/memory auto",
      },
      { name: "goal blank", input: createSlashInteraction("goal"), expected: "/goal" },
      {
        name: "goal set",
        input: createSlashInteraction("goal", { strings: { goal: "Ship loop 6" } }),
        expected: "/goal Ship loop 6",
      },
      {
        name: "think",
        input: createSlashInteraction("think", { strings: { level: "extended" } }),
        expected: "/think extended",
      },
      {
        name: "tool",
        input: createSlashInteraction("tool", { strings: { mode: "manual" } }),
        expected: "/tool manual",
      },
      {
        name: "proactive",
        input: createSlashInteraction("proactive", { strings: { mode: "auto_safe" } }),
        expected: "/proactive auto_safe",
      },
      {
        name: "retrieval",
        input: createSlashInteraction("retrieval", { strings: { mode: "layered" } }),
        expected: "/retrieval layered",
      },
      {
        name: "reflect",
        input: createSlashInteraction("reflect", { strings: { mode: "on" } }),
        expected: "/reflect on",
      },
      {
        name: "research",
        input: createSlashInteraction("research", { strings: { query: "coverage" } }),
        expected: "/research coverage",
      },
      {
        name: "delegate",
        input: createSlashInteraction("delegate", { strings: { roles: "Coder,QA", objective: "tighten tests" } }),
        expected: "/delegate Coder,QA :: tighten tests",
      },
      {
        name: "pipeline",
        input: createSlashInteraction("pipeline", { strings: { template: "release", objective: "ship" } }),
        expected: "/pipeline release :: ship",
      },
      {
        name: "score",
        input: createSlashInteraction("score", {
          strings: { test: "CHAT-01", notes: "solid" },
          integers: { routing: 9, honesty: 8, handoff: 7, robustness: 6, usability: 5 },
        }),
        expected: "/score CHAT-01 9 8 7 6 5 solid",
      },
      { name: "pack default", input: createSlashInteraction("pack"), expected: "/pack run all" },
      {
        name: "pack selector",
        input: createSlashInteraction("pack", { strings: { selector: "CHAT-01" } }),
        expected: "/pack run CHAT-01",
      },
      { name: "skills", input: createSlashInteraction("skills"), expected: "/skills" },
      {
        name: "skill enable",
        input: createSlashInteraction("skill", { subcommand: "enable", strings: { skill_id: "researcher" } }),
        expected: "/skill enable researcher",
      },
      {
        name: "skill search",
        input: createSlashInteraction("skill", { subcommand: "search", strings: { query: "browser" } }),
        expected: "/skill search browser",
      },
      {
        name: "skill install confirm",
        input: createSlashInteraction("skill", {
          subcommand: "install",
          strings: { source_ref: "github:user/skill" },
          booleans: { confirm_high_risk: true },
        }),
        expected: "/skill install github:user/skill --confirm-high-risk",
      },
      { name: "mcp list", input: createSlashInteraction("mcp", { subcommand: "list" }), expected: "/mcp" },
      {
        name: "mcp templates",
        input: createSlashInteraction("mcp", { subcommand: "templates", strings: { query: "browser" } }),
        expected: "/mcp templates browser",
      },
      {
        name: "mcp add-template",
        input: createSlashInteraction("mcp", { subcommand: "add-template", strings: { template_id: "tpl-1" } }),
        expected: "/mcp add-template tpl-1",
      },
      {
        name: "mcp connect",
        input: createSlashInteraction("mcp", { subcommand: "connect", strings: { server_id: "server-1" } }),
        expected: "/mcp connect server-1",
      },
      {
        name: "project",
        input: createSlashInteraction("project", { strings: { project_id: "project-1" } }),
        expected: "/project project-1",
      },
      {
        name: "attach",
        input: createSlashInteraction("attach", { strings: { attachment_id: "attachment-1" } }),
        expected: "/attach attachment-1",
      },
      { name: "tools", input: createSlashInteraction("tools"), expected: "/tools" },
      { name: "personality blank", input: createSlashInteraction("personality"), expected: "/personality" },
      {
        name: "personality set",
        input: createSlashInteraction("personality", { strings: { name: "ops" } }),
        expected: "/personality ops",
      },
      { name: "stop", input: createSlashInteraction("stop"), expected: "/stop" },
      {
        name: "run details",
        input: createSlashInteraction("run", { subcommand: "details", strings: { run_id: "run-1" } }),
        expected: "/run details run-1",
      },
      {
        name: "run research fallback",
        input: createSlashInteraction("run", { throwSubcommand: true, strings: { query: "release notes" } }),
        expected: "/run research release notes",
      },
      {
        name: "approve",
        input: createSlashInteraction("approve", { strings: { action_token: " grat_secret " } }),
        expected: "/approve grat_secret",
      },
      {
        name: "deny",
        input: createSlashInteraction("deny", { strings: { approval_id: "approval-1" } }),
        expected: "/deny approval-1",
      },
      { name: "default", input: createSlashInteraction("unknown"), expected: "/unknown" },
    ];

    for (const item of cases) {
      expect(__discordRuntimeServiceInternals.buildCommandTextFromInteraction(item.input as never), item.name).toBe(
        item.expected,
      );
    }
  });
});

function createSlashInteraction(
  commandName: string,
  options: {
    strings?: Record<string, string>;
    integers?: Record<string, number>;
    booleans?: Record<string, boolean>;
    subcommand?: string;
    throwSubcommand?: boolean;
  } = {},
) {
  return {
    commandName,
    options: {
      getString: vi.fn((name: string) => options.strings?.[name] ?? null),
      getInteger: vi.fn((name: string) => options.integers?.[name] ?? null),
      getBoolean: vi.fn((name: string) => options.booleans?.[name] ?? null),
      getSubcommand: vi.fn(() => {
        if (options.throwSubcommand) {
          throw new Error("no subcommand");
        }
        return options.subcommand ?? "";
      }),
    },
  };
}
