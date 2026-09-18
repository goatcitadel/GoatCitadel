import type { RemoteWorkerArtifactManifest, RemoteWorkerArtifactPartDescriptor, ResolvedRemoteWorkerAssignmentAuthority } from "@goatcitadel/contracts";
import type { RemoteWorkerArtifactUploadRecord, RemoteWorkerAssignmentProtectedCommitFence } from "@goatcitadel/storage";
import type { AppendPartInput, CommitArtifactInput, OpenUploadInput } from "./remote-worker-artifact-settlement-service.js";
import type { CurrentRemoteWorkerRuntimeCredentialAuthority } from "./remote-worker-current-authority-service.js";
import { rejected } from "./remote-worker-assignment-execution-validators.js";
export interface ArtifactSettlementPort {
    openUpload(input: OpenUploadInput): RemoteWorkerArtifactUploadRecord | Promise<RemoteWorkerArtifactUploadRecord>;
    appendPart(input: AppendPartInput): RemoteWorkerArtifactUploadRecord | Promise<RemoteWorkerArtifactUploadRecord>;
    commitArtifact(input: CommitArtifactInput): RemoteWorkerArtifactUploadRecord | Promise<RemoteWorkerArtifactUploadRecord>;
}
export interface ArtifactSubmissionDependencies {
  readonly artifacts: ArtifactSettlementPort;
}
export type ArtifactSubmission =
  | Readonly<{
      kind: "artifact.open";
      uploadAttempt: number;
      declaredFileCount: number;
      declaredTotalBytes: number;
      stagingRootSha256: string;
      expiresAt: string;
    }>
  | Readonly<{ kind: "artifact.part"; uploadId: string; part: RemoteWorkerArtifactPartDescriptor }>
  | Readonly<{
      kind: "artifact.commit";
      uploadId: string;
      manifest: RemoteWorkerArtifactManifest;
      files: readonly Readonly<{
        logicalPath: string;
        logicalPathSha256: string;
        bytesBase64: string;
        mimeType: string;
      }>[];
    }>;
export function isArtifactSubmission(value: { kind: string }): value is ArtifactSubmission {
  return ["artifact.open", "artifact.part", "artifact.commit"].includes(value.kind);
}
/** The artifact owner checks assignment identity before any CAS write. */
export async function dispatchArtifactSubmission(owners: ArtifactSubmissionDependencies, input: {
  readonly identity: { registryWorkspaceId: string; assignmentId: string; assignmentGeneration: number;
    leaseTokenSha256: string; protectedAuthority: RemoteWorkerAssignmentProtectedCommitFence };
  readonly submission: ArtifactSubmission;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
  readonly fenced: { authority: CurrentRemoteWorkerRuntimeCredentialAuthority; records: ResolvedRemoteWorkerAssignmentAuthority };
}) {
  const { identity, submission, idempotencyKey, signal, fenced } = input;
  signal.throwIfAborted();
  if (submission.kind === "artifact.open") {
    const upload = await owners.artifacts.openUpload({
      ...identity,
      uploadAttempt: submission.uploadAttempt,
      declaredFileCount: submission.declaredFileCount,
      declaredTotalBytes: submission.declaredTotalBytes,
      stagingRootSha256: submission.stagingRootSha256,
      expiresAt: submission.expiresAt,
      idempotencyKey,
    });
    return ({ disposition: "artifact_recorded", upload } as const);
  }
  if (submission.kind === "artifact.part") {
    const upload = await owners.artifacts.appendPart({
      ...identity,
      uploadId: submission.uploadId,
      part: submission.part,
      idempotencyKey,
    });
    return ({ disposition: "artifact_recorded", upload } as const);
  }
  if (submission.kind === "artifact.commit") {
    // The manifest carries a full settlement identity, and the CAS writer
    // shards blobs by its executionWorkspaceId BEFORE storage compares the
    // manifest identity. Bind every field to the fenced records here so a
    // worker holding one assignment's lease cannot stage bytes under another
    // workspace, worker, or generation.
    assertManifestIdentityBinding(submission.manifest, fenced);
    const upload = await owners.artifacts.commitArtifact({
      ...identity,
      uploadId: submission.uploadId,
      manifest: submission.manifest,
      files: submission.files.map((file) =>
        Object.freeze({
          logicalPath: file.logicalPath,
          logicalPathSha256: file.logicalPathSha256,
          bytes: Buffer.from(file.bytesBase64, "base64"),
          mimeType: file.mimeType,
        }),
      ),
      idempotencyKey,
      // Bounded strictly below the native listener's per-request deadline so
      // a CAS commit cannot keep installing blobs after the socket is gone
      // and the durable nonce is already spent.
      signal: signal,
    });
    return ({ disposition: "artifact_recorded", upload } as const);
  }
  throw rejected("Unsupported artifact submission.");
}
/**
 * Bind the worker-declared artifact manifest identity to the fenced records.
 * `normalizeRemoteWorkerArtifactManifest` only proves shape; storage compares
 * the identity only after the CAS writer has already sharded blobs by the
 * manifest's own `executionWorkspaceId`, so the comparison must happen here,
 * before any blob is installed.
 */
function assertManifestIdentityBinding(
  manifest: RemoteWorkerArtifactManifest,
  fenced: {
    readonly authority: CurrentRemoteWorkerRuntimeCredentialAuthority;
    readonly records: ResolvedRemoteWorkerAssignmentAuthority;
  },
): void {
  const identity = manifest.identity;
  const { assignment, generation } = fenced.records;
  if (
    identity.registryWorkspaceId !== assignment.registryWorkspaceId ||
    identity.executionWorkspaceId !== assignment.manifest.executionWorkspaceId ||
    identity.assignmentId !== assignment.assignmentId ||
    identity.assignmentGeneration !== generation.assignmentGeneration ||
    identity.workerId !== fenced.authority.workerId ||
    identity.workerGeneration !== fenced.authority.workerGeneration ||
    identity.runtimeManifestSha256 !== fenced.authority.runtimeManifestSha256 ||
    identity.workspaceCeilingSha256 !== fenced.authority.workspaceCeilingSha256 ||
    identity.capabilityCeilingSha256 !== fenced.authority.capabilityCeilingSha256 ||
    identity.assignmentManifestSha256 !== assignment.manifestSha256
  ) {
    throw rejected("Remote worker assignment artifact manifest does not bind the fenced assignment authority.");
  }
}
