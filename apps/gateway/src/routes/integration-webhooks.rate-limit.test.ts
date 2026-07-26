import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableInboundChannelAcceptInput } from "../services/channel-inbound-dispatch.js";
import { buildGenericChannelInboundSignature } from "../services/generic-channel-webhook.js";
import { isLoopbackRateLimitAllowlisted } from "../services/webhook-rate-limit.js";
import { integrationWebhookRoutes } from "./integration-webhooks.js";

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";
const INGRESS_MAX = 4;
const ACCEPTED_MAX = 2;
const ENV_KEYS = ["GOATCITADEL_RATE_LIMIT_MAX_WEBHOOK_INGRESS", "GOATCITADEL_RATE_LIMIT_MAX_WEBHOOK_ACCEPTED"] as const;
const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

describe("signed webhook staged rate limits", () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    process.env.GOATCITADEL_RATE_LIMIT_MAX_WEBHOOK_INGRESS = String(INGRESS_MAX);
    process.env.GOATCITADEL_RATE_LIMIT_MAX_WEBHOOK_ACCEPTED = String(ACCEPTED_MAX);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  it("keeps invalid generic HMAC traffic out of the accepted-callback bucket", async () => {
    const ingestChannelMessage = vi.fn(async () => ({ accepted: true }));
    const acceptInboundChannelEvent = vi.fn(async (input: DurableInboundChannelAcceptInput) => ({
      accepted: true as const,
      durableAccepted: true as const,
      deduped: false,
      replied: false as const,
      queued: true,
      eventType: input.eventType,
      inboundEventId: `inbound-${input.message.eventId}`,
    }));
    app = await buildRateLimitedWebhookApp({
      getIntegrationConnection: vi.fn(() => ({
        connectionId: CONNECTION_ID,
        key: "discord",
        enabled: true,
        status: "connected",
        config: { inboundSecret: "generic-secret" },
      })),
      acceptInboundChannelEvent,
      ingestChannelMessage,
      recordDevDiagnostic: vi.fn(),
    });

    const invalidIp = "203.0.113.80";
    const invalidStatuses: number[] = [];
    for (let attempt = 0; attempt < ACCEPTED_MAX + 1; attempt += 1) {
      const response = await injectGeneric(app, invalidIp, `invalid-${attempt}`, false);
      invalidStatuses.push(response.statusCode);
    }
    expect(invalidStatuses).toEqual([401, 401, 401]);

    const validAfterInvalid = await injectGeneric(app, invalidIp, "valid-after-invalid", true);
    expect(validAfterInvalid.statusCode).toBe(200);
    expect(validAfterInvalid.headers["x-ratelimit-limit"]).toBe(String(ACCEPTED_MAX));
    expect(validAfterInvalid.headers["x-ratelimit-remaining"]).toBe("1");

    const ingressOverflow = await injectGeneric(app, invalidIp, "ingress-overflow", false);
    expect(ingressOverflow.statusCode).toBe(429);
    expect(ingressOverflow.headers["x-ratelimit-limit"]).toBe(String(INGRESS_MAX));

    const acceptedIp = "203.0.113.81";
    const first = await injectGeneric(app, acceptedIp, "accepted-1", true);
    const second = await injectGeneric(app, acceptedIp, "accepted-2", true);
    const exhausted = await injectGeneric(app, acceptedIp, "accepted-3", true);

    expect([first.statusCode, second.statusCode, exhausted.statusCode]).toEqual([200, 200, 429]);
    expect(exhausted.headers["x-ratelimit-limit"]).toBe(String(ACCEPTED_MAX));
    expect(exhausted.headers["x-ratelimit-remaining"]).toBe("0");
    expect(Number(exhausted.headers["x-ratelimit-reset"])).toBeGreaterThan(0);
    expect(Number(exhausted.headers["retry-after"])).toBeGreaterThan(0);
    expect(exhausted.json()).toMatchObject({
      error: "Accepted webhook callback rate limit exceeded",
      retryAfterSeconds: expect.any(Number),
    });

    const proxyHeaders = { "x-forwarded-for": "203.0.113.82" };
    const proxiedFirst = await injectGeneric(app, "127.0.0.1", "proxied-1", true, proxyHeaders);
    const proxiedSecond = await injectGeneric(app, "127.0.0.1", "proxied-2", true, proxyHeaders);
    const proxiedExhausted = await injectGeneric(app, "127.0.0.1", "proxied-3", true, proxyHeaders);
    expect([proxiedFirst.statusCode, proxiedSecond.statusCode, proxiedExhausted.statusCode]).toEqual([200, 200, 429]);
    expect(proxiedExhausted.headers["x-ratelimit-limit"]).toBe(String(ACCEPTED_MAX));

    const loopbackStatuses: number[] = [];
    for (let attempt = 0; attempt < ACCEPTED_MAX + 1; attempt += 1) {
      loopbackStatuses.push((await injectGeneric(app, "127.0.0.1", `loopback-${attempt}`, true)).statusCode);
    }
    expect(loopbackStatuses).toEqual([200, 200, 200]);

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const liveBody = JSON.stringify({
      eventId: "accepted-live-overflow",
      account: CONNECTION_ID,
      actorId: "operator-1",
      content: "hello",
    });
    const liveTimestamp = String(Math.floor(Date.now() / 1000));
    const liveExceeded = await fetch(
      new URL(`/api/v1/integrations/connections/${CONNECTION_ID}/discord/inbound`, `${address}/`),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.82",
          "x-goatcitadel-channel-timestamp": liveTimestamp,
          "x-goatcitadel-channel-signature": buildGenericChannelInboundSignature(
            liveTimestamp,
            liveBody,
            "generic-secret",
          ),
        },
        body: liveBody,
      },
    );
    expect(liveExceeded.status).toBe(429);
    expect(await liveExceeded.json()).toMatchObject({ error: "Accepted webhook callback rate limit exceeded" });

    const health = await fetch(new URL("/health/rate-limit-proof", `${address}/`));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect(acceptInboundChannelEvent).toHaveBeenCalledTimes(8);
    expect(ingestChannelMessage).not.toHaveBeenCalled();
  });

  it("does not let unverified generic channel params partition the coarse ingress bucket", async () => {
    process.env.GOATCITADEL_RATE_LIMIT_MAX_WEBHOOK_INGRESS = "2";
    app = await buildRateLimitedWebhookApp({
      getIntegrationConnection: vi.fn(() => ({
        connectionId: CONNECTION_ID,
        key: "discord",
        enabled: true,
        status: "connected",
        config: { inboundSecret: "generic-secret" },
      })),
    });

    const statuses: number[] = [];
    for (const channel of ["rotating-a", "rotating-b", "rotating-c", "rotating-d"]) {
      statuses.push((await injectGeneric(app, "203.0.113.85", channel, false, {}, channel)).statusCode);
    }

    expect(statuses).toEqual([400, 400, 429, 429]);
  });

  it("keeps invalid shared-factory provider secrets out of the accepted bucket", async () => {
    app = await buildRateLimitedWebhookApp({
      getIntegrationConnection: vi.fn(() => ({
        connectionId: CONNECTION_ID,
        key: "telegram",
        enabled: true,
        status: "connected",
        config: { webhookSecret: "telegram-secret" },
      })),
    });

    const invalidIp = "203.0.113.90";
    const invalidStatuses: number[] = [];
    for (let attempt = 0; attempt < ACCEPTED_MAX + 1; attempt += 1) {
      const response = await injectTelegram(app, invalidIp, `wrong-${attempt}`);
      invalidStatuses.push(response.statusCode);
    }
    expect(invalidStatuses).toEqual([401, 401, 401]);

    const validAfterInvalid = await injectTelegram(app, invalidIp, "telegram-secret");
    expect(validAfterInvalid.statusCode).toBe(200);
    expect(validAfterInvalid.headers["x-ratelimit-limit"]).toBe(String(ACCEPTED_MAX));
    expect(validAfterInvalid.headers["x-ratelimit-remaining"]).toBe("1");

    const acceptedIp = "203.0.113.91";
    const first = await injectTelegram(app, acceptedIp, "telegram-secret");
    const second = await injectTelegram(app, acceptedIp, "telegram-secret");
    const exhausted = await injectTelegram(app, acceptedIp, "telegram-secret");

    expect([first.statusCode, second.statusCode, exhausted.statusCode]).toEqual([200, 200, 429]);
    expect(exhausted.headers["x-ratelimit-limit"]).toBe(String(ACCEPTED_MAX));
    expect(exhausted.headers["x-ratelimit-remaining"]).toBe("0");
    expect(Number(exhausted.headers["x-ratelimit-reset"])).toBeGreaterThan(0);
    expect(Number(exhausted.headers["retry-after"])).toBeGreaterThan(0);
  });
});

async function buildRateLimitedWebhookApp(integrationWebhooks: Record<string, unknown>): Promise<FastifyInstance> {
  const next = Fastify();
  next.addHook("preSerialization", async (_request, _reply, payload) => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return payload;
  });
  await next.register(rateLimit, {
    global: false,
    timeWindow: "1 minute",
    max: INGRESS_MAX,
    skipOnError: true,
    allowList: (request) => isLoopbackRateLimitAllowlisted(request.ip, request),
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
    },
  });
  next.decorate("services", {
    integrationWebhooks: {
      acceptInboundChannelEvent: async (input: DurableInboundChannelAcceptInput) => ({
        accepted: true,
        durableAccepted: true,
        deduped: false,
        replied: false,
        queued: true,
        eventType: input.eventType,
        inboundEventId: `inbound-${input.message.eventId}`,
      }),
      ...integrationWebhooks,
    },
  } as never);
  next.get("/health/rate-limit-proof", async () => ({ ok: true }));
  await next.register(integrationWebhookRoutes);
  return next;
}

async function injectGeneric(
  app: FastifyInstance,
  remoteAddress: string,
  eventId: string,
  valid: boolean,
  extraHeaders: Record<string, string> = {},
  channel = "discord",
) {
  const body = JSON.stringify({
    eventId,
    account: CONNECTION_ID,
    actorId: "operator-1",
    content: "hello",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return app.inject({
    method: "POST",
    url: `/api/v1/integrations/connections/${CONNECTION_ID}/${channel}/inbound`,
    remoteAddress,
    headers: {
      "content-type": "application/json",
      "x-goatcitadel-channel-timestamp": timestamp,
      "x-goatcitadel-channel-signature": valid
        ? buildGenericChannelInboundSignature(timestamp, body, "generic-secret")
        : "v1=invalid",
      ...extraHeaders,
    },
    payload: body,
  });
}

async function injectTelegram(app: FastifyInstance, remoteAddress: string, secret: string) {
  const options: InjectOptions = {
    method: "POST",
    url: `/api/v1/integrations/connections/${CONNECTION_ID}/telegram/webhook`,
    remoteAddress,
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    payload: JSON.stringify({ update_id: 1 }),
  };
  return app.inject(options);
}
