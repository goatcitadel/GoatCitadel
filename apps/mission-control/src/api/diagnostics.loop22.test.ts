import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  recordClientDiagnostic: vi.fn(),
  setDevDiagnosticsGatewayReachable: vi.fn(),
}));

const clientCoreMocks = vi.hoisted(() => ({
  buildGatewayUrl: vi.fn((path: string) => `http://gateway.local${path}`),
  clearGatewayAuthState: vi.fn(),
  readStoredGatewayAuthState: vi.fn(),
  request: vi.fn(),
}));

const httpMocks = vi.hoisted(() => ({
  isApiRequestError: vi.fn(),
}));

const sseBridgeMocks = vi.hoisted(() => ({
  computeReconnectDelay: vi.fn(() => 25),
  isSseBridgeNotNeededError: vi.fn(),
  issueSseBridgeToken: vi.fn(),
}));

vi.mock("../state/dev-diagnostics-store", () => ({
  recordClientDiagnostic: storeMocks.recordClientDiagnostic,
  setDevDiagnosticsGatewayReachable: storeMocks.setDevDiagnosticsGatewayReachable,
}));

vi.mock("./client-core.js", () => ({
  buildGatewayUrl: clientCoreMocks.buildGatewayUrl,
  clearGatewayAuthState: clientCoreMocks.clearGatewayAuthState,
  readStoredGatewayAuthState: clientCoreMocks.readStoredGatewayAuthState,
  request: clientCoreMocks.request,
}));

vi.mock("./http-internal", () => ({
  isApiRequestError: httpMocks.isApiRequestError,
}));

vi.mock("./sse-bridge.js", () => ({
  computeReconnectDelay: sseBridgeMocks.computeReconnectDelay,
  isSseBridgeNotNeededError: sseBridgeMocks.isSseBridgeNotNeededError,
  issueSseBridgeToken: sseBridgeMocks.issueSseBridgeToken,
}));

class MockEventSource {
  static instances: MockEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

function installWindow(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
  vi.stubGlobal("EventSource", MockEventSource);
}

describe("diagnostics api", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
    for (const mock of [
      ...Object.values(storeMocks),
      ...Object.values(clientCoreMocks),
      ...Object.values(httpMocks),
      ...Object.values(sseBridgeMocks),
    ]) {
      mock.mockReset();
    }
    clientCoreMocks.buildGatewayUrl.mockImplementation((path: string) => `http://gateway.local${path}`);
    clientCoreMocks.readStoredGatewayAuthState.mockReturnValue(null);
    clientCoreMocks.request.mockResolvedValue({ items: [] });
    httpMocks.isApiRequestError.mockReturnValue(false);
    sseBridgeMocks.computeReconnectDelay.mockReturnValue(25);
    sseBridgeMocks.isSseBridgeNotNeededError.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("builds diagnostics list query strings only from provided filters", async () => {
    const { fetchDevDiagnostics } = await import("./diagnostics");

    await fetchDevDiagnostics();
    await fetchDevDiagnostics({
      level: "warn",
      category: "runtime",
      correlationId: "corr-1",
      limit: 25,
    });

    expect(clientCoreMocks.request).toHaveBeenNthCalledWith(1, "/api/v1/dev/diagnostics");
    expect(clientCoreMocks.request).toHaveBeenNthCalledWith(
      2,
      "/api/v1/dev/diagnostics?level=warn&category=runtime&correlationId=corr-1&limit=25",
    );
  });

  it("is a no-op cleanup when diagnostics streams are opened outside the browser", async () => {
    const { connectDevDiagnosticsStream } = await import("./diagnostics");
    const close = connectDevDiagnosticsStream(vi.fn());

    close();

    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("connects, records valid events, ignores malformed payloads, and reconnects after errors", async () => {
    installWindow();
    const onEvent = vi.fn();
    const { connectDevDiagnosticsStream } = await import("./diagnostics");

    const close = connectDevDiagnosticsStream(onEvent);
    await vi.runAllTimersAsync();

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toBe("http://gateway.local/api/v1/dev/diagnostics/stream?replay=50");

    MockEventSource.instances[0]?.onopen?.();
    MockEventSource.instances[0]?.onmessage?.({
      data: JSON.stringify({ event: "startup.ready", level: "info", message: "ready" }),
    });
    MockEventSource.instances[0]?.onmessage?.({ data: "{bad json" });
    MockEventSource.instances[0]?.onerror?.();

    expect(onEvent).toHaveBeenCalledWith({ event: "startup.ready", level: "info", message: "ready" });
    expect(storeMocks.setDevDiagnosticsGatewayReachable).toHaveBeenCalledWith(true);
    expect(storeMocks.setDevDiagnosticsGatewayReachable).toHaveBeenCalledWith(false);
    expect(MockEventSource.instances[0]?.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(25);
    expect(MockEventSource.instances).toHaveLength(2);

    close();
    expect(MockEventSource.instances[1]?.closed).toBe(true);
  });

  it("uses SSE bridge auth when credentials are present and falls back when the bridge is unnecessary", async () => {
    installWindow();
    clientCoreMocks.readStoredGatewayAuthState.mockReturnValue({ mode: "token", token: "gateway-token" });
    sseBridgeMocks.issueSseBridgeToken.mockResolvedValueOnce({ token: "sse-token" });
    const { connectDevDiagnosticsStream } = await import("./diagnostics");

    let close = connectDevDiagnosticsStream(vi.fn());
    await vi.runAllTimersAsync();
    expect(MockEventSource.instances[0]?.url).toContain("sse_token=sse-token");
    close();

    MockEventSource.instances = [];
    const bridgeNotNeeded = new Error("bridge not needed");
    sseBridgeMocks.issueSseBridgeToken.mockRejectedValueOnce(bridgeNotNeeded);
    sseBridgeMocks.isSseBridgeNotNeededError.mockImplementation((error: unknown) => error === bridgeNotNeeded);

    close = connectDevDiagnosticsStream(vi.fn());
    await vi.runAllTimersAsync();

    expect(clientCoreMocks.clearGatewayAuthState).toHaveBeenCalled();
    expect(MockEventSource.instances[0]?.url).not.toContain("sse_token=");
    close();
  });

  it("schedules reconnect when bridge token issuance fails with a non-400 API error", async () => {
    installWindow();
    const tokenError = Object.assign(new Error("token failed"), { status: 503 });
    clientCoreMocks.readStoredGatewayAuthState.mockReturnValue({ mode: "basic", username: "u", password: "p" });
    sseBridgeMocks.issueSseBridgeToken.mockRejectedValue(tokenError);
    httpMocks.isApiRequestError.mockReturnValue(true);
    const { connectDevDiagnosticsStream } = await import("./diagnostics");

    const close = connectDevDiagnosticsStream(vi.fn());
    await Promise.resolve();
    await Promise.resolve();

    expect(MockEventSource.instances).toHaveLength(0);
    expect(storeMocks.setDevDiagnosticsGatewayReachable).toHaveBeenCalledWith(false);

    close();
  });
});
