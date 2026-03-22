import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { authPlugin } from "../plugins/auth.js";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import { buildNextcloudTalkSignature } from "../services/nextcloud-talk-webhook.js";
import { integrationsRoutes } from "./integrations.js";

describe("integrations inbound route guards", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("rejects channel inbound payloads with oversized content-length", async () => {
    const ingestChannelMessage = vi.fn();
    app = Fastify();
    app.decorate("gateway", {
      ingestChannelMessage,
    } as never);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/channels/discord/inbound",
      headers: {
        "content-length": String(300 * 1024),
      },
      payload: {
        account: "acct-1",
        actorId: "user-1",
        content: "hello",
      },
    });

    expect(response.statusCode).toBe(413);
    expect(ingestChannelMessage).not.toHaveBeenCalled();
  });

  it("accepts bounded inbound payloads and forwards to gateway ingest", async () => {
    const ingestChannelMessage = vi.fn(async () => ({
      accepted: true,
      sessionId: "sess-1",
    }));
    app = Fastify();
    app.decorate("gateway", {
      ingestChannelMessage,
    } as never);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/channels/discord/inbound",
      payload: {
        account: "acct-1",
        actorId: "user-1",
        content: "hello from inbound",
        metadata: {
          source: "test",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(ingestChannelMessage).toHaveBeenCalledWith(
      "discord",
      undefined,
      expect.objectContaining({
        account: "acct-1",
        actorId: "user-1",
        content: "hello from inbound",
      }),
    );
  });

  it("runs connector diagnostics through the integration diagnostics route", async () => {
    const runIntegrationConnectionDiagnostics = vi.fn(async () => ({
      connectorType: "integration_connection",
      connectorId: "11111111-1111-1111-1111-111111111111",
      status: "warn",
      checks: [
        {
          key: "smoke_mode",
          status: "pass",
          message: "Smoke probes are configured.",
        },
      ],
      checkedAt: "2026-03-22T00:00:00.000Z",
    }));
    app = Fastify();
    app.decorate("gateway", {
      runIntegrationConnectionDiagnostics,
    } as never);
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/diagnostics",
    });

    expect(response.statusCode).toBe(200);
    expect(runIntegrationConnectionDiagnostics).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
    expect(response.json()).toEqual(expect.objectContaining({
      connectorType: "integration_connection",
      connectorId: "11111111-1111-1111-1111-111111111111",
      status: "warn",
    }));
  });

  it("accepts signed Nextcloud Talk webhooks without standard auth or idempotency headers", async () => {
    const getIntegrationConnection = vi.fn(() => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      key: "nextcloud-talk",
      config: {
        baseUrl: "https://cloud.example.com",
        token: "nextcloud-secret",
      },
    }));
    const ingestChannelMessage = vi.fn(async () => ({
      accepted: true,
      deduped: false,
      session: { sessionId: "sess-nextcloud" },
      transcriptOffset: 1,
    }));
    const setChatSessionBinding = vi.fn();
    const respondToExistingChatMessage = vi.fn(async () => ({
      sessionId: "sess-nextcloud",
      userMessage: { messageId: "1567", content: "hi world !" },
      assistantMessage: { messageId: "assistant-1", content: "hello back" },
      transport: "integration",
      turnId: "turn-1",
    }));
    app = Fastify();
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection,
      ingestChannelMessage,
      setChatSessionBinding,
      respondToExistingChatMessage,
      recordDevDiagnostic: vi.fn(),
    } as never);
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

    const payload = JSON.stringify({
      type: "Create",
      actor: {
        type: "Person",
        id: "users/ada-lovelace",
        name: "Ada Lovelace",
      },
      object: {
        type: "Note",
        id: "1567",
        name: "message",
        content: "{\"message\":\"hi {mention-call1} !\",\"parameters\":{\"mention-call1\":{\"type\":\"call\",\"id\":\"room-42\",\"name\":\"world\"}}}",
        mediaType: "text/markdown",
      },
      target: {
        type: "Collection",
        id: "room-42",
        name: "world",
      },
    });
    const random = "abcdef0123456789";
    const signature = buildNextcloudTalkSignature(random, payload, "nextcloud-secret");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/nextcloud-talk/webhook",
      headers: {
        "content-type": "application/json",
        "x-nextcloud-talk-random": random,
        "x-nextcloud-talk-signature": signature,
        "x-nextcloud-talk-backend": "https://cloud.example.com",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(ingestChannelMessage).toHaveBeenCalledWith(
      "nextcloud-talk",
      expect.stringContaining("nextcloud-talk:11111111-1111-1111-1111-111111111111:"),
      expect.objectContaining({
        eventId: "1567",
        account: "11111111-1111-1111-1111-111111111111",
        room: "room-42",
        actorId: "users/ada-lovelace",
        content: "hi world !",
        displayName: "Ada Lovelace",
      }),
    );
    expect(setChatSessionBinding).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess-nextcloud",
      transport: "integration",
      connectionId: "11111111-1111-1111-1111-111111111111",
      target: "room-42",
      writable: true,
    }));
    expect(respondToExistingChatMessage).toHaveBeenCalledWith("sess-nextcloud", "1567");
    expect(response.json()).toEqual(expect.objectContaining({
      accepted: true,
      replied: true,
      sessionId: "sess-nextcloud",
      turnId: "turn-1",
      eventType: "Create",
    }));
  });

  it("rejects unsigned Nextcloud Talk webhooks", async () => {
    app = Fastify();
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "nextcloud-talk",
        config: { token: "nextcloud-secret" },
      })),
      recordDevDiagnostic: vi.fn(),
    } as never);
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

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/nextcloud-talk/webhook",
      headers: {
        "content-type": "application/json",
      },
      payload: JSON.stringify({ type: "Create" }),
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects Nextcloud webhooks for non-Nextcloud connectors", async () => {
    app = Fastify();
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "discord",
        config: { token: "discord-token" },
      })),
      recordDevDiagnostic: vi.fn(),
    } as never);
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

    const payload = JSON.stringify({ type: "Create" });
    const signature = buildNextcloudTalkSignature("abcdef0123456789", payload, "discord-token");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/nextcloud-talk/webhook",
      headers: {
        "content-type": "application/json",
        "x-nextcloud-talk-random": "abcdef0123456789",
        "x-nextcloud-talk-signature": signature,
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
  });

  it("accepts non-message Nextcloud activity hooks without ingesting chat turns", async () => {
    const ingestChannelMessage = vi.fn();
    const recordDevDiagnostic = vi.fn();
    app = Fastify();
    app.decorate("gateway", {
      validateDeviceAccessToken: vi.fn(() => undefined),
      getIntegrationConnection: vi.fn(() => ({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "nextcloud-talk",
        config: { token: "nextcloud-secret" },
      })),
      ingestChannelMessage,
      recordDevDiagnostic,
    } as never);
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

    const payload = JSON.stringify({
      type: "Like",
      actor: { id: "users/ada-lovelace", name: "Ada Lovelace" },
      object: { id: "1567", content: "{\"message\":\"hi\",\"parameters\":{}}" },
      target: { id: "room-42", name: "world" },
      content: "😆",
    });
    const random = "abcdef0123456789";
    const signature = buildNextcloudTalkSignature(random, payload, "nextcloud-secret");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/nextcloud-talk/webhook",
      headers: {
        "content-type": "application/json",
        "x-nextcloud-talk-random": random,
        "x-nextcloud-talk-signature": signature,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(ingestChannelMessage).not.toHaveBeenCalled();
    expect(recordDevDiagnostic).toHaveBeenCalled();
    expect(response.json()).toEqual(expect.objectContaining({
      accepted: true,
      handled: true,
      eventType: "Like",
    }));
  });
});
