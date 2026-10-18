import { afterEach, describe, expect, it, vi } from "vitest";
import { sign } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { authPlugin } from "../plugins/auth.js";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import type { DurableInboundChannelAcceptInput } from "../services/channel-inbound-dispatch.js";
import { deriveQqbotEd25519KeyPair, verifyQqbotSignature } from "../services/qqbot-webhook.js";
import { installRouteAccessTracking } from "./route-access.js";
import { integrationWebhookRoutes } from "./integration-webhooks.js";

const connectionId = "22222222-2222-2222-2222-222222222222";
const webhookUrl = `/api/v1/integrations/connections/${connectionId}/qqbot/webhook`;
const APP_SECRET = "naOC0ocQE3shWLAfffVLB1rhYPG7";
const TS = "1725442341";

function groupEvent(memberOpenid = "MEMBER1") {
  return {
    op: 0,
    id: "GATEWAY_EVENT_1",
    t: "GROUP_AT_MESSAGE_CREATE",
    d: {
      id: "ROBOT1.0_msg1",
      content: " hello bot",
      group_openid: "GROUP1",
      author: { member_openid: memberOpenid },
      timestamp: "2026-10-17T10:00:00+08:00",
    },
  };
}

function buildConnection(config: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    connectionId,
    revision: "rev-1",
    key: "qqbot",
    enabled: true,
    status: "connected" as const,
    config: {
      appId: "1020",
      appSecret: APP_SECRET,
      inboundAccessMode: "allowlist",
      allowedSenders: ["MEMBER1"],
      ...config,
    },
    ...overrides,
  };
}

function signBody(body: string, timestamp = TS, secret = APP_SECRET): string {
  const { privateKey } = deriveQqbotEd25519KeyPair(secret);
  return sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), privateKey).toString("hex");
}

function acceptedResult(event: DurableInboundChannelAcceptInput, deduped = false) {
  return {
    accepted: true as const,
    durableAccepted: true as const,
    deduped,
    replied: false as const,
    queued: !deduped,
    eventType: event.eventType,
    inboundEventId: `inbound:${event.message.eventId}`,
  };
}

describe("QQBot webhook route", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  async function buildApp(
    input: {
      connection?: ReturnType<typeof buildConnection>;
      acceptInboundChannelEvent?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const acceptInboundChannelEvent =
      input.acceptInboundChannelEvent ??
      vi.fn(async (event: DurableInboundChannelAcceptInput) => acceptedResult(event));
    const recordDevDiagnostic = vi.fn();
    const next = Fastify();
    next.decorate("services", {
      integrationWebhooks: {
        getIntegrationConnection: vi.fn(() => input.connection ?? buildConnection()),
        acceptInboundChannelEvent,
        recordDevDiagnostic,
      },
    } as never);
    await next.register(integrationWebhookRoutes);
    app = next;
    return { app: next, acceptInboundChannelEvent, recordDevDiagnostic };
  }

  function post(
    target: FastifyInstance,
    body: unknown,
    headers: { signature?: string | null; timestamp?: string | null } = {},
  ) {
    const payload = JSON.stringify(body);
    const signature = headers.signature === undefined ? signBody(payload) : headers.signature;
    const timestamp = headers.timestamp === undefined ? TS : headers.timestamp;
    return target.inject({
      method: "POST",
      url: webhookUrl,
      headers: {
        "content-type": "application/json",
        ...(signature ? { "x-signature-ed25519": signature } : {}),
        ...(timestamp ? { "x-signature-timestamp": timestamp } : {}),
      },
      payload,
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
          entry.method === "POST" && entry.url === "/api/v1/integrations/connections/:connectionId/qqbot/webhook",
      ),
    ).toMatchObject({ accessClass: "webhook", classificationSource: "policy" });
  });

  it("rejects bad, missing and wrong-secret signatures with 401 and never dispatches", async () => {
    const ctx = await buildApp();
    const body = JSON.stringify(groupEvent());
    for (const headers of [
      { signature: "00".repeat(64) },
      { signature: null },
      { timestamp: null },
      { timestamp: "1725442342" },
      { signature: signBody(body, TS, "another-secret") },
    ]) {
      const response = await post(ctx.app, groupEvent(), headers);
      expect(response.statusCode).toBe(401);
    }
    // op 13 is signed too: an unsigned validation request is refused.
    const unsigned = await post(ctx.app, { op: 13, d: { plain_token: "tok", event_ts: TS } }, { signature: null });
    expect(unsigned.statusCode).toBe(401);
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("answers a signed op 13 validation with a verifiable signature", async () => {
    const ctx = await buildApp();
    const response = await post(ctx.app, { op: 13, d: { plain_token: "Arq0D5A61EgUu4OxUvOp", event_ts: TS } });
    expect(response.statusCode).toBe(200);
    const reply = response.json() as { plain_token: string; signature: string };
    expect(reply.plain_token).toBe("Arq0D5A61EgUu4OxUvOp");
    expect(
      verifyQqbotSignature({
        appSecret: APP_SECRET,
        signatureHex: reply.signature,
        timestamp: TS,
        rawBody: Buffer.from("Arq0D5A61EgUu4OxUvOp"),
      }),
    ).toBe(true);
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("refuses to sign a malformed validation token with 400", async () => {
    const ctx = await buildApp();
    const response = await post(ctx.app, { op: 13, d: { plain_token: '{"op":0}', event_ts: TS } });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("signature");
  });

  it("returns 400 when the connection has no app secret", async () => {
    const ctx = await buildApp({ connection: buildConnection({ appSecret: undefined }) });
    const response = await post(ctx.app, groupEvent());
    expect(response.statusCode).toBe(400);
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("dispatches a group message once with the exact options and acks op 12", async () => {
    const ctx = await buildApp();
    const response = await post(ctx.app, groupEvent());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ op: 12 });
    expect(ctx.acceptInboundChannelEvent).toHaveBeenCalledTimes(1);
    const call = ctx.acceptInboundChannelEvent.mock.calls[0]?.[0] as DurableInboundChannelAcceptInput;
    expect(call).toMatchObject({
      channel: "qqbot",
      connectionId,
      idempotencyKey: `qqbot:${connectionId}:ROBOT1.0_msg1`,
      bindingTarget: "group:GROUP1",
      dispatchKind: "agent_turn",
      acceptedConnectionRevision: "rev-1",
      responseOptions: { deliveryReplyToMessageId: "ROBOT1.0_msg1" },
      message: {
        eventId: "ROBOT1.0_msg1",
        account: connectionId,
        room: "group:GROUP1",
        actorId: "MEMBER1",
        content: "hello bot",
        metadata: expect.objectContaining({ qqReplyMsgId: "ROBOT1.0_msg1" }),
      },
    });
    expect(JSON.stringify(call)).not.toContain(APP_SECRET);
  });

  it("surfaces a replayed delivery as deduped by the ingest idempotency key", async () => {
    const seen = new Set<string>();
    const accept = vi.fn(async (event: DurableInboundChannelAcceptInput) => {
      const deduped = seen.has(event.idempotencyKey);
      seen.add(event.idempotencyKey);
      return acceptedResult(event, deduped);
    });
    const ctx = await buildApp({ acceptInboundChannelEvent: accept });
    await post(ctx.app, groupEvent());
    await post(ctx.app, groupEvent());
    const results = await Promise.all(accept.mock.results.map((r) => r.value));
    expect(results.map((r) => r.deduped)).toEqual([false, true]);
    expect(accept.mock.calls[1]?.[0].idempotencyKey).toBe(accept.mock.calls[0]?.[0].idempotencyKey);
  });

  it("drops a sender that is not on the allowlist", async () => {
    const ctx = await buildApp();
    const response = await post(ctx.app, groupEvent("STRANGER"));
    expect(response.statusCode).toBe(200);
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
      const response = await post(ctx.app, groupEvent());
      expect(response.statusCode).toBe(200);
      expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
      expect(ctx.recordDevDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ event: "channel.inbound_allowlist_empty" }),
      );
      await ctx.app.close();
      app = null;
    }
  });

  it("acks other events with op 12 without dispatching", async () => {
    const ctx = await buildApp();
    const response = await post(ctx.app, { op: 0, t: "GUILD_CREATE", d: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ op: 12 });
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("returns 503 without leaking error text when durable acceptance fails, so QQ retries", async () => {
    const accept = vi.fn(async () => {
      throw new Error("storage path C:/secret/inbound.db is locked");
    });
    const ctx = await buildApp({ acceptInboundChannelEvent: accept });
    const response = await post(ctx.app, groupEvent());
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("inbound.db");
  });

  it("rejects a connection that is not a QQBot connector", async () => {
    const ctx = await buildApp({ connection: buildConnection({}, { key: "slack" }) });
    const response = await post(ctx.app, groupEvent());
    expect(response.statusCode).toBe(400);
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("passes gateway auth and idempotency plugins without operator credentials", async () => {
    const accept = vi.fn(async (event: DurableInboundChannelAcceptInput) => acceptedResult(event));
    const next = Fastify();
    next.decorate("services", {
      integrationWebhooks: {
        getIntegrationConnection: vi.fn(() => buildConnection()),
        acceptInboundChannelEvent: accept,
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
    await next.register(integrationWebhookRoutes);
    app = next;

    const response = await post(next, groupEvent());
    expect(response.statusCode).toBe(200);
    expect(accept).toHaveBeenCalledTimes(1);
  });
});
