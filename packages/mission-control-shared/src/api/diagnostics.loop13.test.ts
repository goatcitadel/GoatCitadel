import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  buildGatewayUrl: vi.fn((path: string) => `http://localhost:8787${path}`),
  clearGatewayAuthState: vi.fn(),
  computeReconnectDelay: vi.fn(() => 25),
  isApiRequestError: vi.fn(),
  isSseBridgeNotNeededError: vi.fn(),
  issueSseBridgeToken: vi.fn(),
  readStoredGatewayAuthState: vi.fn(),
  recordClientDiagnostic: vi.fn(),
  request: vi.fn(),
  setDevDiagnosticsGatewayReachable: vi.fn(),
}));

vi.mock("../state/dev-diagnostics-store", () => ({
  recordClientDiagnostic: apiMocks.recordClientDiagnostic,
  setDevDiagnosticsGatewayReachable: apiMocks.setDevDiagnosticsGatewayReachable,
}));

vi.mock("./client-core.js", () => ({
  buildGatewayUrl: apiMocks.buildGatewayUrl,
  clearGatewayAuthState: apiMocks.clearGatewayAuthState,
  readStoredGatewayAuthState: apiMocks.readStoredGatewayAuthState,
  request: apiMocks.request,
}));

vi.mock("./http-internal", () => ({
  isApiRequestError: apiMocks.isApiRequestError,
}));

vi.mock("./sse-bridge.js", () => ({
  computeReconnectDelay: apiMocks.computeReconnectDelay,
  isSseBridgeNotNeededError: apiMocks.isSseBridgeNotNeededError,
  issueSseBridgeToken: apiMocks.issueSseBridgeToken,
}));

import { connectDevDiagnosticsStream, fetchDevDiagnostics } from "./diagnostics";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
}

function installWindow() {
  vi.stubGlobal("window", {
    clearTimeout: vi.fn((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)),
    setTimeout: vi.fn((callback: () => void, delay?: number) =>
      setTimeout(callback, delay),
    ) as unknown as Window["setTimeout"],
  });
  vi.stubGlobal("EventSource", FakeEventSource);
}

async function flushAsync() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe("diagnostics API loop13 tails", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    FakeEventSource.instances = [];
    apiMocks.request.mockResolvedValue({ items: [] });
    apiMocks.readStoredGatewayAuthState.mockReturnValue(undefined);
    apiMocks.issueSseBridgeToken.mockResolvedValue({ token: "diag-token", scope: "dev:diagnostics:stream" });
    apiMocks.isSseBridgeNotNeededError.mockReturnValue(false);
    apiMocks.isApiRequestError.mockReturnValue(false);
    installWindow();
  });

  it("builds diagnostics query strings only for present filters", async () => {
    await fetchDevDiagnostics();
    expect(apiMocks.request).toHaveBeenLastCalledWith("/api/v1/dev/diagnostics");

    await fetchDevDiagnostics({ level: "warn", category: "api", correlationId: "corr-1", limit: 0 });
    expect(apiMocks.request).toHaveBeenLastCalledWith(
      "/api/v1/dev/diagnostics?level=warn&category=api&correlationId=corr-1",
    );

    await fetchDevDiagnostics({ limit: 12 });
    expect(apiMocks.request).toHaveBeenLastCalledWith("/api/v1/dev/diagnostics?limit=12");
  });

  it("stays inert without a browser window", () => {
    vi.stubGlobal("window", undefined);

    const cleanup = connectDevDiagnosticsStream(() => undefined);

    cleanup();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("streams diagnostics without auth, ignores malformed events, reconnects, and cleans up timers", async () => {
    vi.useFakeTimers();
    const events: unknown[] = [];

    const cleanup = connectDevDiagnosticsStream((event) => events.push(event));
    await flushAsync();

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0]!;
    expect(new URL(source.url).searchParams.get("replay")).toBe("50");

    source.onopen?.();
    expect(apiMocks.setDevDiagnosticsGatewayReachable).toHaveBeenLastCalledWith(true);

    source.onmessage?.({ data: JSON.stringify({ eventId: "diag-1", level: "info" }) });
    source.onmessage?.({ data: "{bad json" });
    expect(events).toEqual([{ eventId: "diag-1", level: "info" }]);

    source.onerror?.();
    expect(source.close).toHaveBeenCalled();
    expect(apiMocks.setDevDiagnosticsGatewayReachable).toHaveBeenLastCalledWith(false);
    expect(window.setTimeout).toHaveBeenCalledWith(expect.any(Function), 25);
    source.onerror?.();
    expect(window.setTimeout).toHaveBeenCalledTimes(1);

    cleanup();
    expect(window.clearTimeout).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("uses bridge tokens for stored auth and handles bridge-not-needed and HTTP 400 fallback paths", async () => {
    apiMocks.readStoredGatewayAuthState.mockReturnValue({ mode: "token", token: "token-1" });
    let cleanup = connectDevDiagnosticsStream(() => undefined);
    await flushAsync();
    expect(new URL(FakeEventSource.instances.at(-1)!.url).searchParams.get("sse_token")).toBe("diag-token");
    cleanup();

    apiMocks.issueSseBridgeToken.mockRejectedValueOnce(new Error("bridge not needed"));
    apiMocks.isSseBridgeNotNeededError.mockReturnValueOnce(true);
    cleanup = connectDevDiagnosticsStream(() => undefined);
    await flushAsync();
    expect(apiMocks.clearGatewayAuthState).toHaveBeenCalled();
    expect(new URL(FakeEventSource.instances.at(-1)!.url).searchParams.has("sse_token")).toBe(false);
    cleanup();

    const api400 = Object.assign(new Error("bad bridge request"), { status: 400 });
    apiMocks.issueSseBridgeToken.mockRejectedValueOnce(api400);
    apiMocks.isSseBridgeNotNeededError.mockReturnValue(false);
    apiMocks.isApiRequestError.mockImplementation((error) => error === api400);
    cleanup = connectDevDiagnosticsStream(() => undefined);
    await flushAsync();
    expect(new URL(FakeEventSource.instances.at(-1)!.url).searchParams.has("sse_token")).toBe(false);
    cleanup();

    apiMocks.readStoredGatewayAuthState.mockReturnValue({ mode: "none", username: "operator", password: "secret" });
    apiMocks.issueSseBridgeToken.mockResolvedValueOnce({ token: "basic-token", scope: "dev:diagnostics:stream" });
    cleanup = connectDevDiagnosticsStream(() => undefined);
    await flushAsync();
    expect(new URL(FakeEventSource.instances.at(-1)!.url).searchParams.get("sse_token")).toBe("basic-token");
    cleanup();
  });

  it("schedules reconnects for bridge failures and skips late opens after cleanup", async () => {
    vi.useFakeTimers();
    apiMocks.readStoredGatewayAuthState.mockReturnValue({ mode: "token", token: "token-1" });
    apiMocks.issueSseBridgeToken.mockRejectedValueOnce(new Error("bridge failed"));
    apiMocks.isApiRequestError.mockReturnValue(false);

    let cleanup = connectDevDiagnosticsStream(() => undefined);
    await flushAsync();

    expect(FakeEventSource.instances).toHaveLength(0);
    expect(apiMocks.setDevDiagnosticsGatewayReachable).toHaveBeenCalledWith(false);
    expect(window.setTimeout).toHaveBeenCalledWith(expect.any(Function), 25);
    cleanup();

    let resolveToken!: (value: { token: string; scope: string }) => void;
    apiMocks.issueSseBridgeToken.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveToken = resolve;
      }),
    );
    cleanup = connectDevDiagnosticsStream(() => undefined);
    cleanup();
    resolveToken({ token: "late-token", scope: "dev:diagnostics:stream" });
    await flushAsync();

    expect(FakeEventSource.instances).toHaveLength(0);
    vi.useRealTimers();
  });
});
