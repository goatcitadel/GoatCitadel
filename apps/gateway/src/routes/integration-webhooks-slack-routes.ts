import type { FastifyInstance } from "fastify";
import { dispatchSlackEvent, type SlackDispatchPayload } from "../services/slack-event-processor.js";
import {
  normalizeSlackWebhookPayload,
  verifySlackWebhookConnectionBinding,
  verifySlackSignature,
} from "../services/slack-webhook.js";
import {
  createWebhookRouteOptions,
  createWebhookSecretResolver,
  readConfigSecret,
  readWebhookVoiceInboundEnabled,
} from "./integration-webhooks-shared.js";
import { asString } from "../services/webhook-json-helpers.js";
import { createIgnoredWebhookReply, createWebhookHandler, readHeaderValue } from "./webhook-handler-factory.js";

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
      verifySignature: ({ request, connection, connectionId, rawBody }) => {
        const signingSecret = readConfigSecret(
          connection.config,
          "signingSecret",
          "signingSecretEnv",
          createWebhookSecretResolver(fastify, connectionId),
        );
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
      parsePayload: async ({ connectionId, connection, request }) => {
        const normalized = normalizeSlackWebhookPayload({
          connectionId,
          payload: request.body,
          botUserId: asString(connection.config.slackBotUserId),
          appId: asString(connection.config.slackAppId),
          voiceInboundEnabled: await readWebhookVoiceInboundEnabled(fastify, request, "slack"),
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
      dispatch: ({ connectionId, connection, request, rawBody, parsed }) =>
        dispatchSlackEvent(
          { webhooks: fastify.services.integrationWebhooks },
          // The URL's connection id stays authoritative for the webhook, as before.
          { connection: { ...connection, connectionId }, parsed, payload: request.body, rawBody },
        ),
    }),
  );
}
