import type { FastifyInstance } from "fastify";
import {
  deriveSlackWebhookIdempotencyKey,
  normalizeSlackWebhookPayload,
  verifySlackSignature,
} from "../services/slack-webhook.js";
import { readConfigSecret } from "./integration-webhooks-shared.js";
import { asString } from "../services/webhook-json-helpers.js";
import {
  CHANNEL_INBOUND_MAX_BYTES,
  createIgnoredWebhookReply,
  createWebhookPreParsing,
  createWebhookHandler,
  dispatchInboundWebhookMessage,
  readHeaderValue,
} from "./webhook-handler-factory.js";

type SlackDispatchPayload = Exclude<
  ReturnType<typeof normalizeSlackWebhookPayload>,
  { kind: "ignore" } | { kind: "challenge" }
>;

export function registerSlackWebhookRoutes(fastify: FastifyInstance): void {
  fastify.post(
    "/api/v1/integrations/connections/:connectionId/slack/webhook",
    {
      bodyLimit: CHANNEL_INBOUND_MAX_BYTES,
      preParsing: createWebhookPreParsing("slackRawBody"),
      config: {
        rateLimit: {
          max: 500,
        },
      },
    },
    createWebhookHandler<SlackDispatchPayload>(fastify, {
      source: "slack",
      connectorKey: "slack",
      connectorLabel: "Slack",
      rawBodyKey: "slackRawBody",
      missingRawBodyError: "Missing Slack raw request body",
      verifySignature: ({ request, connection, rawBody }) => {
        const signingSecret = readConfigSecret(connection.config, "signingSecret", "signingSecretEnv");
        if (!signingSecret) {
          return { ok: false as const, statusCode: 400, error: "Slack connection is missing a signing secret" };
        }

        const timestampHeader = readHeaderValue(request.headers["x-slack-request-timestamp"]);
        const signatureHeader = readHeaderValue(request.headers["x-slack-signature"]);
        if (
          !verifySlackSignature({
            timestamp: timestampHeader,
            signature: signatureHeader,
            rawBody,
            secret: signingSecret,
          })
        ) {
          return {
            ok: false as const,
            statusCode: 401,
            error: "Invalid Slack webhook signature",
            logReason: "signature_mismatch",
          };
        }
        return { ok: true as const };
      },
      parsePayload: ({ connectionId, connection, request }) => {
        const normalized = normalizeSlackWebhookPayload({
          connectionId,
          payload: request.body,
          botUserId: asString(connection.config.slackBotUserId),
          appId: asString(connection.config.slackAppId),
        });
        if (normalized.kind === "challenge") {
          return {
            kind: "reply" as const,
            payload: { challenge: normalized.challenge },
          };
        }
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
      dispatch: async ({ connectionId, request, rawBody, parsed }) =>
        dispatchInboundWebhookMessage(fastify.services.integrationWebhooks, {
          channel: "slack",
          connectionId,
          idempotencyKey: deriveSlackWebhookIdempotencyKey(connectionId, request.body, rawBody),
          eventType: parsed.eventType,
          bindingTarget: parsed.room ?? parsed.peer,
          message: {
            eventId: parsed.eventId,
            account: parsed.account,
            peer: parsed.peer,
            room: parsed.room,
            threadId: parsed.threadId,
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
