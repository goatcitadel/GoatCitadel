import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NpuConfig } from "../config.js";
import { NpuSidecarService } from "./npu-sidecar-service.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);
const originalFetch = globalThis.fetch;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalKill = process.kill;
const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  spawnMock.mockReset();
  globalThis.fetch = originalFetch;
  process.kill = originalKill;
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("NpuSidecarService", () => {
  it("refreshes health, publishes status, and persists the runtime cache", async () => {
    const rootDir = await createTempRoot();
    const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        activeModelId: "npu-phi",
        backend: "qnn",
        capability: {
          supported: true,
          qnnExecutionProviderAvailable: true,
          details: ["QNN ready"],
        },
      }),
    ) as never;
    const service = new NpuSidecarService({
      rootDir,
      config: createConfig({ enabled: true }),
      onEvent: (eventType, payload) => events.push({ eventType, payload }),
    });

    const status = await service.refresh();

    expect(status).toMatchObject({
      enabled: true,
      desiredState: "stopped",
      processState: "running",
      healthy: true,
      activeModelId: "npu-phi",
      backend: "qnn",
      capability: {
        supported: true,
        qnnExecutionProviderAvailable: true,
      },
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/health",
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
      }),
    );
    expect(events).toEqual([]);
    await expect(readCachedStatus(rootDir)).resolves.toMatchObject({
      healthy: true,
      activeModelId: "npu-phi",
    });
  });

  it("maps model manifests from the sidecar and filters malformed rows", async () => {
    const rootDir = await createTempRoot();
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            id: "phi-3",
            metadata: {
              family: "phi",
              source: "huggingface",
              label: "Phi 3 Mini",
              path: "models/phi",
              default: true,
              requiresQnn: true,
              contextWindow: 4096,
            },
          },
          {
            metadata: {
              modelId: "custom-1",
              family: "unknown-family",
              source: "other-source",
            },
          },
          {
            id: "",
            metadata: {},
          },
        ],
      }),
    ) as never;
    const service = new NpuSidecarService({
      rootDir,
      config: createConfig({ enabled: true }),
    });

    await expect(service.listModels()).resolves.toEqual([
      {
        modelId: "phi-3",
        label: "Phi 3 Mini",
        family: "phi",
        source: "huggingface",
        path: "models/phi",
        sha256: undefined,
        readiness: "unchecked",
        backend: "unknown",
        fallbackReason: undefined,
        default: true,
        requiresQnn: true,
        contextWindow: 4096,
        enabled: true,
      },
      {
        modelId: "custom-1",
        label: "NPU model",
        family: "other",
        source: "custom",
        path: undefined,
        sha256: undefined,
        readiness: "unchecked",
        backend: "unknown",
        fallbackReason: undefined,
        default: false,
        requiresQnn: false,
        contextWindow: undefined,
        enabled: true,
      },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledWith("http://127.0.0.1:11434/models", expect.any(Object));
  });

  it("starts the configured sidecar process, resolves relative args, and stops it on Unix hosts", async () => {
    setPlatform("linux");
    const rootDir = await createTempRoot();
    await fs.mkdir(path.join(rootDir, "runtime"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "runtime", "sidecar.py"), "print('ok')", "utf8");
    const child = createChildProcess(4242);
    spawnMock.mockReturnValue(child as never);
    globalThis.fetch = vi.fn(async () => jsonResponse({ backend: "cpu" })) as never;
    process.kill = vi.fn() as never;
    const events: string[] = [];
    const service = new NpuSidecarService({
      rootDir,
      config: createConfig({
        enabled: true,
        sidecar: {
          command: "python",
          args: ["runtime/sidecar.py", "--port", "11434"],
          baseUrl: "http://127.0.0.1:11434/",
        },
      }),
      onEvent: (eventType) => events.push(eventType),
    });

    await expect(service.start("operator")).resolves.toMatchObject({
      processState: "running",
      healthy: true,
      sidecarPid: 4242,
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "python",
      [path.join(rootDir, "runtime", "sidecar.py"), "--port", "11434"],
      expect.objectContaining({
        cwd: rootDir,
        env: expect.objectContaining({
          GOATCITADEL_NPU_HOST: "127.0.0.1",
          GOATCITADEL_NPU_PORT: "11434",
        }),
        windowsHide: true,
      }),
    );
    expect(events).toEqual(expect.arrayContaining(["npu_starting", "npu_started"]));

    await expect(service.stop("operator")).resolves.toMatchObject({
      desiredState: "stopped",
      processState: "stopped",
      healthy: false,
    });
    expect(process.kill).toHaveBeenCalledWith(4242, "SIGTERM");
  });

  it("loads cached state during init and records an unhealthy refresh when the sidecar is unreachable", async () => {
    const rootDir = await createTempRoot();
    await fs.mkdir(path.join(rootDir, "data"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "data", "npu-runtime-state.json"),
      JSON.stringify({
        desiredState: "running",
        processState: "running",
        healthy: true,
        activeModelId: "cached-model",
        backend: "qnn",
        updatedAt: "2026-05-14T12:00:00.000Z",
      }),
      "utf8",
    );
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as never;
    const service = new NpuSidecarService({
      rootDir,
      config: createConfig({ enabled: false, autoStart: false }),
    });

    await service.init();

    expect(service.getStatus()).toMatchObject({
      desiredState: "running",
      processState: "running",
      healthy: false,
      activeModelId: "cached-model",
      backend: "qnn",
    });
    await expect(readCachedStatus(rootDir)).resolves.toMatchObject({
      healthy: false,
      activeModelId: "cached-model",
    });
  });

  it("rejects disabled starts before launching any sidecar process", async () => {
    const service = new NpuSidecarService({
      rootDir: await createTempRoot(),
      config: createConfig({ enabled: false }),
    });

    await expect(service.start()).rejects.toThrow("NPU runtime is disabled in assistant config");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-npu-sidecar-"));
  tempRoots.push(root);
  return root;
}

function createConfig(overrides: Partial<NpuConfig> & { sidecar?: Partial<NpuConfig["sidecar"]> } = {}): NpuConfig {
  return {
    enabled: overrides.enabled ?? true,
    autoStart: overrides.autoStart ?? false,
    sidecar: {
      command: overrides.sidecar?.command ?? "node",
      args: overrides.sidecar?.args ?? ["sidecar.js"],
      baseUrl: overrides.sidecar?.baseUrl ?? "http://127.0.0.1:11434",
      healthPath: overrides.sidecar?.healthPath ?? "/health",
      modelsPath: overrides.sidecar?.modelsPath ?? "/models",
      requestTimeoutMs: overrides.sidecar?.requestTimeoutMs ?? 500,
      startTimeoutMs: overrides.sidecar?.startTimeoutMs ?? 2_000,
      restartBudget: {
        maxRestarts: overrides.sidecar?.restartBudget?.maxRestarts ?? 2,
        windowMs: overrides.sidecar?.restartBudget?.windowMs ?? 60_000,
        backoffMs: overrides.sidecar?.restartBudget?.backoffMs ?? 100,
      },
    },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function createChildProcess(pid: number): EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

async function readCachedStatus(rootDir: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(rootDir, "data", "npu-runtime-state.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}
