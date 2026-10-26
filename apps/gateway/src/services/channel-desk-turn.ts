/**
 * Desk questions in the operator's own channel conversation.
 *
 * When the operator types into a channel conversation in Chat, what happens depends on whose conversation it is:
 *
 * - `ask`: the operator's own direct conversation with the channel's bot. The text is a question to GoatCitadel. It
 *   becomes a durable inbound event (`operator_desk_turn`) that the inbound worker answers like a message from the
 *   phone. Only GoatCitadel's answer, under a short quote of the question, is delivered to the channel.
 * - `post`: any other conversation (a group, or someone else's direct conversation). The text is posted into the
 *   conversation as written, which is the existing verbatim path. Anything less certain than "ask" is "post", so a
 *   desk send never starts a turn on another person's behalf.
 * - `blocked`: the channel is removed, switched off, or not connected; nothing is sent.
 *
 * Everything here is a pure decision or builder. The Gateway reads the binding, connection and session, and commits
 * the event through the inbound worker's own acceptance path.
 */

import {
  ConflictError,
  ValidationError,
  resolveChannelOwnerActorIds,
  type ChatChannelConversation,
  type ChatSendMessageResponse,
  type ChatSessionBindingRecord,
  type GatewayEventInput,
  type InboundChannelEventAcceptInput,
  type InboundChannelEventRecord,
  type IntegrationConnection,
} from "@goatcitadel/contracts";
import { decodeSessionKeySegment, resolveSessionRoute } from "@goatcitadel/gateway-core";
import type { IngestChannelMessageInput } from "./channel-inbound-dispatch.js";

export const OPERATOR_DESK_DISPATCH_KIND = "operator_desk_turn";
export const OPERATOR_DESK_TRANSPORT = "operator_desk";
/** The ingest origin the inbound worker names when it records a desk question. */
export const OPERATOR_DESK_INGEST_ORIGIN = "operator_desk";
const OPERATOR_ACTOR_ID = "operator";
const DESK_QUOTE_CHARACTERS = 200;

export type DeskConversationMode = "ask" | "post" | "blocked";

/** A desk event as the desk path builds it; the inbound worker assigns its event id. */
export type OperatorDeskAcceptance = Omit<InboundChannelEventAcceptInput, "eventId" | "receivedAt">;

/** What the inbound worker reports once a desk event is durably accepted. */
export interface OperatorDeskAccepted {
  event: InboundChannelEventRecord;
  /** The Chat message id the worker records the desk question under. */
  messageId: string;
  /** The turn id the worker answers it under. */
  turnId: string;
}

/** Commits one desk event through the inbound worker's acceptance path. */
export type ChannelDeskTurnHost = (acceptance: OperatorDeskAcceptance) => Promise<OperatorDeskAccepted>;

export interface OperatorDeskTurnInput {
  sessionId: string;
  sessionKey: string;
  binding: ChatSessionBindingRecord;
  content: string;
  /** The send request's own idempotency key. */
  idempotencyKey: string;
  /** The route the send request was checked against; the desk turn answers with the same choice. */
  providerId?: string;
  model?: string;
}

/** Send-request fields a desk question cannot carry into a channel conversation. */
export interface OperatorDeskRequestExtras {
  attachments?: readonly string[];
  parts?: ReadonlyArray<{ type: string }>;
  templateInvocation?: unknown;
  workspaceSnapshot?: unknown;
}

/** One desk send as the chat route hands it over. */
export type OperatorDeskSendInput = Pick<OperatorDeskTurnInput, "content" | "idempotencyKey" | "providerId" | "model"> &
  OperatorDeskRequestExtras;

/** The accepted desk question, with the turn the inbound worker answers it under. */
export type OperatorDeskTurnResponse = ChatSendMessageResponse & { turnId: string };

export type OperatorDeskSendResult =
  | { mode: "post" }
  | { mode: "blocked"; message: string }
  | { mode: "refused"; message: string }
  | { mode: "ask"; response: OperatorDeskTurnResponse };

export const DESK_FILES_REFUSED_MESSAGE = "Files and templates aren't sent in channel conversations.";

/** True only for a direct conversation whose other person is on the connection's owner list. */
export function isOperatorOwnConversation(
  conversation: ChatChannelConversation | undefined,
  connectionConfig: Record<string, unknown> | undefined,
): boolean {
  if (conversation?.kind !== "direct") {
    return false;
  }
  const counterpart = conversation.counterpartActorId?.trim().toLowerCase();
  return Boolean(counterpart) && resolveChannelOwnerActorIds(connectionConfig).includes(counterpart!);
}

export function resolveDeskConversationMode(
  binding: ChatSessionBindingRecord,
  connection: IntegrationConnection | undefined,
): DeskConversationMode {
  if (binding.transport !== "integration" || !binding.connectionId) {
    return "post";
  }
  if (!connection || connection.connectionId !== binding.connectionId) {
    return "blocked";
  }
  if (connection.enabled === false || connection.status !== "connected") {
    return "blocked";
  }
  if (!binding.writable || !binding.target?.trim()) {
    return "post";
  }
  return isOperatorOwnConversation(binding.conversation, connection.config) ? "ask" : "post";
}

/** The reason a blocked desk reply is refused, in the channel's own name. */
export function describeBlockedDeskReply(connection: IntegrationConnection | undefined): string {
  if (!connection) {
    return "This channel was removed. Its conversations stay readable.";
  }
  if (connection.enabled === false) {
    return `Turn ${connection.label} back on to reply.`;
  }
  return `${connection.label} isn't connected right now. Check its channel page.`;
}

/**
 * Quotes the desk question above GoatCitadel's answer, so the phone shows what was asked. A cut quote ends in "…".
 * On a Telegram connection with a parse mode, the quote is escaped for it: one stray `_` or `<` in the question would
 * otherwise make Telegram refuse the whole message. Only the quote is escaped; the answer is sent as composed.
 */
export function buildDeskDeliveryPrefix(
  content: string,
  channel?: { key: string; config: Record<string, unknown> },
): string {
  const characters = Array.from(content.trim());
  const cut = characters.length > DESK_QUOTE_CHARACTERS;
  // Cut first, then escape, so an escape sequence is never split.
  const quoted = escapeDeskQuote(characters.slice(0, DESK_QUOTE_CHARACTERS).join(""), channel);
  return `From your desk: "${quoted}${cut ? "…" : ""}"\n\n`;
}

function escapeDeskQuote(text: string, channel: { key: string; config: Record<string, unknown> } | undefined): string {
  const parseMode = channel?.key === "telegram" ? channel.config.parseMode : undefined;
  switch (typeof parseMode === "string" ? parseMode.trim().toLowerCase() : "") {
    case "markdown":
      return text.replace(/[_*`[]/g, "\\$&");
    case "markdownv2":
      return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
    case "html":
      return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    default:
      return text;
  }
}

/** True when a send request carries something only a mission chat can use: files, non-text parts, a template. */
function carriesFilesOrTemplates(extras: OperatorDeskRequestExtras): boolean {
  return Boolean(
    (extras.attachments?.length ?? 0) > 0 ||
    extras.parts?.some((part) => part.type !== "text") ||
    extras.templateInvocation !== undefined ||
    extras.workspaceSnapshot !== undefined,
  );
}

export function isOperatorDeskEvent(event: { dispatchKind: string; transport: string }): boolean {
  return event.dispatchKind === OPERATOR_DESK_DISPATCH_KIND && event.transport === OPERATOR_DESK_TRANSPORT;
}

/**
 * The inbound worker's last check before answering a desk question: the binding it just refreshed must still name
 * the operator's own direct conversation on this connection.
 */
export function resolveDeskQuestionGate(
  conversation: ChatChannelConversation | undefined,
  connectionConfig: Record<string, unknown>,
): { action: "allow" } | { action: "suppress"; reason: string } {
  return isOperatorOwnConversation(conversation, connectionConfig)
    ? { action: "allow" }
    : { action: "suppress", reason: "The conversation is no longer your own, so the desk question was not answered." };
}

/**
 * The Chat event that records a desk question: always the operator, whatever the stored message names. The caller
 * ingests it with operator authority.
 */
export function buildOperatorDeskGatewayEvent(channel: string, message: IngestChannelMessageInput): GatewayEventInput {
  return {
    eventId: message.eventId,
    route: {
      channel,
      account: message.account,
      peer: message.peer,
      room: message.room,
      threadId: message.threadId,
    },
    actor: { type: "user", id: OPERATOR_ACTOR_ID },
    message: { role: "user", content: message.content },
  };
}

export function buildOperatorDeskAcceptance(input: OperatorDeskTurnInput): OperatorDeskAcceptance {
  const content = input.content.trim();
  if (!content) {
    throw new ValidationError({ field: "content", message: "Type a question to send." });
  }
  const requestKey = input.idempotencyKey?.trim();
  if (!requestKey) {
    throw new ValidationError({ field: "idempotencyKey", message: "A desk question needs an idempotency key." });
  }
  const connectionId = input.binding.connectionId?.trim();
  const target = input.binding.target?.trim();
  if (input.binding.transport !== "integration" || !connectionId || !target) {
    throw new ConflictError({ message: "This conversation is not bound to a channel." });
  }
  const route = decodeSessionRoute(input.sessionKey);
  if (resolveSessionRoute(route).sessionId !== input.sessionId) {
    throw new ConflictError({ message: "This conversation's channel address does not match its session." });
  }
  const idempotencyKey = `desk:${input.sessionId}:${requestKey}`;
  // Stored with the event, so a retry after an approval wait answers with the same choice.
  const providerId = input.providerId?.trim();
  const model = input.model?.trim();
  const selection = { ...(providerId ? { providerId } : {}), ...(model ? { model } : {}) };
  return {
    channelKey: route.channel,
    connectionId,
    transport: OPERATOR_DESK_TRANSPORT,
    dispatchKind: OPERATOR_DESK_DISPATCH_KIND,
    idempotencyKey,
    laneKey: `session:${input.sessionId}`,
    payload: {
      eventType: OPERATOR_DESK_DISPATCH_KIND,
      bindingTarget: target,
      message: {
        eventId: idempotencyKey,
        account: route.account,
        ...(route.peer ? { peer: route.peer } : {}),
        ...(route.room ? { room: route.room } : {}),
        ...(route.threadId ? { threadId: route.threadId } : {}),
        actorId: OPERATOR_ACTOR_ID,
        actorType: "user",
        content,
      },
      ...(Object.keys(selection).length > 0 ? { responseOptions: selection } : {}),
    },
  };
}

/** Accepts a desk question as a durable event and returns the message the worker will record for it. */
export async function acceptOperatorDeskTurn(
  host: ChannelDeskTurnHost,
  input: OperatorDeskTurnInput,
): Promise<OperatorDeskTurnResponse> {
  const acceptance = buildOperatorDeskAcceptance(input);
  const accepted = await host(acceptance);
  const message = acceptance.payload.message as { content: string };
  return {
    sessionId: input.sessionId,
    userMessage: {
      messageId: accepted.messageId,
      sessionId: input.sessionId,
      role: "user",
      actorType: "user",
      actorId: OPERATOR_ACTOR_ID,
      sourceAuthority: "operator",
      content: message.content,
      timestamp: accepted.event.receivedAt,
    },
    transport: "integration",
    turnId: accepted.turnId,
  };
}

/**
 * Decides what one desk send does and, in the operator's own conversation, accepts it. A missing binding, a mission
 * session, or any conversation that is not provably the operator's own keeps the existing verbatim path. A desk
 * question is text only: files, non-text parts, a template or a workspace snapshot are refused, never dropped.
 */
export async function routeOperatorDeskSend(
  input: Omit<OperatorDeskTurnInput, "binding"> &
    OperatorDeskRequestExtras & {
      binding: ChatSessionBindingRecord | undefined;
      connection: IntegrationConnection | undefined;
    },
  host: ChannelDeskTurnHost,
): Promise<OperatorDeskSendResult> {
  const { binding, connection, attachments, parts, templateInvocation, workspaceSnapshot, ...turn } = input;
  if (!binding) {
    return { mode: "post" };
  }
  const mode = resolveDeskConversationMode(binding, connection);
  if (mode === "blocked") {
    return { mode, message: describeBlockedDeskReply(connection) };
  }
  if (mode === "post") {
    return { mode };
  }
  if (carriesFilesOrTemplates({ attachments, parts, templateInvocation, workspaceSnapshot })) {
    return { mode: "refused", message: DESK_FILES_REFUSED_MESSAGE };
  }
  return { mode, response: await acceptOperatorDeskTurn(host, { ...turn, binding }) };
}

/**
 * Rebuilds the channel route a session key was derived from. A three-part key names one conversation (peer or room
 * derive the same key); a four-part key is a thread in a room.
 */
function decodeSessionRoute(sessionKey: string): {
  channel: string;
  account: string;
  peer?: string;
  room?: string;
  threadId?: string;
} {
  const [channel, account, conversation, threadId, ...rest] = sessionKey.split(":").map(decodeSessionKeySegment);
  if (!channel || !account || !conversation || rest.length > 0) {
    throw new ConflictError({ message: "This conversation has no channel address." });
  }
  return threadId ? { channel, account, room: conversation, threadId } : { channel, account, peer: conversation };
}
