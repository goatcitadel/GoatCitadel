import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { __internal, eventsRoutes } from "./events.js";

describe("events routes additional coverage", () => {
  let app: FastifyInstance | null = null;
  const originalSseConnectionLimit = process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP;

  afterEach(async () => {
    if (originalSseConnectionLimit === undefined) {
      delete process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP;
    } else {
      process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP = originalSseConnectionLimit;
    }
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("lists realtime events with cursor pagination and reports replay gaps", async () => {
    const realtimeEvents = {
      getRealtimeEventSequenceBounds: vi.fn(async () => ({ oldestSequence: 10, newestSequence: 42 })),
      listRealtimeEvents: vi.fn(async () => [
        { eventId: "event-1", sequence: 41 },
        { eventId: "event-2", sequence: 42 },
      ]),
    };
    app = buildApp(realtimeEvents);

    const listed = await app.inject({ method: "GET", url: "/api/v1/events?limit=2&cursor=40" });
    const gap = await app.inject({ method: "GET", url: "/api/v1/events?limit=2&cursor=5" });
    const invalid = await app.inject({ method: "GET", url: "/api/v1/events?limit=0" });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      items: [
        { eventId: "event-1", sequence: 41 },
        { eventId: "event-2", sequence: 42 },
      ],
      nextCursor: "42",
    });
    expect(realtimeEvents.listRealtimeEvents).toHaveBeenCalledWith(2, "40");
    expect(gap.statusCode).toBe(409);
    expect(gap.json()).toEqual({
      error: "replay_gap",
      requestedCursor: "5",
      oldestCursor: "10",
      newestCursor: "42",
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("falls back for invalid cursors and resolves SSE connection limits from the environment", async () => {
    process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP = "not-a-number";
    app = buildApp({
      getRealtimeEventSequenceBounds: vi.fn(async () => ({ oldestSequence: 10, newestSequence: undefined })),
      listRealtimeEvents: vi.fn(async () => []),
    });

    const invalidCursor = await app.inject({ method: "GET", url: "/api/v1/events?cursor=abc&limit=1" });

    expect(invalidCursor.statusCode).toBe(200);
    expect(__internal.normalizeSseConnectionKey("FE80::1%Loopback")).toBe("fe80::1");
    expect(__internal.resolveMaxSseConnectionsPerIp()).toBe(25);
    process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP = "7";
    expect(__internal.resolveMaxSseConnectionsPerIp()).toBe(7);
  });
});

function buildApp(realtimeEvents: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", { realtimeEvents } as never);
  next.decorate("requireOperatorAuth", async () => undefined);
  void next.register(eventsRoutes);
  return next;
}
