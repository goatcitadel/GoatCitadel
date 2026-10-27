import type {
  ChatChannelConversation,
  IntegrationConnection,
  PersonalityCatalogResponse,
} from "@goatcitadel/contracts";
import { readTelegramReceiveMode } from "@goatcitadel/gateway-core";
import { buildChannelConversation } from "./channel-conversation.js";
import { normalizeChannelCommandInput } from "./channel-command-contract.js";
import {
  createIgnoredWebhookReply,
  dispatchInboundWebhookCommand,
  dispatchInboundVoiceWebhookMessage,
  dispatchInboundWebhookMessage,
} from "./channel-inbound-dispatch.js";
import type { IntegrationWebhookRoutePort } from "./integration-webhook-route-service.js";
import { buildChannelPersonalitySystemOverlay } from "./telegram-channel-commands.js";
import { authorizeTelegramChannelActor } from "./telegram-channel-pairing.js";
import { applyTelegramChannelSessionRotation } from "./telegram-channel-sessions.js";
import {
  TELEGRAM_APPROVAL_CALLBACK_EVENT_TYPE,
  TELEGRAM_CHANNEL_COMMAND_EVENT_TYPE,
} from "./telegram-inbound-command-service.js";
import { deriveTelegramWebhookIdempotencyKey, normalizeTelegramWebhookPayload } from "./telegram-webhook.js";

/**
 * Shared Telegram update handling.
 *
 * Extracted from routes/integration-webhooks-telegram-routes.ts so the webhook route and long polling handle an
 * update the same way: pairing, channel commands, approval callbacks, voice notes and plain messages. The webhook
 * route still owns delivery acceptance (secret token, receive mode, rate limit); this module only decides what an
 * accepted update does.
 */

export interface TelegramUpdateDeps {
  webhooks: IntegrationWebhookRoutePort;
  readPersonalityCatalog(): Promise<Omit<PersonalityCatalogResponse, "revision">>;
}

export type TelegramDispatchPayload = Exclude<ReturnType<typeof normalizeTelegramWebhookPayload>, { kind: "ignore" }>;

/** The part of a connection the dispatch reads. A full IntegrationConnection satisfies it. */
export type TelegramDispatchConnection = Pick<IntegrationConnection, "connectionId" | "revision" | "config">;

export type TelegramBotMethodCall = {
  method: "sendMessage" | "answerCallbackQuery";
  params: Record<string, unknown>;
};

/** Today's webhook dispatch, unchanged: returns the body the webhook route sends back. */
export async function dispatchTelegramUpdate(
  deps: TelegramUpdateDeps,
  input: {
    connection: TelegramDispatchConnection;
    parsed: TelegramDispatchPayload;
    payload: unknown;
    rawBody: Buffer;
  },
): Promise<unknown> {
  const { connection, parsed, payload, rawBody } = input;
  const connectionId = connection.connectionId;
  const target = parsed.room ?? parsed.peer;
  const conversation = resolveTelegramConversation(parsed.actorId, parsed.metadata);
  if (parsed.kind === "callback") {
    const approval = parseTelegramApprovalCallback(parsed.content);
    if (!approval) {
      return {
        method: "answerCallbackQuery",
        callback_query_id: parsed.callbackQueryId,
        text: "GoatCitadel did not recognize that channel action.",
      };
    }
    const auth = target
      ? authorizeTelegramChannelActor({
          config: connection.config,
          chatId: target,
          actorId: parsed.actorId,
          actorDisplayName: readTelegramMetadataString(parsed.metadata, "actorDisplayName"),
        })
      : { authorized: false };
    if (!auth.authorized) {
      if (auth.configPatch) {
        await deps.webhooks.updateIntegrationConnection(connectionId, {
          expectedRevision: connection.revision,
          config: {
            ...connection.config,
            ...auth.configPatch,
          },
          lastSyncAt: new Date().toISOString(),
          lastError: null,
        });
      }
      return {
        method: "answerCallbackQuery",
        callback_query_id: parsed.callbackQueryId,
        text: "Approve this Telegram user in GoatCitadel before resolving channel approvals.",
        show_alert: true,
      };
    }
    const approvalActionId = await deps.webhooks.findRemoteActionTokenId?.(approval.token);
    const callbackIdempotencyKey = deriveTelegramWebhookIdempotencyKey(connectionId, payload, rawBody);
    const command = await dispatchInboundWebhookCommand(deps.webhooks, {
      channel: "telegram",
      connectionId,
      idempotencyKey: callbackIdempotencyKey,
      eventType: TELEGRAM_APPROVAL_CALLBACK_EVENT_TYPE,
      bindingTarget: target,
      conversation,
      inboundAccessConfig: connection.config,
      acceptedConnectionRevision: connection.revision,
      message: {
        // The callback query id is an ephemeral provider reply handle.
        // Use the secret-free durable admission identity for settlement.
        eventId: callbackIdempotencyKey,
        account: parsed.account,
        peer: parsed.peer,
        room: parsed.room,
        threadId: parsed.threadId,
        actorId: parsed.actorId,
        actorType: parsed.actorType,
        content: `/${approval.decision}`,
        displayName: resolveTelegramConversationName(parsed.metadata),
        metadata: {
          ...withoutTelegramEphemeralCallbackMetadata(parsed.metadata),
          approvalActionId,
          approvalActionLookupFailed: !approvalActionId,
          approvalDecision: approval.decision,
        },
      },
    });
    const resultText = renderDurableCommandResult(command.result);
    return {
      method: "answerCallbackQuery",
      callback_query_id: parsed.callbackQueryId,
      text: resultText.slice(0, 200),
      show_alert: command.result.status !== "completed",
    };
  }

  if (target) {
    const auth = authorizeTelegramChannelActor({
      config: connection.config,
      chatId: target,
      actorId: parsed.actorId,
      actorDisplayName: readTelegramMetadataString(parsed.metadata, "actorDisplayName"),
    });
    if (!auth.authorized) {
      if (auth.configPatch) {
        await deps.webhooks.updateIntegrationConnection(connectionId, {
          expectedRevision: connection.revision,
          config: {
            ...connection.config,
            ...auth.configPatch,
          },
          lastSyncAt: new Date().toISOString(),
          lastError: null,
        });
      }
      return auth.response ?? createIgnoredWebhookReply(parsed.eventType, "Telegram actor is not paired");
    }
  }

  // Voice messages never participate in channel command handling or
  // approval-token resolution: transcripts are spoofable auto-generated
  // text, and commands require typed text. The voice branch below routes
  // straight to the trust-gated voice dispatch.
  const commandEligible = target && !parsed.voiceMedia ? target : undefined;
  const normalizedCommand = commandEligible
    ? normalizeChannelCommandInput(parsed.content, { platform: "telegram" })
    : undefined;
  if (commandEligible && normalizedCommand?.handled && normalizedCommand.command && normalizedCommand.name) {
    const approvalActionId = normalizedCommand.approvalToken
      ? await deps.webhooks.findRemoteActionTokenId?.(normalizedCommand.approvalToken)
      : undefined;
    const approvalCommand =
      normalizedCommand.name === "approve" || normalizedCommand.name === "deny"
        ? normalizedCommand.approvalDecision
        : undefined;
    const command = await dispatchInboundWebhookCommand(deps.webhooks, {
      channel: "telegram",
      connectionId,
      idempotencyKey: deriveTelegramWebhookIdempotencyKey(connectionId, payload, rawBody),
      eventType: TELEGRAM_CHANNEL_COMMAND_EVENT_TYPE,
      bindingTarget: commandEligible,
      conversation,
      inboundAccessConfig: connection.config,
      acceptedConnectionRevision: connection.revision,
      message: {
        eventId: parsed.eventId,
        account: parsed.account,
        peer: parsed.peer,
        room: parsed.room,
        threadId: parsed.threadId,
        actorId: parsed.actorId,
        actorType: parsed.actorType,
        content: approvalCommand ? `/${normalizedCommand.name}` : parsed.content,
        displayName: resolveTelegramConversationName(parsed.metadata),
        metadata: {
          ...withoutTelegramEphemeralCallbackMetadata(parsed.metadata),
          approvalActionId,
          approvalActionLookupFailed: Boolean(normalizedCommand.approvalToken && !approvalActionId),
          approvalDecision: approvalCommand,
        },
      },
    });
    return {
      method: "sendMessage",
      chat_id: commandEligible,
      text: renderDurableCommandResult(command.result),
    };
  }
  const routedTelegramMessage = applyTelegramChannelSessionRotation(connection.config, {
    peer: parsed.peer,
    room: parsed.room,
    threadId: parsed.threadId,
  });
  const dispatchOptions = {
    channel: "telegram",
    connectionId,
    idempotencyKey: deriveTelegramWebhookIdempotencyKey(connectionId, payload, rawBody),
    eventType: parsed.eventType,
    bindingTarget: target,
    conversation,
    inboundAccessConfig: connection.config,
    acceptedConnectionRevision: connection.revision,
    message: {
      eventId: parsed.eventId,
      account: parsed.account,
      peer: routedTelegramMessage.peer,
      room: routedTelegramMessage.room,
      threadId: routedTelegramMessage.threadId,
      actorId: parsed.actorId,
      actorType: parsed.actorType,
      displayName: resolveTelegramConversationName(parsed.metadata),
      content: parsed.content,
      metadata: parsed.metadata,
    },
    responseOptions: {
      deliveryReplyToMessageId: parsed.deliveryReplyToMessageId,
      channelSystemInstruction: target
        ? buildChannelPersonalitySystemOverlay(connection.config, target, await deps.readPersonalityCatalog())
        : undefined,
    },
  };
  const voiceMedia = parsed.voiceMedia;
  if (voiceMedia) {
    // Voice media is accepted as a bounded secret-free reference before
    // ACK. Download/transcription/ingest are owned by the durable worker.
    return dispatchInboundVoiceWebhookMessage(deps.webhooks, {
      ...dispatchOptions,
      voice: {
        request: {
          channel: "telegram",
          connectionConfig: {},
          fileId: voiceMedia.fileId,
          mimeType: voiceMedia.mimeType,
        },
        fallbackContent: parsed.content,
      },
    });
  }
  return dispatchInboundWebhookMessage(deps.webhooks, dispatchOptions);
}

/**
 * Polling entry: re-reads the connection, normalizes, dispatches. Undefined when the connection is not live or
 * Telegram's update is ignored (a bot's own message, an unsupported update kind, an empty message).
 */
export async function runTelegramUpdate(
  deps: TelegramUpdateDeps,
  connectionId: string,
  update: unknown,
): Promise<unknown> {
  const connection = await deps.webhooks.getIntegrationConnection(connectionId);
  // Same kill switch as the webhook handler: a disabled or disconnected connection must not ingest anything.
  if (connection.enabled === false || (connection.status !== undefined && connection.status !== "connected")) {
    return undefined;
  }
  // Only a Telegram connection that still polls may act on a polled update; one switched to a webhook or to
  // receiving nothing since the poll began must not.
  if (connection.key !== "telegram" || readTelegramReceiveMode(connection.config) !== "poll") {
    return undefined;
  }
  const normalized = normalizeTelegramWebhookPayload({
    connectionId,
    payload: update,
    voiceInboundEnabled: await readVoiceInboundEnabled(deps),
  });
  if (normalized.kind === "ignore") {
    return undefined;
  }
  return dispatchTelegramUpdate(deps, {
    connection: { ...connection, connectionId },
    parsed: normalized,
    payload: update,
    rawBody: Buffer.alloc(0),
  });
}

/**
 * A webhook reply body that is a Bot API call the poller must make itself. Telegram executes such a body when it
 * is returned from a webhook; a poll has no response channel, so the caller sends it. Anything else (an
 * acceptance receipt, an ignored reply, a method that is not sent from a reply) is not a Bot API call.
 */
export function readTelegramBotMethodCall(body: unknown): TelegramBotMethodCall | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const { method, ...params } = body as Record<string, unknown>;
  if (method !== "sendMessage" && method !== "answerCallbackQuery") {
    return undefined;
  }
  return { method, params };
}

// Mirrors readWebhookVoiceInboundEnabled: a failing flag read means voice is off. The error is dropped without
// being logged or rethrown because its message could carry connection details.
async function readVoiceInboundEnabled(deps: TelegramUpdateDeps): Promise<boolean> {
  try {
    return (await deps.webhooks.isVoiceInboundEnabled?.()) === true;
  } catch {
    return false;
  }
}

function readTelegramMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

// A private chat is named after the person; a group or channel after its title.
function resolveTelegramConversationName(metadata: Record<string, unknown>): string | undefined {
  const actorDisplayName = readTelegramMetadataString(metadata, "actorDisplayName");
  if (readTelegramMetadataString(metadata, "chatType") === "private") {
    return actorDisplayName;
  }
  return readTelegramMetadataString(metadata, "chatTitle") ?? actorDisplayName;
}

// A private chat is a direct conversation with the sender; anything else is a group or channel.
function resolveTelegramConversation(actorId: string, metadata: Record<string, unknown>): ChatChannelConversation {
  if (readTelegramMetadataString(metadata, "chatType") === "private") {
    return buildChannelConversation({
      kind: "direct",
      counterpartActorId: actorId,
      title: readTelegramMetadataString(metadata, "actorDisplayName"),
    });
  }
  return buildChannelConversation({ kind: "group", title: readTelegramMetadataString(metadata, "chatTitle") });
}

function withoutTelegramEphemeralCallbackMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const safeMetadata = { ...metadata };
  delete safeMetadata.callbackData;
  delete safeMetadata.callbackQueryId;
  return safeMetadata;
}

function parseTelegramApprovalCallback(data: string): { token: string; decision: "approve" | "reject" } | undefined {
  const match = /^gca:([^:]+):(a|r)$/i.exec(data.trim());
  if (!match) {
    return undefined;
  }
  return {
    token: match[1] ?? "",
    decision: (match[2]?.toLowerCase() === "a" ? "approve" : "reject") as "approve" | "reject",
  };
}

function renderDurableCommandResult(
  result:
    | { status: "completed"; resultText: string }
    | { status: "manual_reconciliation_required" | "failed"; message: string },
): string {
  if (result.status === "completed") {
    return result.resultText;
  }
  if (result.status === "manual_reconciliation_required") {
    return [
      "GoatCitadel retained this command for manual reconciliation because execution may have started.",
      "It was not replayed automatically.",
    ].join(" ");
  }
  return result.message;
}
