import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { gatewayEventsRoute } from "./gateway-events.js";

describe("gateway events route", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("passes a stable idempotency key through and preserves duplicate semantics", async () => {
    const seen = new Set<string>();
    const ingestEvent = vi.fn((idempotencyKey: string) => {
      const deduped = seen.has(idempotencyKey);
      seen.add(idempotencyKey);
      return { deduped };
    });

    app = Fastify();
    app.addHook("preHandler", async (request) => {
      (request as typeof request & { idempotencyKey: string }).idempotencyKey = String(
        request.headers["idempotency-key"] ?? "",
      );
    });
    app.decorate("services", { gatewayEvents: { ingestEvent } } as never);
    await app.register(gatewayEventsRoute);

    const payload = createGatewayEventPayload();
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/gateway/events",
      headers: { "Idempotency-Key": "gateway-events-route-test-1" },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/gateway/events",
      headers: { "Idempotency-Key": "gateway-events-route-test-1" },
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ deduped: false });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ deduped: true });
    expect(ingestEvent).toHaveBeenCalledWith("gateway-events-route-test-1", payload);
  });

  it("rejects malformed payloads before ingestion", async () => {
    const ingestEvent = vi.fn();

    app = Fastify();
    app.decorate("services", { gatewayEvents: { ingestEvent } } as never);
    await app.register(gatewayEventsRoute);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/gateway/events",
      headers: { "Idempotency-Key": "gateway-events-route-test-2" },
      payload: {
        eventId: "evt-bad",
        route: { channel: "webchat", account: "operator" },
        actor: { type: "user", id: "operator" },
        message: { role: "user", content: "" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(ingestEvent).not.toHaveBeenCalled();
  });

  it("projects event-ingress result state without changing the raw user payload or stored result", async () => {
    const result = {
      accepted: true,
      deduped: false,
      session: {
        sessionId: "session-secret",
        sessionKey: "mission:operator:secret",
        kind: "dm",
        channel: "mission",
        account: "operator",
        routingHints: {
          authorization: "Bearer ingress-routing-secret",
          tokenEnv: "INGRESS_TOKEN",
          secretRef: "keychain:ingress-token",
        },
        lastActivityAt: "2026-07-09T12:00:00.000Z",
        updatedAt: "2026-07-09T12:00:00.000Z",
        health: "healthy",
        tokenInput: 2,
        tokenOutput: 3,
        tokenCachedInput: 1,
        tokenTotal: 5,
        costUsdTotal: 0.001,
        budgetState: "ok",
      },
      transcriptOffset: 10,
      errorMetadata: { DATABASE_PASSWORD: "ingress-error-secret" },
    };
    const ingestEvent = vi.fn(async () => result);
    app = Fastify();
    app.addHook("preHandler", async (request) => {
      (request as typeof request & { idempotencyKey: string }).idempotencyKey = "ingress-projection-key";
    });
    app.decorate("services", { gatewayEvents: { ingestEvent } } as never);
    await app.register(gatewayEventsRoute);
    const payload = createGatewayEventPayload();
    payload.message.content = "User intentionally supplied Bearer ingress-user-secret";

    const response = await app.inject({ method: "POST", url: "/api/v1/gateway/events", payload });

    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json())).not.toContain("ingress-routing-secret");
    expect(JSON.stringify(response.json())).not.toContain("ingress-error-secret");
    expect(response.json().session).toMatchObject({
      tokenInput: 2,
      tokenOutput: 3,
      tokenCachedInput: 1,
      tokenTotal: 5,
      routingHints: {
        tokenEnv: "INGRESS_TOKEN",
        secretRef: "keychain:ingress-token",
      },
    });
    expect(ingestEvent).toHaveBeenCalledWith("ingress-projection-key", payload);
    expect(payload.message.content).toContain("ingress-user-secret");
    expect(result.session.routingHints.authorization).toContain("ingress-routing-secret");
    expect(result.errorMetadata.DATABASE_PASSWORD).toBe("ingress-error-secret");
  });
});

function createGatewayEventPayload() {
  return {
    eventId: "evt-route-test",
    route: {
      channel: "webchat",
      account: "operator",
      peer: "assistant",
    },
    actor: {
      type: "user",
      id: "operator",
    },
    message: {
      role: "user",
      content: "hello route",
    },
    usage: {
      inputTokens: 2,
      outputTokens: 3,
      costUsd: 0.001,
    },
  };
}
