import { describe, expect, it } from "vitest";
import {
  buildLineWebhookSignature,
  deriveLineWebhookIdempotencyKey,
  isLineWebhookPath,
  normalizeLineWebhookPayload,
  verifyLineWebhookSignature,
} from "./line-webhook.js";

describe("line webhook helpers", () => {
  it("matches the expected webhook path", () => {
    expect(isLineWebhookPath("/api/v1/integrations/connections/123/line/webhook")).toBe(true);
    expect(isLineWebhookPath("/api/v1/integrations/connections/123/telegram/webhook")).toBe(false);
  });

  it("signs and verifies raw webhook payloads", () => {
    const rawBody = Buffer.from('{"destination":"U123"}', "utf8");
    const signature = buildLineWebhookSignature(rawBody, "line-channel-secret");

    expect(verifyLineWebhookSignature(signature, rawBody, "line-channel-secret")).toBe(true);
    expect(verifyLineWebhookSignature("bad-signature", rawBody, "line-channel-secret")).toBe(false);
    expect(verifyLineWebhookSignature(undefined, rawBody, "line-channel-secret")).toBe(false);
  });

  it("normalizes inbound text messages", () => {
    const normalized = normalizeLineWebhookPayload({
      connectionId: "conn-line",
      payload: {
        destination: "Ubot123",
        events: [
          {
            type: "message",
            mode: "active",
            webhookEventId: "01HV5R0EVTQ6AY9QX4QFTRMNY9",
            replyToken: "reply-token-1",
            deliveryContext: {
              isRedelivery: false,
            },
            source: {
              type: "group",
              groupId: "Cgroup123",
              userId: "Uuser123",
            },
            message: {
              id: "325708",
              type: "text",
              text: "Please open the Office Lab view",
            },
          },
        ],
      },
    });

    expect(normalized).toEqual({
      kind: "message",
      eventType: "message",
      eventId: "325708",
      account: "conn-line",
      actorId: "Uuser123",
      actorType: "user",
      content: "Please open the Office Lab view",
      room: "Cgroup123",
      deliveryReplyToMessageId: "325708",
      metadata: {
        destination: "Ubot123",
        isRedelivery: false,
        mode: "active",
        replyToken: "reply-token-1",
        sourceType: "group",
        webhookEventId: "01HV5R0EVTQ6AY9QX4QFTRMNY9",
      },
    });
  });

  it("ignores unsupported follow events", () => {
    const normalized = normalizeLineWebhookPayload({
      connectionId: "conn-line",
      payload: {
        events: [
          {
            type: "follow",
          },
        ],
      },
    });

    expect(normalized).toEqual({
      kind: "ignore",
      eventType: "follow",
      reason: "Unsupported LINE event type: follow",
    });
  });

  it("normalizes room, user, media, and malformed LINE messages without inventing content", () => {
    expect(
      normalizeLineWebhookPayload({
        connectionId: "conn-line",
        payload: {},
      }),
    ).toEqual({
      kind: "ignore",
      reason: "No LINE webhook events were present",
    });

    expect(
      normalizeLineWebhookPayload({
        connectionId: "conn-line",
        payload: {
          events: [
            {
              type: "message",
              source: { type: "room", roomId: "Rroom123" },
              message: { id: "media-1", type: "image" },
            },
          ],
        },
      }),
    ).toMatchObject({
      kind: "message",
      actorId: "Rroom123",
      room: "Rroom123",
      content: "[line image]",
      metadata: {
        sourceType: "room",
      },
    });

    expect(
      normalizeLineWebhookPayload({
        connectionId: "conn-line",
        payload: {
          events: [
            {
              type: "message",
              source: { type: "user", userId: "Uuser123" },
              message: { id: "sticker-1", type: "sticker" },
            },
          ],
        },
      }),
    ).toMatchObject({
      kind: "message",
      actorId: "Uuser123",
      peer: "Uuser123",
      content: "[line sticker]",
    });

    expect(
      normalizeLineWebhookPayload({
        connectionId: "conn-line",
        payload: {
          events: [
            {
              type: "message",
              source: { type: "user", userId: "Uuser123" },
              message: { id: "unknown-1", type: "template" },
            },
          ],
        },
      }),
    ).toEqual({
      kind: "ignore",
      eventType: "message",
      reason: "Missing LINE actor, message id, or content",
    });
  });

  it("derives a stable idempotency key from the LINE webhook event id", () => {
    const payload = {
      events: [
        {
          webhookEventId: "01HV5R0EVTQ6AY9QX4QFTRMNY9",
          message: {
            id: "325708",
          },
        },
      ],
    };

    expect(deriveLineWebhookIdempotencyKey("conn-line", payload, Buffer.from(JSON.stringify(payload), "utf8"))).toBe(
      "line:conn-line:01HV5R0EVTQ6AY9QX4QFTRMNY9",
    );

    const messageOnly = { events: [{ message: { id: "message-id" } }] };
    expect(deriveLineWebhookIdempotencyKey("conn-line", messageOnly, Buffer.from("{}", "utf8"))).toBe(
      "line:conn-line:message-id",
    );
    expect(deriveLineWebhookIdempotencyKey("conn-line", { events: [] }, Buffer.from("{}", "utf8"))).toMatch(
      /^line:conn-line:/,
    );
  });
});
