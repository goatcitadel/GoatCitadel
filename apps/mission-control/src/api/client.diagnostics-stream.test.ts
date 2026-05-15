import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockStorage implements Storage {
  private readonly map = new Map<string, string>();

  public get length(): number {
    return this.map.size;
  }

  public clear(): void {
    this.map.clear();
  }

  public getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.map.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

class MockEventSource {
  public static instances: MockEventSource[] = [];

  public onopen: (() => void) | null = null;

  public onmessage: ((event: MessageEvent<string>) => void) | null = null;

  public onerror: (() => void) | null = null;

  public readonly url: string;

  public closed = false;

  public constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  public close(): void {
    this.closed = true;
  }
}

const streamCleanups: Array<() => void> = [];

function installMockWindow(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        protocol: "http:",
        hostname: "localhost",
      },
      localStorage: new MockStorage(),
      sessionStorage: new MockStorage(),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
}

describe("connectDevDiagnosticsStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    installMockWindow();
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
  });

  afterEach(() => {
    for (const cleanup of streamCleanups.splice(0)) {
      cleanup();
    }
    MockEventSource.instances = [];
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("requests a diagnostics SSE token when gateway auth is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: () => null,
      },
      json: async () => ({
        token: "diag-token-1",
        expiresAt: new Date().toISOString(),
        scope: "dev:diagnostics:stream",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    window.sessionStorage.setItem(
      "goatcitadel.gateway.auth",
      JSON.stringify({
        mode: "token",
        token: "operator-token",
      }),
    );

    const { connectDevDiagnosticsStream } = await import("./client");
    const close = connectDevDiagnosticsStream(() => undefined);
    streamCleanups.push(close);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/auth/sse-token"),
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toContain("/api/v1/dev/diagnostics/stream");
    expect(MockEventSource.instances[0]?.url).toContain("sse_token=diag-token-1");

    close();
    streamCleanups.pop();
  });

  it("reconnects after the diagnostics stream errors", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { connectDevDiagnosticsStream } = await import("./client");
    const close = connectDevDiagnosticsStream(() => undefined);
    streamCleanups.push(close);
    await vi.advanceTimersByTimeAsync(0);

    expect(MockEventSource.instances).toHaveLength(1);
    MockEventSource.instances[0]?.onerror?.();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2);

    close();
    streamCleanups.pop();
  });
});
