import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  remoteWorkerAuthenticatedOperatorActorSha256,
  remoteWorkerProtectedAdmissionContextSha256,
  remoteWorkerProtectedAdmissionRemoteCallerBindingSha256,
  type RemoteWorkerBootstrapRecord,
  type RemoteWorkerGenerationRecord,
  type RemoteWorkerProtectedAdmissionEvidenceRecord,
} from "@goatcitadel/contracts";
import type { RemoteWorkerAdmissionRepository } from "@goatcitadel/storage";
import { RemoteWorkerProtectedAdmissionEvidenceVerifier } from "./remote-worker-protected-admission-evidence-verifier.js";

export interface CurrentRemoteWorkerProtectedAdmissionAuthority {
  readonly generation: RemoteWorkerGenerationRecord;
  readonly evidence: RemoteWorkerProtectedAdmissionEvidenceRecord;
  /** Canonical 44-byte Ed25519 SPKI DER for assignment proof-of-possession. */
  readonly workerPublicKeySpkiDer: Buffer;
}

/**
 * The production read owner for protected remote-worker admission authority.
 * A storage record by itself is audit material, never current cryptographic
 * authority. This service composes pin/signature verification with generation
 * currency and quarantine/revocation fencing on every read.
 */
export class RemoteWorkerProtectedAdmissionAuthorityService {
  public constructor(
    private readonly store: Pick<
      RemoteWorkerAdmissionRepository,
      "findCurrentGeneration" | "findLatestGenerationControl" | "findProtectedAdmissionEvidenceRecord" | "getBootstrap"
    >,
    private readonly verifier = new RemoteWorkerProtectedAdmissionEvidenceVerifier(),
  ) {}

  public async assertAvailable(): Promise<void> {
    await this.verifier.assertAvailable();
  }

  public resolveCurrent(input: {
    readonly registryWorkspaceId: string;
    readonly workerId: string;
    readonly workerGeneration: number;
  }): CurrentRemoteWorkerProtectedAdmissionAuthority {
    try {
      const current = this.store.findCurrentGeneration(input.registryWorkspaceId, input.workerId);
      if (
        current === undefined ||
        current.registryWorkspaceId !== input.registryWorkspaceId ||
        current.workerId !== input.workerId ||
        current.workerGeneration !== input.workerGeneration ||
        current.transportIdentitySource !== "native_mtls"
      ) {
        throw unavailable();
      }
      if (
        this.store.findLatestGenerationControl(input.registryWorkspaceId, input.workerId, input.workerGeneration) !==
        undefined
      ) {
        throw unavailable();
      }
      const evidence = this.store.findProtectedAdmissionEvidenceRecord(
        input.registryWorkspaceId,
        input.workerId,
        input.workerGeneration,
      );
      if (evidence === undefined || evidence.revokedAt !== undefined) throw unavailable();
      const bootstrap = this.store.getBootstrap(input.registryWorkspaceId, current.bootstrapId);
      if (bootstrap.protectedAdmissionSignerPin === undefined) throw unavailable();
      assertCurrentBindings(input, current, bootstrap, evidence);
      this.verifier.verifyPersisted(evidence, bootstrap.protectedAdmissionSignerPin);
      return Object.freeze({
        generation: current,
        evidence,
        workerPublicKeySpkiDer: Buffer.from(evidence.workerPublicKeySpkiBase64Url, "base64url"),
      });
    } catch {
      throw unavailable();
    }
  }
}

function assertCurrentBindings(
  input: {
    readonly registryWorkspaceId: string;
    readonly workerId: string;
    readonly workerGeneration: number;
  },
  current: RemoteWorkerGenerationRecord,
  bootstrap: RemoteWorkerBootstrapRecord,
  evidence: RemoteWorkerProtectedAdmissionEvidenceRecord,
): void {
  const runtimeManifestSha256 = sha256(canonicalJsonString(bootstrap.runtimeManifest));
  const expectedContextSha256 = remoteWorkerProtectedAdmissionContextSha256({
    registryWorkspaceId: input.registryWorkspaceId,
    bootstrapId: current.bootstrapId,
    workerId: input.workerId,
    nodeId: current.nodeId,
    targetWorkerGeneration: input.workerGeneration,
    platform: bootstrap.platform,
    architecture: bootstrap.architecture,
    runtimeManifestSha256,
    runtimeManifestPayloadSha256: bootstrap.runtimeManifest.payloadSha256,
    workspaceCeilingSha256: current.workspaceCeilingSha256,
    capabilityCeilingSha256: current.capabilityCeilingSha256,
    workerPublicKeySpkiSha256: current.publicKeySpkiSha256,
    clientCertificateSha256: current.clientCertificateSha256,
    transportTrustAnchorSha256: current.transportTrustAnchorSha256,
    tlsExporterSha256: evidence.tlsExporterSha256,
    evidenceNonceSha256: evidence.evidenceNonceSha256,
    downloadVerificationReceiptSha256: current.downloadVerificationReceiptSha256,
    installedTreeAttestationSha256: current.installedTreeAttestationSha256,
    installedTreeVerificationReceiptSha256: current.installedTreeVerificationReceiptSha256,
  });
  const expectedRemoteCallerBindingSha256 = remoteWorkerProtectedAdmissionRemoteCallerBindingSha256({
    workerPublicKeySpkiSha256: current.publicKeySpkiSha256,
    clientCertificateSha256: current.clientCertificateSha256,
    transportTrustAnchorSha256: current.transportTrustAnchorSha256,
    tlsExporterSha256: evidence.tlsExporterSha256,
  });
  if (
    bootstrap.registryWorkspaceId !== input.registryWorkspaceId ||
    bootstrap.bootstrapId !== current.bootstrapId ||
    bootstrap.bootstrapId !== evidence.bootstrapId ||
    bootstrap.workerId !== input.workerId ||
    bootstrap.workerId !== evidence.workerId ||
    bootstrap.nodeId !== current.nodeId ||
    bootstrap.targetWorkerGeneration !== input.workerGeneration ||
    bootstrap.state !== "consumed" ||
    bootstrap.runtimeManifest.payload.platform !== bootstrap.platform ||
    bootstrap.runtimeManifest.payload.architecture !== bootstrap.architecture ||
    evidence.registryWorkspaceId !== input.registryWorkspaceId ||
    evidence.workerGeneration !== input.workerGeneration ||
    evidence.runtimeManifestSha256 !== runtimeManifestSha256 ||
    current.runtimeManifestSha256 !== runtimeManifestSha256 ||
    evidence.runtimeManifestPayloadSha256 !== bootstrap.runtimeManifest.payloadSha256 ||
    evidence.workspaceCeilingSha256 !== bootstrap.workspaceCeilingSha256 ||
    current.workspaceCeilingSha256 !== bootstrap.workspaceCeilingSha256 ||
    evidence.capabilityCeilingSha256 !== bootstrap.capabilityCeilingSha256 ||
    current.capabilityCeilingSha256 !== bootstrap.capabilityCeilingSha256 ||
    evidence.workerPublicKeySpkiSha256 !== current.publicKeySpkiSha256 ||
    evidence.clientCertificateSha256 !== current.clientCertificateSha256 ||
    evidence.transportTrustAnchorSha256 !== current.transportTrustAnchorSha256 ||
    evidence.downloadVerificationReceiptSha256 !== current.downloadVerificationReceiptSha256 ||
    evidence.installedTreeAttestationSha256 !== current.installedTreeAttestationSha256 ||
    evidence.installedTreeVerificationReceiptSha256 !== current.installedTreeVerificationReceiptSha256 ||
    evidence.admittedAt !== current.admittedAt ||
    evidence.authenticatedOperatorActorId !== bootstrap.createdByActorId ||
    evidence.authenticatedOperatorActorSha256 !==
      remoteWorkerAuthenticatedOperatorActorSha256(bootstrap.createdByActorId) ||
    evidence.authenticatedRemoteCallerBindingSha256 !== expectedRemoteCallerBindingSha256 ||
    evidence.contextSha256 !== expectedContextSha256
  ) {
    throw unavailable();
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function unavailable(): Error {
  return new Error("Current protected remote worker admission authority is unavailable.");
}
