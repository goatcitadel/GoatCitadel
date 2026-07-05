import { describe, expect, it } from "vitest";
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
