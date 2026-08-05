import type { NpuCapabilityReport, NpuModelManifest, NpuRuntimeStatus } from "@goatcitadel/contracts";
import type { NpuConfig } from "../config.js";

const RETIRED_MESSAGE = "NPU sidecar runtime was retired from GoatCitadel 1.0 and is not shipped.";

export interface NpuSidecarServiceOptions {
  rootDir: string;
  config: NpuConfig;
  onEvent?: (eventType: string, payload: Record<string, unknown>) => Promise<unknown>;
}

export class NpuSidecarService {
  public constructor(private options: NpuSidecarServiceOptions) {}

  public async init(): Promise<void> {
    await this.emit("npu_retired", { message: RETIRED_MESSAGE });
  }

  public updateConfig(config: NpuConfig): void {
    this.options = {
      ...this.options,
      config,
    };
  }

  public getConfigSnapshot(): NpuConfig {
    return structuredClone(this.options.config);
  }

  public getStatus(): NpuRuntimeStatus {
    return retiredStatus(this.options.config);
  }

  public async start(reason = "manual"): Promise<NpuRuntimeStatus> {
    await this.emit("npu_retired_start_blocked", { reason, message: RETIRED_MESSAGE });
    throw new Error(RETIRED_MESSAGE);
  }

  public async stop(reason = "manual"): Promise<NpuRuntimeStatus> {
    await this.emit("npu_retired_stop_noop", { reason });
    return this.getStatus();
  }

  public async refresh(): Promise<NpuRuntimeStatus> {
    return this.getStatus();
  }

  public async listModels(): Promise<NpuModelManifest[]> {
    return [];
  }

  public async close(): Promise<void> {
    await this.emit("npu_retired_close_noop", { message: RETIRED_MESSAGE });
  }

  private async emit(eventType: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.options.onEvent) {
      return;
    }
    await this.options.onEvent(eventType, payload);
  }
}

function retiredStatus(config: NpuConfig): NpuRuntimeStatus {
  return {
    enabled: false,
    desiredState: "stopped",
    processState: "stopped",
    sidecarUrl: normalizeBaseUrl(config.sidecar.baseUrl),
    healthy: false,
    backend: "unknown",
    capability: retiredCapability(),
    lastError: RETIRED_MESSAGE,
    updatedAt: new Date().toISOString(),
  };
}

function retiredCapability(): NpuCapabilityReport {
  return {
    platform: process.platform,
    arch: process.arch,
    isWindowsArm64: process.platform === "win32" && process.arch === "arm64",
    onnxRuntimeAvailable: false,
    onnxRuntimeGenAiAvailable: false,
    qnnExecutionProviderAvailable: false,
    supported: false,
    localInferenceReady: false,
    streamingChatCompletions: false,
    fallbackProxyConfigured: false,
    details: [RETIRED_MESSAGE],
  };
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
