import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";
import type { NpuSidecarService } from "./npu-sidecar-service.js";

export const npuRouteMethods = [
  "getNpuStatus",
  "listNpuModels",
  "refreshNpuRuntime",
  "startNpuRuntime",
  "stopNpuRuntime",
] as const;

export type NpuRouteMethod = (typeof npuRouteMethods)[number];
export type NpuRoutePort = RoutePort<NpuRouteMethod>;
export type NpuRouteService = RouteService<NpuRouteMethod>;

export interface NpuRoutePortDependencies {
  npuSidecar: NpuSidecarService;
  publishRealtime: (eventType: string, source: string, payload: Record<string, unknown>) => Promise<unknown>;
}

export function createNpuRoutePort(deps: NpuRoutePortDependencies): NpuRoutePort {
  return {
    getNpuStatus: () => deps.npuSidecar.getStatus(),
    listNpuModels: () => deps.npuSidecar.listModels(),
    refreshNpuRuntime: async () => {
      const status = await deps.npuSidecar.refresh();
      await deps.publishRealtime("system", "npu", {
        type: "npu_refreshed",
        status,
      });
      return status;
    },
    startNpuRuntime: async () => {
      const status = await deps.npuSidecar.start("api");
      await deps.publishRealtime("system", "npu", {
        type: "npu_started",
        status,
      });
      return status;
    },
    stopNpuRuntime: async () => {
      const status = await deps.npuSidecar.stop("api");
      await deps.publishRealtime("system", "npu", {
        type: "npu_stopped",
        status,
      });
      return status;
    },
  };
}

export function createNpuRouteService(port: NpuRoutePort): NpuRouteService {
  return createRouteService(port, npuRouteMethods);
}
