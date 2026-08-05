import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";
import type { LlamaCppRuntimeService } from "./llama-cpp-runtime-service.js";

export const llamaCppRouteMethods = [
  "adviseLlamaCppRuntime",
  "cancelLlamaCppHuggingFaceDownload",
  "detectLlamaCppInstall",
  "getLlamaCppHuggingFaceDownload",
  "listLlamaCppModels",
  "refreshLlamaCppRuntime",
  "startLlamaCppHuggingFaceDownload",
  "startLlamaCppRuntime",
  "stopLlamaCppRuntime",
] as const;

export type LlamaCppRouteMethod = (typeof llamaCppRouteMethods)[number];
export type LlamaCppRoutePort = RoutePort<LlamaCppRouteMethod>;
export type LlamaCppRouteService = RouteService<LlamaCppRouteMethod>;

export interface LlamaCppRoutePortDependencies {
  llamaCppRuntime: LlamaCppRuntimeService;
  publishRealtime: (eventType: string, source: string, payload: Record<string, unknown>) => Promise<unknown>;
}

export function createLlamaCppRoutePort(deps: LlamaCppRoutePortDependencies): LlamaCppRoutePort {
  return {
    adviseLlamaCppRuntime: (input) => deps.llamaCppRuntime.advise(input),
    cancelLlamaCppHuggingFaceDownload: (jobId) => deps.llamaCppRuntime.cancelHuggingFaceDownload(jobId),
    detectLlamaCppInstall: () => deps.llamaCppRuntime.detectLocalInstall(),
    getLlamaCppHuggingFaceDownload: (jobId) => deps.llamaCppRuntime.getHuggingFaceDownloadStatus(jobId),
    listLlamaCppModels: () => deps.llamaCppRuntime.listModels(),
    refreshLlamaCppRuntime: async () => {
      const status = await deps.llamaCppRuntime.refresh();
      await deps.publishRealtime("system", "llamacpp", {
        type: "llamacpp_refreshed",
        status,
      });
      return status;
    },
    startLlamaCppHuggingFaceDownload: (input) => deps.llamaCppRuntime.startHuggingFaceDownload(input),
    startLlamaCppRuntime: async () => {
      const status = await deps.llamaCppRuntime.start("api");
      await deps.publishRealtime("system", "llamacpp", {
        type: "llamacpp_started",
        status,
      });
      return status;
    },
    stopLlamaCppRuntime: async () => {
      const status = await deps.llamaCppRuntime.stop("api");
      await deps.publishRealtime("system", "llamacpp", {
        type: "llamacpp_stopped",
        status,
      });
      return status;
    },
  };
}

export function createLlamaCppRouteService(port: LlamaCppRoutePort): LlamaCppRouteService {
  return createRouteService(port, llamaCppRouteMethods);
}
