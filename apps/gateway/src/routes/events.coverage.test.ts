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

  it("preserves the backward REST cursor gap at the pruned floor when a retained suffix exists", async () => {
    const retained = { eventId: "event-11", sequence: 11 };
    app = buildApp({
      getRealtimeEventSequenceBounds: () => ({ oldestSequence: 11, newestSequence: 11, lastPrunedSequence: 10 }),
      listRealtimeEvents: (_limit: number, cursor: string) => retained.sequence < Number(cursor) ? [retained] : [],
    });

    const retainedPage = await app.inject({ method: "GET", url: "/api/v1/events?cursor=12" });
    const atOldest = await app.inject({ method: "GET", url: "/api/v1/events?cursor=11" });
    const atPrunedFloor = await app.inject({ method: "GET", url: "/api/v1/events?cursor=10" });

    expect(retainedPage.statusCode).toBe(200);
    expect(retainedPage.json()).toEqual({ items: [retained] });
    expect(atOldest.statusCode).toBe(200);
    expect(atOldest.json()).toEqual({ items: [] });
    expect(atPrunedFloor.statusCode).toBe(409);
    expect(atPrunedFloor.json()).toEqual({
      error: "replay_gap",
      requestedCursor: "10",
      oldestCursor: "11",
      newestCursor: "11",
      lastPrunedCursor: "10",
    });
  });

  it("reports a REST gap below the floor while preserving empty-store equality", async () => {
    app = buildApp({
      getRealtimeEventSequenceBounds: () => ({ lastPrunedSequence: 10 }),
      listRealtimeEvents: () => [],
    });
    const lost = await app.inject({ method: "GET", url: "/api/v1/events?cursor=9" });
    const atFloor = await app.inject({ method: "GET", url: "/api/v1/events?cursor=10" });
    expect(lost.statusCode).toBe(409);
    expect(lost.json()).toMatchObject({ error: "replay_gap", requestedCursor: "9", lastPrunedCursor: "10" });
    expect(atFloor.statusCode).toBe(200);
    expect(atFloor.json()).toEqual({ items: [] });
  });

  it("rechecks retention after listing when pruning advances during the REST read", async () => {
    let reads = 0;
    const getRealtimeEventSequenceBounds = vi.fn(() => ++reads === 1
      ? { oldestSequence: 1, newestSequence: 3 }
      : { lastPrunedSequence: 3 });
    app = buildApp({ getRealtimeEventSequenceBounds, listRealtimeEvents: () => [] });
    const response = await app.inject({ method: "GET", url: "/api/v1/events?cursor=2" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "replay_gap", requestedCursor: "2", lastPrunedCursor: "3" });
    expect(getRealtimeEventSequenceBounds).toHaveBeenCalledTimes(2);
  });
});

function buildApp(realtimeEvents: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", { realtimeEvents } as never);
  next.decorate("requireOperatorAuth", async () => undefined);
  void next.register(eventsRoutes);
  return next;
}
