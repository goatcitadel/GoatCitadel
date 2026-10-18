import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { authPlugin } from "../plugins/auth.js";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import type { DurableInboundChannelAcceptInput } from "../services/channel-inbound-dispatch.js";
import { computeWecomSignature, encryptWecomMessageForTest } from "../services/wecom-webhook.js";
import { installRouteAccessTracking } from "./route-access.js";
import { integrationWebhookRoutes } from "./integration-webhooks.js";

const connectionId = "33333333-3333-3333-3333-333333333333";
const webhookPath = `/api/v1/integrations/connections/${connectionId}/wecom/webhook`;
const AES_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const CORP_ID = "wx5823bf96d3bd56c7";
const TOKEN = "callback-token-1";
const TS = "1409659813";
const NONCE = "1372623149";

function textXml(from = "zhangsan", msgId = "1234567890123456", content = "hello bot") {
  return (
    `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName>` +
    `<CreateTime>1348831860</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content>` +
    `<MsgId>${msgId}</MsgId><AgentID>1000002</AgentID></xml>`
  );
}

function encrypt(message: string, receiveId = CORP_ID): string {
  return encryptWecomMessageForTest({ encodingAesKey: AES_KEY, message, receiveId });
}

function envelope(encrypted: string): string {
  return `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>`;
}

function buildConnection(config: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    connectionId,
    revision: "rev-1",
    key: "wecom",
    enabled: true,
    status: "connected" as const,
    config: {
      corpId: CORP_ID,
      agentId: "1000002",
      callbackToken: TOKEN,
      encodingAesKey: AES_KEY,
      inboundAccessMode: "allowlist",
      allowedSenders: ["zhangsan"],
      ...config,
    },
    ...overrides,
  };
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

describe("WeCom webhook route", () => {
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

  function get(target: FastifyInstance, echostr: string, overrides: { signature?: string; token?: string } = {}) {
    const signature = overrides.signature ?? computeWecomSignature(overrides.token ?? TOKEN, TS, NONCE, echostr);
    const query = new URLSearchParams({ msg_signature: signature, timestamp: TS, nonce: NONCE, echostr });
    return target.inject({ method: "GET", url: `${webhookPath}?${query.toString()}` });
  }

  function post(
    target: FastifyInstance,
    xml: string,
    overrides: { signature?: string; token?: string; contentType?: string; encrypted?: string } = {},
  ) {
    const encrypted = overrides.encrypted ?? encrypt(xml);
    const signature = overrides.signature ?? computeWecomSignature(overrides.token ?? TOKEN, TS, NONCE, encrypted);
    const query = new URLSearchParams({ msg_signature: signature, timestamp: TS, nonce: NONCE });
    return target.inject({
      method: "POST",
      url: `${webhookPath}?${query.toString()}`,
      headers: { "content-type": overrides.contentType ?? "text/xml" },
      payload: envelope(encrypted),
    });
  }

  it("is classified as a webhook route for both GET and POST", async () => {
    const next = Fastify();
    installRouteAccessTracking(next);
    next.decorate("services", { integrationWebhooks: {} } as never);
    await next.register(integrationWebhookRoutes);
    app = next;
    for (const method of ["GET", "POST"]) {
      expect(
        next.routeAccessManifest.find(
          (entry) =>
            entry.method === method && entry.url === "/api/v1/integrations/connections/:connectionId/wecom/webhook",
        ),
      ).toMatchObject({ accessClass: "webhook", classificationSource: "policy" });
    }
  });

  it("GET with a good signature echoes the decrypted echostr as text/plain", async () => {
    const ctx = await buildApp();
    const echostr = encrypt("1616140317555161061");
    const response = await get(ctx.app, echostr);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toBe("1616140317555161061");
  });

  it("GET with a bad signature or wrong token gets 401 and reveals nothing", async () => {
    const ctx = await buildApp();
    const echostr = encrypt("secret-echo");
    for (const overrides of [{ signature: "0".repeat(40) }, { token: "wrong-token" }]) {
      const response = await get(ctx.app, echostr, overrides);
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain("secret-echo");
    }
  });

  it("GET with a validly signed echostr for a foreign CorpID gets 401", async () => {
    const ctx = await buildApp();
    const response = await get(ctx.app, encrypt("echo", "wxforeign"));
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('echo"');
  });

  it("GET returns 400 when the connection lacks callback credentials, and rejects other connector keys", async () => {
    const missing = await buildApp({ connection: buildConnection({ callbackToken: undefined }) });
    expect((await get(missing.app, encrypt("x"))).statusCode).toBe(400);
    await missing.app.close();
    app = null;
    const other = await buildApp({ connection: buildConnection({}, { key: "slack" }) });
    expect((await get(other.app, encrypt("x"))).statusCode).toBe(400);
  });

  it("POST with a bad signature gets 401 and never dispatches", async () => {
    const ctx = await buildApp();
    for (const overrides of [{ signature: "0".repeat(40) }, { token: "wrong-token" }]) {
      const response = await post(ctx.app, textXml(), overrides);
      expect(response.statusCode).toBe(401);
    }
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("POST with a decrypted payload for a foreign CorpID gets 401 and never dispatches", async () => {
    const ctx = await buildApp();
    const response = await post(ctx.app, textXml(), { encrypted: encrypt(textXml(), "wxforeign") });
    expect(response.statusCode).toBe(401);
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("POST with a malformed envelope or DTD gets 400 and never dispatches", async () => {
    const ctx = await buildApp();
    const noEncrypt = await ctx.app.inject({
      method: "POST",
      url: `${webhookPath}?msg_signature=${"0".repeat(40)}&timestamp=${TS}&nonce=${NONCE}`,
      headers: { "content-type": "application/xml" },
      payload: "<xml><AgentID>1</AgentID></xml>",
    });
    expect(noEncrypt.statusCode).toBe(400);
    const dtd = await ctx.app.inject({
      method: "POST",
      url: `${webhookPath}?msg_signature=${"0".repeat(40)}&timestamp=${TS}&nonce=${NONCE}`,
      headers: { "content-type": "text/xml" },
      payload: '<!DOCTYPE x [<!ENTITY e "v">]><xml><Encrypt>&e;</Encrypt></xml>',
    });
    expect(dtd.statusCode).toBe(400);
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("dispatches a text message once with the exact options and replies success", async () => {
    const ctx = await buildApp();
    const response = await post(ctx.app, textXml());
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("success");
    expect(ctx.acceptInboundChannelEvent).toHaveBeenCalledTimes(1);
    const call = ctx.acceptInboundChannelEvent.mock.calls[0]?.[0] as DurableInboundChannelAcceptInput;
    expect(call).toMatchObject({
      channel: "wecom",
      connectionId,
      idempotencyKey: `wecom:${connectionId}:1234567890123456`,
      bindingTarget: "user:zhangsan",
      dispatchKind: "agent_turn",
      acceptedConnectionRevision: "rev-1",
      message: {
        eventId: "1234567890123456",
        account: connectionId,
        room: "user:zhangsan",
        actorId: "zhangsan",
        content: "hello bot",
      },
    });
    const serialized = JSON.stringify(call);
    expect(serialized).not.toContain(AES_KEY);
    expect(serialized).not.toContain(TOKEN);
  });

  it("also accepts application/xml", async () => {
    const ctx = await buildApp();
    const response = await post(ctx.app, textXml(), { contentType: "application/xml; charset=utf-8" });
    expect(response.statusCode).toBe(200);
    expect(ctx.acceptInboundChannelEvent).toHaveBeenCalledTimes(1);
  });

  it("keeps the XML parser scoped to the WeCom routes: XML to another channel route is still unsupported", async () => {
    const ctx = await buildApp();
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/integrations/connections/${connectionId}/qqbot/webhook`,
      headers: { "content-type": "text/xml" },
      payload: "<xml/>",
    });
    expect(response.statusCode).toBe(415);
  });

  it("surfaces a replayed delivery as deduped by the ingest idempotency key", async () => {
    const seen = new Set<string>();
    const accept = vi.fn(async (event: DurableInboundChannelAcceptInput) => {
      const deduped = seen.has(event.idempotencyKey);
      seen.add(event.idempotencyKey);
      return acceptedResult(event, deduped);
    });
    const ctx = await buildApp({ acceptInboundChannelEvent: accept });
    await post(ctx.app, textXml());
    await post(ctx.app, textXml());
    const results = await Promise.all(accept.mock.results.map((r) => r.value));
    expect(results.map((r) => r.deduped)).toEqual([false, true]);
  });

  it("drops a FromUserName that is not on the allowlist", async () => {
    const ctx = await buildApp();
    const response = await post(ctx.app, textXml("stranger"));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("success");
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
      const response = await post(ctx.app, textXml());
      expect(response.statusCode).toBe(200);
      expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
      expect(ctx.recordDevDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ event: "channel.inbound_allowlist_empty" }),
      );
      await ctx.app.close();
      app = null;
    }
  });

  it("acks events and non-text messages with success without dispatching", async () => {
    const ctx = await buildApp();
    const event = `<xml><FromUserName>zhangsan</FromUserName><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event></xml>`;
    const response = await post(ctx.app, event);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("success");
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("returns 503 without leaking error text when durable acceptance fails, so WeCom retries", async () => {
    const accept = vi.fn(async () => {
      throw new Error("storage path C:/secret/inbound.db is locked");
    });
    const ctx = await buildApp({ acceptInboundChannelEvent: accept });
    const response = await post(ctx.app, textXml());
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("inbound.db");
  });

  it("returns 400 when the connection lacks callback credentials", async () => {
    const ctx = await buildApp({ connection: buildConnection({ encodingAesKey: undefined }) });
    const response = await post(ctx.app, textXml());
    expect(response.statusCode).toBe(400);
    expect(ctx.acceptInboundChannelEvent).not.toHaveBeenCalled();
  });

  it("passes gateway auth and idempotency plugins without operator credentials (GET and POST)", async () => {
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

    const verified = await get(next, encrypt("ping"));
    expect(verified.statusCode).toBe(200);
    expect(verified.body).toBe("ping");
    const delivered = await post(next, textXml());
    expect(delivered.statusCode).toBe(200);
    expect(accept).toHaveBeenCalledTimes(1);
  });
});
