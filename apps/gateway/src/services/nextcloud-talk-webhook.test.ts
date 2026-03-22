import { describe, expect, it } from "vitest";
import {
  buildNextcloudTalkSignature,
  deriveNextcloudTalkWebhookIdempotencyKey,
  isNextcloudTalkWebhookPath,
  normalizeNextcloudTalkWebhookPayload,
  verifyNextcloudTalkSignature,
} from "./nextcloud-talk-webhook.js";

describe("nextcloudTalkWebhook utilities", () => {
  it("matches the dedicated webhook route only", () => {
    expect(isNextcloudTalkWebhookPath("/api/v1/integrations/connections/123/nextcloud-talk/webhook")).toBe(true);
    expect(isNextcloudTalkWebhookPath("/api/v1/channels/nextcloud-talk/inbound")).toBe(false);
  });

  it("verifies signatures against random plus raw body", () => {
    const rawBody = Buffer.from("{\"type\":\"Create\"}", "utf8");
    const random = "abcdef0123456789";
    const secret = "nextcloud-secret";
    const signature = buildNextcloudTalkSignature(random, rawBody, secret);

    expect(verifyNextcloudTalkSignature(random, signature, rawBody, secret)).toBe(true);
    expect(verifyNextcloudTalkSignature(random, `${signature.slice(0, -1)}0`, rawBody, secret)).toBe(false);
  });

  it("derives stable idempotency keys from the raw webhook body", () => {
    const rawBody = Buffer.from("{\"type\":\"Create\",\"object\":{\"id\":\"1567\"}}", "utf8");
    expect(deriveNextcloudTalkWebhookIdempotencyKey("conn-1", rawBody))
      .toBe(deriveNextcloudTalkWebhookIdempotencyKey("conn-1", rawBody));
  });

  it("normalizes message events and renders parameter placeholders", () => {
    const normalized = normalizeNextcloudTalkWebhookPayload({
      connectionId: "conn-nextcloud",
      backendUrl: "https://cloud.example.com",
      payload: {
        type: "Create",
        actor: {
          type: "Person",
          id: "users/ada-lovelace",
          name: "Ada Lovelace",
        },
        object: {
          type: "Note",
          id: "1567",
          name: "message",
          content: JSON.stringify({
            message: "hi {mention-call1} !",
            parameters: {
              "mention-call1": {
                type: "call",
                id: "n3xtc10ud",
                name: "world",
              },
            },
          }),
          mediaType: "text/markdown",
          inReplyTo: {
            actor: { type: "Person", id: "users/grace-hopper", name: "Grace Hopper" },
            object: { type: "Note", id: "1400", content: "{\"message\":\"hello\",\"parameters\":{}}" },
          },
        },
        target: {
          type: "Collection",
          id: "n3xtc10ud",
          name: "world",
        },
      },
    });

    expect(normalized).toEqual(expect.objectContaining({
      kind: "message",
      eventType: "Create",
      eventId: "1567",
      account: "conn-nextcloud",
      room: "n3xtc10ud",
      actorId: "users/ada-lovelace",
      displayName: "Ada Lovelace",
      content: "hi world !",
      replyToMessageId: "1400",
    }));
  });

  it("ignores bot-authored create events", () => {
    const normalized = normalizeNextcloudTalkWebhookPayload({
      connectionId: "conn-nextcloud",
      payload: {
        type: "Create",
        actor: {
          type: "Application",
          id: "bots/bot-123",
          name: "Bot123",
        },
        object: {
          id: "1567",
          content: "{\"message\":\"hello\",\"parameters\":{}}",
        },
        target: {
          id: "room-1",
        },
      },
    });

    expect(normalized).toEqual({
      kind: "ignore",
      eventType: "Create",
      reason: "Ignoring bot-authored Nextcloud message",
    });
  });

  it("normalizes reaction events without creating chat messages", () => {
    const added = normalizeNextcloudTalkWebhookPayload({
      connectionId: "conn-nextcloud",
      payload: {
        type: "Like",
        actor: { id: "users/ada-lovelace", name: "Ada Lovelace" },
        object: { id: "1567", content: "{\"message\":\"hi\",\"parameters\":{}}" },
        target: { id: "room-1", name: "world" },
        content: "😆",
      },
    });
    const removed = normalizeNextcloudTalkWebhookPayload({
      connectionId: "conn-nextcloud",
      payload: {
        type: "Undo",
        actor: { id: "users/ada-lovelace", name: "Ada Lovelace" },
        object: {
          type: "Like",
          object: { id: "1567", content: "{\"message\":\"hi\",\"parameters\":{}}" },
          content: "😆",
        },
        target: { id: "room-1", name: "world" },
      },
    });

    expect(added).toEqual(expect.objectContaining({
      kind: "activity",
      eventType: "Like",
      room: "room-1",
      metadata: expect.objectContaining({
        reaction: "😆",
        messageId: "1567",
      }),
    }));
    expect(removed).toEqual(expect.objectContaining({
      kind: "activity",
      eventType: "Undo",
      room: "room-1",
      metadata: expect.objectContaining({
        reaction: "😆",
        messageId: "1567",
      }),
    }));
  });
});
