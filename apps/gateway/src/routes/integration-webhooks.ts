import type { FastifyPluginAsync } from "fastify";
import { registerLineWebhookRoutes } from "./integration-webhooks-line-routes.js";
import { registerNextcloudTalkWebhookRoutes } from "./integration-webhooks-nextcloud-talk-routes.js";
import { registerSlackWebhookRoutes } from "./integration-webhooks-slack-routes.js";
import { registerTelegramWebhookRoutes } from "./integration-webhooks-telegram-routes.js";
import { registerWhatsAppWebhookRoutes } from "./integration-webhooks-whatsapp-routes.js";
import { createWebhookRouteOptions } from "./integration-webhooks-shared.js";
import { channelInboundSchema, channelParamsSchema } from "./integration-webhook-schemas.js";
import { CHANNEL_INBOUND_MAX_BYTES, parseContentLength } from "./webhook-handler-factory.js";

export const integrationWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/api/v1/channels/:channel/inbound", createWebhookRouteOptions(), async (request, reply) => {
    const contentLength = parseContentLength(request.headers["content-length"]);
    if (contentLength !== undefined && contentLength > CHANNEL_INBOUND_MAX_BYTES) {
      return reply.code(413).send({
        error: `Inbound channel payload too large. Max ${CHANNEL_INBOUND_MAX_BYTES} bytes.`,
      });
    }

    const params = channelParamsSchema.safeParse(request.params);
    const parsed = channelInboundSchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: parsed.success ? undefined : parsed.error.flatten(),
        },
      });
    }

    try {
      const result = await fastify.services.integrationWebhooks.ingestChannelMessage(
        params.data.channel,
        request.idempotencyKey,
        parsed.data,
      );
      return reply.send(result);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  registerTelegramWebhookRoutes(fastify);
  registerWhatsAppWebhookRoutes(fastify);
  registerSlackWebhookRoutes(fastify);
  registerLineWebhookRoutes(fastify);
  registerNextcloudTalkWebhookRoutes(fastify);
};
