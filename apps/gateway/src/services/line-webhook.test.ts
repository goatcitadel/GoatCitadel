import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerLineWebhookRoutes } from "../routes/integration-webhooks-line-routes.js";
import {
  buildLineWebhookSignature,
  deriveLineWebhookEventIdempotencyKey,
  deriveLineWebhookIdempotencyKey,
  isLineWebhookPath,
  normalizeLineWebhookPayload,
  normalizeLineWebhookPayloads,
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

  it("normalizes every supported event in a LINE webhook batch with distinct identities", () => {
    const normalized = normalizeLineWebhookPayloads({
      connectionId: "conn-line",
      payload: {
        destination: "Ubot123",
        events: [
          {
            type: "message",
            webhookEventId: "webhook-event-1",
            source: { type: "user", userId: "user-1" },
            message: { id: "message-1", type: "text", text: "first" },
          },
          { type: "follow", source: { type: "user", userId: "user-2" } },
          {
            type: "message",
            webhookEventId: "webhook-event-2",
            source: { type: "group", groupId: "group-1", userId: "user-2" },
            message: { id: "message-2", type: "text", text: "second" },
          },
        ],
      },
    });

    expect(normalized).toHaveLength(3);
    expect(normalized.map((event) => event.kind)).toEqual(["message", "ignore", "message"]);
    const messages = normalized.filter((event) => event.kind === "message");
    expect(messages.map((event) => event.eventId)).toEqual(["message-1", "message-2"]);
    expect(messages.map((event) => deriveLineWebhookEventIdempotencyKey("conn-line", event))).toEqual([
      "line:conn-line:webhook-event-1",
      "line:conn-line:webhook-event-2",
    ]);
  });
});

describe("line webhook durable batch intake", () => {
  const connectionId = "22222222-2222-2222-2222-222222222222";
  const channelSecret = "line-channel-secret";
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("does not acknowledge until every supported event is atomically accepted", async () => {
    let resolveAcceptance: ((value: Array<Record<string, unknown>>) => void) | undefined;
    const acceptance = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveAcceptance = resolve;
    });
    const acceptInboundChannelEvents = vi.fn(() => acceptance);
    const services = {
      getIntegrationConnection: vi.fn(() => ({
        connectionId,
        key: "line",
        enabled: true,
        status: "connected" as const,
        config: {
          channelSecret,
          inboundAccessMode: "allowlist",
          allowedSenders: ["user-1", "user-2"],
        },
      })),
      acceptInboundChannelEvents,
      ingestChannelMessage: vi.fn(),
      setChatSessionBinding: vi.fn(),
      respondToExistingChatMessage: vi.fn(),
      emitChannelActivity: vi.fn(),
      recordDevDiagnostic: vi.fn(),
    };
    app = Fastify();
    app.decorate("services", { integrationWebhooks: services } as never);
    registerLineWebhookRoutes(app);
    await app.ready();

    const payload = {
      destination: "bot-1",
      events: [
        {
          type: "message",
          webhookEventId: "line-webhook-1",
          replyToken: "sensitive-reply-token-1",
          source: { type: "user", userId: "user-1" },
          message: { id: "line-message-1", type: "text", text: "first" },
        },
        { type: "follow", source: { type: "user", userId: "ignored-user" } },
        {
          type: "message",
          webhookEventId: "line-webhook-2",
          replyToken: "sensitive-reply-token-2",
          source: { type: "user", userId: "user-2" },
          message: { id: "line-message-2", type: "text", text: "second" },
        },
      ],
    };
    const rawBody = JSON.stringify(payload);
    let acknowledged = false;
    const responsePromise = app.inject({
      method: "POST",
      url: `/api/v1/integrations/connections/${connectionId}/line/webhook`,
      headers: {
        "content-type": "application/json",
        "x-line-signature": buildLineWebhookSignature(rawBody, channelSecret),
      },
      payload: rawBody,
    });
    void responsePromise.then(() => {
      acknowledged = true;
    });

    await vi.waitFor(() => expect(acceptInboundChannelEvents).toHaveBeenCalledTimes(1));
    expect(acknowledged).toBe(false);
    const inputs = acceptInboundChannelEvents.mock.calls[0]?.[0];
    expect(inputs).toEqual([
      expect.objectContaining({
        idempotencyKey: `line:${connectionId}:line-webhook-1`,
        dispatchKind: "agent_turn",
        message: expect.objectContaining({ eventId: "line-message-1", content: "first" }),
      }),
      expect.objectContaining({
        idempotencyKey: `line:${connectionId}:line-webhook-2`,
        dispatchKind: "agent_turn",
        message: expect.objectContaining({ eventId: "line-message-2", content: "second" }),
      }),
    ]);
    expect(JSON.stringify(inputs)).not.toContain(channelSecret);
    expect(JSON.stringify(inputs)).not.toContain("sensitive-reply-token");

    resolveAcceptance?.(
      inputs.map((input: { eventType: string; message: { eventId: string } }) => ({
        accepted: true,
        durableAccepted: true,
        deduped: false,
        replied: false,
        queued: true,
        eventType: input.eventType,
        inboundEventId: `inbound:${input.message.eventId}`,
      })),
    );
    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accepted: true,
      durableAccepted: true,
      batch: true,
      eventCount: 2,
      acceptedCount: 2,
      dedupedCount: 0,
    });
  });
});
