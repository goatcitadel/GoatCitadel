import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordPairingRecord, IntegrationConnection } from "@goatcitadel/contracts";
import { DiscordRuntimeService } from "./discord-runtime-service.js";

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

function createPairingRecord(
  overrides: Partial<DiscordPairingRecord> = {},
): DiscordPairingRecord {
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
    const onInboundMessage = vi.fn(() => new Promise<void>((resolve) => {
      resolveInbound = resolve;
    }));
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
    expect(onInboundMessage).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "11111111-1111-1111-1111-111111111111",
      target: "channel_1",
      actorId: "user_1",
      content: "hello there",
      sourceMessageId: "msg_1",
    }));

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
        getString: vi.fn((name: string) => name === "model" ? "gpt-5.4" : null),
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
    expect(onSlashCommand).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "11111111-1111-1111-1111-111111111111",
      target: "channel_1",
      actorId: "user_1",
      commandText: "/model gpt-5.4",
      sourceCommandId: "interaction_1",
    }));
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
      findApprovedPairing: () => createPairingRecord({
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
    expect(onInboundMessage).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "11111111-1111-1111-1111-111111111111",
      target: "dm_1",
      actorId: "user_1",
      content: "hello from dm",
      sourceMessageId: "msg_dm_1",
      metadata: expect.objectContaining({
        dm: true,
        runtimeMode: "gateway",
      }),
    }));
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
    expect(onInboundMessage).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "user_1",
      content: "open dm",
      metadata: expect.objectContaining({
        dm: true,
      }),
    }));
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
    expect(ensurePendingPairing).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "user_1",
      "Goat User",
    );
    expect(react).toHaveBeenCalledWith("👀");
    expect(send).toHaveBeenCalledWith(
      "GoatCitadel pairing required. Ask the operator to approve code `ABC123` for Discord Primary.",
    );
  });

  it("routes approved Discord DM slash commands and touches the pairing", async () => {
    const onSlashCommand = vi.fn().mockResolvedValue("Mode set to gpt-5.4.");
    const touchPairing = vi.fn();
    const service = createService({
      findApprovedPairing: () => createPairingRecord({
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
        getString: vi.fn((name: string) => name === "model" ? "gpt-5.4" : null),
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
    expect(onSlashCommand).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "user_1",
      target: "dm_1",
      commandText: "/model gpt-5.4",
      metadata: expect.objectContaining({
        dm: true,
        interaction: true,
      }),
    }));
    expect(editReply).toHaveBeenCalledWith({ content: "Mode set to gpt-5.4." });
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
        getString: vi.fn((name: string) => name === "model" ? "gpt-5.4" : null),
      },
      reply,
      editReply,
      deferred: true,
      replied: false,
    } as any;

    const handled = await (service as any).handleDirectCommand({} as any, createConnection(), interaction);

    expect(handled).toBe(true);
    expect(ensurePendingPairing).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "user_1",
      "Goat User",
    );
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
        getString: vi.fn((name: string) => name === "model" ? "gpt-5.4" : null),
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

    const typing = await service.sendTyping(
      "11111111-1111-1111-1111-111111111111",
      "channel_1",
      3_000,
    );

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

    const typing = await service.sendTyping(
      "11111111-1111-1111-1111-111111111111",
      "channel_1",
      3_000,
    );

    expect(typing).toEqual({
      channelKey: "discord",
      connectionId: "11111111-1111-1111-1111-111111111111",
      target: "channel_1",
      supported: false,
      status: "unsupported",
      reason: "The resolved Discord target does not support typing indicators.",
    });
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
