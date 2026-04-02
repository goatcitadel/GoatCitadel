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
    const rawBody = Buffer.from("{\"destination\":\"U123\"}", "utf8");
    const signature = buildLineWebhookSignature(rawBody, "line-channel-secret");

    expect(verifyLineWebhookSignature(signature, rawBody, "line-channel-secret")).toBe(true);
    expect(verifyLineWebhookSignature("bad-signature", rawBody, "line-channel-secret")).toBe(false);
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

    expect(
      deriveLineWebhookIdempotencyKey(
        "conn-line",
        payload,
        Buffer.from(JSON.stringify(payload), "utf8"),
      ),
    ).toBe("line:conn-line:01HV5R0EVTQ6AY9QX4QFTRMNY9");
  });
});
