import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { DevDiagnosticsEvent } from "@goatcitadel/contracts";
import { devDiagnosticsRoutes } from "./dev-diagnostics.js";

type RouteHandler = (request: { query: unknown; raw: EventEmitter }, reply: FakeReply) => Promise<void>;

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
}

describe("dev diagnostics stream route", () => {
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
    const reply: FakeReply = { raw, hijack: vi.fn() };

    await handler({ query: { replay: "2", level: "info" }, raw: requestRaw }, reply);

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
      const reply: FakeReply = { raw, hijack: vi.fn() };

      await handler({ query: { replay: "1" }, raw: new EventEmitter() }, reply);
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
      const throwingReply: FakeReply = { raw: throwingRaw, hijack: vi.fn() };
      await handler({ query: { replay: "1" }, raw: new EventEmitter() }, throwingReply);
      throwingRaw.emit("close");
      expect(throwingRaw.end).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

function parseSseData(chunk: string): DevDiagnosticsEvent {
  return JSON.parse(chunk.replace(/^data: /, "").trim()) as DevDiagnosticsEvent;
}
