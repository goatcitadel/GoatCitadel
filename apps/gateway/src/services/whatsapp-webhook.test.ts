import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerWhatsAppWebhookRoutes } from "../routes/integration-webhooks-whatsapp-routes.js";
import { CHANNEL_INBOUND_MAX_BYTES } from "../routes/webhook-handler-factory.js";
import {
  buildWhatsAppWebhookSignature,
  deriveWhatsAppWebhookIdempotencyKey,
  isWhatsAppWebhookPath,
  normalizeWhatsAppWebhookPayload,
  verifyWhatsAppWebhookSignature,
} from "./whatsapp-webhook.js";

describe("whatsapp webhook helpers", () => {
  it("matches the expected webhook path", () => {
    expect(isWhatsAppWebhookPath("/api/v1/integrations/connections/123/whatsapp/webhook")).toBe(true);
    expect(isWhatsAppWebhookPath("/api/v1/integrations/connections/123/slack/webhook")).toBe(false);
  });

  it("signs and verifies raw webhook payloads", () => {
    const rawBody = Buffer.from('{"object":"whatsapp_business_account"}', "utf8");
    const signature = buildWhatsAppWebhookSignature(rawBody, "whatsapp-app-secret");

    expect(verifyWhatsAppWebhookSignature(signature, rawBody, "whatsapp-app-secret")).toBe(true);
    expect(verifyWhatsAppWebhookSignature("sha256=deadbeef", rawBody, "whatsapp-app-secret")).toBe(false);
    expect(verifyWhatsAppWebhookSignature(undefined, rawBody, "whatsapp-app-secret")).toBe(false);
    expect(verifyWhatsAppWebhookSignature(signature.toUpperCase(), rawBody, "whatsapp-app-secret")).toBe(true);
  });

  it("normalizes inbound text messages", () => {
    const normalized = normalizeWhatsAppWebhookPayload({
      connectionId: "conn-whatsapp",
      payload: {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: {
                  metadata: {
                    phone_number_id: "123456789012345",
                    display_phone_number: "+15551234567",
                  },
                  contacts: [
                    {
                      wa_id: "15558675309",
                      profile: {
                        name: "Ada Lovelace",
                      },
                    },
                  ],
                  messages: [
                    {
                      from: "15558675309",
                      id: "wamid.HBgLNDU2",
                      timestamp: "1712182068",
                      type: "text",
                      text: {
                        body: "Need an operator check-in",
                      },
                      context: {
                        id: "wamid.context.1",
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });

    expect(normalized).toEqual({
      kind: "message",
      eventType: "text",
      eventId: "wamid.HBgLNDU2",
      account: "conn-whatsapp",
      actorId: "15558675309",
      actorType: "user",
      displayName: "Ada Lovelace",
      content: "Need an operator check-in",
      peer: "15558675309",
      deliveryReplyToMessageId: "wamid.HBgLNDU2",
      metadata: {
        contactWaId: "15558675309",
        displayPhoneNumber: "+15551234567",
        phoneNumberId: "123456789012345",
        replyToMessageId: "wamid.context.1",
        timestamp: "1712182068",
      },
    });
  });

  it("ignores non-message status payloads", () => {
    const normalized = normalizeWhatsAppWebhookPayload({
      connectionId: "conn-whatsapp",
      payload: {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: {
                  statuses: [
                    {
                      id: "wamid.HBgLNDU2",
                      status: "delivered",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });

    expect(normalized).toEqual({
      kind: "ignore",
      eventType: "status",
      reason: "Ignoring WhatsApp delivery status event",
    });
  });

  it("renders supported non-text message content and fallback metadata", () => {
    const base = (message: Record<string, unknown>) => ({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ profile: {}, wa_id: "15558675309" }],
                metadata: {},
                messages: [
                  {
                    from: "15558675309",
                    id: `wamid.${message.type as string}`,
                    timestamp: "1712182068",
                    ...message,
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(
      normalizeWhatsAppWebhookPayload({
        connectionId: "conn-whatsapp",
        payload: base({ type: "image", image: { caption: "diagram" } }),
      }),
    ).toEqual(expect.objectContaining({ kind: "message", content: "diagram", eventType: "image" }));
    expect(
      normalizeWhatsAppWebhookPayload({
        connectionId: "conn-whatsapp",
        payload: base({ type: "document", document: {} }),
      }),
    ).toEqual(expect.objectContaining({ kind: "message", content: "[whatsapp document]" }));
    expect(
      normalizeWhatsAppWebhookPayload({
        connectionId: "conn-whatsapp",
        payload: base({ type: "audio" }),
      }),
    ).toEqual(expect.objectContaining({ kind: "message", content: "[whatsapp audio]" }));
    expect(
      normalizeWhatsAppWebhookPayload({
        connectionId: "conn-whatsapp",
        payload: base({ type: "sticker" }),
      }),
    ).toEqual(expect.objectContaining({ kind: "message", content: "[whatsapp sticker]" }));
    expect(
      normalizeWhatsAppWebhookPayload({
        connectionId: "conn-whatsapp",
        payload: base({ type: "reaction", reaction: { emoji: "" } }),
      }),
    ).toEqual(expect.objectContaining({ kind: "message", content: "[whatsapp reaction]" }));
    expect(
      normalizeWhatsAppWebhookPayload({
        connectionId: "conn-whatsapp",
        payload: base({ type: "reaction", reaction: { emoji: "+1" } }),
      }),
    ).toEqual(expect.objectContaining({ kind: "message", content: "Reaction: +1" }));
    expect(
      normalizeWhatsAppWebhookPayload({
        connectionId: "conn-whatsapp",
        payload: base({ type: "location", location: { latitude: 47.61, longitude: -122.33 } }),
      }),
    ).toEqual(expect.objectContaining({ kind: "message", content: "Location: 47.61,-122.33" }));
    expect(
      normalizeWhatsAppWebhookPayload({
        connectionId: "conn-whatsapp",
        payload: base({ type: "location", location: {} }),
      }),
    ).toEqual(expect.objectContaining({ kind: "message", content: "[whatsapp location]" }));
  });

  it("ignores unsupported or incomplete WhatsApp payloads", () => {
    expect(
      normalizeWhatsAppWebhookPayload({
        connectionId: "conn-whatsapp",
        payload: { object: "page" },
      }),
    ).toEqual({
      kind: "ignore",
      reason: "Unsupported WhatsApp webhook object",
    });
    expect(
      normalizeWhatsAppWebhookPayload({
        connectionId: "conn-whatsapp",
        payload: { object: "whatsapp_business_account", entry: [] },
      }),
    ).toEqual({
      kind: "ignore",
      reason: "No WhatsApp message payload was present",
    });
    expect(
      normalizeWhatsAppWebhookPayload({
        connectionId: "conn-whatsapp",
        payload: {
          object: "whatsapp_business_account",
          entry: [{ changes: [{ value: { messages: [{ id: "wamid.missing", type: "unsupported" }] } }] }],
        },
      }),
    ).toEqual({
      kind: "ignore",
      eventType: "unsupported",
      reason: "Missing WhatsApp actor, message id, or content",
    });
  });

  it("derives a stable idempotency key from the WhatsApp message id", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wamid.HBgLNDU2",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(
      deriveWhatsAppWebhookIdempotencyKey("conn-whatsapp", payload, Buffer.from(JSON.stringify(payload), "utf8")),
    ).toBe("whatsapp:conn-whatsapp:wamid.HBgLNDU2");
    expect(deriveWhatsAppWebhookIdempotencyKey("conn-whatsapp", {}, Buffer.from("raw", "utf8"))).toMatch(
      /^whatsapp:conn-whatsapp:[a-f0-9]{64}$/,
    );
  });
});

describe("whatsapp webhook route negative paths", () => {
  const connectionId = "11111111-1111-1111-1111-111111111111";
  const appSecret = "whatsapp-app-secret";
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("rejects a mismatched x-hub-signature-256 before ingest", async () => {
    const services = createIntegrationWebhooksMock();
    app = await buildApp(services);

    const rawBody = JSON.stringify(buildInboundMessagePayload("wamid.sig-mismatch"));
    const response = await app.inject({
      method: "POST",
      url: webhookUrl(),
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": buildWhatsAppWebhookSignature(rawBody, "some-other-secret"),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid WhatsApp webhook signature" });
    expect(services.ingestChannelMessage).not.toHaveBeenCalled();
    expect(services.respondToExistingChatMessage).not.toHaveBeenCalled();
  });

  it("rejects inbound deliveries when the connection has no app secret configured", async () => {
    const services = createIntegrationWebhooksMock({
      config: {
        webhookVerifyToken: "verify-token",
        inboundAccessMode: "allowlist",
        allowedSenders: ["15558675309"],
      },
    });
    app = await buildApp(services);

    const rawBody = JSON.stringify(buildInboundMessagePayload("wamid.no-secret"));
    const response = await app.inject({
      method: "POST",
      url: webhookUrl(),
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": buildWhatsAppWebhookSignature(rawBody, appSecret),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "WhatsApp connection is missing an app secret" });
    expect(services.ingestChannelMessage).not.toHaveBeenCalled();
  });

  it("dedupes a replayed WhatsApp event id on the second delivery", async () => {
    const services = createIntegrationWebhooksMock();
    app = await buildApp(services);

    const first = await signedInboundRequest(buildInboundMessagePayload("wamid.replayed"));
    const second = await signedInboundRequest(buildInboundMessagePayload("wamid.replayed"));

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ accepted: true, deduped: false, replied: true });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ accepted: true, deduped: true, replied: false });
    expect(services.ingestChannelMessage).toHaveBeenCalledTimes(2);
    expect(services.ingestChannelMessage).toHaveBeenNthCalledWith(
      1,
      "whatsapp",
      `whatsapp:${connectionId}:wamid.replayed`,
      expect.objectContaining({ eventId: "wamid.replayed" }),
    );
    expect(services.ingestChannelMessage).toHaveBeenNthCalledWith(
      2,
      "whatsapp",
      `whatsapp:${connectionId}:wamid.replayed`,
      expect.objectContaining({ eventId: "wamid.replayed" }),
    );
    // Only the first delivery may drive a reply turn; the replay must be inert.
    expect(services.respondToExistingChatMessage).toHaveBeenCalledTimes(1);
  });

  it("drops a non-allowlisted sender before ingest", async () => {
    const services = createIntegrationWebhooksMock({
      config: {
        appSecret,
        webhookVerifyToken: "verify-token",
        inboundAccessMode: "allowlist",
        allowedSenders: ["15550001111"],
      },
    });
    app = await buildApp(services);

    const response = await signedInboundRequest(buildInboundMessagePayload("wamid.denied"));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: true,
      replied: false,
      ignored: true,
      reason: "sender_not_allowlisted",
      eventType: "text",
      inboundAccess: {
        mode: "allowlist",
        reason: "sender_not_allowlisted",
      },
    });
    expect(services.ingestChannelMessage).not.toHaveBeenCalled();
    expect(services.setChatSessionBinding).not.toHaveBeenCalled();
    expect(services.respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(services.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel.sender_not_allowlisted", category: "channels" }),
    );
  });

  it("rejects an oversized inbound body before ingest", async () => {
    const services = createIntegrationWebhooksMock();
    app = await buildApp(services);

    // A streamed body over CHANNEL_INBOUND_MAX_BYTES is aborted by the
    // preParsing raw-body guard before signature checks or ingest run. The
    // guard throws a plain Error, so Fastify surfaces it as a 500 rather than
    // a 413 — the delivery is still rejected without touching ingest.
    const oversized = buildInboundMessagePayload("wamid.oversized", "x".repeat(CHANNEL_INBOUND_MAX_BYTES + 1));
    const response = await signedInboundRequest(oversized);

    expect(response.statusCode).toBe(500);
    expect(services.ingestChannelMessage).not.toHaveBeenCalled();
    expect(services.respondToExistingChatMessage).not.toHaveBeenCalled();
  });

  it("rejects an inbound delivery whose declared content-length exceeds the byte cap", async () => {
    const services = createIntegrationWebhooksMock();
    app = await buildApp(services);

    const rawBody = JSON.stringify(buildInboundMessagePayload("wamid.declared-oversized"));
    const response = await app.inject({
      method: "POST",
      url: webhookUrl(),
      headers: {
        "content-type": "application/json",
        "content-length": String(CHANNEL_INBOUND_MAX_BYTES + 1),
        "x-hub-signature-256": buildWhatsAppWebhookSignature(rawBody, appSecret),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(413);
    expect(services.ingestChannelMessage).not.toHaveBeenCalled();
    expect(services.respondToExistingChatMessage).not.toHaveBeenCalled();
  });

  async function signedInboundRequest(payload: Record<string, unknown>) {
    if (!app) {
      throw new Error("app is not initialized");
    }
    const rawBody = JSON.stringify(payload);
    return app.inject({
      method: "POST",
      url: webhookUrl(),
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": buildWhatsAppWebhookSignature(rawBody, appSecret),
      },
      payload: rawBody,
    });
  }

  function webhookUrl(): string {
    return `/api/v1/integrations/connections/${connectionId}/whatsapp/webhook`;
  }

  function buildInboundMessagePayload(eventId: string, body = "Need an operator check-in") {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: {
                  phone_number_id: "123456789012345",
                  display_phone_number: "+15551234567",
                },
                contacts: [{ wa_id: "15558675309", profile: { name: "Ada Lovelace" } }],
                messages: [
                  {
                    from: "15558675309",
                    id: eventId,
                    timestamp: "1712182068",
                    type: "text",
                    text: { body },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  function createIntegrationWebhooksMock(overrides: { config?: Record<string, unknown> } = {}) {
    const seenIdempotencyKeys = new Set<string>();
    const connection = {
      connectionId,
      key: "whatsapp",
      enabled: true,
      status: "connected" as const,
      config: overrides.config ?? {
        appSecret,
        webhookVerifyToken: "verify-token",
        inboundAccessMode: "allowlist" as const,
        allowedSenders: ["15558675309"],
      },
    };
    return {
      getIntegrationConnection: vi.fn(() => connection),
      ingestChannelMessage: vi.fn(async (_channel: string, idempotencyKey: string) => {
        const deduped = seenIdempotencyKeys.has(idempotencyKey);
        seenIdempotencyKeys.add(idempotencyKey);
        return { deduped, session: { sessionId: "sess-whatsapp" } };
      }),
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(async () => ({ turnId: "turn-1", trace: { status: "completed" } })),
      emitChannelActivity: vi.fn(async () => ({ delivered: true })),
      recordDevDiagnostic: vi.fn(),
    };
  }

  async function buildApp(services: Record<string, unknown>): Promise<FastifyInstance> {
    const next = Fastify();
    next.decorate("services", { integrationWebhooks: services } as never);
    registerWhatsAppWebhookRoutes(next);
    await next.ready();
    return next;
  }
});
