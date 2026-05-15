import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import { TuiLiveFeed } from "./live-feed.js";

describe("TuiLiveFeed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("delivers unique SSE and fallback poll events while notifying state listeners", async () => {
    const now = "2026-05-14T20:00:00.000Z";
    const firstEvent = {
      eventId: "evt-1",
      eventType: "runtime.ready",
      source: "gateway",
      timestamp: now,
      payload: {},
    } satisfies RealtimeEvent;
    const secondEvent = {
      eventType: "runtime.tick",
      source: "gateway",
      timestamp: "2026-05-14T20:00:01.000Z",
      payload: {},
    } satisfies RealtimeEvent;
    const polledEvent = {
      eventId: "evt-2",
      eventType: "runtime.poll",
      source: "gateway",
      timestamp: "2026-05-14T20:00:02.000Z",
      payload: {},
    } satisfies RealtimeEvent;
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
              controller.enqueue(encoder.encode("event: ignored\n\n"));
              controller.enqueue(encoder.encode("data: \n\n"));
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(firstEvent)}\n\n`));
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(firstEvent)}\n\n`));
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(secondEvent)}\n\n`));
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const client = {
      baseUrl: "http://127.0.0.1:8787",
      streamHeaders: () => ({ Authorization: "Bearer test" }),
      listEvents: vi.fn(async () => ({ items: [firstEvent, polledEvent] })),
    };
    const feed = new TuiLiveFeed(client as never, 1000);
    const delivered: RealtimeEvent[] = [];
    const states: string[] = [];
    const unsubscribeEvent = feed.subscribe((event) => delivered.push(event));
    const unsubscribeState = feed.subscribeState((state) => states.push(state));

    await feed.start();
    await waitFor(() => delivered.length === 3);
    unsubscribeEvent();
    unsubscribeState();
    feed.stop();

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8787/api/v1/events/stream?replay=20", {
      method: "GET",
      signal: expect.any(AbortSignal),
      headers: { Authorization: "Bearer test" },
    });
    expect(delivered).toEqual([firstEvent, secondEvent, polledEvent]);
    expect(states).toEqual(expect.arrayContaining(["offline", "connecting", "live", "polling"]));
    expect(feed.getLastEvent()).toEqual(polledEvent);
    expect(feed.getLastError()).toBeNull();
    expect(client.listEvents).toHaveBeenCalledWith(20);
  });

  it("falls back to polling and records degraded state when streaming and polling fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch);
    const client = {
      baseUrl: "http://127.0.0.1:8787",
      streamHeaders: () => ({}),
      listEvents: vi.fn(async () => {
        throw "poll failed";
      }),
    };
    const feed = new TuiLiveFeed(client as never, 1000);

    await feed.start();
    await waitFor(() => feed.getState() === "offline");
    feed.stop();

    expect(feed.getLastError()).toBe("Live feed degraded; falling back to polling.");
    expect(client.listEvents).toHaveBeenCalledWith(20);
  });

  it("records malformed SSE errors so the TUI can show degraded feed status", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"eventType":"broken"\n\n'));
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const client = {
      baseUrl: "http://127.0.0.1:8787",
      streamHeaders: () => ({}),
      listEvents: vi.fn(async () => ({ items: [] as RealtimeEvent[] })),
    };
    const feed = new TuiLiveFeed(client as never, 5);

    await feed.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(feed.getLastError()).toMatch(/malformed SSE payload/i);
    feed.stop();
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for live-feed condition.");
}
