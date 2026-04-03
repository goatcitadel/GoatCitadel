import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { eventsRoutes } from "./events.js";

describe("events stream route", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
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
    app.decorate("gateway", {
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
    } as never);
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
    app.decorate("gateway", {
      listRealtimeEvents: () => [{
        eventId: "event-1",
        sequence: 42,
        eventType: "system",
        source: "tests",
        timestamp: "2026-03-20T10:00:00.000Z",
        payload: { ok: true },
      }],
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
    } as never);
    await app.register(eventsRoutes);

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/v1/events/stream?replay=1`);

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await reader!.read();
    const text = new TextDecoder().decode(chunk.value ?? new Uint8Array());
    expect(text.includes("id: 42")).toBe(true);
    expect(text.includes("\"sequence\":42")).toBe(true);
    expect(text.includes("event: stream-ready")).toBe(true);
    expect(text.includes("\"leaseId\":\"lease-2\"")).toBe(true);
    await reader!.cancel();
  });

  it("signals replay gaps when the requested cursor falls behind retention", async () => {
    app = Fastify();
    await app.register(cors, { origin: true });
    app.decorate("gateway", {
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
    } as never);
    await app.register(eventsRoutes);

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/v1/events/stream?afterCursor=50`);

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await reader!.read();
    const text = new TextDecoder().decode(chunk.value ?? new Uint8Array());
    expect(text.includes("event: replay-gap")).toBe(true);
    expect(text.includes("\"oldestCursor\":100")).toBe(true);
    await reader!.cancel();
  });
});
