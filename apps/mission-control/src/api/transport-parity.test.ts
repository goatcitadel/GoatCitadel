import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  public onerror: (() => void) | null = null;

  public onmessage: ((event: MessageEvent<string>) => void) | null = null;

  public readonly url: string;

  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  public constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  public addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const bucket = this.listeners.get(type) ?? new Set<(event: MessageEvent<string>) => void>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  public close(): void {}
}

function installMockWindow(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        protocol: "http:",
        hostname: "localhost",
        pathname: "/mission-control",
        search: "",
        hash: "",
      },
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
}

function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  const normalized = new Headers(headers);
  return Object.fromEntries(normalized.entries());
}

describe("Mission Control transport parity", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    installMockWindow();
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("crypto", {
      randomUUID: () => "test-uuid",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the same auth and retry semantics through client-core and shell-client request paths", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "try again" }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ data: { items: [], view: "active" } }))
      .mockResolvedValueOnce(jsonResponse({ error: "try again" }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ data: { items: [], view: "active" } }));
    vi.stubGlobal("fetch", fetchMock);

    const diagnostics = await import("../state/dev-diagnostics-store");
    const core = await import("./client-core");
    const shell = await import("./shell-client");

    core.persistGatewayAuthState({ mode: "token", token: "operator-token" });

    diagnostics.clearClientDiagnostics();
    const coreRequest = core.request<{ items: unknown[]; view: string }>("/api/v1/workspaces?view=active&limit=200");
    await vi.runAllTimersAsync();
    await coreRequest;
    const coreHeaders = toHeaderRecord(fetchMock.mock.calls[1]?.[1]?.headers);
    const coreEvents = diagnostics.listClientDiagnostics({ category: "api", limit: 3 });

    diagnostics.clearClientDiagnostics();
    const shellRequest = shell.fetchWorkspaces();
    await vi.runAllTimersAsync();
    await shellRequest;
    const shellHeaders = toHeaderRecord(fetchMock.mock.calls[3]?.[1]?.headers);
    const shellEvents = diagnostics.listClientDiagnostics({ category: "api", limit: 3 });

    expect(coreHeaders.authorization).toBe("Bearer operator-token");
    expect(shellHeaders.authorization).toBe("Bearer operator-token");
    expect(coreHeaders["x-goatcitadel-origin-surface"]).toBe(shellHeaders["x-goatcitadel-origin-surface"]);
    expect(coreEvents.map((item) => item.event)).toEqual(["request.finish", "request.retry", "request.start"]);
    expect(shellEvents.map((item) => item.event)).toEqual(["request.finish", "request.retry", "request.start"]);
  });

  it("shares the same realtime stream implementation between the standard client and shell surface", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      jsonResponse({
        token: "stream-token-1",
        expiresAt: new Date().toISOString(),
        scope: "events:stream",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = await import("./client");
    const shell = await import("./shell-client");

    client.persistGatewayAuthState({ mode: "token", token: "operator-token" });

    expect(shell.connectEventStream).toBe(client.connectEventStream);

    const stop = shell.connectEventStream(() => undefined);
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/auth/sse-token"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toContain("/api/v1/events/stream");
    expect(MockEventSource.instances[0]?.url).toContain("sse_token=stream-token-1");

    MockEventSource.instances[0]?.onerror?.();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2);

    stop();
  });
});
