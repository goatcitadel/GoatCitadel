import {
  RemoteWorkerAdmissionService,
  type RemoteWorkerAdmissionEvidenceVerifierPort,
  type RemoteWorkerAdmissionStorePort,
} from "./remote-worker-admission-service.js";
import { createRemoteWorkerAdmissionNativeRequestHandler } from "./remote-worker-admission-handler.js";
import type { RemoteWorkerNativeRequestHandler } from "./remote-worker-native-tls-listener.js";
import type { EnabledRemoteWorkerRuntimeConfig } from "./remote-worker-runtime-config.js";

export interface RemoteWorkerAdmissionEvidenceVerifier extends RemoteWorkerAdmissionEvidenceVerifierPort {
  /** Fail-closed trust/key/adapter preflight that must complete before bind. */
  assertAvailable(): Promise<void>;
}

interface RemoteWorkerAdmissionCompositionDependencies {
  readonly config: EnabledRemoteWorkerRuntimeConfig;
  readonly admissionStore: RemoteWorkerAdmissionStorePort;
  readonly createEvidenceVerifier?: (config: EnabledRemoteWorkerRuntimeConfig) => RemoteWorkerAdmissionEvidenceVerifier;
}

/**
 * Production admission composition. No trustworthy pinned remote-evidence
 * adapter exists yet, so the Gateway passes no factory and remains dark. A
 * local copy of worker bytes is deliberately insufficient. Once the protected
 * provisioner can issue signed download/install evidence, its exact verifier
 * must preflight successfully before this function may return a live handler.
 */
export async function createGatewayRemoteWorkerAdmissionNativeRequestHandler(
  dependencies: RemoteWorkerAdmissionCompositionDependencies,
): Promise<RemoteWorkerNativeRequestHandler | undefined> {
  if (dependencies.createEvidenceVerifier === undefined) return undefined;
  const evidenceVerifier = dependencies.createEvidenceVerifier(dependencies.config);
  await evidenceVerifier.assertAvailable();
  const admissionService = new RemoteWorkerAdmissionService({
    admissionStore: dependencies.admissionStore,
    evidenceVerifier,
    readRuntimeConfig: () => dependencies.config,
  });
  return createRemoteWorkerAdmissionNativeRequestHandler({ admissionService });
}
