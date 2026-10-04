import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";
import type { LlamaCppRuntimeStatus } from "@goatcitadel/contracts";
import type { LlamaCppRuntimeService } from "./llama-cpp-runtime-service.js";
import type { LlamaCppSetupService } from "./llama-cpp-setup-service.js";

export const llamaCppRouteMethods = [
  "adviseLlamaCppRuntime",
  "cancelLlamaCppHuggingFaceDownload",
  "detectLlamaCppInstall",
  "getLlamaCppHuggingFaceDownload",
  "getLlamaCppSetup",
  "listLlamaCppModels",
  "refreshLlamaCppRuntime",
  "startLlamaCppHuggingFaceDownload",
  "startLlamaCppRuntime",
  "stageLlamaCppManagedSelection",
  "stopLlamaCppRuntime",
  "testLlamaCppChat",
] as const;

export type LlamaCppRouteMethod = (typeof llamaCppRouteMethods)[number];
export type LlamaCppRoutePort = RoutePort<LlamaCppRouteMethod>;
export type LlamaCppRouteService = RouteService<LlamaCppRouteMethod>;

export interface LlamaCppRoutePortDependencies {
  llamaCppRuntime: LlamaCppRuntimeService;
  setup: LlamaCppSetupService;
  publishRealtime: (eventType: string, source: string, payload: Record<string, unknown>) => Promise<unknown>;
}

/**
 * What other windows need to hear about. `updatedAt` moves with every probe, and for a managed
 * llama-server `lastError` holds its latest stderr line (including the log line for each health
 * probe), so neither counts as a change on its own. Real failures still change `healthy` and
 * `processState`.
 *
 * In `leaseDiagnostics`, only `evidence.lastProbe.at` moves with every probe, but the whole object
 * is left out on purpose. So a lease-only transition (`activeLeaseCount`, `state`, `ownership`) is
 * no longer announced on its own; the next announced status carries it.
 */
export function llamaCppStatusSignature(status: LlamaCppRuntimeStatus): string {
  return JSON.stringify({ ...status, updatedAt: undefined, leaseDiagnostics: undefined, lastError: undefined });
}

export function createLlamaCppRoutePort(deps: LlamaCppRoutePortDependencies): LlamaCppRoutePort {
  const runtime = deps.llamaCppRuntime;
  const setup = deps.setup;
  return {
    adviseLlamaCppRuntime: (input) => runtime.advise(input),
    cancelLlamaCppHuggingFaceDownload: (jobId) => runtime.cancelHuggingFaceDownload(jobId),
    detectLlamaCppInstall: () => runtime.detectLocalInstall(),
    getLlamaCppHuggingFaceDownload: (jobId) => runtime.getHuggingFaceDownloadStatus(jobId),
    getLlamaCppSetup: (workspaceId) => setup.get(workspaceId),
    listLlamaCppModels: () => runtime.listModels(),
    refreshLlamaCppRuntime: async () => {
      // Status reads probe the runtime because nothing else watches it. Announce only a probe
      // that changed the status; announcing every read made each window read it again.
      const before = llamaCppStatusSignature(runtime.getStatus());
      const status = await runtime.refresh();
      if (llamaCppStatusSignature(status) !== before) {
        await deps.publishRealtime("system", "llamacpp", {
          type: "llamacpp_refreshed",
          status,
        });
      }
      return status;
    },
    startLlamaCppHuggingFaceDownload: (input) => runtime.startHuggingFaceDownload(input),
    startLlamaCppRuntime: async () => {
      const status = await runtime.start("api");
      await deps.publishRealtime("system", "llamacpp", {
        type: "llamacpp_started",
        status,
      });
      return status;
    },
    stageLlamaCppManagedSelection: (input) => setup.stageManagedSelection(input),
    stopLlamaCppRuntime: async () => {
      const status = await runtime.stop("api");
      await deps.publishRealtime("system", "llamacpp", {
        type: "llamacpp_stopped",
        status,
      });
      return status;
    },
    testLlamaCppChat: (workspaceId) => setup.chatTest(workspaceId),
  };
}

export function createLlamaCppRouteService(port: LlamaCppRoutePort): LlamaCppRouteService {
  return createRouteService(port, llamaCppRouteMethods);
}
