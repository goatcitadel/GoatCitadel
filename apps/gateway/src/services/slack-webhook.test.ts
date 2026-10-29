import { describe, expect, it } from "vitest";
import {
  buildSlackSignature,
  deriveSlackWebhookIdempotencyKey,
  isSlackWebhookPath,
  normalizeSlackWebhookPayload,
  verifySlackWebhookConnectionBinding,
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

  it("binds Slack envelopes to the configured team and app", () => {
    const payload = { type: "event_callback", team_id: "T123", api_app_id: "A123" };
    expect(
      verifySlackWebhookConnectionBinding({
        payload,
        expectedTeamId: "T123",
        expectedAppId: "A123",
      }),
    ).toEqual({ ok: true });
    expect(
      verifySlackWebhookConnectionBinding({
        payload: { ...payload, team_id: "T999" },
        expectedTeamId: "T123",
        expectedAppId: "A123",
      }),
    ).toEqual({ ok: false, reason: "identity_mismatch" });
    expect(verifySlackWebhookConnectionBinding({ payload, expectedTeamId: "T123" })).toEqual({
      ok: false,
      reason: "missing_connection_identity",
    });
    expect(
      verifySlackWebhookConnectionBinding({
        payload: { type: "event_callback", team_id: "T123" },
        expectedTeamId: "T123",
        expectedAppId: "A123",
      }),
    ).toEqual({ ok: false, reason: "missing_envelope_identity" });
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

  it("drops bot-authored messages by bot_id, own bot user id, or own app id", () => {
    const baseEvent = {
      type: "message",
      text: "loop candidate",
      channel: "C123",
      channel_type: "channel",
      ts: "1712109984.500000",
    };

    expect(
      normalizeSlackWebhookPayload({
        connectionId: "conn-slack",
        payload: {
          type: "event_callback",
          event_id: "Ev-bot-id",
          event: { ...baseEvent, user: "U999", bot_id: "B123" },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "ignore",
        eventType: "message",
      }),
    );

    expect(
      normalizeSlackWebhookPayload({
        connectionId: "conn-slack",
        payload: {
          type: "event_callback",
          event_id: "Ev-self",
          event: { ...baseEvent, user: "U-BOT" },
        },
        botUserId: "U-BOT",
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "ignore",
        eventType: "message",
      }),
    );

    expect(
      normalizeSlackWebhookPayload({
        connectionId: "conn-slack",
        payload: {
          type: "event_callback",
          event_id: "Ev-app",
          event: { ...baseEvent, user: "U777", app_id: "A123" },
        },
        appId: "A123",
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "ignore",
        eventType: "message",
      }),
    );
  });

  it("still accepts a genuine human message when self/bot identifiers are configured", () => {
    expect(
      normalizeSlackWebhookPayload({
        connectionId: "conn-slack",
        payload: {
          type: "event_callback",
          event_id: "Ev-human",
          event: {
            type: "message",
            user: "U-HUMAN",
            text: "hello there",
            channel: "C123",
            channel_type: "channel",
            ts: "1712109984.600000",
          },
        },
        botUserId: "U-BOT",
        appId: "A123",
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "message",
        actorId: "U-HUMAN",
        content: "hello there",
      }),
    );
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
      "slack:conn-slack:message:C123:1712109984.300000",
    );
    expect(deriveSlackWebhookIdempotencyKey("conn-slack", {}, Buffer.from("raw", "utf8"))).toMatch(
      /^slack:conn-slack:[a-f0-9]{64}$/,
    );
  });

  it("reads an app_mention as a room message without the mention", () => {
    const result = normalizeSlackWebhookPayload({
      connectionId: "conn-1",
      botUserId: "UBOT",
      payload: {
        type: "event_callback",
        event_id: "Ev-mention",
        team_id: "T1",
        event: { type: "app_mention", user: "U1", text: "<@UBOT> hello", channel: "C1", ts: "1.2" },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: "message",
        eventType: "message",
        eventId: "1.2",
        actorId: "U1",
        content: "hello",
        room: "C1",
        peer: undefined,
        deliveryReplyToMessageId: "1.2",
      }),
    );
  });

  it("strips only a leading mention of this bot, and the whitespace after it", () => {
    const read = (text: string, botUserId?: string) =>
      normalizeSlackWebhookPayload({
        connectionId: "conn-1",
        botUserId,
        payload: {
          type: "event_callback",
          event: { type: "app_mention", user: "U1", text, channel: "C1", ts: "1.2" },
        },
      });

    expect(read("  <@UBOT>   what is due?", "UBOT")).toEqual(expect.objectContaining({ content: "what is due?" }));
    expect(read("<@UBOT|goatcitadel> what is due?", "UBOT")).toEqual(
      expect.objectContaining({ content: "what is due?" }),
    );
    // A mention later in the text, or of someone else, stays as typed.
    expect(read("ask <@UBOT> what is due?", "UBOT")).toEqual(
      expect.objectContaining({ content: "ask <@UBOT> what is due?" }),
    );
    expect(read("<@UOTHER> hi <@UBOT>", "UBOT")).toEqual(expect.objectContaining({ content: "<@UOTHER> hi <@UBOT>" }));
    // Without a known bot user there is nothing to strip.
    expect(read("<@UBOT> hello")).toEqual(expect.objectContaining({ content: "<@UBOT> hello" }));
    // A bare mention carries no request.
    expect(read("<@UBOT>", "UBOT")).toEqual(expect.objectContaining({ kind: "ignore", eventType: "app_mention" }));
  });

  it("leaves a plain message event's text untouched, mention included", () => {
    expect(
      normalizeSlackWebhookPayload({
        connectionId: "conn-1",
        botUserId: "UBOT",
        payload: {
          type: "event_callback",
          event: {
            type: "message",
            user: "U1",
            text: "<@UBOT> hello",
            channel: "C1",
            channel_type: "channel",
            ts: "1.2",
          },
        },
      }),
    ).toEqual(expect.objectContaining({ kind: "message", content: "<@UBOT> hello" }));
  });

  it("drops an app_mention authored by a bot or by this bot itself", () => {
    const mention = { type: "app_mention", text: "<@UBOT> loop", channel: "C1", ts: "1.2" };
    const read = (event: Record<string, unknown>) =>
      normalizeSlackWebhookPayload({
        connectionId: "conn-1",
        botUserId: "UBOT",
        appId: "A1",
        payload: { type: "event_callback", event },
      });

    expect(read({ ...mention, user: "U9", bot_id: "B1" })).toEqual(expect.objectContaining({ kind: "ignore" }));
    expect(read({ ...mention, user: "UBOT" })).toEqual(expect.objectContaining({ kind: "ignore" }));
    expect(read({ ...mention, user: "U9", app_id: "A1" })).toEqual(expect.objectContaining({ kind: "ignore" }));
  });

  it("does not treat an app_mention file share as a voice message", () => {
    const result = normalizeSlackWebhookPayload({
      connectionId: "conn-1",
      botUserId: "UBOT",
      voiceInboundEnabled: true,
      payload: {
        type: "event_callback",
        event: {
          type: "app_mention",
          subtype: "file_share",
          user: "U1",
          text: "<@UBOT> listen",
          channel: "C1",
          ts: "1.2",
          files: [{ id: "F1", mimetype: "audio/webm", url_private_download: "https://files.slack.com/f1" }],
        },
      },
    });

    expect(result).toEqual(expect.objectContaining({ kind: "ignore", eventType: "app_mention" }));
  });

  it("gives a message and its app_mention the same key", () => {
    const envelope = (eventId: string, type: "message" | "app_mention") => ({
      type: "event_callback",
      event_id: eventId,
      event: { type, user: "U1", text: "<@UBOT> hello", channel: "C1", ts: "1.2" },
    });
    const keyOf = (payload: unknown) =>
      deriveSlackWebhookIdempotencyKey("conn-1", payload, Buffer.from(JSON.stringify(payload), "utf8"));

    expect(keyOf(envelope("Ev-a", "message"))).toBe("slack:conn-1:message:C1:1.2");
    expect(keyOf(envelope("Ev-b", "app_mention"))).toBe("slack:conn-1:message:C1:1.2");
  });

  it("keeps different messages on different keys", () => {
    const keyOf = (channel: string, ts: string) => {
      const payload = {
        type: "event_callback",
        event_id: "Ev-same",
        event: { type: "message", user: "U1", text: "hi", channel, ts },
      };
      return deriveSlackWebhookIdempotencyKey("conn-1", payload, Buffer.from(JSON.stringify(payload), "utf8"));
    };

    expect(new Set([keyOf("C1", "1.2"), keyOf("C1", "1.3"), keyOf("C2", "1.2")]).size).toBe(3);
  });

  it("keeps the event_id key when there is no channel and ts", () => {
    const keyOf = (event: Record<string, unknown>) => {
      const payload = { type: "event_callback", event_id: "Ev-x", event };
      return deriveSlackWebhookIdempotencyKey("conn-1", payload, Buffer.from(JSON.stringify(payload), "utf8"));
    };

    expect(keyOf({ type: "message", text: "hi" })).toBe("slack:conn-1:Ev-x");
    expect(keyOf({ type: "message", text: "hi", channel: "C1" })).toBe("slack:conn-1:Ev-x");
    expect(keyOf({ type: "message", text: "hi", ts: "1.2" })).toBe("slack:conn-1:Ev-x");
    expect(keyOf({ type: "message", text: "hi", channel: "", ts: "" })).toBe("slack:conn-1:Ev-x");
    expect(deriveSlackWebhookIdempotencyKey("conn-1", { type: "event_callback" }, Buffer.from("raw", "utf8"))).toMatch(
      /^slack:conn-1:[a-f0-9]{64}$/,
    );
  });
});
