import { describe, expect, it, vi } from "vitest";
import {
  createLlamaCppRoutePort,
  createLlamaCppRouteService,
  llamaCppRouteMethods,
} from "./llama-cpp-route-service.js";

describe("llama.cpp route service facade", () => {
  it("delegates runtime calls and publishes lifecycle realtime events", async () => {
    const status = {
      mode: "managed",
      running: true,
    };
    const llamaCppRuntime = {
      advise: vi.fn(async (input: unknown) => ({ recommendation: "install", input })),
      cancelHuggingFaceDownload: vi.fn((jobId: string) => ({ jobId, state: "cancelled" })),
      detectLocalInstall: vi.fn(() => ({ installed: true })),
      getHuggingFaceDownloadStatus: vi.fn((jobId: string) => ({ jobId, state: "running" })),
      getStatus: vi.fn(() => status),
      listModels: vi.fn(() => [{ id: "llama-3" }]),
      refresh: vi.fn(async () => ({ ...status, refreshed: true })),
      start: vi.fn(async (source: string) => ({ ...status, source })),
      startHuggingFaceDownload: vi.fn((input: unknown) => ({ jobId: "download-1", input })),
      stop: vi.fn(async (source: string) => ({ running: false, source })),
    };
    const setup = {
      get: vi.fn(async (workspaceId: string) => ({ workspaceId })),
      stageManagedSelection: vi.fn(async (input: unknown) => input),
      chatTest: vi.fn(async (workspaceId: string) => ({ workspaceId, success: false })),
    };
    const publishRealtime = vi.fn();
    const port = createLlamaCppRoutePort({
      llamaCppRuntime: llamaCppRuntime as never,
      setup: setup as never,
      publishRealtime,
    });
    const service = createLlamaCppRouteService(port);

    expect(Object.isFrozen(service)).toBe(true);
    expect(Object.keys(service)).toEqual([...llamaCppRouteMethods]);
    await expect(service.adviseLlamaCppRuntime({ goal: "local model" })).resolves.toMatchObject({
      recommendation: "install",
      input: { goal: "local model" },
    });
    expect(service.cancelLlamaCppHuggingFaceDownload("job-1")).toEqual({ jobId: "job-1", state: "cancelled" });
    expect(service.detectLlamaCppInstall()).toEqual({ installed: true });
    expect(service.getLlamaCppHuggingFaceDownload("job-2")).toEqual({ jobId: "job-2", state: "running" });
    expect(service.listLlamaCppModels()).toEqual([{ id: "llama-3" }]);
    await expect(service.refreshLlamaCppRuntime()).resolves.toMatchObject({ refreshed: true });
    expect(service.startLlamaCppHuggingFaceDownload({ modelId: "llama-3" })).toEqual({
      jobId: "download-1",
      input: { modelId: "llama-3" },
    });
    await expect(service.startLlamaCppRuntime()).resolves.toMatchObject({ running: true, source: "api" });
    await expect(service.stopLlamaCppRuntime()).resolves.toMatchObject({ running: false, source: "api" });
    await expect(service.getLlamaCppSetup("workspace-a")).resolves.toEqual({ workspaceId: "workspace-a" });
    await service.stageLlamaCppManagedSelection({ workspaceId: "workspace-a", modelId: "model-a" });
    await expect(service.testLlamaCppChat("workspace-a")).resolves.toEqual({
      workspaceId: "workspace-a",
      success: false,
    });

    for (const method of Object.values(llamaCppRuntime)) {
      expect(method.mock.contexts).toEqual([llamaCppRuntime]);
    }
    for (const method of Object.values(setup)) {
      expect(method.mock.contexts).toEqual([setup]);
    }

    expect(llamaCppRuntime.advise).toHaveBeenCalledWith({ goal: "local model" });
    expect(llamaCppRuntime.start).toHaveBeenCalledWith("api");
    expect(llamaCppRuntime.stop).toHaveBeenCalledWith("api");
    expect(publishRealtime).toHaveBeenCalledWith("system", "llamacpp", {
      type: "llamacpp_refreshed",
      status: { ...status, refreshed: true },
    });
    expect(publishRealtime).toHaveBeenCalledWith("system", "llamacpp", {
      type: "llamacpp_started",
      status: { ...status, source: "api" },
    });
    expect(publishRealtime).toHaveBeenCalledWith("system", "llamacpp", {
      type: "llamacpp_stopped",
      status: { running: false, source: "api" },
    });
    expect(llamaCppRuntime.start.mock.invocationCallOrder[0]).toBeLessThan(
      publishRealtime.mock.invocationCallOrder[1]!,
    );
  });

  it("never emits a successful lifecycle signal when the runtime owner rejects start", async () => {
    const error = new Error("runtime is externally owned");
    const runtime = {
      start: vi.fn(async () => {
        throw error;
      }),
    };
    const deps = {
      llamaCppRuntime: runtime as never,
      setup: {} as never,
      publishRealtime: vi.fn(async () => undefined),
    };
    const service = createLlamaCppRoutePort(deps);

    await expect(service.startLlamaCppRuntime()).rejects.toBe(error);
    expect(runtime.start.mock.contexts).toEqual([runtime]);
    expect(deps.publishRealtime).not.toHaveBeenCalled();
  });

  it("announces a refresh only when the probe changed what operators see", async () => {
    const steady = {
      enabled: true,
      desiredState: "running",
      processState: "running",
      baseUrl: "http://127.0.0.1:8080/v1",
      healthy: true,
      activeModelId: "gemma-local",
      updatedAt: "2026-10-03T00:00:00.000Z",
    };
    const runtime = {
      getStatus: vi.fn(() => steady),
      refresh: vi.fn(async () => ({ ...steady, updatedAt: "2026-10-03T00:00:05.000Z" })),
    };
    const publishRealtime = vi.fn(async () => undefined);
    const service = createLlamaCppRoutePort({ llamaCppRuntime: runtime as never, setup: {} as never, publishRealtime });

    await service.refreshLlamaCppRuntime();
    expect(publishRealtime).not.toHaveBeenCalled();

    const failed = { ...steady, healthy: false, processState: "error", updatedAt: "2026-10-03T00:00:10.000Z" };
    runtime.refresh.mockResolvedValueOnce(failed);
    await service.refreshLlamaCppRuntime();
    expect(publishRealtime).toHaveBeenCalledExactlyOnceWith("system", "llamacpp", {
      type: "llamacpp_refreshed",
      status: failed,
    });
  });

  it("stays silent when only llama-server's latest log line changed", async () => {
    const healthy = {
      enabled: true,
      desiredState: "running",
      processState: "running",
      baseUrl: "http://127.0.0.1:8080/v1",
      healthy: true,
      activeModelId: "gemma-local",
      updatedAt: "2026-10-03T00:00:00.000Z",
    };
    const runtime = {
      getStatus: vi.fn(() => ({ ...healthy, lastError: "srv  log_server_r: request: GET /health 127.0.0.1 200" })),
      refresh: vi.fn(async () => ({ ...healthy, updatedAt: "2026-10-03T00:00:05.000Z" })),
    };
    const publishRealtime = vi.fn(async () => undefined);
    const service = createLlamaCppRoutePort({ llamaCppRuntime: runtime as never, setup: {} as never, publishRealtime });

    await service.refreshLlamaCppRuntime();
    expect(publishRealtime).not.toHaveBeenCalled();
  });
});
