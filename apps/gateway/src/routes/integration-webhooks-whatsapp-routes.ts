import type { FastifyInstance } from "fastify";
import {
  deriveWhatsAppWebhookIdempotencyKey,
  normalizeWhatsAppWebhookPayload,
  verifyWhatsAppWebhookSignature,
} from "../services/whatsapp-webhook.js";
import { resolveWhatsAppAppSecret, resolveWhatsAppVerifyToken } from "./integration-webhooks-shared.js";
import { timingSafeStringEqual } from "../services/webhook-json-helpers.js";
import {
  CHANNEL_INBOUND_MAX_BYTES,
  createIgnoredWebhookReply,
  createWebhookPreParsing,
  createWebhookHandler,
  dispatchInboundVoiceWebhookMessage,
  dispatchInboundWebhookMessage,
  readHeaderValue,
  readQueryString,
} from "./webhook-handler-factory.js";
import { connectionParamsSchema } from "./integration-webhook-schemas.js";

type WhatsAppDispatchPayload = Exclude<ReturnType<typeof normalizeWhatsAppWebhookPayload>, { kind: "ignore" }>;

export function registerWhatsAppWebhookRoutes(fastify: FastifyInstance): void {
  fastify.get(
    "/api/v1/integrations/connections/:connectionId/whatsapp/webhook",
    {
      config: {
        rateLimit: {
          max: 500,
        },
      },
    },
    async (request, reply) => {
      const params = connectionParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }

      let connection;
      try {
        connection = fastify.services.integrationWebhooks.getIntegrationConnection(params.data.connectionId);
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
      if (connection.key !== "whatsapp") {
        return reply.code(400).send({ error: "Integration connection is not a WhatsApp connector" });
      }

      const verifyToken = resolveWhatsAppVerifyToken(connection.config);
      if (!verifyToken) {
        return reply.code(400).send({ error: "WhatsApp connection is missing a webhook verify token" });
      }

      const query = request.query as Record<string, unknown>;
      const mode = readQueryString(query, "hub.mode");
      const providedVerifyToken = readQueryString(query, "hub.verify_token");
      const challenge = readQueryString(query, "hub.challenge");
      if (mode !== "subscribe" || !challenge) {
        return reply.code(400).send({ error: "Invalid WhatsApp webhook verification query" });
      }
      if (!providedVerifyToken || !timingSafeStringEqual(providedVerifyToken, verifyToken)) {
        return reply.code(401).send({ error: "Invalid WhatsApp webhook verify token" });
      }

      return reply.type("text/plain").send(challenge);
    },
  );

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/whatsapp/webhook",
    {
      bodyLimit: CHANNEL_INBOUND_MAX_BYTES,
      preParsing: createWebhookPreParsing("whatsappRawBody"),
      config: {
        rateLimit: {
          max: 500,
        },
      },
    },
    createWebhookHandler<WhatsAppDispatchPayload>(fastify, {
      source: "whatsapp",
      connectorKey: "whatsapp",
      connectorLabel: "WhatsApp",
      rawBodyKey: "whatsappRawBody",
      missingRawBodyError: "Missing WhatsApp raw request body",
      verifySignature: ({ request, connection, rawBody }) => {
        const appSecret = resolveWhatsAppAppSecret(connection.config);
        if (!appSecret) {
          return { ok: false as const, statusCode: 400, error: "WhatsApp connection is missing an app secret" };
        }

        const signatureHeader = readHeaderValue(request.headers["x-hub-signature-256"]);
        if (!verifyWhatsAppWebhookSignature(signatureHeader, rawBody, appSecret)) {
          return {
            ok: false as const,
            statusCode: 401,
            error: "Invalid WhatsApp webhook signature",
            logReason: "signature_mismatch",
          };
        }
        return { ok: true as const };
      },
      parsePayload: ({ connectionId, request }) => {
        const normalized = normalizeWhatsAppWebhookPayload({
          connectionId,
          payload: request.body,
          voiceInboundEnabled: fastify.services.integrationWebhooks.isVoiceInboundEnabled?.() === true,
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
      dispatch: async ({ connectionId, connection, request, rawBody, parsed }) => {
        const dispatchOptions = {
          channel: "whatsapp",
          connectionId,
          idempotencyKey: deriveWhatsAppWebhookIdempotencyKey(connectionId, request.body, rawBody),
          eventType: parsed.eventType,
          bindingTarget: parsed.peer,
          inboundAccessConfig: connection.config,
          message: {
            eventId: parsed.eventId,
            account: parsed.account,
            peer: parsed.peer,
            actorId: parsed.actorId,
            actorType: parsed.actorType,
            displayName: parsed.displayName,
            content: parsed.content,
            metadata: parsed.metadata,
          },
          responseOptions: {
            deliveryReplyToMessageId: parsed.deliveryReplyToMessageId,
          },
        };
        const voiceMedia = parsed.voiceMedia;
        if (voiceMedia) {
          // channelVoiceInboundV1Enabled path (voiceMedia only exists when the
          // flag is on): trust gate first (no download for unknown senders),
          // fast webhook ack, async download/transcription/ingest, placeholder
          // fallback on failure so the message is never silently dropped.
          return dispatchInboundVoiceWebhookMessage(fastify.services.integrationWebhooks, {
            ...dispatchOptions,
            voice: {
              transcribe: () =>
                fastify.services.integrationWebhooks.transcribeChannelVoice({
                  channel: "whatsapp",
                  connectionConfig: connection.config,
                  mediaId: voiceMedia.mediaId,
                  mimeType: voiceMedia.mimeType,
                }),
              fallbackContent: parsed.content,
            },
          });
        }
        return dispatchInboundWebhookMessage(fastify.services.integrationWebhooks, dispatchOptions);
      },
    }),
  );
}
