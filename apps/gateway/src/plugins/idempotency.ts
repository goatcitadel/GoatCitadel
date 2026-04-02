import fp from "fastify-plugin";
import { isLineWebhookPath } from "../services/line-webhook.js";
import { isNextcloudTalkWebhookPath } from "../services/nextcloud-talk-webhook.js";
import { isSlackWebhookPath } from "../services/slack-webhook.js";
import { isTelegramWebhookPath } from "../services/telegram-webhook.js";
import { isWhatsAppWebhookPath } from "../services/whatsapp-webhook.js";

export const idempotencyHeaderPlugin = fp(async (fastify) => {
  fastify.decorateRequest("idempotencyKey", "");

  fastify.addHook("preHandler", async (request, reply) => {
    if (
      isLineWebhookPath(request.url)
      || isNextcloudTalkWebhookPath(request.url)
      || isSlackWebhookPath(request.url)
      || isTelegramWebhookPath(request.url)
      || isWhatsAppWebhookPath(request.url)
    ) {
      return;
    }
    if (request.method === "POST" || request.method === "PATCH" || request.method === "PUT" || request.method === "DELETE") {
      const key = request.headers["idempotency-key"];
      if (!key || Array.isArray(key) || !key.trim()) {
        await reply.code(400).send({
          error: "Idempotency-Key header is required for mutating requests",
        });
        return;
      }

      (request as typeof request & { idempotencyKey: string }).idempotencyKey = key;
    }
  });
});
