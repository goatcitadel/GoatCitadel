import { describe, expect, it, vi } from "vitest";
import {
  integrationWebhookRouteMethods,
  type IntegrationWebhookRouteMethod,
  type IntegrationWebhookRoutePort,
} from "./integration-webhook-route-service.js";
import {
  dispatchSlackEvent,
  runSlackEvent,
  type SlackDispatchPayload,
  type SlackEventDeps,
} from "./slack-event-processor.js";
import { normalizeSlackWebhookPayload } from "./slack-webhook.js";

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";
const ALLOWLIST_CONFIG = {
  botToken: "xoxb-test-token",
  slackTeamId: "T1",
  slackAppId: "A1",
  slackBotUserId: "UBOT",
  inboundAccessMode: "allowlist",
  allowedSenders: ["U1"],
};
const SOCKET_CONFIG = { ...ALLOWLIST_CONFIG, receiveMode: "socket" };

type FakeOverrides = Partial<Record<IntegrationWebhookRouteMethod, (...args: never[]) => unknown>>;

function createFakeWebhooks(overrides: FakeOverrides = {}): IntegrationWebhookRoutePort {
  const port = Object.fromEntries(integrationWebhookRouteMethods.map((method) => [method, vi.fn()]));
  return { ...port, ...overrides } as unknown as IntegrationWebhookRoutePort;
}

function createDeps(webhooks: IntegrationWebhookRoutePort): SlackEventDeps {
  return { webhooks };
}

function connectionRecord(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: CONNECTION_ID,
    revision: "rev-3",
    key: "slack",
    enabled: true,
    status: "connected",
    config: SOCKET_CONFIG,
    ...overrides,
  };
}

function acceptedEvent(input: { eventType: string; message: { eventId: string } }) {
  return {
    accepted: true as const,
    durableAccepted: true as const,
    deduped: false,
    replied: false as const,
    queued: true,
    eventType: input.eventType,
    inboundEventId: `inbound:${input.message.eventId}`,
  };
}

function directMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    event_id: "Ev-dm",
    team_id: "T1",
    api_app_id: "A1",
    event: {
      type: "message",
      user: "U1",
      text: "please help",
      channel: "D1",
      channel_type: "im",
      ts: "1712109984.200000",
      ...overrides,
    },
  };
}

function channelMention(overrides: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    event_id: "Ev-mention",
    team_id: "T1",
    api_app_id: "A1",
    event: { type: "app_mention", user: "U1", text: "<@UBOT> what is due?", channel: "C1", ts: "1712109985.100000" },
    ...overrides,
  };
}

function voiceShare() {
  return directMessage({
    subtype: "file_share",
    text: "",
    files: [
      {
        id: "F0VOICE01",
        mimetype: "audio/webm",
        subtype: "slack_audio",
        url_private_download: "https://files.slack.com/files-pri/T1-F0VOICE01/download/audio_message.webm",
      },
    ],
  });
}

function normalizeForDispatch(payload: unknown, voiceInboundEnabled = false): SlackDispatchPayload {
  const normalized = normalizeSlackWebhookPayload({
    connectionId: CONNECTION_ID,
    payload,
    botUserId: "UBOT",
    appId: "A1",
    voiceInboundEnabled,
  });
  if (normalized.kind !== "message") {
    throw new Error(`Test event was unexpectedly not a message: ${normalized.kind}`);
  }
  return normalized;
}

describe("slack event processor", () => {
  it("dispatches a direct message as the webhook did", async () => {
    const acceptInboundChannelEvent = vi.fn(async (input: { eventType: string; message: { eventId: string } }) =>
      acceptedEvent(input),
    );
    const webhooks = createFakeWebhooks({ acceptInboundChannelEvent });
    const payload = directMessage();

    const reply = await dispatchSlackEvent(createDeps(webhooks), {
      connection: { ...connectionRecord({ config: ALLOWLIST_CONFIG }), connectionId: CONNECTION_ID } as never,
      parsed: normalizeForDispatch(payload),
      payload,
    });

    expect(reply).toEqual(expect.objectContaining({ accepted: true, durableAccepted: true, queued: true }));
    expect(acceptInboundChannelEvent).toHaveBeenCalledTimes(1);
    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        connectionId: CONNECTION_ID,
        idempotencyKey: `slack:${CONNECTION_ID}:message:D1:1712109984.200000`,
        eventType: "message",
        bindingTarget: "D1",
        dispatchKind: "agent_turn",
        acceptedConnectionRevision: "rev-3",
        conversation: { kind: "direct", counterpartActorId: "U1" },
        responseOptions: { deliveryReplyToMessageId: "1712109984.200000" },
        message: expect.objectContaining({
          eventId: "1712109984.200000",
          account: CONNECTION_ID,
          peer: "D1",
          room: undefined,
          actorId: "U1",
          content: "please help",
        }),
      }),
    );
  });

  it("applies the connection's own sender rules, and never passes them on", async () => {
    const acceptInboundChannelEvent = vi.fn();
    const recordDevDiagnostic = vi.fn();
    const webhooks = createFakeWebhooks({ acceptInboundChannelEvent, recordDevDiagnostic });
    const payload = directMessage({ user: "U2" });

    const reply = await dispatchSlackEvent(createDeps(webhooks), {
      connection: { ...connectionRecord({ config: ALLOWLIST_CONFIG }), connectionId: CONNECTION_ID } as never,
      parsed: normalizeForDispatch(payload),
      payload,
    });

    // U2 is not on the allowlist (U1 is), so nothing is accepted.
    expect(reply).toEqual(expect.objectContaining({ accepted: true, ignored: true, reason: "sender_not_allowlisted" }));
    expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("describes a channel message as a group conversation in the room", async () => {
    const acceptInboundChannelEvent = vi.fn(async (input: { eventType: string; message: { eventId: string } }) =>
      acceptedEvent(input),
    );
    const webhooks = createFakeWebhooks({ acceptInboundChannelEvent });
    const payload = channelMention();

    await dispatchSlackEvent(createDeps(webhooks), {
      connection: { ...connectionRecord({ config: ALLOWLIST_CONFIG }), connectionId: CONNECTION_ID } as never,
      parsed: normalizeForDispatch(payload),
      payload,
    });

    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingTarget: "C1",
        conversation: { kind: "group" },
        idempotencyKey: `slack:${CONNECTION_ID}:message:C1:1712109985.100000`,
        message: expect.objectContaining({ room: "C1", peer: undefined, content: "what is due?" }),
      }),
    );
  });

  it("dispatches a voice share as a secret-free voice turn", async () => {
    const acceptInboundChannelEvent = vi.fn(async (input: { eventType: string; message: { eventId: string } }) =>
      acceptedEvent(input),
    );
    const webhooks = createFakeWebhooks({ acceptInboundChannelEvent });
    const payload = voiceShare();

    await dispatchSlackEvent(createDeps(webhooks), {
      connection: { ...connectionRecord({ config: ALLOWLIST_CONFIG }), connectionId: CONNECTION_ID } as never,
      parsed: normalizeForDispatch(payload, true),
      payload,
    });

    const input = acceptInboundChannelEvent.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(input).toEqual(
      expect.objectContaining({
        channel: "slack",
        dispatchKind: "voice_agent_turn",
        voiceRequest: {
          channel: "slack",
          connectionConfig: {},
          fileId: "F0VOICE01",
          downloadUrl: "https://files.slack.com/files-pri/T1-F0VOICE01/download/audio_message.webm",
          mimeType: "audio/webm",
        },
        voiceFallbackContent: "[voice message]",
      }),
    );
    expect(JSON.stringify(input)).not.toContain("xoxb-test-token");
  });

  it("derives the key from the raw body only when the event has no channel and ts", async () => {
    const acceptInboundChannelEvent = vi.fn(async (input: { eventType: string; message: { eventId: string } }) =>
      acceptedEvent(input),
    );
    const webhooks = createFakeWebhooks({ acceptInboundChannelEvent });
    // `event_ts` alone is enough to normalize but is not a `ts`, so the event_id key applies.
    const payload = directMessage({ ts: undefined, event_ts: "1712109984.900000" });

    await dispatchSlackEvent(createDeps(webhooks), {
      connection: { ...connectionRecord({ config: ALLOWLIST_CONFIG }), connectionId: CONNECTION_ID } as never,
      parsed: normalizeForDispatch(payload),
      payload,
      rawBody: Buffer.from(JSON.stringify(payload)),
    });

    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `slack:${CONNECTION_ID}:Ev-dm` }),
    );
  });

  it("runSlackEvent reads the connection fresh and only for Socket Mode connections", async () => {
    for (const receiveMode of ["webhook", undefined, "off", "poll"]) {
      const getIntegrationConnection = vi.fn(async () =>
        connectionRecord({ config: { ...SOCKET_CONFIG, receiveMode } }),
      );
      const acceptInboundChannelEvent = vi.fn();
      const webhooks = createFakeWebhooks({ getIntegrationConnection, acceptInboundChannelEvent });

      const result = await runSlackEvent(createDeps(webhooks), CONNECTION_ID, directMessage());

      expect(result).toBeUndefined();
      expect(getIntegrationConnection).toHaveBeenCalledTimes(1);
      expect(getIntegrationConnection).toHaveBeenCalledWith(CONNECTION_ID);
      expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
    }

    for (const state of [
      { enabled: false, status: "connected" },
      { enabled: true, status: "paused" },
      { enabled: true, status: "disconnected" },
      { enabled: true, status: "error" },
    ]) {
      const acceptInboundChannelEvent = vi.fn();
      const webhooks = createFakeWebhooks({
        getIntegrationConnection: async () => connectionRecord(state),
        acceptInboundChannelEvent,
      });

      const result = await runSlackEvent(createDeps(webhooks), CONNECTION_ID, directMessage());

      expect(result).toBeUndefined();
      expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
    }
  });

  it("runSlackEvent does nothing for a connection that is not Slack", async () => {
    const acceptInboundChannelEvent = vi.fn();
    const webhooks = createFakeWebhooks({
      getIntegrationConnection: async () => connectionRecord({ key: "telegram" }),
      acceptInboundChannelEvent,
    });

    await expect(runSlackEvent(createDeps(webhooks), CONNECTION_ID, directMessage())).resolves.toBeUndefined();
    expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("runSlackEvent dispatches a direct message and a channel mention for a Socket Mode connection", async () => {
    const acceptInboundChannelEvent = vi.fn(async (input: { eventType: string; message: { eventId: string } }) =>
      acceptedEvent(input),
    );
    const webhooks = createFakeWebhooks({
      getIntegrationConnection: async () => connectionRecord(),
      acceptInboundChannelEvent,
    });

    const dm = await runSlackEvent(createDeps(webhooks), CONNECTION_ID, directMessage());
    const mention = await runSlackEvent(createDeps(webhooks), CONNECTION_ID, channelMention());

    expect(dm).toEqual(expect.objectContaining({ accepted: true, durableAccepted: true }));
    expect(mention).toEqual(expect.objectContaining({ accepted: true, durableAccepted: true }));
    expect(acceptInboundChannelEvent).toHaveBeenCalledTimes(2);
    expect(acceptInboundChannelEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: "slack",
        idempotencyKey: `slack:${CONNECTION_ID}:message:D1:1712109984.200000`,
        conversation: { kind: "direct", counterpartActorId: "U1" },
        acceptedConnectionRevision: "rev-3",
      }),
    );
    expect(acceptInboundChannelEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        bindingTarget: "C1",
        conversation: { kind: "group" },
        message: expect.objectContaining({ room: "C1", content: "what is due?" }),
      }),
    );
  });

  it("runSlackEvent gives a message and its app_mention one key, so one mention runs one turn", async () => {
    const acceptInboundChannelEvent = vi.fn(async (input: { eventType: string; message: { eventId: string } }) =>
      acceptedEvent(input),
    );
    const webhooks = createFakeWebhooks({
      getIntegrationConnection: async () => connectionRecord(),
      acceptInboundChannelEvent,
    });
    const asMessage = {
      type: "event_callback",
      event_id: "Ev-as-message",
      team_id: "T1",
      event: { type: "message", user: "U1", text: "<@UBOT> hi", channel: "C1", channel_type: "channel", ts: "5.5" },
    };
    const asMention = {
      type: "event_callback",
      event_id: "Ev-as-mention",
      team_id: "T1",
      event: { type: "app_mention", user: "U1", text: "<@UBOT> hi", channel: "C1", ts: "5.5" },
    };

    await runSlackEvent(createDeps(webhooks), CONNECTION_ID, asMessage);
    await runSlackEvent(createDeps(webhooks), CONNECTION_ID, asMention);

    const keys = acceptInboundChannelEvent.mock.calls.map(
      (call) => (call[0] as unknown as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toEqual([`slack:${CONNECTION_ID}:message:C1:5.5`, `slack:${CONNECTION_ID}:message:C1:5.5`]);
  });

  it("runSlackEvent drops another workspace's event", async () => {
    const acceptInboundChannelEvent = vi.fn();
    const webhooks = createFakeWebhooks({
      getIntegrationConnection: async () => connectionRecord(),
      acceptInboundChannelEvent,
    });

    const result = await runSlackEvent(createDeps(webhooks), CONNECTION_ID, { ...directMessage(), team_id: "T2" });

    expect(result).toBeUndefined();
    expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("runSlackEvent accepts an event whose workspace matches, or when none is saved", async () => {
    for (const config of [SOCKET_CONFIG, { ...SOCKET_CONFIG, slackTeamId: undefined }]) {
      const acceptInboundChannelEvent = vi.fn(async (input: { eventType: string; message: { eventId: string } }) =>
        acceptedEvent(input),
      );
      const webhooks = createFakeWebhooks({
        getIntegrationConnection: async () => connectionRecord({ config }),
        acceptInboundChannelEvent,
      });

      await runSlackEvent(createDeps(webhooks), CONNECTION_ID, directMessage());

      expect(acceptInboundChannelEvent).toHaveBeenCalledTimes(1);
    }
  });

  it("runSlackEvent ignores the bot's own messages and url_verification", async () => {
    const acceptInboundChannelEvent = vi.fn();
    const webhooks = createFakeWebhooks({
      getIntegrationConnection: async () => connectionRecord(),
      acceptInboundChannelEvent,
    });
    const ignored: unknown[] = [
      directMessage({ user: "UBOT" }),
      directMessage({ user: "U9", bot_id: "B1" }),
      directMessage({ user: "U9", app_id: "A1" }),
      { type: "url_verification", challenge: "challenge-token" },
      { type: "event_callback", team_id: "T1", event: { type: "reaction_added" } },
      { type: "app_rate_limited", team_id: "T1" },
      "not an object",
      undefined,
    ];

    for (const payload of ignored) {
      await expect(runSlackEvent(createDeps(webhooks), CONNECTION_ID, payload)).resolves.toBeUndefined();
    }
    expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("runSlackEvent treats a failing voice flag as off without throwing", async () => {
    const acceptInboundChannelEvent = vi.fn();
    const webhooks = createFakeWebhooks({
      getIntegrationConnection: async () => connectionRecord(),
      isVoiceInboundEnabled: async () => {
        throw new Error("settings unavailable");
      },
      acceptInboundChannelEvent,
    });

    // With the flag off, an audio share with no text is ignored rather than dispatched.
    await expect(runSlackEvent(createDeps(webhooks), CONNECTION_ID, voiceShare())).resolves.toBeUndefined();
    expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("runSlackEvent dispatches an audio share as a voice turn when the voice flag is on", async () => {
    const acceptInboundChannelEvent = vi.fn(async (input: { eventType: string; message: { eventId: string } }) =>
      acceptedEvent(input),
    );
    const webhooks = createFakeWebhooks({
      getIntegrationConnection: async () => connectionRecord(),
      isVoiceInboundEnabled: async () => true,
      acceptInboundChannelEvent,
    });

    await runSlackEvent(createDeps(webhooks), CONNECTION_ID, voiceShare());

    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchKind: "voice_agent_turn",
        idempotencyKey: `slack:${CONNECTION_ID}:message:D1:1712109984.200000`,
        voiceRequest: expect.objectContaining({ channel: "slack", fileId: "F0VOICE01" }),
      }),
    );
  });
});
