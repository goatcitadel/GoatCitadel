import type { ChatSessionBindingRecord, DiscordPairingRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { isErrandOwner } from "./errand-owner.js";

/** Where an errand was started: Chat on the PC, or one of the operator's channel conversations. */
export type ErrandOrigin =
  | { kind: "pc" }
  | {
      kind: "channel";
      connectionId: string;
      channelKey: string;
      target: string;
      conversation: "direct" | "group";
      actorId: string;
    };

/** The chat session that Mission Control's own Chat uses; every other value is the channel the turn came in on. */
export const MISSION_SESSION_CHANNEL = "mission";

export interface ErrandOriginDeps {
  /** The session's channel: "mission" for Chat in Mission Control, otherwise the channel the turn came in on. */
  sessionChannel(sessionId: string): Promise<string | undefined>;
  binding(sessionId: string): Promise<ChatSessionBindingRecord | undefined>;
  /** The actor id on the turn's user message, when that message belongs to this session. */
  turnActorId(sessionId: string, turnId: string): Promise<string | undefined>;
  /** The connection's channel key and stored config, for the owner check. */
  connection(connectionId: string): Promise<{ key: string; config: Record<string, unknown> } | undefined>;
  readDiscordPairings(): Promise<DiscordPairingRecord[]>;
}

/**
 * Resolves where the turn came from. A session that is not provably Mission Control's Chat, or a channel session
 * whose binding or sender can't be read, resolves to `undefined`, which the errand service refuses.
 */
export async function resolveErrandOrigin(
  deps: Pick<ErrandOriginDeps, "sessionChannel" | "binding" | "turnActorId">,
  sessionId: string,
  turnId: string,
): Promise<ErrandOrigin | undefined> {
  const { sessionChannel, binding: readBinding, turnActorId } = deps;
  const channelKey = (await sessionChannel(sessionId).catch(() => undefined))?.trim();
  if (!channelKey) {
    return undefined;
  }
  if (channelKey === MISSION_SESSION_CHANNEL) {
    return { kind: "pc" };
  }
  const [binding, actorId] = await Promise.all([
    readBinding(sessionId).catch(() => undefined),
    turnActorId(sessionId, turnId).catch(() => undefined),
  ]);
  const connectionId = binding?.connectionId?.trim();
  const target = binding?.target?.trim();
  const sender = actorId?.trim();
  if (!binding || binding.transport !== "integration" || !connectionId || !target || !sender) {
    return undefined;
  }
  return {
    kind: "channel",
    connectionId,
    channelKey,
    target,
    // A conversation whose kind was never recorded is treated as a group: no screenshots go to it.
    conversation: binding.conversation?.kind === "direct" ? "direct" : "group",
    actorId: sender,
  };
}

/** The approved Discord pairings' user ids on one connection. */
export function approvedDiscordActorIds(records: readonly DiscordPairingRecord[], connectionId: string): string[] {
  return records
    .filter((record) => record.connectionId === connectionId && record.status === "approved")
    .map((record) => record.userId);
}

/**
 * The turn's origin when the errand may start: Chat on the PC, or a channel conversation whose sender is the
 * operator's own account on that connection (see `isErrandOwner`). Anything else resolves to `undefined`.
 */
export async function resolveOwnedErrandOrigin(
  deps: ErrandOriginDeps,
  sessionId: string,
  turnId: string,
): Promise<ErrandOrigin | undefined> {
  const { connection: readConnection, readDiscordPairings } = deps;
  const origin = await resolveErrandOrigin(deps, sessionId, turnId);
  if (!origin || origin.kind === "pc") {
    return origin;
  }
  const connection = await readConnection(origin.connectionId).catch(() => undefined);
  if (!connection) {
    return undefined;
  }
  // The connection's own key decides which pairing record counts, not the session's channel label.
  const discordApprovedActorIds =
    connection.key === "discord"
      ? approvedDiscordActorIds(await readDiscordPairings().catch(() => []), origin.connectionId)
      : undefined;
  const owner = isErrandOwner({
    channelKey: connection.key,
    config: connection.config,
    actorId: origin.actorId,
    ...(discordApprovedActorIds ? { discordApprovedActorIds } : {}),
  });
  return owner ? origin : undefined;
}

/** Builds the origin readers from Gateway storage; `readDiscordPairings` is the Gateway's own reader. */
export function createErrandOriginDeps(sources: {
  storage: AsyncStorage;
  readDiscordPairings(): Promise<DiscordPairingRecord[]>;
}): ErrandOriginDeps {
  const { storage, readDiscordPairings } = sources;
  const { sessions, chatSessionBindings, chatTurnTraces, chatMessages, integrationConnections } = storage;
  return {
    sessionChannel: async (sessionId) => (await sessions.getBySessionId(sessionId)).channel,
    binding: async (sessionId) => await chatSessionBindings.get(sessionId),
    turnActorId: async (sessionId, turnId) => {
      const trace = await chatTurnTraces.get(turnId);
      if (trace.sessionId !== sessionId) {
        return undefined;
      }
      const message = await chatMessages.get(trace.userMessageId);
      return message && message.sessionId === sessionId && message.role === "user" ? message.actorId : undefined;
    },
    connection: async (connectionId) => {
      const record = await integrationConnections.get(connectionId);
      return { key: record.key, config: record.config };
    },
    readDiscordPairings: () => readDiscordPairings(),
  };
}
