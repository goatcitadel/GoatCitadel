import type { FastifyInstance } from "fastify";
import type { PersonalityCatalogResponse } from "@goatcitadel/contracts";
import { readTelegramReceiveMode } from "@goatcitadel/gateway-core";
import { listPersonalityPresets } from "../services/channel-personalities.js";
import { dispatchTelegramUpdate, type TelegramDispatchPayload } from "../services/telegram-update-processor.js";
import { normalizeTelegramWebhookPayload, verifyTelegramWebhookSecretToken } from "../services/telegram-webhook.js";
import {
  createWebhookRouteOptions,
  createWebhookSecretResolver,
  readWebhookVoiceInboundEnabled,
  resolveTelegramWebhookSecret,
} from "./integration-webhooks-shared.js";
import { createIgnoredWebhookReply, createWebhookHandler, readHeaderValue } from "./webhook-handler-factory.js";

export function registerTelegramWebhookRoutes(fastify: FastifyInstance): void {
  const routeOptions = createWebhookRouteOptions("telegramRawBody");
  fastify.post(
    "/api/v1/integrations/connections/:connectionId/telegram/webhook",
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
    createWebhookHandler<TelegramDispatchPayload>(fastify, {
      source: "telegram",
      connectorKey: "telegram",
      connectorLabel: "Telegram",
      rawBodyKey: "telegramRawBody",
      missingRawBodyError: "Missing Telegram raw request body",
      verifySignature: ({ request, connection, connectionId }) => {
        const webhookSecret = resolveTelegramWebhookSecret(
          connection.config,
          createWebhookSecretResolver(fastify, connectionId),
        );
        if (!webhookSecret) {
          return { ok: false as const, statusCode: 400, error: "Telegram connection is missing a webhook secret" };
        }
        const secretTokenHeader = readHeaderValue(request.headers["x-telegram-bot-api-secret-token"]);
        if (!verifyTelegramWebhookSecretToken(secretTokenHeader, webhookSecret)) {
          return { ok: false as const, statusCode: 401, error: "Invalid Telegram webhook secret token" };
        }
        return { ok: true as const };
      },
      parsePayload: async ({ connectionId, connection, request }) => {
        // A connection that polls for messages, or receives none, must not act on a webhook delivery even
        // when an old webhook secret is still saved. This runs after the secret-token check, so only a
        // correctly signed caller learns the mode. The 200 reply makes Telegram stop retrying.
        const receiveMode = readTelegramReceiveMode(connection.config);
        if (receiveMode) {
          return {
            kind: "reply" as const,
            payload: createIgnoredWebhookReply(undefined, `receive_mode_${receiveMode}`),
          };
        }
        const normalized = normalizeTelegramWebhookPayload({
          connectionId,
          payload: request.body,
          voiceInboundEnabled: await readWebhookVoiceInboundEnabled(fastify, request, "telegram"),
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
      dispatch: ({ connectionId, connection, request, rawBody, parsed }) =>
        dispatchTelegramUpdate(
          {
            webhooks: fastify.services.integrationWebhooks,
            readPersonalityCatalog: () => resolveRoutePersonalityCatalog(fastify),
          },
          // The URL's connection id stays authoritative for the webhook, as before.
          { connection: { ...connection, connectionId }, parsed, payload: request.body, rawBody },
        ),
    }),
  );
}

async function resolveRoutePersonalityCatalog(
  fastify: FastifyInstance,
): Promise<Omit<PersonalityCatalogResponse, "revision">> {
  const settings = (
    fastify.services as {
      settings?: { getPersonalityCatalog?: () => PersonalityCatalogResponse | Promise<PersonalityCatalogResponse> };
    }
  ).settings;
  return (
    (await settings?.getPersonalityCatalog?.()) ?? { items: listPersonalityPresets(), defaultPersonalityId: "default" }
  );
}
