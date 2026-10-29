import type { IntegrationConnection } from "@goatcitadel/contracts";
import { buildChannelConversation } from "./channel-conversation.js";
import { dispatchInboundVoiceWebhookMessage, dispatchInboundWebhookMessage } from "./channel-inbound-dispatch.js";
import type { IntegrationWebhookRoutePort } from "./integration-webhook-route-service.js";
import {
  deriveSlackWebhookIdempotencyKey,
  normalizeSlackWebhookPayload,
  type SlackWebhookNormalization,
} from "./slack-webhook.js";
import { asRecord, asString } from "./webhook-json-helpers.js";

/**
 * Shared Slack event handling.
 *
 * Extracted from routes/integration-webhooks-slack-routes.ts so the webhook route and Socket Mode handle an event
 * the same way: sender rules, voice shares and plain messages. Socket Mode differs in two ways: its sender rules are
 * always allowlist-only, and it leaves voice shares out. The webhook route still owns delivery acceptance (signing
 * secret, team and app binding, rate limit); this module only decides what an accepted event does.
 */

export interface SlackEventDeps {
  webhooks: IntegrationWebhookRoutePort;
}

export type SlackDispatchPayload = Extract<SlackWebhookNormalization, { kind: "message" }>;

/** The part of a connection the dispatch reads. A full IntegrationConnection satisfies it. */
export type SlackDispatchConnection = Pick<IntegrationConnection, "connectionId" | "revision" | "config">;

/**
 * Today's webhook dispatch, unchanged: returns the body the webhook route sends back.
 *
 * `rawBody` is the webhook's request body. It only names the idempotency key of an event that has neither a
 * channel and ts nor an `event_id`; Socket Mode has no raw body, so the event itself stands in.
 */
export async function dispatchSlackEvent(
  deps: SlackEventDeps,
  input: {
    connection: SlackDispatchConnection;
    parsed: SlackDispatchPayload;
    payload: unknown;
    rawBody?: Buffer;
  },
): Promise<unknown> {
  const { connection, parsed, payload } = input;
  const connectionId = connection.connectionId;
  const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(payload ?? null), "utf8");
  const dispatchOptions = {
    channel: "slack",
    connectionId,
    // Voice and text share the provider event key, so replays dedupe, and so does a message and its app_mention.
    idempotencyKey: deriveSlackWebhookIdempotencyKey(connectionId, payload, rawBody),
    eventType: parsed.eventType,
    bindingTarget: parsed.room ?? parsed.peer,
    // Slack events carry ids but no names, so neither kind gets a title here.
    conversation: buildChannelConversation(
      parsed.metadata.channelType === "im" ? { kind: "direct", counterpartActorId: parsed.actorId } : { kind: "group" },
    ),
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
      content: parsed.content,
      metadata: parsed.metadata,
    },
    responseOptions: {
      deliveryReplyToMessageId: parsed.deliveryReplyToMessageId,
    },
  };
  const voiceMedia = parsed.voiceMedia;
  if (voiceMedia) {
    // Accept the secret-free file reference before ACK; the durable worker
    // resolves the current bot token and owns download/transcription.
    return dispatchInboundVoiceWebhookMessage(deps.webhooks, {
      ...dispatchOptions,
      voice: {
        request: {
          channel: "slack",
          connectionConfig: {},
          fileId: voiceMedia.fileId,
          downloadUrl: voiceMedia.downloadUrl,
          mimeType: voiceMedia.mimeType,
        },
        fallbackContent: parsed.content,
        caption: parsed.voiceCaption,
      },
    });
  }
  return dispatchInboundWebhookMessage(deps.webhooks, dispatchOptions);
}

/**
 * Socket Mode entry: re-reads the connection, normalizes and dispatches. Undefined when the connection is not live
 * or Slack's event is ignored (the bot's own message, an event from another workspace, a challenge, an unsupported
 * event kind).
 */
export async function runSlackEvent(deps: SlackEventDeps, connectionId: string, payload: unknown): Promise<unknown> {
  const connection = await deps.webhooks.getIntegrationConnection(connectionId);
  // Same kill switch as the webhook handler: a disabled or disconnected connection must not ingest anything.
  if (connection.enabled === false || (connection.status !== undefined && connection.status !== "connected")) {
    return undefined;
  }
  // Only a Slack connection that still uses Socket Mode may act on a socket event; one switched to a webhook since
  // the socket opened must not.
  const config = connection.config;
  if (connection.key !== "slack" || asString(config.receiveMode) !== "socket") {
    return undefined;
  }
  // A socket opened with this connection's app token only carries its own workspace, so this is a backstop.
  const savedTeamId = asString(config.slackTeamId);
  const eventTeamId = asString(asRecord(payload).team_id);
  if (savedTeamId && eventTeamId && eventTeamId !== savedTeamId) {
    return undefined;
  }
  const normalized = normalizeSlackWebhookPayload({
    connectionId,
    payload,
    botUserId: asString(config.slackBotUserId),
    appId: asString(config.slackAppId),
    // Voice messages over Socket Mode are left out: the app has no file-reading scope, so the voice flag is not read.
    voiceInboundEnabled: false,
  });
  if (normalized.kind !== "message") {
    return undefined;
  }
  return dispatchSlackEvent(deps, {
    // Socket Mode inbound is always allowlist-only, as for every stream channel: a legacy connection saved as open
    // (or with no access mode) and switched to Socket Mode is never open to the whole workspace.
    connection: { ...connection, connectionId, config: { ...config, inboundAccessMode: "allowlist" } },
    parsed: normalized,
    payload,
  });
}
