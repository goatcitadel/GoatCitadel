import { describe, expect, it, vi } from "vitest";
import type { NpuConfig } from "../config.js";
import { NpuSidecarService } from "./npu-sidecar-service.js";

describe("NpuSidecarService", () => {
  it("reports the NPU sidecar as retired from the 1.0 runtime", async () => {
    const events: string[] = [];
    const service = new NpuSidecarService({
      rootDir: process.cwd(),
      config: createConfig({ enabled: true, autoStart: true }),
      onEvent: (eventType) => events.push(eventType),
    });

    await service.init();

    expect(service.getStatus()).toMatchObject({
      enabled: false,
      desiredState: "stopped",
      processState: "stopped",
      healthy: false,
      lastError: "NPU sidecar runtime was retired from GoatCitadel 1.0 and is not shipped.",
      capability: {
        supported: false,
        localInferenceReady: false,
        onnxRuntimeAvailable: false,
        onnxRuntimeGenAiAvailable: false,
        qnnExecutionProviderAvailable: false,
      },
    });
    expect(events).toContain("npu_retired");
  });

  it("blocks starts and exposes no models", async () => {
    const service = new NpuSidecarService({
      rootDir: process.cwd(),
      config: createConfig({ enabled: true }),
      onEvent: vi.fn(),
    });

    await expect(service.start()).rejects.toThrow("NPU sidecar runtime was retired");
    await expect(service.listModels()).resolves.toEqual([]);
    await expect(service.stop()).resolves.toMatchObject({ enabled: false, healthy: false });
    await expect(service.refresh()).resolves.toMatchObject({ enabled: false, healthy: false });
  });
});

function createConfig(overrides: Partial<NpuConfig> = {}): NpuConfig {
  return {
    enabled: overrides.enabled ?? false,
    autoStart: overrides.autoStart ?? false,
    sidecar: {
      command: overrides.sidecar?.command ?? "disabled",
      args: overrides.sidecar?.args ?? [],
      baseUrl: overrides.sidecar?.baseUrl ?? "http://127.0.0.1:11440",
      healthPath: overrides.sidecar?.healthPath ?? "/health",
      modelsPath: overrides.sidecar?.modelsPath ?? "/models",
      requestTimeoutMs: overrides.sidecar?.requestTimeoutMs ?? 500,
      startTimeoutMs: overrides.sidecar?.startTimeoutMs ?? 2_000,
      restartBudget: {
        maxRestarts: overrides.sidecar?.restartBudget?.maxRestarts ?? 0,
        windowMs: overrides.sidecar?.restartBudget?.windowMs ?? 60_000,
        backoffMs: overrides.sidecar?.restartBudget?.backoffMs ?? 100,
      },
    },
  };
}
