import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION, REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION, REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_SCHEMA_VERSION,
  canonicalJsonString, remoteWorkerProtectedAdmissionContextSha256, remoteWorkerProtectedAdmissionRemoteCallerBindingSha256,
  type CreateRemoteWorkerBootstrapCommand, type FinalizeRemoteWorkerBootstrapAdmissionCommand,
  type RemoteWorkerBootstrapRecord, type RemoteWorkerRuntimeCredentialRecord, type RemoteWorkerProtectedAdmissionSignerPin } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { TaskRepository } from "./task-repo.js";
import { RemoteWorkerAdmissionRepository, type FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput } from "./remote-worker-admission-repo.js";
import { RemoteWorkerAssignmentRepository, type RemoteWorkerAssignmentProtectedCommitFence } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerMeshNodeAdmissionRepository } from "./remote-worker-mesh-node-admission-repo.js";
import { MeshCapabilityNodeAdmissionRepository } from "./mesh-capability-node-admission-repo.js";
import type { RemoteWorkerNonceConsumeInput } from "./remote-worker-nonce-repo.js";
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const DBytes = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

/** Controlled protected-admission evidence for isolated DB tests; no OS custody or network admission. */
export function runtimeManifest(seed: string) {
  const payload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: D(`${seed}:bundle`),
    dependencyLockSha256: D(`${seed}:lock`),
    vendorTreeSha256: D(`${seed}:vendor`),
    launcherSha256: D(`${seed}:launcher`),
    installedTreeManifestSha256: D(`${seed}:tree`),
    installedTreeFileCount: 12,
    platform: "windows",
    architecture: "x64",
  } as const;
  return {
    payload,
    payloadSha256: D(canonicalJsonString(payload)),
    signatureAlgorithm: "ed25519" as const,
    signerKeyId: `key-${seed}`,
    signatureBase64Url: "A".repeat(86),
  };
}

export function bootstrapInput(seed: string): CreateRemoteWorkerBootstrapCommand {
  return {
    registryWorkspaceId: "default",
    workerLabel: `Worker ${seed}`,
    platform: "windows",
    architecture: "x64",
    runtimeManifest: runtimeManifest(seed),
    allowedWorkspaceIds: ["default"],
    capabilityClasses: ["durable_compute", "gateway_inference"],
    expiresInSeconds: 300,
    createdByActorId: "operator-a",
    idempotencyKey: `${seed}:bootstrap`,
    bootstrapSecretSha256: D(`${seed}:bootstrap-secret`),
  };
}


export function postgresNonceClock(db: DatabaseClient): { timestamp: string; expiresAt: string } {
  const timestamp = new DurableRunRepository(db).readDatabaseNow();
  return { timestamp, expiresAt: new Date(Date.parse(timestamp) + 60_000).toISOString() };
}

export function protectedBootstrapNonce(
  db: DatabaseClient,
  bootstrap: RemoteWorkerBootstrapRecord,
  seed: string,
): RemoteWorkerNonceConsumeInput {
  const clock = postgresNonceClock(db);
  return {
    authority: {
      kind: "bootstrap",
      registryWorkspaceId: bootstrap.registryWorkspaceId,
      bootstrapId: bootstrap.bootstrapId,
      workerId: bootstrap.workerId,
      targetWorkerGeneration: bootstrap.targetWorkerGeneration,
    },
    nonceSha256: D(`${seed}:nonce`),
    timestamp: clock.timestamp,
    expiresAt: clock.expiresAt,
  };
}

export function protectedCredentialNonce(
  db: DatabaseClient,
  credential: RemoteWorkerRuntimeCredentialRecord,
  seed: string,
): RemoteWorkerNonceConsumeInput {
  const clock = postgresNonceClock(db);
  return {
    authority: {
      kind: "credential",
      registryWorkspaceId: credential.registryWorkspaceId,
      workerId: credential.workerId,
      workerGeneration: credential.workerGeneration,
      credentialGeneration: credential.credentialGeneration,
      credentialId: credential.credentialId,
    },
    nonceSha256: D(`${seed}:nonce`),
    timestamp: clock.timestamp,
    expiresAt: clock.expiresAt,
  };
}

export function protectedSignerPin(): RemoteWorkerProtectedAdmissionSignerPin {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 0x22)]);
  return {
    schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
    signatureAlgorithm: "ed25519",
    keysetGeneration: 1,
    keysetReceiptSha256: D("keyset:1"),
    signerSpkiSha256: DBytes(spki),
    signerSpkiBase64Url: spki.toString("base64url"),
  };
}

export function protectedWorkerSpki(seed: string): Buffer {
  return Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(D(`${seed}:key`), "hex")]);
}

export function protectedBootstrapInput(seed: string): CreateRemoteWorkerBootstrapCommand {
  return {
    ...bootstrapInput(seed),
    protectedAdmissionSignerPin: protectedSignerPin(),
  };
}

export function protectedFinalizeInput(
  db: DatabaseClient,
  bootstrap: RemoteWorkerBootstrapRecord,
  bootstrapSeed: string,
  connectionSeed: string,
): FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput {
  const nonce = protectedBootstrapNonce(db, bootstrap, `${bootstrapSeed}:${connectionSeed}`);
  const admittedWorkerSpki = protectedWorkerSpki(bootstrapSeed);
  const base = {
    expectedRegistryWorkspaceId: bootstrap.registryWorkspaceId,
    expectedBootstrapId: bootstrap.bootstrapId,
    expectedTargetWorkerGeneration: bootstrap.targetWorkerGeneration,
    bootstrapSecretSha256: D(`${bootstrapSeed}:bootstrap-secret`),
    verifiedPublicKeySpkiSha256: DBytes(admittedWorkerSpki),
    verifiedClientCertificateSha256: D(`${bootstrapSeed}:certificate`),
    verifiedRuntimeManifestSha256: D(canonicalJsonString(bootstrap.runtimeManifest)),
    verifiedWorkspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
    verifiedCapabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
    verifiedTransportIdentitySource: "native_mtls" as const,
    verifiedTransportTrustAnchorSha256: D(`${bootstrapSeed}:anchor`),
    verifiedTransportReceiptSha256: D(`${connectionSeed}:transport`),
    verifiedProofOfPossessionReceiptSha256: D(`${connectionSeed}:pop`),
    verifiedDownloadReceiptSha256: D(`${bootstrapSeed}:download`),
    verifiedInstalledTreeAttestationSha256: D(`${bootstrapSeed}:attestation`),
    verifiedInstalledTreeReceiptSha256: D(`${bootstrapSeed}:tree-receipt`),
    credentialIssuanceProofSha256: D(`${connectionSeed}:issuance`),
    credentialExpiresInSeconds: 600,
    credentialTokenSha256: D(`${connectionSeed}:credential`),
    exchangeIdempotencyKey: `${bootstrapSeed}:exchange`,
  };
  const tlsExporterSha256 = D(`${connectionSeed}:tls-exporter`);
  const contextSha256 = remoteWorkerProtectedAdmissionContextSha256({
    registryWorkspaceId: bootstrap.registryWorkspaceId,
    bootstrapId: bootstrap.bootstrapId,
    workerId: bootstrap.workerId,
    nodeId: bootstrap.nodeId,
    targetWorkerGeneration: bootstrap.targetWorkerGeneration,
    platform: bootstrap.platform,
    architecture: bootstrap.architecture,
    runtimeManifestSha256: base.verifiedRuntimeManifestSha256,
    runtimeManifestPayloadSha256: bootstrap.runtimeManifest.payloadSha256,
    workspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
    capabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
    workerPublicKeySpkiSha256: base.verifiedPublicKeySpkiSha256,
    clientCertificateSha256: base.verifiedClientCertificateSha256,
    transportTrustAnchorSha256: base.verifiedTransportTrustAnchorSha256,
    tlsExporterSha256,
    evidenceNonceSha256: nonce.nonceSha256,
    downloadVerificationReceiptSha256: base.verifiedDownloadReceiptSha256,
    installedTreeAttestationSha256: base.verifiedInstalledTreeAttestationSha256,
    installedTreeVerificationReceiptSha256: base.verifiedInstalledTreeReceiptSha256,
  });
  const operationId = Buffer.from(D(`${connectionSeed}:operation`), "hex").subarray(0, 16);
  const envelope = Buffer.alloc(288);
  envelope.write("GCAE", 0, "ascii");
  envelope.writeUInt16LE(1, 4);
  envelope.writeUInt8(1, 6);
  envelope.writeUInt32LE(288, 8);
  operationId.copy(envelope, 16);
  Buffer.from(nonce.nonceSha256, "hex").copy(envelope, 32);
  envelope.writeBigUInt64LE(BigInt(bootstrap.targetWorkerGeneration), 64);
  Buffer.from(contextSha256, "hex").copy(envelope, 96);
  Buffer.from(base.verifiedRuntimeManifestSha256, "hex").copy(envelope, 128);
  Buffer.from(base.verifiedPublicKeySpkiSha256, "hex").copy(envelope, 160);
  Buffer.from(base.verifiedDownloadReceiptSha256, "hex").copy(envelope, 192);
  Buffer.from(base.verifiedInstalledTreeAttestationSha256, "hex").copy(envelope, 224);
  Buffer.from(base.verifiedInstalledTreeReceiptSha256, "hex").copy(envelope, 256);
  const caller = {
    workerPublicKeySpkiSha256: base.verifiedPublicKeySpkiSha256,
    clientCertificateSha256: base.verifiedClientCertificateSha256,
    transportTrustAnchorSha256: base.verifiedTransportTrustAnchorSha256,
    tlsExporterSha256,
  };
  const pin = bootstrap.protectedAdmissionSignerPin;
  if (!pin) throw new Error("protected signer pin missing");
  const command: FinalizeRemoteWorkerBootstrapAdmissionCommand = {
    ...base,
    verifiedProtectedAdmissionEvidence: {
      schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_SCHEMA_VERSION,
      operationIdBase64Url: operationId.toString("base64url"),
      evidenceNonceSha256: nonce.nonceSha256,
      workerGeneration: bootstrap.targetWorkerGeneration,
      envelopeSha256: DBytes(envelope),
      envelopeBase64Url: envelope.toString("base64url"),
      keysetReceiptSha256: pin.keysetReceiptSha256,
      signerSpkiSha256: pin.signerSpkiSha256,
      signerSpkiBase64Url: pin.signerSpkiBase64Url,
      signatureBase64Url: Buffer.alloc(64, 0x33).toString("base64url"),
      contextSha256,
      runtimeManifestSha256: base.verifiedRuntimeManifestSha256,
      runtimeManifestPayloadSha256: bootstrap.runtimeManifest.payloadSha256,
      workspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
      capabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
      ...caller,
      workerPublicKeySpkiBase64Url: admittedWorkerSpki.toString("base64url"),
      authenticatedRemoteCallerBindingSha256: remoteWorkerProtectedAdmissionRemoteCallerBindingSha256(caller),
      downloadVerificationReceiptSha256: base.verifiedDownloadReceiptSha256,
      installedTreeAttestationSha256: base.verifiedInstalledTreeAttestationSha256,
      installedTreeVerificationReceiptSha256: base.verifiedInstalledTreeReceiptSha256,
    },
  };
  return { nonce, command };
}

export function seedProtectedFenceHarness(setupDb: DatabaseClient, suffix: string, tools = false) {
  const tasks = new TaskRepository(setupDb);
  const durableRuns = new DurableRunRepository(setupDb);
  const workerAdmissions = new RemoteWorkerAdmissionRepository(setupDb);
  const meshNodeAdmissions = new RemoteWorkerMeshNodeAdmissionRepository(setupDb);
  const capabilityAdmissions = new MeshCapabilityNodeAdmissionRepository(setupDb);
  const assignments = new RemoteWorkerAssignmentRepository(setupDb);
  const bootstrap = workerAdmissions.createBootstrap({ ...protectedBootstrapInput(suffix),
    ...(tools ? { capabilityClasses: ["artifact_stage", "durable_compute", "gateway_inference", "governed_tool"] as const } : {}),
  }).record;
  const finalizeInput = protectedFinalizeInput(setupDb, bootstrap, suffix, tools ? `${suffix}:tool-first` : "first");
  const finalized = workerAdmissions.finalizeBootstrapAdmissionWithNonce(finalizeInput);
  const evidence = finalizeInput.command.verifiedProtectedAdmissionEvidence;
  assert.ok(evidence);
  const joinAuthorityInput = {
    registryWorkspaceId: finalized.generation.registryWorkspaceId,
    bootstrapId: finalized.generation.bootstrapId,
    workerId: finalized.generation.workerId,
    workerGeneration: finalized.generation.workerGeneration,
    nodeId: finalized.generation.nodeId,
    clientCertificateSha256: finalized.generation.clientCertificateSha256,
    protectedAdmissionEnvelopeSha256: evidence.envelopeSha256,
    protectedAdmissionContextSha256: evidence.contextSha256,
    workspaceId: "default",
    // Must expire BEFORE the backing 600s runtime credential: the M2 fence
    // selector requires the credential to outlive the issued join authority.
    expiresInSeconds: 300,
    issuedByActorId: "operator-a",
  } as const;
  const rawMeshNodeCredential = tools ? Buffer.from(D(`${suffix}:mesh-credential`), "hex").toString("base64url") : "a".repeat(43);
  const issued = meshNodeAdmissions.issueJoinAuthority({
    ...joinAuthorityInput,
    idempotencyKey: `${suffix}:mesh-authority:1`,
    rawMeshNodeCredential,
  });
  assert.equal(issued.disposition, "created");
  const admissionCommand = {
    workspaceId: "default",
    clientCertificateSha256: finalized.generation.clientCertificateSha256,
    method: "POST" as const,
    rawPath: "/api/v1/remote-workers/mesh-node-admissions",
    operation: "mesh.node.admit",
  } as const;
  const admitted = meshNodeAdmissions.admitWithNonce({
    nonce: protectedCredentialNonce(setupDb, finalized.credential, `${suffix}:admit:1`),
    command: {
      ...admissionCommand,
      rawMeshNodeCredential,
      protocolBodySha256: D(`${suffix}:admission-body:1`),
      transportReceiptSha256: D(`${suffix}:admission-transport:1`),
      proofOfPossessionReceiptSha256: D(`${suffix}:admission-pop:1`),
      tlsExporterSha256: D(`${suffix}:admission-exporter:1`),
      idempotencyKey: `${suffix}:mesh-admission:1`,
    },
  });
  assert.equal(admitted.disposition, "admitted");
  const credentialResolutionInput = {
    registryWorkspaceId: finalized.generation.registryWorkspaceId,
    bootstrapId: finalized.generation.bootstrapId,
    workerId: finalized.generation.workerId,
    workerGeneration: finalized.generation.workerGeneration,
    nodeId: finalized.generation.nodeId,
    clientCertificateSha256: finalized.generation.clientCertificateSha256,
    protectedAdmissionEnvelopeSha256: evidence.envelopeSha256,
    protectedAdmissionContextSha256: evidence.contextSha256,
    workspaceId: "default",
  } as const;
  const meshFence = meshNodeAdmissions.resolveCurrentForRuntimeCredential({
    ...credentialResolutionInput,
    credentialId: finalized.credential.credentialId,
    credentialGeneration: finalized.credential.credentialGeneration,
    authorizationCredentialSha256: finalizeInput.command.credentialTokenSha256,
  });
  assert.ok(meshFence);
  const claimAuthority = {
    registryWorkspaceId: finalized.generation.registryWorkspaceId,
    bootstrapId: finalized.generation.bootstrapId,
    workerId: finalized.generation.workerId,
    workerGeneration: finalized.generation.workerGeneration,
    credentialId: finalized.credential.credentialId,
    credentialGeneration: finalized.credential.credentialGeneration,
    authorizationCredentialSha256: finalizeInput.command.credentialTokenSha256,
    nodeId: finalized.generation.nodeId,
    clientCertificateSha256: finalized.generation.clientCertificateSha256,
    runtimeManifestSha256: finalized.generation.runtimeManifestSha256,
    workspaceCeilingSha256: finalized.generation.workspaceCeilingSha256,
    capabilityCeilingSha256: finalized.generation.capabilityCeilingSha256,
    protectedAdmissionEnvelopeSha256: evidence.envelopeSha256,
    protectedAdmissionContextSha256: evidence.contextSha256,
    claimsSha256: finalized.credential.claimsSha256,
  } as const;
  const fence: RemoteWorkerAssignmentProtectedCommitFence = {
    credentialAuthority: claimAuthority,
    meshAdmission: meshFence,
  };
  return {
    tasks,
    durableRuns,
    workerAdmissions,
    meshNodeAdmissions,
    capabilityAdmissions,
    assignments,
    bootstrap,
    finalizeInput,
    finalized,
    evidence,
    joinAuthorityInput,
    admissionCommand,
    credentialResolutionInput,
    issued,
    admitted,
    meshFence,
    claimAuthority,
    fence,
  };
}

