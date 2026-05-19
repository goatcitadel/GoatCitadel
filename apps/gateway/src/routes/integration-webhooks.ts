import type { FastifyPluginAsync } from "fastify";
import { registerLineWebhookRoutes } from "./integration-webhooks-line-routes.js";
import { registerNextcloudTalkWebhookRoutes } from "./integration-webhooks-nextcloud-talk-routes.js";
import { registerSlackWebhookRoutes } from "./integration-webhooks-slack-routes.js";
import { registerTelegramWebhookRoutes } from "./integration-webhooks-telegram-routes.js";
import { registerWhatsAppWebhookRoutes } from "./integration-webhooks-whatsapp-routes.js";
import { createWebhookRouteOptions, resolveGenericChannelInboundSecret } from "./integration-webhooks-shared.js";
import { channelConnectionInboundParamsSchema, channelInboundSchema } from "./integration-webhook-schemas.js";
import {
  CHANNEL_INBOUND_MAX_BYTES,
  parseContentLength,
  readHeaderValue,
  validateWebhookHostHeader,
} from "./webhook-handler-factory.js";
import {
  deriveGenericChannelInboundIdempotencyKey,
  verifyGenericChannelInboundSignature,
} from "../services/generic-channel-webhook.js";

export const integrationWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/api/v1/integrations/connections/:connectionId/:channel/inbound",
    createWebhookRouteOptions("genericChannelRawBody"),
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
        connection = fastify.services.integrationWebhooks.getIntegrationConnection(params.data.connectionId);
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }

      if (connection.key !== params.data.channel) {
        return reply.code(400).send({ error: "Integration connection does not match inbound channel" });
      }
      if (connection.enabled === false || (connection.status !== undefined && connection.status !== "connected")) {
        return reply.code(409).send({ error: "Integration connection is not connected" });
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

      const parsed = channelInboundSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      if (parsed.data.account !== params.data.connectionId) {
        return reply.code(400).send({ error: "Inbound account must match integration connection" });
      }

      try {
        const result = await fastify.services.integrationWebhooks.ingestChannelMessage(
          params.data.channel,
          deriveGenericChannelInboundIdempotencyKey(params.data.connectionId, params.data.channel, parsed.data.eventId),
          {
            ...parsed.data,
            account: params.data.connectionId,
          },
        );
        return reply.send(result);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  registerTelegramWebhookRoutes(fastify);
  registerWhatsAppWebhookRoutes(fastify);
  registerSlackWebhookRoutes(fastify);
  registerLineWebhookRoutes(fastify);
  registerNextcloudTalkWebhookRoutes(fastify);
};
