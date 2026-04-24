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
