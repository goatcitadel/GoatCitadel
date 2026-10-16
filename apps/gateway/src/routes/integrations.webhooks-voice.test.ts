import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { authPlugin } from "../plugins/auth.js";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import { buildNextcloudTalkSignature } from "../services/nextcloud-talk-webhook.js";
import { buildSlackSignature } from "../services/slack-webhook.js";
import {
  cleanupIntegrationTestApp,
  decorateIntegrationServices,
  integrationsRoutes,
} from "./integrations-test-fixtures.js";

// Inbound voice for Slack (download + transcription in the durable worker) and
// Nextcloud Talk (honest fallback: Talk bots cannot download shared media).

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";
const SLACK_FILE_URL = "https://files.slack.com/files-pri/T111-F0VOICE01/download/audio_message.webm";
const NEXTCLOUD_VOICE_FALLBACK =
  "[voice message received — Nextcloud Talk bots cannot download shared media, so it was not transcribed]";

function createDurableAcceptanceMock() {
  return vi.fn(async (input: { eventType: string; message: { eventId: string } }) => ({
    accepted: true as const,
    durableAccepted: true as const,
    deduped: false,
    replied: false as const,
    queued: true,
    eventType: input.eventType,
    inboundEventId: `inbound:${input.message.eventId}`,
  }));
}

describe("inbound voice webhooks (Slack, Nextcloud Talk)", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await cleanupIntegrationTestApp(app);
    app = null;
  });

  async function buildApp(methods: Record<string, unknown>) {
    app = Fastify();
    decorateIntegrationServices(app, {
      validateDeviceAccessToken: vi.fn(() => undefined),
      ingestChannelMessage: vi.fn(),
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(),
      recordDevDiagnostic: vi.fn(),
      ...methods,
    });
    app.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await app.register(authPlugin);
    await app.register(idempotencyHeaderPlugin);
    await app.register(integrationsRoutes);
    return app;
  }

  function slackConnection() {
    return {
      connectionId: CONNECTION_ID,
      key: "slack",
      config: {
        botToken: "xoxb-slack-token",
        signingSecret: "slack-signing-secret",
        slackTeamId: "T111",
        slackAppId: "A111",
      },
    };
  }

  function slackImageSharePayload(text?: string) {
    return JSON.stringify({
      type: "event_callback",
      event_id: "EvImage1",
      team_id: "T111",
      api_app_id: "A111",
      event: {
        type: "message",
        subtype: "file_share",
        user: "U111",
        text: text ?? "",
        channel: "D111",
        channel_type: "im",
        ts: "1712109984.400000",
        files: [
          {
            id: "F0IMAGE01",
            mimetype: "image/png",
            url_private_download: "https://files.slack.com/files-pri/T111-F0IMAGE01/download/shot.png",
          },
        ],
      },
    });
  }

  function slackVoicePayload(text?: string) {
    return JSON.stringify({
      type: "event_callback",
      event_id: "EvVoice1",
      team_id: "T111",
      api_app_id: "A111",
      event: {
        type: "message",
        subtype: "file_share",
        user: "U111",
        ...(text ? { text } : { text: "" }),
        channel: "D111",
        channel_type: "im",
        ts: "1712109984.300000",
        files: [
          {
            id: "F0VOICE01",
            mimetype: "audio/webm",
            subtype: "slack_audio",
            url_private_download: SLACK_FILE_URL,
            url_private: "https://files.slack.com/files-pri/T111-F0VOICE01/audio_message.webm",
          },
        ],
      },
    });
  }

  async function postSlack(target: FastifyInstance, payload: string) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return target.inject({
      method: "POST",
      url: `/api/v1/integrations/connections/${CONNECTION_ID}/slack/webhook`,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": buildSlackSignature(timestamp, payload, "slack-signing-secret"),
      },
      payload,
    });
  }

  it("Slack: an audio file share dispatches a secret-free voice_agent_turn when voice is enabled", async () => {
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    const transcribeChannelVoice = vi.fn();
    const built = await buildApp({
      getIntegrationConnection: vi.fn(() => slackConnection()),
      isVoiceInboundEnabled: async () => true,
      transcribeChannelVoice,
      acceptInboundChannelEvent,
    });

    const response = await postSlack(built, slackVoicePayload());

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: true, durableAccepted: true, queued: true });
    expect(acceptInboundChannelEvent).toHaveBeenCalledTimes(1);
    const input = acceptInboundChannelEvent.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(input).toEqual(
      expect.objectContaining({
        channel: "slack",
        idempotencyKey: `slack:${CONNECTION_ID}:EvVoice1`,
        dispatchKind: "voice_agent_turn",
        bindingTarget: "D111",
        voiceRequest: {
          channel: "slack",
          connectionConfig: {},
          fileId: "F0VOICE01",
          downloadUrl: SLACK_FILE_URL,
          mimeType: "audio/webm",
        },
        voiceFallbackContent: "[voice message]",
        message: expect.objectContaining({ eventId: "1712109984.300000", actorId: "U111", content: "[voice message]" }),
      }),
    );
    expect(JSON.stringify(input)).not.toContain("xoxb-slack-token");
    expect(JSON.stringify(input)).not.toContain("slack-signing-secret");
    expect(transcribeChannelVoice).not.toHaveBeenCalled();
  });

  it("Slack: the fallback content keeps any typed text after the voice marker", async () => {
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    const built = await buildApp({
      getIntegrationConnection: vi.fn(() => slackConnection()),
      isVoiceInboundEnabled: () => true,
      acceptInboundChannelEvent,
    });

    await postSlack(built, slackVoicePayload("listen to this"));

    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchKind: "voice_agent_turn",
        voiceFallbackContent: "[voice message] listen to this",
        voiceCaption: "listen to this",
      }),
    );
  });

  it("Slack: with voice disabled every file_share (audio or image, captioned or not) stays ignored", async () => {
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    const built = await buildApp({
      getIntegrationConnection: vi.fn(() => slackConnection()),
      isVoiceInboundEnabled: () => false,
      acceptInboundChannelEvent,
    });

    for (const payload of [slackVoicePayload("listen to this"), slackImageSharePayload("look at this")]) {
      const response = await postSlack(built, payload);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ accepted: true, ignored: true });
    }
    expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("Slack: with voice enabled a non-audio file_share is still ignored", async () => {
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    const built = await buildApp({
      getIntegrationConnection: vi.fn(() => slackConnection()),
      isVoiceInboundEnabled: () => true,
      acceptInboundChannelEvent,
    });

    const response = await postSlack(built, slackImageSharePayload("look at this"));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: true, ignored: true });
    expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("Slack: with voice disabled a voice-only share is still ignored (default behavior unchanged)", async () => {
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    const built = await buildApp({
      getIntegrationConnection: vi.fn(() => slackConnection()),
      isVoiceInboundEnabled: () => false,
      acceptInboundChannelEvent,
    });

    const response = await postSlack(built, slackVoicePayload());

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: true, ignored: true });
    expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("Slack: a replayed voice event reuses the same provider-event idempotency key", async () => {
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    const built = await buildApp({
      getIntegrationConnection: vi.fn(() => slackConnection()),
      isVoiceInboundEnabled: () => true,
      acceptInboundChannelEvent,
    });

    await postSlack(built, slackVoicePayload());
    await postSlack(built, slackVoicePayload());

    const keys = acceptInboundChannelEvent.mock.calls.map(
      (call) => (call[0] as unknown as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toEqual([`slack:${CONNECTION_ID}:EvVoice1`, `slack:${CONNECTION_ID}:EvVoice1`]);
  });

  it("Slack: the sender gate runs before voice acceptance", async () => {
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    const built = await buildApp({
      getIntegrationConnection: vi.fn(() => ({
        ...slackConnection(),
        config: { ...slackConnection().config, inboundAccessMode: "allowlist", allowedSenders: ["U999"] },
      })),
      isVoiceInboundEnabled: () => true,
      acceptInboundChannelEvent,
    });

    const response = await postSlack(built, slackVoicePayload());

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: true, ignored: true });
    expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("Nextcloud Talk: a shared voice file dispatches an honest not-transcribed agent turn", async () => {
    const acceptInboundChannelEvent = createDurableAcceptanceMock();
    const transcribeChannelVoice = vi.fn();
    const built = await buildApp({
      getIntegrationConnection: vi.fn(() => ({
        connectionId: CONNECTION_ID,
        key: "nextcloud-talk",
        config: { baseUrl: "https://cloud.example.com", token: "nextcloud-secret" },
      })),
      isVoiceInboundEnabled: () => true,
      transcribeChannelVoice,
      acceptInboundChannelEvent,
    });
    const payload = JSON.stringify({
      type: "Create",
      actor: { type: "Person", id: "users/ada", name: "Ada" },
      object: {
        type: "Note",
        id: "1900",
        name: "",
        content: JSON.stringify({
          message: "{file}",
          parameters: {
            file: {
              type: "file",
              id: "4242",
              name: "Talk recording from 2026-10-16 12-00-00 (Room).mp3",
              mimetype: "audio/mpeg",
              path: "Talk/Talk recording from 2026-10-16 12-00-00 (Room).mp3",
            },
          },
        }),
        mediaType: "text/markdown",
      },
      target: { type: "Collection", id: "room-42", name: "Room" },
    });
    const random = "abcdef0123456789";

    const response = await built.inject({
      method: "POST",
      url: `/api/v1/integrations/connections/${CONNECTION_ID}/nextcloud-talk/webhook`,
      headers: {
        "content-type": "application/json",
        "x-nextcloud-talk-random": random,
        "x-nextcloud-talk-signature": buildNextcloudTalkSignature(random, payload, "nextcloud-secret"),
        "x-nextcloud-talk-backend": "https://cloud.example.com",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(acceptInboundChannelEvent).toHaveBeenCalledTimes(1);
    const input = acceptInboundChannelEvent.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(input).toEqual(
      expect.objectContaining({
        channel: "nextcloud-talk",
        idempotencyKey: `nextcloud-talk:${CONNECTION_ID}:1900`,
        dispatchKind: "agent_turn",
        message: expect.objectContaining({ eventId: "1900", content: NEXTCLOUD_VOICE_FALLBACK }),
      }),
    );
    expect(input.voiceRequest).toBeUndefined();
    expect(transcribeChannelVoice).not.toHaveBeenCalled();
  });
});
