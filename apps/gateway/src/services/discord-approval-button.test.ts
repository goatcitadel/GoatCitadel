import { describe, expect, it, vi } from "vitest";
import type { DiscordPairingRecord, IntegrationConnection } from "@goatcitadel/contracts";
import { buildDiscordApprovalButtonCommandText, parseDiscordApprovalButtonId } from "./discord-approval-button.js";
import { DiscordRuntimeService } from "./discord-runtime-service.js";

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";
const RAW_TOKEN = `grat_${"d".repeat(43)}`;

describe("parseDiscordApprovalButtonId", () => {
  it("reads the token and decision from an approval button's custom_id", () => {
    expect(parseDiscordApprovalButtonId(`gca:${RAW_TOKEN}:a`)).toEqual({ token: RAW_TOKEN, decision: "approve" });
    expect(parseDiscordApprovalButtonId(`gca:${RAW_TOKEN}:r`)).toEqual({ token: RAW_TOKEN, decision: "reject" });
    expect(buildDiscordApprovalButtonCommandText({ token: RAW_TOKEN, decision: "reject" })).toBe(`/deny ${RAW_TOKEN}`);
  });

  it.each(["", "gca::a", `gca:${RAW_TOKEN}:x`, `gca:${RAW_TOKEN}:a:extra`, `GCA:${RAW_TOKEN}:A`, "other-component"])(
    "ignores the custom_id %j",
    (customId) => {
      expect(parseDiscordApprovalButtonId(customId)).toBeUndefined();
    },
  );
});

describe("DiscordRuntimeService approval buttons", () => {
  it("hands a paired user's press in a DM to the durable owner and answers privately", async () => {
    const harness = createHarness({ pairing: createPairing() });
    const interaction = createButtonInteraction(`gca:${RAW_TOKEN}:a`);

    await harness.press(interaction);

    expect(harness.acceptSlashCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        target: "dm_1",
        actorId: "user_1",
        sourceCommandId: "interaction_button_1",
        commandText: `/approve ${RAW_TOKEN}`,
        eventType: "discord-approval-button",
        conversation: expect.objectContaining({ kind: "direct" }),
        metadata: expect.objectContaining({ dm: true, interaction: true }),
      }),
    );
    expect(harness.touchPairing).toHaveBeenCalledWith("pairing_1");
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(harness.awaitSlashCommandResult).toHaveBeenCalledWith("inbound-button-1");
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "Approved." });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("acknowledges the press before it reads any connection or records the command", async () => {
    let releaseConnections: () => void = () => {};
    const connectionsRead = new Promise<void>((resolve) => {
      releaseConnections = resolve;
    });
    const harness = createHarness({ pairing: createPairing(), connectionsRead });
    const interaction = createButtonInteraction(`gca:${RAW_TOKEN}:a`);

    const pressed = harness.press(interaction);
    // Discord needs an answer within 3 seconds; the slow reads after the deferral don't hold it up.
    await vi.waitFor(() => expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true }));
    expect(harness.acceptSlashCommand).not.toHaveBeenCalled();
    releaseConnections();
    await pressed;

    expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      harness.listConnections.mock.invocationCallOrder[0]!,
    );
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "Approved." });
  });

  it("acts on nothing when Discord refuses the acknowledgement", async () => {
    const harness = createHarness({ pairing: createPairing() });
    const interaction = createButtonInteraction(`gca:${RAW_TOKEN}:a`);
    interaction.deferReply.mockRejectedValueOnce(new Error("Unknown interaction"));

    await harness.press(interaction);

    expect(harness.listConnections).not.toHaveBeenCalled();
    expect(harness.acceptSlashCommand).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("refuses a DM press from a user who is not paired, even when DMs are open", async () => {
    const harness = createHarness({ config: { inboundDmPolicy: "open" } });
    const interaction = createButtonInteraction(`gca:${RAW_TOKEN}:r`);

    await harness.press(interaction);

    expect(harness.acceptSlashCommand).not.toHaveBeenCalled();
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Approve this Discord user in GoatCitadel before answering approvals.",
    });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("ignores a button that is not an approval button", async () => {
    const harness = createHarness({ pairing: createPairing() });
    const interaction = createButtonInteraction("gca:not-a-decision");

    await harness.press(interaction);

    expect(harness.listConnections).not.toHaveBeenCalled();
    expect(harness.acceptSlashCommand).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it("lets a guild press in only through the guild's allowlist", async () => {
    const harness = createHarness();
    const allowed = createButtonInteraction(`gca:${RAW_TOKEN}:a`, { guild: { channelId: "channel_1" } });
    const elsewhere = createButtonInteraction(`gca:${RAW_TOKEN}:a`, { guild: { channelId: "channel_other" } });

    await harness.press(allowed);
    await harness.press(elsewhere);

    expect(harness.acceptSlashCommand).toHaveBeenCalledTimes(1);
    expect(harness.acceptSlashCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "channel_1",
        metadata: expect.objectContaining({ guildId: "guild_1", channelId: "channel_1" }),
      }),
    );
    expect(allowed.deferReply).toHaveBeenCalledTimes(1);
    expect(allowed.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(elsewhere.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(elsewhere.editReply).toHaveBeenCalledWith({
      content: "GoatCitadel is not enabled for approvals in this channel or DM route.",
    });
  });
});

describe("DiscordRuntimeService clearMessageComponents", () => {
  function serviceWithChannel(channel: unknown, options: { ready?: boolean } = {}) {
    const service = createHarness().service;
    const edit = vi.fn(async () => undefined);
    const resolved = channel === "text" ? { messages: { edit } } : channel;
    const fetchChannel = vi.fn(async () => resolved);
    const createDM = vi.fn(async () => ({ messages: { edit } }));
    (service as unknown as { runtimesByToken: Map<string, unknown> }).runtimesByToken.set("token-1", {
      connectionIds: new Set([CONNECTION_ID]),
      ready: options.ready ?? true,
      client: { channels: { fetch: fetchChannel }, users: { fetch: vi.fn(async () => ({ createDM })) } },
    });
    return { service, edit, fetchChannel, createDM };
  }

  it("removes every component from the message the bot sent", async () => {
    const { service, edit, fetchChannel } = serviceWithChannel("text");

    await service.clearMessageComponents(CONNECTION_ID, "channel_1", "message_1");

    expect(fetchChannel).toHaveBeenCalledWith("channel_1");
    expect(edit).toHaveBeenCalledWith("message_1", { components: [] });
  });

  it("refuses when the bot isn't connected, or the target holds no messages", async () => {
    await expect(
      serviceWithChannel("text", { ready: false }).service.clearMessageComponents(CONNECTION_ID, "channel_1", "m"),
    ).rejects.toThrow("Discord gateway runtime is not ready.");
    await expect(
      serviceWithChannel({ type: "voice" }).service.clearMessageComponents(CONNECTION_ID, "channel_1", "m"),
    ).rejects.toThrow("The Discord target has no messages to edit.");
    await expect(
      serviceWithChannel("text").service.clearMessageComponents("other-connection", "channel_1", "m"),
    ).rejects.toThrow("Discord gateway runtime is not ready.");
  });
});

function createHarness(
  options: { pairing?: DiscordPairingRecord; config?: Record<string, unknown>; connectionsRead?: Promise<void> } = {},
) {
  const connection = createConnection(options.config);
  const listConnections = vi.fn(async () => {
    await options.connectionsRead;
    return [connection];
  });
  const touchPairing = vi.fn(async () => {});
  const acceptSlashCommand = vi.fn(async () => ({ inboundEventId: "inbound-button-1" }));
  const awaitSlashCommandResult = vi.fn(async () => "Approved.");
  const service = new DiscordRuntimeService({
    listConnections,
    findApprovedPairing: async (_connectionId, userId) =>
      options.pairing && options.pairing.userId === userId ? options.pairing : undefined,
    ensurePendingPairing: () => {
      throw new Error("a button press never starts a pairing");
    },
    touchPairing,
    onInboundMessage: vi.fn(),
    acceptSlashCommand,
    awaitSlashCommandResult,
    listModelSuggestions: async () => [],
    publishDiagnostic: () => {},
  });
  const runtime = { connectionIds: new Set([CONNECTION_ID]), client: {}, guildIds: [] } as never;
  const press = (interaction: ReturnType<typeof createButtonInteraction>) =>
    (
      service as unknown as { handleApprovalButton(runtime: unknown, interaction: unknown): Promise<void> }
    ).handleApprovalButton(runtime, interaction);
  return { service, press, listConnections, touchPairing, acceptSlashCommand, awaitSlashCommandResult };
}

function createButtonInteraction(customId: string, options: { guild?: { channelId: string } } = {}) {
  const guild = options.guild;
  return {
    id: "interaction_button_1",
    customId,
    inGuild: () => Boolean(guild),
    guildId: guild ? "guild_1" : null,
    channelId: guild?.channelId ?? "dm_1",
    channel: {
      isDMBased: () => !guild,
      isThread: () => false,
      ...(guild ? { name: "approvals" } : {}),
    },
    user: { id: "user_1", username: "goat-user", displayName: "Goat User", globalName: "Goat User" },
    member: null,
    reply: vi.fn(async () => undefined),
    deferReply: vi.fn(async (_options: { ephemeral: boolean }): Promise<void> => undefined),
    editReply: vi.fn(async () => undefined),
  };
}

function createConnection(config: Record<string, unknown> = {}): IntegrationConnection {
  return {
    connectionId: CONNECTION_ID,
    catalogId: "channel.discord",
    kind: "channel",
    key: "discord",
    label: "Discord Primary",
    enabled: true,
    status: "connected",
    config: {
      runtimeMode: "gateway",
      guildPolicy: "allowlist",
      guilds: { guild_1: { requireMention: true, channels: ["channel_1"] } },
      ...config,
    },
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

function createPairing(): DiscordPairingRecord {
  return {
    pairingId: "pairing_1",
    connectionId: CONNECTION_ID,
    userId: "user_1",
    code: "ABC123",
    status: "approved",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}
