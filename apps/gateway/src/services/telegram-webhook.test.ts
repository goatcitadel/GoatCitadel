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

describe("telegram inbound voice media (channelVoiceInboundV1Enabled)", () => {
  const voicePayload = {
    update_id: 9100,
    message: {
      message_id: 500,
      from: { id: 777, is_bot: false, first_name: "Ada" },
      chat: { id: 777, type: "private" },
      voice: {
        file_id: "AwACAgIAAxkBAAIB",
        file_unique_id: "AgADSw",
        duration: 4,
        mime_type: "audio/ogg",
        file_size: 10240,
      },
    },
  };

  it("keeps dropping voice notes when the flag is off (byte-identical default)", () => {
    expect(
      normalizeTelegramWebhookPayload({
        connectionId: "conn-telegram",
        payload: voicePayload,
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "ignore",
        reason: "Missing Telegram chat, message id, content, or actor id",
      }),
    );
    // Explicit false behaves like absent.
    expect(
      normalizeTelegramWebhookPayload({
        connectionId: "conn-telegram",
        payload: voicePayload,
        voiceInboundEnabled: false,
      }),
    ).toEqual(expect.objectContaining({ kind: "ignore" }));
  });

  it("emits a structured voiceMedia ref plus placeholder content when the flag is on", () => {
    const normalized = normalizeTelegramWebhookPayload({
      connectionId: "conn-telegram",
      payload: voicePayload,
      voiceInboundEnabled: true,
    });
    expect(normalized).toEqual(
      expect.objectContaining({
        kind: "message",
        eventId: "500",
        actorId: "777",
        content: "[telegram voice message]",
        voiceMedia: {
          kind: "voice",
          fileId: "AwACAgIAAxkBAAIB",
          mimeType: "audio/ogg",
          durationSeconds: 4,
        },
      }),
    );
  });

  it("handles audio messages and keeps the caption as content when present", () => {
    const normalized = normalizeTelegramWebhookPayload({
      connectionId: "conn-telegram",
      payload: {
        update_id: 9101,
        message: {
          message_id: 501,
          from: { id: 777, is_bot: false, first_name: "Ada" },
          chat: { id: 777, type: "private" },
          caption: "song draft",
          audio: { file_id: "audio-file-1", duration: 30, mime_type: "audio/mpeg" },
        },
      },
      voiceInboundEnabled: true,
    });
    expect(normalized).toEqual(
      expect.objectContaining({
        kind: "message",
        content: "song draft",
        voiceMedia: expect.objectContaining({ kind: "audio", fileId: "audio-file-1", mimeType: "audio/mpeg" }),
      }),
    );
  });

  it("never emits voiceMedia for plain text messages even with the flag on", () => {
    const normalized = normalizeTelegramWebhookPayload({
      connectionId: "conn-telegram",
      payload: {
        update_id: 9102,
        message: {
          message_id: 502,
          from: { id: 777, is_bot: false, first_name: "Ada" },
          chat: { id: 777, type: "private" },
          text: "typed text",
        },
      },
      voiceInboundEnabled: true,
    });
    expect(normalized).toEqual(expect.objectContaining({ kind: "message", content: "typed text" }));
    expect(normalized).not.toHaveProperty("voiceMedia");
  });
});
