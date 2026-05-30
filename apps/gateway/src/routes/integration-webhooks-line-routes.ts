import type { FastifyInstance } from "fastify";
import {
  deriveLineWebhookIdempotencyKey,
  normalizeLineWebhookPayload,
  verifyLineWebhookSignature,
} from "../services/line-webhook.js";
import { resolveAllowedSenders } from "@goatcitadel/contracts";
import { resolveLineChannelSecret } from "./integration-webhooks-shared.js";
import {
  CHANNEL_INBOUND_MAX_BYTES,
  createIgnoredWebhookReply,
  createWebhookPreParsing,
  createWebhookHandler,
  dispatchInboundWebhookMessage,
  readHeaderValue,
} from "./webhook-handler-factory.js";

type LineDispatchPayload = Exclude<ReturnType<typeof normalizeLineWebhookPayload>, { kind: "ignore" }>;

export function registerLineWebhookRoutes(fastify: FastifyInstance): void {
  fastify.post(
    "/api/v1/integrations/connections/:connectionId/line/webhook",
    {
      bodyLimit: CHANNEL_INBOUND_MAX_BYTES,
      preParsing: createWebhookPreParsing("lineRawBody"),
      config: {
        rateLimit: {
          max: 500,
        },
      },
    },
    createWebhookHandler<LineDispatchPayload>(fastify, {
      source: "line",
      connectorKey: "line",
      connectorLabel: "LINE",
      rawBodyKey: "lineRawBody",
      missingRawBodyError: "Missing LINE raw request body",
      verifySignature: ({ request, connection, rawBody }) => {
        const channelSecret = resolveLineChannelSecret(connection.config);
        if (!channelSecret) {
          return { ok: false as const, statusCode: 400, error: "LINE connection is missing a channel secret" };
        }

        const signatureHeader = readHeaderValue(request.headers["x-line-signature"]);
        if (!verifyLineWebhookSignature(signatureHeader, rawBody, channelSecret)) {
          return {
            ok: false as const,
            statusCode: 401,
            error: "Invalid LINE webhook signature",
            logReason: "signature_mismatch",
          };
        }
        return { ok: true as const };
      },
      parsePayload: ({ connectionId, request }) => {
        const normalized = normalizeLineWebhookPayload({
          connectionId,
          payload: request.body,
        });
        if (normalized.kind === "ignore") {
          return {
            kind: "reply" as const,
            payload: createIgnoredWebhookReply(normalized.eventType, normalized.reason),
          };
        }
        return {
          kind: "dispatch" as const,
          parsed: normalized,
        };
      },
      dispatch: async ({ connectionId, connection, request, rawBody, parsed }) =>
        dispatchInboundWebhookMessage(fastify.services.integrationWebhooks, {
          channel: "line",
          connectionId,
          idempotencyKey: deriveLineWebhookIdempotencyKey(connectionId, request.body, rawBody),
          eventType: parsed.eventType,
          bindingTarget: parsed.room ?? parsed.peer,
          allowedSenders: resolveAllowedSenders(connection.config),
          message: {
            eventId: parsed.eventId,
            account: parsed.account,
            peer: parsed.peer,
            room: parsed.room,
            actorId: parsed.actorId,
            actorType: parsed.actorType,
            content: parsed.content,
            metadata: parsed.metadata,
          },
          responseOptions: {
            deliveryReplyToMessageId: parsed.deliveryReplyToMessageId,
          },
        }),
    }),
  );
}
