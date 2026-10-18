import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  computeWecomSignature,
  decryptWecomMessage,
  normalizeWecomMessage,
  readWecomXmlFields,
} from "../services/wecom-webhook.js";
import { createWebhookRouteOptions, resolveWecomCallbackSecrets } from "./integration-webhooks-shared.js";
import { timingSafeStringEqual } from "../services/webhook-json-helpers.js";
import type { IntegrationConnectionRecord } from "../services/channel-inbound-dispatch.js";
import { connectionParamsSchema } from "./integration-webhook-schemas.js";
import {
  CHANNEL_INBOUND_MAX_BYTES,
  createWebhookHandler,
  dispatchInboundWebhookMessage,
  readQueryString,
} from "./webhook-handler-factory.js";

type WecomDispatchPayload = Extract<ReturnType<typeof normalizeWecomMessage>, { kind: "message" }>;

/** WeCom treats any 2xx whose body is `success` (or empty) as an acknowledged delivery. */
const WECOM_ACK = "success";

/** The decrypted plaintext of a verified POST, handed from verifySignature to parsePayload. */
const verifiedPlaintext = new WeakMap<object, string>();

type CallbackCredentials = { corpId: string; token: string; encodingAesKey: string };

function readCallbackCredentials(config: Record<string, unknown>): CallbackCredentials | undefined {
  const { corpId, token, encodingAesKey } = resolveWecomCallbackSecrets(config);
  return corpId && token && encodingAesKey ? { corpId, token, encodingAesKey } : undefined;
}

function signatureMatches(
  credentials: CallbackCredentials,
  query: Record<string, unknown>,
  encrypted: string,
): boolean {
  const provided = readQueryString(query, "msg_signature");
  const timestamp = readQueryString(query, "timestamp");
  const nonce = readQueryString(query, "nonce");
  if (!provided || !timestamp || !nonce) {
    return false;
  }
  const expected = computeWecomSignature(credentials.token, timestamp, nonce, encrypted);
  return timingSafeStringEqual(provided.toLowerCase(), expected);
}

export function registerWecomWebhookRoutes(fastify: FastifyInstance): void {
  // WeCom posts XML. The parser is scoped to this plugin so no other route's content negotiation changes;
  // the preParsing hook still captures the raw bytes into wecomRawBody before this parser runs.
  void fastify.register(async (scope) => {
    scope.addContentTypeParser(
      ["text/xml", "application/xml"],
      { parseAs: "string", bodyLimit: CHANNEL_INBOUND_MAX_BYTES },
      (_request, body, done) => done(null, body),
    );
    registerWecomRoutes(scope);
  });
}

function registerWecomRoutes(fastify: FastifyInstance): void {
  const routeOptions = createWebhookRouteOptions("wecomRawBody");

  // URL verification: WeCom sends an encrypted echostr and expects the decrypted plaintext back.
  fastify.get(
    "/api/v1/integrations/connections/:connectionId/wecom/webhook",
    { config: { rateLimit: { max: 500 } } },
    async (request, reply) => {
      const params = connectionParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }

      let connection;
      try {
        connection = await fastify.services.integrationWebhooks.getIntegrationConnection(params.data.connectionId);
      } catch {
        return reply.code(404).send({ error: "Integration connection not found" });
      }
      // A disabled or disconnected connection must not complete a handshake either.
      if (connection.enabled === false || (connection.status !== undefined && connection.status !== "connected")) {
        return reply.code(404).send({ error: "Integration connection not found" });
      }
      if (connection.key !== "wecom") {
        return reply.code(400).send({ error: "Integration connection is not a WeCom connector" });
      }
      const credentials = readCallbackCredentials(connection.config);
      if (!credentials) {
        return reply.code(400).send({ error: "WeCom connection is missing corpId, callbackToken or encodingAesKey" });
      }

      const query = request.query as Record<string, unknown>;
      const echostr = readQueryString(query, "echostr");
      if (!echostr) {
        return reply.code(400).send({ error: "Invalid WeCom webhook verification query" });
      }
      if (!signatureMatches(credentials, query, echostr)) {
        return reply.code(401).send({ error: "Invalid WeCom signature" });
      }
      try {
        const plaintext = decryptWecomMessage({
          encodingAesKey: credentials.encodingAesKey,
          encrypted: echostr,
          expectedReceiveId: credentials.corpId,
        });
        return reply.type("text/plain").send(plaintext);
      } catch {
        request.log.warn(
          { channel: "wecom", connectionId: params.data.connectionId, reason: "echostr_decrypt_failed" },
          "Rejected WeCom URL verification because the echostr could not be decrypted.",
        );
        return reply.code(401).send({ error: "Invalid WeCom payload" });
      }
    },
  );

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/wecom/webhook",
    routeOptions,
    createWebhookHandler<WecomDispatchPayload>(fastify, {
      source: "wecom",
      connectorKey: "wecom",
      connectorLabel: "WeCom",
      rawBodyKey: "wecomRawBody",
      missingRawBodyError: "Missing WeCom raw request body",
      // A disabled connection is acknowledged so WeCom does not keep retrying.
      ignoredReply: () => WECOM_ACK,
      verifySignature: ({ request, connection, rawBody }) => {
        const credentials = readCallbackCredentials(connection.config);
        if (!credentials) {
          return {
            ok: false as const,
            statusCode: 400,
            error: "WeCom connection is missing corpId, callbackToken or encodingAesKey",
          };
        }
        let encrypted: string | undefined;
        try {
          encrypted = readWecomXmlFields(rawBody.toString("utf8"), ["Encrypt"]).Encrypt?.trim();
        } catch {
          return { ok: false as const, statusCode: 400, error: "Malformed WeCom request body" };
        }
        if (!encrypted) {
          return { ok: false as const, statusCode: 400, error: "Malformed WeCom request body" };
        }
        if (!signatureMatches(credentials, request.query as Record<string, unknown>, encrypted)) {
          return {
            ok: false as const,
            statusCode: 401,
            error: "Invalid WeCom signature",
            logReason: "invalid_signature",
          };
        }
        try {
          verifiedPlaintext.set(
            request,
            decryptWecomMessage({
              encodingAesKey: credentials.encodingAesKey,
              encrypted,
              expectedReceiveId: credentials.corpId,
            }),
          );
        } catch {
          // Covers a foreign CorpID, bad padding and a malformed key alike; the cause is never echoed.
          return {
            ok: false as const,
            statusCode: 401,
            error: "Invalid WeCom payload",
            logReason: "decrypt_failed",
          };
        }
        return { ok: true as const };
      },
      parsePayload: ({ request, connectionId, reply }) => {
        const xml = verifiedPlaintext.get(request as FastifyRequest);
        if (xml === undefined) {
          void reply.code(400);
          return { kind: "reply" as const, payload: { error: "Malformed WeCom request body" } };
        }
        let normalized: ReturnType<typeof normalizeWecomMessage>;
        try {
          normalized = normalizeWecomMessage({ connectionId, xml });
        } catch {
          // The envelope signature and CorpID already verified, so this is a genuine WeCom event whose inner XML
          // this flat parser cannot read (nested ScanCodeInfo, PicList/item, ...). A 400 would make WeCom retry
          // it three times, so ack it and leave a content-free diagnostic.
          fastify.services.integrationWebhooks.recordDevDiagnostic?.({
            level: "warn",
            category: "channels",
            event: "channel.wecom_unparsed_event",
            message:
              "A verified WeCom message had XML this adapter does not parse and was acknowledged without dispatch.",
            context: { channel: "wecom", connectionId },
          });
          return { kind: "reply" as const, payload: WECOM_ACK };
        }
        if (normalized.kind === "ignore") {
          if (normalized.reason === "missing_msg_id") {
            fastify.services.integrationWebhooks.recordDevDiagnostic?.({
              level: "warn",
              category: "channels",
              event: "channel.wecom_missing_msg_id",
              message: "A WeCom text message had no MsgId and was acknowledged without dispatch.",
              context: { channel: "wecom", connectionId },
            });
          }
          return { kind: "reply" as const, payload: WECOM_ACK };
        }
        return { kind: "dispatch" as const, parsed: normalized };
      },
      dispatch: async ({ request, reply, connectionId, connection, parsed }) => {
        try {
          await dispatchWecomMessage(connectionId, connection, parsed);
        } catch (error) {
          request.log.error(
            {
              channel: "wecom",
              connectionId,
              error: error instanceof Error ? error.message : String(error),
            },
            "WeCom inbound webhook was not acknowledged because durable acceptance failed.",
          );
          // WeCom retries non-2xx deliveries, so a transient acceptance failure must not drop the event.
          void reply.code(503);
          return { error: "Durable inbound channel acceptance failed" };
        }
        return WECOM_ACK;
      },
    }),
  );

  async function dispatchWecomMessage(
    connectionId: string,
    connection: IntegrationConnectionRecord,
    parsed: WecomDispatchPayload,
  ): Promise<void> {
    const target = `user:${parsed.actorId}`;
    await dispatchInboundWebhookMessage(fastify.services.integrationWebhooks, {
      channel: "wecom",
      connectionId,
      idempotencyKey: `wecom:${connectionId}:${parsed.eventId}`,
      eventType: "wecom.message",
      bindingTarget: target,
      // WeCom never had inbound, so legacy-open (open_legacy or unset) must never apply:
      // force allowlist semantics and keep the connection's allowedSenders (empty means deny all).
      inboundAccessConfig: { ...connection.config, inboundAccessMode: "allowlist" },
      acceptedConnectionRevision: connection.revision,
      message: {
        eventId: parsed.eventId,
        account: connectionId,
        room: target,
        actorId: parsed.actorId,
        content: parsed.content,
        metadata: parsed.metadata,
      },
    });
  }
}
