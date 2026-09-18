import type { AsyncStorage } from "@goatcitadel/storage";
import type { GatewayRouteServices } from "./gateway-route-services.js";
import type { createRemoteWorkerExecutionOwners } from "./remote-worker-execution-owners.js";
import { createGatewayRemoteWorkerAdmissionNativeRequestHandler } from "./remote-worker-admission-composition.js";
import { createGatewayRemoteWorkerAssignmentRuntimeComposition, remoteWorkerAssignmentRuntimeActivated } from "./remote-worker-assignment-runtime-composition.js";
import type { EnabledRemoteWorkerRuntimeConfig } from "./remote-worker-runtime-config.js";
import { RemoteWorkerProtectedAdmissionEvidenceVerifier } from "./remote-worker-protected-admission-evidence-verifier.js";
import { RemoteWorkerChatApprovalWaitReadService } from "./remote-worker-chat-approval-wait-read-service.js";

interface NativeWorkerGatewayPort {
  storage: AsyncStorage;
  routeServices: Pick<GatewayRouteServices, "meshCapabilityPublication" | "meshCapabilityInvocation">;
  createRemoteWorkerExecutionOwners(): ReturnType<typeof createRemoteWorkerExecutionOwners>;
}

export async function composeGatewayNativeWorkerHandler(
  gateway: NativeWorkerGatewayPort,
  config: EnabledRemoteWorkerRuntimeConfig,
) {
  // Explicit activation composes all native execution owners. Listener,
  // protected admission, current capability and spending checks still apply.
  const activated = remoteWorkerAssignmentRuntimeActivated();
  const { meshCapabilityPublication: publication, meshCapabilityInvocation: invocation } = gateway.routeServices;
  const meshCapabilities = publication && invocation ? { publication, invocation } : undefined;
  if (activated && !meshCapabilities) throw new Error("Remote worker mesh capability owners are unavailable.");
  const assignmentRuntime = activated
    ? createGatewayRemoteWorkerAssignmentRuntimeComposition({
        admissionStore: gateway.storage.remoteWorkerAdmissions,
        meshAdmissions: gateway.storage.remoteWorkerMeshNodeAdmissions,
        assignments: gateway.storage.remoteWorkerAssignments,
        nonceConsumer: gateway.storage.remoteWorkerNonces,
        execution: gateway.createRemoteWorkerExecutionOwners(),
        meshCapabilities,
        approvalWait: new RemoteWorkerChatApprovalWaitReadService(gateway.storage),
      })
    : undefined;
  return await createGatewayRemoteWorkerAdmissionNativeRequestHandler({
    config,
    admissionStore: gateway.storage.remoteWorkerAdmissions,
    meshNodeAdmissionStore: gateway.storage.remoteWorkerMeshNodeAdmissions,
    ...(assignmentRuntime === undefined
      ? {}
      : {
          assignmentProtocol: assignmentRuntime.assignmentProtocol,
          assignmentDispatch: assignmentRuntime.assignmentDispatch,
          meshCapabilities: assignmentRuntime.meshCapabilities,
          ...(assignmentRuntime.assignmentExecution === undefined
            ? {}
            : { assignmentExecution: assignmentRuntime.assignmentExecution }),
        }),
    createEvidenceVerifier: () => new RemoteWorkerProtectedAdmissionEvidenceVerifier(),
  });
}
