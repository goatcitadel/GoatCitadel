import type { FastifyInstance } from "fastify";
import {
  deriveNextcloudTalkWebhookIdempotencyKey,
  normalizeNextcloudTalkWebhookPayload,
  verifyNextcloudTalkSignature,
} from "../services/nextcloud-talk-webhook.js";
import { createWebhookRouteOptions, resolveNextcloudTalkSecret } from "./integration-webhooks-shared.js";
import {
  createIgnoredWebhookReply,
  createWebhookHandler,
  dispatchInboundWebhookMessage,
  readHeaderValue,
} from "./webhook-handler-factory.js";

type NextcloudTalkDispatchPayload = Exclude<
  ReturnType<typeof normalizeNextcloudTalkWebhookPayload>,
  { kind: "ignore" } | { kind: "activity" }
>;

export function registerNextcloudTalkWebhookRoutes(fastify: FastifyInstance): void {
  fastify.post(
    "/api/v1/integrations/connections/:connectionId/nextcloud-talk/webhook",
    createWebhookRouteOptions("nextcloudTalkRawBody"),
    createWebhookHandler<NextcloudTalkDispatchPayload>(fastify, {
      source: "nextcloud-talk",
      connectorKey: "nextcloud-talk",
      connectorLabel: "Nextcloud Talk",
      rawBodyKey: "nextcloudTalkRawBody",
      missingRawBodyError: "Missing Nextcloud Talk raw request body",
      verifySignature: ({ request, connection, rawBody }) => {
        const secret = resolveNextcloudTalkSecret(connection.config);
        if (!secret) {
          return {
            ok: false as const,
            statusCode: 400,
            error: "Nextcloud Talk connection is missing a token/secret",
          };
        }

        const randomHeader = readHeaderValue(request.headers["x-nextcloud-talk-random"]);
        const signatureHeader = readHeaderValue(request.headers["x-nextcloud-talk-signature"]);
        if (!verifyNextcloudTalkSignature(randomHeader, signatureHeader, rawBody, secret)) {
          return {
            ok: false as const,
            statusCode: 401,
            error: "Invalid Nextcloud Talk webhook signature",
            logReason: "signature_mismatch",
          };
        }
        return { ok: true as const };
      },
      parsePayload: ({ connectionId, request }) => {
        const backendHeader = readHeaderValue(request.headers["x-nextcloud-talk-backend"]);
        const normalized = normalizeNextcloudTalkWebhookPayload({
          connectionId,
          payload: request.body,
          backendUrl: backendHeader,
        });
        if (normalized.kind === "ignore") {
          return {
            kind: "reply" as const,
            payload: createIgnoredWebhookReply(normalized.eventType, normalized.reason),
          };
        }
        if (normalized.kind === "activity") {
          fastify.services.integrationWebhooks.recordDevDiagnostic({
            level: "info",
            category: "channels",
            event: "nextcloud-talk.webhook.activity",
            message: `Processed Nextcloud Talk ${normalized.eventType} webhook`,
            context: {
              connectionId,
              eventType: normalized.eventType,
              room: normalized.room,
              actorId: normalized.actorId,
              backendUrl: normalized.backendUrl,
              ...normalized.metadata,
            },
          });
          return {
            kind: "reply" as const,
            payload: {
              accepted: true,
              handled: true,
              eventType: normalized.eventType,
            },
          };
        }
        return {
          kind: "dispatch" as const,
          parsed: normalized,
        };
      },
      dispatch: async ({ connectionId, rawBody, parsed }) =>
        dispatchInboundWebhookMessage(fastify.services.integrationWebhooks, {
          channel: "nextcloud-talk",
          connectionId,
          idempotencyKey: deriveNextcloudTalkWebhookIdempotencyKey(connectionId, rawBody),
          eventType: parsed.eventType,
          bindingTarget: parsed.room,
          message: {
            eventId: parsed.eventId,
            account: parsed.account,
            room: parsed.room,
            actorId: parsed.actorId,
            actorType: parsed.actorType,
            displayName: parsed.displayName,
            content: parsed.content,
            metadata: {
              backendUrl: parsed.backendUrl,
              ...parsed.metadata,
            },
          },
        }),
    }),
  );
}
