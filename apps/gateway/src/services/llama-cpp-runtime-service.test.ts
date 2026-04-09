import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LlamaCppHardwareProfile } from "@goatcitadel/contracts";
import type { LlamaCppConfig } from "../config.js";
import {
  buildLlamaCppLaunchArgs,
  normalizeLlamaCppProviderBaseUrl,
  parseAmdGpuTelemetryJson,
  parseNvidiaSmiCsv,
  parseSystemProfilerDisplaysJson,
  parseWindowsVideoControllerJson,
  recommendLlamaCppLaunchSettings,
} from "./llama-cpp-runtime-service.js";

function createConfig(overrides?: {
  server?: Partial<LlamaCppConfig["server"]>;
  launch?: Partial<LlamaCppConfig["launch"]>;
}): LlamaCppConfig {
  return {
    enabled: true,
    autoStart: false,
    server: {
      baseUrl: "http://127.0.0.1:8080/v1",
      command: "llama-server",
      extraArgs: [],
      healthPath: "/health",
      modelsPath: "/v1/models",
      startTimeoutMs: 30000,
      requestTimeoutMs: 15000,
      restartBudget: {
        windowMs: 300000,
        maxRestarts: 3,
        backoffMs: 2000,
      },
      ...overrides?.server,
    },
    launch: {
      alias: "gemma-4",
      ...overrides?.launch,
    },
  };
}

function createProfile(overrides?: Partial<LlamaCppHardwareProfile>): LlamaCppHardwareProfile {
  return {
    platform: "win32",
    arch: "x64",
    cpuModel: "AMD Ryzen 9 7950X",
    cpuCoresLogical: 16,
    cpuCoresPhysical: 8,
    systemRamBytes: 64 * 1024 ** 3,
    systemRamFreeBytes: 32 * 1024 ** 3,
    gpus: [],
    notes: [],
    ...overrides,
  };
}

describe("llama.cpp runtime helpers", () => {
  it("normalizes provider base URLs to the OpenAI-compatible /v1 path", () => {
    expect(normalizeLlamaCppProviderBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/v1");
    expect(normalizeLlamaCppProviderBaseUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080/v1");
    expect(normalizeLlamaCppProviderBaseUrl("")).toBe("http://127.0.0.1:8080/v1");
  });

  it("builds launch args from structured runtime settings", () => {
    const config = createConfig({
      server: {
        baseUrl: "http://127.0.0.1:18080/v1",
        extraArgs: ["--mlock", "--no-warmup"],
      },
      launch: {
        modelPath: "models/gemma-4-q4.gguf",
        alias: "gemma-4",
        ctxSize: 8192,
        threads: 12,
        gpuLayers: 40,
        parallel: 2,
        batchSize: 1024,
        ubatchSize: 512,
        flashAttention: true,
      },
    });

    expect(buildLlamaCppLaunchArgs("F:\\code\\personal-ai", config)).toEqual([
      "-m",
      path.resolve("F:\\code\\personal-ai", "models/gemma-4-q4.gguf"),
      "--host",
      "127.0.0.1",
      "--port",
      "18080",
      "--alias",
      "gemma-4",
      "-c",
      "8192",
      "-t",
      "12",
      "-ngl",
      "40",
      "-np",
      "2",
      "-b",
      "1024",
      "-ub",
      "512",
      "--flash-attn",
      "on",
      "--mlock",
      "--no-warmup",
    ]);
  });

  it("parses NVIDIA telemetry from nvidia-smi CSV output", () => {
    const [gpu] = parseNvidiaSmiCsv("NVIDIA GeForce RTX 4090, 24564, 560.94");
    expect(gpu).toMatchObject({
      vendor: "nvidia",
      name: "NVIDIA GeForce RTX 4090",
      driver: "560.94",
      source: "nvidia-smi",
      confidence: "high",
    });
    expect(gpu?.vramBytes).toBe(24564 * 1024 * 1024);
  });

  it("parses AMD JSON telemetry from vendor tooling", () => {
    const gpus = parseAmdGpuTelemetryJson(
      JSON.stringify({
        card0: {
          "Card series": "AMD Radeon RX 7900 XTX",
          vram_size_mb: 24576,
          driver_version: "24.3.1",
        },
      }),
    );

    expect(gpus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          vendor: "amd",
          name: "AMD Radeon RX 7900 XTX",
          driver: "24.3.1",
          source: "amd-smi",
        }),
      ]),
    );
  });

  it("parses Windows and macOS fallback GPU telemetry", () => {
    const windows = parseWindowsVideoControllerJson(
      JSON.stringify([
        {
          Name: "NVIDIA RTX 4080",
          AdapterRAM: 17163091968,
          DriverVersion: "31.0.15.6094",
        },
      ]),
    );
    expect(windows[0]).toMatchObject({
      vendor: "nvidia",
      name: "NVIDIA RTX 4080",
      confidence: "low",
      source: "windows-cim",
    });

    const apple = parseSystemProfilerDisplaysJson(
      JSON.stringify({
        SPDisplaysDataType: [
          {
            _name: "Apple M3 Max",
            spdisplays_vram_shared: "48 GB",
          },
        ],
      }),
    );
    expect(apple[0]).toMatchObject({
      vendor: "apple",
      name: "Apple M3 Max",
      confidence: "medium",
      source: "system_profiler",
    });
    expect(apple[0]?.vramBytes).toBe(48 * 1024 ** 3);
  });

  it("recommends conservative CPU-safe defaults when GPU confidence is weak", () => {
    const profile = createProfile({
      systemRamBytes: 32 * 1024 ** 3,
      gpus: [
        {
          vendor: "nvidia",
          name: "Unknown NVIDIA GPU",
          source: "windows-cim",
          confidence: "low",
          vramBytes: 8 * 1024 ** 3,
        },
      ],
      notes: ["VRAM confidence is low on this host."],
    });

    const recommendation = recommendLlamaCppLaunchSettings({ profile });

    expect(recommendation.recommended).toMatchObject({
      ctxSize: 8192,
      threads: 8,
      gpuLayers: 0,
      parallel: 1,
      batchSize: 512,
      ubatchSize: 256,
      flashAttention: undefined,
    });
    expect(recommendation.warnings).toEqual(
      expect.arrayContaining([
        "VRAM confidence is low on this host.",
        expect.stringContaining("Keeping GPU layers at 0 is safer."),
      ]),
    );
  });

  it("warns when the selected model is likely too large and keeps headroom intact", () => {
    const profile = createProfile({
      systemRamBytes: 128 * 1024 ** 3,
      cpuCoresLogical: 24,
      cpuCoresPhysical: 12,
      gpus: [
        {
          vendor: "nvidia",
          name: "NVIDIA RTX 4090",
          source: "nvidia-smi",
          confidence: "high",
          vramBytes: 24 * 1024 ** 3,
        },
      ],
    });

    const recommendation = recommendLlamaCppLaunchSettings({
      profile,
      observedModelBytes: 110 * 1024 ** 3,
    });

    expect(recommendation.recommended).toMatchObject({
      ctxSize: 4096,
      threads: 12,
      parallel: 2,
      batchSize: 1024,
      ubatchSize: 512,
      flashAttention: true,
    });
    expect(recommendation.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("close to total system RAM")]),
    );
  });
});
