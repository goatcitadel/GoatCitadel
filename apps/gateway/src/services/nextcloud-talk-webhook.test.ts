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
    const rawBody = Buffer.from('{"type":"Create"}', "utf8");
    const random = "abcdef0123456789";
    const secret = "nextcloud-secret";
    const signature = buildNextcloudTalkSignature(random, rawBody, secret);

    expect(verifyNextcloudTalkSignature(random, signature, rawBody, secret)).toBe(true);
    expect(verifyNextcloudTalkSignature(random, `${signature.slice(0, -1)}0`, rawBody, secret)).toBe(false);
    expect(verifyNextcloudTalkSignature(undefined, signature, rawBody, secret)).toBe(false);
    expect(verifyNextcloudTalkSignature(random, "not-a-signature", rawBody, secret)).toBe(false);
  });

  it("derives stable idempotency keys from the raw webhook body", () => {
    const rawBody = Buffer.from('{"type":"Create","object":{"id":"1567"}}', "utf8");
    expect(deriveNextcloudTalkWebhookIdempotencyKey("conn-1", rawBody)).toBe(
      deriveNextcloudTalkWebhookIdempotencyKey("conn-1", rawBody),
    );
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
            object: { type: "Note", id: "1400", content: '{"message":"hello","parameters":{}}' },
          },
        },
        target: {
          type: "Collection",
          id: "n3xtc10ud",
          name: "world",
        },
      },
    });

    expect(normalized).toEqual(
      expect.objectContaining({
        kind: "message",
        eventType: "Create",
        eventId: "1567",
        account: "conn-nextcloud",
        room: "n3xtc10ud",
        actorId: "users/ada-lovelace",
        displayName: "Ada Lovelace",
        content: "hi world !",
        replyToMessageId: "1400",
      }),
    );
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
          content: '{"message":"hello","parameters":{}}',
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

  it("ignores missing, unsupported, or incomplete create events", () => {
    expect(
      normalizeNextcloudTalkWebhookPayload({
        connectionId: "conn-nextcloud",
        payload: {},
      }),
    ).toEqual({
      kind: "ignore",
      reason: "Missing Nextcloud webhook type",
    });
    expect(
      normalizeNextcloudTalkWebhookPayload({
        connectionId: "conn-nextcloud",
        payload: { type: "Delete" },
      }),
    ).toEqual({
      kind: "ignore",
      eventType: "Delete",
      reason: "Unsupported Nextcloud webhook type: Delete",
    });
    expect(
      normalizeNextcloudTalkWebhookPayload({
        connectionId: "conn-nextcloud",
        payload: {
          type: "Create",
          actor: { type: "Person", id: "users/ada-lovelace" },
          object: { id: "1567", content: "" },
          target: { id: "room-1" },
        },
      }),
    ).toEqual({
      kind: "ignore",
      eventType: "Create",
      reason: "Missing actor, message, room, or content in Nextcloud message event",
    });
  });

  it("renders raw, empty, and fallback-parameter create message content", () => {
    expect(
      normalizeNextcloudTalkWebhookPayload({
        connectionId: "conn-nextcloud",
        payload: {
          type: "Create",
          actor: { type: "system", id: "system", name: "System" },
          object: { id: "raw-1", content: " raw text " },
          target: { id: "room-1", name: "Ops" },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "message",
        actorType: "system",
        content: "raw text",
      }),
    );

    expect(
      normalizeNextcloudTalkWebhookPayload({
        connectionId: "conn-nextcloud",
        payload: {
          type: "Create",
          actor: { type: "Person", id: "users/ada-lovelace" },
          object: {
            id: "templated-1",
            content: JSON.stringify({
              message: "hi {fallback}",
              parameters: {
                fallback: { label: "label fallback" },
              },
            }),
          },
          target: { id: "room-1" },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "message",
        content: "hi label fallback",
      }),
    );

    expect(
      normalizeNextcloudTalkWebhookPayload({
        connectionId: "conn-nextcloud",
        payload: {
          type: "Create",
          actor: { type: "Person", id: "users/ada-lovelace" },
          object: {
            id: "empty-1",
            content: JSON.stringify({ parameters: {} }),
          },
          target: { id: "room-1" },
        },
      }),
    ).toEqual({
      kind: "ignore",
      eventType: "Create",
      reason: "Missing actor, message, room, or content in Nextcloud message event",
    });
  });

  it("normalizes reaction events without creating chat messages", () => {
    const added = normalizeNextcloudTalkWebhookPayload({
      connectionId: "conn-nextcloud",
      payload: {
        type: "Like",
        actor: { id: "users/ada-lovelace", name: "Ada Lovelace" },
        object: { id: "1567", content: '{"message":"hi","parameters":{}}' },
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
          object: { id: "1567", content: '{"message":"hi","parameters":{}}' },
          content: "😆",
        },
        target: { id: "room-1", name: "world" },
      },
    });

    expect(added).toEqual(
      expect.objectContaining({
        kind: "activity",
        eventType: "Like",
        room: "room-1",
        metadata: expect.objectContaining({
          reaction: "😆",
          messageId: "1567",
        }),
      }),
    );
    expect(removed).toEqual(
      expect.objectContaining({
        kind: "activity",
        eventType: "Undo",
        room: "room-1",
        metadata: expect.objectContaining({
          reaction: "😆",
          messageId: "1567",
        }),
      }),
    );
    expect(
      normalizeNextcloudTalkWebhookPayload({
        connectionId: "conn-nextcloud",
        payload: {
          type: "Join",
          actor: { id: "users/grace-hopper", name: "Grace Hopper" },
          object: { id: "room-from-object", type: "Collection" },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "activity",
        eventType: "Join",
        room: "room-from-object",
      }),
    );
    expect(
      normalizeNextcloudTalkWebhookPayload({
        connectionId: "conn-nextcloud",
        payload: {
          type: "Leave",
          actor: { id: "users/grace-hopper", name: "Grace Hopper" },
          target: { id: "room-from-target" },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "activity",
        eventType: "Leave",
        room: "room-from-target",
      }),
    );
  });
});
