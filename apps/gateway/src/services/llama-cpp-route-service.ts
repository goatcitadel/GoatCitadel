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
 * What other windows need to hear about, one entry per status field so a new field cannot silently
 * join or leave the signature.
 *
 * - `updatedAt` moves with every probe.
 * - `lastError` holds a managed llama-server's latest stderr line, which changes with every log line
 *   (including the one for each health probe). Real failures still change `healthy` and `processState`.
 * - `leaseDiagnostics` is announced: lease count, state, ownership and purposes are operator-visible and
 *   no separate lease event exists. Only its per-probe `evidence.lastProbe` is left out (its `healthy`
 *   repeats the top-level field).
 */
const LLAMACPP_STATUS_FIELDS = {
  enabled: "announce",
  desiredState: "announce",
  processState: "announce",
  baseUrl: "announce",
  pid: "announce",
  healthy: "announce",
  activeModelId: "announce",
  command: "announce",
  commandSource: "announce",
  modelPath: "announce",
  lastError: "ignore",
  updatedAt: "ignore",
  launchCommandPreview: "announce",
  leaseDiagnostics: "announce",
} as const satisfies Record<keyof LlamaCppRuntimeStatus, "announce" | "ignore">;

export function llamaCppStatusSignature(status: LlamaCppRuntimeStatus): string {
  const announced: Record<string, unknown> = {};
  for (const [field, rule] of Object.entries(LLAMACPP_STATUS_FIELDS)) {
    if (rule === "announce") announced[field] = status[field as keyof LlamaCppRuntimeStatus];
  }
  const lease = status.leaseDiagnostics;
  if (lease) {
    announced.leaseDiagnostics = { ...lease, evidence: lease.evidence && { ...lease.evidence, lastProbe: undefined } };
  }
  return JSON.stringify(announced);
}

export function createLlamaCppRoutePort(deps: LlamaCppRoutePortDependencies): LlamaCppRoutePort {
  const runtime = deps.llamaCppRuntime;
  const setup = deps.setup;
  // The last status other windows heard about. A read announces when it differs from this, not from
  // its own starting snapshot, so overlapping reads announce one change once and a change another
  // probe absorbed is still announced by the next read.
  let lastAnnounced: string | undefined;
  const announce = async (type: string, status: LlamaCppRuntimeStatus) => {
    lastAnnounced = llamaCppStatusSignature(status);
    await deps.publishRealtime("system", "llamacpp", { type, status });
  };
  return {
    adviseLlamaCppRuntime: (input) => runtime.advise(input),
    cancelLlamaCppHuggingFaceDownload: (jobId) => runtime.cancelHuggingFaceDownload(jobId),
    detectLlamaCppInstall: () => runtime.detectLocalInstall(),
    getLlamaCppHuggingFaceDownload: (jobId) => runtime.getHuggingFaceDownloadStatus(jobId),
    getLlamaCppSetup: (workspaceId) => setup.get(workspaceId),
    listLlamaCppModels: () => runtime.listModels(),
    refreshLlamaCppRuntime: async () => {
      // Status reads probe the runtime because nothing else watches it. Announce only a status other
      // windows have not heard; announcing every read made each window read it again.
      lastAnnounced ??= llamaCppStatusSignature(runtime.getStatus());
      const status = await runtime.refresh();
      if (llamaCppStatusSignature(status) !== lastAnnounced) await announce("llamacpp_refreshed", status);
      return status;
    },
    startLlamaCppHuggingFaceDownload: (input) => runtime.startHuggingFaceDownload(input),
    startLlamaCppRuntime: async () => {
      const status = await runtime.start("api");
      await announce("llamacpp_started", status);
      return status;
    },
    stageLlamaCppManagedSelection: (input) => setup.stageManagedSelection(input),
    stopLlamaCppRuntime: async () => {
      const status = await runtime.stop("api");
      await announce("llamacpp_stopped", status);
      return status;
    },
    testLlamaCppChat: (workspaceId) => setup.chatTest(workspaceId),
  };
}

export function createLlamaCppRouteService(port: LlamaCppRoutePort): LlamaCppRouteService {
  return createRouteService(port, llamaCppRouteMethods);
}
