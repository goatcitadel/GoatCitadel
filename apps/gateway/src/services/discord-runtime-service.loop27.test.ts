import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";

const discordMock = vi.hoisted(() => {
  class FakeSlashCommandBuilder {
    public setName(): this {
      return this;
    }
    public setDescription(): this {
      return this;
    }
    public addStringOption(callback?: (builder: FakeSlashCommandBuilder) => unknown): this {
      callback?.(new FakeSlashCommandBuilder());
      return this;
    }
    public addIntegerOption(callback?: (builder: FakeSlashCommandBuilder) => unknown): this {
      callback?.(new FakeSlashCommandBuilder());
      return this;
    }
    public addBooleanOption(callback?: (builder: FakeSlashCommandBuilder) => unknown): this {
      callback?.(new FakeSlashCommandBuilder());
      return this;
    }
    public addSubcommand(callback?: (builder: FakeSlashCommandBuilder) => unknown): this {
      callback?.(new FakeSlashCommandBuilder());
      return this;
    }
    public setRequired(): this {
      return this;
    }
    public setAutocomplete(): this {
      return this;
    }
    public setMinValue(): this {
      return this;
    }
    public setMaxValue(): this {
      return this;
    }
    public addChoices(): this {
      return this;
    }
    public toJSON(): Record<string, string> {
      return { name: "mock-command" };
    }
  }

  class FakeClient {
    public static instances: FakeClient[] = [];
    public readonly handlers = new Map<string, (...args: unknown[]) => void>();
    public readonly login = vi.fn(async () => undefined);
    public readonly destroy = vi.fn(async () => undefined);
    public readonly application = {
      commands: {
        set: vi.fn(async () => undefined),
      },
    };
    public readonly guilds = {
      cache: new Map<string, { commands: { set: ReturnType<typeof vi.fn> } }>(),
      fetch: vi.fn(async (_guildId: string) => null),
    };
    public readonly channels = {
      fetch: vi.fn(async (_channelId: string) => null),
    };
    public readonly users = {
      fetch: vi.fn(async (_userId: string) => ({
        createDM: vi.fn(async () => ({ sendTyping: vi.fn(async () => undefined) })),
      })),
    };
    public readonly user = {
      id: "bot-1",
      tag: "GoatCitadel#0001",
      username: "GoatCitadel",
    };

    public constructor() {
      FakeClient.instances.push(this);
    }

    public on(event: string, handler: (...args: unknown[]) => void): this {
      this.handlers.set(event, handler);
      return this;
    }

    public emitForTest(event: string, ...args: unknown[]): void {
      this.handlers.get(event)?.(...args);
    }
  }

  return { FakeClient, FakeSlashCommandBuilder };
});

vi.mock("discord.js", () => ({
  Client: discordMock.FakeClient,
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    DirectMessages: 4,
    MessageContent: 8,
  },
  Partials: {
    Channel: "Channel",
  },
  SlashCommandBuilder: discordMock.FakeSlashCommandBuilder,
}));

import { DiscordRuntimeService } from "./discord-runtime-service.js";

afterEach(() => {
  discordMock.FakeClient.instances.splice(0);
  vi.restoreAllMocks();
});

describe("DiscordRuntimeService gateway runtime lifecycle", () => {
  it("creates, refreshes, reconnects, and tears down managed gateway runtimes", async () => {
    const publishDiagnostic = vi.fn();
    let connections = [
      createConnection("conn-1", {
        botToken: " token-a ",
        guilds: {
          "guild-1": { channels: ["channel-1"] },
        },
      }),
      createConnection("conn-2", {
        botToken: "token-a",
        defaultGuildId: "guild-2",
      }),
      createConnection("conn-missing-token", {
        botToken: " ",
      }),
    ];
    const service = new DiscordRuntimeService({
      listConnections: () => connections,
      findApprovedPairing: () => undefined,
      ensurePendingPairing: () => {
        throw new Error("unexpected pairing request");
      },
      touchPairing: vi.fn(),
      onInboundMessage: vi.fn(async () => undefined),
      onSlashCommand: vi.fn(async () => "ok"),
      listModelSuggestions: vi.fn(async () => []),
      publishDiagnostic,
    });

    await service.sync();

    const [client] = discordMock.FakeClient.instances;
    expect(client?.login).toHaveBeenCalledWith("token-a");
    expect(service.getConnectionStatus("conn-missing-token")).toMatchObject({
      ready: false,
      lastError: "Discord gateway mode requires a bot token or env-backed bot token.",
    });
    expect(service.getConnectionStatus("conn-1")).toMatchObject({
      ready: false,
      guildIds: [],
    });

    const guildSet = vi.fn(async () => undefined);
    client?.guilds.cache.set("guild-1", { commands: { set: guildSet } });
    client?.guilds.cache.set("guild-2", { commands: { set: guildSet } });
    client?.emitForTest("clientReady");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.getConnectionStatus("conn-1")).toMatchObject({
      ready: true,
      connectedBotId: "bot-1",
      connectedBotTag: "GoatCitadel#0001",
    });
    expect(client?.application.commands.set).toHaveBeenCalled();
    expect(guildSet).toHaveBeenCalledTimes(2);
    expect(publishDiagnostic).toHaveBeenCalledWith(
      "discord.gateway.ready",
      "Discord gateway runtime is ready.",
      expect.objectContaining({
        connectionIds: ["conn-1", "conn-2"],
        botId: "bot-1",
      }),
    );

    await service.reconnectConnection("conn-1");
    expect(client?.destroy).toHaveBeenCalledTimes(1);
    expect(client?.login).toHaveBeenCalledTimes(2);
    expect(service.getConnectionStatus("conn-1")).toMatchObject({
      ready: false,
      lastError: undefined,
    });

    connections = [createConnection("conn-3", { botToken: "token-b" })];
    await service.sync();
    expect(client?.destroy).toHaveBeenCalledTimes(2);
    expect(discordMock.FakeClient.instances).toHaveLength(2);
    expect(discordMock.FakeClient.instances[1]?.login).toHaveBeenCalledWith("token-b");

    await service.close();
    expect(discordMock.FakeClient.instances[1]?.destroy).toHaveBeenCalledTimes(1);
    expect(service.getConnectionStatus("conn-3")).toBeUndefined();
  });
});

function createConnection(connectionId: string, config: Record<string, unknown>): IntegrationConnection {
  return {
    connectionId,
    catalogId: "channel.discord",
    kind: "channel",
    key: "discord",
    label: `Discord ${connectionId}`,
    enabled: true,
    status: "connected",
    config: {
      runtimeMode: "gateway",
      ...config,
    },
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  };
}
