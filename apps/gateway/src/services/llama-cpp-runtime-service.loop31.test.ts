import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlamaCppConfig } from "../config.js";
import { LlamaCppRuntimeService, adviseLlamaCppRuntime, buildLlamaCppLaunchArgs } from "./llama-cpp-runtime-service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llamacpp-loop31-"));
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
      startTimeoutMs: 30_000,
      requestTimeoutMs: 15_000,
      restartBudget: {
        windowMs: 300_000,
        maxRestarts: 2,
        backoffMs: 2_000,
      },
      ...overrides?.server,
    },
    launch: {
      alias: "gemma-4-local",
      ...overrides?.launch,
    },
  };
}

describe("llama.cpp runtime loop31 coverage tails", () => {
  it("delegates close through stop and emits runtime diagnostics through the configured hook", async () => {
    const rootDir = await makeTempDir();
    const service = new LlamaCppRuntimeService({
      rootDir,
      config: createConfig(),
    });
    const stop = vi.fn(async () => service.getStatus());
    (service as unknown as { stop: typeof stop }).stop = stop;

    await service.close();

    expect(stop).toHaveBeenCalledWith("shutdown");

    const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
    const eventingService = new LlamaCppRuntimeService({
      rootDir,
      config: createConfig(),
      onEvent: (eventType, payload) => events.push({ eventType, payload }),
    });
    (eventingService as unknown as { emit(eventType: string, payload: Record<string, unknown>): void }).emit(
      "llamacpp_test_event",
      { ok: true },
    );

    expect(events).toEqual([{ eventType: "llamacpp_test_event", payload: { ok: true } }]);
  });

  it("advises with model-size evidence and preserves unreadable model warnings", async () => {
    const rootDir = await makeTempDir();
    const modelPath = path.join(rootDir, "models", "oversized.gguf");
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, Buffer.alloc(1024));

    const recommendation = await adviseLlamaCppRuntime({
      rootDir,
      config: createConfig({
        launch: {
          modelPath,
        },
      }),
      input: {
        modelPath: path.join(rootDir, "models", "missing.gguf"),
      },
    });

    expect(recommendation.profile.cpuCoresLogical).toBeGreaterThan(0);
    expect(recommendation.recommended.ctxSize).toBeGreaterThanOrEqual(4096);
    expect(recommendation.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Model path could not be read")]),
    );
  });

  it("exposes service advisor results without mutating runtime state", async () => {
    const rootDir = await makeTempDir();
    const service = new LlamaCppRuntimeService({
      rootDir,
      config: createConfig(),
    });

    const before = service.getStatus();
    const advice = await service.advise({});
    const after = service.getStatus();

    expect(advice.profile.platform).toBe(process.platform);
    expect(after).toMatchObject({
      desiredState: before.desiredState,
      processState: before.processState,
      healthy: before.healthy,
    });
  });

  it("covers closed health waits, restart-budget exhaustion, and restart scheduling guards", async () => {
    vi.useFakeTimers();
    const rootDir = await makeTempDir();
    const service = new LlamaCppRuntimeService({
      rootDir,
      config: createConfig({
        server: {
          restartBudget: {
            windowMs: 60_000,
            maxRestarts: 1,
            backoffMs: 25,
          },
        },
      }),
    });

    (service as unknown as { closed: boolean }).closed = true;
    await expect(
      (service as unknown as { waitForHealthy(timeoutMs: number): Promise<boolean> }).waitForHealthy(1000),
    ).resolves.toBe(false);

    (service as unknown as { closed: boolean }).closed = false;
    (service as unknown as { bumpRestartCounter(): void }).bumpRestartCounter();
    expect(() => (service as unknown as { assertRestartBudget(): void }).assertRestartBudget()).toThrow(
      "restart budget exhausted",
    );

    (service as unknown as { restartTimestamps: number[] }).restartTimestamps = [];
    (service as unknown as { desiredState: "running" }).desiredState = "running";
    (service as unknown as { scheduleRestart(): void }).scheduleRestart();
    expect((service as unknown as { restartTimer?: NodeJS.Timeout }).restartTimer).toBeDefined();
    (service as unknown as { scheduleRestart(): void }).scheduleRestart();
    const scheduledTimer = (service as unknown as { restartTimer?: NodeJS.Timeout }).restartTimer;
    expect(scheduledTimer).toBeDefined();

    clearTimeout(scheduledTimer);
    (service as unknown as { restartTimer?: NodeJS.Timeout }).restartTimer = undefined;
    expect((service as unknown as { restartTimer?: NodeJS.Timeout }).restartTimer).toBeUndefined();
  });

  it("omits default reasoning args when operators pass an explicit reasoning override", () => {
    const args = buildLlamaCppLaunchArgs(
      "F:\\code\\personal-ai",
      createConfig({
        server: {
          extraArgs: ["--reasoning", "auto", "--mlock"],
        },
        launch: {
          modelPath: "models/gemma.gguf",
        },
      }),
    );

    expect(args.filter((arg) => arg === "--reasoning")).toHaveLength(1);
    expect(args).toEqual(expect.arrayContaining(["--reasoning", "auto", "--mlock"]));
  });
});
