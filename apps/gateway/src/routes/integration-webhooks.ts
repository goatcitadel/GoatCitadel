import type { FastifyPluginAsync } from "fastify";
import { evaluateChannelInboundAccess } from "@goatcitadel/contracts";
import { registerLineWebhookRoutes } from "./integration-webhooks-line-routes.js";
import { registerNextcloudTalkWebhookRoutes } from "./integration-webhooks-nextcloud-talk-routes.js";
import { registerSlackWebhookRoutes } from "./integration-webhooks-slack-routes.js";
import { registerTelegramWebhookRoutes } from "./integration-webhooks-telegram-routes.js";
import { registerWhatsAppWebhookRoutes } from "./integration-webhooks-whatsapp-routes.js";
import { createWebhookRouteOptions, resolveGenericChannelInboundSecret } from "./integration-webhooks-shared.js";
import { channelConnectionInboundParamsSchema, channelInboundSchema } from "./integration-webhook-schemas.js";
import {
  CHANNEL_INBOUND_MAX_BYTES,
  createIgnoredWebhookReply,
  parseContentLength,
  readHeaderValue,
  validateWebhookHostHeader,
} from "./webhook-handler-factory.js";
import {
  deriveGenericChannelInboundIdempotencyKey,
  verifyGenericChannelInboundSignature,
} from "../services/generic-channel-webhook.js";
import { createAcceptedWebhookRateLimit, enforceAcceptedWebhookRateLimit } from "../services/webhook-rate-limit.js";

export const integrationWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  const genericChannelInboundOptions = createWebhookRouteOptions("genericChannelRawBody");
  const genericAcceptedRateLimit = createAcceptedWebhookRateLimit(fastify, "generic");
  fastify.post(
    "/api/v1/integrations/connections/:connectionId/:channel/inbound",
    {
      ...genericChannelInboundOptions,
      config: {
        ...genericChannelInboundOptions.config,
        rateLimit: {
          ...genericChannelInboundOptions.config.rateLimit,
          max: genericChannelInboundOptions.config.rateLimit.max,
        },
      },
    },
    async (request, reply) => {
      const contentLength = parseContentLength(request.headers["content-length"]);
      if (contentLength !== undefined && contentLength > CHANNEL_INBOUND_MAX_BYTES) {
        return reply.code(413).send({
          error: `Inbound channel payload too large. Max ${CHANNEL_INBOUND_MAX_BYTES} bytes.`,
        });
      }
      const hostHeaderError = validateWebhookHostHeader(request);
      if (hostHeaderError) {
        return reply.code(400).send({ error: hostHeaderError });
      }

      const params = channelConnectionInboundParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }

      let connection: ReturnType<typeof fastify.services.integrationWebhooks.getIntegrationConnection>;
      try {
        connection = await fastify.services.integrationWebhooks.getIntegrationConnection(params.data.connectionId);
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }

      if (connection.key !== params.data.channel) {
        return reply.code(400).send({ error: "Integration connection does not match inbound channel" });
      }
      if (connection.enabled === false || (connection.status !== undefined && connection.status !== "connected")) {
        // Same policy as webhook-handler-factory: reply 200-ignored rather
        // than a non-2xx so external providers do not auto-disable the
        // webhook subscription on repeated failures; "disable" stays an
        // effective local inbound kill switch either way.
        return reply.send(createIgnoredWebhookReply(undefined, "connection_disabled"));
      }

      const rawBody = (request as typeof request & { genericChannelRawBody?: Buffer }).genericChannelRawBody;
      if (!rawBody) {
        return reply.code(400).send({ error: "Missing generic channel raw request body" });
      }

      const secret = resolveGenericChannelInboundSecret(connection.config);
      if (!secret) {
        return reply.code(400).send({ error: "Integration connection is missing a generic inbound secret" });
      }

      const timestampHeader = readHeaderValue(request.headers["x-goatcitadel-channel-timestamp"]);
      const signatureHeader = readHeaderValue(request.headers["x-goatcitadel-channel-signature"]);
      if (
        !verifyGenericChannelInboundSignature({
          timestamp: timestampHeader,
          signature: signatureHeader,
          rawBody,
          secret,
        })
      ) {
        request.log.warn(
          {
            channel: params.data.channel,
            connectionId: params.data.connectionId,
            reason: "signature_mismatch",
          },
          "Rejected generic channel inbound webhook because verification failed.",
        );
        return reply.code(401).send({ error: "Invalid generic channel inbound signature" });
      }
      if (await enforceAcceptedWebhookRateLimit(genericAcceptedRateLimit, request, reply)) {
        return reply;
      }

      const parsed = channelInboundSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      if (parsed.data.account !== params.data.connectionId) {
        return reply.code(400).send({ error: "Inbound account must match integration connection" });
      }

      const inboundAccess = evaluateChannelInboundAccess({
        config: connection.config,
        actorId: parsed.data.actorId,
      });
      if (inboundAccess.legacyWarning) {
        fastify.services.integrationWebhooks.recordDevDiagnostic?.({
          level: "warn",
          category: "channels",
          event: "channel.inbound_access_legacy_open",
          message: inboundAccess.legacyWarning,
          context: {
            channel: params.data.channel,
            connectionId: params.data.connectionId,
            actorId: parsed.data.actorId,
            eventType: "generic-channel",
            mode: inboundAccess.mode,
            reason: inboundAccess.reason,
          },
        });
      }
      if (!inboundAccess.allowed) {
        const hasEmptyAllowlist = inboundAccess.reason === "allowlist_empty";
        const hasInvalidConfig = inboundAccess.reason === "invalid_config";
        fastify.services.integrationWebhooks.recordDevDiagnostic?.({
          level: "warn",
          category: "channels",
          event: hasEmptyAllowlist
            ? "channel.inbound_allowlist_empty"
            : hasInvalidConfig
              ? "channel.inbound_access_invalid_config"
              : "channel.sender_not_allowlisted",
          message: hasEmptyAllowlist
            ? "Dropped an inbound generic channel message because allowlist mode is enabled with no permitted senders."
            : hasInvalidConfig
              ? "Dropped an inbound generic channel message because its inbound access config is malformed."
              : "Dropped an inbound generic channel message because the sender is not on the connection allowlist.",
          context: {
            channel: params.data.channel,
            connectionId: params.data.connectionId,
            actorId: parsed.data.actorId,
            eventType: "generic-channel",
            mode: inboundAccess.mode,
            reason: inboundAccess.reason,
            allowedSenderCount: inboundAccess.allowedSenders.length,
          },
        });
        return reply.send({
          accepted: true,
          ignored: true,
          reason: inboundAccess.reason,
          inboundAccess: {
            mode: inboundAccess.mode,
            reason: inboundAccess.reason,
          },
        });
      }

      try {
        const acceptInbound = fastify.services.integrationWebhooks.acceptInboundChannelEvent;
        if (!acceptInbound) {
          throw new Error("Durable inbound channel acceptance is unavailable.");
        }
        const result = await acceptInbound({
          channel: params.data.channel,
          connectionId: params.data.connectionId,
          idempotencyKey: deriveGenericChannelInboundIdempotencyKey(
            params.data.connectionId,
            params.data.channel,
            parsed.data.eventId,
          ),
          eventType: "generic-channel",
          bindingTarget: parsed.data.room ?? parsed.data.peer,
          dispatchKind: "record_only",
          message: {
            ...parsed.data,
            account: params.data.connectionId,
          },
        });
        return reply.send(result);
      } catch (error) {
        request.log.error(
          {
            channel: params.data.channel,
            connectionId: params.data.connectionId,
            eventId: parsed.data.eventId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Generic channel inbound webhook was not acknowledged because durable acceptance failed.",
        );
        return reply.code(503).send({ error: "Durable inbound channel acceptance failed" });
      }
    },
  );

  registerTelegramWebhookRoutes(fastify);
  registerWhatsAppWebhookRoutes(fastify);
  registerSlackWebhookRoutes(fastify);
  registerLineWebhookRoutes(fastify);
  registerNextcloudTalkWebhookRoutes(fastify);
};
