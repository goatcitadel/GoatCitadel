import { describe, expect, it, vi } from "vitest";
import {
  integrationWebhookRouteMethods,
  type IntegrationWebhookRouteMethod,
  type IntegrationWebhookRoutePort,
} from "./integration-webhook-route-service.js";
import { normalizeTelegramWebhookPayload } from "./telegram-webhook.js";
import {
  dispatchTelegramUpdate,
  readTelegramBotMethodCall,
  runTelegramUpdate,
  type TelegramDispatchPayload,
  type TelegramUpdateDeps,
} from "./telegram-update-processor.js";

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";
const APPROVED_CONFIG = {
  botToken: "telegram-bot-token",
  webhookSecret: "telegram-webhook-secret",
  receiveMode: "poll",
  telegramPairing: {
    approved: [{ actorId: "777", approvedAt: "2026-05-02T12:00:00.000Z", displayName: "Ada Lovelace" }],
    pending: [],
  },
};

type FakeOverrides = Partial<Record<IntegrationWebhookRouteMethod, (...args: never[]) => unknown>>;

function createFakeWebhooks(overrides: FakeOverrides = {}): IntegrationWebhookRoutePort {
  const port = Object.fromEntries(integrationWebhookRouteMethods.map((method) => [method, vi.fn()]));
  return { ...port, ...overrides } as unknown as IntegrationWebhookRoutePort;
}

function createDeps(webhooks: IntegrationWebhookRoutePort): TelegramUpdateDeps {
  return {
    webhooks,
    readPersonalityCatalog: async () => ({ items: [], defaultPersonalityId: "default" }),
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

function privateTextUpdate(input: { updateId: number; actorId: number; isBot?: boolean; text?: string }) {
  return {
    update_id: input.updateId,
    message: {
      message_id: 456,
      from: { id: input.actorId, is_bot: input.isBot ?? false, first_name: "Ada" },
      chat: { id: input.actorId, type: "private" },
      text: input.text ?? "please help",
    },
  };
}

function normalizeForDispatch(update: unknown): TelegramDispatchPayload {
  const normalized = normalizeTelegramWebhookPayload({ connectionId: CONNECTION_ID, payload: update });
  if (normalized.kind === "ignore") {
    throw new Error(`Test update was unexpectedly ignored: ${normalized.reason}`);
  }
  return normalized;
}

describe("telegram update processor", () => {
  it("asks an unknown sender for pairing as a sendMessage call", async () => {
    const updateIntegrationConnection = vi.fn();
    const acceptInboundChannelEvent = vi.fn();
    const webhooks = createFakeWebhooks({ updateIntegrationConnection, acceptInboundChannelEvent });
    const update = privateTextUpdate({ updateId: 9001, actorId: 4242 });

    const reply = await dispatchTelegramUpdate(createDeps(webhooks), {
      connection: { connectionId: CONNECTION_ID, revision: "rev-1", config: { botToken: "telegram-bot-token" } },
      parsed: normalizeForDispatch(update),
      payload: update,
      rawBody: Buffer.from(JSON.stringify(update)),
    });

    const call = readTelegramBotMethodCall(reply);
    expect(call?.method).toBe("sendMessage");
    expect(call?.params.chat_id).toBe("4242");
    expect(String(call?.params.text)).toContain("Pairing code:");
    // The pending code is persisted against the revision that admitted the sender, and nothing is accepted.
    expect(updateIntegrationConnection).toHaveBeenCalledWith(
      CONNECTION_ID,
      expect.objectContaining({ expectedRevision: "rev-1" }),
    );
    expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("only treats known Bot API calls as replies", () => {
    expect(readTelegramBotMethodCall({ accepted: true })).toBeUndefined();
    expect(readTelegramBotMethodCall({ method: "deleteMessage" })).toBeUndefined();
    expect(readTelegramBotMethodCall(undefined)).toBeUndefined();
    expect(readTelegramBotMethodCall(null)).toBeUndefined();
    expect(readTelegramBotMethodCall("sendMessage")).toBeUndefined();
    expect(readTelegramBotMethodCall([{ method: "sendMessage" }])).toBeUndefined();

    expect(readTelegramBotMethodCall({ method: "sendMessage", chat_id: "4242", text: "hello" })).toEqual({
      method: "sendMessage",
      params: { chat_id: "4242", text: "hello" },
    });
    expect(
      readTelegramBotMethodCall({
        method: "answerCallbackQuery",
        callback_query_id: "cb-1",
        text: "done",
        show_alert: true,
      }),
    ).toEqual({
      method: "answerCallbackQuery",
      params: { callback_query_id: "cb-1", text: "done", show_alert: true },
    });
  });

  it("runTelegramUpdate reads the connection fresh and skips ignored updates", async () => {
    const getIntegrationConnection = vi.fn(async () => ({
      connectionId: CONNECTION_ID,
      revision: "rev-1",
      key: "telegram",
      enabled: true,
      status: "connected",
      config: APPROVED_CONFIG,
    }));
    const acceptInboundChannelEvent = vi.fn();
    const webhooks = createFakeWebhooks({ getIntegrationConnection, acceptInboundChannelEvent });

    const result = await runTelegramUpdate(
      createDeps(webhooks),
      CONNECTION_ID,
      privateTextUpdate({ updateId: 9002, actorId: 777, isBot: true }),
    );

    expect(result).toBeUndefined();
    expect(getIntegrationConnection).toHaveBeenCalledTimes(1);
    expect(getIntegrationConnection).toHaveBeenCalledWith(CONNECTION_ID);
    expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("runTelegramUpdate does nothing for a disabled or disconnected connection", async () => {
    for (const state of [
      { enabled: false, status: "connected" },
      { enabled: true, status: "paused" },
      { enabled: true, status: "disconnected" },
      { enabled: true, status: "error" },
    ]) {
      const acceptInboundChannelEvent = vi.fn();
      const webhooks = createFakeWebhooks({
        getIntegrationConnection: async () => ({
          connectionId: CONNECTION_ID,
          revision: "rev-1",
          key: "telegram",
          ...state,
          config: APPROVED_CONFIG,
        }),
        acceptInboundChannelEvent,
      });

      const result = await runTelegramUpdate(
        createDeps(webhooks),
        CONNECTION_ID,
        privateTextUpdate({ updateId: 9003, actorId: 777 }),
      );

      expect(result).toBeUndefined();
      expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
    }
  });

  it("runTelegramUpdate does nothing for a connection that is not Telegram", async () => {
    const acceptInboundChannelEvent = vi.fn();
    const updateIntegrationConnection = vi.fn();
    const webhooks = createFakeWebhooks({
      getIntegrationConnection: async () => ({
        connectionId: CONNECTION_ID,
        revision: "rev-1",
        key: "discord",
        enabled: true,
        status: "connected",
        config: APPROVED_CONFIG,
      }),
      acceptInboundChannelEvent,
      updateIntegrationConnection,
    });

    const result = await runTelegramUpdate(
      createDeps(webhooks),
      CONNECTION_ID,
      privateTextUpdate({ updateId: 9010, actorId: 4242 }),
    );

    expect(result).toBeUndefined();
    expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
    expect(updateIntegrationConnection).not.toHaveBeenCalled();
  });

  it("runTelegramUpdate does nothing for a Telegram connection that does not poll", async () => {
    for (const receiveMode of [undefined, "off", "webhook"]) {
      const acceptInboundChannelEvent = vi.fn();
      const updateIntegrationConnection = vi.fn();
      const webhooks = createFakeWebhooks({
        getIntegrationConnection: async () => ({
          connectionId: CONNECTION_ID,
          revision: "rev-1",
          key: "telegram",
          enabled: true,
          status: "connected",
          config: { ...APPROVED_CONFIG, receiveMode },
        }),
        acceptInboundChannelEvent,
        updateIntegrationConnection,
      });

      const result = await runTelegramUpdate(
        createDeps(webhooks),
        CONNECTION_ID,
        privateTextUpdate({ updateId: 9011, actorId: 4242 }),
      );

      expect(result).toBeUndefined();
      expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
      expect(updateIntegrationConnection).not.toHaveBeenCalled();
    }
  });

  it("runTelegramUpdate uses the update id as the idempotency key", async () => {
    const acceptInboundChannelEvent = vi.fn(async (input: { eventType: string; message: { eventId: string } }) =>
      acceptedEvent(input),
    );
    const webhooks = createFakeWebhooks({
      getIntegrationConnection: async () => ({
        connectionId: CONNECTION_ID,
        revision: "rev-7",
        key: "telegram",
        enabled: true,
        status: "connected",
        config: APPROVED_CONFIG,
      }),
      acceptInboundChannelEvent,
    });

    const result = await runTelegramUpdate(
      createDeps(webhooks),
      CONNECTION_ID,
      privateTextUpdate({ updateId: 9004, actorId: 777 }),
    );

    expect(acceptInboundChannelEvent).toHaveBeenCalledTimes(1);
    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        connectionId: CONNECTION_ID,
        idempotencyKey: `telegram:${CONNECTION_ID}:9004`,
        eventType: "message",
        dispatchKind: "agent_turn",
        acceptedConnectionRevision: "rev-7",
      }),
    );
    expect(result).toEqual(expect.objectContaining({ accepted: true, durableAccepted: true, queued: true }));
  });

  it("runTelegramUpdate treats a failing voice flag as off without throwing", async () => {
    const acceptInboundChannelEvent = vi.fn();
    const webhooks = createFakeWebhooks({
      getIntegrationConnection: async () => ({
        connectionId: CONNECTION_ID,
        revision: "rev-1",
        key: "telegram",
        enabled: true,
        status: "connected",
        config: APPROVED_CONFIG,
      }),
      isVoiceInboundEnabled: async () => {
        throw new Error("settings unavailable");
      },
      acceptInboundChannelEvent,
    });
    const voiceUpdate = {
      update_id: 9005,
      message: {
        message_id: 457,
        from: { id: 777, is_bot: false, first_name: "Ada" },
        chat: { id: 777, type: "private" },
        voice: { file_id: "voice-file-1", mime_type: "audio/ogg", duration: 3 },
      },
    };

    // With the flag off, a voice note carries no content and is ignored rather than dispatched.
    await expect(runTelegramUpdate(createDeps(webhooks), CONNECTION_ID, voiceUpdate)).resolves.toBeUndefined();
    expect(acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("runTelegramUpdate dispatches a voice note when the voice flag is on", async () => {
    const acceptInboundChannelEvent = vi.fn(async (input: { eventType: string; message: { eventId: string } }) =>
      acceptedEvent(input),
    );
    const webhooks = createFakeWebhooks({
      getIntegrationConnection: async () => ({
        connectionId: CONNECTION_ID,
        revision: "rev-1",
        key: "telegram",
        enabled: true,
        status: "connected",
        config: APPROVED_CONFIG,
      }),
      isVoiceInboundEnabled: async () => true,
      acceptInboundChannelEvent,
    });
    const voiceUpdate = {
      update_id: 9006,
      message: {
        message_id: 458,
        from: { id: 777, is_bot: false, first_name: "Ada" },
        chat: { id: 777, type: "private" },
        voice: { file_id: "voice-file-2", mime_type: "audio/ogg", duration: 3 },
      },
    };

    await runTelegramUpdate(createDeps(webhooks), CONNECTION_ID, voiceUpdate);

    expect(acceptInboundChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchKind: "voice_agent_turn",
        idempotencyKey: `telegram:${CONNECTION_ID}:9006`,
        voiceRequest: expect.objectContaining({ channel: "telegram", fileId: "voice-file-2" }),
      }),
    );
  });
});
