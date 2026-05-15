import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EVENT_CURSOR_STORAGE_KEY = "goatcitadel.events.cursor.v1";
const EVENT_CLIENT_ID_STORAGE_KEY = "goatcitadel.events.client.v1";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public clear(): void {
    this.values.clear();
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class MockEventSource {
  public static instances: MockEventSource[] = [];

  public onopen: (() => void) | null = null;
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public onerror: (() => void) | null = null;
  public closed = false;
  public readonly url: string;

  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  public constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  public addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: MessageEvent<string>) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public close(): void {
    this.closed = true;
  }

  public dispatch(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent<string>);
    }
  }
}

function installMockWindow(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        protocol: "http:",
        hostname: "localhost",
      },
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
}

async function flushConnection(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("connectEventStream replay and cursor handling", () => {
  beforeEach(() => {
    vi.resetModules();
    installMockWindow();
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("crypto", {
      randomUUID: () => "client-generated-1",
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    MockEventSource.instances = [];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("resumes from the stored realtime cursor and persists newer event sequences", async () => {
    window.localStorage.setItem(EVENT_CURSOR_STORAGE_KEY, "42");
    window.localStorage.setItem(EVENT_CLIENT_ID_STORAGE_KEY, "client-stable-1");
    const events: unknown[] = [];
    const statuses: unknown[] = [];

    const client = await import("./client");
    const close = client.connectEventStream(
      (event) => events.push(event),
      undefined,
      (status) => statuses.push(status),
    );
    await flushConnection();

    const source = MockEventSource.instances[0]!;
    const url = new URL(source.url);
    expect(url.pathname).toBe("/api/v1/events/stream");
    expect(url.searchParams.get("clientId")).toBe("client-stable-1");
    expect(url.searchParams.get("afterCursor")).toBe("42");
    expect(url.searchParams.has("replay")).toBe(false);

    source.onmessage?.({
      data: JSON.stringify({
        eventId: "event-43",
        eventType: "chat.updated",
        source: "chat",
        sequence: 43,
        timestamp: "2026-05-15T12:00:00.000Z",
      }),
    } as MessageEvent<string>);

    expect(window.localStorage.getItem(EVENT_CURSOR_STORAGE_KEY)).toBe("43");
    expect(events).toHaveLength(1);
    expect(statuses).toContainEqual(expect.objectContaining({ lastEventAt: "2026-05-15T12:00:00.000Z" }));

    close();
    expect(source.closed).toBe(true);

    client.connectEventStream(() => undefined);
    await flushConnection();

    expect(new URL(MockEventSource.instances[1]!.url).searchParams.get("afterCursor")).toBe("43");
  });

  it("clears stale cursors and emits an operator event when retained replay has a gap", async () => {
    window.localStorage.setItem(EVENT_CURSOR_STORAGE_KEY, "99");
    const events: any[] = [];
    const statuses: unknown[] = [];

    const client = await import("./client");
    const close = client.connectEventStream(
      (event) => events.push(event),
      undefined,
      (status) => statuses.push(status),
    );
    await flushConnection();

    const source = MockEventSource.instances[0]!;
    source.dispatch(
      "stream-ready",
      JSON.stringify({
        leaseId: "lease-1",
        clientId: "client-from-gateway",
        gatewayNodeId: "gateway-a",
      }),
    );
    expect(statuses).toContainEqual(
      expect.objectContaining({
        leaseId: "lease-1",
        clientId: "client-from-gateway",
        gatewayNodeId: "gateway-a",
      }),
    );

    source.dispatch(
      "replay-gap",
      JSON.stringify({
        oldestCursor: 120,
        requestedAfterCursor: 99,
      }),
    );

    expect(window.localStorage.getItem(EVENT_CURSOR_STORAGE_KEY)).toBeNull();
    expect(events[0]).toMatchObject({
      eventType: "system",
      source: "events",
      sequence: 120,
      payload: {
        kind: "replay_gap",
        oldestCursor: 120,
        requestedAfterCursor: 99,
      },
    });
    expect(statuses).toContainEqual(
      expect.objectContaining({
        leaseId: undefined,
        clientId: "client-from-gateway",
        gatewayNodeId: undefined,
      }),
    );

    close();
  });

  it("falls back to initial replay when the stored cursor is invalid", async () => {
    window.localStorage.setItem(EVENT_CURSOR_STORAGE_KEY, "0");

    const client = await import("./client");
    const close = client.connectEventStream(() => undefined);
    await flushConnection();

    const url = new URL(MockEventSource.instances[0]!.url);
    expect(url.searchParams.get("replay")).toBe("20");
    expect(url.searchParams.has("afterCursor")).toBe(false);

    close();
  });
});
