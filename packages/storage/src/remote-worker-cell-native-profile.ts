import {
  REMOTE_WORKER_CELL_PROFILE_V2_SCHEMA_VERSION, REMOTE_WORKER_CELL_PROVISIONING_JOURNAL_RESERVED_BYTES,
  normalizeRemoteWorkerCellCapacityReservation, normalizeRemoteWorkerCellProfile, remoteWorkerCellCanonicalSha256,
  type RemoteWorkerBootstrapRecord, type RemoteWorkerCellCapacityReservation,
  type RemoteWorkerGenerationRecord, type ResolvedRemoteWorkerAssignmentAuthority,
} from "@goatcitadel/contracts";

/** Closed native launch environment. Values are supplied separately and never
 * included in the persisted profile; no ambient worker environment is inherited. */
export const REMOTE_WORKER_NATIVE_ENVIRONMENT_NAMES = Object.freeze(["SystemRoot", "TEMP", "TMP"] as const);
export const REMOTE_WORKER_NATIVE_ENVIRONMENT_SHA256 = remoteWorkerCellCanonicalSha256({
  schemaVersion: "goatcitadel.native-cell-environment.v1", names: REMOTE_WORKER_NATIVE_ENVIRONMENT_NAMES,
});

/** Supplied by Gateway composition, never decoded from a worker request. */
export interface RemoteWorkerNativeCellPolicy {
  readonly capacity: RemoteWorkerCellCapacityReservation;
  readonly provisioningWallMs: number;
}
export function snapshotRemoteWorkerNativeCellPolicy(input: RemoteWorkerNativeCellPolicy): RemoteWorkerNativeCellPolicy {
  const capacity = normalizeRemoteWorkerCellCapacityReservation(input.capacity);
  if (!Number.isSafeInteger(input.provisioningWallMs) || input.provisioningWallMs < 1000 || input.provisioningWallMs > 600000 ||
      capacity.logicalDiskBytes < 16 * 1024 * 1024 || capacity.logicalDiskBytes % (2 * 1024 * 1024) !== 0 ||
      capacity.allocatedDiskBytes < capacity.logicalDiskBytes + 64 * 1024 * 1024 + REMOTE_WORKER_CELL_PROVISIONING_JOURNAL_RESERVED_BYTES) {
    throw new Error("Gateway native cell resource policy is invalid.");
  }
  return Object.freeze({ capacity, provisioningWallMs: input.provisioningWallMs });
}

/** Called only inside the assignment owner's transaction with canonical rows.
 * Installed-tree evidence is the generation's signed admission binding; a
 * runtime manifest digest alone must never stand in for that attestation. */
export function buildRemoteWorkerNativeCellProfile(
  authority: ResolvedRemoteWorkerAssignmentAuthority,
  worker: RemoteWorkerGenerationRecord,
  bootstrap: RemoteWorkerBootstrapRecord,
  parentIdentityHex: string,
  policy: RemoteWorkerNativeCellPolicy,
) {
  const { assignment, generation } = authority;
  const manifest = assignment.manifest;
  if (bootstrap.platform !== "windows" || bootstrap.architecture !== "x64" ||
      bootstrap.runtimeManifest.payload.platform !== "windows" || bootstrap.runtimeManifest.payload.architecture !== "x64" ||
      bootstrap.state !== "consumed" || worker.transportIdentitySource !== "native_mtls" ||
      worker.registryWorkspaceId !== assignment.registryWorkspaceId || worker.workerId !== generation.workerId ||
      worker.workerGeneration !== generation.workerGeneration || worker.runtimeManifestSha256 !== generation.runtimeManifestSha256 ||
      bootstrap.bootstrapId !== worker.bootstrapId || bootstrap.workerId !== worker.workerId ||
      bootstrap.registryWorkspaceId !== worker.registryWorkspaceId || bootstrap.targetWorkerGeneration !== worker.workerGeneration ||
      remoteWorkerCellCanonicalSha256(bootstrap.runtimeManifest) !== worker.runtimeManifestSha256) {
    throw new Error("Native cell preparation requires the current admitted Windows x64 runtime.");
  }
  const limits = snapshotRemoteWorkerNativeCellPolicy(policy).capacity;
  const key = { registryWorkspaceId: assignment.registryWorkspaceId, assignmentId: assignment.assignmentId,
    assignmentGeneration: generation.assignmentGeneration, workerId: generation.workerId, workerGeneration: generation.workerGeneration };
  const identity = remoteWorkerCellCanonicalSha256({ schemaVersion: "goatcitadel.native-cell-identity.v1", ...key });
  const cellName = `gc-cell-${identity.slice(0, 32)}`;
  const profile = normalizeRemoteWorkerCellProfile({ schemaVersion: REMOTE_WORKER_CELL_PROFILE_V2_SCHEMA_VERSION,
    ...key, cellId: cellName, backend: "windows_native",
    logicalRootSha256: remoteWorkerCellCanonicalSha256({ schemaVersion: "goatcitadel.native-cell-root.v1",
      executionWorkspaceId: manifest.executionWorkspaceId, parentIdentityHex, cellName }),
    assignmentManifestSha256: assignment.manifestSha256, pathJailSha256: manifest.pathJailSha256,
    capabilityProfileSha256: manifest.capabilityProfileSha256, contextSnapshotSha256: manifest.contextSnapshotSha256,
    toolEffectPostureSha256: manifest.toolEffectPostureSha256, runtimeAttestationSha256: worker.installedTreeAttestationSha256,
    launcherAttestationSha256: remoteWorkerCellCanonicalSha256({ schemaVersion: "goatcitadel.native-cell-launcher-attestation.v1",
      runtimeManifestSha256: worker.runtimeManifestSha256, installedTreeAttestationSha256: worker.installedTreeAttestationSha256,
      installedTreeVerificationReceiptSha256: worker.installedTreeVerificationReceiptSha256,
      launcherSha256: bootstrap.runtimeManifest.payload.launcherSha256 }),
    capacity: { ...limits, rawOutputLimitBytes: Math.min(limits.rawOutputLimitBytes, manifest.maxOutputBytes),
      artifactCeilingBytes: Math.min(limits.artifactCeilingBytes, manifest.maxArtifactBytes) },
    egressPosture: "deny_all", egressDnsRevision: 1,
    egressPolicySha256: remoteWorkerCellCanonicalSha256({ schemaVersion: "goatcitadel.native-cell-egress.v1", posture: "deny_all" }),
    envAllowlistSha256: REMOTE_WORKER_NATIVE_ENVIRONMENT_SHA256,
  });
  return Object.freeze({ profile, cellName,
    diskIdentifierHex: remoteWorkerCellCanonicalSha256({ schemaVersion: "goatcitadel.native-cell-disk.v1", ...key }).slice(0, 32),
    reservedDiskBytes: limits.logicalDiskBytes + 64 * 1024 * 1024 });
}
