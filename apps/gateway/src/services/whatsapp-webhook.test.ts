import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerWhatsAppWebhookRoutes } from "../routes/integration-webhooks-whatsapp-routes.js";
import { CHANNEL_INBOUND_MAX_BYTES } from "../routes/webhook-handler-factory.js";
import {
  buildWhatsAppWebhookSignature,
  deriveWhatsAppWebhookEventIdempotencyKey,
  deriveWhatsAppWebhookIdempotencyKey,
  isWhatsAppWebhookPath,
  normalizeWhatsAppWebhookPayload,
  normalizeWhatsAppWebhookPayloads,
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

  it("normalizes every message across WhatsApp entries and changes", () => {
    const normalized = normalizeWhatsAppWebhookPayloads({
      connectionId: "conn-whatsapp",
      payload: {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                value: {
                  statuses: [{ id: "status-1", status: "delivered" }],
                  contacts: [
                    { wa_id: "sender-2", profile: { name: "Second" } },
                    { wa_id: "sender-1", profile: { name: "First" } },
                  ],
                  messages: [
                    { from: "sender-1", id: "wamid.batch.1", type: "text", text: { body: "first" } },
                    { from: "sender-2", id: "wamid.batch.2", type: "text", text: { body: "second" } },
                  ],
                },
              },
            ],
          },
          {
            changes: [
              {
                value: {
                  contacts: [{ wa_id: "sender-3", profile: { name: "Third" } }],
                  messages: [{ from: "sender-3", id: "wamid.batch.3", type: "image", image: { caption: "third" } }],
                },
              },
            ],
          },
        ],
      },
    });

    expect(normalized.map((event) => event.kind)).toEqual(["ignore", "message", "message", "message"]);
    const messages = normalized.filter((event) => event.kind === "message");
    expect(messages.map((event) => [event.eventId, event.displayName, event.content])).toEqual([
      ["wamid.batch.1", "First", "first"],
      ["wamid.batch.2", "Second", "second"],
      ["wamid.batch.3", "Third", "third"],
    ]);
    expect(messages.map((event) => deriveWhatsAppWebhookEventIdempotencyKey("conn-whatsapp", event))).toEqual([
      "whatsapp:conn-whatsapp:wamid.batch.1",
      "whatsapp:conn-whatsapp:wamid.batch.2",
      "whatsapp:conn-whatsapp:wamid.batch.3",
    ]);
  });
});

describe("whatsapp inbound voice media (channelVoiceInboundV1Enabled)", () => {
  const audioPayload = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "123456789012345" },
              contacts: [{ wa_id: "15558675309", profile: { name: "Ada Lovelace" } }],
              messages: [
                {
                  from: "15558675309",
                  id: "wamid.audio.1",
                  timestamp: "1712182068",
                  type: "audio",
                  audio: {
                    id: "media-id-9000",
                    mime_type: "audio/ogg; codecs=opus",
                    voice: true,
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  it("keeps the placeholder without voiceMedia when the flag is off (byte-identical default)", () => {
    const normalized = normalizeWhatsAppWebhookPayload({
      connectionId: "conn-whatsapp",
      payload: audioPayload,
    });
    expect(normalized).toEqual(
      expect.objectContaining({
        kind: "message",
        eventType: "audio",
        content: "[whatsapp audio]",
      }),
    );
    expect(normalized).not.toHaveProperty("voiceMedia");
  });

  it("emits a structured voiceMedia ref alongside the placeholder when the flag is on", () => {
    const normalized = normalizeWhatsAppWebhookPayload({
      connectionId: "conn-whatsapp",
      payload: audioPayload,
      voiceInboundEnabled: true,
    });
    expect(normalized).toEqual(
      expect.objectContaining({
        kind: "message",
        eventType: "audio",
        content: "[whatsapp audio]",
        voiceMedia: {
          mediaId: "media-id-9000",
          mimeType: "audio/ogg; codecs=opus",
        },
      }),
    );
  });

  it("never emits voiceMedia for non-audio messages even with the flag on", () => {
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
                  messages: [
                    {
                      from: "15558675309",
                      id: "wamid.text.1",
                      type: "text",
                      text: { body: "typed text" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      voiceInboundEnabled: true,
    });
    expect(normalized).toEqual(expect.objectContaining({ kind: "message", content: "typed text" }));
    expect(normalized).not.toHaveProperty("voiceMedia");
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
    expect(first.json()).toMatchObject({
      accepted: true,
      durableAccepted: true,
      deduped: false,
      replied: false,
      queued: true,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      accepted: true,
      durableAccepted: true,
      deduped: true,
      replied: false,
      queued: false,
    });
    expect(services.acceptInboundChannelEvent).toHaveBeenCalledTimes(2);
    expect(services.acceptInboundChannelEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        idempotencyKey: `whatsapp:${connectionId}:wamid.replayed`,
        dispatchKind: "agent_turn",
        message: expect.objectContaining({ eventId: "wamid.replayed" }),
      }),
    );
    expect(services.acceptInboundChannelEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: `whatsapp:${connectionId}:wamid.replayed` }),
    );
    expect(services.ingestChannelMessage).not.toHaveBeenCalled();
    expect(services.respondToExistingChatMessage).not.toHaveBeenCalled();
  });

  it("atomically accepts every message in a WhatsApp batch and makes replays inert", async () => {
    const services = createIntegrationWebhooksMock();
    app = await buildApp(services);
    const payload = buildInboundMessageBatchPayload();

    const first = await signedInboundRequest(payload);
    const replay = await signedInboundRequest(payload);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      accepted: true,
      durableAccepted: true,
      batch: true,
      eventCount: 2,
      acceptedCount: 2,
      dedupedCount: 0,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      accepted: true,
      batch: true,
      eventCount: 2,
      acceptedCount: 2,
      dedupedCount: 2,
    });
    expect(services.acceptInboundChannelEvents).toHaveBeenCalledTimes(2);
    const firstBatch = services.acceptInboundChannelEvents.mock.calls[0]?.[0];
    expect(firstBatch).toEqual([
      expect.objectContaining({
        idempotencyKey: `whatsapp:${connectionId}:wamid.batch.text`,
        dispatchKind: "agent_turn",
        message: expect.objectContaining({ eventId: "wamid.batch.text", content: "first" }),
      }),
      expect.objectContaining({
        idempotencyKey: `whatsapp:${connectionId}:wamid.batch.audio`,
        dispatchKind: "voice_agent_turn",
        message: expect.objectContaining({ eventId: "wamid.batch.audio", content: "[whatsapp audio]" }),
        voiceRequest: {
          channel: "whatsapp",
          connectionConfig: {},
          mediaId: "media-batch-audio",
          mimeType: "audio/ogg",
        },
      }),
    ]);
    expect(JSON.stringify(firstBatch)).not.toContain(appSecret);
    expect(JSON.stringify(firstBatch)).not.toContain("verify-token");
    expect(services.ingestChannelMessage).not.toHaveBeenCalled();
    expect(services.respondToExistingChatMessage).not.toHaveBeenCalled();
  });

  it("fails closed when a replay reuses a batch identity with different content", async () => {
    const services = createIntegrationWebhooksMock();
    app = await buildApp(services);

    const first = await signedInboundRequest(buildInboundMessageBatchPayload("first"));
    const mismatchedReplay = await signedInboundRequest(buildInboundMessageBatchPayload("changed"));

    expect(first.statusCode).toBe(200);
    expect(mismatchedReplay.statusCode).toBe(500);
    expect(services.acceptInboundChannelEvents).toHaveBeenCalledTimes(2);
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

    const oversized = buildInboundMessagePayload("wamid.oversized", "x".repeat(CHANNEL_INBOUND_MAX_BYTES + 1));
    const response = await signedInboundRequest(oversized);

    expect(response.statusCode).toBe(413);
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

  function buildInboundMessageBatchPayload(firstBody = "first") {
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
                    id: "wamid.batch.text",
                    timestamp: "1712182068",
                    type: "text",
                    text: { body: firstBody },
                  },
                  {
                    from: "15558675309",
                    id: "wamid.batch.audio",
                    timestamp: "1712182069",
                    type: "audio",
                    audio: { id: "media-batch-audio", mime_type: "audio/ogg", voice: true },
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
    const durablePayloadsByIdempotencyKey = new Map<string, string>();
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
    const acceptDurableInput = async (input: Record<string, unknown>) => {
      const idempotencyKey = String(input.idempotencyKey);
      const payload = JSON.stringify(input);
      const existingPayload = durablePayloadsByIdempotencyKey.get(idempotencyKey);
      if (existingPayload !== undefined && existingPayload !== payload) {
        throw new Error(`Inbound channel event payload mismatch for ${idempotencyKey}.`);
      }
      const deduped = existingPayload !== undefined;
      durablePayloadsByIdempotencyKey.set(idempotencyKey, payload);
      return {
        accepted: true as const,
        durableAccepted: true as const,
        deduped,
        replied: false as const,
        queued: !deduped,
        eventType: String(input.eventType),
        inboundEventId: `inbound:${idempotencyKey}`,
      };
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
      isVoiceInboundEnabled: vi.fn(() => true),
      acceptInboundChannelEvent: vi.fn(acceptDurableInput),
      acceptInboundChannelEvents: vi.fn(async (inputs: Array<Record<string, unknown>>) =>
        Promise.all(inputs.map((input) => acceptDurableInput(input))),
      ),
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
