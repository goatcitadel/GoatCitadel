/**
 * Messaging read model.
 *
 * Lists the conversations people hold with the operator through a connected
 * channel, grouped by the channel connection that carries them, and keeps one
 * read marker per operator and conversation. The gateway owns every part of
 * this view (channel status, titles, "own conversation", unread counts); a
 * client only renders it.
 */

import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  resolveChannelOwnerActorIds,
  type ChatMessagingChannel,
  type ChatMessagingChannelStatus,
  type ChatMessagingConversation,
  type ChatMessagingOverview,
  type ChatSessionBindingRecord,
  type ChatSessionListQuery,
  type ChatSessionReadResponse,
  type ChatSessionRecord,
  type IntegrationConnection,
  type SessionMeta,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { INTEGRATION_CATALOG } from "./integration-catalog.js";

const MESSAGING_SESSION_LIMIT = 1000;
const CONNECTION_LIMIT = 1000;
const READ_MARKER_ATTEMPTS = 8;
/** Counts every channel message when an operator has not read the conversation yet. */
const EPOCH = "1970-01-01T00:00:00.000Z";
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const CHANNEL_LABELS_BY_KEY: ReadonlyMap<string, string> = new Map(
  INTEGRATION_CATALOG.filter((entry) => entry.kind === "channel").map((entry) => [entry.key, entry.label]),
);

/** Channels that need a look come first, then switched-off ones, then channels whose connection is gone. */
const STATUS_ORDER: Readonly<Record<ChatMessagingChannelStatus, number>> = {
  on: 0,
  needs_attention: 0,
  off: 1,
  removed: 2,
};

export interface ChatMessagingDeps {
  storage: Pick<
    AsyncStorage,
    | "chatMessages"
    | "chatSessionBindings"
    | "chatSessionMeta"
    | "integrationConnections"
    | "sessions"
    | "systemSettings"
  >;
  normalizeWorkspaceId(workspaceId?: string): string;
  listChatSessions(query: ChatSessionListQuery): Promise<ChatSessionRecord[]>;
}

interface ChannelConversationSource {
  record: ChatSessionRecord;
  connectionId: string;
  binding: ChatSessionBindingRecord | undefined;
}

export async function listChatMessaging(
  deps: ChatMessagingDeps,
  input: { workspaceId: string; actor?: string },
): Promise<ChatMessagingOverview> {
  const normalizeWorkspaceId = workspaceNormalizer(deps);
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const records = await deps.listChatSessions({
    workspaceId,
    scope: "external",
    view: "active",
    limit: MESSAGING_SESSION_LIMIT,
  });
  // A channel connection is named only by an integration binding; mission sessions are never Messaging.
  const channelRecords = records.filter((record) => record.scope === "external" && record.channelConnectionId);
  const sessionIds = channelRecords.map((record) => record.sessionId);
  const bindings = await deps.storage.chatSessionBindings.listBySessionIds(sessionIds);
  const sessions = await deps.storage.sessions.listBySessionIds(sessionIds);
  const allConnections = await deps.storage.integrationConnections.list(undefined, CONNECTION_LIMIT);
  const connections = new Map(allConnections.map((connection) => [connection.connectionId, connection]));
  // Every channel connection of the workspace is a channel row, with or without conversations yet. A
  // connection that names no workspace belongs to all of them.
  const workspaceChannelIds = allConnections
    .filter(
      (connection) =>
        connection.kind === "channel" &&
        (!connection.workspaceId || normalizeWorkspaceId(connection.workspaceId) === workspaceId),
    )
    .map((connection) => connection.connectionId);

  const sourcesByConnection = new Map<string, ChannelConversationSource[]>();
  for (const record of channelRecords) {
    const connectionId = record.channelConnectionId;
    if (!connectionId) {
      continue;
    }
    const source = { record, connectionId, binding: bindings.get(record.sessionId) };
    sourcesByConnection.set(connectionId, [...(sourcesByConnection.get(connectionId) ?? []), source]);
  }

  const connectionIds = new Set([...sourcesByConnection.keys(), ...workspaceChannelIds]);
  const channels = await Promise.all(
    [...connectionIds].map((connectionId) =>
      buildChannel(deps, {
        connectionId,
        connection: connections.get(connectionId),
        sources: sourcesByConnection.get(connectionId) ?? [],
        sessions,
        actor: input.actor,
      }),
    ),
  );
  return { workspaceId, channels: channels.sort(compareChannels) };
}

/**
 * Moves the operator's read marker for one conversation forward to `readThrough`. The marker never moves
 * backwards, so a slow or repeated request cannot make read messages new again; the answer is the marker
 * that stands afterwards.
 *
 * The session must exist. When `workspaceId` is given it must also be the session's workspace; the read
 * route names only the session, so it leaves the workspace to the session's own canonical metadata.
 */
export async function markChatSessionRead(
  deps: ChatMessagingDeps,
  input: { sessionId: string; workspaceId?: string; actor: string; readThrough: string },
): Promise<ChatSessionReadResponse> {
  const actor = input.actor.trim();
  if (!actor) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "actor" });
  }
  const readThrough = normalizeReadThrough(input.readThrough);
  const normalizeWorkspaceId = workspaceNormalizer(deps);
  const meta = await deps.storage.chatSessionMeta.get(input.sessionId);
  const inWorkspace =
    input.workspaceId === undefined ||
    normalizeWorkspaceId(meta?.workspaceId) === normalizeWorkspaceId(input.workspaceId);
  if (!meta || !inWorkspace) {
    throw new NotFoundError({ entity: "Chat session", id: input.sessionId });
  }

  const key = readMarkerKey(actor, input.sessionId);
  for (let attempt = 0; attempt < READ_MARKER_ATTEMPTS; attempt += 1) {
    const previous = await deps.storage.systemSettings.get(key);
    const standing = parseReadMarker(previous?.value);
    if (standing && Date.parse(standing) >= Date.parse(readThrough)) {
      return { sessionId: input.sessionId, lastReadAt: standing };
    }
    const saved = await deps.storage.systemSettings.compareAndSet(
      key,
      previous,
      { at: readThrough },
      new Date().toISOString(),
    );
    if (saved) {
      return { sessionId: input.sessionId, lastReadAt: readThrough };
    }
  }
  throw new ConflictError({
    code: "WRITE_CONFLICT",
    message: "The read marker is being updated elsewhere. Try again.",
  });
}

async function buildChannel(
  deps: ChatMessagingDeps,
  input: {
    connectionId: string;
    connection: IntegrationConnection | undefined;
    sources: ChannelConversationSource[];
    sessions: ReadonlyMap<string, SessionMeta>;
    actor: string | undefined;
  },
): Promise<ChatMessagingChannel> {
  const { connectionId, connection, sources, sessions, actor } = input;
  const channelKey = connection?.key ?? sources[0]?.record.channel ?? "";
  const ownerActorIds = resolveChannelOwnerActorIds(connection?.config);
  const conversations = await Promise.all(
    sources.map((source) =>
      buildConversation(deps, { source, session: sessions.get(source.record.sessionId), ownerActorIds, actor }),
    ),
  );
  return {
    connectionId,
    channelKey,
    label: connection?.label ?? CHANNEL_LABELS_BY_KEY.get(channelKey) ?? channelKey,
    status: resolveChannelStatus(connection),
    conversations: conversations.sort(compareConversations),
  };
}

async function buildConversation(
  deps: ChatMessagingDeps,
  input: {
    source: ChannelConversationSource;
    session: SessionMeta | undefined;
    ownerActorIds: readonly string[];
    actor: string | undefined;
  },
): Promise<ChatMessagingConversation> {
  const { source, session, ownerActorIds, actor } = input;
  const { record, binding } = source;
  const details = binding?.conversation;
  // Conversations bound before their details were recorded still say what they are through the session.
  const kind = details?.kind ?? (session?.kind === "dm" ? "direct" : "group");
  const counterpart = details?.counterpartActorId?.trim().toLowerCase();
  const conversation: ChatMessagingConversation = {
    sessionId: record.sessionId,
    title:
      details?.title?.trim() || record.title?.trim() || (kind === "direct" ? "Direct message" : "Group conversation"),
    kind,
    own: kind === "direct" && counterpart !== undefined && ownerActorIds.includes(counterpart),
    lastActivityAt: record.lastActivityAt,
  };
  if (!actor) {
    return conversation;
  }
  const lastReadAt = await readStandingMarker(deps, actor, record.sessionId);
  const newMessageCount = await deps.storage.chatMessages.countAfter(record.sessionId, lastReadAt ?? EPOCH);
  return { ...conversation, ...(lastReadAt ? { lastReadAt } : {}), newMessageCount };
}

/** Enabled and connected is on; a disabled, paused or disconnected connection is off; an enabled error needs attention. */
function resolveChannelStatus(connection: IntegrationConnection | undefined): ChatMessagingChannelStatus {
  if (!connection) {
    return "removed";
  }
  if (!connection.enabled) {
    return "off";
  }
  switch (connection.status) {
    case "connected":
      return "on";
    case "error":
      return "needs_attention";
    case "paused":
    case "disconnected":
      return "off";
  }
}

function compareChannels(left: ChatMessagingChannel, right: ChatMessagingChannel): number {
  return (
    STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
    left.label.localeCompare(right.label, undefined, { sensitivity: "base" }) ||
    left.connectionId.localeCompare(right.connectionId)
  );
}

function compareConversations(left: ChatMessagingConversation, right: ChatMessagingConversation): number {
  return (
    Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt) || left.sessionId.localeCompare(right.sessionId)
  );
}

/** One read of the dependency bag, so every comparison in a request normalises workspace ids the same way. */
function workspaceNormalizer(deps: ChatMessagingDeps): (workspaceId?: string) => string {
  return (workspaceId) => deps.normalizeWorkspaceId(workspaceId);
}

/** The key never names the operator or the conversation: both are hashed together. */
function readMarkerKey(actor: string, sessionId: string): string {
  return `chat.read.v1.${createHash("sha256").update(`${actor}\n${sessionId}`).digest("hex")}`;
}

async function readStandingMarker(
  deps: ChatMessagingDeps,
  actor: string,
  sessionId: string,
): Promise<string | undefined> {
  const record = await deps.storage.systemSettings.get(readMarkerKey(actor, sessionId));
  return parseReadMarker(record?.value);
}

/** A damaged stored marker reads as "never read" and is replaced by the next mark. */
function parseReadMarker(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("at" in value) || typeof value.at !== "string") {
    return undefined;
  }
  const at = Date.parse(value.at);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

/**
 * Messages carry millisecond UTC timestamps; the marker is normalised to the same format so they compare as
 * text. A time later than now is clamped to now: a skewed client clock must not hide messages that arrive
 * before it.
 */
function normalizeReadThrough(value: string): string {
  const at = ISO_TIMESTAMP.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(at)) {
    throw new ValidationError({ field: "readThrough", message: "readThrough must be an ISO 8601 timestamp" });
  }
  return new Date(Math.min(at, Date.now())).toISOString();
}
