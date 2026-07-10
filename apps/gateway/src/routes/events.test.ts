import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { canReceiveApprovalActionTokens, eventsRoutes } from "./events.js";

function decorateRealtimeEvents(app: FastifyInstance, methods: Record<string, unknown>) {
  app.decorate("services", { realtimeEvents: methods } as never);
}

describe("events stream route", () => {
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

  it("limits live approval action tokens to operator-derived or direct-loopback streams", () => {
    const request = (authActorSource: string, remoteAddress = "203.0.113.5", headers = {}) => ({
      authActorSource,
      headers,
      raw: { socket: { remoteAddress } },
    });

    for (const source of ["token", "basic", "loopback", "sse"]) {
      expect(canReceiveApprovalActionTokens(request(source))).toBe(true);
    }
    for (const source of ["companion", "device", "a2a_peer"]) {
      expect(canReceiveApprovalActionTokens(request(source))).toBe(false);
    }
    expect(canReceiveApprovalActionTokens(request("none", "127.0.0.1"))).toBe(true);
    expect(canReceiveApprovalActionTokens(request("none", "::1"))).toBe(true);
    expect(canReceiveApprovalActionTokens(request("none"))).toBe(false);
    expect(canReceiveApprovalActionTokens(request("none", "127.0.0.1", { "x-forwarded-for": "198.51.100.8" }))).toBe(
      false,
    );
  });

  it("returns CORS headers for allowed origins on SSE stream responses", async () => {
    app = Fastify();
    await app.register(cors, {
      origin: (origin, cb) => {
        if (!origin || origin === "http://localhost:5173") {
          cb(null, true);
          return;
        }
        cb(new Error("blocked"), false);
      },
    });
    decorateRealtimeEvents(app, {
      listRealtimeEvents: () => [],
      listRealtimeEventsAfterSequence: () => [],
      getRealtimeEventSequenceBounds: () => ({ oldestSequence: 10, newestSequence: 12 }),
      subscribeRealtime: () => () => undefined,
      openRealtimeStreamLease: () => ({
        leaseId: "lease-1",
        clientId: "client-1",
        gatewayNodeId: "node-1",
      }),
      touchRealtimeStreamLease: () => undefined,
      closeRealtimeStreamLease: () => undefined,
    });
    await app.register(eventsRoutes);

    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const response = await fetch(`${address}/api/v1/events/stream?replay=1`, {
      headers: {
        Origin: "http://localhost:5173",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await reader!.read();
    const text = new TextDecoder().decode(chunk.value ?? new Uint8Array());
    expect(text.includes(": connected")).toBe(true);
    await reader!.cancel();
  });

  it("emits SSE event ids from the realtime sequence", async () => {
    app = Fastify();
    await app.register(cors, { origin: true });
    decorateRealtimeEvents(app, {
      listRealtimeEvents: () => [
        {
          eventId: "event-1",
          sequence: 42,
          eventType: "system",
          source: "tests",
          timestamp: "2026-03-20T10:00:00.000Z",
          payload: { ok: true },
        },
      ],
      listRealtimeEventsAfterSequence: () => [],
      getRealtimeEventSequenceBounds: () => ({ oldestSequence: 42, newestSequence: 42 }),
      subscribeRealtime: () => () => undefined,
      openRealtimeStreamLease: () => ({
        leaseId: "lease-2",
        clientId: "client-2",
        gatewayNodeId: "node-2",
      }),
      touchRealtimeStreamLease: () => undefined,
      closeRealtimeStreamLease: () => undefined,
    });
    await app.register(eventsRoutes);

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/v1/events/stream?replay=1`);

    expect(response.status).toBe(200);
    const text = await readSseUntil(response, (buffer) => buffer.includes('"leaseId":"lease-2"'));
    expect(text.includes("id: 42")).toBe(true);
    expect(text.includes('"sequence":42')).toBe(true);
    expect(text.includes("event: stream-ready")).toBe(true);
    expect(text.includes('"leaseId":"lease-2"')).toBe(true);
  });

  it("signals replay gaps when the requested cursor falls behind retention", async () => {
    app = Fastify();
    await app.register(cors, { origin: true });
    decorateRealtimeEvents(app, {
      listRealtimeEvents: () => [],
      listRealtimeEventsAfterSequence: () => [],
      getRealtimeEventSequenceBounds: () => ({ oldestSequence: 100, newestSequence: 150 }),
      subscribeRealtime: () => () => undefined,
      openRealtimeStreamLease: () => ({
        leaseId: "lease-3",
        clientId: "client-3",
        gatewayNodeId: "node-3",
      }),
      touchRealtimeStreamLease: () => undefined,
      closeRealtimeStreamLease: () => undefined,
    });
    await app.register(eventsRoutes);

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/v1/events/stream?afterCursor=50`);

    expect(response.status).toBe(200);
    const text = await readSseUntil(response, (buffer) => buffer.includes('"oldestCursor":100'));
    expect(text.includes("event: replay-gap")).toBe(true);
    expect(text.includes('"oldestCursor":100')).toBe(true);
  });

  it("signals replay gaps when retained replay is truncated before the newest sequence", async () => {
    app = Fastify();
    await app.register(cors, { origin: true });
    const replay = Array.from({ length: 500 }, (_, index) => ({
      eventId: `event-${index + 101}`,
      sequence: index + 101,
      eventType: "system",
      source: "tests",
      timestamp: "2026-03-20T10:00:00.000Z",
      payload: { index },
    }));
    const closeRealtimeStreamLease = vi.fn();
    decorateRealtimeEvents(app, {
      listRealtimeEvents: () => [],
      listRealtimeEventsAfterSequence: () => replay,
      getRealtimeEventSequenceBounds: () => ({ oldestSequence: 100, newestSequence: 700 }),
      subscribeRealtime: () => () => undefined,
      openRealtimeStreamLease: () => ({
        leaseId: "lease-truncated",
        clientId: "client-truncated",
        gatewayNodeId: "node-truncated",
      }),
      touchRealtimeStreamLease: () => undefined,
      closeRealtimeStreamLease,
    });
    await app.register(eventsRoutes);

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/v1/events/stream?afterCursor=100`);

    expect(response.status).toBe(200);
    const text = await readSseText(response);
    expect(text).toContain("event: replay-gap");
    expect(text).toContain('"reason":"replay_window_truncated"');
    expect(text).toContain('"lastReplayCursor":600');
    expect(text).not.toContain("event: stream-ready");
    expect(text).not.toContain("id: 101");
    expect(closeRealtimeStreamLease).toHaveBeenCalledWith({
      leaseId: "lease-truncated",
      closeReason: "replay_gap",
    });
  });

  it("rejects concurrent SSE streams beyond the per-client cap and frees slots on disconnect", async () => {
    process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP = "1";
    app = Fastify();
    await app.register(cors, { origin: true });
    decorateRealtimeEvents(app, {
      listRealtimeEvents: () => [],
      listRealtimeEventsAfterSequence: () => [],
      getRealtimeEventSequenceBounds: () => ({ oldestSequence: 10, newestSequence: 12 }),
      subscribeRealtime: () => () => undefined,
      openRealtimeStreamLease: () => ({
        leaseId: "lease-limit",
        clientId: "client-limit",
        gatewayNodeId: "node-limit",
      }),
      touchRealtimeStreamLease: () => undefined,
      closeRealtimeStreamLease: () => undefined,
    });
    await app.register(eventsRoutes);

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const first = await fetch(`${address}/api/v1/events/stream?replay=1`);
    expect(first.status).toBe(200);
    const firstReader = first.body?.getReader();
    expect(firstReader).toBeDefined();
    await firstReader!.read();

    const blocked = await fetch(`${address}/api/v1/events/stream?replay=1`);
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toMatchObject({
      code: "SSE_CONNECTION_LIMIT",
      limit: 1,
    });

    await firstReader!.cancel();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const afterDisconnect = await fetch(`${address}/api/v1/events/stream?replay=1`);
    expect(afterDisconnect.status).toBe(200);
    await afterDisconnect.body?.cancel();
  });

  it("delivers events published during replay exactly once and in order (INFRA-003)", async () => {
    app = Fastify();
    await app.register(cors, { origin: true });
    let liveListener: ((event: Record<string, unknown>) => void) | null = null;
    const replayEvents = [
      {
        eventId: "event-1",
        sequence: 1,
        eventType: "system",
        source: "tests",
        timestamp: "2026-03-20T10:00:01.000Z",
        payload: { n: 1 },
      },
      {
        eventId: "event-2",
        sequence: 2,
        eventType: "system",
        source: "tests",
        timestamp: "2026-03-20T10:00:02.000Z",
        payload: { n: 2 },
      },
    ];
    decorateRealtimeEvents(app, {
      // The snapshot read fires a live event *after* the listener has attached
      // but *before* the snapshot is returned — exactly the gap window that used
      // to silently drop events.
      listRealtimeEvents: () => {
        liveListener?.({
          eventId: "event-3",
          sequence: 3,
          eventType: "system",
          source: "tests",
          timestamp: "2026-03-20T10:00:03.000Z",
          payload: { n: 3 },
        });
        // Handler reverses the default-replay snapshot, so return descending.
        return [...replayEvents].reverse();
      },
      listRealtimeEventsAfterSequence: () => [],
      getRealtimeEventSequenceBounds: () => ({ oldestSequence: 1, newestSequence: 3 }),
      subscribeRealtime: (listener: (event: Record<string, unknown>) => void) => {
        liveListener = listener;
        return () => {
          liveListener = null;
        };
      },
      openRealtimeStreamLease: () => ({
        leaseId: "lease-gap",
        clientId: "client-gap",
        gatewayNodeId: "node-gap",
      }),
      touchRealtimeStreamLease: () => undefined,
      closeRealtimeStreamLease: () => undefined,
    });
    await app.register(eventsRoutes);

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/v1/events/stream?replay=50`);
    expect(response.status).toBe(200);

    const text = await readSseUntil(response, (buffer) => buffer.includes('"replayedEventCount":3'));

    // The event published during replay is delivered exactly once...
    expect(occurrences(text, '"sequence":3')).toBe(1);
    // ...after the two replayed events, preserving ascending order...
    expect(text.indexOf('"sequence":1')).toBeLessThan(text.indexOf('"sequence":2'));
    expect(text.indexOf('"sequence":2')).toBeLessThan(text.indexOf('"sequence":3'));
    // ...and before stream-ready, which reports the buffered event in its tally.
    expect(text.indexOf('"sequence":3')).toBeLessThan(text.indexOf("event: stream-ready"));
    expect(text).toContain('"replayedEventCount":3');
    expect(text).toContain('"lastSentSequence":3');
  });

  it("does not double-deliver an event present in both the snapshot and the live buffer", async () => {
    app = Fastify();
    await app.register(cors, { origin: true });
    let liveListener: ((event: Record<string, unknown>) => void) | null = null;
    const replayEvents = [
      {
        eventId: "event-11",
        sequence: 11,
        eventType: "system",
        source: "tests",
        timestamp: "2026-03-20T10:00:11.000Z",
        payload: { n: 11 },
      },
      {
        eventId: "event-12",
        sequence: 12,
        eventType: "system",
        source: "tests",
        timestamp: "2026-03-20T10:00:12.000Z",
        payload: { n: 12, deliveryToken: "redacted-replay" },
      },
    ];
    decorateRealtimeEvents(app, {
      listRealtimeEvents: () => [],
      listRealtimeEventsAfterSequence: () => {
        // seq 12 is already in the snapshot (overlap); seq 13 is genuinely new.
        liveListener?.({
          eventId: "event-12",
          sequence: 12,
          eventType: "system",
          source: "tests",
          timestamp: "2026-03-20T10:00:12.000Z",
          payload: { n: 12, deliveryToken: "raw-live" },
        });
        liveListener?.({
          eventId: "event-13",
          sequence: 13,
          eventType: "system",
          source: "tests",
          timestamp: "2026-03-20T10:00:13.000Z",
          payload: { n: 13 },
        });
        return replayEvents;
      },
      // Bounds are sampled before the snapshot/live publish, so newest is 12;
      // seq 13 only exists because it was published during the snapshot read.
      getRealtimeEventSequenceBounds: () => ({ oldestSequence: 10, newestSequence: 12 }),
      subscribeRealtime: (listener: (event: Record<string, unknown>) => void) => {
        liveListener = listener;
        return () => {
          liveListener = null;
        };
      },
      openRealtimeStreamLease: () => ({
        leaseId: "lease-dedup",
        clientId: "client-dedup",
        gatewayNodeId: "node-dedup",
      }),
      touchRealtimeStreamLease: () => undefined,
      closeRealtimeStreamLease: () => undefined,
    });
    await app.register(eventsRoutes);

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/v1/events/stream?afterCursor=10`);
    expect(response.status).toBe(200);

    const text = await readSseUntil(response, (buffer) => buffer.includes('"lastSentSequence":13'));

    // The overlapping event (seq 12) is delivered exactly once...
    expect(occurrences(text, '"sequence":12')).toBe(1);
    // ...using the live version so transient approval capabilities are not
    // replaced by their retained redacted projection during snapshot overlap.
    expect(text).toContain('"deliveryToken":"raw-live"');
    expect(text).not.toContain('"deliveryToken":"redacted-replay"');
    // ...the new buffered event (seq 13) exactly once...
    expect(occurrences(text, '"sequence":13')).toBe(1);
    // ...in ascending order, with seq 13 (flushed) before stream-ready.
    expect(text.indexOf('"sequence":11')).toBeLessThan(text.indexOf('"sequence":12'));
    expect(text.indexOf('"sequence":12')).toBeLessThan(text.indexOf('"sequence":13'));
    expect(text.indexOf('"sequence":13')).toBeLessThan(text.indexOf("event: stream-ready"));
    expect(text).toContain('"lastSentSequence":13');
  });

  it("allows startup reconnect bursts above five active streams by default", async () => {
    delete process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP;
    app = Fastify();
    await app.register(cors, { origin: true });
    let leaseIndex = 0;
    decorateRealtimeEvents(app, {
      listRealtimeEvents: () => [],
      listRealtimeEventsAfterSequence: () => [],
      getRealtimeEventSequenceBounds: () => ({ oldestSequence: 10, newestSequence: 12 }),
      subscribeRealtime: () => () => undefined,
      openRealtimeStreamLease: () => {
        leaseIndex += 1;
        return {
          leaseId: `lease-burst-${leaseIndex}`,
          clientId: `client-burst-${leaseIndex}`,
          gatewayNodeId: "node-burst",
        };
      },
      touchRealtimeStreamLease: () => undefined,
      closeRealtimeStreamLease: () => undefined,
    });
    await app.register(eventsRoutes);

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        fetch(`${address}/api/v1/events/stream?clientId=client-burst-${index}&replay=1`),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
    await Promise.all(responses.map((response) => response.body?.cancel()));
  });
});

async function readSseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < 10; index += 1) {
    const chunk = await reader!.read();
    if (chunk.value) {
      chunks.push(chunk.value);
    }
    if (chunk.done) {
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function readSseUntil(response: Response, done: (buffer: string) => boolean): Promise<string> {
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const decoder = new TextDecoder();
  let buffer = "";
  for (let index = 0; index < 50; index += 1) {
    const chunk = await reader!.read();
    if (chunk.value) {
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    if (done(buffer) || chunk.done) {
      break;
    }
  }
  await reader!.cancel();
  return buffer;
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let position = haystack.indexOf(needle);
  while (position !== -1) {
    count += 1;
    position = haystack.indexOf(needle, position + needle.length);
  }
  return count;
}
