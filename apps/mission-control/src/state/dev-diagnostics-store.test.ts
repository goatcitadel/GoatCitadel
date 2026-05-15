import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
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

function installMockWindow(locationOverrides: Record<string, unknown> = {}): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        pathname: "/mission-control",
        search: "",
        hash: "",
        ...locationOverrides,
      },
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
    },
  });
}

describe("dev-diagnostics-store invariants", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("initializes a stable empty route when browser location parts are missing", async () => {
    installMockWindow({
      pathname: undefined,
      search: undefined,
      hash: undefined,
    });

    const diagnostics = await import("./dev-diagnostics-store");
    const bundle = diagnostics.buildDevDiagnosticsBundle();

    expect(bundle.route).toBe("");
  });

  it("drops invalid route and identifier values instead of recording NaN or undefined strings", async () => {
    installMockWindow();
    const diagnostics = await import("./dev-diagnostics-store");

    diagnostics.setDevDiagnosticsCurrentRoute("NaN" as unknown as string);
    diagnostics.recordClientDiagnostic({
      level: "info",
      category: "ui",
      event: "invariant.check",
      message: "Testing diagnostic sanitization",
      route: "undefined" as unknown as string,
      correlationId: "NaN" as unknown as string,
      sessionId: "undefined" as unknown as string,
      providerId: "null" as unknown as string,
      modelId: "   ",
    });

    const bundle = diagnostics.buildDevDiagnosticsBundle();
    const event = (bundle.browserDiagnostics as Array<Record<string, unknown>>)[0];

    expect(bundle.route).toBe("");
    expect(event?.route).toBe("");
    expect(event?.correlationId).toBeUndefined();
    expect(event?.sessionId).toBeUndefined();
    expect(event?.providerId).toBeUndefined();
    expect(event?.modelId).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toContain("NaN");
    expect(JSON.stringify(bundle)).not.toContain("undefined");
  });

  it("does not echo diagnostics to the console during test runs", async () => {
    installMockWindow();
    const consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const diagnostics = await import("./dev-diagnostics-store");

    diagnostics.recordClientDiagnostic({
      level: "info",
      category: "ui",
      event: "test.console_suppressed",
      message: "This should stay in the diagnostics buffer only.",
    });

    expect(consoleDebugSpy).not.toHaveBeenCalled();
  });

  it("exposes bridge and hook snapshots while sanitizing diagnostics metadata", async () => {
    vi.stubEnv("VITE_GOATCITADEL_DEV_DIAGNOSTICS_ENABLED", "true");
    vi.stubEnv("VITE_GOATCITADEL_DEV_DIAGNOSTICS_CLIENT_BUFFER", "2");
    installMockWindow({
      pathname: "/work",
      search: "?access_token=secret&view=chat",
      hash: "#access_token=hash&panel=trace",
    });

    const diagnostics = await import("./dev-diagnostics-store");
    const snapshots: string[] = [];
    function Probe() {
      const snapshot = diagnostics.useDevDiagnosticsState();
      snapshots.push(
        `${snapshot.currentRoute}|${snapshot.items.length}|${snapshot.activeCorrelationId ?? ""}|${
          snapshot.activeChatSessionId ?? ""
        }`,
      );
      return React.createElement("span", null, snapshot.items.length);
    }

    let renderer: ReactTestRenderer = create(React.createElement("div"));
    try {
      await act(async () => {
        renderer = create(React.createElement(Probe));
      });

      const bridge = window.__goatcitadelDevDiagnostics;
      expect(bridge).toBeDefined();
      expect(bridge?.getSnapshot().currentRoute).toBe("/work?view=chat#panel=trace");

      await act(async () => {
        bridge?.setCorrelationId(" corr-bridge ");
        bridge?.setChatSessionId(" chat-bridge ");
        diagnostics.setDevDiagnosticsCurrentRoute("/chat?access_token=secret&thread=1#access_token=hash&drawer=trace");
        diagnostics.setDevDiagnosticsCurrentEffectsMode(" strict ");
        diagnostics.setDevDiagnosticsSseState("open");
        diagnostics.setDevDiagnosticsGatewayReachable(true);
        diagnostics.setDevDiagnosticsLastRequestError(" token failed ");
        diagnostics.setDevDiagnosticsLatestTraceSummary({ phase: "compose" });
        diagnostics.setDevDiagnosticsStartupSummary({
          startedAt: "2026-05-15T00:00:00.000Z",
          finishedAt: "2026-05-15T00:00:01.000Z",
          durationMs: 1000,
          outcome: "success",
          phases: [
            {
              key: "preflight",
              label: "Preflight",
              status: "success",
              startedAt: "2026-05-15T00:00:00.000Z",
              finishedAt: "2026-05-15T00:00:01.000Z",
              durationMs: 1000,
              detail: "ready",
            },
          ],
        });
        diagnostics.recordClientDiagnostic({
          level: "info",
          category: "ui",
          event: "first",
          message: "first event",
          correlationId: "corr-first",
        });
        diagnostics.recordClientDiagnostic({
          level: "debug",
          category: "refresh",
          event: "second",
          message: "second event",
          correlationId: "corr-second",
        });
        diagnostics.recordClientDiagnostic({
          level: "error",
          category: "ui",
          event: "third",
          message: "third event",
          correlationId: "corr-third",
          context: {
            apiKey: "sk-secret",
            nested: { authorization: "Bearer token" },
            safe: "visible",
          },
        });
      });

      expect(diagnostics.getCurrentDiagnosticsRoute()).toBe("/chat?thread=1#drawer=trace");
      expect(diagnostics.getCurrentDiagnosticsCorrelationId()).toBe("corr-third");
      expect(snapshots.at(-1)).toContain("/chat?thread=1#drawer=trace|2|corr-third|chat-bridge");

      const recent = bridge?.list({ limit: 5 }) ?? [];
      expect(recent.map((item) => item.event)).toEqual(["third", "second"]);
      expect(bridge?.list({ level: "error", category: "ui", correlationId: "corr-third" })).toHaveLength(1);
      expect(recent[0]?.context).toEqual({
        apiKey: "[redacted]",
        nested: { authorization: "[redacted]" },
        safe: "visible",
      });

      const bundle = bridge?.buildBundle([
        {
          id: "gateway-1",
          timestamp: "2026-05-15T00:00:00.000Z",
          level: "warn",
          category: "gateway",
          event: "gateway.warn",
          message: "gateway warning",
          source: "gateway",
        },
      ]);
      expect(bundle).toMatchObject({
        route: "/chat?thread=1#drawer=trace",
        activeChatSessionId: "chat-bridge",
        activeCorrelationId: "corr-third",
        lastRequestError: "token failed",
        currentEffectsMode: "strict",
        gatewayReachable: true,
        sseState: "open",
      });
      expect(JSON.stringify(bundle)).not.toContain("sk-secret");
      expect(JSON.stringify(bundle)).not.toContain("Bearer token");

      await act(async () => {
        diagnostics.clearClientDiagnostics();
      });
      expect(diagnostics.listClientDiagnostics()).toEqual([]);
      expect(snapshots.at(-1)).toContain("|0|corr-third|chat-bridge");
    } finally {
      renderer.unmount();
    }
  });
});
