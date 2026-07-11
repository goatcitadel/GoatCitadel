import { describe, expect, it, vi } from "vitest";
import { GatewayService } from "./gateway-service.js";

// Regression guard for the R3-8 review CRITICAL: GatewayService owns the
// SubagentFanoutRuntime, but the runtime host handed to the entry/stream turn
// services is a hand-written literal (buildChatTurnRuntimeHost) filtered
// through the strict whitelist composer (createChatTurnRuntimeHost). If either
// site drops `subagentFanout`, no executor is ever registered in production
// and every model agent.fanout call fails with "no active chat turn" — while
// service-level tests stay green because their fixtures set the member
// directly. This test builds the host through the REAL gateway literal.
describe("GatewayService.buildChatTurnRuntimeHost", () => {
  it("exposes the gateway's subagentFanout registry on the composed runtime host (R3-8)", () => {
    const subagentFanout = { register: vi.fn(() => () => {}) };
    const stub = {
      storage: { runtimeDecisionTraces: {}, chatSessionPrefs: { get: vi.fn() } },
      turnRuntime: {},
      backgroundTasks: new Set(),
      hooksService: {},
      llmService: {},
      steerService: {},
      config: {},
      improvementService: { listSurfaceRouteOverrideExemplars: vi.fn(() => []) },
      subagentFanout,
    };

    const host = (
      GatewayService.prototype as unknown as {
        buildChatTurnRuntimeHost(this: unknown): { subagentFanout?: unknown };
      }
    ).buildChatTurnRuntimeHost.call(stub);

    expect(host.subagentFanout).toBe(subagentFanout);
  });

  it("forwards the durable lease owner through the composed Chat runtime host", () => {
    const finalizeDurableChatRun = vi.fn();
    const stub = {
      storage: { runtimeDecisionTraces: {}, chatSessionPrefs: { get: vi.fn() } },
      turnRuntime: {},
      backgroundTasks: new Set(),
      hooksService: {},
      llmService: {},
      steerService: {},
      config: {},
      improvementService: { listSurfaceRouteOverrideExemplars: vi.fn(() => []) },
      subagentFanout: {},
      finalizeDurableChatRun,
    };
    const host = (
      GatewayService.prototype as unknown as {
        buildChatTurnRuntimeHost(this: unknown): {
          finalizeDurableChatRun: (...args: unknown[]) => void;
        };
      }
    ).buildChatTurnRuntimeHost.call(stub);

    host.finalizeDurableChatRun("run-1", {}, {}, "lease-owner-1");

    expect(finalizeDurableChatRun).toHaveBeenCalledWith("run-1", {}, {}, "lease-owner-1");
  });
});
