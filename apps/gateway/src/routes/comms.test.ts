import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { commsRoutes } from "./comms.js";

describe("comms routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("validates gmail send payloads", async () => {
    const commsGmailSend = vi.fn();
    app = Fastify();
    app.decorate("gateway", { commsGmailSend } as never);
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/comms/gmail/send",
      payload: {
        connectionId: "not-a-uuid",
        to: ["bad-email"],
        subject: "",
        bodyText: "",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(commsGmailSend).not.toHaveBeenCalled();
  });

  it("forwards calendar create requests to the gateway", async () => {
    const commsCalendarCreate = vi.fn(async () => ({ eventId: "evt-1" }));
    app = Fastify();
    app.decorate("gateway", { commsCalendarCreate } as never);
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/comms/calendar/create",
      payload: {
        connectionId: "11111111-1111-4111-8111-111111111111",
        title: "Review",
        startIso: "2026-03-05T10:00:00.000Z",
        endIso: "2026-03-05T10:30:00.000Z",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(commsCalendarCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: "Review",
    }));
  });

  it("allows attachment-only channel sends", async () => {
    const commsSend = vi.fn(async () => ({ deliveryId: "delivery-1", status: "sent" }));
    app = Fastify();
    app.decorate("gateway", { commsSend } as never);
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/comms/send",
      payload: {
        connectionId: "11111111-1111-4111-8111-111111111111",
        target: "imessage:+15551234567",
        attachmentIds: ["22222222-2222-4222-8222-222222222222"],
        message: "",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(commsSend).toHaveBeenCalledWith(expect.objectContaining({
      attachmentIds: ["22222222-2222-4222-8222-222222222222"],
      message: "",
    }));
  });

  it("forwards channel reactions to the gateway", async () => {
    const commsReact = vi.fn(async () => ({ deliveryId: "delivery-2", status: "sent" }));
    app = Fastify();
    app.decorate("gateway", { commsReact } as never);
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/comms/react",
      payload: {
        connectionId: "11111111-1111-4111-8111-111111111111",
        target: "imessage:+15551234567",
        messageId: "msg-123",
        reaction: "love",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(commsReact).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "msg-123",
      reaction: "love",
    }));
  });

  it("forwards channel unsend requests to the gateway", async () => {
    const commsUnsend = vi.fn(async () => ({ deliveryId: "delivery-3", status: "sent" }));
    app = Fastify();
    app.decorate("gateway", { commsUnsend } as never);
    await app.register(commsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/comms/unsend",
      payload: {
        connectionId: "11111111-1111-4111-8111-111111111111",
        messageId: "msg-456",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(commsUnsend).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "msg-456",
    }));
  });
});
