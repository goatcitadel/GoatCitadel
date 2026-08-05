/* eslint-disable max-lines -- Discord runtime behavior stays consolidated so gateway event handling remains debuggable in one place. */
import { randomUUID } from "node:crypto";
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
import { logger } from "@goatcitadel/gateway-core";
import {
  SharedHostAdmissionClosedError,
  type SharedHostLifecycleAdmissionPort,
} from "./shared-host-lifecycle-service.js";
import type {
  ChannelTypingResult,
  DiscordGuildAccessRule,
  DiscordInboundDmPolicy,
  DiscordPairingRecord,
  DiscordRuntimeMode,
  DiscordRuntimeStatus,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import {
  SHARED_CHANNEL_COMMANDS,
  findSharedChannelCommand,
  normalizeChannelApprovalToken,
} from "./channel-command-contract.js";

const log = logger.child("discord-runtime-service");

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

type DiscordSlashCommandEnvelope = Omit<DiscordInboundEnvelope, "content" | "sourceMessageId"> & {
  commandText: string;
  sourceCommandId: string;
};

interface DiscordRuntimeCallbacks {
  listConnections: () => Promise<IntegrationConnection[]>;
  findApprovedPairing: (connectionId: string, userId: string) => Promise<DiscordPairingRecord | undefined>;
  ensurePendingPairing: (connectionId: string, userId: string, displayName?: string) => Promise<DiscordPairingRecord>;
  touchPairing: (pairingId: string) => Promise<void>;
  onInboundMessage: (input: DiscordInboundEnvelope) => Promise<void>;
  /** Commits the command envelope before the interaction is acknowledged. */
  acceptSlashCommand: (input: DiscordSlashCommandEnvelope) => Promise<{ inboundEventId: string }>;
  /** Waits for the durable command owner, including replay of a prior terminal result. */
  awaitSlashCommandResult: (inboundEventId: string) => Promise<string>;
  listModelSuggestions: (
    query: string,
    limit?: number,
  ) => Promise<
    Array<{
      model: string;
      providerId?: string;
      providerLabel?: string;
    }>
  >;
  publishDiagnostic: (event: string, message: string, context: Record<string, unknown>) => void;
  sharedHostLifecycle?: SharedHostLifecycleAdmissionPort;
}

type ManagedClientRecord = {
  token: string;
  client: Client;
  connectionIds: Set<string>;
  active: boolean;
  loginInFlight: boolean;
  loginEpoch: number;
  successfulLoginEpoch?: number;
  reconnectLoginEpoch?: number;
  callbackReadyFenceEpoch?: number;
  loginTask?: Promise<void>;
  commandSyncTask?: Promise<void>;
  reconnectPhase?: "serializing" | "logging-in";
  reconnectTask?: Promise<void>;
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
  private readonly lifecycleTasks = new Set<Promise<void>>();
  private closeState: "open" | "closing" | "closed" = "open";
  private closePromise?: Promise<void>;

  public constructor(private readonly callbacks: DiscordRuntimeCallbacks) {}

  public async sync(): Promise<void> {
    if (this.closeState !== "open") return;
    const gatewayConnections = (await this.callbacks.listConnections())
      .filter((connection) => connection.kind === "channel" && connection.key === "discord" && connection.enabled)
      .filter((connection) => getDiscordRuntimeMode(connection.config) === "gateway");
    const nextGroups = new Map<string, IntegrationConnection[]>();
    for (const connection of gatewayConnections) {
      const token =
        readDiscordSecret(connection.config, "botToken", "botTokenEnv") ??
        readDiscordSecret(connection.config, "token", "tokenEnv");
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
      runtime.active = false;
      this.runtimesByToken.delete(token);
      await this.destroyRuntime(runtime);
      if (this.closeState !== "open") return;
    }

    for (const [token, connections] of nextGroups.entries()) {
      if (this.closeState !== "open") return;
      const existing = this.runtimesByToken.get(token);
      if (existing) {
        existing.connectionIds = new Set(connections.map((connection) => connection.connectionId));
        this.updateStatusSnapshot(existing);
        if (existing.ready && existing.reconnectLoginEpoch === undefined) {
          void this.scheduleApplicationCommandSync(existing, "existing-runtime").catch((error: unknown) => {
            log.warn("Detached Discord command sync rejected unexpectedly.", {
              source: "existing-runtime",
              error: getErrorMessage(error),
            });
          });
        }
        continue;
      }
      const runtime = this.createManagedRuntime(token, connections);
      this.runtimesByToken.set(token, runtime);
      this.updateStatusSnapshot(runtime);
      void this.scheduleLogin(runtime).catch((error: unknown) => {
        log.warn("Detached Discord login rejected unexpectedly.", { error: getErrorMessage(error) });
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
    if (this.closeState !== "open") return this.getConnectionStatus(connectionId);
    const runtime = [...this.runtimesByToken.values()].find((entry) => entry.connectionIds.has(connectionId));
    if (!runtime) {
      return this.getConnectionStatus(connectionId);
    }
    if (runtime.reconnectTask) {
      await runtime.reconnectTask;
      return this.getConnectionStatus(connectionId);
    }
    const reconnectTask = this.reconnectRuntime(runtime).finally(() => {
      if (runtime.reconnectTask === reconnectTask) runtime.reconnectTask = undefined;
    });
    runtime.reconnectTask = reconnectTask;
    await reconnectTask;
    return this.getConnectionStatus(connectionId);
  }

  public async sendTyping(
    connectionId: string,
    target: string,
    durationMs = 8_000,
    signal?: AbortSignal,
  ): Promise<ChannelTypingResult> {
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
      throwIfDiscordRuntimeAborted(signal);
      const channel =
        normalized.kind === "user"
          ? await (await runtime.client.users.fetch(normalized.id)).createDM()
          : await runtime.client.channels.fetch(normalized.id);
      throwIfDiscordRuntimeAborted(signal);
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
      throwIfDiscordRuntimeAborted(signal);
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
    if (this.closeState === "closed") return;
    if (this.closePromise) return this.closePromise;
    this.closeState = "closing";
    const runtimes = [...this.runtimesByToken.values()];
    const runtimesWithPendingLogin = runtimes.filter((runtime) => runtime.loginInFlight === true);
    const reconnectTasks = runtimes
      .map((runtime) => runtime.reconnectTask)
      .filter((task): task is Promise<void> => Boolean(task));
    runtimes.forEach((runtime) => {
      runtime.active = false;
      runtime.callbackReadyFenceEpoch = Math.max(
        runtime.callbackReadyFenceEpoch ?? 0,
        runtime.reconnectLoginEpoch ?? (runtime.loginEpoch ?? 0) + 1,
      );
    });
    this.closePromise = (async () => {
      // Destroy first so Discord can settle an in-flight login, then wait for
      // every lifecycle-counted network task before the owner is cleared.
      await Promise.allSettled(runtimes.map((runtime) => this.destroyRuntime(runtime)));
      await Promise.allSettled([...this.lifecycleTasks]);
      await Promise.allSettled(reconnectTasks);
      // A login promise may settle after the first destroy call. Destroy once
      // more after task settlement so no client can become live after close.
      await Promise.allSettled(runtimesWithPendingLogin.map((runtime) => runtime.client.destroy()));
      this.runtimesByToken.clear();
      this.statusByConnectionId.clear();
      this.lifecycleTasks.clear();
      this.closeState = "closed";
    })();
    return this.closePromise;
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
      active: true,
      loginInFlight: false,
      loginEpoch: 0,
      guildIds: [],
      ready: false,
    };

    client.on("clientReady", () => {
      if (!this.isRuntimeActive(runtime)) return;
      // Provider callbacks carry no login epoch. Once explicit reconnect has
      // claimed this client, its persistent fence makes tracked authenticated
      // login settlement the sole readiness authority for every later epoch.
      if (runtime.callbackReadyFenceEpoch !== undefined) return;
      void this.scheduleApplicationCommandSync(runtime, "client-ready", true).catch((error: unknown) => {
        log.warn("Detached Discord command sync rejected unexpectedly.", {
          source: "client-ready",
          error: getErrorMessage(error),
        });
      });
    });

    client.on("messageCreate", (message: Message) => {
      if (!this.isRuntimeActive(runtime)) return;
      void this.runInboundWork("discord-message", () => this.handleMessage(runtime, message)).catch((error) => {
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
      if (!this.isRuntimeActive(runtime)) return;
      if (interaction.isAutocomplete()) {
        void this.runInboundWork("discord-autocomplete", () =>
          this.handleAutocompleteInteraction(runtime, interaction),
        ).catch((error) => {
          runtime.lastError = (error as Error).message;
          this.updateStatusSnapshot(runtime);
          this.callbacks.publishDiagnostic(
            "discord.gateway.autocomplete_error",
            "Discord autocomplete handling failed.",
            {
              connectionIds: [...runtime.connectionIds],
              interactionId: interaction.id,
              commandName: interaction.commandName,
              channelId: interaction.channelId,
              guildId: interaction.guildId,
              error: (error as Error).message,
            },
          );
        });
        return;
      }
      if (!interaction.isChatInputCommand()) {
        return;
      }
      void this.runInboundWork("discord-command", () => this.handleInteraction(runtime, interaction)).catch((error) => {
        runtime.lastError = (error as Error).message;
        this.updateStatusSnapshot(runtime);
        this.callbacks.publishDiagnostic(
          "discord.gateway.interaction_error",
          "Discord slash command handling failed.",
          {
            connectionIds: [...runtime.connectionIds],
            interactionId: interaction.id,
            commandName: interaction.commandName,
            channelId: interaction.channelId,
            guildId: interaction.guildId,
            error: (error as Error).message,
          },
        );
      });
    });

    client.on("error", (error: Error) => {
      if (!this.isRuntimeActive(runtime)) return;
      runtime.ready = false;
      runtime.lastError = error.message;
      this.updateStatusSnapshot(runtime);
      this.callbacks.publishDiagnostic("discord.gateway.error", "Discord gateway runtime error.", {
        connectionIds: [...runtime.connectionIds],
        error: error.message,
      });
    });

    client.on("shardDisconnect", () => {
      if (!this.isRuntimeActive(runtime)) return;
      runtime.ready = false;
      runtime.lastReconnectAt = new Date().toISOString();
      this.updateStatusSnapshot(runtime);
    });

    return runtime;
  }

  private async reconnectRuntime(runtime: ManagedClientRecord): Promise<void> {
    const reconnectLoginEpoch = (runtime.loginEpoch ?? 0) + 1;
    runtime.reconnectLoginEpoch = reconnectLoginEpoch;
    runtime.callbackReadyFenceEpoch = Math.max(runtime.callbackReadyFenceEpoch ?? 0, reconnectLoginEpoch);
    runtime.reconnectPhase = "serializing";
    try {
      const priorCommandSync = runtime.commandSyncTask;
      if (priorCommandSync) await priorCommandSync;
      if (!this.isRuntimeActive(runtime)) return;

      runtime.lastReconnectAt = new Date().toISOString();
      runtime.ready = false;
      runtime.lastError = undefined;
      this.updateStatusSnapshot(runtime);
      await runtime.client.destroy();
      if (runtime.loginTask) await runtime.loginTask;
      if (!this.isRuntimeActive(runtime)) return;

      runtime.reconnectPhase = "logging-in";
      await this.scheduleLogin(runtime, reconnectLoginEpoch);
      if (!this.isRuntimeActive(runtime) || runtime.successfulLoginEpoch !== reconnectLoginEpoch) return;

      // The current tracked login settlement is the only epoch-bearing ready
      // signal available from discord.js. It owns one fresh admitted sync.
      await this.scheduleApplicationCommandSync(runtime, "reconnect", true);
    } finally {
      if (runtime.reconnectLoginEpoch === reconnectLoginEpoch) runtime.reconnectLoginEpoch = undefined;
      runtime.reconnectPhase = undefined;
    }
  }

  private runInboundWork<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
    const admission = this.callbacks.sharedHostLifecycle?.tryReserve("agent", `${label}:${randomUUID()}`);
    if (admission && !admission.admitted) {
      return Promise.reject(new SharedHostAdmissionClosedError(admission.state, admission.reason));
    }
    return Promise.resolve()
      .then(work)
      .finally(() => {
        if (admission?.admitted) admission.reservation.release();
      });
  }

  private scheduleLogin(runtime: ManagedClientRecord, requestedEpoch?: number): Promise<void> {
    const existing = runtime.loginTask;
    if (existing) return existing;
    const loginEpoch = requestedEpoch ?? (runtime.loginEpoch ?? 0) + 1;
    runtime.loginEpoch = loginEpoch;
    return this.scheduleLifecycleTask(
      runtime,
      "loginTask",
      "discord-login",
      async (signal) => {
        this.assertRuntimeTaskActive(runtime, signal);
        const authenticated = await this.loginRuntime(runtime);
        this.assertRuntimeTaskActive(runtime, signal);
        if (authenticated) runtime.successfulLoginEpoch = loginEpoch;
      },
      (error) => {
        runtime.lastError = getErrorMessage(error);
        runtime.ready = false;
        this.updateStatusSnapshot(runtime);
      },
    );
  }

  private scheduleApplicationCommandSync(
    runtime: ManagedClientRecord,
    source: "existing-runtime" | "client-ready" | "reconnect",
    markReady = false,
  ): Promise<void> {
    return this.scheduleLifecycleTask(
      runtime,
      "commandSyncTask",
      `discord-command-sync:${source}`,
      async (signal) => {
        this.assertRuntimeTaskActive(runtime, signal);
        if (markReady) {
          runtime.ready = true;
          runtime.connectedBotId = runtime.client.user?.id;
          runtime.connectedBotTag = runtime.client.user?.tag ?? runtime.client.user?.username;
          runtime.guildIds = [...runtime.client.guilds.cache.keys()];
          runtime.lastReadyAt = new Date().toISOString();
          runtime.lastError = undefined;
          this.updateStatusSnapshot(runtime);
          this.callbacks.publishDiagnostic("discord.gateway.ready", "Discord gateway runtime is ready.", {
            connectionIds: [...runtime.connectionIds],
            botId: runtime.connectedBotId,
            botTag: runtime.connectedBotTag,
            guildIds: runtime.guildIds,
          });
        }
        await this.syncApplicationCommands(runtime, signal);
      },
      (error) => {
        runtime.lastError = getErrorMessage(error);
        this.updateStatusSnapshot(runtime);
        if (source !== "existing-runtime") {
          this.callbacks.publishDiagnostic("discord.gateway.commands_error", "Discord slash command sync failed.", {
            connectionIds: [...runtime.connectionIds],
            error: getErrorMessage(error),
          });
        }
      },
    );
  }

  private scheduleLifecycleTask(
    runtime: ManagedClientRecord,
    taskKey: "loginTask" | "commandSyncTask",
    label: string,
    work: (signal?: AbortSignal) => Promise<void>,
    onError: (error: unknown) => void,
  ): Promise<void> {
    const existing = runtime[taskKey];
    if (existing) return existing;
    if (!this.isRuntimeActive(runtime)) return Promise.resolve();
    const admission = this.callbacks.sharedHostLifecycle?.tryReserve("worker", `${label}:${randomUUID()}`);
    if (admission && !admission.admitted) return Promise.resolve();
    const signal = admission?.admitted ? admission.reservation.signal : undefined;
    let workPromise: Promise<void>;
    try {
      this.assertRuntimeTaskActive(runtime, signal);
      workPromise = work(signal);
    } catch (error) {
      workPromise = Promise.reject(error);
    }
    const task = workPromise
      .catch((error: unknown) => {
        if (!this.isRuntimeActive(runtime) || signal?.aborted) return;
        try {
          onError(error);
        } catch (handlerError) {
          log.warn("Discord lifecycle task error handler failed.", {
            label,
            error: getErrorMessage(handlerError),
          });
        }
      })
      .finally(() => {
        if (admission?.admitted) admission.reservation.release();
        this.lifecycleTasks.delete(task);
        if (runtime[taskKey] === task) runtime[taskKey] = undefined;
      });
    runtime[taskKey] = task;
    this.lifecycleTasks.add(task);
    return task;
  }

  private isRuntimeActive(runtime: ManagedClientRecord): boolean {
    return (
      this.closeState === "open" && runtime.active !== false && this.runtimesByToken.get(runtime.token) === runtime
    );
  }

  private assertRuntimeTaskActive(runtime: ManagedClientRecord, signal?: AbortSignal): void {
    throwIfDiscordRuntimeAborted(signal);
    if (!this.isRuntimeActive(runtime)) {
      throw new Error("Discord runtime work was cancelled because its lifecycle owner is closing.");
    }
  }

  private async loginRuntime(runtime: ManagedClientRecord): Promise<boolean> {
    runtime.loginInFlight = true;
    try {
      const authenticatedToken = await runtime.client.login(runtime.token);
      return typeof authenticatedToken === "string" && authenticatedToken.trim().length > 0;
    } finally {
      runtime.loginInFlight = false;
    }
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
    const connections = (await this.callbacks.listConnections()).filter((connection) =>
      runtime.connectionIds.has(connection.connectionId),
    );
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
    const connections = (await this.callbacks.listConnections()).filter((connection) =>
      runtime.connectionIds.has(connection.connectionId),
    );
    for (const connection of connections) {
      const handled = await this.tryHandleInteractionForConnection(runtime, connection, interaction);
      if (handled) {
        runtime.lastInboundAt = new Date().toISOString();
        this.updateStatusSnapshot(runtime);
        return;
      }
    }
    if (!interaction.deferred && !interaction.replied) {
      await interaction
        .reply({
          content: "GoatCitadel is not enabled for slash commands in this channel or DM route.",
          ephemeral: !interaction.channel?.isDMBased(),
        })
        .catch((error) =>
          this.recordInteractionResponseFailure(runtime, "discord.gateway.interaction_reply_error", error, {
            commandName: interaction.commandName,
          }),
        );
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
      await interaction.respond([]).catch((error) =>
        this.recordInteractionResponseFailure(runtime, "discord.gateway.autocomplete_response_error", error, {
          commandName: interaction.commandName,
          reason: "unsupported_command",
        }),
      );
      return;
    }
    const connections = (await this.callbacks.listConnections()).filter((connection) =>
      runtime.connectionIds.has(connection.connectionId),
    );
    const allowed = connections.some((connection) => this.canHandleAutocompleteForConnection(connection, interaction));
    if (!allowed) {
      await interaction.respond([]).catch((error) =>
        this.recordInteractionResponseFailure(runtime, "discord.gateway.autocomplete_response_error", error, {
          commandName: interaction.commandName,
          reason: "route_not_allowed",
        }),
      );
      return;
    }
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "model") {
      await interaction.respond([]).catch((error) =>
        this.recordInteractionResponseFailure(runtime, "discord.gateway.autocomplete_response_error", error, {
          commandName: interaction.commandName,
          reason: "unsupported_field",
        }),
      );
      return;
    }
    const suggestions = await this.callbacks.listModelSuggestions(String(focused.value ?? ""), 25);
    await interaction
      .respond(
        suggestions.slice(0, 25).map((item) => ({
          name: formatDiscordModelChoiceLabel(item.model, item.providerLabel ?? item.providerId),
          value: item.model,
        })),
      )
      .catch((error) =>
        this.recordInteractionResponseFailure(runtime, "discord.gateway.autocomplete_response_error", error, {
          commandName: interaction.commandName,
          reason: "suggestions",
        }),
      );
  }

  private recordInteractionResponseFailure(
    runtime: ManagedClientRecord,
    event: string,
    error: unknown,
    context: Record<string, unknown>,
  ): void {
    const message = getErrorMessage(error);
    runtime.lastError = message;
    this.updateStatusSnapshot(runtime);
    log.warn("Discord interaction response failed.", { ...context, error: message });
    this.callbacks.publishDiagnostic(event, "Discord interaction response failed.", {
      ...context,
      error: message,
    });
  }

  private async syncApplicationCommands(runtime: ManagedClientRecord, signal?: AbortSignal): Promise<void> {
    this.assertRuntimeTaskActive(runtime, signal);
    const commands = buildDiscordSlashCommandDefinitions();
    const application = runtime.client.application;
    if (!application) {
      return;
    }
    await application.commands.set(commands);
    this.assertRuntimeTaskActive(runtime, signal);

    const configuredGuildIds = new Set<string>();
    const connections = (await this.callbacks.listConnections()).filter((connection) =>
      runtime.connectionIds.has(connection.connectionId),
    );
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
      this.assertRuntimeTaskActive(runtime, signal);
      const guild =
        runtime.client.guilds.cache.get(guildId) ?? (await runtime.client.guilds.fetch(guildId).catch(() => null));
      this.assertRuntimeTaskActive(runtime, signal);
      if (!guild) {
        continue;
      }
      await guild.commands.set(commands);
      this.assertRuntimeTaskActive(runtime, signal);
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
    if (!hasAllowedDiscordRole(guildRule, message.member)) {
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
    if (!hasAllowedDiscordRole(guildRule, interaction.member)) {
      return false;
    }
    const commandText = buildCommandTextFromInteraction(interaction);
    await this.handleAcceptedCommand(interaction, {
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
    });
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
    if (!hasAllowedDiscordRole(guildRule, interaction.member)) {
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
    const approved = await this.callbacks.findApprovedPairing(connection.connectionId, message.author.id);
    if (approved) {
      await this.callbacks.touchPairing(approved.pairingId);
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
    const pending = await this.callbacks.ensurePendingPairing(
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
    const approved = await this.callbacks.findApprovedPairing(connection.connectionId, interaction.user.id);
    const commandText = buildCommandTextFromInteraction(interaction);
    if (approved) {
      await this.callbacks.touchPairing(approved.pairingId);
      await this.handleAcceptedCommand(interaction, {
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
      });
      return true;
    }
    if (dmPolicy === "open") {
      await this.handleAcceptedCommand(interaction, {
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
      });
      return true;
    }
    const pending = await this.callbacks.ensurePendingPairing(
      connection.connectionId,
      interaction.user.id,
      interaction.user.globalName ?? interaction.user.displayName ?? interaction.user.username,
    );
    const pairingMessage = `GoatCitadel pairing required. Ask the operator to approve code \`${pending.code}\` for ${connection.label}.`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: pairingMessage });
    } else {
      await interaction.reply({ content: pairingMessage });
    }
    return true;
  }

  private async handleAcceptedMessage(message: Message, task: () => Promise<void>): Promise<void> {
    // The callback is the durable acceptance boundary in production. Do not
    // emit a reaction or typing side effect until that local commit succeeds.
    await task();
    await this.markMessageSeen(message);
  }

  private async handleAcceptedCommand(
    interaction: ChatInputCommandInteraction,
    input: DiscordSlashCommandEnvelope,
  ): Promise<void> {
    // Discord interactions have a short acknowledgement deadline. Commit the
    // bounded envelope first, defer immediately, then wait for the durable
    // command owner. The provider callback never executes the mutation itself.
    const accepted = await this.callbacks.acceptSlashCommand(input);
    const ephemeral = !interaction.channel?.isDMBased();
    await interaction.deferReply({ ephemeral });
    const result = await this.callbacks.awaitSlashCommandResult(accepted.inboundEventId);
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
}

function throwIfDiscordRuntimeAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  throw reason instanceof Error
    ? reason
    : new Error(typeof reason === "string" ? reason : "Discord typing delivery aborted.");
}

function readDiscordSecret(config: Record<string, unknown>, key: string, envKey: string): string | undefined {
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
    const requireMention =
      typeof (rawRule as { requireMention?: unknown }).requireMention === "boolean"
        ? Boolean((rawRule as { requireMention?: boolean }).requireMention)
        : true;
    const users = sanitizeStringArray((rawRule as { users?: unknown }).users);
    const roles = sanitizeStringArray((rawRule as { roles?: unknown }).roles);
    const channels = sanitizeStringArray((rawRule as { channels?: unknown }).channels);
    result[guildId] = {
      requireMention,
      users: users.length > 0 ? users : undefined,
      roles: roles.length > 0 ? roles : undefined,
      channels: channels.length > 0 ? channels : undefined,
    };
  }
  return result;
}

function hasAllowedDiscordRole(rule: DiscordGuildAccessRule, member: unknown): boolean {
  if (!rule.roles || rule.roles.length === 0) {
    return true;
  }
  const roleIds = readDiscordMemberRoleIds(member);
  return rule.roles.some((roleId) => roleIds.has(roleId));
}

function readDiscordMemberRoleIds(member: unknown): Set<string> {
  const roles = (member as { roles?: unknown } | null | undefined)?.roles;
  if (Array.isArray(roles)) {
    return new Set(roles.filter((item): item is string => typeof item === "string"));
  }
  const cache = (roles as { cache?: { keys?: () => IterableIterator<string> } } | null | undefined)?.cache;
  if (typeof cache?.keys === "function") {
    return new Set(cache.keys());
  }
  return new Set();
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
  const sharedCommandText = buildSharedCommandTextFromInteraction(interaction);
  if (sharedCommandText) {
    return sharedCommandText;
  }
  switch (interaction.commandName) {
    case "help":
      return "/help";
    case "status":
      return "/status";
    case "new": {
      const title = interaction.options.getString("title");
      return title ? `/new ${title}` : "/new";
    }
    case "sethome":
      return "/sethome";
    case "mode":
      return "/mode";
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
    case "goal": {
      const goal = interaction.options.getString("goal");
      return goal ? `/goal ${goal}` : "/goal";
    }
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
      ]
        .filter((value) => value !== undefined && value !== null && String(value).trim().length > 0)
        .join(" ");
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
    case "tools":
      return "/tools";
    case "personality": {
      const requested = interaction.options.getString("name");
      return requested ? `/personality ${requested}` : "/personality";
    }
    case "stop":
      return "/stop";
    case "run": {
      const subcommand = readDiscordSubcommand(interaction);
      if (subcommand === "details") {
        return `/run details ${interaction.options.getString("run_id", true)}`;
      }
      return `/run research ${interaction.options.getString("query", true)}`;
    }
    case "approve":
      return `/approve ${readDiscordApprovalToken(interaction)}`;
    case "deny":
      return `/deny ${readDiscordApprovalToken(interaction)}`;
    default:
      return `/${interaction.commandName}`;
  }
}

function buildSharedCommandTextFromInteraction(interaction: ChatInputCommandInteraction): string | undefined {
  const definition = findSharedChannelCommand(interaction.commandName);
  if (!definition?.platforms.includes("discord")) {
    return undefined;
  }
  switch (definition.name) {
    case "new": {
      const title = interaction.options.getString("title");
      return title ? "/new " + title : "/new";
    }
    case "skill": {
      const name = interaction.options.getString("name");
      return name ? "/skill " + name : "/skill";
    }
    case "memory": {
      const query = interaction.options.getString("query", true);
      return "/memory " + query;
    }
    case "recall": {
      const query = interaction.options.getString("query", true);
      return "/recall " + query;
    }
    case "search": {
      const query = interaction.options.getString("query", true);
      return "/search " + query;
    }
    case "personality": {
      const requested = interaction.options.getString("name");
      return requested ? "/personality " + requested : "/personality";
    }
    case "run": {
      const subcommand = readDiscordSubcommand(interaction);
      if (subcommand === "details") {
        return "/run details " + interaction.options.getString("run_id", true);
      }
      return "/run research " + interaction.options.getString("query", true);
    }
    case "approve":
      return "/approve " + readDiscordApprovalToken(interaction);
    case "deny":
      return "/deny " + readDiscordApprovalToken(interaction);
    default:
      return "/" + definition.name;
  }
}

function readDiscordSubcommand(interaction: ChatInputCommandInteraction): string | undefined {
  try {
    return interaction.options.getSubcommand(false) || undefined;
  } catch {
    return undefined;
  }
}

function readDiscordApprovalToken(interaction: ChatInputCommandInteraction): string {
  const actionToken =
    interaction.options.getString("action_token") ??
    interaction.options.getString("approval_token") ??
    interaction.options.getString("approval_id");
  return normalizeChannelApprovalToken(actionToken ?? "") ?? "";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function buildDiscordSlashCommandDefinitions(): RESTPostAPIApplicationCommandsJSONBody[] {
  const stringChoice = (value: string) => ({ name: value, value });
  const sharedCommands = buildSharedDiscordSlashCommandDefinitions();
  const sharedNames = new Set(sharedCommands.map((command) => command.name));

  const discordSpecificCommands = [
    new SlashCommandBuilder().setName("help").setDescription("Show GoatCitadel chat commands."),
    new SlashCommandBuilder().setName("status").setDescription("Show GoatCitadel channel status."),
    new SlashCommandBuilder()
      .setName("new")
      .setDescription("Start a fresh GoatCitadel session for this Discord route.")
      .addStringOption((option) => option.setName("title").setDescription("Optional session title.")),
    new SlashCommandBuilder()
      .setName("sethome")
      .setDescription("Set the current Discord channel or DM as the home delivery target."),
    new SlashCommandBuilder().setName("mode").setDescription("Show the active GoatCitadel chat surface."),
    new SlashCommandBuilder()
      .setName("plan")
      .setDescription("Show or set planning mode.")
      .addStringOption((option) =>
        option
          .setName("state")
          .setDescription("Set planning mode.")
          .addChoices(stringChoice("on"), stringChoice("off")),
      ),
    new SlashCommandBuilder()
      .setName("model")
      .setDescription("Override the active model for this session.")
      .addStringOption((option) =>
        option.setName("model").setDescription("Model id.").setRequired(true).setAutocomplete(true),
      ),
    new SlashCommandBuilder()
      .setName("web")
      .setDescription("Set web retrieval behavior.")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("Web mode.")
          .setRequired(true)
          .addChoices(stringChoice("auto"), stringChoice("off"), stringChoice("quick"), stringChoice("deep")),
      ),
    new SlashCommandBuilder()
      .setName("memory")
      .setDescription("Set memory behavior.")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("Memory mode.")
          .setRequired(true)
          .addChoices(stringChoice("auto"), stringChoice("on"), stringChoice("off")),
      ),
    new SlashCommandBuilder()
      .setName("goal")
      .setDescription("Run or list bounded session goal loops.")
      .addStringOption((option) => option.setName("goal").setDescription("Goal objective. Leave blank to list goals.")),
    new SlashCommandBuilder()
      .setName("think")
      .setDescription("Set thinking depth.")
      .addStringOption((option) =>
        option
          .setName("level")
          .setDescription("Thinking level.")
          .setRequired(true)
          .addChoices(stringChoice("minimal"), stringChoice("standard"), stringChoice("extended")),
      ),
    new SlashCommandBuilder()
      .setName("tool")
      .setDescription("Set tool autonomy mode.")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("Tool autonomy.")
          .setRequired(true)
          .addChoices(stringChoice("safe_auto"), stringChoice("manual")),
      ),
    new SlashCommandBuilder()
      .setName("proactive")
      .setDescription("Set proactive mode.")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("Proactive mode.")
          .setRequired(true)
          .addChoices(
            stringChoice("off"),
            stringChoice("suggest"),
            stringChoice("auto_safe"),
            stringChoice("auto_full"),
          ),
      ),
    new SlashCommandBuilder()
      .setName("retrieval")
      .setDescription("Set retrieval routing mode.")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("Retrieval mode.")
          .setRequired(true)
          .addChoices(stringChoice("standard"), stringChoice("layered")),
      ),
    new SlashCommandBuilder()
      .setName("reflect")
      .setDescription("Toggle reflection retry mode.")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("Reflection mode.")
          .setRequired(true)
          .addChoices(stringChoice("off"), stringChoice("on")),
      ),
    new SlashCommandBuilder()
      .setName("research")
      .setDescription("Run quick research in the current session.")
      .addStringOption((option) => option.setName("query").setDescription("Research query.").setRequired(true)),
    new SlashCommandBuilder()
      .setName("delegate")
      .setDescription("Run task-backed role delegation.")
      .addStringOption((option) => option.setName("roles").setDescription("Comma-separated roles.").setRequired(true))
      .addStringOption((option) =>
        option.setName("objective").setDescription("Delegation objective.").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("pipeline")
      .setDescription("Run a built-in delegation template.")
      .addStringOption((option) =>
        option
          .setName("template")
          .setDescription("Template id.")
          .setRequired(true)
          .addChoices(stringChoice("prd"), stringChoice("build"), stringChoice("triage"), stringChoice("release")),
      )
      .addStringOption((option) => option.setName("objective").setDescription("Pipeline objective.").setRequired(true)),
    new SlashCommandBuilder()
      .setName("score")
      .setDescription("Score the latest prompt-pack run.")
      .addStringOption((option) => option.setName("test").setDescription("Prompt-pack test code.").setRequired(true))
      .addIntegerOption((option) =>
        option.setName("routing").setDescription("Routing score.").setRequired(true).setMinValue(0).setMaxValue(10),
      )
      .addIntegerOption((option) =>
        option.setName("honesty").setDescription("Honesty score.").setRequired(true).setMinValue(0).setMaxValue(10),
      )
      .addIntegerOption((option) =>
        option.setName("handoff").setDescription("Handoff score.").setRequired(true).setMinValue(0).setMaxValue(10),
      )
      .addIntegerOption((option) =>
        option
          .setName("robustness")
          .setDescription("Robustness score.")
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(10),
      )
      .addIntegerOption((option) =>
        option.setName("usability").setDescription("Usability score.").setRequired(true).setMinValue(0).setMaxValue(10),
      )
      .addStringOption((option) => option.setName("notes").setDescription("Optional scoring note.")),
    new SlashCommandBuilder()
      .setName("pack")
      .setDescription("Run prompt-pack tests.")
      .addStringOption((option) => option.setName("selector").setDescription("Test selector or all.")),
    new SlashCommandBuilder().setName("skills").setDescription("List installed skills."),
    new SlashCommandBuilder()
      .setName("skill")
      .setDescription("Manage skills.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("enable")
          .setDescription("Enable a skill.")
          .addStringOption((option) =>
            option.setName("skill_id").setDescription("Installed skill id.").setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("sleep")
          .setDescription("Put a skill to sleep.")
          .addStringOption((option) =>
            option.setName("skill_id").setDescription("Installed skill id.").setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("disable")
          .setDescription("Disable a skill.")
          .addStringOption((option) =>
            option.setName("skill_id").setDescription("Installed skill id.").setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("search")
          .setDescription("Search skill sources.")
          .addStringOption((option) => option.setName("query").setDescription("Search query.").setRequired(true)),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("lookup")
          .setDescription("Resolve a skill source.")
          .addStringOption((option) =>
            option.setName("query").setDescription("Lookup query or URL.").setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("install")
          .setDescription("Install a skill.")
          .addStringOption((option) =>
            option.setName("source_ref").setDescription("Skill source reference.").setRequired(true),
          )
          .addBooleanOption((option) =>
            option.setName("confirm_high_risk").setDescription("Confirm high-risk installs."),
          ),
      ),
    new SlashCommandBuilder()
      .setName("mcp")
      .setDescription("Inspect or manage MCP servers.")
      .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List MCP servers."))
      .addSubcommand((subcommand) =>
        subcommand
          .setName("connect")
          .setDescription("Connect an MCP server.")
          .addStringOption((option) => option.setName("server_id").setDescription("Server id.").setRequired(true)),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("disconnect")
          .setDescription("Disconnect an MCP server.")
          .addStringOption((option) => option.setName("server_id").setDescription("Server id.").setRequired(true)),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("templates")
          .setDescription("List MCP templates.")
          .addStringOption((option) => option.setName("query").setDescription("Optional search query.")),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("add-template")
          .setDescription("Add an MCP template.")
          .addStringOption((option) => option.setName("template_id").setDescription("Template id.").setRequired(true)),
      ),
    new SlashCommandBuilder()
      .setName("project")
      .setDescription("Assign or clear the session project.")
      .addStringOption((option) =>
        option.setName("project_id").setDescription("Project id or none.").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("attach")
      .setDescription("Reference an attachment id in the next send.")
      .addStringOption((option) => option.setName("attachment_id").setDescription("Attachment id.").setRequired(true)),
    new SlashCommandBuilder().setName("tools").setDescription("Show channel tool posture and approval policy."),
    new SlashCommandBuilder()
      .setName("personality")
      .setDescription("Show or set the channel personality.")
      .addStringOption((option) => option.setName("name").setDescription("Personality id, or none.")),
    new SlashCommandBuilder().setName("stop").setDescription("Stop the active channel run where supported."),
    new SlashCommandBuilder()
      .setName("run")
      .setDescription("Run a named chat workflow.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("research")
          .setDescription("Run quick research.")
          .addStringOption((option) => option.setName("query").setDescription("Research query.").setRequired(true)),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("details")
          .setDescription("Show details for a run id.")
          .addStringOption((option) => option.setName("run_id").setDescription("Run id.").setRequired(true)),
      ),
    new SlashCommandBuilder()
      .setName("approve")
      .setDescription("Approve a pending inline tool request.")
      .addStringOption((option) =>
        option.setName("action_token").setDescription("Remote approval action token.").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("deny")
      .setDescription("Deny a pending inline tool request.")
      .addStringOption((option) =>
        option.setName("action_token").setDescription("Remote approval action token.").setRequired(true),
      ),
  ]
    .map((builder) => builder.toJSON())
    .filter((command) => !sharedNames.has(command.name));
  return [...sharedCommands, ...discordSpecificCommands];
}

function buildSharedDiscordSlashCommandDefinitions(): RESTPostAPIApplicationCommandsJSONBody[] {
  return SHARED_CHANNEL_COMMANDS.filter((definition) => definition.platforms.includes("discord")).map((definition) =>
    buildSharedDiscordSlashCommandDefinition(definition.name, definition.description),
  );
}

function buildSharedDiscordSlashCommandDefinition(
  name: string,
  description: string,
): RESTPostAPIApplicationCommandsJSONBody {
  const builder = new SlashCommandBuilder().setName(name).setDescription(description);
  switch (name) {
    case "new":
      builder.addStringOption((option) => option.setName("title").setDescription("Optional session title."));
      break;
    case "skill":
      builder.addStringOption((option) => option.setName("name").setDescription("Visible skill binding name."));
      break;
    case "memory":
      builder.addStringOption((option) =>
        option.setName("query").setDescription("Memory query, or auto/on/off to set memory mode.").setRequired(true),
      );
      break;
    case "recall":
    case "search":
      builder.addStringOption((option) => option.setName("query").setDescription("Lookup query.").setRequired(true));
      break;
    case "personality":
      builder.addStringOption((option) => option.setName("name").setDescription("Personality id, or none."));
      break;
    case "run":
      builder
        .addSubcommand((subcommand) =>
          subcommand
            .setName("research")
            .setDescription("Run quick research.")
            .addStringOption((option) => option.setName("query").setDescription("Research query.").setRequired(true)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("details")
            .setDescription("Show details for a run id.")
            .addStringOption((option) => option.setName("run_id").setDescription("Run id.").setRequired(true)),
        );
      break;
    case "approve":
    case "deny":
      builder.addStringOption((option) =>
        option.setName("action_token").setDescription("Remote approval action token.").setRequired(true),
      );
      break;
    default:
      break;
  }
  return builder.toJSON();
}

export const __discordRuntimeServiceInternals = {
  buildCommandTextFromInteraction,
  buildDiscordSlashCommandDefinitions,
  formatDiscordModelChoiceLabel,
  getDiscordGuildPolicy,
  getDiscordInboundDmPolicy,
  getDiscordRuntimeMode,
  getErrorMessage,
  normalizeDiscordRuntimeTarget,
  readConfigString,
  readDiscordApprovalToken,
  readDiscordSecret,
  readDiscordSubcommand,
  readGuildRuleMap,
  resolveDiscordGuildRule,
  sanitizeGuildRules,
  sanitizeStringArray,
  supportsTyping,
  throwIfDiscordRuntimeAborted,
  truncateDiscordResponse,
};
