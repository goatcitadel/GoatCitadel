import { randomUUID } from "node:crypto";
import { resolveSessionRoute } from "@goatcitadel/gateway-core";
import type {
  ApprovalResolveInput,
  ChannelActivityInput,
  ChannelActivityResult,
  ChatSendMessageResponse,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  IntegrationConnection,
  PersonalityCatalogResponse,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ApprovalResolveResult } from "./approval-types.js";
import type { ChatCommandOptions } from "./chat-command-service.js";
import {
  DEFAULT_CHANNEL_TOOLSET_POSTURE,
  findSharedChannelCommand,
  normalizeChannelCommandInput,
} from "./channel-command-contract.js";
import { getPersonalityPreset, listPersonalityPresets, normalizePersonalityId } from "./channel-personalities.js";
import type {
  DurableInboundChannelAcceptInput,
  DurableInboundChannelAcceptResult,
} from "./channel-inbound-dispatch.js";
import type {
  InboundChannelCommandExecutionInput,
  InboundChannelCommandResult,
} from "./inbound-channel-event-service.js";

const DISCORD_ROUTE_SESSIONS_SETTING_KEY = "discord_route_sessions_v1";
const DISCORD_APPROVAL_VERSION_KEY = "discordApprovalVersion";
const DISCORD_APPROVAL_DECISION_KEY = "discordApprovalDecision";
const DISCORD_APPROVAL_LOOKUP_STATUS_KEY = "discordApprovalLookupStatus";
const DISCORD_APPROVAL_ACTION_ID_KEY = "discordApprovalActionId";

export interface DiscordRouteSessionRecord {
  connectionId: string;
  target: string;
  logicalSessionKey: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiscordRuntimeBridgeHost {
  readonly storage: Pick<
    AsyncStorage,
    | "runImmediateTransaction"
    | "chatSessionBindings"
    | "chatSessionMeta"
    | "chatSessionPrefs"
    | "chatSessionProjects"
    | "integrationConnections"
    | "sessions"
    | "systemSettings"
  >;
  readonly operatorSummaryCache: {
    invalidate(): void;
  };
  assignChatSessionProject(sessionId: string, projectId?: string): Promise<unknown>;
  acceptInboundChannelEvent(input: DurableInboundChannelAcceptInput): Promise<DurableInboundChannelAcceptResult>;
  awaitInboundChannelCommandResult(inboundEventId: string): Promise<InboundChannelCommandResult>;
  findRemoteActionTokenId(token: string): Promise<string | undefined>;
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
  ensureChatSessionRuntimeGrants(sessionId: string): Promise<void>;
  getPersonalityCatalog?(): Promise<PersonalityCatalogResponse>;
  getChatSessionPrefs(sessionId: string): Promise<ChatSessionPrefsRecord>;
  hasRunningTurn(sessionId: string): Promise<boolean>;
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
  emitChannelActivity(input: ChannelActivityInput): Promise<ChannelActivityResult>;
  recordDevDiagnostic(input: {
    level: "info" | "warn" | "error";
    category: string;
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }): void | Promise<void>;
  requireChatSession(sessionId: string): Promise<ChatSessionRecord>;
  resolveApprovalWithRemoteToken(input: {
    token: string;
    connectorId: string;
    decision: ApprovalResolveInput["decision"];
    resolvedBy?: string;
  }): Promise<ApprovalResolveResult>;
  resolveApprovalWithRemoteTokenId(input: {
    tokenId: string;
    connectorId: string;
    decision: ApprovalResolveInput["decision"];
    resolvedBy?: string;
  }): Promise<ApprovalResolveResult>;
  respondToExistingChatMessage(sessionId: string, sourceMessageId: string): Promise<ChatSendMessageResponse>;
  setChatSessionBinding(input: {
    sessionId: string;
    transport: "integration";
    connectionId: string;
    target: string;
    writable: boolean;
  }): Promise<unknown>;
  updateChatSession(sessionId: string, patch: { title?: string }): Promise<unknown>;
  updateChatSessionPrefs(sessionId: string, patch: Record<string, unknown>): Promise<unknown>;
}

export async function readDiscordRouteSessions(host: DiscordRuntimeBridgeHost): Promise<DiscordRouteSessionRecord[]> {
  return (
    (await host.storage.systemSettings.get<DiscordRouteSessionRecord[]>(DISCORD_ROUTE_SESSIONS_SETTING_KEY))?.value ??
    []
  );
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

export async function writeDiscordRouteSessions(
  host: DiscordRuntimeBridgeHost,
  records: DiscordRouteSessionRecord[],
): Promise<void> {
  await host.storage.systemSettings.set(DISCORD_ROUTE_SESSIONS_SETTING_KEY, records);
}

export async function resolveDiscordInboundRoute(
  host: DiscordRuntimeBridgeHost,
  input: {
    connectionId: string;
    target: string;
    peer?: string;
    room?: string;
    threadId?: string;
  },
): Promise<{
  peer?: string;
  room?: string;
  threadId?: string;
}> {
  const routeSession = (await readDiscordRouteSessions(host)).find(
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

export async function ensureDiscordChatSession(
  host: DiscordRuntimeBridgeHost,
  input: {
    connectionId: string;
    target: string;
    displayName?: string;
    peer?: string;
    room?: string;
    threadId?: string;
  },
): Promise<ChatSessionRecord> {
  const route = await resolveDiscordInboundRoute(host, input);
  const resolution = resolveSessionRoute({
    channel: "discord",
    account: input.connectionId,
    peer: route.peer,
    room: route.room,
    threadId: route.threadId,
  });
  const now = new Date().toISOString();
  await host.storage.runImmediateTransaction(async () => {
    const connection = await host.storage.integrationConnections.get(input.connectionId);
    const workspaceId = connection.workspaceId?.trim() || "default";
    const lockedMeta = await host.storage.chatSessionMeta.get(resolution.sessionId);
    if (lockedMeta?.workspaceId && lockedMeta.workspaceId !== workspaceId) {
      throw new Error("stable Discord session key already belongs to another workspace");
    }
    await host.storage.sessions.upsert({
      sessionId: resolution.sessionId,
      sessionKey: resolution.sessionKey,
      kind: resolution.kind,
      channel: "discord",
      account: input.connectionId,
      displayName: input.displayName?.trim() || undefined,
      timestamp: now,
    });
    await host.storage.chatSessionMeta.ensure(resolution.sessionId, now, workspaceId);
    await host.storage.chatSessionPrefs.ensure(resolution.sessionId, now);
    await host.storage.chatSessionBindings.upsert(
      {
        sessionId: resolution.sessionId,
        workspaceId,
        transport: "integration",
        connectionId: input.connectionId,
        target: input.target,
        writable: true,
      },
      now,
    );
  });
  host.operatorSummaryCache.invalidate();
  await host.ensureChatSessionRuntimeGrants(resolution.sessionId);
  return await host.requireChatSession(resolution.sessionId);
}

export async function startNewDiscordRouteSession(
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
): Promise<ChatSessionRecord> {
  const sourceSession = await ensureDiscordChatSession(host, input);
  const records = await readDiscordRouteSessions(host);
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
  await writeDiscordRouteSessions(host, [
    nextRecord,
    ...records.filter((item) => !(item.connectionId === input.connectionId && item.target === input.target)),
  ]);
  const createdSession = await ensureDiscordChatSession(host, input);
  nextRecord.sessionId = createdSession.sessionId;
  await writeDiscordRouteSessions(host, [
    nextRecord,
    ...records.filter((item) => !(item.connectionId === input.connectionId && item.target === input.target)),
  ]);
  await cloneChatSessionContext(host, sourceSession.sessionId, createdSession.sessionId);
  if (input.title?.trim()) {
    await host.updateChatSession(createdSession.sessionId, { title: input.title.trim() });
  }
  return await host.requireChatSession(createdSession.sessionId);
}

/**
 * Persist a slash-command envelope before Discord receives its interaction
 * acknowledgement. The durable inbound worker, rather than the provider
 * callback, owns command execution and terminal result settlement.
 */
export async function acceptDiscordRuntimeSlashCommand(
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
): Promise<DurableInboundChannelAcceptResult> {
  const route = await resolveDiscordInboundRoute(host, input);
  const durableCommand = await buildDurableDiscordCommand(host, input.commandText, input.metadata);
  return host.acceptInboundChannelEvent({
    channel: "discord",
    connectionId: input.connectionId,
    idempotencyKey: `discord:${input.connectionId}:interaction:${input.sourceCommandId}`,
    eventType: "discord-gateway-slash-command",
    bindingTarget: input.target,
    dispatchKind: "command",
    message: {
      eventId: input.sourceCommandId,
      account: input.connectionId,
      peer: route.peer,
      room: route.room,
      threadId: route.threadId,
      actorId: input.actorId,
      actorType: "user",
      content: durableCommand.commandText,
      displayName: input.displayName,
      metadata: durableCommand.metadata,
    },
  });
}

type DiscordApprovalDecision = "approve" | "reject";

async function buildDurableDiscordCommand(
  host: DiscordRuntimeBridgeHost,
  commandText: string,
  metadata: Record<string, unknown> | undefined,
): Promise<{ commandText: string; metadata?: Record<string, unknown> }> {
  const command = normalizeChannelCommandInput(commandText, { platform: "discord" });
  if (!command.approvalDecision || !command.command) {
    return { commandText, metadata };
  }
  if (!command.approvalToken) {
    return { commandText: command.command, metadata };
  }
  const approvalActionId = await host.findRemoteActionTokenId(command.approvalToken);
  return {
    // The raw single-use bearer value must never cross the durable boundary.
    commandText: command.command,
    metadata: {
      ...metadata,
      [DISCORD_APPROVAL_VERSION_KEY]: 1,
      [DISCORD_APPROVAL_DECISION_KEY]: command.approvalDecision,
      [DISCORD_APPROVAL_LOOKUP_STATUS_KEY]: approvalActionId ? "resolved" : "not_found",
      ...(approvalActionId ? { [DISCORD_APPROVAL_ACTION_ID_KEY]: approvalActionId } : {}),
    },
  };
}

function readDurableDiscordApproval(
  metadata: Record<string, unknown> | undefined,
): { decision: DiscordApprovalDecision; tokenId?: string } | undefined {
  const version = metadata?.[DISCORD_APPROVAL_VERSION_KEY];
  if (version === undefined) {
    return undefined;
  }
  const decision = metadata?.[DISCORD_APPROVAL_DECISION_KEY];
  const lookupStatus = metadata?.[DISCORD_APPROVAL_LOOKUP_STATUS_KEY];
  const actionId = readString(metadata?.[DISCORD_APPROVAL_ACTION_ID_KEY]);
  if (
    version !== 1 ||
    (decision !== "approve" && decision !== "reject") ||
    (lookupStatus !== "resolved" && lookupStatus !== "not_found") ||
    (lookupStatus === "resolved" && !actionId) ||
    (lookupStatus === "not_found" && actionId)
  ) {
    throw new Error("Durable Discord approval command metadata is invalid.");
  }
  return { decision, tokenId: actionId };
}

function renderDiscordApprovalResolution(result: ApprovalResolveResult, decision: DiscordApprovalDecision): string {
  return decision === "approve"
    ? `Approved ${result.approval.approvalId}. GoatCitadel will resume any waiting work it can safely resume.`
    : `Rejected ${result.approval.approvalId}. GoatCitadel will keep the requested action blocked.`;
}

/** Execute only the allowlisted Discord command event reconstructed from its durable envelope. */
export async function executeDiscordRuntimeInboundCommand(
  host: DiscordRuntimeBridgeHost,
  input: InboundChannelCommandExecutionInput,
): Promise<{ resultText: string }> {
  if (input.channel !== "discord" || input.eventType !== "discord-gateway-slash-command") {
    throw new Error(`Unsupported durable inbound command event: ${input.channel}/${input.eventType}`);
  }
  const target = input.bindingTarget?.trim();
  if (!target) {
    throw new Error("Durable Discord slash command is missing its binding target.");
  }
  if (input.operationKey !== input.idempotencyKey) {
    throw new Error("Durable Discord slash command operation identity does not match its acceptance identity.");
  }
  const durableApproval = readDurableDiscordApproval(input.message.metadata);
  if (durableApproval) {
    const command = normalizeChannelCommandInput(input.message.content, { platform: "discord" });
    if (command.approvalDecision !== durableApproval.decision || command.approvalToken) {
      throw new Error("Durable Discord approval command does not match its secret-free command metadata.");
    }
    if (!durableApproval.tokenId) {
      return { resultText: "The approval action token was not recognized. Request a fresh approval message." };
    }
    const result = await host.resolveApprovalWithRemoteTokenId({
      tokenId: durableApproval.tokenId,
      connectorId: `integration:${input.connectionId}`,
      decision: durableApproval.decision,
      resolvedBy: `discord:${input.message.actorId}`,
    });
    return { resultText: renderDiscordApprovalResolution(result, durableApproval.decision) };
  }
  const resultText = await handleDiscordRuntimeSlashCommand(host, {
    connectionId: input.connectionId,
    target,
    actorId: input.message.actorId,
    displayName: input.message.displayName,
    commandText: input.message.content,
    sourceCommandId: input.message.eventId,
    peer: input.message.peer,
    room: input.message.room,
    threadId: input.message.threadId,
    metadata: input.message.metadata,
    operationKey: input.operationKey,
  });
  return { resultText };
}

/** Map durable terminal state to bounded provider-safe copy. */
export async function awaitDiscordRuntimeSlashCommandResult(
  host: DiscordRuntimeBridgeHost,
  inboundEventId: string,
): Promise<string> {
  const result = await host.awaitInboundChannelCommandResult(inboundEventId);
  if (result.status === "completed") {
    return result.resultText;
  }
  if (result.status === "manual_reconciliation_required") {
    return `Command was durably accepted but needs operator reconciliation before it can be retried. Event ${inboundEventId}.`;
  }
  return `Command was durably accepted but could not be completed. Inspect event ${inboundEventId} in GoatCitadel Ops.`;
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
    operationKey?: string;
  },
): Promise<string> {
  const commandText = input.commandText.trim();
  if (!commandText.startsWith("/")) {
    return "Command must start with '/'.";
  }
  const normalizedCommand = normalizeChannelCommandInput(commandText, { platform: "discord" });
  if (normalizedCommand.name === "new") {
    const title = normalizedCommand.argText;
    const session = await startNewDiscordRouteSession(host, {
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
      connectorId: `integration:${input.connectionId}`,
      decision: normalizedCommand.approvalDecision,
      resolvedBy: `discord:${input.actorId}`,
    });
    return renderDiscordApprovalResolution(result, normalizedCommand.approvalDecision);
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

  const session = await ensureDiscordChatSession(host, {
    connectionId: input.connectionId,
    target: input.target,
    displayName: input.displayName,
    peer: input.peer,
    room: input.room,
    threadId: input.threadId,
  });
  const sharedDefinition = normalizedCommand.name ? findSharedChannelCommand(normalizedCommand.name) : undefined;
  if (!sharedDefinition?.bypassesActiveRunGuard && (await host.hasRunningTurn(session.sessionId))) {
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
  const connection = await host.storage.integrationConnections.get(input.connectionId);
  switch (command.name) {
    case "status":
      return renderDiscordStatus(connection, input.target, await host.getPersonalityCatalog?.());
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
      await host.storage.integrationConnections.update(input.connectionId, {
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
      return await handleDiscordPersonalityCommand(host, input, command.argText, connection);
    case "stop": {
      const session = await ensureDiscordChatSession(host, input);
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

async function handleDiscordPersonalityCommand(
  host: DiscordRuntimeBridgeHost,
  input: Parameters<typeof handleDiscordRuntimeSlashCommand>[1],
  argument: string,
  connection: IntegrationConnection,
): Promise<string> {
  const catalog = (await host.getPersonalityCatalog?.()) ?? {
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
  await host.storage.integrationConnections.update(input.connectionId, {
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
  const route = await resolveDiscordInboundRoute(host, input);
  await host.acceptInboundChannelEvent({
    channel: "discord",
    connectionId: input.connectionId,
    idempotencyKey: `discord:${input.connectionId}:${input.sourceMessageId}`,
    eventType: "discord-gateway-message",
    bindingTarget: input.target,
    dispatchKind: "agent_turn",
    message: {
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
  });
}

export async function cloneChatSessionContext(
  host: DiscordRuntimeBridgeHost,
  sourceSessionId: string,
  targetSessionId: string,
): Promise<void> {
  if (sourceSessionId === targetSessionId) {
    return;
  }
  const {
    sessionId: _sourceSessionId,
    createdAt: _sourceCreatedAt,
    updatedAt: _sourceUpdatedAt,
    ...prefsPatch
  } = await host.getChatSessionPrefs(sourceSessionId);
  await host.updateChatSessionPrefs(targetSessionId, prefsPatch);
  const projectId = (await host.storage.chatSessionProjects.get(sourceSessionId))?.projectId;
  if (projectId) {
    await host.assignChatSessionProject(targetSessionId, projectId);
  }
}
