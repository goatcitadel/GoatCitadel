import { RemoteWorkersRouteService } from "./remote-workers-route-service.js";
import type { GatewayRouteCompositionPort, RouteDependencyDomain } from "./gateway-route-composition-port.js";
import { createConfiguredRemoteWorkerManifestVerifier } from "./remote-worker-manifest-verifier.js";

/** Route wiring uses existing runtime owners; it does not enable native admission. */
export function composeRemoteWorkerRouteDependencies(
  gateway: Pick<GatewayRouteCompositionPort, "storage" | "createRemoteWorkerExecutionOwners">,
): RouteDependencyDomain<"remoteWorkers">["remoteWorkers"] {
  const nativeRuntime = () => gateway.createRemoteWorkerExecutionOwners().operatorNativeRuntime;
  return {
    registry: gateway.storage.remoteWorkerAdmissions,
    assignments: gateway.storage.remoteWorkerAssignments,
    runtimeReads: gateway.storage.remoteWorkerRuntimeReads,
    nativeFiles: {
      list: (key, signal) => gateway.createRemoteWorkerExecutionOwners().operatorNativeFiles.list(key, signal),
      download: (key, signal) => gateway.createRemoteWorkerExecutionOwners().operatorNativeFiles.download(key, signal),
    },
    nativeRuntime: {
      requestReview: (input, signal) => nativeRuntime().requestReview(input, signal),
      requestInstallationReview: (input, signal) => nativeRuntime().requestInstallationReview(input, signal),
      retainInstallationReview: (input, signal) => nativeRuntime().retainInstallationReview(input, signal),
    },
    operatorControl: {
      budgets: gateway.storage.remoteWorkerBudgets,
      admissions: gateway.storage.remoteWorkerAdmissions,
      audit: gateway.storage.audit,
      manifestVerifier: createConfiguredRemoteWorkerManifestVerifier(),
      // Join-secret issuance stays dark with native admission until its
      // protected signer and assignment owner can pass startup preflight.
    },
  };
}

export function createRemoteWorkerRouteService(
  deps: RouteDependencyDomain<"remoteWorkers">["remoteWorkers"],
): RemoteWorkersRouteService {
  return new RemoteWorkersRouteService(
    deps.registry,
    deps.assignments,
    () => new Date().toISOString(),
    deps.operatorControl,
    deps.runtimeReads,
    deps.nativeFiles,
    deps.nativeRuntime,
  );
}
