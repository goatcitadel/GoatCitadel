import { randomUUID } from "node:crypto";
import { resolveSessionRoute } from "@goatcitadel/gateway-core";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { GatewayService } from "./gateway-service.js";

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

export interface DiscordRuntimeBridgeHost extends Pick<
  GatewayService,
  | "assignChatSessionProject"
  | "ensureChatSessionRuntimeGrants"
  | "getChatSessionPrefs"
  | "ingestChannelMessage"
  | "isChatTurnWriteConflict"
  | "operatorSummaryCache"
  | "parseChatCommand"
  | "recordDevDiagnostic"
  | "requireChatSession"
  | "respondToExistingChatMessage"
  | "setChatSessionBinding"
  | "updateChatSession"
  | "updateChatSessionPrefs"
> {
  storage: Pick<
    GatewayService["storage"],
    | "chatSessionBindings"
    | "chatSessionMeta"
    | "chatSessionPrefs"
    | "chatSessionProjects"
    | "sessions"
    | "systemSettings"
  >;
}

export function readDiscordRouteSessions(host: DiscordRuntimeBridgeHost): DiscordRouteSessionRecord[] {
  return host.storage.systemSettings.get<DiscordRouteSessionRecord[]>(DISCORD_ROUTE_SESSIONS_SETTING_KEY)?.value ?? [];
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
  if (/^\/new(?:\s|$)/i.test(commandText)) {
    const title = commandText.replace(/^\/new/i, "").trim();
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

  const session = ensureDiscordChatSession(host, {
    connectionId: input.connectionId,
    target: input.target,
    displayName: input.displayName,
    peer: input.peer,
    room: input.room,
    threadId: input.threadId,
  });
  const result = await host.parseChatCommand(session.sessionId, commandText);
  return result.message;
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
              error: error.message,
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
