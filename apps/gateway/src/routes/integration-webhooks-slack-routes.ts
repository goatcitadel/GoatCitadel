import type { FastifyInstance } from "fastify";
import {
  deriveSlackWebhookIdempotencyKey,
  normalizeSlackWebhookPayload,
  verifySlackWebhookConnectionBinding,
  verifySlackSignature,
} from "../services/slack-webhook.js";
import { createWebhookRouteOptions, readConfigSecret } from "./integration-webhooks-shared.js";
import { asString } from "../services/webhook-json-helpers.js";
import {
  createIgnoredWebhookReply,
  createWebhookHandler,
  dispatchInboundWebhookMessage,
  readHeaderValue,
} from "./webhook-handler-factory.js";

type SlackDispatchPayload = Exclude<
  ReturnType<typeof normalizeSlackWebhookPayload>,
  { kind: "ignore" } | { kind: "challenge" }
>;

export function registerSlackWebhookRoutes(fastify: FastifyInstance): void {
  const routeOptions = createWebhookRouteOptions("slackRawBody");
  fastify.post(
    "/api/v1/integrations/connections/:connectionId/slack/webhook",
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
        const binding = verifySlackWebhookConnectionBinding({
          payload: request.body,
          expectedTeamId: asString(connection.config.slackTeamId),
          expectedAppId: asString(connection.config.slackAppId),
        });
        if (!binding.ok) {
          const missingConnectionIdentity = binding.reason === "missing_connection_identity";
          return {
            ok: false as const,
            statusCode: missingConnectionIdentity ? 400 : 403,
            error: missingConnectionIdentity
              ? "Slack connection is missing its expected team or app identity"
              : "Slack webhook does not match this connection",
            logReason: `connection_binding_${binding.reason}`,
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
      dispatch: async ({ connectionId, connection, request, rawBody, parsed }) =>
        dispatchInboundWebhookMessage(fastify.services.integrationWebhooks, {
          channel: "slack",
          connectionId,
          idempotencyKey: deriveSlackWebhookIdempotencyKey(connectionId, request.body, rawBody),
          eventType: parsed.eventType,
          bindingTarget: parsed.room ?? parsed.peer,
          inboundAccessConfig: connection.config,
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
