import { createElement, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OLD_ENV = { ...import.meta.env };

async function loadStore(env: Record<string, string | boolean | undefined> = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "undefined") {
      vi.unstubAllEnvs();
      continue;
    }
    vi.stubEnv(key, value);
  }
  return import("./dev-diagnostics-store");
}

describe("dev diagnostics store", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    Object.assign(import.meta.env, OLD_ENV);
  });

  it("does nothing when diagnostics are disabled", async () => {
    const store = await loadStore({ VITE_GOATCITADEL_DEV_DIAGNOSTICS_ENABLED: "false" });

    expect(store.isDevDiagnosticsEnabled()).toBe(false);
    expect(store.recordClientDiagnostic({ level: "info", category: "api", event: "x", message: "x" })).toBeUndefined();
    expect(store.listClientDiagnostics()).toEqual([]);
    store.setDevDiagnosticsCurrentRoute("/chat");
    store.setDevDiagnosticsActiveCorrelationId("corr");
    store.clearClientDiagnostics();
    expect(store.getCurrentDiagnosticsRoute()).toBe("");
    expect(store.getCurrentDiagnosticsCorrelationId()).toBeUndefined();
  });

  it("records, sanitizes, filters, and bundles enabled diagnostics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
    vi.stubGlobal("crypto", { randomUUID: () => "uuid-1" });
    vi.stubGlobal("window", {
      location: {
        pathname: "/chat",
        search: "?access_token=secret&ok=1",
        hash: "#access_token=secret2&panel=trace",
      },
      __goatcitadelDevDiagnostics: undefined,
    });
    const store = await loadStore({
      VITE_GOATCITADEL_DEV_DIAGNOSTICS_ENABLED: "true",
      VITE_GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE: "true",
      VITE_GOATCITADEL_DEV_DIAGNOSTICS_CLIENT_BUFFER: "2",
    });

    expect(store.isDevDiagnosticsEnabled()).toBe(true);
    expect(store.getCurrentDiagnosticsRoute()).toBe("/chat?ok=1#panel=trace");
    store.setDevDiagnosticsCurrentRoute(
      " https://example.test/settings?access_token=secret&tab=a#access_token=secret2&mode=b ",
    );
    store.setDevDiagnosticsActiveChatSession(" session-1 ");
    store.setDevDiagnosticsCurrentEffectsMode(" compact ");
    store.setDevDiagnosticsSseState("open" as never);
    store.setDevDiagnosticsGatewayReachable(true);
    store.setDevDiagnosticsLastRequestError(" network ");
    store.setDevDiagnosticsLatestTraceSummary({ steps: 2 });
    store.setDevDiagnosticsStartupSummary({
      startedAt: "start",
      finishedAt: "finish",
      durationMs: 1,
      outcome: "ready",
      phases: [],
    });

    const first = store.recordClientDiagnostic({
      level: "debug",
      category: "sse",
      event: "freshness",
      message: "fresh",
      context: {
        apiKey: "sk-secret",
        nested: { authorization: "Bearer secret", safe: "value" },
      },
      correlationId: " corr-1 ",
      durationMs: 1.4,
      runtimeKind: "tool",
      runtimeStatus: "ok" as never,
      runtimeError: { name: "Error", message: " boom ", code: " E_FAIL ", retryable: true },
    });
    const throttled = store.recordClientDiagnostic({
      level: "debug",
      category: "sse",
      event: "freshness",
      message: "fresh again",
    });
    vi.advanceTimersByTime(5000);
    const second = store.recordClientDiagnostic({
      level: "warn",
      category: "runtime",
      event: "tool.failed",
      message: "failed",
      toolName: " fs.read ",
      runId: " run-1 ",
      meetingSessionId: " meet-1 ",
      durationMs: -1,
      runtimeError: { message: "failed" },
    });
    const third = store.recordClientDiagnostic({
      level: "error",
      category: "api",
      event: "request.error",
      message: "failed",
      sessionId: " explicit-session ",
    });

    expect(first?.context).toEqual({ apiKey: "[redacted]", nested: { authorization: "[redacted]", safe: "value" } });
    expect(first?.durationMs).toBe(1);
    expect(first?.runtimeError).toEqual({ name: "Error", message: "boom", code: "E_FAIL", retryable: true });
    expect(throttled).toBeUndefined();
    expect(second?.durationMs).toBeUndefined();
    expect(second?.runtimeError).toEqual({ message: "failed" });
    expect(third?.sessionId).toBe("explicit-session");
    expect(store.listClientDiagnostics()).toHaveLength(2);
    expect(store.listClientDiagnostics({ level: "warn" }).map((item) => item.id)).toEqual([second?.id]);
    expect(store.listClientDiagnostics({ category: "api", limit: 1 }).map((item) => item.id)).toEqual([third?.id]);
    expect(store.listClientDiagnostics({ runtimeKind: "tool" })).toEqual([]);
    expect(store.listClientDiagnostics({ runId: "run-1" }).map((item) => item.id)).toEqual([second?.id]);
    expect(store.listClientDiagnostics({ toolName: "fs.read" }).map((item) => item.id)).toEqual([second?.id]);
    expect(store.listClientDiagnostics({ meetingSessionId: "meet-1" }).map((item) => item.id)).toEqual([second?.id]);

    const bundle = store.buildDevDiagnosticsBundle([{ id: "gateway", runId: "gateway-run" } as never]);
    expect(bundle).toMatchObject({
      route: "/settings?tab=a#mode=b",
      activeChatSessionId: "session-1",
      activeCorrelationId: third?.correlationId,
      lastRequestError: "network",
      currentEffectsMode: "compact",
      gatewayReachable: true,
      sseState: "open",
      latestTraceSummary: { steps: 2 },
    });
    expect(bundle.runtimeDiagnostics).toEqual([{ id: "gateway", runId: "gateway-run" }, second]);
    expect(window.__goatcitadelDevDiagnostics?.getSnapshot().enabled).toBe(true);
    expect(window.__goatcitadelDevDiagnostics?.list({ category: "api" })).toHaveLength(1);
    window.__goatcitadelDevDiagnostics?.setCorrelationId(" corr-bridge ");
    window.__goatcitadelDevDiagnostics?.setChatSessionId(" session-bridge ");
    expect(store.getCurrentDiagnosticsCorrelationId()).toBe("corr-bridge");
    window.__goatcitadelDevDiagnostics?.buildBundle([{ id: "gateway-bridge", toolName: "shell" } as never]);

    store.setDevDiagnosticsCurrentRoute("/settings?tab=a#mode=b");
    store.setDevDiagnosticsActiveChatSession("session-bridge");
    store.setDevDiagnosticsCurrentEffectsMode("compact");
    store.setDevDiagnosticsSseState("open" as never);
    store.setDevDiagnosticsGatewayReachable(true);
    store.setDevDiagnosticsLastRequestError("network");
    store.setDevDiagnosticsActiveCorrelationId("corr-bridge");
    store.clearClientDiagnostics();
    expect(store.listClientDiagnostics()).toEqual([]);
  });

  it("updates React subscribers and covers negative filter predicates", async () => {
    const snapshots: string[] = [];
    const store = await loadStore({ VITE_GOATCITADEL_DEV_DIAGNOSTICS_ENABLED: "on" });

    function Probe({ children }: { children?: ReactNode }) {
      const snapshot = store.useDevDiagnosticsState();
      snapshots.push(`${snapshot.currentRoute}:${snapshot.items.length}`);
      return createElement("div", null, children ?? snapshot.currentRoute);
    }

    const renderer = create(createElement(Probe));
    act(() => {
      store.setDevDiagnosticsCurrentRoute("/first?access_token=secret&ok=1");
    });
    renderer.update(createElement(Probe, null, "updated"));

    let event: ReturnType<typeof store.recordClientDiagnostic>;
    act(() => {
      event = store.recordClientDiagnostic({
        level: "info",
        category: "api",
        event: "request.start",
        message: "start",
        correlationId: "corr-1",
        runtimeKind: "provider",
        runtimeStatus: "ok" as never,
        runId: "run-1",
        toolName: "tool-1",
        meetingSessionId: "meeting-1",
      });
    });

    expect(event!).toBeDefined();
    expect(snapshots.some((value) => value.startsWith("/first?ok=1"))).toBe(true);
    expect(store.listClientDiagnostics({ correlationId: "missing" })).toEqual([]);
    expect(store.listClientDiagnostics({ runtimeStatus: "failed" as never })).toEqual([]);
    expect(store.listClientDiagnostics({ runtimeKind: "other" })).toEqual([]);
    expect(store.listClientDiagnostics({ runId: "other" })).toEqual([]);
    expect(store.listClientDiagnostics({ toolName: "other" })).toEqual([]);
    expect(store.listClientDiagnostics({ meetingSessionId: "other" })).toEqual([]);
    expect(store.listClientDiagnostics({ limit: 0 })).toHaveLength(1);

    renderer.unmount();
    act(() => {
      store.setDevDiagnosticsCurrentRoute("/after-unmount");
    });
    expect(snapshots.some((value) => value.startsWith("/after-unmount"))).toBe(false);
  });

  it("falls back to timestamp correlation ids and route regex sanitization", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    vi.stubGlobal("crypto", {});
    vi.stubGlobal("Math", { ...Math, random: () => 0.5 });
    const store = await loadStore({ VITE_GOATCITADEL_DEV_DIAGNOSTICS_ENABLED: "yes" });

    store.setDevDiagnosticsCurrentRoute("not a url?access_token=secret");
    const event = store.recordClientDiagnostic({
      level: "info",
      category: "api",
      event: "request.start",
      message: "start",
      route: "not a url?access_token=secret",
      runtimeError: { message: " " },
    });

    expect(event?.id).toContain("1767312000000-");
    expect(event?.route).not.toContain("secret");
    expect(event?.runtimeError).toBeUndefined();
  });

  it("treats malformed window location parts and invalid input as empty diagnostics text", async () => {
    vi.stubGlobal("window", {
      location: {
        pathname: null,
        search: undefined,
        hash: 42,
      },
    });
    const store = await loadStore({ VITE_GOATCITADEL_DEV_DIAGNOSTICS_ENABLED: "true" });

    expect(store.getCurrentDiagnosticsRoute()).toBe("");
    store.setDevDiagnosticsCurrentRoute(undefined as never);
    store.setDevDiagnosticsActiveChatSession("undefined");
    store.setDevDiagnosticsCurrentEffectsMode("null");
    store.setDevDiagnosticsLastRequestError("NaN");
    store.setDevDiagnosticsActiveCorrelationId(" ");

    const event = store.recordClientDiagnostic({
      level: "info",
      category: "api",
      event: "request.start",
      message: "start",
      route: undefined as never,
      context: { bearer: "Basic abc", refreshToken: "plain", safe: "ok" },
    });

    expect(event?.route).toBe("");
    expect(event?.context).toEqual({ bearer: "[redacted]", refreshToken: "[redacted]", safe: "ok" });
    expect(store.buildDevDiagnosticsBundle().activeChatSessionId).toBeUndefined();
  });
});
