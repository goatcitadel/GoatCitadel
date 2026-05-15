import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlamaCppHardwareProfile } from "@goatcitadel/contracts";
import type { LlamaCppConfig } from "../config.js";
import {
  LlamaCppRuntimeService,
  buildLlamaCppLaunchArgs,
  normalizeLlamaCppProviderBaseUrl,
  parseAmdGpuTelemetryJson,
  parseNvidiaSmiCsv,
  parseSystemProfilerDisplaysJson,
  parseWindowsVideoControllerJson,
  recommendLlamaCppLaunchSettings,
} from "./llama-cpp-runtime-service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => removeTempDir(dir)));
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llamacpp-runtime-"));
  tempDirs.push(dir);
  return dir;
}

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
      alias: "gemma-4-local",
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
        alias: "gemma-4-local",
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
      "gemma-4-local",
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
      "--reasoning",
      "off",
      "--mlock",
      "--no-warmup",
    ]);
  });

  it("discovers local gguf files from modelsRootPath before relying on the runtime endpoint", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llamacpp-models-"));
    try {
      const modelsRoot = path.join(tempRoot, "models");
      const nestedModel = path.join(modelsRoot, "Gemma-E4B-Opus", "gemma-4-E4B-it.Q8_0.gguf");
      const flatModel = path.join(modelsRoot, "Mistral-Small.gguf");
      await fs.mkdir(path.dirname(nestedModel), { recursive: true });
      await fs.writeFile(nestedModel, "model", "utf8");
      await fs.writeFile(flatModel, "model", "utf8");

      const service = new LlamaCppRuntimeService({
        rootDir: tempRoot,
        config: createConfig({
          launch: {
            modelsRootPath: modelsRoot,
          },
        }),
      });

      await expect(service.listModels()).resolves.toEqual([
        {
          modelId: "Gemma-E4B-Opus/gemma-4-E4B-it.Q8_0",
          filePath: nestedModel,
          relativePath: "Gemma-E4B-Opus/gemma-4-E4B-it.Q8_0.gguf",
          source: "filesystem",
        },
        {
          modelId: "Mistral-Small",
          filePath: flatModel,
          relativePath: "Mistral-Small.gguf",
          source: "filesystem",
        },
      ]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("treats an already healthy remote llama.cpp server as running without spawning a process", async () => {
    const rootDir = await makeTempDir();
    const modelPath = path.join(rootDir, "models", "ready.gguf");
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, "model", "utf8");
    const fetch = vi.fn(async (url: URL | string) => {
      const target = String(url);
      if (target.endsWith("/health")) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ model_alias: "health-alias" }),
          text: async () => "",
        } as Response;
      }
      if (target.endsWith("/v1/models")) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ data: [{ id: "remote-ready", object: "model", created: 1, owned_by: "local" }] }),
        } as Response;
      }
      throw new Error(`Unexpected fetch ${target}`);
    });
    vi.stubGlobal("fetch", fetch);
    const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
    const service = new LlamaCppRuntimeService({
      rootDir,
      config: createConfig({
        launch: { modelPath },
      }),
      onEvent: (eventType, payload) => {
        events.push({ eventType, payload });
      },
    });

    await expect(service.start("manual")).resolves.toMatchObject({
      desiredState: "running",
      processState: "running",
      healthy: true,
      activeModelId: "remote-ready",
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/health",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
    expect(events).toEqual([]);
    await expect(fs.readFile(path.join(rootDir, "data", "llamacpp-runtime-state.json"), "utf8")).resolves.toContain(
      '"healthy": true',
    );
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

  it("handles malformed GPU telemetry and unknown vendor fallbacks without crashing", () => {
    expect(parseWindowsVideoControllerJson("{not json")).toEqual([]);
    expect(parseSystemProfilerDisplaysJson("{not json")).toEqual([]);
    expect(parseSystemProfilerDisplaysJson(JSON.stringify({ SPDisplaysDataType: "missing" }))).toEqual([]);
    expect(parseAmdGpuTelemetryJson("{not json")).toEqual([]);

    expect(
      parseWindowsVideoControllerJson(
        JSON.stringify([{ Name: "Intel Arc Pro", AdapterRAM: "unknown", DriverVersion: 123 }, { AdapterRAM: 1024 }]),
      ),
    ).toEqual([
      expect.objectContaining({
        vendor: "intel",
        name: "Intel Arc Pro",
        vramBytes: undefined,
        driver: undefined,
      }),
      expect.objectContaining({
        vendor: "unknown",
        name: "GPU",
        vramBytes: 1024,
      }),
    ]);
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

  it("keeps CPU-first launch guidance when no GPU is detected or VRAM is too small for the model", () => {
    const noGpu = recommendLlamaCppLaunchSettings({
      profile: createProfile({
        cpuCoresLogical: 6,
        cpuCoresPhysical: undefined,
        systemRamBytes: 16 * 1024 ** 3,
        gpus: [],
      }),
    });
    expect(noGpu.recommended).toMatchObject({
      ctxSize: 4096,
      threads: 4,
      gpuLayers: 0,
      parallel: 1,
      batchSize: 512,
      ubatchSize: 256,
    });
    expect(noGpu.warnings).toEqual(expect.arrayContaining([expect.stringContaining("No discrete GPU was detected")]));

    const modestVram = recommendLlamaCppLaunchSettings({
      profile: createProfile({
        gpus: [
          {
            vendor: "amd",
            name: "Radeon RX 7600",
            source: "rocm-smi",
            confidence: "high",
            vramBytes: 8 * 1024 ** 3,
          },
        ],
      }),
      observedModelBytes: 24 * 1024 ** 3,
    });
    expect(modestVram.recommended.gpuLayers).toBe(0);
    expect(modestVram.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("modest relative to the model size")]),
    );
  });

  it("refreshes status from a healthy OpenAI-compatible llama.cpp endpoint", async () => {
    const tempRoot = await makeTempDir();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "http://127.0.0.1:8080/health") {
        return new Response(JSON.stringify({ model_alias: "health-alias" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "http://127.0.0.1:8080/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "runtime-model", owned_by: "llama.cpp" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    const service = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig(),
    });

    const status = await service.refresh();

    expect(status).toMatchObject({
      desiredState: "stopped",
      processState: "running",
      healthy: true,
      activeModelId: "runtime-model",
      baseUrl: "http://127.0.0.1:8080/v1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(fs.readFile(path.join(tempRoot, "data", "llamacpp-runtime-state.json"), "utf8")).resolves.toContain(
      "runtime-model",
    );
  });

  it("refreshes healthy text responses and falls back to configured alias when model listing fails", async () => {
    const tempRoot = await makeTempDir();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "http://127.0.0.1:8080/health") {
        return new Response("OK", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "http://127.0.0.1:8080/v1/models") {
        return new Response("starting", {
          status: 503,
          headers: { "content-type": "text/plain" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    const service = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig({
        launch: {
          alias: "configured-alias",
        },
      }),
    });

    await expect(service.refresh()).resolves.toMatchObject({
      processState: "running",
      healthy: true,
      activeModelId: "configured-alias",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns current status when start is requested for an already-owned running process", async () => {
    const tempRoot = await makeTempDir();
    const modelPath = path.join(tempRoot, "models", "gemma.gguf");
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, "model", "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "http://127.0.0.1:8080/health") {
          return new Response(JSON.stringify({ model: "owned-runtime" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url === "http://127.0.0.1:8080/v1/models") {
          return new Response(JSON.stringify({ data: [{ id: "owned-runtime" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch,
    );
    const service = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig({
        launch: {
          modelPath,
        },
      }),
    });
    (service as unknown as { process: { pid: number } | null }).process = { pid: 12345 };
    (service as unknown as { processState: "running" }).processState = "running";

    await expect(service.start("already-running")).resolves.toMatchObject({
      desiredState: "running",
      processState: "running",
      healthy: true,
      activeModelId: "owned-runtime",
    });
  });

  it("marks an owned process unhealthy when refresh cannot reach the runtime", async () => {
    const tempRoot = await makeTempDir();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
    );
    const service = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig(),
    });
    (service as unknown as { process: { pid: number } | null; desiredState: "running" }).process = { pid: 12345 };
    (service as unknown as { desiredState: "running" }).desiredState = "running";

    const status = await service.refresh();

    expect(status).toMatchObject({
      desiredState: "running",
      processState: "error",
      healthy: false,
    });
  });

  it("stops without an owned process by preserving observed remote runtime health", async () => {
    const tempRoot = await makeTempDir();
    const restartTimer = setTimeout(() => undefined, 30_000);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "http://127.0.0.1:8080/health") {
        return new Response(JSON.stringify({ model_alias: "remote-alias" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "http://127.0.0.1:8080/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "remote-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    const service = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig(),
    });
    (service as unknown as { restartTimer?: NodeJS.Timeout }).restartTimer = restartTimer;
    (service as unknown as { desiredState: "running" }).desiredState = "running";

    const status = await service.stop("operator");

    expect(status).toMatchObject({
      desiredState: "stopped",
      processState: "running",
      healthy: true,
      activeModelId: "remote-model",
    });
    expect((service as unknown as { restartTimer?: NodeJS.Timeout }).restartTimer).toBeUndefined();
  });

  it("falls back to standard local install detection when an explicit command is missing", async () => {
    const tempRoot = await makeTempDir();
    const service = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig({
        server: {
          command: path.join(tempRoot, "missing", "llama-server.exe"),
        },
      }),
    });

    const detection = await service.detectLocalInstall();

    expect(detection.recommendedBaseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(detection.command).not.toBe(path.join(tempRoot, "missing", "llama-server.exe"));
    expect(["missing", "standard-windows", "path", "path-with-exe"]).toContain(detection.source);
  }, 15_000);

  it("auto-starts during init when the configured remote runtime is already healthy", async () => {
    const tempRoot = await makeTempDir();
    const modelPath = path.join(tempRoot, "models", "gemma.gguf");
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, "model", "utf8");
    const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "http://127.0.0.1:8080/health") {
        return new Response(JSON.stringify({ model_alias: "health-alias" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "http://127.0.0.1:8080/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "remote-ready", owned_by: "llama.cpp" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    const service = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig({
        launch: {
          modelPath,
        },
      }),
      onEvent: (eventType, payload) => {
        events.push({ eventType, payload });
      },
    });
    service.updateConfig({
      ...createConfig({
        launch: {
          modelPath,
        },
      }),
      autoStart: true,
    });

    await service.init();

    expect(service.getStatus()).toMatchObject({
      desiredState: "running",
      processState: "running",
      healthy: true,
      activeModelId: "remote-ready",
      modelPath,
    });
    expect(events).toEqual([]);
    await expect(fs.readFile(path.join(tempRoot, "data", "llamacpp-runtime-state.json"), "utf8")).resolves.toContain(
      "remote-ready",
    );
  });

  it("lists remote models when the filesystem manifest is absent", async () => {
    const tempRoot = await makeTempDir();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("http://127.0.0.1:8080/v1/models");
      return new Response(
        JSON.stringify({
          models: [
            { model: "remote-a", object: "model", created: 123, ownedBy: "operator" },
            { id: "" },
            { id: "remote-b", owned_by: "llama.cpp" },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    const service = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig({
        launch: {
          modelsRootPath: "missing-models",
        },
      }),
    });

    await expect(service.listModels()).resolves.toEqual([
      {
        modelId: "remote-a",
        object: "model",
        created: 123,
        ownedBy: "operator",
      },
      {
        modelId: "remote-b",
        object: undefined,
        created: undefined,
        ownedBy: "llama.cpp",
      },
    ]);
  });

  it("detects an explicitly configured local llama.cpp command", async () => {
    const tempRoot = await makeTempDir();
    const service = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig({
        server: {
          command: process.execPath,
        },
      }),
    });

    await expect(service.detectLocalInstall()).resolves.toMatchObject({
      found: true,
      command: process.execPath,
      source: "configured",
      recommendedBaseUrl: "http://127.0.0.1:8080/v1",
    });
  });

  it("surfaces remote model listing failures when no local model manifest is available", async () => {
    const tempRoot = await makeTempDir();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "starting" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
      ) as typeof fetch,
    );
    const service = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig({
        launch: {
          modelsRootPath: "missing-models",
        },
      }),
    });

    await expect(service.listModels()).rejects.toThrow("llama.cpp model listing failed (503)");
  });

  it("renders operator launch previews with quoted paths from cached runtime state", async () => {
    const tempRoot = await makeTempDir();
    const service = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig({
        server: {
          baseUrl: "http://127.0.0.1:18080/v1",
          extraArgs: ["--model-note", "ops model"],
        },
        launch: {
          modelPath: "models/Gemma Ops.gguf",
          alias: "gemma ops",
        },
      }),
    });
    (service as unknown as { lastCommand?: string }).lastCommand = "C:\\Program Files\\llama server\\llama-server.exe";

    expect(service.getStatus().launchCommandPreview).toContain('"C:\\Program Files\\llama server\\llama-server.exe"');
    expect(service.getStatus().launchCommandPreview).toContain('"gemma ops"');
    expect(service.getStatus().launchCommandPreview).toContain('"ops model"');
    expect(service.getStatus().modelPath).toBe(path.join(tempRoot, "models", "Gemma Ops.gguf"));
  });

  it("rejects start while disabled before probing model files or remote health", async () => {
    const tempRoot = await makeTempDir();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    const service = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig({
        launch: { modelPath: "models/missing.gguf" },
      }),
    });
    service.updateConfig({
      ...createConfig({
        launch: { modelPath: "models/missing.gguf" },
      }),
      enabled: false,
    });

    await expect(service.start()).rejects.toThrow("llama.cpp runtime is disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects start when launch model configuration is missing or points at a missing file", async () => {
    const tempRoot = await makeTempDir();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    const unconfigured = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig(),
    });
    const missingFile = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig({
        launch: {
          modelPath: "models/missing.gguf",
        },
      }),
    });

    await expect(unconfigured.start()).rejects.toThrow("launch.modelPath must be configured");
    await expect(missingFile.start()).rejects.toThrow("llama.cpp model path does not exist");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes Hugging Face download jobs and supports immediate cancellation", async () => {
    const tempRoot = await makeTempDir();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
              once: true,
            });
          }),
      ) as typeof fetch,
    );
    const service = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig({
        launch: {
          modelsRootPath: "models",
          alias: "configured-alias",
        },
      }),
    });

    const queued = await service.startHuggingFaceDownload({
      repo: " google/gemma-3n-E4B-it-GGUF ",
      filename: " Q4_K_M/gemma.gguf ",
      mmprojFilename: " mmproj/model.gguf ",
      sha256: "A".repeat(64),
      mmprojSha256: "B".repeat(64),
    });
    const cancelled = service.cancelHuggingFaceDownload(queued.jobId);

    expect(queued).toMatchObject({
      status: "queued",
      stage: "model",
      repo: "google/gemma-3n-E4B-it-GGUF",
      alias: "configured-alias",
      filename: "Q4_K_M/gemma.gguf",
      mmprojFilename: "mmproj/model.gguf",
      sourceUrl: "https://huggingface.co/google/gemma-3n-E4B-it-GGUF/resolve/main/Q4_K_M/gemma.gguf",
      mmprojSourceUrl: "https://huggingface.co/google/gemma-3n-E4B-it-GGUF/resolve/main/mmproj/model.gguf",
      expectedSha256: "a".repeat(64),
      expectedMmprojSha256: "b".repeat(64),
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      stage: "done",
      error: "Cancelled by user.",
    });
    expect(service.getHuggingFaceDownloadStatus(queued.jobId)).toMatchObject({
      status: "cancelled",
    });
  });

  it("downloads Hugging Face GGUF artifacts to the managed models root and records hashes", async () => {
    const tempRoot = await makeTempDir();
    const payload = new TextEncoder().encode("model-bytes");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(payload, {
            status: 200,
            headers: { "content-length": String(payload.length) },
          }),
      ) as typeof fetch,
    );
    const service = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig({
        launch: {
          modelsRootPath: "models",
        },
      }),
    });

    const queued = await service.startHuggingFaceDownload({
      repo: "owner/model",
      filename: "quant/model.gguf",
      sha256,
    });
    const completed = await waitForDownloadStatus(service, queued.jobId, "completed");

    expect(completed).toMatchObject({
      status: "completed",
      stage: "done",
      modelBytes: payload.length,
      actualSha256: sha256,
      bytesDownloaded: payload.length,
      totalBytes: payload.length,
    });
    await expect(
      fs.readFile(path.join(tempRoot, "models", "owner_model", "quant", "model.gguf"), "utf8"),
    ).resolves.toBe("model-bytes");
  });

  it("downloads optional Hugging Face mmproj artifacts and records their progress and hashes", async () => {
    const tempRoot = await makeTempDir();
    const modelPayload = new TextEncoder().encode("model-bytes");
    const mmprojPayload = new TextEncoder().encode("mmproj-bytes");
    const modelSha256 = createHash("sha256").update(modelPayload).digest("hex");
    const mmprojSha256 = createHash("sha256").update(mmprojPayload).digest("hex");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const payload = url.endsWith("/mmproj/model.gguf") ? mmprojPayload : modelPayload;
      return new Response(payload, {
        status: 200,
        headers: { "content-length": String(payload.length) },
      });
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    const service = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig({
        launch: {
          modelsRootPath: "models",
        },
      }),
    });

    const queued = await service.startHuggingFaceDownload({
      repo: "owner/model",
      filename: "quant/model.gguf",
      mmprojFilename: "mmproj/model.gguf",
      sha256: modelSha256,
      mmprojSha256,
    });
    const completed = await waitForDownloadStatus(service, queued.jobId, "completed");

    expect(completed).toMatchObject({
      status: "completed",
      stage: "done",
      modelBytes: modelPayload.length,
      mmprojBytes: mmprojPayload.length,
      actualSha256: modelSha256,
      actualMmprojSha256: mmprojSha256,
      bytesDownloaded: modelPayload.length,
      totalBytes: modelPayload.length,
      mmprojBytesDownloaded: mmprojPayload.length,
      mmprojTotalBytes: mmprojPayload.length,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(
      fs.readFile(path.join(tempRoot, "models", "owner_model", "mmproj", "model.gguf"), "utf8"),
    ).resolves.toBe("mmproj-bytes");
  });

  it("persists Hugging Face download failures when integrity verification fails", async () => {
    const tempRoot = await makeTempDir();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new TextEncoder().encode("wrong-bytes"), {
            status: 200,
            headers: { "content-length": "11" },
          }),
      ) as typeof fetch,
    );
    const service = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig({
        launch: {
          modelsRootPath: "models",
        },
      }),
    });

    const queued = await service.startHuggingFaceDownload({
      repo: "owner/model",
      filename: "model.gguf",
      sha256: "0".repeat(64),
    });
    const failed = await waitForDownloadStatus(service, queued.jobId, "failed");

    expect(failed).toMatchObject({
      status: "failed",
      stage: "model",
      error: "SHA256 mismatch for model.gguf.",
    });
  });

  it("rejects malformed Hugging Face download inputs and unknown download job lookups", async () => {
    const tempRoot = await makeTempDir();
    const service = new LlamaCppRuntimeService({
      rootDir: tempRoot,
      config: createConfig(),
    });

    await expect(service.startHuggingFaceDownload({ repo: "bad", filename: "model.gguf" })).rejects.toThrow(
      "owner/name",
    );
    await expect(service.startHuggingFaceDownload({ repo: "owner/model", filename: "../model.gguf" })).rejects.toThrow(
      "invalid path segment",
    );
    await expect(service.startHuggingFaceDownload({ repo: "owner/model", filename: "model.txt" })).rejects.toThrow(
      "Only GGUF",
    );
    await expect(
      service.startHuggingFaceDownload({ repo: "owner/model", filename: "model.gguf", sha256: "abc" }),
    ).rejects.toThrow("SHA256");
    expect(() => service.getHuggingFaceDownloadStatus("missing")).toThrow("Unknown llama.cpp download job");
    expect(() => service.cancelHuggingFaceDownload("missing")).toThrow("Unknown llama.cpp download job");
  });
});

async function waitForDownloadStatus(
  service: LlamaCppRuntimeService,
  jobId: string,
  status: "completed" | "failed" | "cancelled",
): Promise<ReturnType<LlamaCppRuntimeService["getHuggingFaceDownloadStatus"]>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = service.getHuggingFaceDownloadStatus(jobId);
    if (current.status === status) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for llama.cpp download ${jobId} to reach ${status}.`);
}

async function removeTempDir(target: string): Promise<void> {
  const transientCodes = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!transientCodes.has(String(code)) || attempt === 7) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}
