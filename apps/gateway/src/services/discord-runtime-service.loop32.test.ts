import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordRuntimeService } from "./discord-runtime-service.js";
import { __discordRuntimeServiceInternals } from "./discord-runtime-service.js";

afterEach(() => {
  vi.useRealTimers();
  delete process.env.GOATCITADEL_DISCORD_LOOP32_TOKEN;
});

describe("discord runtime service loop32 internals", () => {
  it("normalizes runtime config, guild rules, targets, and bounded response text", () => {
    process.env.GOATCITADEL_DISCORD_LOOP32_TOKEN = " env-token ";
    const config = {
      runtimeMode: "gateway",
      inboundDmPolicy: "open",
      guildPolicy: "off",
      botTokenEnv: "GOATCITADEL_DISCORD_LOOP32_TOKEN",
      defaultGuildId: "guild-default",
      defaultChannelId: "channel-default",
      guilds: {
        "guild-1": {
          requireMention: false,
          users: [" user-1 ", "", 123],
          channels: [" channel-1 ", "channel-2"],
        },
        "guild-empty": {
          users: [],
          channels: [],
        },
        ignored: null,
      },
    };

    expect(__discordRuntimeServiceInternals.getDiscordRuntimeMode(config)).toBe("gateway");
    expect(__discordRuntimeServiceInternals.getDiscordInboundDmPolicy(config)).toBe("open");
    expect(__discordRuntimeServiceInternals.getDiscordGuildPolicy(config)).toBe("off");
    expect(__discordRuntimeServiceInternals.readDiscordSecret(config, "botToken", "botTokenEnv")).toBe("env-token");
    expect(__discordRuntimeServiceInternals.normalizeDiscordRuntimeTarget(" <#12345> ")).toEqual({
      kind: "channel",
      id: "12345",
    });
    expect(__discordRuntimeServiceInternals.normalizeDiscordRuntimeTarget("<@!777>")).toEqual({
      kind: "user",
      id: "777",
    });
    expect(__discordRuntimeServiceInternals.resolveDiscordGuildRule(config, "guild-1")).toEqual({
      requireMention: false,
      users: ["user-1"],
      channels: ["channel-1", "channel-2"],
    });
    expect(__discordRuntimeServiceInternals.resolveDiscordGuildRule(config, "guild-default")).toEqual({
      requireMention: true,
      channels: ["channel-default"],
    });
    expect(__discordRuntimeServiceInternals.truncateDiscordResponse("   ")).toBe("Done.");
    expect(__discordRuntimeServiceInternals.truncateDiscordResponse("x".repeat(2_100))).toHaveLength(1_900);
    expect(__discordRuntimeServiceInternals.formatDiscordModelChoiceLabel("m".repeat(120), "provider")).toHaveLength(
      100,
    );
  });

  it("builds command text and approval tokens from interaction option fallbacks", () => {
    expect(
      __discordRuntimeServiceInternals.buildCommandTextFromInteraction(
        fakeInteraction("delegate", {
          strings: { roles: "Architect, QA", objective: "Review runtime diagnostics" },
        }),
      ),
    ).toBe("/delegate Architect, QA :: Review runtime diagnostics");
    expect(
      __discordRuntimeServiceInternals.buildCommandTextFromInteraction(
        fakeInteraction("score", {
          strings: { test: "TEST-32", notes: "  useful evidence  " },
          integers: { routing: 2, honesty: 1, handoff: 2, robustness: 1, usability: 2 },
        }),
      ),
    ).toBe("/score TEST-32 2 1 2 1 2 useful evidence");
    expect(
      __discordRuntimeServiceInternals.buildCommandTextFromInteraction(
        fakeInteraction("approve", {
          strings: { approval_id: "approval_123" },
        }),
      ),
    ).toBe("/approve approval_123");
    expect(__discordRuntimeServiceInternals.readDiscordSubcommand(fakeInteraction("run", {}))).toBeUndefined();
  });

  it("dispatches accepted gateway messages once and refreshes runtime status", async () => {
    const connection = createConnection();
    const service = createService([connection]);
    const handledAt = "2026-05-15T12:00:00.000Z";
    vi.useFakeTimers();
    vi.setSystemTime(new Date(handledAt));
    const runtime = createRuntime(connection.connectionId);
    const message = {
      inGuild: () => true,
      channel: { isDMBased: () => false },
      author: { bot: false },
      content: "  hello gateway  ",
    };
    const tryHandle = vi.fn(async () => true);
    (
      service as unknown as {
        tryHandleMessageForConnection: typeof tryHandle;
        handleMessage(runtime: unknown, message: unknown): Promise<void>;
      }
    ).tryHandleMessageForConnection = tryHandle;

    await (
      service as unknown as {
        handleMessage(runtime: unknown, message: unknown): Promise<void>;
      }
    ).handleMessage(runtime, message);

    expect(tryHandle).toHaveBeenCalledWith(runtime, connection, message);
    expect(runtime.lastInboundAt).toBe(handledAt);
    expect(service.getConnectionStatus(connection.connectionId)).toMatchObject({
      connectionId: connection.connectionId,
      ready: true,
      lastInboundAt: handledAt,
    });
  });

  it("ignores ineligible gateway messages and publishes interaction reply failures", async () => {
    const connection = createConnection();
    const publishDiagnostic = vi.fn();
    const service = createService([connection], publishDiagnostic);
    const runtime = createRuntime(connection.connectionId);
    const tryHandleMessage = vi.fn(async () => true);
    (
      service as unknown as {
        tryHandleMessageForConnection: typeof tryHandleMessage;
        handleMessage(runtime: unknown, message: unknown): Promise<void>;
      }
    ).tryHandleMessageForConnection = tryHandleMessage;

    for (const message of [
      { inGuild: () => false, channel: { isDMBased: () => false }, author: { bot: false }, content: "hello" },
      { inGuild: () => true, channel: { isDMBased: () => false }, author: { bot: true }, content: "hello" },
      { inGuild: () => true, channel: { isDMBased: () => false }, author: { bot: false }, content: "   " },
    ]) {
      await (
        service as unknown as {
          handleMessage(runtime: unknown, message: unknown): Promise<void>;
        }
      ).handleMessage(runtime, message);
    }
    expect(tryHandleMessage).not.toHaveBeenCalled();

    const tryHandleInteraction = vi.fn(async () => false);
    (
      service as unknown as {
        tryHandleInteractionForConnection: typeof tryHandleInteraction;
        handleInteraction(runtime: unknown, interaction: unknown): Promise<void>;
      }
    ).tryHandleInteractionForConnection = tryHandleInteraction;
    await (
      service as unknown as {
        handleInteraction(runtime: unknown, interaction: unknown): Promise<void>;
      }
    ).handleInteraction(runtime, {
      inGuild: () => true,
      channel: { isDMBased: () => false },
      commandName: "status",
      deferred: false,
      replied: false,
      reply: vi.fn(async () => {
        throw new Error("reply denied");
      }),
    });

    expect(tryHandleInteraction).toHaveBeenCalled();
    expect(runtime.lastError).toBe("reply denied");
    expect(publishDiagnostic).toHaveBeenCalledWith(
      "discord.gateway.interaction_reply_error",
      "Discord interaction response failed.",
      expect.objectContaining({ commandName: "status", error: "reply denied" }),
    );
  });
});

function createService(connections: Array<ReturnType<typeof createConnection>> = [], publishDiagnostic = vi.fn()) {
  return new DiscordRuntimeService({
    listConnections: () => connections,
    findApprovedPairing: () => undefined,
    ensurePendingPairing: () => {
      throw new Error("unexpected pairing request");
    },
    touchPairing: () => undefined,
    onInboundMessage: vi.fn(),
    acceptSlashCommand: vi.fn(async () => ({ inboundEventId: "inbound-command-1" })),
    awaitSlashCommandResult: vi.fn(async () => "ok"),
    listModelSuggestions: vi.fn(async () => []),
    publishDiagnostic,
  });
}

function createConnection() {
  return {
    connectionId: "11111111-1111-1111-1111-111111111111",
    catalogId: "channel.discord",
    kind: "channel",
    key: "discord",
    label: "Discord Loop32",
    enabled: true,
    status: "connected",
    config: {
      runtimeMode: "gateway",
      guildPolicy: "off",
    },
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  } as const;
}

function createRuntime(connectionId: string) {
  return {
    token: "token-1",
    client: {},
    connectionIds: new Set([connectionId]),
    guildIds: ["guild-1"],
    ready: true,
    lastError: undefined as string | undefined,
    lastInboundAt: undefined as string | undefined,
  };
}

function fakeInteraction(
  commandName: string,
  options: {
    strings?: Record<string, string | null | undefined>;
    integers?: Record<string, number | null | undefined>;
    booleans?: Record<string, boolean | null | undefined>;
    subcommand?: string;
  },
) {
  return {
    commandName,
    options: {
      getString: (key: string, required?: boolean) => {
        const value = options.strings?.[key] ?? null;
        if (required && value === null) {
          throw new Error(`missing string ${key}`);
        }
        return value;
      },
      getInteger: (key: string, required?: boolean) => {
        const value = options.integers?.[key] ?? null;
        if (required && value === null) {
          throw new Error(`missing integer ${key}`);
        }
        return value;
      },
      getBoolean: (key: string) => options.booleans?.[key] ?? null,
      getSubcommand: (required?: boolean) => {
        if (!options.subcommand && required) {
          throw new Error("missing subcommand");
        }
        return options.subcommand ?? null;
      },
    },
  } as never;
}
