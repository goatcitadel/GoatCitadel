import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import { GatewayService } from "./gateway-service.js";

function createFeatureFlags() {
  return {
    durableKernelV1Enabled: false,
    replayOverridesV1Enabled: false,
    memoryLifecycleAdminV1Enabled: false,
    memoryMaintenanceV1Enabled: false,
    connectorDiagnosticsV1Enabled: false,
    computerUseGuardrailsV1Enabled: true,
    bankrBuiltinEnabled: false,
    cronReviewQueueV1Enabled: false,
    replayRegressionV1Enabled: false,
    codeModeV1Enabled: false,
    improvementLedgerV1Enabled: false,
    improvementActivationV1Enabled: false,
  };
}

function createGatewayHarness(options?: { storedFeatures?: Partial<ReturnType<typeof createFeatureFlags>> }) {
  const storedFeatures = options?.storedFeatures;
  const systemSettings = {
    get: vi.fn(() => (storedFeatures ? { value: storedFeatures } : undefined)),
    set: vi.fn(),
  };
  const gateway = Object.create(GatewayService.prototype) as GatewayService & {
    storage: { systemSettings: typeof systemSettings };
    config: {
      assistant: {
        durable: {
          enabled: boolean;
          executionEnabled: boolean;
          chatAutoPromoteEnabled: boolean;
        };
        features: ReturnType<typeof createFeatureFlags>;
      };
    };
  };
  gateway.storage = { systemSettings } as never;
  gateway.config = {
    assistant: {
      durable: {
        enabled: false,
        executionEnabled: false,
        chatAutoPromoteEnabled: false,
      },
      features: createFeatureFlags(),
    },
  } as never;
  return { gateway, systemSettings };
}

describe("GatewayService durable feature flags", () => {
  it("reports the durable kernel enabled even when config and stored flags drift false", () => {
    const { gateway } = createGatewayHarness({
      storedFeatures: {
        durableKernelV1Enabled: false,
      },
    });

    const flags = GatewayService.prototype.readFeatureFlags.call(gateway);

    expect(flags.durableKernelV1Enabled).toBe(true);
  });

  it("preserves stored durable baseline drift evidence without mutating config or settings", () => {
    const { gateway, systemSettings } = createGatewayHarness({
      storedFeatures: {
        durableKernelV1Enabled: false,
        replayRegressionV1Enabled: true,
      },
    });

    (GatewayService.prototype as unknown as { enforceDurableExecutionBaseline(this: typeof gateway): void })
      .enforceDurableExecutionBaseline.call(gateway);

    expect(gateway.config.assistant.durable.enabled).toBe(false);
    expect(gateway.config.assistant.durable.executionEnabled).toBe(false);
    expect(gateway.config.assistant.durable.chatAutoPromoteEnabled).toBe(false);
    expect(gateway.config.assistant.features.durableKernelV1Enabled).toBe(false);
    expect(systemSettings.set).not.toHaveBeenCalled();
  });

  it("rejects attempts to disable the durable kernel while preserving unrelated feature updates", () => {
    const { gateway, systemSettings } = createGatewayHarness();

    expect(() =>
      GatewayService.prototype.updateFeatureFlags.call(gateway, {
        durableKernelV1Enabled: false,
      }),
    ).toThrow(/cannot be disabled/i);

    const next = GatewayService.prototype.updateFeatureFlags.call(gateway, {
      replayRegressionV1Enabled: true,
    });

    expect(next.durableKernelV1Enabled).toBe(true);
    expect(next.replayRegressionV1Enabled).toBe(true);
    expect(systemSettings.set).toHaveBeenLastCalledWith(
      "feature_flags_v1",
      expect.objectContaining({
        durableKernelV1Enabled: true,
        replayRegressionV1Enabled: true,
      }),
    );
  });
});
