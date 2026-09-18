import type { RemoteWorkerDurableNonceConsumePort } from "./remote-worker-protocol.js";
import type { RemoteWorkerAssignmentMeshAuthorityPort, RemoteWorkerAssignmentProtocolStorePort } from "./remote-worker-assignment-protocol-service.js";
import type { RemoteWorkerAssignmentDispatchStorePort } from "./remote-worker-assignment-dispatch-service.js";
import type { RemoteWorkerAssignmentExecutionOwnerDependencies } from "./remote-worker-assignment-runtime-composition.js";

interface PreflightDependencies {
  readonly nonceConsumer: RemoteWorkerDurableNonceConsumePort;
  readonly meshAdmissions: RemoteWorkerAssignmentMeshAuthorityPort;
  readonly assignments: RemoteWorkerAssignmentProtocolStorePort & RemoteWorkerAssignmentDispatchStorePort;
  readonly execution?: RemoteWorkerAssignmentExecutionOwnerDependencies;
}

/** Structural availability only; current execution authority remains with each runtime owner. */
export function createWorkerAssignmentPreflight(
  dependencies: PreflightDependencies,
  protectedAuthority: { assertAvailable(): Promise<void> },
) {
  const preflight = async (): Promise<void> => {
    await protectedAuthority.assertAvailable();
    assertPort(dependencies.nonceConsumer, "consume", "durable nonce consumer");
    assertPort(dependencies.meshAdmissions, "resolveCurrentForRuntimeCredential", "mesh admission authority");
    assertPort(dependencies.assignments, "resolveActiveAuthorityByLeaseTokenHash", "assignment store");
    assertPort(dependencies.assignments, "listTaskBoundChatOffers", "assignment offer store");
  };
  const executionPreflight = async (): Promise<void> => {
    await preflight();
    assertPort(dependencies.execution?.inference, "performInference", "inference exchange owner");
    for (const method of ["openUpload", "appendPart", "commitArtifact"]) {
      assertPort(dependencies.execution?.settlement.artifacts, method, "artifact settlement owner");
    }
    assertPort(dependencies.execution?.settlement.effects, "dispatchEffect", "effect settlement owner");
  };
  return { preflight, executionPreflight };
}

function assertPort(value: unknown, method: string, label: string): void {
  // AsyncStorage repositories are callable path proxies on both supported
  // adapters. Require the method, without rejecting that canonical facade.
  if (value === null || (typeof value !== "object" && typeof value !== "function")
    || typeof (value as Record<string, unknown>)[method] !== "function") {
    throw new TypeError(`Remote worker ${label} is unavailable.`);
  }
}
