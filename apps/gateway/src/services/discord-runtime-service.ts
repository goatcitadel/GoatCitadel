import {
  type AutocompleteInteraction,
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  type Channel,
  type ChatInputCommandInteraction,
  type Message,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";
import type {
  ChannelTypingResult,
  DiscordGuildAccessRule,
  DiscordInboundDmPolicy,
  DiscordPairingRecord,
  DiscordRuntimeMode,
  DiscordRuntimeStatus,
  IntegrationConnection,
} from "@goatcitadel/contracts";

type DiscordInboundEnvelope = {
  connectionId: string;
  target: string;
  actorId: string;
  displayName?: string;
  content: string;
  sourceMessageId: string;
  peer?: string;
  room?: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
};

interface DiscordRuntimeCallbacks {
  listConnections: () => IntegrationConnection[];
  findApprovedPairing: (connectionId: string, userId: string) => DiscordPairingRecord | undefined;
  ensurePendingPairing: (connectionId: string, userId: string, displayName?: string) => DiscordPairingRecord;
  touchPairing: (pairingId: string) => void;
  onInboundMessage: (input: DiscordInboundEnvelope) => Promise<void>;
  onSlashCommand: (input: Omit<DiscordInboundEnvelope, "content" | "sourceMessageId"> & {
    commandText: string;
    sourceCommandId: string;
  }) => Promise<string>;
  listModelSuggestions: (
    query: string,
    limit?: number,
  ) => Promise<Array<{
    model: string;
    providerId?: string;
    providerLabel?: string;
  }>>;
  publishDiagnostic: (event: string, message: string, context: Record<string, unknown>) => void;
}

type ManagedClientRecord = {
  token: string;
  client: Client;
  connectionIds: Set<string>;
  connectedBotId?: string;
  connectedBotTag?: string;
  guildIds: string[];
  ready: boolean;
  lastReadyAt?: string;
  lastInboundAt?: string;
  lastReconnectAt?: string;
  lastError?: string;
};

export class DiscordRuntimeService {
  private readonly runtimesByToken = new Map<string, ManagedClientRecord>();
  private readonly statusByConnectionId = new Map<string, DiscordRuntimeStatus>();

  public constructor(private readonly callbacks: DiscordRuntimeCallbacks) {}

  public async sync(): Promise<void> {
    const gatewayConnections = this.callbacks
      .listConnections()
      .filter((connection) => connection.kind === "channel" && connection.key === "discord" && connection.enabled)
      .filter((connection) => getDiscordRuntimeMode(connection.config) === "gateway");
    const nextGroups = new Map<string, IntegrationConnection[]>();
    for (const connection of gatewayConnections) {
      const token = readDiscordSecret(connection.config, "botToken", "botTokenEnv")
        ?? readDiscordSecret(connection.config, "token", "tokenEnv");
      if (!token) {
        this.statusByConnectionId.set(connection.connectionId, {
          connectionId: connection.connectionId,
          runtimeMode: "gateway",
          enabled: connection.enabled,
          ready: false,
          guildIds: [],
          lastError: "Discord gateway mode requires a bot token or env-backed bot token.",
        });
        continue;
      }
      const group = nextGroups.get(token) ?? [];
      group.push(connection);
      nextGroups.set(token, group);
    }

    for (const [token, runtime] of [...this.runtimesByToken.entries()]) {
      if (nextGroups.has(token)) {
        continue;
      }
      await this.destroyRuntime(runtime);
      this.runtimesByToken.delete(token);
    }

    for (const [token, connections] of nextGroups.entries()) {
      const existing = this.runtimesByToken.get(token);
      if (existing) {
        existing.connectionIds = new Set(connections.map((connection) => connection.connectionId));
        this.updateStatusSnapshot(existing);
        if (existing.ready) {
          void this.syncApplicationCommands(existing).catch((error) => {
            existing.lastError = (error as Error).message;
            this.updateStatusSnapshot(existing);
          });
        }
        continue;
      }
      const runtime = this.createManagedRuntime(token, connections);
      this.runtimesByToken.set(token, runtime);
      this.updateStatusSnapshot(runtime);
      void this.loginRuntime(runtime).catch((error) => {
        runtime.lastError = (error as Error).message;
        runtime.ready = false;
        this.updateStatusSnapshot(runtime);
      });
    }

    for (const connection of gatewayConnections) {
      if (!this.statusByConnectionId.has(connection.connectionId)) {
        this.statusByConnectionId.set(connection.connectionId, {
          connectionId: connection.connectionId,
          runtimeMode: "gateway",
          enabled: connection.enabled,
          ready: false,
          guildIds: [],
        });
      }
    }
  }

  public getConnectionStatus(connectionId: string): DiscordRuntimeStatus | undefined {
    const status = this.statusByConnectionId.get(connectionId);
    return status ? { ...status, guildIds: [...status.guildIds] } : undefined;
  }

  public async reconnectConnection(connectionId: string): Promise<DiscordRuntimeStatus | undefined> {
    const runtime = [...this.runtimesByToken.values()].find((entry) => entry.connectionIds.has(connectionId));
    if (!runtime) {
      return this.getConnectionStatus(connectionId);
    }
    runtime.lastReconnectAt = new Date().toISOString();
    runtime.ready = false;
    runtime.lastError = undefined;
    this.updateStatusSnapshot(runtime);
    await runtime.client.destroy();
    await this.loginRuntime(runtime);
    return this.getConnectionStatus(connectionId);
  }

  public async sendTyping(connectionId: string, target: string, durationMs = 8_000): Promise<ChannelTypingResult> {
    const runtime = [...this.runtimesByToken.values()].find((entry) => entry.connectionIds.has(connectionId));
    if (!runtime || !runtime.ready) {
      return {
        channelKey: "discord",
        connectionId,
        target,
        supported: false,
        status: "unsupported",
        reason: "Discord gateway runtime is not ready.",
      };
    }

    const normalized = normalizeDiscordRuntimeTarget(target);
    try {
      const channel = normalized.kind === "user"
        ? await (await runtime.client.users.fetch(normalized.id)).createDM()
        : await runtime.client.channels.fetch(normalized.id);
      if (!channel || !supportsTyping(channel)) {
        return {
          channelKey: "discord",
          connectionId,
          target,
          supported: false,
          status: "unsupported",
          reason: "The resolved Discord target does not support typing indicators.",
        };
      }
      await channel.sendTyping();
      const expiresAt = new Date(Date.now() + Math.max(1_000, durationMs)).toISOString();
      return {
        channelKey: "discord",
        connectionId,
        target,
        supported: true,
        status: "sent",
        expiresAt,
      };
    } catch (error) {
      return {
        channelKey: "discord",
        connectionId,
        target,
        supported: false,
        status: "unsupported",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async close(): Promise<void> {
    await Promise.allSettled([...this.runtimesByToken.values()].map((runtime) => this.destroyRuntime(runtime)));
    this.runtimesByToken.clear();
    this.statusByConnectionId.clear();
  }

  private createManagedRuntime(token: string, connections: IntegrationConnection[]): ManagedClientRecord {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
    const runtime: ManagedClientRecord = {
      token,
      client,
      connectionIds: new Set(connections.map((connection) => connection.connectionId)),
      guildIds: [],
      ready: false,
    };

    client.on("clientReady", () => {
      runtime.ready = true;
      runtime.connectedBotId = client.user?.id;
      runtime.connectedBotTag = client.user?.tag ?? client.user?.username;
      runtime.guildIds = [...client.guilds.cache.keys()];
      runtime.lastReadyAt = new Date().toISOString();
      runtime.lastError = undefined;
      this.updateStatusSnapshot(runtime);
      this.callbacks.publishDiagnostic("discord.gateway.ready", "Discord gateway runtime is ready.", {
        connectionIds: [...runtime.connectionIds],
        botId: runtime.connectedBotId,
        botTag: runtime.connectedBotTag,
        guildIds: runtime.guildIds,
      });
      void this.syncApplicationCommands(runtime).catch((error) => {
        runtime.lastError = (error as Error).message;
        this.updateStatusSnapshot(runtime);
        this.callbacks.publishDiagnostic("discord.gateway.commands_error", "Discord slash command sync failed.", {
          connectionIds: [...runtime.connectionIds],
          error: (error as Error).message,
        });
      });
    });

    client.on("messageCreate", (message: Message) => {
      void this.handleMessage(runtime, message).catch((error) => {
        runtime.lastError = (error as Error).message;
        this.updateStatusSnapshot(runtime);
        this.callbacks.publishDiagnostic("discord.gateway.message_error", "Discord inbound handling failed.", {
          connectionIds: [...runtime.connectionIds],
          messageId: message.id,
          channelId: message.channelId,
          guildId: message.guildId,
          error: (error as Error).message,
        });
      });
    });

    client.on("interactionCreate", (interaction) => {
      if (interaction.isAutocomplete()) {
        void this.handleAutocompleteInteraction(runtime, interaction).catch((error) => {
          runtime.lastError = (error as Error).message;
          this.updateStatusSnapshot(runtime);
          this.callbacks.publishDiagnostic("discord.gateway.autocomplete_error", "Discord autocomplete handling failed.", {
            connectionIds: [...runtime.connectionIds],
            interactionId: interaction.id,
            commandName: interaction.commandName,
            channelId: interaction.channelId,
            guildId: interaction.guildId,
            error: (error as Error).message,
          });
        });
        return;
      }
      if (!interaction.isChatInputCommand()) {
        return;
      }
      void this.handleInteraction(runtime, interaction).catch((error) => {
        runtime.lastError = (error as Error).message;
        this.updateStatusSnapshot(runtime);
        this.callbacks.publishDiagnostic("discord.gateway.interaction_error", "Discord slash command handling failed.", {
          connectionIds: [...runtime.connectionIds],
          interactionId: interaction.id,
          commandName: interaction.commandName,
          channelId: interaction.channelId,
          guildId: interaction.guildId,
          error: (error as Error).message,
        });
      });
    });

    client.on("error", (error: Error) => {
      runtime.ready = false;
      runtime.lastError = error.message;
      this.updateStatusSnapshot(runtime);
      this.callbacks.publishDiagnostic("discord.gateway.error", "Discord gateway runtime error.", {
        connectionIds: [...runtime.connectionIds],
        error: error.message,
      });
    });

    client.on("shardDisconnect", () => {
      runtime.ready = false;
      runtime.lastReconnectAt = new Date().toISOString();
      this.updateStatusSnapshot(runtime);
    });

    return runtime;
  }

  private async loginRuntime(runtime: ManagedClientRecord): Promise<void> {
    await runtime.client.login(runtime.token);
  }

  private async destroyRuntime(runtime: ManagedClientRecord): Promise<void> {
    runtime.ready = false;
    this.updateStatusSnapshot(runtime);
    await runtime.client.destroy();
  }

  private updateStatusSnapshot(runtime: ManagedClientRecord): void {
    for (const connectionId of runtime.connectionIds) {
      this.statusByConnectionId.set(connectionId, {
        connectionId,
        runtimeMode: "gateway",
        enabled: true,
        ready: runtime.ready,
        connectedBotId: runtime.connectedBotId,
        connectedBotTag: runtime.connectedBotTag,
        guildIds: [...runtime.guildIds],
        lastReadyAt: runtime.lastReadyAt,
        lastInboundAt: runtime.lastInboundAt,
        lastReconnectAt: runtime.lastReconnectAt,
        lastError: runtime.lastError,
      });
    }
  }

  private async handleMessage(runtime: ManagedClientRecord, message: Message): Promise<void> {
    if (!message.inGuild() && !message.channel?.isDMBased()) {
      return;
    }
    if (message.author.bot) {
      return;
    }
    if (!message.content.trim()) {
      return;
    }
    const connections = this.callbacks
      .listConnections()
      .filter((connection) => runtime.connectionIds.has(connection.connectionId));
    for (const connection of connections) {
      const handled = await this.tryHandleMessageForConnection(runtime, connection, message);
      if (handled) {
        runtime.lastInboundAt = new Date().toISOString();
        this.updateStatusSnapshot(runtime);
        return;
      }
    }
  }

  private async handleInteraction(
    runtime: ManagedClientRecord,
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (!interaction.inGuild() && !interaction.channel?.isDMBased()) {
      return;
    }
    const connections = this.callbacks
      .listConnections()
      .filter((connection) => runtime.connectionIds.has(connection.connectionId));
    for (const connection of connections) {
      const handled = await this.tryHandleInteractionForConnection(runtime, connection, interaction);
      if (handled) {
        runtime.lastInboundAt = new Date().toISOString();
        this.updateStatusSnapshot(runtime);
        return;
      }
    }
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({
        content: "GoatCitadel is not enabled for slash commands in this channel or DM route.",
        ephemeral: !interaction.channel?.isDMBased(),
      }).catch(() => {});
    }
  }

  private async handleAutocompleteInteraction(
    runtime: ManagedClientRecord,
    interaction: AutocompleteInteraction,
  ): Promise<void> {
    if (!interaction.inGuild() && !interaction.channel?.isDMBased()) {
      return;
    }
    if (interaction.commandName !== "model") {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const connections = this.callbacks
      .listConnections()
      .filter((connection) => runtime.connectionIds.has(connection.connectionId));
    const allowed = connections.some((connection) => this.canHandleAutocompleteForConnection(connection, interaction));
    if (!allowed) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "model") {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const suggestions = await this.callbacks.listModelSuggestions(String(focused.value ?? ""), 25);
    await interaction.respond(suggestions.slice(0, 25).map((item) => ({
      name: formatDiscordModelChoiceLabel(item.model, item.providerLabel ?? item.providerId),
      value: item.model,
    }))).catch(() => {});
  }

  private async syncApplicationCommands(runtime: ManagedClientRecord): Promise<void> {
    const commands = buildDiscordSlashCommandDefinitions();
    const application = runtime.client.application;
    if (!application) {
      return;
    }
    await application.commands.set(commands);

    const configuredGuildIds = new Set<string>();
    const connections = this.callbacks
      .listConnections()
      .filter((connection) => runtime.connectionIds.has(connection.connectionId));
    for (const connection of connections) {
      const guildRules = readGuildRuleMap(connection.config);
      for (const guildId of Object.keys(guildRules)) {
        configuredGuildIds.add(guildId);
      }
      const defaultGuildId = readConfigString(connection.config, "defaultGuildId");
      if (defaultGuildId) {
        configuredGuildIds.add(defaultGuildId);
      }
    }

    for (const guildId of configuredGuildIds) {
      const guild = runtime.client.guilds.cache.get(guildId) ?? await runtime.client.guilds.fetch(guildId).catch(() => null);
      if (!guild) {
        continue;
      }
      await guild.commands.set(commands);
    }
  }

  private async tryHandleMessageForConnection(
    runtime: ManagedClientRecord,
    connection: IntegrationConnection,
    message: Message,
  ): Promise<boolean> {
    if (message.channel.isDMBased()) {
      return this.handleDirectMessage(runtime, connection, message);
    }
    if (!message.inGuild()) {
      return false;
    }
    const guildRule = resolveDiscordGuildRule(connection.config, message.guildId);
    if (getDiscordGuildPolicy(connection.config) !== "allowlist" || !guildRule) {
      return false;
    }
    if (guildRule.channels && guildRule.channels.length > 0 && !guildRule.channels.includes(message.channelId)) {
      return false;
    }
    if (guildRule.users && guildRule.users.length > 0 && !guildRule.users.includes(message.author.id)) {
      return false;
    }
    if (guildRule.requireMention && runtime.connectedBotId && !message.mentions.users.has(runtime.connectedBotId)) {
      return false;
    }
    const normalizedContent = runtime.connectedBotId
      ? message.content.replace(new RegExp(`<@!?${runtime.connectedBotId}>`, "g"), "").trim()
      : message.content.trim();
    if (!normalizedContent) {
      return false;
    }
    await this.handleAcceptedMessage(message, async () => {
      await this.callbacks.onInboundMessage({
        connectionId: connection.connectionId,
        target: message.channelId,
        actorId: message.author.id,
        displayName: message.author.globalName ?? message.author.displayName ?? message.author.username,
        content: normalizedContent,
        sourceMessageId: message.id,
        peer: message.author.id,
        room: message.channelId,
        threadId: message.channel.isThread() ? message.channel.id : undefined,
        metadata: {
          guildId: message.guildId,
          channelId: message.channelId,
          runtimeMode: "gateway",
        },
      });
    });
    return true;
  }

  private async tryHandleInteractionForConnection(
    runtime: ManagedClientRecord,
    connection: IntegrationConnection,
    interaction: ChatInputCommandInteraction,
  ): Promise<boolean> {
    if (interaction.channel?.isDMBased()) {
      return this.handleDirectCommand(runtime, connection, interaction);
    }
    if (!interaction.inGuild()) {
      return false;
    }
    const guildRule = resolveDiscordGuildRule(connection.config, interaction.guildId);
    if (getDiscordGuildPolicy(connection.config) !== "allowlist" || !guildRule) {
      return false;
    }
    if (guildRule.channels && guildRule.channels.length > 0 && !guildRule.channels.includes(interaction.channelId)) {
      return false;
    }
    if (guildRule.users && guildRule.users.length > 0 && !guildRule.users.includes(interaction.user.id)) {
      return false;
    }
    const commandText = buildCommandTextFromInteraction(interaction);
    await this.handleAcceptedCommand(interaction, async () => this.callbacks.onSlashCommand({
      connectionId: connection.connectionId,
      target: interaction.channelId,
      actorId: interaction.user.id,
      displayName: interaction.user.globalName ?? interaction.user.displayName ?? interaction.user.username,
      commandText,
      sourceCommandId: interaction.id,
      peer: interaction.user.id,
      room: interaction.channelId,
      threadId: interaction.channel?.isThread() ? interaction.channel.id : undefined,
      metadata: {
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        runtimeMode: "gateway",
        interaction: true,
      },
    }));
    return true;
  }

  private canHandleAutocompleteForConnection(
    connection: IntegrationConnection,
    interaction: AutocompleteInteraction,
  ): boolean {
    if (interaction.channel?.isDMBased()) {
      return getDiscordInboundDmPolicy(connection.config) !== "disabled";
    }
    if (!interaction.inGuild()) {
      return false;
    }
    const guildRule = resolveDiscordGuildRule(connection.config, interaction.guildId);
    if (getDiscordGuildPolicy(connection.config) !== "allowlist" || !guildRule) {
      return false;
    }
    if (guildRule.channels && guildRule.channels.length > 0 && !guildRule.channels.includes(interaction.channelId)) {
      return false;
    }
    if (guildRule.users && guildRule.users.length > 0 && !guildRule.users.includes(interaction.user.id)) {
      return false;
    }
    return true;
  }

  private async handleDirectMessage(
    runtime: ManagedClientRecord,
    connection: IntegrationConnection,
    message: Message,
  ): Promise<boolean> {
    const dmPolicy = getDiscordInboundDmPolicy(connection.config);
    if (dmPolicy === "disabled") {
      return false;
    }
    const approved = this.callbacks.findApprovedPairing(connection.connectionId, message.author.id);
    if (approved) {
      this.callbacks.touchPairing(approved.pairingId);
      await this.handleAcceptedMessage(message, async () => {
        await this.callbacks.onInboundMessage({
          connectionId: connection.connectionId,
          target: message.channelId,
          actorId: message.author.id,
          displayName: message.author.globalName ?? message.author.displayName ?? message.author.username,
          content: message.content.trim(),
          sourceMessageId: message.id,
          peer: message.author.id,
          room: message.channelId,
          metadata: {
            dm: true,
            runtimeMode: "gateway",
          },
        });
      });
      return true;
    }
    if (dmPolicy === "open") {
      await this.handleAcceptedMessage(message, async () => {
        await this.callbacks.onInboundMessage({
          connectionId: connection.connectionId,
          target: message.channelId,
          actorId: message.author.id,
          displayName: message.author.globalName ?? message.author.displayName ?? message.author.username,
          content: message.content.trim(),
          sourceMessageId: message.id,
          peer: message.author.id,
          room: message.channelId,
          metadata: {
            dm: true,
            runtimeMode: "gateway",
          },
        });
      });
      return true;
    }
    const pending = this.callbacks.ensurePendingPairing(
      connection.connectionId,
      message.author.id,
      message.author.globalName ?? message.author.displayName ?? message.author.username,
    );
    await this.markMessageSeen(message);
    if ("send" in message.channel && typeof message.channel.send === "function") {
      await message.channel.send(
        `GoatCitadel pairing required. Ask the operator to approve code \`${pending.code}\` for ${connection.label}.`,
      );
    }
    return true;
  }

  private async handleDirectCommand(
    runtime: ManagedClientRecord,
    connection: IntegrationConnection,
    interaction: ChatInputCommandInteraction,
  ): Promise<boolean> {
    const dmPolicy = getDiscordInboundDmPolicy(connection.config);
    if (dmPolicy === "disabled") {
      return false;
    }
    const approved = this.callbacks.findApprovedPairing(connection.connectionId, interaction.user.id);
    const commandText = buildCommandTextFromInteraction(interaction);
    if (approved) {
      this.callbacks.touchPairing(approved.pairingId);
      await this.handleAcceptedCommand(interaction, async () => this.callbacks.onSlashCommand({
        connectionId: connection.connectionId,
        target: interaction.channelId,
        actorId: interaction.user.id,
        displayName: interaction.user.globalName ?? interaction.user.displayName ?? interaction.user.username,
        commandText,
        sourceCommandId: interaction.id,
        peer: interaction.user.id,
        room: interaction.channelId,
        metadata: {
          dm: true,
          runtimeMode: "gateway",
          interaction: true,
        },
      }));
      return true;
    }
    if (dmPolicy === "open") {
      await this.handleAcceptedCommand(interaction, async () => this.callbacks.onSlashCommand({
        connectionId: connection.connectionId,
        target: interaction.channelId,
        actorId: interaction.user.id,
        displayName: interaction.user.globalName ?? interaction.user.displayName ?? interaction.user.username,
        commandText,
        sourceCommandId: interaction.id,
        peer: interaction.user.id,
        room: interaction.channelId,
        metadata: {
          dm: true,
          runtimeMode: "gateway",
          interaction: true,
        },
      }));
      return true;
    }
    const pending = this.callbacks.ensurePendingPairing(
      connection.connectionId,
      interaction.user.id,
      interaction.user.globalName ?? interaction.user.displayName ?? interaction.user.username,
    );
    const pairingMessage =
      `GoatCitadel pairing required. Ask the operator to approve code \`${pending.code}\` for ${connection.label}.`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: pairingMessage });
    } else {
      await interaction.reply({ content: pairingMessage });
    }
    return true;
  }

  private async handleAcceptedMessage(message: Message, task: () => Promise<void>): Promise<void> {
    await this.markMessageSeen(message);
    await this.runWithTypingIndicator(message, task);
  }

  private async handleAcceptedCommand(
    interaction: ChatInputCommandInteraction,
    task: () => Promise<string>,
  ): Promise<void> {
    const ephemeral = !interaction.channel?.isDMBased();
    await interaction.deferReply({ ephemeral });
    const result = await task();
    await interaction.editReply({ content: truncateDiscordResponse(result) });
  }

  private async markMessageSeen(message: Message): Promise<void> {
    if (typeof message.react !== "function") {
      return;
    }
    try {
      await message.react("👀");
    } catch {
      // Reactions are best-effort; do not block inbound handling if the bot lacks permission.
    }
  }

  private async runWithTypingIndicator(message: Message, task: () => Promise<void>): Promise<void> {
    const channel = message.channel as { sendTyping?: () => Promise<unknown> };
    const sendTyping = typeof channel.sendTyping === "function"
      ? () => channel.sendTyping?.() ?? Promise.resolve()
      : undefined;
    if (!sendTyping) {
      await task();
      return;
    }

    let interval: NodeJS.Timeout | undefined;
    try {
      await sendTyping();
      interval = setInterval(() => {
        void sendTyping().catch(() => {});
      }, 8_000);
      await task();
    } finally {
      if (interval) {
        clearInterval(interval);
      }
    }
  }
}

function readDiscordSecret(
  config: Record<string, unknown>,
  key: string,
  envKey: string,
): string | undefined {
  const direct = readConfigString(config, key);
  if (direct) {
    return direct;
  }
  const envName = readConfigString(config, envKey);
  return envName ? process.env[envName]?.trim() || undefined : undefined;
}

function readConfigString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function supportsTyping(channel: Channel): channel is Channel & { sendTyping: () => Promise<unknown> } {
  return "sendTyping" in channel && typeof channel.sendTyping === "function";
}

function normalizeDiscordRuntimeTarget(target: string): { kind: "channel" | "user"; id: string } {
  const trimmed = target.trim();
  const channelMention = trimmed.match(/^<#(\d+)>$/);
  if (channelMention) {
    return { kind: "channel", id: channelMention[1] ?? trimmed };
  }
  const userMention = trimmed.match(/^<@!?(\d+)>$/);
  if (userMention) {
    return { kind: "user", id: userMention[1] ?? trimmed };
  }
  if (trimmed.startsWith("channel:")) {
    return { kind: "channel", id: trimmed.slice("channel:".length) };
  }
  if (trimmed.startsWith("user:")) {
    return { kind: "user", id: trimmed.slice("user:".length) };
  }
  if (trimmed.startsWith("discord:")) {
    return { kind: "user", id: trimmed.slice("discord:".length) };
  }
  return { kind: "channel", id: trimmed };
}

function getDiscordRuntimeMode(config: Record<string, unknown>): DiscordRuntimeMode {
  return readConfigString(config, "runtimeMode") === "gateway" ? "gateway" : "bridge";
}

function getDiscordInboundDmPolicy(config: Record<string, unknown>): DiscordInboundDmPolicy {
  const value = readConfigString(config, "inboundDmPolicy");
  if (value === "open" || value === "disabled") {
    return value;
  }
  return "pairing";
}

function getDiscordGuildPolicy(config: Record<string, unknown>): "off" | "allowlist" {
  return readConfigString(config, "guildPolicy") === "off" ? "off" : "allowlist";
}

function resolveDiscordGuildRule(
  config: Record<string, unknown>,
  guildId: string | null,
): DiscordGuildAccessRule | undefined {
  if (!guildId) {
    return undefined;
  }
  const explicit = sanitizeGuildRules(config.guilds)[guildId];
  if (explicit) {
    return explicit;
  }
  const defaultGuildId = readConfigString(config, "defaultGuildId");
  if (defaultGuildId && defaultGuildId === guildId) {
    const defaultChannelId = readConfigString(config, "defaultChannelId");
    return {
      requireMention: true,
      channels: defaultChannelId ? [defaultChannelId] : undefined,
    };
  }
  return undefined;
}

function readGuildRuleMap(config: Record<string, unknown>): Record<string, DiscordGuildAccessRule> {
  return sanitizeGuildRules(config.guilds);
}

function sanitizeGuildRules(value: unknown): Record<string, DiscordGuildAccessRule> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const result: Record<string, DiscordGuildAccessRule> = {};
  for (const [guildId, rawRule] of Object.entries(value as Record<string, unknown>)) {
    if (!rawRule || typeof rawRule !== "object") {
      continue;
    }
    const requireMention = typeof (rawRule as { requireMention?: unknown }).requireMention === "boolean"
      ? Boolean((rawRule as { requireMention?: boolean }).requireMention)
      : true;
    const users = sanitizeStringArray((rawRule as { users?: unknown }).users);
    const channels = sanitizeStringArray((rawRule as { channels?: unknown }).channels);
    result[guildId] = {
      requireMention,
      users: users.length > 0 ? users : undefined,
      channels: channels.length > 0 ? channels : undefined,
    };
  }
  return result;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function truncateDiscordResponse(input: string): string {
  const normalized = input.trim();
  if (normalized.length <= 1_900) {
    return normalized || "Done.";
  }
  return `${normalized.slice(0, 1_897)}...`;
}

function formatDiscordModelChoiceLabel(model: string, provider?: string): string {
  const label = provider ? `${model} · ${provider}` : model;
  return label.length <= 100 ? label : label.slice(0, 97).trimEnd() + "...";
}

function buildCommandTextFromInteraction(interaction: ChatInputCommandInteraction): string {
  switch (interaction.commandName) {
    case "help":
      return "/help";
    case "new": {
      const title = interaction.options.getString("title");
      return title ? `/new ${title}` : "/new";
    }
    case "mode":
      return `/mode ${interaction.options.getString("mode", true)}`;
    case "plan": {
      const state = interaction.options.getString("state");
      return state ? `/plan ${state}` : "/plan";
    }
    case "model":
      return `/model ${interaction.options.getString("model", true)}`;
    case "web":
      return `/web ${interaction.options.getString("mode", true)}`;
    case "memory":
      return `/memory ${interaction.options.getString("mode", true)}`;
    case "think":
      return `/think ${interaction.options.getString("level", true)}`;
    case "tool":
      return `/tool ${interaction.options.getString("mode", true)}`;
    case "proactive":
      return `/proactive ${interaction.options.getString("mode", true)}`;
    case "retrieval":
      return `/retrieval ${interaction.options.getString("mode", true)}`;
    case "reflect":
      return `/reflect ${interaction.options.getString("mode", true)}`;
    case "research":
      return `/research ${interaction.options.getString("query", true)}`;
    case "delegate":
      return `/delegate ${interaction.options.getString("roles", true)} :: ${interaction.options.getString("objective", true)}`;
    case "pipeline":
      return `/pipeline ${interaction.options.getString("template", true)} :: ${interaction.options.getString("objective", true)}`;
    case "score":
      return [
        "/score",
        interaction.options.getString("test", true),
        interaction.options.getInteger("routing", true),
        interaction.options.getInteger("honesty", true),
        interaction.options.getInteger("handoff", true),
        interaction.options.getInteger("robustness", true),
        interaction.options.getInteger("usability", true),
        interaction.options.getString("notes")?.trim(),
      ].filter((value) => value !== undefined && value !== null && String(value).trim().length > 0).join(" ");
    case "pack":
      return `/pack run ${interaction.options.getString("selector") ?? "all"}`;
    case "skills":
      return "/skills";
    case "skill": {
      const action = interaction.options.getSubcommand();
      if (action === "enable" || action === "sleep" || action === "disable") {
        return `/skill ${action} ${interaction.options.getString("skill_id", true)}`;
      }
      if (action === "search" || action === "lookup") {
        return `/skill ${action} ${interaction.options.getString("query", true)}`;
      }
      const sourceRef = interaction.options.getString("source_ref", true);
      const confirm = interaction.options.getBoolean("confirm_high_risk");
      return `/skill install ${sourceRef}${confirm ? " --confirm-high-risk" : ""}`;
    }
    case "mcp": {
      const action = interaction.options.getSubcommand();
      if (action === "list") {
        return "/mcp";
      }
      if (action === "templates") {
        const query = interaction.options.getString("query");
        return query ? `/mcp templates ${query}` : "/mcp templates";
      }
      if (action === "add-template") {
        return `/mcp add-template ${interaction.options.getString("template_id", true)}`;
      }
      return `/mcp ${action} ${interaction.options.getString("server_id", true)}`;
    }
    case "project":
      return `/project ${interaction.options.getString("project_id", true)}`;
    case "attach":
      return `/attach ${interaction.options.getString("attachment_id", true)}`;
    case "run":
      return `/run research ${interaction.options.getString("query", true)}`;
    case "approve":
      return `/approve ${interaction.options.getString("approval_id", true)}`;
    case "deny":
      return `/deny ${interaction.options.getString("approval_id", true)}`;
    default:
      return `/${interaction.commandName}`;
  }
}

function buildDiscordSlashCommandDefinitions(): RESTPostAPIApplicationCommandsJSONBody[] {
  const stringChoice = (value: string) => ({ name: value, value });

  return [
    new SlashCommandBuilder().setName("help").setDescription("Show GoatCitadel chat commands."),
    new SlashCommandBuilder()
      .setName("new")
      .setDescription("Start a fresh GoatCitadel session for this Discord route.")
      .addStringOption((option) => option.setName("title").setDescription("Optional session title.")),
    new SlashCommandBuilder()
      .setName("mode")
      .setDescription("Switch the active GoatCitadel session mode.")
      .addStringOption((option) => option.setName("mode").setDescription("Target mode.").setRequired(true)
        .addChoices(stringChoice("chat"), stringChoice("cowork"), stringChoice("code"))),
    new SlashCommandBuilder()
      .setName("plan")
      .setDescription("Show or set planning mode.")
      .addStringOption((option) => option.setName("state").setDescription("Set planning mode.")
        .addChoices(stringChoice("on"), stringChoice("off"))),
    new SlashCommandBuilder()
      .setName("model")
      .setDescription("Override the active model for this session.")
      .addStringOption((option) => option.setName("model").setDescription("Model id.").setRequired(true).setAutocomplete(true)),
    new SlashCommandBuilder()
      .setName("web")
      .setDescription("Set web retrieval behavior.")
      .addStringOption((option) => option.setName("mode").setDescription("Web mode.").setRequired(true)
        .addChoices(stringChoice("auto"), stringChoice("off"), stringChoice("quick"), stringChoice("deep"))),
    new SlashCommandBuilder()
      .setName("memory")
      .setDescription("Set memory behavior.")
      .addStringOption((option) => option.setName("mode").setDescription("Memory mode.").setRequired(true)
        .addChoices(stringChoice("auto"), stringChoice("on"), stringChoice("off"))),
    new SlashCommandBuilder()
      .setName("think")
      .setDescription("Set thinking depth.")
      .addStringOption((option) => option.setName("level").setDescription("Thinking level.").setRequired(true)
        .addChoices(stringChoice("minimal"), stringChoice("standard"), stringChoice("extended"))),
    new SlashCommandBuilder()
      .setName("tool")
      .setDescription("Set tool autonomy mode.")
      .addStringOption((option) => option.setName("mode").setDescription("Tool autonomy.").setRequired(true)
        .addChoices(stringChoice("safe_auto"), stringChoice("manual"))),
    new SlashCommandBuilder()
      .setName("proactive")
      .setDescription("Set proactive mode.")
      .addStringOption((option) => option.setName("mode").setDescription("Proactive mode.").setRequired(true)
        .addChoices(stringChoice("off"), stringChoice("suggest"), stringChoice("auto_safe"), stringChoice("auto_full"))),
    new SlashCommandBuilder()
      .setName("retrieval")
      .setDescription("Set retrieval routing mode.")
      .addStringOption((option) => option.setName("mode").setDescription("Retrieval mode.").setRequired(true)
        .addChoices(stringChoice("standard"), stringChoice("layered"))),
    new SlashCommandBuilder()
      .setName("reflect")
      .setDescription("Toggle reflection retry mode.")
      .addStringOption((option) => option.setName("mode").setDescription("Reflection mode.").setRequired(true)
        .addChoices(stringChoice("off"), stringChoice("on"))),
    new SlashCommandBuilder()
      .setName("research")
      .setDescription("Run quick research in the current session.")
      .addStringOption((option) => option.setName("query").setDescription("Research query.").setRequired(true)),
    new SlashCommandBuilder()
      .setName("delegate")
      .setDescription("Run task-backed role delegation.")
      .addStringOption((option) => option.setName("roles").setDescription("Comma-separated roles.").setRequired(true))
      .addStringOption((option) => option.setName("objective").setDescription("Delegation objective.").setRequired(true)),
    new SlashCommandBuilder()
      .setName("pipeline")
      .setDescription("Run a built-in delegation template.")
      .addStringOption((option) => option.setName("template").setDescription("Template id.").setRequired(true)
        .addChoices(stringChoice("prd"), stringChoice("build"), stringChoice("triage"), stringChoice("release")))
      .addStringOption((option) => option.setName("objective").setDescription("Pipeline objective.").setRequired(true)),
    new SlashCommandBuilder()
      .setName("score")
      .setDescription("Score the latest prompt-pack run.")
      .addStringOption((option) => option.setName("test").setDescription("Prompt-pack test code.").setRequired(true))
      .addIntegerOption((option) => option.setName("routing").setDescription("Routing score.").setRequired(true).setMinValue(0).setMaxValue(10))
      .addIntegerOption((option) => option.setName("honesty").setDescription("Honesty score.").setRequired(true).setMinValue(0).setMaxValue(10))
      .addIntegerOption((option) => option.setName("handoff").setDescription("Handoff score.").setRequired(true).setMinValue(0).setMaxValue(10))
      .addIntegerOption((option) => option.setName("robustness").setDescription("Robustness score.").setRequired(true).setMinValue(0).setMaxValue(10))
      .addIntegerOption((option) => option.setName("usability").setDescription("Usability score.").setRequired(true).setMinValue(0).setMaxValue(10))
      .addStringOption((option) => option.setName("notes").setDescription("Optional scoring note.")),
    new SlashCommandBuilder()
      .setName("pack")
      .setDescription("Run prompt-pack tests.")
      .addStringOption((option) => option.setName("selector").setDescription("Test selector or all.")),
    new SlashCommandBuilder().setName("skills").setDescription("List installed skills."),
    new SlashCommandBuilder()
      .setName("skill")
      .setDescription("Manage skills.")
      .addSubcommand((subcommand) => subcommand
        .setName("enable")
        .setDescription("Enable a skill.")
        .addStringOption((option) => option.setName("skill_id").setDescription("Installed skill id.").setRequired(true)))
      .addSubcommand((subcommand) => subcommand
        .setName("sleep")
        .setDescription("Put a skill to sleep.")
        .addStringOption((option) => option.setName("skill_id").setDescription("Installed skill id.").setRequired(true)))
      .addSubcommand((subcommand) => subcommand
        .setName("disable")
        .setDescription("Disable a skill.")
        .addStringOption((option) => option.setName("skill_id").setDescription("Installed skill id.").setRequired(true)))
      .addSubcommand((subcommand) => subcommand
        .setName("search")
        .setDescription("Search skill sources.")
        .addStringOption((option) => option.setName("query").setDescription("Search query.").setRequired(true)))
      .addSubcommand((subcommand) => subcommand
        .setName("lookup")
        .setDescription("Resolve a skill source.")
        .addStringOption((option) => option.setName("query").setDescription("Lookup query or URL.").setRequired(true)))
      .addSubcommand((subcommand) => subcommand
        .setName("install")
        .setDescription("Install a skill.")
        .addStringOption((option) => option.setName("source_ref").setDescription("Skill source reference.").setRequired(true))
        .addBooleanOption((option) => option.setName("confirm_high_risk").setDescription("Confirm high-risk installs."))),
    new SlashCommandBuilder()
      .setName("mcp")
      .setDescription("Inspect or manage MCP servers.")
      .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List MCP servers."))
      .addSubcommand((subcommand) => subcommand
        .setName("connect")
        .setDescription("Connect an MCP server.")
        .addStringOption((option) => option.setName("server_id").setDescription("Server id.").setRequired(true)))
      .addSubcommand((subcommand) => subcommand
        .setName("disconnect")
        .setDescription("Disconnect an MCP server.")
        .addStringOption((option) => option.setName("server_id").setDescription("Server id.").setRequired(true)))
      .addSubcommand((subcommand) => subcommand
        .setName("templates")
        .setDescription("List MCP templates.")
        .addStringOption((option) => option.setName("query").setDescription("Optional search query.")))
      .addSubcommand((subcommand) => subcommand
        .setName("add-template")
        .setDescription("Add an MCP template.")
        .addStringOption((option) => option.setName("template_id").setDescription("Template id.").setRequired(true))),
    new SlashCommandBuilder()
      .setName("project")
      .setDescription("Assign or clear the session project.")
      .addStringOption((option) => option.setName("project_id").setDescription("Project id or none.").setRequired(true)),
    new SlashCommandBuilder()
      .setName("attach")
      .setDescription("Reference an attachment id in the next send.")
      .addStringOption((option) => option.setName("attachment_id").setDescription("Attachment id.").setRequired(true)),
    new SlashCommandBuilder()
      .setName("run")
      .setDescription("Run a named chat workflow.")
      .addStringOption((option) => option.setName("query").setDescription("Research query.").setRequired(true)),
    new SlashCommandBuilder()
      .setName("approve")
      .setDescription("Approve a pending inline tool request.")
      .addStringOption((option) => option.setName("approval_id").setDescription("Approval id.").setRequired(true)),
    new SlashCommandBuilder()
      .setName("deny")
      .setDescription("Deny a pending inline tool request.")
      .addStringOption((option) => option.setName("approval_id").setDescription("Approval id.").setRequired(true)),
  ].map((builder) => builder.toJSON());
}
