import {
  REMOTE_WORKER_SETTLEMENT_BOUNDS,
  remoteWorkerArtifactManifestSha256,
  type RemoteWorkerArtifactManifest,
  type RemoteWorkerArtifactPartDescriptor,
  type RemoteWorkerSettlementIdentity,
} from "@goatcitadel/contracts";
import type {
  RemoteWorkerArtifactRepository,
  RemoteWorkerArtifactUploadRecord,
  RemoteWorkerBlobInput,
} from "@goatcitadel/storage";
import type { RemoteWorkerArtifactStore } from "./remote-worker-artifact-store.js";
import type { Awaitable, AwaitableOwnerMethods } from "./remote-worker-owner-port.js";

/**
 * HX-506 artifact settlement service (production-dark).
 *
 * Orchestrates the immutable upload/part/manifest lifecycle over the HX-506
 * artifact repository and the CAS artifact store. It CONSUMES the live HX-502
 * assignment authority and HX-411 session generation through an injected fence
 * port; it never becomes the assignment, session, or capacity authority. Each
 * part operation rechecks authority before recording an immutable part receipt,
 * and commit installs CAS objects before the durable manifest transaction.
 */

export interface RemoteWorkerAssignmentAuthorityFence {
  /** True only when the exact assignment generation still holds live authority. */
  assertLiveAuthority(input: {
    registryWorkspaceId: string;
    assignmentId: string;
    assignmentGeneration: number;
    leaseTokenSha256: string;
  }): Awaitable<void>;
}

type RemoteWorkerArtifactSettlementRepositoryMethod = "openUpload" | "appendPart" | "commitArtifact";

export type RemoteWorkerArtifactSettlementRepositoryPort = AwaitableOwnerMethods<
  RemoteWorkerArtifactRepository,
  RemoteWorkerArtifactSettlementRepositoryMethod
>;

export interface RemoteWorkerArtifactSettlementDependencies {
  repository: RemoteWorkerArtifactSettlementRepositoryPort;
  store: RemoteWorkerArtifactStore;
  authority: RemoteWorkerAssignmentAuthorityFence;
}

export interface OpenUploadInput {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  leaseTokenSha256: string;
  uploadAttempt: number;
  declaredFileCount: number;
  declaredTotalBytes: number;
  stagingRootSha256: string;
  expiresAt: string;
  idempotencyKey: string;
}

export interface AppendPartInput {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  leaseTokenSha256: string;
  uploadId: string;
  part: RemoteWorkerArtifactPartDescriptor;
  idempotencyKey: string;
}

export interface CommitFileInput {
  logicalPath: string;
  logicalPathSha256: string;
  bytes: Uint8Array;
  mimeType: string;
}

export interface CommitArtifactInput {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  leaseTokenSha256: string;
  uploadId: string;
  manifest: RemoteWorkerArtifactManifest;
  files: readonly CommitFileInput[];
  idempotencyKey: string;
  signal: AbortSignal;
}

export class RemoteWorkerArtifactSettlementService {
  private readonly repository: RemoteWorkerArtifactSettlementRepositoryPort;
  private readonly store: RemoteWorkerArtifactStore;
  private readonly authority: RemoteWorkerAssignmentAuthorityFence;

  public constructor(dependencies: RemoteWorkerArtifactSettlementDependencies) {
    this.repository = dependencies.repository;
    this.store = dependencies.store;
    this.authority = dependencies.authority;
  }

  public async openUpload(input: OpenUploadInput): Promise<RemoteWorkerArtifactUploadRecord> {
    await this.authority.assertLiveAuthority(input);
    return await this.repository.openUpload(input);
  }

  public async appendPart(input: AppendPartInput): Promise<RemoteWorkerArtifactUploadRecord> {
    // Every part operation rechecks the exact current assignment authority before
    // it records an immutable part receipt.
    await this.authority.assertLiveAuthority(input);
    return await this.repository.appendPart(input);
  }

  /**
   * Commit streams the files without buffering the full artifact: each file's
   * bytes are installed at their immutable CAS address before the durable
   * manifest transaction re-locks assignment authority and records the blobs,
   * manifest, entries, upload commit, and verification-gate state.
   */
  public async commitArtifact(input: CommitArtifactInput): Promise<RemoteWorkerArtifactUploadRecord> {
    await this.authority.assertLiveAuthority(input);
    if (input.files.length > REMOTE_WORKER_SETTLEMENT_BOUNDS.maxFiles) {
      throw new RangeError("Remote worker artifact commit exceeds the file bound.");
    }
    // Install every referenced blob into CAS with full retained-handle
    // verification; existing objects converge only on an exact hash match.
    const blobs = new Map<string, RemoteWorkerBlobInput>();
    for (const entry of input.manifest.entries) {
      const file = input.files.find((candidate) => candidate.logicalPathSha256 === entry.logicalPathSha256);
      if (!file) throw new RangeError("Remote worker artifact commit is missing a manifest file.");
      const installed = await this.store.installBlob({
        executionWorkspaceId: input.manifest.identity.executionWorkspaceId,
        blobSha256: entry.blobSha256,
        bytes: file.bytes,
        signal: input.signal,
      });
      blobs.set(entry.blobSha256, {
        blobSha256: installed.blobSha256,
        byteCount: installed.byteCount,
        physicalRelPath: installed.physicalRelPath,
      });
    }
    // Re-lock assignment authority immediately before the durable transaction.
    await this.authority.assertLiveAuthority(input);
    return await this.repository.commitArtifact({
      registryWorkspaceId: input.registryWorkspaceId,
      assignmentId: input.assignmentId,
      assignmentGeneration: input.assignmentGeneration,
      uploadId: input.uploadId,
      manifest: input.manifest,
      blobs: [...blobs.values()],
      idempotencyKey: input.idempotencyKey,
    });
  }

  public manifestSha256(manifest: RemoteWorkerArtifactManifest): string {
    return remoteWorkerArtifactManifestSha256(manifest);
  }

  public identityOf(upload: RemoteWorkerArtifactUploadRecord): RemoteWorkerSettlementIdentity {
    return upload.identity;
  }
}
