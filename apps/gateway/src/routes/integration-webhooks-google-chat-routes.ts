import type { FastifyInstance } from "fastify";
import {
  createCachedGoogleChatCertFetcher,
  fetchGoogleChatCertsFromGoogle,
  isGoogleChatAudienceType,
  normalizeGoogleChatEvent,
  verifyGoogleChatBearer,
  type GoogleChatCertFetcher,
} from "../services/google-chat-webhook.js";
import { createWebhookRouteOptions } from "./integration-webhooks-shared.js";
import type { IntegrationConnectionRecord } from "../services/channel-inbound-dispatch.js";
import { createWebhookHandler, dispatchInboundWebhookMessage, readHeaderValue } from "./webhook-handler-factory.js";

type GoogleChatDispatchPayload = Extract<ReturnType<typeof normalizeGoogleChatEvent>, { kind: "message" }>;

/**
 * Google Chat reads a synchronous HTTP response body as a reply message, so
 * every handled outcome answers `{}` (no synchronous reply). The durable worker
 * replies asynchronously through the Chat API in service-account mode.
 */
const EMPTY_CHAT_REPLY = Object.freeze({});
const GOOGLE_CHAT_THREAD_NAME = /^spaces\/[^/]+\/threads\/[^/]+$/;

export function registerGoogleChatWebhookRoutes(
  fastify: FastifyInstance,
  options: { fetchCerts?: GoogleChatCertFetcher } = {},
): void {
  // One certificate cache per gateway registration: never a module global.
  const fetchCerts = createCachedGoogleChatCertFetcher(options.fetchCerts ?? fetchGoogleChatCertsFromGoogle);
  const routeOptions = createWebhookRouteOptions("googleChatRawBody");
  fastify.post(
    "/api/v1/integrations/connections/:connectionId/google-chat/webhook",
    routeOptions,
    createWebhookHandler<GoogleChatDispatchPayload>(fastify, {
      source: "google-chat",
      connectorKey: "google-chat",
      connectorLabel: "Google Chat",
      rawBodyKey: "googleChatRawBody",
      missingRawBodyError: "Missing Google Chat raw request body",
      verifySignature: async ({ request, connection }) => {
        // Mirrors channel-core capability truth: inbound exists only in Chat app (service-account) mode.
        if (
          !readConfigString(connection.config.serviceAccountKeyEnv) &&
          !readConfigString(connection.config.serviceAccountKey)
        ) {
          return {
            ok: false as const,
            statusCode: 400,
            error:
              "Google Chat inbound requires Chat app mode: configure a service-account key (serviceAccountKeyEnv or serviceAccountKey)",
          };
        }
        const audienceType = connection.config.audienceType;
        const audience = readConfigString(connection.config.audience);
        if (!isGoogleChatAudienceType(audienceType) || !audience) {
          return {
            ok: false as const,
            statusCode: 400,
            error: "Google Chat connection is missing its Chat app audienceType/audience configuration",
          };
        }
        let result: Awaited<ReturnType<typeof verifyGoogleChatBearer>>;
        try {
          result = await verifyGoogleChatBearer({
            authorizationHeader: readHeaderValue(request.headers.authorization),
            audienceType,
            audience,
            fetchCerts,
          });
        } catch {
          // Google retries non-2xx deliveries; a transient certificate fetch failure must not drop events.
          return {
            ok: false as const,
            statusCode: 503,
            error: "Google Chat signing certificates are unavailable",
            logReason: "cert_fetch_failed",
          };
        }
        if (!result.ok) {
          return {
            ok: false as const,
            statusCode: 401,
            error: "Invalid Google Chat bearer token",
            logReason: result.reason,
          };
        }
        return { ok: true as const };
      },
      parsePayload: ({ connectionId, request }) => {
        const normalized = normalizeGoogleChatEvent({ connectionId, payload: request.body });
        if (normalized.kind === "ignore") {
          return { kind: "reply" as const, payload: EMPTY_CHAT_REPLY };
        }
        return { kind: "dispatch" as const, parsed: normalized };
      },
      dispatch: async ({ request, reply, connectionId, connection, parsed }) => {
        try {
          await dispatchGoogleChatMessage(connectionId, connection, parsed);
        } catch (error) {
          request.log.error(
            {
              channel: "google-chat",
              connectionId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Google Chat inbound webhook was not acknowledged because durable acceptance failed.",
          );
          // Google retries non-2xx deliveries, so a transient acceptance failure must not drop the event.
          void reply.code(503);
          return { error: "Durable inbound channel acceptance failed" };
        }
        return EMPTY_CHAT_REPLY;
      },
    }),
  );

  async function dispatchGoogleChatMessage(
    connectionId: string,
    connection: IntegrationConnectionRecord,
    parsed: GoogleChatDispatchPayload,
  ): Promise<void> {
    await dispatchInboundWebhookMessage(fastify.services.integrationWebhooks, {
      channel: "google-chat",
      connectionId,
      idempotencyKey: `google-chat:${connectionId}:${parsed.eventId}`,
      eventType: "MESSAGE",
      bindingTarget: parsed.space,
      // Google Chat never had inbound, so legacy-open (open_legacy or unset) must never apply:
      // force allowlist semantics and keep the connection's allowedSenders (empty means deny all).
      inboundAccessConfig: { ...connection.config, inboundAccessMode: "allowlist" },
      acceptedConnectionRevision: connection.revision,
      message: {
        eventId: parsed.eventId,
        account: connectionId,
        room: parsed.space,
        threadId: parsed.threadName,
        actorId: parsed.actorId,
        displayName: parsed.displayName,
        content: parsed.content,
        metadata: parsed.metadata,
      },
      responseOptions: { deliveryReplyToMessageId: googleChatReplyTarget(parsed) },
    });
  }
}

/**
 * The reply target is always a name the Chat API send path accepts: the inbound
 * thread when it is a well-formed thread name, otherwise the inbound message
 * name (the send path resolves its thread before posting).
 */
function googleChatReplyTarget(parsed: GoogleChatDispatchPayload): string {
  return parsed.threadName && GOOGLE_CHAT_THREAD_NAME.test(parsed.threadName) ? parsed.threadName : parsed.eventId;
}

function readConfigString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
