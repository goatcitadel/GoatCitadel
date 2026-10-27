import type { FastifyInstance } from "fastify";
import {
  isUnsignedQqbotValidationBody,
  normalizeQqbotWebhookPayload,
  signQqbotValidation,
  verifyQqbotSignature,
} from "../services/qqbot-webhook.js";
import {
  createWebhookRouteOptions,
  createWebhookSecretResolver,
  resolveQqbotSecret,
} from "./integration-webhooks-shared.js";
import type { IntegrationConnectionRecord } from "../services/channel-inbound-dispatch.js";
import { createWebhookHandler, dispatchInboundWebhookMessage, readHeaderValue } from "./webhook-handler-factory.js";

type QqbotDispatchPayload = Extract<ReturnType<typeof normalizeQqbotWebhookPayload>, { kind: "message" }>;

/** QQ expects an op 12 (HTTP callback ACK) for every handled dispatch. */
const QQBOT_ACK = Object.freeze({ op: 12 });

export function registerQqbotWebhookRoutes(fastify: FastifyInstance): void {
  fastify.post(
    "/api/v1/integrations/connections/:connectionId/qqbot/webhook",
    createWebhookRouteOptions("qqbotRawBody"),
    createWebhookHandler<QqbotDispatchPayload>(fastify, {
      source: "qqbot",
      connectorKey: "qqbot",
      connectorLabel: "QQBot",
      rawBodyKey: "qqbotRawBody",
      ignoredReply: () => QQBOT_ACK,
      missingRawBodyError: "Missing QQBot raw request body",
      verifySignature: ({ request, connection, connectionId, rawBody }) => {
        const appSecret = resolveQqbotSecret(connection.config, createWebhookSecretResolver(fastify, connectionId));
        if (!appSecret) {
          return {
            ok: false as const,
            statusCode: 400,
            error: "QQBot connection is missing its app secret (appSecret or appSecretEnv)",
          };
        }
        const signatureHex = readHeaderValue(request.headers["x-signature-ed25519"]);
        const timestamp = readHeaderValue(request.headers["x-signature-timestamp"]);
        // Dispatches always need a valid signature. QQ may send the op 13 callback validation with no signature
        // headers at all, so that one shape (strict token format) is allowed through; if either header is
        // present, the signature must verify.
        const unsignedValidation = !signatureHex && !timestamp && isUnsignedQqbotValidationBody(rawBody);
        const valid = unsignedValidation || verifyQqbotSignature({ appSecret, signatureHex, timestamp, rawBody });
        return valid
          ? { ok: true as const }
          : {
              ok: false as const,
              statusCode: 401,
              error: "Invalid QQBot signature",
              logReason: "invalid_signature",
            };
      },
      parsePayload: ({ connectionId, connection, request, reply }) => {
        const normalized = normalizeQqbotWebhookPayload({ connectionId, payload: request.body });
        if (normalized.kind === "validation") {
          // verifySignature already proved the secret exists.
          const appSecret =
            resolveQqbotSecret(connection.config, createWebhookSecretResolver(fastify, connectionId)) ?? "";
          return {
            kind: "reply" as const,
            payload: {
              plain_token: normalized.plainToken,
              signature: signQqbotValidation({
                appSecret,
                eventTs: normalized.eventTs,
                plainToken: normalized.plainToken,
              }),
            },
          };
        }
        if (normalized.kind === "invalid") {
          void reply.code(400);
          return { kind: "reply" as const, payload: { error: normalized.reason } };
        }
        if (normalized.kind === "ignore") {
          return { kind: "reply" as const, payload: QQBOT_ACK };
        }
        return { kind: "dispatch" as const, parsed: normalized };
      },
      dispatch: async ({ request, reply, connectionId, connection, parsed }) => {
        try {
          await dispatchQqbotMessage(connectionId, connection, parsed);
        } catch (error) {
          request.log.error(
            {
              channel: "qqbot",
              connectionId,
              error: error instanceof Error ? error.message : String(error),
            },
            "QQBot inbound webhook was not acknowledged because durable acceptance failed.",
          );
          // QQ retries non-2xx deliveries, so a transient acceptance failure must not drop the event.
          void reply.code(503);
          return { error: "Durable inbound channel acceptance failed" };
        }
        return QQBOT_ACK;
      },
    }),
  );

  async function dispatchQqbotMessage(
    connectionId: string,
    connection: IntegrationConnectionRecord,
    parsed: QqbotDispatchPayload,
  ): Promise<void> {
    await dispatchInboundWebhookMessage(fastify.services.integrationWebhooks, {
      channel: "qqbot",
      connectionId,
      idempotencyKey: `qqbot:${connectionId}:${parsed.eventId}`,
      eventType: parsed.eventType,
      bindingTarget: parsed.target,
      // QQBot never had inbound, so legacy-open (open_legacy or unset) must never apply:
      // force allowlist semantics and keep the connection's allowedSenders (empty means deny all).
      inboundAccessConfig: { ...connection.config, inboundAccessMode: "allowlist" },
      acceptedConnectionRevision: connection.revision,
      message: {
        eventId: parsed.eventId,
        account: connectionId,
        room: parsed.target,
        actorId: parsed.actorId,
        content: parsed.content,
        // QQ restricts active group/C2C sends, so the reply must be passive against this msg_id.
        metadata: { ...parsed.metadata, qqReplyMsgId: parsed.eventId },
      },
      responseOptions: { deliveryReplyToMessageId: parsed.eventId },
    });
  }
}
