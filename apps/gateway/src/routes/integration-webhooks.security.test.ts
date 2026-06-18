import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { buildGenericChannelInboundSignature } from "../services/generic-channel-webhook.js";
import { integrationWebhookRoutes } from "./integration-webhooks.js";

describe("integration webhook security routes", () => {
  let app: FastifyInstance | null = null;
  const connectionId = "11111111-1111-1111-1111-111111111111";

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("accepts generic inbound only on a signed connection-scoped channel route", async () => {
    const ingestChannelMessage = vi.fn(async () => ({
      deduped: false,
      session: { sessionId: "sess-1" },
    }));
    const recordDevDiagnostic = vi.fn();
    app = buildApp({
      ingestChannelMessage,
      recordDevDiagnostic,
      getIntegrationConnection: vi.fn(() => buildConnection("discord")),
    });
    await app.register(integrationWebhookRoutes);

    const payload = {
      eventId: "evt-1",
      account: connectionId,
      actorId: "user-1",
      content: "hello",
    };
    const response = await signedInboundRequest("discord", payload);

    expect(response.statusCode).toBe(200);
    expect(ingestChannelMessage).toHaveBeenCalledWith(
      "discord",
      `generic-channel:${connectionId}:discord:${payload.eventId}`,
      expect.objectContaining({
        eventId: payload.eventId,
        account: connectionId,
        actorId: "user-1",
        content: "hello",
      }),
    );
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel.inbound_access_legacy_open", category: "channels" }),
    );
  });

  it("drops generic inbound before ingest when allowlist mode has no configured senders", async () => {
    const ingestChannelMessage = vi.fn();
    const recordDevDiagnostic = vi.fn();
    app = buildApp({
      ingestChannelMessage,
      recordDevDiagnostic,
      getIntegrationConnection: vi.fn(() =>
        buildConnection("discord", {
          inboundSecret: "generic-secret",
          inboundAccessMode: "allowlist",
        }),
      ),
    });
    await app.register(integrationWebhookRoutes);

    const payload = {
      eventId: "evt-denied",
      account: connectionId,
      actorId: "user-1",
      content: "hello",
    };
    const response = await signedInboundRequest("discord", payload);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: true,
      ignored: true,
      reason: "allowlist_empty",
      inboundAccess: {
        mode: "allowlist",
        reason: "allowlist_empty",
      },
    });
    expect(ingestChannelMessage).not.toHaveBeenCalled();
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel.inbound_allowlist_empty", category: "channels" }),
    );
  });

  it("drops generic inbound before ingest when stored inbound access config is malformed", async () => {
    const ingestChannelMessage = vi.fn();
    const recordDevDiagnostic = vi.fn();
    app = buildApp({
      ingestChannelMessage,
      recordDevDiagnostic,
      getIntegrationConnection: vi.fn(() =>
        buildConnection("discord", {
          inboundSecret: "generic-secret",
          inboundAccessMode: "allow_list",
          allowedSenders: ["user-owner"],
        }),
      ),
    });
    await app.register(integrationWebhookRoutes);

    const response = await signedInboundRequest("discord", {
      eventId: "evt-invalid-config",
      account: connectionId,
      actorId: "user-intruder",
      content: "hello",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: true,
      ignored: true,
      reason: "invalid_config",
      inboundAccess: {
        mode: "allowlist",
        reason: "invalid_config",
      },
    });
    expect(ingestChannelMessage).not.toHaveBeenCalled();
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel.inbound_access_invalid_config", category: "channels" }),
    );
  });

  it("rejects generic inbound when the HMAC signature is missing or invalid", async () => {
    const ingestChannelMessage = vi.fn();
    app = buildApp({
      ingestChannelMessage,
      getIntegrationConnection: vi.fn(() => buildConnection("discord")),
    });
    await app.register(integrationWebhookRoutes);

    const payload = JSON.stringify({
      eventId: "evt-invalid",
      account: connectionId,
      actorId: "user-1",
      content: "hello",
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/connections/${connectionId}/discord/inbound`,
      headers: {
        "content-type": "application/json",
        "x-goatcitadel-channel-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-goatcitadel-channel-signature": "v1=bad",
      },
      payload,
    });

    expect(response.statusCode).toBe(401);
    expect(ingestChannelMessage).not.toHaveBeenCalled();
  });

  it("rejects missing event ids and mismatched connection accounts before ingest", async () => {
    const ingestChannelMessage = vi.fn();
    app = buildApp({
      ingestChannelMessage,
      getIntegrationConnection: vi.fn(() => buildConnection("discord")),
    });
    await app.register(integrationWebhookRoutes);

    const missingEvent = await signedInboundRequest("discord", {
      account: connectionId,
      actorId: "user-1",
      content: "hello",
    });
    const accountMismatch = await signedInboundRequest("discord", {
      eventId: "evt-2",
      account: "22222222-2222-2222-2222-222222222222",
      actorId: "user-1",
      content: "hello",
    });

    expect(missingEvent.statusCode).toBe(400);
    expect(accountMismatch.statusCode).toBe(400);
    expect(ingestChannelMessage).not.toHaveBeenCalled();
  });

  it("rejects malformed Host headers before webhook dispatch", async () => {
    const ingestChannelMessage = vi.fn();
    app = buildApp({
      ingestChannelMessage,
      getIntegrationConnection: vi.fn(() => buildConnection("discord")),
    });
    await app.register(integrationWebhookRoutes);

    const response = await signedInboundRequest(
      "discord",
      {
        eventId: "evt-host",
        account: connectionId,
        actorId: "user-1",
        content: "hello",
      },
      { host: "bad host" },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Malformed Host header" });
    expect(ingestChannelMessage).not.toHaveBeenCalled();
  });

  it("does not register the retired unauthenticated channel inbound route", async () => {
    const ingestChannelMessage = vi.fn();
    app = buildApp({
      ingestChannelMessage,
      getIntegrationConnection: vi.fn(() => buildConnection("discord")),
    });
    await app.register(integrationWebhookRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/channels/discord/inbound",
      payload: {
        eventId: "evt-old",
        account: connectionId,
        actorId: "user-1",
        content: "hello",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(ingestChannelMessage).not.toHaveBeenCalled();
  });

  async function signedInboundRequest(
    channel: string,
    payload: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    if (!app) {
      throw new Error("app is not initialized");
    }
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return app.inject({
      method: "POST",
      url: `/api/v1/integrations/connections/${connectionId}/${channel}/inbound`,
      headers: {
        "content-type": "application/json",
        "x-goatcitadel-channel-timestamp": timestamp,
        "x-goatcitadel-channel-signature": buildGenericChannelInboundSignature(timestamp, body, "generic-secret"),
        ...headers,
      },
      payload: body,
    });
  }

  function buildConnection(channel: string, config: Record<string, unknown> = { inboundSecret: "generic-secret" }) {
    return {
      connectionId,
      key: channel,
      enabled: true,
      status: "connected" as const,
      config,
    };
  }

  function buildApp(methods: Record<string, unknown>): FastifyInstance {
    const next = Fastify();
    next.decorate("services", {
      integrationWebhooks: methods,
    } as never);
    return next;
  }
});
