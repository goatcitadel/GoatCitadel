import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { NotFoundError } from "@goatcitadel/contracts";
import { buildChannelConversation } from "../services/channel-conversation.js";
import {
  createAcceptedWebhookRateLimit,
  enforceAcceptedWebhookRateLimit,
  type AcceptedWebhookRateLimit,
} from "../services/webhook-rate-limit.js";
import {
  deriveWhatsAppWebhookEventIdempotencyKey,
  normalizeWhatsAppWebhookPayloads,
  verifyWhatsAppWebhookConnectionBinding,
  verifyWhatsAppWebhookSignature,
} from "../services/whatsapp-webhook.js";
import {
  createWebhookRouteOptions,
  createWebhookSecretResolver,
  readWebhookVoiceInboundEnabled,
  resolveWhatsAppAppSecret,
  resolveWhatsAppVerifyToken,
} from "./integration-webhooks-shared.js";
import { asString, timingSafeStringEqual } from "../services/webhook-json-helpers.js";
import {
  createIgnoredWebhookReply,
  createWebhookHandler,
  dispatchInboundWebhookBatch,
  dispatchInboundVoiceWebhookMessage,
  dispatchInboundWebhookMessage,
  readHeaderValue,
  readQueryString,
  validateWebhookHostHeader,
  type WebhookRawBodyRequest,
} from "./webhook-handler-factory.js";
import { connectionParamsSchema } from "./integration-webhook-schemas.js";

type WhatsAppDispatchPayload = Array<
  Exclude<ReturnType<typeof normalizeWhatsAppWebhookPayloads>[number], { kind: "ignore" }>
>;

type WhatsAppWebhookRequest = FastifyRequest & Partial<WebhookRawBodyRequest>;

/** The sentences a refused setup-draft delivery is answered with. None of them can carry anything Meta sent. */
const SETUP_DELIVERY_REFUSALS = {
  400: "Invalid WhatsApp webhook payload",
  401: "Invalid WhatsApp webhook signature",
  403: "WhatsApp webhook does not match this connection",
} as const;

export function registerWhatsAppWebhookRoutes(fastify: FastifyInstance): void {
  const routeOptions = createWebhookRouteOptions("whatsappRawBody");
  // The accepted-delivery limit for a setup draft's address, made with the helper the saved-connection handler uses
  // (same limit, window and key). Like every limiter made that way it has its own store; an id is never both a saved
  // connection and a setup draft, so no address is counted in two places.
  const setupDeliveryRateLimit = createAcceptedWebhookRateLimit(fastify, "whatsapp");
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
        // An address that is no saved connection may be a setup draft made on the Messaging page.
        if (
          error instanceof NotFoundError &&
          (await answerSetupCheck(fastify, request, reply, params.data.connectionId))
        ) {
          return reply;
        }
        return reply.code(404).send({ error: (error as Error).message });
      }
      if (connection.key !== "whatsapp") {
        return reply.code(400).send({ error: "Integration connection is not a WhatsApp connector" });
      }

      const verifyToken = resolveWhatsAppVerifyToken(
        connection.config,
        createWebhookSecretResolver(fastify, params.data.connectionId),
      );
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
      // Ahead of the saved-connection handler: an address that is no saved connection may be a setup draft's.
      preHandler: (request, reply) => answerSetupDelivery(fastify, setupDeliveryRateLimit, request, reply),
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
      verifySignature: ({ request, connection, connectionId, rawBody }) => {
        const appSecret = resolveWhatsAppAppSecret(
          connection.config,
          createWebhookSecretResolver(fastify, connectionId),
        );
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
        const binding = verifyWhatsAppWebhookConnectionBinding({
          payload: request.body,
          expectedPhoneNumberId: asString(connection.config.phoneNumberId) ?? asString(connection.config.senderId),
        });
        if (!binding.ok) {
          const missingConnectionIdentity = binding.reason === "missing_connection_identity";
          return {
            ok: false as const,
            statusCode: missingConnectionIdentity ? 400 : 403,
            error: missingConnectionIdentity
              ? "WhatsApp connection is missing its expected phone number identity"
              : "WhatsApp webhook does not match this connection",
            logReason: `connection_binding_${binding.reason}`,
          };
        }
        return { ok: true as const };
      },
      parsePayload: async ({ connectionId, request }) => {
        const normalized = normalizeWhatsAppWebhookPayloads({
          connectionId,
          payload: request.body,
          voiceInboundEnabled: await readWebhookVoiceInboundEnabled(fastify, request, "whatsapp"),
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
            // Inbound WhatsApp events are always one-to-one with the sender.
            conversation: buildChannelConversation({
              kind: "direct",
              counterpartActorId: event.actorId,
              title: event.displayName,
            }),
            inboundAccessConfig: connection.config,
            acceptedConnectionRevision: connection.revision,
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

/**
 * Meta's address check for a WhatsApp setup draft that is not a saved connection yet. Answers it and returns true when
 * the listener did; returns false when the address is no setup draft either, so the 404 stays what it always was.
 */
async function answerSetupCheck(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  connectionId: string,
): Promise<boolean> {
  const webhooks = fastify.services.integrationWebhooks;
  if (typeof webhooks.answerWhatsAppSetupCheck !== "function") {
    return false;
  }
  const query = request.query as Record<string, unknown>;
  const answer = (await webhooks.answerWhatsAppSetupCheck(connectionId, {
    mode: readQueryString(query, "hub.mode"),
    verifyToken: readQueryString(query, "hub.verify_token"),
    challenge: readQueryString(query, "hub.challenge"),
  })) as { status?: unknown; challenge?: unknown } | undefined;
  if (answer?.status === 200 && typeof answer.challenge === "string") {
    reply.type("text/plain").send(answer.challenge);
    return true;
  }
  if (answer?.status === 400) {
    reply.code(400).send({ error: "Invalid WhatsApp webhook verification query" });
    return true;
  }
  if (answer?.status === 401) {
    reply.code(401).send({ error: "Invalid WhatsApp webhook verify token" });
    return true;
  }
  return false;
}

/**
 * A delivery for an address that is no saved connection. When it is a setup draft made on the Messaging page, the
 * listener checks the signature and hears the setup code; the delivery is answered as ignored and never reaches a
 * conversation. The size limit, the raw body and the ingress rate limit are the route's own, so they apply here as they do
 * to a saved connection. The accepted-delivery limit applies where the saved-connection handler applies it, once the
 * signature has passed: a 200 from the listener means a setup draft, a valid signature and the draft's phone number, so
 * only then is the limit spent (and 429 answered when it is used up). Unsigned, wrongly signed and unknown addresses never
 * spend it. Returns the reply once it has answered, and nothing when the saved-connection handler is to answer: a saved
 * connection, a bad address or Host header, a missing body, an address that is no setup draft, and any lookup that failed
 * for a reason other than "not found".
 */
async function answerSetupDelivery(
  fastify: FastifyInstance,
  rateLimit: AcceptedWebhookRateLimit | undefined,
  request: WhatsAppWebhookRequest,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  const webhooks = fastify.services.integrationWebhooks;
  const params = connectionParamsSchema.safeParse(request.params);
  const rawBody = request.whatsappRawBody;
  if (
    !params.success ||
    !rawBody ||
    validateWebhookHostHeader(request) ||
    typeof webhooks.hearWhatsAppSetupDelivery !== "function" ||
    !(await isMissingConnection(fastify, params.data.connectionId))
  ) {
    return undefined;
  }

  const connectionId = params.data.connectionId;
  const heard = (await webhooks.hearWhatsAppSetupDelivery(
    connectionId,
    rawBody.toString("utf8"),
    readHeaderValue(request.headers["x-hub-signature-256"]),
  )) as { status?: unknown } | undefined;
  if (heard?.status === 200) {
    if (await enforceAcceptedWebhookRateLimit(rateLimit, request, reply)) {
      return reply;
    }
    return reply.send(createIgnoredWebhookReply(undefined, "setup_listening"));
  }
  if (heard?.status === 400 || heard?.status === 401 || heard?.status === 403) {
    if (heard.status !== 400) {
      request.log.warn(
        {
          channel: "whatsapp",
          connectionId,
          reason: heard.status === 401 ? "setup_signature_mismatch" : "setup_connection_binding_mismatch",
        },
        "Rejected inbound webhook because verification failed.",
      );
    }
    return reply.code(heard.status).send({ error: SETUP_DELIVERY_REFUSALS[heard.status] });
  }
  return undefined;
}

/** Whether the connection lookup said "not found", which is the only answer that makes an address a candidate setup draft. */
async function isMissingConnection(fastify: FastifyInstance, connectionId: string): Promise<boolean> {
  try {
    await fastify.services.integrationWebhooks.getIntegrationConnection(connectionId);
    return false;
  } catch (error) {
    return error instanceof NotFoundError;
  }
}
