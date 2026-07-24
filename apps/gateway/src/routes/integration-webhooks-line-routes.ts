import type { FastifyInstance } from "fastify";
import {
  deriveLineWebhookEventIdempotencyKey,
  normalizeLineWebhookPayloads,
  verifyLineWebhookSignature,
} from "../services/line-webhook.js";
import { createWebhookRouteOptions, resolveLineChannelSecret } from "./integration-webhooks-shared.js";
import {
  createIgnoredWebhookReply,
  createWebhookHandler,
  dispatchInboundWebhookBatch,
  dispatchInboundWebhookMessage,
  readHeaderValue,
} from "./webhook-handler-factory.js";

type LineDispatchPayload = Array<Exclude<ReturnType<typeof normalizeLineWebhookPayloads>[number], { kind: "ignore" }>>;

export function registerLineWebhookRoutes(fastify: FastifyInstance): void {
  const routeOptions = createWebhookRouteOptions("lineRawBody");
  fastify.post(
    "/api/v1/integrations/connections/:connectionId/line/webhook",
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
    createWebhookHandler<LineDispatchPayload>(fastify, {
      source: "line",
      connectorKey: "line",
      connectorLabel: "LINE",
      rawBodyKey: "lineRawBody",
      missingRawBodyError: "Missing LINE raw request body",
      verifySignature: ({ request, connection, rawBody }) => {
        const channelSecret = resolveLineChannelSecret(connection.config);
        if (!channelSecret) {
          return { ok: false as const, statusCode: 400, error: "LINE connection is missing a channel secret" };
        }

        const signatureHeader = readHeaderValue(request.headers["x-line-signature"]);
        if (!verifyLineWebhookSignature(signatureHeader, rawBody, channelSecret)) {
          return {
            ok: false as const,
            statusCode: 401,
            error: "Invalid LINE webhook signature",
            logReason: "signature_mismatch",
          };
        }
        return { ok: true as const };
      },
      parsePayload: ({ connectionId, request }) => {
        const normalized = normalizeLineWebhookPayloads({
          connectionId,
          payload: request.body,
        });
        const messages = normalized.filter((event) => event.kind === "message");
        if (messages.length === 0) {
          const ignored = normalized.find((event) => event.kind === "ignore");
          return {
            kind: "reply" as const,
            payload: createIgnoredWebhookReply(ignored?.eventType, ignored?.reason ?? "No supported LINE events"),
          };
        }
        return {
          kind: "dispatch" as const,
          parsed: messages,
        };
      },
      dispatch: async ({ connectionId, connection, parsed }) => {
        const inputs = parsed.map((event) => ({
          channel: "line",
          connectionId,
          idempotencyKey: deriveLineWebhookEventIdempotencyKey(connectionId, event),
          eventType: event.eventType,
          bindingTarget: event.room ?? event.peer,
          inboundAccessConfig: connection.config,
          message: {
            eventId: event.eventId,
            account: event.account,
            peer: event.peer,
            room: event.room,
            actorId: event.actorId,
            actorType: event.actorType,
            content: event.content,
            metadata: event.metadata,
          },
          responseOptions: {
            deliveryReplyToMessageId: event.deliveryReplyToMessageId,
          },
          dispatchKind: "agent_turn" as const,
        }));
        if (inputs.length === 1) {
          const { dispatchKind: _dispatchKind, ...input } = inputs[0]!;
          return dispatchInboundWebhookMessage(fastify.services.integrationWebhooks, input);
        }
        return dispatchInboundWebhookBatch(fastify.services.integrationWebhooks, inputs);
      },
    }),
  );
}
