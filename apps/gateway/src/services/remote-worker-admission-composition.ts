import {
  RemoteWorkerAdmissionService,
  type RemoteWorkerAdmissionEvidenceVerifierPort,
  type RemoteWorkerAdmissionStorePort,
} from "./remote-worker-admission-service.js";
import { createRemoteWorkerAdmissionNativeRequestHandler } from "./remote-worker-admission-handler.js";
import {
  RemoteWorkerCurrentAuthorityService,
  type RemoteWorkerCurrentRuntimeCredentialStorePort,
} from "./remote-worker-current-authority-service.js";
import { createRemoteWorkerAssignmentNativeRequestHandler } from "./remote-worker-assignment-handler.js";
import type {
  RemoteWorkerAssignmentProtocolRequest,
  RemoteWorkerAssignmentProtocolResponse,
} from "./remote-worker-assignment-protocol-service.js";
import { createRemoteWorkerMeshNodeAdmissionNativeRequestHandler } from "./remote-worker-mesh-node-admission-handler.js";
import {
  RemoteWorkerMeshNodeAdmissionService,
  type RemoteWorkerMeshNodeAdmissionStorePort,
} from "./remote-worker-mesh-node-admission-service.js";
import { createRemoteWorkerNativeHandlerMux } from "./remote-worker-native-handler-mux.js";
import type { RemoteWorkerNativeRequestHandler } from "./remote-worker-native-tls-listener.js";
import {
  RemoteWorkerProtectedAdmissionAuthorityService,
  type RemoteWorkerProtectedAdmissionAuthorityStorePort,
} from "./remote-worker-protected-admission-authority-service.js";
import type { EnabledRemoteWorkerRuntimeConfig } from "./remote-worker-runtime-config.js";

type Awaitable<T> = T | Promise<T>;

export interface RemoteWorkerAdmissionEvidenceVerifier extends RemoteWorkerAdmissionEvidenceVerifierPort {
  /** Fail-closed trust/key/adapter preflight that must complete before bind. */
  assertAvailable(): Promise<void>;
}

interface RemoteWorkerAdmissionCompositionDependencies {
  readonly config: EnabledRemoteWorkerRuntimeConfig;
  readonly admissionStore: RemoteWorkerAdmissionStorePort &
    RemoteWorkerProtectedAdmissionAuthorityStorePort &
    RemoteWorkerCurrentRuntimeCredentialStorePort;
  readonly meshNodeAdmissionStore?: RemoteWorkerMeshNodeAdmissionStorePort;
  readonly assignmentProtocol?: {
    assertAvailable(): Awaitable<void>;
    execute(input: RemoteWorkerAssignmentProtocolRequest): Promise<RemoteWorkerAssignmentProtocolResponse>;
  };
  readonly createEvidenceVerifier?: (config: EnabledRemoteWorkerRuntimeConfig) => RemoteWorkerAdmissionEvidenceVerifier;
}

/**
 * Production native-listener composition. The entire listener stays dark until
 * bootstrap, M2 current authority, atomic M3 mesh admission, and the existing
 * assignment protocol are all present and preflighted. There is no partial
 * listener and therefore no ungoverned legacy downgrade path.
 */
export async function createGatewayRemoteWorkerAdmissionNativeRequestHandler(
  dependencies: RemoteWorkerAdmissionCompositionDependencies,
): Promise<RemoteWorkerNativeRequestHandler | undefined> {
  if (
    dependencies.createEvidenceVerifier === undefined ||
    dependencies.meshNodeAdmissionStore === undefined ||
    dependencies.assignmentProtocol === undefined
  ) {
    return undefined;
  }
  const evidenceVerifier = dependencies.createEvidenceVerifier(dependencies.config);
  await evidenceVerifier.assertAvailable();
  const protectedAuthority = new RemoteWorkerProtectedAdmissionAuthorityService(dependencies.admissionStore);
  await protectedAuthority.assertAvailable();
  const currentAuthority = new RemoteWorkerCurrentAuthorityService(dependencies.admissionStore, protectedAuthority);
  const meshNodeAdmission = new RemoteWorkerMeshNodeAdmissionService({
    currentAuthority,
    admissions: dependencies.meshNodeAdmissionStore,
    clock: () => new Date(),
  });
  await meshNodeAdmission.assertAvailable();
  await dependencies.assignmentProtocol.assertAvailable();
  const admissionService = new RemoteWorkerAdmissionService({
    admissionStore: dependencies.admissionStore,
    evidenceVerifier,
    readRuntimeConfig: () => dependencies.config,
  });
  return createRemoteWorkerNativeHandlerMux({
    bootstrap: createRemoteWorkerAdmissionNativeRequestHandler({ admissionService }),
    meshNodeAdmission: createRemoteWorkerMeshNodeAdmissionNativeRequestHandler({ admissionService: meshNodeAdmission }),
    assignment: createRemoteWorkerAssignmentNativeRequestHandler({
      assignmentProtocol: dependencies.assignmentProtocol,
    }),
  });
}
