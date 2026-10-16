import { createSign, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { authPlugin } from "../plugins/auth.js";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import type { DurableInboundChannelAcceptInput } from "../services/channel-inbound-dispatch.js";
import { GOOGLE_CHAT_CERTS_URL, GOOGLE_CHAT_ISSUER } from "../services/google-chat-webhook.js";
import { installRouteAccessTracking } from "./route-access.js";
import { integrationWebhookRoutes } from "./integration-webhooks.js";

const connectionId = "11111111-1111-1111-1111-111111111111";
const webhookUrl = `/api/v1/integrations/connections/${connectionId}/google-chat/webhook`;
const PROJECT_NUMBER = "123456789012";
const KID = "route-kid";
// A raw SPKI public key PEM verifies the same way as Google's X.509 certificate PEMs.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

function signToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function validToken(): string {
  const nowS = Math.floor(Date.now() / 1000);
  return signToken({ iss: GOOGLE_CHAT_ISSUER, aud: PROJECT_NUMBER, iat: nowS - 10, exp: nowS + 3600 });
}

function messageEvent(senderName = "users/123") {
  return {
    type: "MESSAGE",
    eventTime: "2026-10-16T12:00:00.000Z",
    space: { name: "spaces/S", type: "ROOM" },
    user: { name: senderName, displayName: "Ada", email: "ada@example.com", type: "HUMAN" },
    message: {
      name: "spaces/S/messages/M",
      text: "@GoatCitadel hello",
      argumentText: " hello",
      thread: { name: "spaces/S/threads/T" },
      sender: { name: senderName, displayName: "Ada", email: "ada@example.com", type: "HUMAN" },
    },
  };
}

function buildConnection(config: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    connectionId,
    revision: "rev-1",
    key: "google-chat",
    enabled: true,
    status: "connected" as const,
    config: {
      serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
      audienceType: "project_number",
      audience: PROJECT_NUMBER,
      inboundAccessMode: "allowlist",
      allowedSenders: ["users/123"],
      ...config,
    },
    ...overrides,
  };
}

describe("Google Chat app webhook route", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  async function buildApp(input: {
    connection: ReturnType<typeof buildConnection>;
    acceptInboundChannelEvent?: ReturnType<typeof vi.fn>;
    recordDevDiagnostic?: ReturnType<typeof vi.fn>;
  }) {
    const acceptInboundChannelEvent =
      input.acceptInboundChannelEvent ??
      vi.fn(async (event: DurableInboundChannelAcceptInput) => ({
        accepted: true as const,
        durableAccepted: true as const,
        deduped: false,
        replied: false as const,
        queued: true,
        eventType: event.eventType,
        inboundEventId: `inbound:${event.message.eventId}`,
      }));
    const recordDevDiagnostic = input.recordDevDiagnostic ?? vi.fn();
    const fetchCerts = vi.fn(async () => ({ certs: { [KID]: PUBLIC_PEM }, maxAgeSeconds: 3600 }));
    const next = Fastify();
    next.decorate("services", {
      integrationWebhooks: {
        getIntegrationConnection: vi.fn(() => input.connection),
        acceptInboundChannelEvent,
        recordDevDiagnostic,
      },
    } as never);
    await next.register(integrationWebhookRoutes, { googleChatCertFetcher: fetchCerts });
    app = next;
    return { app: next, acceptInboundChannelEvent, recordDevDiagnostic, fetchCerts };
  }

  function post(target: FastifyInstance, token: string | undefined, body: unknown = messageEvent()) {
    return target.inject({
      method: "POST",
      url: webhookUrl,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      payload: JSON.stringify(body),
    });
  }

  it("is classified as a webhook route, not an operator route", async () => {
    const next = Fastify();
    installRouteAccessTracking(next);
    next.decorate("services", { integrationWebhooks: {} } as never);
    await next.register(integrationWebhookRoutes);
    app = next;
    expect(
      next.routeAccessManifest.find(
        (entry) =>
          entry.method === "POST" && entry.url === "/api/v1/integrations/connections/:connectionId/google-chat/webhook",
      ),
    ).toMatchObject({ accessClass: "webhook", classificationSource: "policy" });
  });

  it("rejects a bad token with 401 and does not dispatch", async () => {
    const ctx = await buildApp({ connection: buildConnection() });
    const response = await post(ctx.app, "not.a.token");
    expect(response.statusCode).toBe(401);
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();

    const missing = await post(ctx.app, undefined);
    expect(missing.statusCode).toBe(401);
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("returns 400 when the connection has no Chat app audience configured", async () => {
    const ctx = await buildApp({ connection: buildConnection({ audience: undefined }) });
    const response = await post(ctx.app, validToken());
    expect(response.statusCode).toBe(400);
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("returns 400 when an audience is configured without a service-account key (no Chat app mode)", async () => {
    const ctx = await buildApp({ connection: buildConnection({ serviceAccountKeyEnv: undefined }) });
    const response = await post(ctx.app, validToken());
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: expect.stringContaining("service-account key") });
    expect(ctx.fetchCerts).not.toHaveBeenCalled();
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("dispatches a verified message with a stable idempotency key, and replays with the identical key", async () => {
    const ctx = await buildApp({ connection: buildConnection() });
    const token = validToken();

    const first = await post(ctx.app, token);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({});
    const replay = await post(ctx.app, token);
    expect(replay.statusCode).toBe(200);

    expect(ctx.acceptInboundChannelEvent).toHaveBeenCalledTimes(2);
    const [firstCall, replayCall] = ctx.acceptInboundChannelEvent.mock.calls.map(
      (call) => call[0] as DurableInboundChannelAcceptInput,
    );
    expect(firstCall).toMatchObject({
      channel: "google-chat",
      connectionId,
      idempotencyKey: `google-chat:${connectionId}:spaces/S/messages/M`,
      bindingTarget: "spaces/S",
      dispatchKind: "agent_turn",
      acceptedConnectionRevision: "rev-1",
      responseOptions: { deliveryReplyToMessageId: "spaces/S/threads/T" },
      message: {
        eventId: "spaces/S/messages/M",
        account: connectionId,
        room: "spaces/S",
        threadId: "spaces/S/threads/T",
        actorId: "users/123",
        displayName: "Ada",
        content: "hello",
        metadata: expect.objectContaining({ email: "ada@example.com" }),
      },
    });
    expect(firstCall).not.toHaveProperty("inboundAccessConfig");
    expect(JSON.stringify(firstCall)).not.toContain("GOOGLE_CHAT_SA_KEY");
    expect(replayCall?.idempotencyKey).toBe(firstCall?.idempotencyKey);
    // Certificates are cached per gateway: one upstream fetch for both requests.
    expect(ctx.fetchCerts).toHaveBeenCalledTimes(1);
    expect(ctx.fetchCerts).toHaveBeenCalledWith(GOOGLE_CHAT_CERTS_URL);
  });

  it("drops a sender that is not on the allowlist", async () => {
    const ctx = await buildApp({ connection: buildConnection() });
    const response = await post(ctx.app, validToken(), messageEvent("users/999"));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
    expect(ctx.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel.sender_not_allowlisted" }),
    );
  });

  it("never applies legacy-open access: unset or open_legacy config with no senders is dropped", async () => {
    for (const config of [
      { inboundAccessMode: undefined, allowedSenders: undefined },
      { inboundAccessMode: "open_legacy", allowedSenders: undefined },
    ]) {
      const ctx = await buildApp({ connection: buildConnection(config) });
      const response = await post(ctx.app, validToken());
      expect(response.statusCode).toBe(200);
      expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
      expect(ctx.recordDevDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ event: "channel.inbound_allowlist_empty" }),
      );
      await ctx.app.close();
      app = null;
    }
  });

  it("ignores bot self-echo and lifecycle events without dispatching", async () => {
    const ctx = await buildApp({ connection: buildConnection() });
    const echo = messageEvent();
    echo.message.sender.type = "BOT";
    const echoed = await post(ctx.app, validToken(), echo);
    expect(echoed.statusCode).toBe(200);
    expect(echoed.json()).toEqual({});
    const added = await post(ctx.app, validToken(), { type: "ADDED_TO_SPACE", space: { name: "spaces/S" } });
    expect(added.statusCode).toBe(200);
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("returns 503 without leaking error text when durable acceptance fails, so Google retries", async () => {
    const acceptInboundChannelEvent = vi.fn(async () => {
      throw new Error("storage path C:/secret/inbound.db is locked");
    });
    const ctx = await buildApp({ connection: buildConnection(), acceptInboundChannelEvent });
    const response = await post(ctx.app, validToken());
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Durable inbound channel acceptance failed" });
    expect(response.body).not.toContain("inbound.db");
  });

  it("replies to the inbound message name when the event carries no thread", async () => {
    const ctx = await buildApp({ connection: buildConnection() });
    const event = messageEvent();
    const { thread: _thread, ...messageWithoutThread } = event.message;
    const response = await post(ctx.app, validToken(), { ...event, message: messageWithoutThread });
    expect(response.statusCode).toBe(200);
    expect(ctx.acceptInboundChannelEvent.mock.calls[0]?.[0]).toMatchObject({
      responseOptions: { deliveryReplyToMessageId: "spaces/S/messages/M" },
    });
  });

  it("replies ignored for a disabled connection", async () => {
    const ctx = await buildApp({ connection: buildConnection({}, { enabled: false }) });
    const response = await post(ctx.app, validToken());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: true, ignored: true, reason: "connection_disabled" });
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("passes gateway auth and idempotency plugins without operator credentials", async () => {
    const acceptInboundChannelEvent = vi.fn(async (event: DurableInboundChannelAcceptInput) => ({
      accepted: true as const,
      durableAccepted: true as const,
      deduped: false,
      replied: false as const,
      queued: true,
      eventType: event.eventType,
      inboundEventId: `inbound:${event.message.eventId}`,
    }));
    const next = Fastify();
    next.decorate("services", {
      integrationWebhooks: {
        getIntegrationConnection: vi.fn(() => buildConnection()),
        acceptInboundChannelEvent,
        recordDevDiagnostic: vi.fn(),
      },
    } as never);
    next.decorate("gatewayAuth", {
      getOnboardingStartupState: () => ({ completed: true }),
      validateDeviceAccessToken: () => undefined,
      validateCompanionAccessToken: () => undefined,
      verifyCompanionRequestSignature: () => undefined,
    } as never);
    next.decorate("gatewayConfig", {
      assistant: {
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
          token: { value: "gateway-token", queryParam: "access_token" },
          basic: { username: "operator", password: "password123" },
        },
      },
    } as never);
    await next.register(authPlugin);
    await next.register(idempotencyHeaderPlugin);
    await next.register(integrationWebhookRoutes, {
      googleChatCertFetcher: async () => ({ certs: { [KID]: PUBLIC_PEM } }),
    });
    app = next;

    const response = await post(next, validToken());
    expect(response.statusCode).toBe(200);
    expect(acceptInboundChannelEvent).toHaveBeenCalledTimes(1);
  });

  it("rejects a connection that is not a Google Chat connector", async () => {
    const ctx = await buildApp({ connection: buildConnection({}, { key: "slack" }) });
    const response = await post(ctx.app, validToken());
    expect(response.statusCode).toBe(400);
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
  });
});
