import { describe, expect, it } from "vitest";
import {
  deriveTelegramWebhookIdempotencyKey,
  normalizeTelegramWebhookPayload,
  verifyTelegramWebhookSecretToken,
} from "./telegram-webhook.js";

describe("telegram webhook helpers", () => {
  it("verifies Telegram webhook secret tokens", () => {
    expect(verifyTelegramWebhookSecretToken("telegram-webhook-secret", "telegram-webhook-secret")).toBe(true);
    expect(verifyTelegramWebhookSecretToken("wrong-secret", "telegram-webhook-secret")).toBe(false);
  });

  it("normalizes inbound Telegram message events", () => {
    expect(
      normalizeTelegramWebhookPayload({
        connectionId: "conn-telegram",
        payload: {
          update_id: 9001,
          message: {
            message_id: 456,
            from: {
              id: 777,
              is_bot: false,
              first_name: "Ada",
              last_name: "Lovelace",
              username: "ada",
            },
            chat: {
              id: -1001234567890,
              type: "supergroup",
              title: "Ops Room",
            },
            message_thread_id: 98,
            text: "please help",
            reply_to_message: {
              message_id: 123,
            },
          },
        },
      }),
    ).toEqual({
      kind: "message",
      eventType: "message",
      eventId: "456",
      account: "conn-telegram",
      actorId: "777",
      actorType: "user",
      content: "please help",
      room: "-1001234567890",
      peer: undefined,
      threadId: "98",
      deliveryReplyToMessageId: "456",
      metadata: {
        updateId: "9001",
        chatId: "-1001234567890",
        chatType: "supergroup",
        chatTitle: "Ops Room",
        messageId: "456",
        threadId: "98",
        replyToMessageId: "123",
        actorUsername: "ada",
        actorDisplayName: "Ada Lovelace",
      },
    });
  });

  it("ignores bot-authored events and prefers update ids for idempotency", () => {
    const payload = {
      update_id: 9002,
      message: {
        message_id: 457,
        from: {
          id: 888,
          is_bot: true,
        },
        chat: {
          id: 12345,
          type: "private",
        },
        text: "ignore this",
      },
    };

    expect(
      normalizeTelegramWebhookPayload({
        connectionId: "conn-telegram",
        payload,
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "ignore",
        eventType: "message",
      }),
    );
    expect(
      deriveTelegramWebhookIdempotencyKey("conn-telegram", payload, Buffer.from(JSON.stringify(payload), "utf8")),
    ).toBe("telegram:conn-telegram:9002");
  });
});
