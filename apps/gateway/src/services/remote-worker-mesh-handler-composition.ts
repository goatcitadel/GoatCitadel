import { createRemoteWorkerMeshCapabilityNativeRequestHandler } from "./remote-worker-mesh-capability-handler.js";
import type { RemoteWorkerMeshCapabilityProtocolPort } from "./remote-worker-mesh-capability-protocol-service.js";

interface MeshHandlerDependencies {
  readonly meshCapabilities?: RemoteWorkerMeshCapabilityProtocolPort;
}

/** Optional mesh capability route must pass its owner preflight before it can
 * join the otherwise all-or-nothing native listener. No listener binds here. */
export async function prepareWorkerMeshCapabilityHandler(dependencies: MeshHandlerDependencies) {
  await dependencies.meshCapabilities?.assertAvailable();
  return dependencies.meshCapabilities === undefined ? undefined
    : createRemoteWorkerMeshCapabilityNativeRequestHandler(dependencies.meshCapabilities);
}
