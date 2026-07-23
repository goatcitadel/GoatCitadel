import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  canonicalJsonString,
  type RemoteWorkerArtifactManifest,
  type RemoteWorkerSettlementIdentity,
} from "@goatcitadel/contracts";
import {
  RemoteWorkerArtifactSettlementService,
  type RemoteWorkerAssignmentAuthorityFence,
} from "./remote-worker-artifact-settlement-service.js";

const D = (value: string): string => createHash("sha256").update(value).digest("hex");

const identity: RemoteWorkerSettlementIdentity = {
  registryWorkspaceId: "default",
  executionWorkspaceId: "default",
  assignmentId: "assignment-1",
  assignmentGeneration: 1,
  workerId: "worker-1",
  workerGeneration: 1,
  runtimeManifestSha256: D("runtime"),
  workspaceCeilingSha256: D("workspace"),
  capabilityCeilingSha256: D("capability"),
  assignmentManifestSha256: D("assignment-manifest"),
};

function manifest(): RemoteWorkerArtifactManifest {
  const logicalPath = "dir/file.bin";
  return {
    schemaVersion: REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    identity,
    pathJailSha256: D("jail"),
    workerClaimIds: [],
    workerClaimSha256: D("claims"),
    requiredVerifierProfileSha256: null,
    fileCount: 1,
    totalBytes: 5,
    entries: [
      {
        entryIndex: 0,
        logicalPath,
        logicalPathSha256: D(canonicalJsonString({ logicalPath })),
        blobSha256: D("blob"),
        byteCount: 5,
        mimeType: "application/octet-stream",
      },
    ],
  };
}

function fakeUpload() {
  return { identity, uploadId: "upload-1", uploadState: "committed", uploadRevision: 2 } as never;
}

describe("HX-506 artifact settlement service", () => {
  it("rechecks authority on every part operation and re-locks before commit", async () => {
    const authority: RemoteWorkerAssignmentAuthorityFence = { assertLiveAuthority: vi.fn() };
    const repository = {
      openUpload: vi.fn(() => fakeUpload()),
      appendPart: vi.fn(() => fakeUpload()),
      commitArtifact: vi.fn(() => fakeUpload()),
    } as never;
    const store = {
      installBlob: vi.fn(async () => ({
        blobSha256: D("blob"),
        physicalRelPath: "remote-workers/artifacts/x/sha256/aa/aa",
        byteCount: 5,
        reused: false,
      })),
    } as never;
    const service = new RemoteWorkerArtifactSettlementService({ repository, store, authority });

    const base = {
      registryWorkspaceId: "default",
      assignmentId: "assignment-1",
      assignmentGeneration: 1,
      leaseTokenSha256: D("lease"),
      uploadId: "upload-1",
    };
    service.openUpload({
      ...base,
      uploadAttempt: 1,
      declaredFileCount: 1,
      declaredTotalBytes: 5,
      stagingRootSha256: D("staging"),
      expiresAt: "2099-01-01T00:00:00.000Z",
      idempotencyKey: "open",
    });
    service.appendPart({
      ...base,
      part: {
        globalSequence: 1,
        logicalPathSha256: D("p"),
        filePartIndex: 0,
        isFinalPart: true,
        partBytes: 5,
        partSha256: D("blob"),
      },
      idempotencyKey: "part",
    });
    await service.commitArtifact({
      ...base,
      manifest: manifest(),
      files: [
        {
          logicalPath: "dir/file.bin",
          logicalPathSha256: D(canonicalJsonString({ logicalPath: "dir/file.bin" })),
          bytes: new TextEncoder().encode("hello"),
          mimeType: "application/octet-stream",
        },
      ],
      idempotencyKey: "commit",
      signal: new AbortController().signal,
    });

    // open + part + commit(enter) + commit(re-lock) = 4 authority checks.
    expect((authority.assertLiveAuthority as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
    // The blob is installed into CAS before the durable manifest transaction.
    const installOrder = (store as { installBlob: ReturnType<typeof vi.fn> }).installBlob.mock.invocationCallOrder[0]!;
    const commitOrder = (repository as { commitArtifact: ReturnType<typeof vi.fn> }).commitArtifact.mock
      .invocationCallOrder[0]!;
    expect(installOrder).toBeLessThan(commitOrder);
  });

  it("fails a commit that references a file missing from the streamed set", async () => {
    const authority: RemoteWorkerAssignmentAuthorityFence = { assertLiveAuthority: vi.fn() };
    const repository = { commitArtifact: vi.fn(() => fakeUpload()) } as never;
    const store = { installBlob: vi.fn() } as never;
    const service = new RemoteWorkerArtifactSettlementService({ repository, store, authority });
    await expect(
      service.commitArtifact({
        registryWorkspaceId: "default",
        assignmentId: "assignment-1",
        assignmentGeneration: 1,
        leaseTokenSha256: D("lease"),
        uploadId: "upload-1",
        manifest: manifest(),
        files: [],
        idempotencyKey: "commit",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/missing a manifest file/u);
  });
});
