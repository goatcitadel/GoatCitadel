import type { FastifyInstance } from "fastify";
import {
  deriveWhatsAppWebhookEventIdempotencyKey,
  normalizeWhatsAppWebhookPayloads,
  verifyWhatsAppWebhookSignature,
} from "../services/whatsapp-webhook.js";
import {
  createWebhookRouteOptions,
  resolveWhatsAppAppSecret,
  resolveWhatsAppVerifyToken,
} from "./integration-webhooks-shared.js";
import { timingSafeStringEqual } from "../services/webhook-json-helpers.js";
import {
  createIgnoredWebhookReply,
  createWebhookHandler,
  dispatchInboundWebhookBatch,
  dispatchInboundVoiceWebhookMessage,
  dispatchInboundWebhookMessage,
  readHeaderValue,
  readQueryString,
} from "./webhook-handler-factory.js";
import { connectionParamsSchema } from "./integration-webhook-schemas.js";

type WhatsAppDispatchPayload = Array<
  Exclude<ReturnType<typeof normalizeWhatsAppWebhookPayloads>[number], { kind: "ignore" }>
>;

export function registerWhatsAppWebhookRoutes(fastify: FastifyInstance): void {
  const routeOptions = createWebhookRouteOptions("whatsappRawBody");
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
        connection = await fastify.services.integrationWebhooks.getIntegrationConnection(params.data.connectionId);
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
      ...routeOptions,
      config: {
        ...routeOptions.config,
        rateLimit: {
          ...routeOptions.config.rateLimit,
          max: routeOptions.config.rateLimit.max,
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
        const normalized = normalizeWhatsAppWebhookPayloads({
          connectionId,
          payload: request.body,
          voiceInboundEnabled: fastify.services.integrationWebhooks.isVoiceInboundEnabled?.() === true,
        });
        const messages = normalized.filter((event) => event.kind === "message");
        if (messages.length === 0) {
          const ignored = normalized.find((event) => event.kind === "ignore");
          return {
            kind: "reply" as const,
            payload: createIgnoredWebhookReply(ignored?.eventType, ignored?.reason ?? "No supported WhatsApp events"),
          };
        }
        return {
          kind: "dispatch" as const,
          parsed: messages,
        };
      },
      dispatch: async ({ connectionId, connection, parsed }) => {
        const batch = parsed.map((event) => {
          const dispatchOptions = {
            channel: "whatsapp",
            connectionId,
            idempotencyKey: deriveWhatsAppWebhookEventIdempotencyKey(connectionId, event),
            eventType: event.eventType,
            bindingTarget: event.peer,
            inboundAccessConfig: connection.config,
            message: {
              eventId: event.eventId,
              account: event.account,
              peer: event.peer,
              actorId: event.actorId,
              actorType: event.actorType,
              displayName: event.displayName,
              content: event.content,
              metadata: event.metadata,
            },
            responseOptions: {
              deliveryReplyToMessageId: event.deliveryReplyToMessageId,
            },
          };
          return {
            event,
            dispatchOptions,
            durableInput: event.voiceMedia
              ? {
                  ...dispatchOptions,
                  dispatchKind: "voice_agent_turn" as const,
                  voiceRequest: {
                    channel: "whatsapp" as const,
                    connectionConfig: {},
                    mediaId: event.voiceMedia.mediaId,
                    mimeType: event.voiceMedia.mimeType,
                  },
                  voiceFallbackContent: event.content,
                }
              : {
                  ...dispatchOptions,
                  dispatchKind: "agent_turn" as const,
                },
          };
        });

        if (batch.length > 1) {
          return dispatchInboundWebhookBatch(
            fastify.services.integrationWebhooks,
            batch.map(({ durableInput }) => durableInput),
          );
        }

        const single = batch[0]!;
        const voiceMedia = single.event.voiceMedia;
        if (voiceMedia) {
          // Persist the media reference before ACK; the durable worker obtains
          // current connection credentials and owns transcription/retry.
          return dispatchInboundVoiceWebhookMessage(fastify.services.integrationWebhooks, {
            ...single.dispatchOptions,
            voice: {
              request: {
                channel: "whatsapp",
                connectionConfig: {},
                mediaId: voiceMedia.mediaId,
                mimeType: voiceMedia.mimeType,
              },
              fallbackContent: single.event.content,
            },
          });
        }
        return dispatchInboundWebhookMessage(fastify.services.integrationWebhooks, single.dispatchOptions);
      },
    }),
  );
}
