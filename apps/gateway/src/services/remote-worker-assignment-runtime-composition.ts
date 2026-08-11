import {
  RemoteWorkerAssignmentDispatchService,
  type RemoteWorkerAssignmentDispatchStorePort,
  type RemoteWorkerAssignmentMeshAdmissionPort,
} from "./remote-worker-assignment-dispatch-service.js";
import {
  RemoteWorkerAssignmentDispatchProtocolService,
  type RemoteWorkerAssignmentDispatchProtocolRequest,
  type RemoteWorkerAssignmentDispatchProtocolResponse,
} from "./remote-worker-assignment-dispatch-protocol-service.js";
import {
  RemoteWorkerAssignmentProtocolService,
  type RemoteWorkerAssignmentMeshAuthorityPort,
  type RemoteWorkerAssignmentProtocolRequest,
  type RemoteWorkerAssignmentProtocolResponse,
  type RemoteWorkerAssignmentProtocolStorePort,
} from "./remote-worker-assignment-protocol-service.js";
import {
  RemoteWorkerCurrentAuthorityService,
  type RemoteWorkerCurrentRuntimeCredentialStorePort,
} from "./remote-worker-current-authority-service.js";
import {
  RemoteWorkerProtectedAdmissionAuthorityService,
  type RemoteWorkerProtectedAdmissionAuthorityStorePort,
} from "./remote-worker-protected-admission-authority-service.js";
import type { RemoteWorkerDurableNonceConsumePort } from "./remote-worker-protocol.js";

/**
 * Explicit activation gate for the connected-worker assignment runtime. This is
 * deliberately NOT one of the `GOATCITADEL_REMOTE_WORKER(S)_*` listener settings
 * (those are rejected as unknown by the listener config), so composing the
 * assignment RPC (routes 2-6) and dispatch (routes 8-10) owners is a separate,
 * owner-made decision from turning the native listener on. Default is off: the
 * production runtime factory omits these owners and the listener stays dark.
 */
export const REMOTE_WORKER_ASSIGNMENT_RUNTIME_ACTIVATION_ENV = "GOATCITADEL_WORKER_ASSIGNMENT_RUNTIME_ENABLED";

export function remoteWorkerAssignmentRuntimeActivated(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env[REMOTE_WORKER_ASSIGNMENT_RUNTIME_ACTIVATION_ENV];
  if (raw === undefined || raw === "false") return false;
  if (raw === "true") return true;
  throw new Error(`${REMOTE_WORKER_ASSIGNMENT_RUNTIME_ACTIVATION_ENV} must be exactly "true" or "false".`);
}

/** An injected assignment-protocol owner shaped for the native-listener composition. */
export interface RemoteWorkerAssignmentProtocolOwner {
  assertAvailable(): Promise<void>;
  execute(input: RemoteWorkerAssignmentProtocolRequest): Promise<RemoteWorkerAssignmentProtocolResponse>;
}

/** An injected assignment-dispatch owner shaped for the native-listener composition. */
export interface RemoteWorkerAssignmentDispatchOwner {
  assertAvailable(): Promise<void>;
  execute(
    input: RemoteWorkerAssignmentDispatchProtocolRequest,
  ): Promise<RemoteWorkerAssignmentDispatchProtocolResponse>;
}

export interface RemoteWorkerAssignmentRuntimeComposition {
  readonly assignmentProtocol: RemoteWorkerAssignmentProtocolOwner;
  readonly assignmentDispatch: RemoteWorkerAssignmentDispatchOwner;
}

export interface RemoteWorkerAssignmentRuntimeCompositionDependencies {
  readonly admissionStore: RemoteWorkerCurrentRuntimeCredentialStorePort &
    RemoteWorkerProtectedAdmissionAuthorityStorePort;
  readonly meshAdmissions: RemoteWorkerAssignmentMeshAuthorityPort & RemoteWorkerAssignmentMeshAdmissionPort;
  readonly assignments: RemoteWorkerAssignmentProtocolStorePort & RemoteWorkerAssignmentDispatchStorePort;
  readonly nonceConsumer: RemoteWorkerDurableNonceConsumePort;
  readonly clock?: () => Date;
}

/**
 * Assemble the assignment RPC (routes 2-6) and dispatch (routes 8-10) owners
 * over the canonical storage repositories, reusing one current-authority
 * resolver so both owners resolve the M2 credential identically. The owners are
 * shaped as injected ports (with a fail-closed structural preflight) so the
 * existing native-listener composition can wire them without change, and so the
 * connected-worker E2E can compose the exact production owners single-host.
 */
export function createGatewayRemoteWorkerAssignmentRuntimeComposition(
  dependencies: RemoteWorkerAssignmentRuntimeCompositionDependencies,
): RemoteWorkerAssignmentRuntimeComposition {
  const clock = dependencies.clock ?? ((): Date => new Date());
  const protectedAuthority = new RemoteWorkerProtectedAdmissionAuthorityService(dependencies.admissionStore);
  const currentAuthority = new RemoteWorkerCurrentAuthorityService(dependencies.admissionStore, protectedAuthority);
  const assignmentProtocolService = new RemoteWorkerAssignmentProtocolService({
    credentialAuthority: currentAuthority,
    meshAdmissions: dependencies.meshAdmissions,
    nonceConsumer: dependencies.nonceConsumer,
    assignments: dependencies.assignments,
    clock,
  });
  const dispatchService = new RemoteWorkerAssignmentDispatchService(
    dependencies.assignments,
    dependencies.meshAdmissions,
  );
  const dispatchProtocolService = new RemoteWorkerAssignmentDispatchProtocolService({
    credentialAuthority: currentAuthority,
    nonceConsumer: dependencies.nonceConsumer,
    dispatch: dispatchService,
    clock,
  });
  const preflight = async (): Promise<void> => {
    await protectedAuthority.assertAvailable();
    assertPort(dependencies.nonceConsumer, "consume", "durable nonce consumer");
    assertPort(dependencies.meshAdmissions, "resolveCurrentForRuntimeCredential", "mesh admission authority");
    assertPort(dependencies.assignments, "resolveActiveAuthorityByLeaseTokenHash", "assignment store");
    assertPort(dependencies.assignments, "listTaskBoundChatOffers", "assignment offer store");
  };
  return Object.freeze({
    assignmentProtocol: Object.freeze({
      assertAvailable: preflight,
      execute: (input: RemoteWorkerAssignmentProtocolRequest) => assignmentProtocolService.execute(input),
    }),
    assignmentDispatch: Object.freeze({
      assertAvailable: preflight,
      execute: (input: RemoteWorkerAssignmentDispatchProtocolRequest) => dispatchProtocolService.execute(input),
    }),
  });
}

function assertPort(value: unknown, method: string, label: string): void {
  if (value === null || typeof value !== "object" || typeof (value as Record<string, unknown>)[method] !== "function") {
    throw new TypeError(`Remote worker ${label} is unavailable.`);
  }
}
