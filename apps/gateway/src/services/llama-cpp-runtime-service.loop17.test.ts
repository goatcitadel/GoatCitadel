import { describe, expect, it } from "vitest";
import {
  parseAmdGpuTelemetryJson,
  parseNvidiaSmiCsv,
  parseSystemProfilerDisplaysJson,
  parseWindowsVideoControllerJson,
  recommendLlamaCppLaunchSettings,
} from "./llama-cpp-runtime-service.js";

describe("llama.cpp runtime telemetry parser edge cases", () => {
  it("normalizes sparse NVIDIA CSV rows without inventing missing memory or driver values", () => {
    expect(parseNvidiaSmiCsv(", not-a-number, ")[0]).toMatchObject({
      vendor: "nvidia",
      name: "NVIDIA GPU",
      driver: undefined,
      vramBytes: undefined,
      source: "nvidia-smi",
      confidence: "high",
    });
  });

  it("parses single-object Windows telemetry and nested AMD telemetry with string and byte VRAM values", () => {
    expect(
      parseWindowsVideoControllerJson(
        JSON.stringify({
          Name: "AMD Radeon 780M",
          AdapterRAM: 2_147_483_648,
          DriverVersion: "32.0.1",
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        vendor: "amd",
        name: "AMD Radeon 780M",
        vramBytes: 2_147_483_648,
      }),
    ]);

    const amd = parseAmdGpuTelemetryJson(
      JSON.stringify({
        cards: [
          {
            card_name: "Radeon RX 6800",
            vram_total_mb: "16384 MiB",
          },
          {
            product_name: "Radeon Pro W7900",
            "VRAM Total Memory (B)": 51_539_607_552,
          },
        ],
      }),
      "rocm-smi",
    );

    expect(amd).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          vendor: "amd",
          name: "Radeon RX 6800",
          vramBytes: 16_384 * 1024 * 1024,
          confidence: "medium",
          source: "rocm-smi",
        }),
        expect.objectContaining({
          vendor: "amd",
          name: "Radeon Pro W7900",
          vramBytes: 51_539_607_552,
        }),
      ]),
    );
  });

  it("parses macOS display profiler model and MB memory fields", () => {
    expect(
      parseSystemProfilerDisplaysJson(
        JSON.stringify({
          SPDisplaysDataType: [
            {
              sppci_model: "AMD Radeon Pro 5500M",
              spdisplays_vram: "8192 MB",
            },
          ],
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        vendor: "amd",
        name: "AMD Radeon Pro 5500M",
        vramBytes: 8192 * 1024 * 1024,
        source: "system_profiler",
      }),
    ]);
  });

  it("keeps missing display memory unset and uses GPU confidence as the VRAM tie breaker", () => {
    expect(
      parseSystemProfilerDisplaysJson(
        JSON.stringify({
          SPDisplaysDataType: [
            {
              _name: "Mystery Display Adapter",
            },
            {
              _name: "Intel Iris Xe",
              spdisplays_vram: "shared dynamic memory",
            },
          ],
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        vendor: "unknown",
        name: "Mystery Display Adapter",
        vramBytes: undefined,
      }),
      expect.objectContaining({
        vendor: "intel",
        name: "Intel Iris Xe",
        vramBytes: undefined,
      }),
    ]);

    const recommendation = recommendLlamaCppLaunchSettings({
      profile: {
        platform: "win32",
        arch: "x64",
        cpuModel: "Test CPU",
        cpuCoresLogical: 16,
        systemRamBytes: 64 * 1024 ** 3,
        systemRamFreeBytes: 48 * 1024 ** 3,
        gpus: [
          {
            vendor: "intel",
            name: "Integrated GPU",
            vramBytes: 8 * 1024 ** 3,
            confidence: "low",
            source: "windows-cim",
          },
          {
            vendor: "nvidia",
            name: "RTX 4070",
            vramBytes: 8 * 1024 ** 3,
            confidence: "high",
            source: "nvidia-smi",
          },
        ],
        notes: [],
      },
    });

    expect(recommendation.recommended).toMatchObject({
      ctxSize: 16_384,
      batchSize: 1024,
      ubatchSize: 512,
    });
    expect(recommendation.warnings.join("\n")).not.toContain("confidence is low");
  });
});
