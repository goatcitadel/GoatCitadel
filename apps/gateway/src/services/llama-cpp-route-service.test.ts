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
      listModels: vi.fn(() => [{ id: "llama-3" }]),
      refresh: vi.fn(async () => ({ ...status, refreshed: true })),
      start: vi.fn(async (source: string) => ({ ...status, source })),
      startHuggingFaceDownload: vi.fn((input: unknown) => ({ jobId: "download-1", input })),
      stop: vi.fn(async (source: string) => ({ running: false, source })),
    };
    const publishRealtime = vi.fn();
    const port = createLlamaCppRoutePort({
      llamaCppRuntime: llamaCppRuntime as never,
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
  });
});
