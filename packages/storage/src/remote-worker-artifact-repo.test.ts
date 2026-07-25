import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerArtifactBlobRelPath,
  remoteWorkerArtifactWorkspaceShard,
  remoteWorkerAssignmentParentContextSha256,
  type RemoteWorkerArtifactManifest,
  type RemoteWorkerSettlementIdentity,
} from "@goatcitadel/contracts";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { ChatTurnTraceRepository } from "./chat-turn-trace-repo.js";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { MeshCapabilityNodeAdmissionRepository } from "./mesh-capability-node-admission-repo.js";
import { MeshRepository } from "./mesh-repo.js";
import { RemoteWorkerAdmissionRepository } from "./remote-worker-admission-repo.js";
import { RemoteWorkerArtifactRepository } from "./remote-worker-artifact-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { createDatabase } from "./sqlite.js";
import { TaskRepository } from "./task-repo.js";

const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const FUTURE = "2099-01-01T00:00:00.000Z";

export interface SeededGeneration {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
}

export function seedRemoteWorkerGeneration(db: DatabaseClient, seed: string): SeededGeneration {
  const tasks = new TaskRepository(db);
  const sessions = new ChatSessionMetaRepository(db);
  const turns = new ChatTurnTraceRepository(db);
  const durableRuns = new DurableRunRepository(db);
  const mesh = new MeshRepository(db);
  const nodeAdmissions = new MeshCapabilityNodeAdmissionRepository(db);
  const workerAdmissions = new RemoteWorkerAdmissionRepository(db);
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const now = durableRuns.readDatabaseNow();
  const taskId = `task-${seed}`;
  const sessionId = `session-${seed}`;
  const turnId = `turn-${seed}`;
  const durableRunId = `run-${seed}`;

  tasks.create({ title: `Assignment ${seed}`, workspaceId: "default" }, now, { taskId });
  sessions.ensure(sessionId, now, "default");
  turns.create({
    turnId,
    sessionId,
    userMessageId: `message-${seed}`,
    mode: "chat",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    startedAt: now,
  });
  const parentInput = { executionWorkspaceId: "default", durableRunId, taskId, sessionId, turnId } as const;
  const parentContext = buildRemoteWorkerAssignmentParentContext(parentInput);
  const parentContextSha256 = remoteWorkerAssignmentParentContextSha256(parentInput);
  durableRuns.createRun({
    runId: durableRunId,
    workflowKey: "chat.turn.execute",
    status: "running",
    attemptCount: 1,
    maxAttempts: 3,
    leaseOwnerId: "gateway-a",
    leaseHeartbeatAt: now,
    leaseExpiresAt: FUTURE,
    version: 1,
    startedAt: now,
    now,
    metadata: {
      remoteWorkerAssignmentParentContext: parentContext,
      remoteWorkerAssignmentParentContextSha256: parentContextSha256,
    },
  });
  const runtimePayload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: D(`${seed}:bundle`),
    dependencyLockSha256: D(`${seed}:lock`),
    vendorTreeSha256: D(`${seed}:vendor`),
    launcherSha256: D(`${seed}:launcher`),
    installedTreeManifestSha256: D(`${seed}:tree`),
    installedTreeFileCount: 12,
    platform: "linux" as const,
    architecture: "x64" as const,
  };
  const bootstrap = workerAdmissions.createBootstrap({
    registryWorkspaceId: "default",
    workerLabel: `Worker ${seed}`,
    platform: "linux",
    architecture: "x64",
    runtimeManifest: {
      payload: runtimePayload,
      payloadSha256: D(canonicalJsonString(runtimePayload)),
      signatureAlgorithm: "ed25519",
      signerKeyId: `release-key-${seed}`,
      signatureBase64Url: "A".repeat(86),
    },
    allowedWorkspaceIds: ["default"],
    capabilityClasses: ["durable_compute", "gateway_inference"],
    expiresInSeconds: 300,
    createdByActorId: "operator-a",
    idempotencyKey: `bootstrap:${seed}`,
    bootstrapSecretSha256: D(`${seed}:bootstrap-secret`),
  }).record;
  const worker = workerAdmissions.finalizeBootstrapAdmission({
    expectedRegistryWorkspaceId: bootstrap.registryWorkspaceId,
    expectedBootstrapId: bootstrap.bootstrapId,
    expectedTargetWorkerGeneration: bootstrap.targetWorkerGeneration,
    bootstrapSecretSha256: D(`${seed}:bootstrap-secret`),
    verifiedPublicKeySpkiSha256: D(`${seed}:spki`),
    verifiedClientCertificateSha256: D(`${seed}:certificate`),
    verifiedRuntimeManifestSha256: D(canonicalJsonString(bootstrap.runtimeManifest)),
    verifiedWorkspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
    verifiedCapabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
    verifiedTransportIdentitySource: "native_mtls",
    verifiedTransportTrustAnchorSha256: D(`${seed}:trust-anchor`),
    verifiedTransportReceiptSha256: D(`${seed}:transport-receipt`),
    verifiedProofOfPossessionReceiptSha256: D(`${seed}:pop-receipt`),
    verifiedDownloadReceiptSha256: D(`${seed}:download-receipt`),
    verifiedInstalledTreeAttestationSha256: D(`${seed}:installed-tree-attestation`),
    verifiedInstalledTreeReceiptSha256: D(`${seed}:tree-receipt`),
    credentialIssuanceProofSha256: D(`${seed}:issuance`),
    credentialExpiresInSeconds: 600,
    credentialTokenSha256: D(`${seed}:credential-token`),
    exchangeIdempotencyKey: `exchange:${seed}`,
  });
  const tlsFingerprint = `sha256:${bootstrap.nodeId}`;
  const joinToken = `join:${seed}`;
  mesh.upsertNode({
    nodeId: bootstrap.nodeId,
    transport: "lan",
    status: "online",
    capabilities: [],
    tlsFingerprint,
    joinedAt: now,
    lastSeenAt: now,
  });
  mesh.issueJoinToken(joinToken, FUTURE);
  mesh.consumeJoinToken(joinToken, bootstrap.nodeId, now);
  const joinTokenSha256 = mesh.snapshotRuntimeArtifacts(bootstrap.nodeId, joinToken).tokenHash;
  const nodeAdmission = nodeAdmissions.admit({
    workspaceId: "default",
    nodeId: bootstrap.nodeId,
    expectedAdmissionGeneration: 0,
    joinTokenSha256: joinTokenSha256!,
    mtlsRequired: true,
    tlsFingerprint,
    admittedByActorId: "operator-a",
    idempotencyKey: `node-admission:${seed}`,
  });
  const assignment = assignments.createAssignment({
    manifest: {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      registryWorkspaceId: "default",
      ...parentInput,
      capabilityProfileSha256: D(`${seed}:capability-profile`),
      contextSnapshotSha256: D(`${seed}:context`),
      toolEffectPostureSha256: D(`${seed}:posture`),
      pathJailSha256: D(`${seed}:jail`),
      parentContextSha256,
      requiredCapabilityClasses: ["durable_compute", "gateway_inference"],
      deadlineAt: FUTURE,
      leaseTtlSeconds: 60,
      maxEventCount: 100,
      maxEventBytes: 4_096,
      eventLowWatermark: 2,
      eventHighWatermark: 5,
      maxOutputBytes: 65_536,
      maxArtifactBytes: 1_048_576,
    },
    createdByActorId: "gateway-a",
    idempotencyKey: `assignment:${seed}`,
  }).assignment;
  const generation = assignments.startGeneration({
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    workerId: worker.generation.workerId,
    workerGeneration: worker.generation.workerGeneration,
    nodeId: bootstrap.nodeId,
    nodeAdmissionGeneration: nodeAdmission.admissionGeneration,
    dispatchOwnerId: "gateway-a",
    durableRunAttempt: 1,
    leaseTokenSha256: D(`${seed}:lease:1`),
    idempotencyKey: `generation:${seed}:1`,
  }).generation;

  return {
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    assignmentGeneration: generation.assignmentGeneration,
  };
}

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
