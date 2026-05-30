import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { integrationWebhookRoutes } from "./integration-webhooks.js";

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";
const TELEGRAM_URL = `/api/v1/integrations/connections/${CONNECTION_ID}/telegram/webhook`;
const WHATSAPP_URL = `/api/v1/integrations/connections/${CONNECTION_ID}/whatsapp/webhook`;
let telegramUpdateCounter = 10_000;

describe("integration webhook route tails", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (app) {
      await app.close();
      app = null;
    }
  });

  it("covers WhatsApp verification query and secret failure branches", async () => {
    let lookupError: Error | null = null;
    let connection = {
      key: "whatsapp",
      config: {
        webhookVerifyToken: "verify-token",
      },
    };
    const services = createWebhookServices({
      getIntegrationConnection: vi.fn(() => {
        if (lookupError) {
          throw lookupError;
        }
        return connection;
      }),
    });
    app = await buildApp(services);

    await expectStatus("GET", "/api/v1/integrations/connections/not-a-uuid/whatsapp/webhook", 400);

    lookupError = new Error("connection missing");
    await expectError("GET", WHATSAPP_URL, 404, "connection missing");

    lookupError = null;
    connection = { key: "whatsapp", config: {} };
    await expectError("GET", WHATSAPP_URL, 400, "WhatsApp connection is missing a webhook verify token");

    connection = { key: "whatsapp", config: { webhookVerifyToken: "verify-token" } };
    await expectError(
      "GET",
      `${WHATSAPP_URL}?hub.mode=unsubscribe&hub.verify_token=verify-token&hub.challenge=abc`,
      400,
      "Invalid WhatsApp webhook verification query",
    );
    await expectError(
      "GET",
      `${WHATSAPP_URL}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc`,
      401,
      "Invalid WhatsApp webhook verify token",
    );

    // Equal-length-but-wrong token still rejected: exercises the constant-time
    // comparison path (timingSafeStringEqual) rather than a short-circuit.
    await expectError(
      "GET",
      `${WHATSAPP_URL}?hub.mode=subscribe&hub.verify_token=verifx-token&hub.challenge=abc`,
      401,
      "Invalid WhatsApp webhook verify token",
    );

    const challenge = await app.inject({
      method: "GET",
      url: `${WHATSAPP_URL}?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=challenge-123`,
    });
    expect(challenge.statusCode).toBe(200);
    expect(challenge.body).toBe("challenge-123");

    connection = { key: "whatsapp", config: {} };
    await expectError(
      "POST",
      WHATSAPP_URL,
      400,
      "WhatsApp connection is missing an app secret",
      JSON.stringify({ object: "whatsapp_business_account" }),
    );
  });

  it("covers Telegram secret checks, ignored events, callbacks, commands, and active-run replies", async () => {
    let connection = createTelegramConnection({ telegramAllowAllUsers: true });
    const updateIntegrationConnection = vi.fn((connectionId: string, patch: unknown) => ({
      connectionId,
      ...connection,
      ...(patch as Record<string, unknown>),
    }));
    const resolveApprovalWithRemoteToken = vi.fn(async (input: { token: string; decision: "approve" | "reject" }) => ({
      approval: {
        approvalId: input.decision === "approve" ? "approval-approved" : "approval-rejected",
        status: input.decision === "approve" ? "approved" : "rejected",
      },
    }));
    const hasRunningTurn = vi.fn(() => false);
    const services = createWebhookServices({
      getIntegrationConnection: vi.fn(() => connection),
      hasRunningTurn,
      resolveApprovalWithRemoteToken,
      updateIntegrationConnection,
    });
    app = await buildApp(services, {
      getPersonalityCatalog: () => ({
        items: [{ id: "ops", label: "Ops", description: "Operational voice", systemInstruction: "Be direct." }],
        defaultPersonalityId: "ops",
      }),
    });

    connection = { key: "telegram", label: "Telegram", config: {} };
    await expectError(
      "POST",
      TELEGRAM_URL,
      400,
      "Telegram connection is missing a webhook secret",
      JSON.stringify({ update_id: 1 }),
    );

    connection = createTelegramConnection({ telegramAllowAllUsers: true });
    await expectError(
      "POST",
      TELEGRAM_URL,
      401,
      "Invalid Telegram webhook secret token",
      JSON.stringify({ update_id: 2 }),
      "wrong-secret",
    );

    const ignored = await postTelegram({ update_id: 3, edited_message: { message_id: 3 } });
    expect(ignored.statusCode).toBe(200);
    expect(ignored.json()).toEqual({
      accepted: true,
      ignored: true,
      eventType: "edited_message",
      reason: "Unsupported Telegram webhook envelope: edited_message",
    });

    const unknownCallback = await postTelegram(callbackPayload("callback-unknown", "not-goatcitadel"));
    expect(unknownCallback.json()).toEqual({
      method: "answerCallbackQuery",
      callback_query_id: "callback-unknown",
      text: "GoatCitadel did not recognize that channel action.",
    });

    const approvedCallback = await postTelegram(callbackPayload("callback-approve", "gca:token-approve:a"));
    expect(approvedCallback.json()).toEqual({
      method: "answerCallbackQuery",
      callback_query_id: "callback-approve",
      text: "Approved approval-approved.",
    });
    const rejectedCallback = await postTelegram(callbackPayload("callback-reject", "gca:token-reject:r"));
    expect(rejectedCallback.json()).toEqual({
      method: "answerCallbackQuery",
      callback_query_id: "callback-reject",
      text: "Rejected approval-rejected.",
    });
    expect(resolveApprovalWithRemoteToken).toHaveBeenCalledWith({
      token: "token-approve",
      decision: "approve",
      resolvedBy: "telegram:777",
    });
    expect(resolveApprovalWithRemoteToken).toHaveBeenCalledWith({
      token: "token-reject",
      decision: "reject",
      resolvedBy: "telegram:777",
    });

    connection = createTelegramConnection({});
    const unauthorizedCallback = await postTelegram(callbackPayload("callback-pair", "gca:token-pair:r"));
    expect(unauthorizedCallback.json()).toMatchObject({
      method: "answerCallbackQuery",
      callback_query_id: "callback-pair",
      show_alert: true,
    });
    expect(updateIntegrationConnection).toHaveBeenCalledWith(
      CONNECTION_ID,
      expect.objectContaining({
        config: expect.objectContaining({
          telegramPairing: expect.objectContaining({
            pending: expect.arrayContaining([expect.objectContaining({ actorId: "777", chatId: "-1001234567890" })]),
          }),
        }),
        lastError: null,
      }),
    );

    connection = createTelegramConnection({ telegramAllowAllUsers: true });
    const newSession = await postTelegram(messagePayload("/new"));
    expect(newSession.json()).toMatchObject({
      method: "sendMessage",
      chat_id: "-1001234567890",
    });
    expect(updateIntegrationConnection).toHaveBeenCalledWith(
      CONNECTION_ID,
      expect.objectContaining({
        config: expect.objectContaining({
          telegramChannelSessions: expect.any(Object),
        }),
        lastError: null,
      }),
    );

    hasRunningTurn.mockReturnValue(true);
    const active = await postTelegram(messagePayload("please start another long run"));
    expect(active.json()).toEqual({
      method: "sendMessage",
      chat_id: "-1001234567890",
      text: "A GoatCitadel run is already active for this chat. Use /status to inspect it or /stop to cancel it before starting another request.",
    });
  });

  async function expectStatus(method: "GET" | "POST", url: string, statusCode: number): Promise<void> {
    const response = await app!.inject({ method, url });
    expect(response.statusCode).toBe(statusCode);
  }

  async function expectError(
    method: "GET" | "POST",
    url: string,
    statusCode: number,
    error: string,
    payload?: string,
    telegramSecret = "telegram-secret",
  ): Promise<void> {
    const response = await app!.inject({
      method,
      url,
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": telegramSecret,
      },
      payload,
    });
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({ error });
  }

  async function postTelegram(payload: unknown) {
    return app!.inject({
      method: "POST",
      url: TELEGRAM_URL,
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "telegram-secret",
      },
      payload: JSON.stringify(payload),
    });
  }
});

async function buildApp(
  integrationWebhooks: Record<string, unknown>,
  settings?: Record<string, unknown>,
): Promise<FastifyInstance> {
  const next = Fastify();
  next.decorate("services", {
    integrationWebhooks,
    ...(settings ? { settings } : {}),
  } as never);
  await next.register(integrationWebhookRoutes);
  return next;
}

function createWebhookServices(overrides: Record<string, unknown> = {}) {
  return {
    getIntegrationConnection: vi.fn(() => createTelegramConnection({ telegramAllowAllUsers: true })),
    hasRunningTurn: vi.fn(() => false),
    ingestChannelMessage: vi.fn(async () => ({
      deduped: false,
      session: { sessionId: "session-webhook" },
    })),
    setChatSessionBinding: vi.fn(),
    respondToExistingChatMessage: vi.fn(async () => ({ turnId: "turn-webhook" })),
    emitChannelActivity: vi.fn(async () => ({ effects: [] })),
    cancelLatestActiveChatTurnForSession: vi.fn(async () => ({ status: "no_active_run" })),
    resolveApprovalWithRemoteToken: vi.fn(async () => ({
      approval: { approvalId: "approval-1", status: "approved" },
    })),
    updateIntegrationConnection: vi.fn(),
    ...overrides,
  };
}

function createTelegramConnection(config: Record<string, unknown>) {
  return {
    key: "telegram",
    label: "Telegram Ops",
    enabled: true,
    status: "connected",
    config: {
      webhookSecret: "telegram-secret",
      ...config,
    },
  };
}

function messagePayload(text: string) {
  return {
    update_id: nextTelegramUpdateId(),
    message: {
      message_id: nextTelegramUpdateId(),
      from: {
        id: 777,
        is_bot: false,
        first_name: "Ada",
        last_name: "Lovelace",
      },
      chat: {
        id: -1001234567890,
        type: "supergroup",
        title: "Ops Room",
      },
      text,
    },
  };
}

function callbackPayload(callbackQueryId: string, data: string) {
  return {
    update_id: nextTelegramUpdateId(),
    callback_query: {
      id: callbackQueryId,
      from: {
        id: 777,
        is_bot: false,
        first_name: "Ada",
        last_name: "Lovelace",
      },
      message: {
        message_id: 9001,
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Ops Room",
        },
      },
      data,
    },
  };
}

function nextTelegramUpdateId(): number {
  telegramUpdateCounter += 1;
  return telegramUpdateCounter;
}
