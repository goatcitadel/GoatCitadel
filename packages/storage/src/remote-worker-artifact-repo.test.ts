import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  canonicalJsonString,
  remoteWorkerArtifactBlobRelPath,
  remoteWorkerArtifactWorkspaceShard,
  type RemoteWorkerArtifactManifest,
  type RemoteWorkerSettlementIdentity,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { RemoteWorkerArtifactRepository } from "./remote-worker-artifact-repo.js";
import { seedRemoteWorkerGeneration, type SeededGeneration } from "./remote-worker-test-fixtures.js";
import { createDatabase } from "./sqlite.js";

const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const FUTURE = "2099-01-01T00:00:00.000Z";

interface Harness {
  db: DatabaseClient;
  artifacts: RemoteWorkerArtifactRepository;
  seed: SeededGeneration;
}

function harness(seedLabel: string): Harness {
  const db = createDatabase({ dbPath: ":memory:" });
  const seed = seedRemoteWorkerGeneration(db, seedLabel);
  return { db, artifacts: new RemoteWorkerArtifactRepository(db), seed };
}

function buildManifest(
  identity: RemoteWorkerSettlementIdentity,
  requiredVerifier: string | null,
): RemoteWorkerArtifactManifest {
  const logicalPath = "dir/file.bin";
  return {
    schemaVersion: REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    identity,
    pathJailSha256: D("jail"),
    workerClaimIds: ["claim-1"],
    workerClaimSha256: D("claims"),
    requiredVerifierProfileSha256: requiredVerifier,
    fileCount: 1,
    totalBytes: 10,
    entries: [
      {
        entryIndex: 0,
        logicalPath,
        logicalPathSha256: D(canonicalJsonString({ logicalPath })),
        blobSha256: D("blob-content"),
        byteCount: 10,
        mimeType: "application/octet-stream",
      },
    ],
  };
}

function blobInput(identity: RemoteWorkerSettlementIdentity) {
  const blobSha256 = D("blob-content");
  return {
    blobSha256,
    byteCount: 10,
    physicalRelPath: remoteWorkerArtifactBlobRelPath(
      remoteWorkerArtifactWorkspaceShard(identity.executionWorkspaceId),
      blobSha256,
    ),
  };
}

function openAndCommit(
  h: Harness,
  requiredVerifier: string | null,
): { identity: RemoteWorkerSettlementIdentity; uploadId: string } {
  const { registryWorkspaceId, assignmentId, assignmentGeneration } = h.seed;
  const opened = h.artifacts.openUpload({
    registryWorkspaceId,
    assignmentId,
    assignmentGeneration,
    uploadAttempt: 1,
    declaredFileCount: 1,
    declaredTotalBytes: 10,
    stagingRootSha256: D("staging"),
    expiresAt: FUTURE,
    idempotencyKey: "open-1",
  });
  h.artifacts.appendPart({
    registryWorkspaceId,
    assignmentId,
    assignmentGeneration,
    uploadId: opened.uploadId,
    part: {
      globalSequence: 1,
      logicalPathSha256: D(canonicalJsonString({ logicalPath: "dir/file.bin" })),
      filePartIndex: 0,
      isFinalPart: true,
      partBytes: 10,
      partSha256: D("blob-content"),
    },
    idempotencyKey: "part-1",
  });
  h.artifacts.commitArtifact({
    registryWorkspaceId,
    assignmentId,
    assignmentGeneration,
    uploadId: opened.uploadId,
    manifest: buildManifest(opened.identity, requiredVerifier),
    blobs: [blobInput(opened.identity)],
    idempotencyKey: "commit-1",
  });
  return { identity: opened.identity, uploadId: opened.uploadId };
}

function gateOf(h: Harness, uploadId: string): string | null {
  return h.artifacts.getUpload(h.seed.registryWorkspaceId, h.seed.assignmentId, h.seed.assignmentGeneration, uploadId)
    .verificationGateState;
}

describe("HX-506 artifact repository (SQLite)", () => {
  it("streams parts and commits a manifest with a not_required gate", () => {
    const h = harness("commit");
    const { uploadId } = openAndCommit(h, null);
    const upload = h.artifacts.getUpload(
      h.seed.registryWorkspaceId,
      h.seed.assignmentId,
      h.seed.assignmentGeneration,
      uploadId,
    );
    assert.equal(upload.uploadState, "committed");
    assert.equal(upload.verificationGateState, "not_required");
    assert.equal(
      h.artifacts.getManifestSha256(h.seed.registryWorkspaceId, h.seed.assignmentId, h.seed.assignmentGeneration)
        ?.length,
      64,
    );
    h.db.close();
  });

  it("replays idempotent open and part", () => {
    const h = harness("replay");
    const { registryWorkspaceId, assignmentId, assignmentGeneration } = h.seed;
    const open = {
      registryWorkspaceId,
      assignmentId,
      assignmentGeneration,
      uploadAttempt: 1,
      declaredFileCount: 1,
      declaredTotalBytes: 10,
      stagingRootSha256: D("staging"),
      expiresAt: FUTURE,
      idempotencyKey: "open-1",
    };
    const first = h.artifacts.openUpload(open);
    assert.equal(h.artifacts.openUpload(open).uploadId, first.uploadId);
    h.db.close();
  });

  it("rejects a non-contiguous part sequence", () => {
    const h = harness("gap");
    const { registryWorkspaceId, assignmentId, assignmentGeneration } = h.seed;
    const opened = h.artifacts.openUpload({
      registryWorkspaceId,
      assignmentId,
      assignmentGeneration,
      uploadAttempt: 1,
      declaredFileCount: 1,
      declaredTotalBytes: 262144,
      stagingRootSha256: D("staging"),
      expiresAt: FUTURE,
      idempotencyKey: "open-1",
    });
    assert.throws(() =>
      h.artifacts.appendPart({
        registryWorkspaceId,
        assignmentId,
        assignmentGeneration,
        uploadId: opened.uploadId,
        part: {
          globalSequence: 2,
          logicalPathSha256: D("p"),
          filePartIndex: 0,
          isFinalPart: true,
          partBytes: 10,
          partSha256: D("part"),
        },
        idempotencyKey: "part-gap",
      }),
    );
    h.db.close();
  });

  it("rejects a declared total above the assignment artifact ceiling", () => {
    const h = harness("ceiling");
    assert.throws(() =>
      h.artifacts.openUpload({
        registryWorkspaceId: h.seed.registryWorkspaceId,
        assignmentId: h.seed.assignmentId,
        assignmentGeneration: h.seed.assignmentGeneration,
        uploadAttempt: 1,
        declaredFileCount: 1,
        declaredTotalBytes: 2_000_000,
        stagingRootSha256: D("staging"),
        expiresAt: FUTURE,
        idempotencyKey: "open-big",
      }),
    );
    h.db.close();
  });

  it("keeps parts, blobs, and manifests insert-only in the database", () => {
    const h = harness("insertonly");
    openAndCommit(h, null);
    assert.throws(() => h.db.prepare("UPDATE remote_worker_artifact_parts SET part_bytes = 5").run(), /insert-only/u);
    assert.throws(() => h.db.prepare("DELETE FROM remote_worker_artifact_parts").run(), /insert-only/u);
    assert.throws(
      () => h.db.prepare("UPDATE remote_worker_artifact_manifests SET file_count = 9").run(),
      /insert-only/u,
    );
    assert.throws(() => h.db.prepare("DELETE FROM remote_worker_artifact_blobs").run(), /insert-only/u);
    h.db.close();
  });

  it("rejects a child row naming a worker inconsistent with the generation (composite-FK isolation)", () => {
    const h = harness("fkisolation");
    const { registryWorkspaceId, assignmentId, assignmentGeneration } = h.seed;
    const opened = h.artifacts.openUpload({
      registryWorkspaceId,
      assignmentId,
      assignmentGeneration,
      uploadAttempt: 1,
      declaredFileCount: 1,
      declaredTotalBytes: 10,
      stagingRootSha256: D("staging"),
      expiresAt: FUTURE,
      idempotencyKey: "open-1",
    });
    assert.throws(() =>
      h.db
        .prepare(
          `INSERT INTO remote_worker_artifact_parts (
            registry_workspace_id, execution_workspace_id, assignment_id, assignment_generation, worker_id,
            worker_generation, runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256,
            assignment_manifest_sha256, upload_id, global_sequence, logical_path_sha256, file_part_index,
            is_final_part, part_bytes, part_sha256, idempotency_key, request_sha256, received_at
          ) VALUES (
            @rw, @ew, @aid, @gen, 'worker-forged', @wg, @rm, @wc, @cc, @am, @uid, 1, @lp, 0, 1, 10, @ps, 'forged', @ps, @now
          )`,
        )
        .run({
          rw: registryWorkspaceId,
          ew: opened.identity.executionWorkspaceId,
          aid: assignmentId,
          gen: assignmentGeneration,
          wg: opened.identity.workerGeneration,
          rm: opened.identity.runtimeManifestSha256,
          wc: opened.identity.workspaceCeilingSha256,
          cc: opened.identity.capabilityCeilingSha256,
          am: opened.identity.assignmentManifestSha256,
          uid: opened.uploadId,
          lp: D("p"),
          ps: D("forged"),
          now: FUTURE,
        }),
    );
    h.db.close();
  });

  it("advances the verification gate only on a passed Gateway attempt, never on a worker claim", () => {
    const h = harness("gate");
    const { registryWorkspaceId, assignmentId, assignmentGeneration } = h.seed;
    const { uploadId } = openAndCommit(h, D("verifier-profile"));
    assert.equal(gateOf(h, uploadId), "pending");

    h.artifacts.recordWorkerClaim({
      registryWorkspaceId,
      assignmentId,
      assignmentGeneration,
      attemptIndex: 1,
      evidence: {
        schemaVersion: REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
        kind: "worker_claim",
        attemptState: "worker_reported",
        verifierProfileSha256: null,
        preExecutionManifestSha256: D("pre"),
        postExecutionManifestSha256: D("post"),
        summary: "worker says trusted",
        capturedOutputBytes: 0,
      },
      idempotencyKey: "claim-1",
    });
    assert.equal(gateOf(h, uploadId), "pending");

    const attempt = h.artifacts.openGatewayVerification({
      registryWorkspaceId,
      assignmentId,
      assignmentGeneration,
      attemptIndex: 1,
      verifierProfileSha256: D("verifier-profile"),
      wallDeadlineAt: FUTURE,
      evidence: gatewayEvidence("queued", 0),
      idempotencyKey: "attempt-1",
    });
    const running = h.artifacts.advanceGatewayVerification({
      registryWorkspaceId,
      assignmentId,
      assignmentGeneration,
      verificationId: attempt.verificationId,
      expectedAttemptRevision: 1,
      nextState: "running",
      evidence: gatewayEvidence("running", 10),
    });
    assert.equal(running.gateState, "pending");
    const passed = h.artifacts.advanceGatewayVerification({
      registryWorkspaceId,
      assignmentId,
      assignmentGeneration,
      verificationId: attempt.verificationId,
      expectedAttemptRevision: 2,
      nextState: "passed",
      evidence: gatewayEvidence("passed", 20),
    });
    assert.equal(passed.gateState, "satisfied");
    assert.equal(gateOf(h, uploadId), "satisfied");
    h.db.close();
  });

  it("claims and resolves the staging cleanup under a database-clock claim", () => {
    const h = harness("cleanup");
    const { registryWorkspaceId, assignmentId, assignmentGeneration } = h.seed;
    const { uploadId } = openAndCommit(h, null);
    const claimed = h.artifacts.claimCleanup({
      registryWorkspaceId,
      assignmentId,
      assignmentGeneration,
      uploadId,
      expectedCleanupRevision: 1,
      claimOwner: "cleaner-a",
    });
    assert.equal(claimed.cleanupState, "pending");
    const resolved = h.artifacts.resolveCleanup({
      registryWorkspaceId,
      assignmentId,
      assignmentGeneration,
      uploadId,
      expectedCleanupRevision: claimed.cleanupRevision,
      claimOwner: "cleaner-a",
      resolution: "cleaned",
    });
    assert.equal(resolved.cleanupState, "cleaned");
    h.db.close();
  });
});

function gatewayEvidence(attemptState: "queued" | "running" | "passed", capturedOutputBytes: number) {
  return {
    schemaVersion: REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
    kind: "gateway_attempt" as const,
    attemptState,
    verifierProfileSha256: D("verifier-profile"),
    preExecutionManifestSha256: D("pre"),
    postExecutionManifestSha256: D("post"),
    summary: attemptState,
    capturedOutputBytes,
  };
}
