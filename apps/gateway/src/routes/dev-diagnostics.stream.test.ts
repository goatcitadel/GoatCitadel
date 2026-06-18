import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DevDiagnosticsEvent } from "@goatcitadel/contracts";
import { devDiagnosticsRoutes } from "./dev-diagnostics.js";

type RouteHandler = (request: { query: unknown; raw: EventEmitter; ip: string }, reply: FakeReply) => Promise<void>;

class FakeRaw extends EventEmitter {
  public readonly chunks: string[] = [];
  public statusCode = 0;
  public headers: Record<string, string> = {};
  public destroyed = false;
  public writableEnded = false;
  public writeHead = vi.fn((statusCode: number, headers: Record<string, string>) => {
    this.statusCode = statusCode;
    this.headers = headers;
  });
  public end = vi.fn(() => {
    this.writableEnded = true;
  });

  public write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

interface FakeReply {
  raw: FakeRaw;
  hijack: ReturnType<typeof vi.fn>;
  code: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  getHeader(name: string): unknown;
  payload?: unknown;
}

describe("dev diagnostics stream route", () => {
  const originalSpecificLimit = process.env.GOATCITADEL_DEV_DIAGNOSTICS_SSE_MAX_CONNECTIONS_PER_IP;
  const originalSharedLimit = process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP;

  afterEach(() => {
    if (originalSpecificLimit === undefined) {
      delete process.env.GOATCITADEL_DEV_DIAGNOSTICS_SSE_MAX_CONNECTIONS_PER_IP;
    } else {
      process.env.GOATCITADEL_DEV_DIAGNOSTICS_SSE_MAX_CONNECTIONS_PER_IP = originalSpecificLimit;
    }
    if (originalSharedLimit === undefined) {
      delete process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP;
    } else {
      process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP = originalSharedLimit;
    }
  });

  async function getStreamHandler(services: Record<string, unknown>): Promise<RouteHandler> {
    const routes = new Map<string, RouteHandler>();
    await devDiagnosticsRoutes({
      get: (path: string, handler: RouteHandler) => {
        routes.set(path, handler);
      },
      services,
    } as never);
    const handler = routes.get("/api/v1/dev/diagnostics/stream");
    if (!handler) {
      throw new Error("stream route was not registered");
    }
    return handler;
  }

  function event(overrides: Partial<DevDiagnosticsEvent>): DevDiagnosticsEvent {
    return {
      id: "evt-base",
      timestamp: "2026-05-14T00:00:00.000Z",
      level: "info",
      category: "gateway",
      event: "diagnostic.event",
      message: "diagnostic event",
      source: "gateway",
      ...overrides,
    };
  }

  it("replays diagnostics, streams matching events, and cleans up on close", async () => {
    const newer = event({ id: "newer", message: "newer" });
    const older = event({ id: "older", message: "older" });
    const unsubscribe = vi.fn();
    let listener: ((event: DevDiagnosticsEvent) => void) | undefined;
    const handler = await getStreamHandler({
      devDiagnostics: {
        isDevDiagnosticsEnabled: () => true,
        listDevDiagnostics: vi.fn(() => ({ items: [newer, older] })),
        subscribeDevDiagnostics: vi.fn((next: (event: DevDiagnosticsEvent) => void) => {
          listener = next;
          return unsubscribe;
        }),
      },
    });
    const raw = new FakeRaw();
    const requestRaw = new EventEmitter();
    const reply = createReply(raw);

    await handler({ query: { replay: "2", level: "info" }, raw: requestRaw, ip: "127.0.0.1" }, reply);

    expect(raw.statusCode).toBe(200);
    expect(raw.headers).toMatchObject({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    expect(raw.chunks[0]).toBe(": connected\n\n");
    expect(
      raw.chunks
        .filter((chunk) => chunk.startsWith("data: "))
        .map(parseSseData)
        .map((item) => item.id),
    ).toEqual(["older", "newer"]);

    listener?.(event({ id: "skip", level: "warn" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(raw.chunks.some((chunk) => chunk.includes('"id":"skip"'))).toBe(false);

    listener?.(event({ id: "live", level: "info" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(raw.chunks.some((chunk) => chunk.includes('"id":"live"'))).toBe(true);

    raw.emit("close");
    raw.emit("close");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(raw.end).toHaveBeenCalledTimes(1);
    expect(reply.hijack).toHaveBeenCalledTimes(1);
  });

  it("sends keep-alives, handles write-false cleanup, and ignores raw end failures", async () => {
    vi.useFakeTimers();
    try {
      const unsubscribe = vi.fn();
      let listener: ((event: DevDiagnosticsEvent) => void) | undefined;
      const handler = await getStreamHandler({
        devDiagnostics: {
          isDevDiagnosticsEnabled: () => true,
          listDevDiagnostics: vi.fn(() => ({ items: [] })),
          subscribeDevDiagnostics: vi.fn((next: (event: DevDiagnosticsEvent) => void) => {
            listener = next;
            return unsubscribe;
          }),
        },
      });
      const raw = new FakeRaw();
      const reply = createReply(raw);

      await handler({ query: { replay: "1" }, raw: new EventEmitter(), ip: "127.0.0.1" }, reply);
      await vi.advanceTimersByTimeAsync(25000);
      expect(raw.chunks).toContain(": keep-alive\n\n");

      raw.writableEnded = true;
      listener?.(event({ id: "cannot-write" }));
      for (let index = 0; index < 6; index += 1) {
        await Promise.resolve();
      }
      expect(unsubscribe).toHaveBeenCalledTimes(1);

      const throwingRaw = new FakeRaw();
      throwingRaw.end.mockImplementationOnce(() => {
        throw new Error("socket already closed");
      });
      const throwingReply = createReply(throwingRaw);
      await handler({ query: { replay: "1" }, raw: new EventEmitter(), ip: "127.0.0.1" }, throwingReply);
      throwingRaw.emit("close");
      expect(throwingRaw.end).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves CORS headers when the raw SSE response is written", async () => {
    const handler = await getStreamHandler({
      devDiagnostics: {
        isDevDiagnosticsEnabled: () => true,
        listDevDiagnostics: vi.fn(() => ({ items: [] })),
        subscribeDevDiagnostics: vi.fn(() => vi.fn()),
      },
    });
    const raw = new FakeRaw();
    const reply = createReply(raw, {
      "Access-Control-Allow-Origin": "http://localhost:5173",
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    });

    await handler({ query: { replay: "1" }, raw: new EventEmitter(), ip: "127.0.0.1" }, reply);

    expect(raw.headers).toMatchObject({
      "Access-Control-Allow-Origin": "http://localhost:5173",
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    });
    raw.emit("close");
  });

  it("limits active streams per client IP and releases the slot on close", async () => {
    process.env.GOATCITADEL_DEV_DIAGNOSTICS_SSE_MAX_CONNECTIONS_PER_IP = "1";
    const handler = await getStreamHandler({
      devDiagnostics: {
        isDevDiagnosticsEnabled: () => true,
        listDevDiagnostics: vi.fn(() => ({ items: [] })),
        subscribeDevDiagnostics: vi.fn(() => vi.fn()),
      },
    });
    const firstRaw = new FakeRaw();
    const firstReply = createReply(firstRaw);
    const blockedRaw = new FakeRaw();
    const blockedReply = createReply(blockedRaw);

    await handler({ query: { replay: "1" }, raw: new EventEmitter(), ip: "127.0.0.1" }, firstReply);
    await handler({ query: { replay: "1" }, raw: new EventEmitter(), ip: "127.0.0.1" }, blockedReply);

    expect(blockedReply.code).toHaveBeenCalledWith(429);
    expect(blockedReply.send).toHaveBeenCalledWith({
      error: "Too many active dev diagnostics streams for this client.",
      code: "DEV_DIAGNOSTICS_SSE_CONNECTION_LIMIT",
      limit: 1,
    });

    firstRaw.emit("close");
    const afterCloseRaw = new FakeRaw();
    const afterCloseReply = createReply(afterCloseRaw);
    await handler({ query: { replay: "1" }, raw: new EventEmitter(), ip: "127.0.0.1" }, afterCloseReply);

    expect(afterCloseRaw.statusCode).toBe(200);
    afterCloseRaw.emit("close");
  });
});

function createReply(raw: FakeRaw, initialHeaders: Record<string, string> = {}): FakeReply {
  const headers = new Map(Object.entries(initialHeaders).map(([name, value]) => [name.toLowerCase(), value]));
  const reply: FakeReply = {
    raw,
    hijack: vi.fn(),
    code: vi.fn((statusCode: number) => {
      raw.statusCode = statusCode;
      return reply;
    }),
    send: vi.fn((payload: unknown) => {
      reply.payload = payload;
      return reply;
    }),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
  };
  return reply;
}

function parseSseData(chunk: string): DevDiagnosticsEvent {
  return JSON.parse(chunk.replace(/^data: /, "").trim()) as DevDiagnosticsEvent;
}
