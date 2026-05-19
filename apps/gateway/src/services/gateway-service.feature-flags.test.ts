import { describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";

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
    memoryLifecycleAutoForgetEnabled: true,
    memoryMaintenanceV1Enabled: false,
    connectorDiagnosticsV1Enabled: false,
    computerUseGuardrailsV1Enabled: true,
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

    (
      GatewayService.prototype as unknown as { enforceDurableExecutionBaseline(this: typeof gateway): void }
    ).enforceDurableExecutionBaseline.call(gateway);

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

  it("throws a typed conflict when a feature-gated runtime path is disabled", () => {
    const { gateway } = createGatewayHarness();

    expect(() => GatewayService.prototype.requireFeatureEnabled.call(gateway, "memoryLifecycleAdminV1Enabled")).toThrow(
      ConflictError,
    );
  });

  it("drains expired unpinned memory across multiple flush batches", () => {
    const nowIso = "2026-04-24T00:00:00.000Z";
    const forgottenItems = Array.from({ length: 1200 }, (_, index) => ({
      itemId: `memory-${index}`,
      namespace: index % 2 === 0 ? "user" : "workspace",
    }));
    const forgetExpiredActiveMemoryItems = vi.fn((input: { limit: number }) => {
      const batch = forgottenItems.splice(0, input.limit);
      return {
        totalCount: 0,
        retainedPinnedCount: 2,
        remainingUnpinnedCount: forgottenItems.length,
        forgottenItems: batch,
        retainedPinnedItems: [],
      };
    });
    const inspectExpiredActiveMemoryLedger = vi.fn(() => ({
      totalCount: 2,
      retainedPinnedCount: 2,
      unpinnedCount: 0,
      retainedPinnedItems: [
        { itemId: "pinned-1", namespace: "user" },
        { itemId: "pinned-2", namespace: "workspace" },
      ],
    }));
    const gateway = Object.create(GatewayService.prototype) as GatewayService & {
      memoryLifecycleService: {
        forgetExpiredActiveMemoryItems: typeof forgetExpiredActiveMemoryItems;
        inspectExpiredActiveMemoryLedger: typeof inspectExpiredActiveMemoryLedger;
      };
    };
    gateway.memoryLifecycleService = {
      forgetExpiredActiveMemoryItems,
      inspectExpiredActiveMemoryLedger,
    };

    const result = (
      GatewayService.prototype as unknown as {
        forgetExpiredMemoryItemsForFlush(this: typeof gateway, nowIso: string): Record<string, unknown>;
      }
    ).forgetExpiredMemoryItemsForFlush.call(gateway, nowIso);

    expect(forgetExpiredActiveMemoryItems).toHaveBeenCalledTimes(3);
    expect(forgetExpiredActiveMemoryItems).toHaveBeenNthCalledWith(1, { nowIso, limit: 500 });
    expect(result).toMatchObject({
      expiredActiveCount: 1202,
      forgottenCount: 1200,
      retainedPinnedCount: 2,
      remainingExpiredUnpinnedCount: 0,
      truncated: false,
    });
  });

  it("reports a truncated expired-memory backlog when the flush safety cap is reached", () => {
    const nowIso = "2026-04-24T00:00:00.000Z";
    const forgetExpiredActiveMemoryItems = vi.fn(() => ({
      totalCount: 0,
      retainedPinnedCount: 0,
      remainingUnpinnedCount: 500,
      forgottenItems: Array.from({ length: 500 }, (_, index) => ({
        itemId: `memory-${index}`,
        namespace: "user",
      })),
      retainedPinnedItems: [],
    }));
    const inspectExpiredActiveMemoryLedger = vi.fn(() => ({
      totalCount: 500,
      retainedPinnedCount: 0,
      unpinnedCount: 500,
      retainedPinnedItems: [],
    }));
    const gateway = Object.create(GatewayService.prototype) as GatewayService & {
      memoryLifecycleService: {
        forgetExpiredActiveMemoryItems: typeof forgetExpiredActiveMemoryItems;
        inspectExpiredActiveMemoryLedger: typeof inspectExpiredActiveMemoryLedger;
      };
    };
    gateway.memoryLifecycleService = {
      forgetExpiredActiveMemoryItems,
      inspectExpiredActiveMemoryLedger,
    };

    const result = (
      GatewayService.prototype as unknown as {
        forgetExpiredMemoryItemsForFlush(this: typeof gateway, nowIso: string): Record<string, unknown>;
      }
    ).forgetExpiredMemoryItemsForFlush.call(gateway, nowIso);

    expect(forgetExpiredActiveMemoryItems).toHaveBeenCalledTimes(20);
    expect(result).toMatchObject({
      expiredActiveCount: 10500,
      forgottenCount: 10000,
      remainingExpiredUnpinnedCount: 500,
      truncated: true,
    });
  });

  it("inspects expired memory without forgetting when auto-forget is disabled", () => {
    const nowIso = "2026-04-24T00:00:00.000Z";
    const forgetExpiredActiveMemoryItems = vi.fn();
    const inspectExpiredActiveMemoryLedger = vi.fn(() => ({
      totalCount: 3,
      retainedPinnedCount: 1,
      unpinnedCount: 2,
      retainedPinnedItems: [{ itemId: "pinned-1", namespace: "user" }],
    }));
    const gateway = Object.create(GatewayService.prototype) as GatewayService & {
      memoryLifecycleService: {
        forgetExpiredActiveMemoryItems: typeof forgetExpiredActiveMemoryItems;
        inspectExpiredActiveMemoryLedger: typeof inspectExpiredActiveMemoryLedger;
      };
    };
    gateway.memoryLifecycleService = {
      forgetExpiredActiveMemoryItems,
      inspectExpiredActiveMemoryLedger,
    };

    const result = (
      GatewayService.prototype as unknown as {
        inspectExpiredMemoryItemsForFlush(this: typeof gateway, nowIso: string): Record<string, unknown>;
      }
    ).inspectExpiredMemoryItemsForFlush.call(gateway, nowIso);

    expect(forgetExpiredActiveMemoryItems).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      expiredActiveCount: 3,
      forgottenCount: 0,
      retainedPinnedCount: 1,
      remainingExpiredUnpinnedCount: 2,
      truncated: true,
    });
  });
});
