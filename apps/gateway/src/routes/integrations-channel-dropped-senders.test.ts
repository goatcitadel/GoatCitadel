import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerChannelSetupIntegrationRoutes } from "./integrations-channel-setup-routes.js";

const CONNECTION_ID = "22222222-2222-2222-2222-222222222222";

describe("GET /api/v1/channels/connections/:connectionId/dropped-senders", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  function build(listChannelDroppedSenders: (connectionId: string) => unknown) {
    app = Fastify();
    app.decorate("services", { integrations: { listChannelDroppedSenders } } as never);
    registerChannelSetupIntegrationRoutes(app);
    return app;
  }

  it("lists the senders the connection turned away, uncached", async () => {
    const items = [{ senderId: "U2", droppedAt: "2026-11-15T10:00:00.000Z" }];
    const list = vi.fn(() => items);
    const response = await build(list).inject({
      method: "GET",
      url: `/api/v1/channels/connections/${CONNECTION_ID}/dropped-senders`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ connectionId: CONNECTION_ID, items });
    expect(list).toHaveBeenCalledWith(CONNECTION_ID);
  });

  it("answers an empty list for a connection that turned nobody away", async () => {
    const response = await build(() => []).inject({
      method: "GET",
      url: "/api/v1/channels/connections/unknown/dropped-senders",
    });
    expect(response.json()).toEqual({ connectionId: "unknown", items: [] });
  });
});
