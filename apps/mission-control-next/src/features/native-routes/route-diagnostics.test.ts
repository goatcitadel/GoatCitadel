import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readRouteDiagnosticNow,
  recordRouteAction,
  recordRouteDataLoad,
  recordRouteDiagnostic,
} from "./route-diagnostics";

const diagnosticsMocks = vi.hoisted(() => ({
  recordClientDiagnostic: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/state/dev-diagnostics-store", () => ({
  recordClientDiagnostic: diagnosticsMocks.recordClientDiagnostic,
}));

describe("native route diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records default diagnostics and redacts or truncates nested context", () => {
    recordRouteDiagnostic({
      event: "settings.empty",
      message: "No context.",
    });
    recordRouteDiagnostic({
      event: "settings.loaded",
      message: "Loaded settings.",
      route: "settings",
      context: {
        token: "secret-token",
        promptBody: "private prompt",
        nested: {
          authorization: "Bearer secret",
          value: `${"x".repeat(181)}tail`,
        },
        list: Array.from({ length: 14 }, (_, index) => ({ index, password: `p-${index}` })),
      },
    });

    expect(diagnosticsMocks.recordClientDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "debug",
        category: "ui",
        event: "settings.loaded",
        route: "settings",
        context: expect.objectContaining({
          token: "[redacted]",
          promptBody: "[redacted]",
          nested: {
            authorization: "[redacted]",
            value: `${"x".repeat(180)}...`,
          },
          list: expect.arrayContaining([{ index: 0, password: "[redacted]" }]),
        }),
      }),
    );
    const [emptyCall, loadedCall] = diagnosticsMocks.recordClientDiagnostic.mock.calls;
    expect(emptyCall?.[0].context).toBeUndefined();
    expect(loadedCall?.[0].context.list).toHaveLength(12);
  });

  it("records route data and route actions with fallback context values", () => {
    const performanceSpy = vi.spyOn(performance, "now").mockReturnValue(125.4);

    recordRouteDataLoad({ route: "library", label: "Library", startedAt: 120.1 });
    recordRouteDataLoad({
      route: "ops",
      label: "Ops",
      startedAt: 150,
      issueCount: 2,
      itemCount: 5,
      selectedId: "run-1",
    });
    recordRouteAction("ops", "refresh");

    expect(diagnosticsMocks.recordClientDiagnostic).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        level: "debug",
        event: "native.route.data.loaded",
        durationMs: 5,
        context: { label: "Library", itemCount: 0, selectedId: undefined, issueCount: 0 },
      }),
    );
    expect(diagnosticsMocks.recordClientDiagnostic).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        level: "warn",
        durationMs: 0,
        context: { label: "Ops", itemCount: 5, selectedId: "run-1", issueCount: 2 },
      }),
    );
    expect(diagnosticsMocks.recordClientDiagnostic).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        level: "info",
        event: "native.route.action",
        context: { action: "refresh" },
      }),
    );

    performanceSpy.mockRestore();
  });

  it("falls back to Date.now when performance is unavailable", () => {
    const originalPerformance = globalThis.performance;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(9001);
    Reflect.deleteProperty(globalThis, "performance");

    expect(readRouteDiagnosticNow()).toBe(9001);

    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: originalPerformance,
    });
    nowSpy.mockRestore();
  });
});
