import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectEventStream, runUiAction } from "./client";

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  get length() {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly close = vi.fn();
  private readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  emit(type: string, data: unknown): void {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: payload });
    }
  }
}

function installBrowser() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: new URL("http://localhost:5173/app"),
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
}

async function flushAsync() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

describe("client event stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "client-uuid") });
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.instances = [];
    installBrowser();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    FakeEventSource.instances = [];
  });

  it("wraps UI actions with success and error metadata", async () => {
    await expect(runUiAction(async () => "ok")).resolves.toMatchObject({
      state: "success",
      data: "ok",
      startedAt: "2026-01-01T12:00:00.000Z",
      finishedAt: "2026-01-01T12:00:00.000Z",
    });
    await expect(
      runUiAction(async () => {
        throw new Error("boom");
      }),
    ).resolves.toMatchObject({
      state: "error",
      error: "boom",
    });
  });

  it("connects once, forwards events, persists cursors, handles replay gaps, reconnects, and cleans up", async () => {
    const events: unknown[] = [];
    const states: string[] = [];
    const statuses: unknown[] = [];

    const cleanup = connectEventStream(
      (event) => events.push(event),
      (state) => states.push(state),
      (status) => statuses.push(status),
    );
    await flushAsync();

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0]!;
    const streamUrl = new URL(source.url);
    expect(streamUrl.pathname).toBe("/api/v1/events/stream");
    expect(streamUrl.searchParams.get("clientId")).toBe("client-uuid");
    expect(streamUrl.searchParams.get("replay")).toBe("20");
    expect(states).toEqual(["closed", "connecting"]);

    source.onopen?.();
    expect(states.at(-1)).toBe("open");

    source.emit("stream-ready", {
      leaseId: "lease-1",
      clientId: "client-1",
      gatewayNodeId: "node-1",
    });
    expect(statuses.at(-1)).toMatchObject({
      state: "open",
      leaseId: "lease-1",
      clientId: "client-1",
      gatewayNodeId: "node-1",
    });

    source.onmessage?.({
      data: JSON.stringify({
        eventId: "event-1",
        sequence: 7,
        eventType: "workspace.updated",
        source: "gateway",
        timestamp: "2026-01-01T12:01:00.000Z",
      }),
    });
    source.onmessage?.({ data: "{bad json" });
    expect(events).toHaveLength(1);
    expect(window.localStorage.getItem("goatcitadel.events.cursor.v1")).toBe("7");

    source.emit("replay-gap", { oldestCursor: 10 });
    expect(window.localStorage.getItem("goatcitadel.events.cursor.v1")).toBeNull();
    expect(events.at(-1)).toMatchObject({
      eventType: "system",
      source: "events",
      payload: { kind: "replay_gap", oldestCursor: 10 },
    });

    source.onerror?.();
    expect(source.close).toHaveBeenCalled();
    expect(states.slice(-2)).toEqual(["error", "retrying"]);

    await vi.advanceTimersByTimeAsync(1000);
    await flushAsync();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(states.at(-1)).toBe("connecting");
    const stateCountAfterReconnect = states.length;
    const eventCountAfterReconnect = events.length;
    source.onopen?.();
    source.onmessage?.({
      data: JSON.stringify({
        eventId: "stale",
        eventType: "stale",
        source: "gateway",
        timestamp: "2026-01-01T12:02:00.000Z",
      }),
    });
    source.emit("replay-gap", { oldestCursor: 99 });
    source.emit("stream-ready", { leaseId: "stale-lease" });
    source.onerror?.();
    expect(states).toHaveLength(stateCountAfterReconnect);
    expect(events).toHaveLength(eventCountAfterReconnect);

    cleanup();
    expect(FakeEventSource.instances.at(-1)?.close).toHaveBeenCalled();
  });

  it("reuses stored client ids and cursors when building stream URLs", async () => {
    window.localStorage.setItem("goatcitadel.events.client.v1", "client-existing");
    window.localStorage.setItem("goatcitadel.events.cursor.v1", "9");

    const cleanup = connectEventStream(() => undefined);
    await flushAsync();

    const streamUrl = new URL(FakeEventSource.instances[0]!.url);
    expect(streamUrl.searchParams.get("clientId")).toBe("client-existing");
    expect(streamUrl.searchParams.get("afterCursor")).toBe("9");
    expect(streamUrl.searchParams.has("replay")).toBe(false);

    cleanup();
  });

  it("bridges stored auth for EventSource URLs and clears auth when the gateway says the bridge is not needed", async () => {
    window.sessionStorage.setItem(
      "goatcitadel.gateway.auth",
      JSON.stringify({ mode: "token", token: "token-1", tokenQueryParam: "access_token" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "SSE token bridge is not needed when auth mode is none" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const cleanup = connectEventStream(() => undefined);
    await flushAsync();

    expect(window.sessionStorage.getItem("goatcitadel.gateway.auth")).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(new URL(FakeEventSource.instances[0]!.url).searchParams.has("sse_token")).toBe(false);

    cleanup();
  });

  it("appends successful SSE bridge tokens for basic auth streams", async () => {
    window.sessionStorage.setItem(
      "goatcitadel.gateway.auth",
      JSON.stringify({ mode: "basic", username: "operator", password: "secret", tokenQueryParam: "access_token" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { token: "sse-token", scope: "events:stream" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const cleanup = connectEventStream(() => undefined);
    await flushAsync();

    expect(new URL(FakeEventSource.instances[0]!.url).searchParams.get("sse_token")).toBe("sse-token");
    cleanup();
  });

  it("ignores malformed stream-ready and replay-gap payloads without breaking subscribers", async () => {
    const events: unknown[] = [];
    const statuses: unknown[] = [];

    const cleanup = connectEventStream(
      (event) => events.push(event),
      undefined,
      (status) => statuses.push(status),
    );
    await flushAsync();
    const source = FakeEventSource.instances[0]!;

    source.emit("stream-ready", "{bad json");
    source.emit("replay-gap", "{bad json");

    expect(events.at(-1)).toMatchObject({
      eventType: "system",
      payload: { kind: "replay_gap", error: "replay_gap" },
    });
    expect(statuses.at(-1)).toMatchObject({ state: "connecting" });

    cleanup();
  });

  it("stays inert when the browser window is unavailable", async () => {
    vi.stubGlobal("window", undefined);
    const states: string[] = [];

    const cleanup = connectEventStream(
      () => undefined,
      (state) => states.push(state),
    );
    await flushAsync();

    expect(states).toEqual(["closed"]);
    expect(FakeEventSource.instances).toHaveLength(0);
    cleanup();
  });

  it("reports connection errors when EventSource URL creation fails", async () => {
    window.sessionStorage.setItem(
      "goatcitadel.gateway.auth",
      JSON.stringify({ mode: "token", token: "token-1", tokenQueryParam: "access_token" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "bridge failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const states: string[] = [];

    const cleanup = connectEventStream(
      () => undefined,
      (state) => states.push(state),
    );
    await flushAsync();

    expect(FakeEventSource.instances).toHaveLength(0);
    expect(states.slice(-2)).toEqual(["error", "retrying"]);

    cleanup();
  });
});
