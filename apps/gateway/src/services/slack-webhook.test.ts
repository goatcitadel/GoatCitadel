import { describe, expect, it } from "vitest";
import {
  buildSlackSignature,
  deriveSlackWebhookIdempotencyKey,
  isSlackWebhookPath,
  normalizeSlackWebhookPayload,
  verifySlackSignature,
} from "./slack-webhook.js";

describe("slack webhook helpers", () => {
  it("matches only the dedicated Slack connection webhook path", () => {
    expect(isSlackWebhookPath("/api/v1/integrations/connections/conn-1/slack/webhook")).toBe(true);
    expect(isSlackWebhookPath("/api/v1/integrations/connections/conn-1/slack/webhook?retry=1")).toBe(true);
    expect(isSlackWebhookPath("/api/v1/integrations/connections/conn-1/telegram/webhook")).toBe(false);
  });

  it("verifies signed Slack webhook requests", () => {
    const payload = Buffer.from(
      JSON.stringify({
        type: "event_callback",
        event_id: "Ev123",
      }),
      "utf8",
    );
    const timestamp = String(Math.floor(Date.UTC(2026, 2, 31, 12, 0, 0) / 1000));
    const signature = buildSlackSignature(timestamp, payload, "slack-signing-secret");

    expect(
      verifySlackSignature({
        timestamp,
        signature,
        rawBody: payload,
        secret: "slack-signing-secret",
        nowMs: Date.UTC(2026, 2, 31, 12, 4, 0),
      }),
    ).toBe(true);
    expect(
      verifySlackSignature({
        timestamp,
        signature,
        rawBody: payload,
        secret: "wrong-secret",
        nowMs: Date.UTC(2026, 2, 31, 12, 4, 0),
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        timestamp: undefined,
        signature,
        rawBody: payload,
        secret: "slack-signing-secret",
        nowMs: Date.UTC(2026, 2, 31, 12, 4, 0),
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        timestamp: "not-a-number",
        signature,
        rawBody: payload,
        secret: "slack-signing-secret",
        nowMs: Date.UTC(2026, 2, 31, 12, 4, 0),
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        timestamp,
        signature: "v1=bad",
        rawBody: payload,
        secret: "slack-signing-secret",
        nowMs: Date.UTC(2026, 2, 31, 12, 4, 0),
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        timestamp,
        signature,
        rawBody: payload,
        secret: "slack-signing-secret",
        nowMs: Date.UTC(2026, 2, 31, 12, 6, 0),
      }),
    ).toBe(false);
  });

  it("normalizes url verification challenges", () => {
    expect(
      normalizeSlackWebhookPayload({
        connectionId: "conn-slack",
        payload: {
          type: "url_verification",
          challenge: "challenge-token",
        },
      }),
    ).toEqual({
      kind: "challenge",
      challenge: "challenge-token",
    });
    expect(
      normalizeSlackWebhookPayload({
        connectionId: "conn-slack",
        payload: {
          type: "url_verification",
        },
      }),
    ).toEqual({
      kind: "ignore",
      eventType: "url_verification",
      reason: "Slack url_verification payload did not include a challenge",
    });
  });

  it("normalizes message events with thread reply targets", () => {
    expect(
      normalizeSlackWebhookPayload({
        connectionId: "conn-slack",
        payload: {
          type: "event_callback",
          event_id: "Ev456",
          team_id: "T123",
          event: {
            type: "message",
            user: "U123",
            text: "hello from thread",
            channel: "C123",
            channel_type: "channel",
            ts: "1712109984.200000",
            thread_ts: "1712109984.100000",
          },
        },
      }),
    ).toEqual({
      kind: "message",
      eventType: "message",
      eventId: "1712109984.200000",
      account: "conn-slack",
      actorId: "U123",
      actorType: "user",
      content: "hello from thread",
      room: "C123",
      peer: undefined,
      threadId: "1712109984.100000",
      deliveryReplyToMessageId: "1712109984.100000",
      metadata: {
        teamId: "T123",
        channel: "C123",
        channelType: "channel",
        threadTs: "1712109984.100000",
        messageTs: "1712109984.200000",
        eventId: "Ev456",
        eventTime: undefined,
      },
    });
  });

  it("normalizes direct messages with event_ts fallback and ignores unsupported envelopes", () => {
    expect(
      normalizeSlackWebhookPayload({
        connectionId: "conn-slack",
        payload: {
          type: "event_callback",
          team_id: "T123",
          event: {
            type: "message",
            user: "U123",
            text: "hello dm",
            channel: "D123",
            channel_type: "im",
            event_ts: "1712109984.400000",
            team: "T456",
          },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "message",
        room: undefined,
        peer: "D123",
        deliveryReplyToMessageId: "1712109984.400000",
        metadata: expect.objectContaining({
          teamId: "T123",
          eventId: undefined,
        }),
      }),
    );

    expect(
      normalizeSlackWebhookPayload({
        connectionId: "conn-slack",
        payload: {
          type: "app_rate_limited",
        },
      }),
    ).toEqual({
      kind: "ignore",
      eventType: "app_rate_limited",
      reason: "Unsupported Slack webhook envelope: app_rate_limited",
    });
    expect(
      normalizeSlackWebhookPayload({
        connectionId: "conn-slack",
        payload: {
          type: "event_callback",
          event: { type: "reaction_added" },
        },
      }),
    ).toEqual({
      kind: "ignore",
      eventType: "reaction_added",
      reason: "Unsupported Slack event type: reaction_added",
    });
    expect(
      normalizeSlackWebhookPayload({
        connectionId: "conn-slack",
        payload: {
          type: "event_callback",
          event: { type: "message", user: "U123", text: "", channel: "C123", ts: "1.0" },
        },
      }),
    ).toEqual({
      kind: "ignore",
      eventType: "message",
      reason: "Missing Slack actor, text, channel, or message timestamp",
    });
  });

  it("ignores bot or subtype message events and derives event idempotency keys", () => {
    const payload = {
      type: "event_callback",
      event_id: "Ev789",
      event: {
        type: "message",
        subtype: "message_changed",
        text: "ignore this",
        channel: "C123",
        ts: "1712109984.300000",
      },
    };
    expect(
      normalizeSlackWebhookPayload({
        connectionId: "conn-slack",
        payload,
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "ignore",
        eventType: "message",
      }),
    );
    expect(deriveSlackWebhookIdempotencyKey("conn-slack", payload, Buffer.from(JSON.stringify(payload), "utf8"))).toBe(
      "slack:conn-slack:Ev789",
    );
    expect(deriveSlackWebhookIdempotencyKey("conn-slack", {}, Buffer.from("raw", "utf8"))).toMatch(
      /^slack:conn-slack:[a-f0-9]{64}$/,
    );
  });
});
