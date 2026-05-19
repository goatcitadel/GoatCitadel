import { randomUUID } from "node:crypto";
import { resolveSessionRoute } from "@goatcitadel/gateway-core";
import type {
  ApprovalResolveInput,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  IntegrationConnection,
  IntegrationConnectionUpdateInput,
  PersonalityCatalogResponse,
} from "@goatcitadel/contracts";
import type { ApprovalResolveResult } from "./approval-types.js";
import type { ChatCommandOptions } from "./chat-command-service.js";
import {
  DEFAULT_CHANNEL_TOOLSET_POSTURE,
  findSharedChannelCommand,
  normalizeChannelCommandInput,
} from "./channel-command-contract.js";
import { getPersonalityPreset, listPersonalityPresets, normalizePersonalityId } from "./channel-personalities.js";

const DEFAULT_DISCORD_WORKSPACE_ID = "default";
const DISCORD_ROUTE_SESSIONS_SETTING_KEY = "discord_route_sessions_v1";

export interface DiscordRouteSessionRecord {
  connectionId: string;
  target: string;
  logicalSessionKey: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiscordRuntimeBridgeHost {
  readonly storage: {
    chatSessionBindings: {
      upsert(
        input: {
          sessionId: string;
          workspaceId: string;
          transport: "integration";
          connectionId: string;
          target: string;
          writable: boolean;
        },
        now?: string,
      ): void;
    };
    chatSessionMeta: {
      ensure(sessionId: string, now?: string, workspaceId?: string): { workspaceId?: string };
    };
    chatSessionPrefs: {
      ensure(sessionId: string, now?: string): void;
    };
    chatSessionProjects: {
      get(sessionId: string): { projectId: string } | undefined;
    };
    integrationConnections: {
      get(connectionId: string): IntegrationConnection;
      update(connectionId: string, input: IntegrationConnectionUpdateInput): IntegrationConnection;
    };
    sessions: {
      upsert(input: {
        sessionId: string;
        sessionKey: string;
        kind: string;
        channel: string;
        account: string;
        displayName?: string;
        timestamp: string;
      }): unknown;
    };
    systemSettings: {
      get<T>(key: string): { value: T } | undefined;
      set(key: string, value: unknown): void;
    };
  };
  readonly operatorSummaryCache: {
    invalidate(): void;
  };
  assignChatSessionProject(sessionId: string, projectId?: string): unknown;
  cancelLatestActiveChatTurnForSession(
    sessionId: string,
    cancelledBy?: string,
  ): Promise<{
    status: "cancelled" | "no_active_run" | "failed";
    sessionId?: string;
    turnId?: string;
    durableRunId?: string;
    durableCancelled?: boolean;
    error?: string;
  }>;
  ensureChatSessionRuntimeGrants(sessionId: string): void;
  getPersonalityCatalog?(): PersonalityCatalogResponse;
  getChatSessionPrefs(sessionId: string): ChatSessionPrefsRecord;
  hasRunningTurn(sessionId: string): boolean;
  ingestChannelMessage(
    channel: string,
    dedupeKey: string,
    input: {
      eventId: string;
      account: string;
      peer?: string;
      room?: string;
      threadId?: string;
      actorId: string;
      actorType: "user";
      content: string;
      displayName?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ deduped: boolean; session: { sessionId: string } }>;
  isChatTurnWriteConflict(error: unknown): boolean;
  parseChatCommand(sessionId: string, commandText: string, options?: ChatCommandOptions): Promise<{ message: string }>;
  recordDevDiagnostic(input: {
    level: "info" | "warn" | "error";
    category: string;
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }): void;
  requireChatSession(sessionId: string): ChatSessionRecord;
  resolveApprovalWithRemoteToken(input: {
    token: string;
    decision: ApprovalResolveInput["decision"];
    resolvedBy?: string;
  }): Promise<ApprovalResolveResult>;
  respondToExistingChatMessage(sessionId: string, sourceMessageId: string): Promise<unknown>;
  setChatSessionBinding(input: {
    sessionId: string;
    transport: "integration";
    connectionId: string;
    target: string;
    writable: boolean;
  }): void;
  updateChatSession(sessionId: string, patch: { title?: string }): unknown;
  updateChatSessionPrefs(sessionId: string, patch: Record<string, unknown>): unknown;
}

export function readDiscordRouteSessions(host: DiscordRuntimeBridgeHost): DiscordRouteSessionRecord[] {
  return host.storage.systemSettings.get<DiscordRouteSessionRecord[]>(DISCORD_ROUTE_SESSIONS_SETTING_KEY)?.value ?? [];
}

// SECURITY (codex finding #4): Operator allowlist for Discord-side commands
// that mutate operator config (`/sethome`, etc.). The field is
// `discordOperatorActors: string[]` (or legacy `operatorActorIds`) in
// connection.config. Empty/missing means "no Discord user is an operator"
// — operators can still change `defaultChannelId` via Mission Control.
export function isDiscordChannelOperator(config: Record<string, unknown>, actorId: string): boolean {
  if (!actorId.trim()) {
    return false;
  }
  const candidates = [
    Array.isArray(config.discordOperatorActors) ? config.discordOperatorActors : undefined,
    Array.isArray((config as Record<string, unknown>).operatorActorIds)
      ? (config as Record<string, unknown>).operatorActorIds
      : undefined,
  ];
  for (const list of candidates) {
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (typeof entry === "string" && entry.trim() === actorId.trim()) {
          return true;
        }
      }
    }
  }
  return false;
}

export function writeDiscordRouteSessions(host: DiscordRuntimeBridgeHost, records: DiscordRouteSessionRecord[]): void {
  host.storage.systemSettings.set(DISCORD_ROUTE_SESSIONS_SETTING_KEY, records);
}

export function resolveDiscordInboundRoute(
  host: DiscordRuntimeBridgeHost,
  input: {
    connectionId: string;
    target: string;
    peer?: string;
    room?: string;
    threadId?: string;
  },
): {
  peer?: string;
  room?: string;
  threadId?: string;
} {
  const routeSession = readDiscordRouteSessions(host).find(
    (item) => item.connectionId === input.connectionId && item.target === input.target,
  );
  if (!routeSession?.logicalSessionKey) {
    return {
      peer: input.peer,
      room: input.room ?? input.target,
      threadId: input.threadId,
    };
  }
  const room = input.room ?? input.target;
  const threadIdBase = input.threadId?.trim() ? `discord_${input.threadId.trim()}` : "discord";
  return {
    room,
    threadId: `${threadIdBase}_${routeSession.logicalSessionKey}`,
  };
}

export function ensureDiscordChatSession(
  host: DiscordRuntimeBridgeHost,
  input: {
    connectionId: string;
    target: string;
    displayName?: string;
    peer?: string;
    room?: string;
    threadId?: string;
  },
): ChatSessionRecord {
  const route = resolveDiscordInboundRoute(host, input);
  const resolution = resolveSessionRoute({
    channel: "discord",
    account: input.connectionId,
    peer: route.peer,
    room: route.room,
    threadId: route.threadId,
  });
  const now = new Date().toISOString();
  host.storage.sessions.upsert({
    sessionId: resolution.sessionId,
    sessionKey: resolution.sessionKey,
    kind: resolution.kind,
    channel: "discord",
    account: input.connectionId,
    displayName: input.displayName?.trim() || undefined,
    timestamp: now,
  });
  host.operatorSummaryCache.invalidate();
  host.storage.chatSessionMeta.ensure(resolution.sessionId, now, DEFAULT_DISCORD_WORKSPACE_ID);
  host.storage.chatSessionPrefs.ensure(resolution.sessionId, now);
  host.ensureChatSessionRuntimeGrants(resolution.sessionId);
  host.storage.chatSessionBindings.upsert(
    {
      sessionId: resolution.sessionId,
      workspaceId: DEFAULT_DISCORD_WORKSPACE_ID,
      transport: "integration",
      connectionId: input.connectionId,
      target: input.target,
      writable: true,
    },
    now,
  );
  return host.requireChatSession(resolution.sessionId);
}

export function startNewDiscordRouteSession(
  host: DiscordRuntimeBridgeHost,
  input: {
    connectionId: string;
    target: string;
    displayName?: string;
    peer?: string;
    room?: string;
    threadId?: string;
    title?: string;
  },
): ChatSessionRecord {
  const sourceSession = ensureDiscordChatSession(host, input);
  const records = readDiscordRouteSessions(host);
  const now = new Date().toISOString();
  const logicalSessionKey = randomUUID().replaceAll("-", "").slice(0, 12);
  const nextRecord: DiscordRouteSessionRecord = {
    connectionId: input.connectionId,
    target: input.target,
    logicalSessionKey,
    sessionId: "",
    createdAt: now,
    updatedAt: now,
  };
  writeDiscordRouteSessions(host, [
    nextRecord,
    ...records.filter((item) => !(item.connectionId === input.connectionId && item.target === input.target)),
  ]);
  const createdSession = ensureDiscordChatSession(host, input);
  nextRecord.sessionId = createdSession.sessionId;
  writeDiscordRouteSessions(host, [
    nextRecord,
    ...records.filter((item) => !(item.connectionId === input.connectionId && item.target === input.target)),
  ]);
  cloneChatSessionContext(host, sourceSession.sessionId, createdSession.sessionId);
  if (input.title?.trim()) {
    host.updateChatSession(createdSession.sessionId, { title: input.title.trim() });
  }
  return host.requireChatSession(createdSession.sessionId);
}

export async function handleDiscordRuntimeSlashCommand(
  host: DiscordRuntimeBridgeHost,
  input: {
    connectionId: string;
    target: string;
    actorId: string;
    displayName?: string;
    commandText: string;
    sourceCommandId: string;
    peer?: string;
    room?: string;
    threadId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<string> {
  const commandText = input.commandText.trim();
  if (!commandText.startsWith("/")) {
    return "Command must start with '/'.";
  }
  const normalizedCommand = normalizeChannelCommandInput(commandText, { platform: "discord" });
  if (normalizedCommand.name === "new") {
    const title = normalizedCommand.argText;
    const session = startNewDiscordRouteSession(host, {
      connectionId: input.connectionId,
      target: input.target,
      displayName: input.displayName,
      peer: input.peer,
      room: input.room,
      threadId: input.threadId,
      title,
    });
    return title
      ? `Started a new session: ${title} (${session.sessionId.slice(-6)}).`
      : `Started a new session (${session.sessionId.slice(-6)}).`;
  }
  if (
    (normalizedCommand.name === "approve" || normalizedCommand.name === "deny") &&
    normalizedCommand.approvalDecision
  ) {
    if (!normalizedCommand.approvalToken) {
      return `Use ${normalizedCommand.command} <action-token> from an approval message.`;
    }
    const result = await host.resolveApprovalWithRemoteToken({
      token: normalizedCommand.approvalToken,
      decision: normalizedCommand.approvalDecision,
      resolvedBy: `discord:${input.actorId}`,
    });
    return normalizedCommand.approvalDecision === "approve"
      ? `Approved ${result.approval.approvalId}. GoatCitadel will resume any waiting work it can safely resume.`
      : `Rejected ${result.approval.approvalId}. GoatCitadel will keep the requested action blocked.`;
  }
  if (
    normalizedCommand.name === "status" ||
    normalizedCommand.name === "sethome" ||
    normalizedCommand.name === "skills" ||
    normalizedCommand.name === "skill" ||
    normalizedCommand.name === "tools" ||
    normalizedCommand.name === "personality" ||
    normalizedCommand.name === "stop"
  ) {
    return handleDiscordSharedChannelCommand(host, input, normalizedCommand);
  }

  const session = ensureDiscordChatSession(host, {
    connectionId: input.connectionId,
    target: input.target,
    displayName: input.displayName,
    peer: input.peer,
    room: input.room,
    threadId: input.threadId,
  });
  const sharedDefinition = normalizedCommand.name ? findSharedChannelCommand(normalizedCommand.name) : undefined;
  if (!sharedDefinition?.bypassesActiveRunGuard && host.hasRunningTurn(session.sessionId)) {
    return "A GoatCitadel run is already active for this Discord channel. Use /status to inspect it or /stop to cancel it before starting another request.";
  }
  const result = await host.parseChatCommand(session.sessionId, commandText, {
    resolvedBy: `discord:${input.actorId}`,
    source: "channel",
    channelContext: {
      platform: "discord",
      account: input.connectionId,
      actorId: input.actorId,
    },
  });
  return result.message;
}

async function handleDiscordSharedChannelCommand(
  host: DiscordRuntimeBridgeHost,
  input: Parameters<typeof handleDiscordRuntimeSlashCommand>[1],
  command: ReturnType<typeof normalizeChannelCommandInput>,
): Promise<string> {
  const connection = host.storage.integrationConnections.get(input.connectionId);
  switch (command.name) {
    case "status":
      return renderDiscordStatus(connection, input.target, host.getPersonalityCatalog?.());
    case "sethome": {
      // SECURITY (codex finding #4): `/sethome` rewrites operator config
      // (`defaultChannelId`/`defaultDiscordChannelId`) and reroutes future
      // background/scheduled deliveries — including the watchdog
      // notification path. Approved pairings / channel allowlist
      // membership / `inboundDmPolicy=open` are chat-access boundaries,
      // not operator boundaries. Require the actor to appear in the
      // connection's Discord operator allowlist
      // (`discordOperatorActors`/`operatorActorIds` in connection.config).
      if (!isDiscordChannelOperator(connection.config, input.actorId)) {
        return [
          "Only operators can change the home channel.",
          "Ask an operator to add your Discord user ID to the operator allowlist in GoatCitadel settings.",
        ].join(" ");
      }
      host.storage.integrationConnections.update(input.connectionId, {
        config: {
          ...connection.config,
          defaultChannelId: input.target,
          defaultDiscordChannelId: input.target,
          homeChannelSetAt: new Date().toISOString(),
        },
        lastSyncAt: new Date().toISOString(),
        lastError: null,
      });
      return `Home channel set to this Discord channel (${input.target}). Background summaries will use it when no more specific target is selected.`;
    }
    case "skills":
      return renderDiscordSkills(connection.config);
    case "skill":
      return renderDiscordSkill(command.argText, connection.config);
    case "tools":
      return renderDiscordTools();
    case "personality":
      return handleDiscordPersonalityCommand(host, input, command.argText, connection);
    case "stop": {
      const session = ensureDiscordChatSession(host, input);
      const outcome = await host.cancelLatestActiveChatTurnForSession(session.sessionId, `discord:${input.actorId}`);
      if (outcome.status === "no_active_run") {
        return "No active Discord channel run is currently running for this channel.";
      }
      if (outcome.status === "failed") {
        return `Could not stop the active Discord channel run: ${outcome.error ?? "unknown error"}`;
      }
      return outcome.durableRunId
        ? `Stopped the active Discord channel run. Linked durable run ${outcome.durableRunId} was ${outcome.durableCancelled === false ? "already terminal or could not be cancelled" : "cancelled too"}.`
        : "Stopped the active Discord channel run.";
    }
    default:
      return "Command is not available on Discord yet.";
  }
}

function renderDiscordStatus(
  connection: IntegrationConnection,
  target: string,
  catalog?: PersonalityCatalogResponse,
): string {
  const active = getPersonalityPreset(readActiveDiscordPersonality(connection.config, target), catalog?.items);
  const home = readString(connection.config.defaultChannelId) ?? readString(connection.config.defaultDiscordChannelId);
  return [
    "GoatCitadel Discord status",
    "",
    `Connection: ${connection.label}`,
    `Enabled: ${connection.enabled ? "yes" : "no"}`,
    `Status: ${connection.status}`,
    `Home channel: ${home ? (home === target ? "this channel" : home) : "not set"}`,
    `Personality: ${active.label}`,
    `Commands: ${["/status", "/sethome", "/personality", "/tools", "/skills", "/stop", "/new"].join(", ")}`,
    "Trust: channel requests can ask for tools, but terminal/filesystem/network actions remain policy- and approval-gated.",
  ].join("\n");
}

function renderDiscordSkills(config: Record<string, unknown>): string {
  const bindings = readSkillBindings(config);
  if (bindings.length === 0) {
    return "No channel-specific skills are enabled for this Discord connection yet. Configure visible skill bindings in Mission Control before using /skill <name>.";
  }
  return ["Enabled channel skills:", ...bindings.map((item) => `- ${item.alias}: ${item.skillId}`)].join("\n");
}

function renderDiscordSkill(name: string, config: Record<string, unknown>): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return "Use /skill <name> to inspect a visible channel skill binding.";
  }
  const binding = readSkillBindings(config).find((item) => item.enabled && item.alias.toLowerCase() === normalized);
  if (!binding) {
    return `No visible channel skill binding matched "${name.trim()}". Use /skills to list enabled skills.`;
  }
  return `Skill "${binding.alias}" is available and will run through GoatCitadel's normal skill trust and approval policy. Send your request as a normal message and mention ${binding.alias}.`;
}

function renderDiscordTools(): string {
  return [
    "Channel tool posture",
    "",
    ...DEFAULT_CHANNEL_TOOLSET_POSTURE.map(
      (item) =>
        `- ${item.label}: ${item.enabled ? item.approval.replace("_", " ") : "unavailable"} - ${item.riskSummary}`,
    ),
  ].join("\n");
}

function handleDiscordPersonalityCommand(
  host: DiscordRuntimeBridgeHost,
  input: Parameters<typeof handleDiscordRuntimeSlashCommand>[1],
  argument: string,
  connection: IntegrationConnection,
): string {
  const catalog = host.getPersonalityCatalog?.() ?? {
    items: listPersonalityPresets(),
    defaultPersonalityId: "default",
  };
  if (!argument.trim()) {
    return [
      "Available personalities:",
      ...catalog.items.map((preset) => `- ${preset.id}: ${preset.description}`),
      "",
      "Use /personality <name> to set one for this channel, or /personality none to clear it.",
    ].join("\n");
  }

  const requested = normalizePersonalityId(argument);
  const preset = getPersonalityPreset(requested, catalog.items);
  if (requested !== "default" && preset.id === "default") {
    return `Unknown personality "${argument.trim()}". Use /personality to list available presets.`;
  }

  const current = readRecord(connection.config.channelPersonalities);
  const nextPersonalities = { ...current };
  if (preset.id === "default") {
    delete nextPersonalities[input.target];
  } else {
    nextPersonalities[input.target] = preset.id;
  }
  host.storage.integrationConnections.update(input.connectionId, {
    config: {
      ...connection.config,
      channelPersonalities: nextPersonalities,
      channelPersonalityUpdatedAt: new Date().toISOString(),
    },
    lastSyncAt: new Date().toISOString(),
    lastError: null,
  });
  return preset.id === "default"
    ? "Personality cleared for this Discord channel. GoatCitadel is back to the default voice."
    : `Personality set to ${preset.label} for this Discord channel.\n\n${preset.description}`;
}

function readActiveDiscordPersonality(config: Record<string, unknown>, target: string): string {
  const personalities = readRecord(config.channelPersonalities);
  const targetValue = readString(personalities[target]);
  return normalizePersonalityId(targetValue ?? readString(config.defaultPersonalityId));
}

function readSkillBindings(
  config: Record<string, unknown>,
): Array<{ skillId: string; alias: string; enabled: boolean }> {
  const raw = config.channelSkillBindings;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      skillId: readString(item.skillId) ?? "",
      alias: readString(item.alias) ?? readString(item.skillId) ?? "",
      enabled: item.enabled !== false,
    }))
    .filter((item) => item.skillId && item.alias);
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export async function handleDiscordRuntimeInbound(
  host: DiscordRuntimeBridgeHost,
  input: {
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
  },
): Promise<void> {
  const route = resolveDiscordInboundRoute(host, input);
  const ingestResult = await host.ingestChannelMessage(
    "discord",
    `discord:${input.connectionId}:${input.sourceMessageId}`,
    {
      eventId: input.sourceMessageId,
      account: input.connectionId,
      peer: route.peer,
      room: route.room,
      threadId: route.threadId,
      actorId: input.actorId,
      actorType: "user",
      content: input.content,
      displayName: input.displayName,
      metadata: input.metadata,
    },
  );
  host.setChatSessionBinding({
    sessionId: ingestResult.session.sessionId,
    transport: "integration",
    connectionId: input.connectionId,
    target: input.target,
    writable: true,
  });
  if (!ingestResult.deduped && host.hasRunningTurn(ingestResult.session.sessionId)) {
    host.recordDevDiagnostic({
      level: "warn",
      category: "channels",
      event: "discord.gateway.active_run_guard",
      message:
        "Discord inbound message was ingested, but reply generation was skipped because a run is already active.",
      context: {
        connectionId: input.connectionId,
        sessionId: ingestResult.session.sessionId,
        sourceMessageId: input.sourceMessageId,
      },
    });
    return;
  }
  if (!ingestResult.deduped) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await host.respondToExistingChatMessage(ingestResult.session.sessionId, input.sourceMessageId);
        return;
      } catch (error) {
        if (!host.isChatTurnWriteConflict(error)) {
          throw error;
        }
        if (attempt >= 3) {
          host.recordDevDiagnostic({
            level: "warn",
            category: "channels",
            event: "discord.gateway.reply_conflict",
            message: "Discord inbound message was ingested, but reply generation conflicted with an active chat turn.",
            context: {
              connectionId: input.connectionId,
              sessionId: ingestResult.session.sessionId,
              sourceMessageId: input.sourceMessageId,
              attempt,
              error: error instanceof Error ? error.message : String(error),
            },
          });
          return;
        }
        await wait(attempt * 750);
      }
    }
  }
}

export function cloneChatSessionContext(
  host: DiscordRuntimeBridgeHost,
  sourceSessionId: string,
  targetSessionId: string,
): void {
  if (sourceSessionId === targetSessionId) {
    return;
  }
  const {
    sessionId: _sourceSessionId,
    createdAt: _sourceCreatedAt,
    updatedAt: _sourceUpdatedAt,
    ...prefsPatch
  } = host.getChatSessionPrefs(sourceSessionId);
  host.updateChatSessionPrefs(targetSessionId, prefsPatch);
  const projectId = host.storage.chatSessionProjects.get(sourceSessionId)?.projectId;
  if (projectId) {
    host.assignChatSessionProject(targetSessionId, projectId);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
