import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_PLATFORM_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_PROFILE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerAssignmentParentContextSha256,
  remoteWorkerCellEvidenceSha256,
  type RemoteWorkerCellCapacityFootprint,
  type RemoteWorkerCellPlatformIdentity,
  type RemoteWorkerCellProfile,
} from "@goatcitadel/contracts";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { ChatTurnTraceRepository } from "./chat-turn-trace-repo.js";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { MeshCapabilityNodeAdmissionRepository } from "./mesh-capability-node-admission-repo.js";
import { MeshRepository } from "./mesh-repo.js";
import { RemoteWorkerAdmissionRepository } from "./remote-worker-admission-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerCellRepository, type RemoteWorkerCellKey } from "./remote-worker-cell-repo.js";
import { createDatabase } from "./sqlite.js";
import { TaskRepository } from "./task-repo.js";

const clients: DatabaseClient[] = [];
const FUTURE = "2099-01-01T00:00:00.000Z";
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

interface Seeded {
  db: DatabaseClient;
  cells: RemoteWorkerCellRepository;
  key: RemoteWorkerCellKey;
  profile: RemoteWorkerCellProfile;
  now: string;
}

function seed(name: string): Seeded {
  const db = createDatabase({ dbPath: ":memory:" });
  clients.push(db);
  const tasks = new TaskRepository(db);
  const sessions = new ChatSessionMetaRepository(db);
  const turns = new ChatTurnTraceRepository(db);
  const durableRuns = new DurableRunRepository(db);
  const mesh = new MeshRepository(db);
  const nodeAdmissions = new MeshCapabilityNodeAdmissionRepository(db);
  const workerAdmissions = new RemoteWorkerAdmissionRepository(db);
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const now = durableRuns.readDatabaseNow();
  const taskId = `task-${name}`;
  const sessionId = `session-${name}`;
  const turnId = `turn-${name}`;
  const durableRunId = `run-${name}`;

  tasks.create({ title: `Assignment ${name}`, workspaceId: "default" }, now, { taskId });
  sessions.ensure(sessionId, now, "default");
  turns.create({
    turnId,
    sessionId,
    userMessageId: `message-${name}`,
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
    bundleSha256: D(`${name}:bundle`),
    dependencyLockSha256: D(`${name}:lock`),
    vendorTreeSha256: D(`${name}:vendor`),
    launcherSha256: D(`${name}:launcher`),
    installedTreeManifestSha256: D(`${name}:tree`),
    installedTreeFileCount: 12,
    platform: "linux" as const,
    architecture: "x64" as const,
  };
  const bootstrap = workerAdmissions.createBootstrap({
    registryWorkspaceId: "default",
    workerLabel: `Worker ${name}`,
    platform: "linux",
    architecture: "x64",
    runtimeManifest: {
      payload: runtimePayload,
      payloadSha256: D(canonicalJsonString(runtimePayload)),
      signatureAlgorithm: "ed25519",
      signerKeyId: `release-key-${name}`,
      signatureBase64Url: "A".repeat(86),
    },
    allowedWorkspaceIds: ["default"],
    capabilityClasses: ["durable_compute", "gateway_inference"],
    expiresInSeconds: 300,
    createdByActorId: "operator-a",
    idempotencyKey: `bootstrap:${name}`,
    bootstrapSecretSha256: D(`${name}:bootstrap-secret`),
  }).record;
  const worker = workerAdmissions.finalizeBootstrapAdmission({
    expectedRegistryWorkspaceId: bootstrap.registryWorkspaceId,
    expectedBootstrapId: bootstrap.bootstrapId,
    expectedTargetWorkerGeneration: bootstrap.targetWorkerGeneration,
    bootstrapSecretSha256: D(`${name}:bootstrap-secret`),
    verifiedPublicKeySpkiSha256: D(`${name}:spki`),
    verifiedClientCertificateSha256: D(`${name}:certificate`),
    verifiedRuntimeManifestSha256: D(canonicalJsonString(bootstrap.runtimeManifest)),
    verifiedWorkspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
    verifiedCapabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
    verifiedTransportIdentitySource: "native_mtls",
    verifiedTransportTrustAnchorSha256: D(`${name}:trust-anchor`),
    verifiedTransportReceiptSha256: D(`${name}:transport-receipt`),
    verifiedProofOfPossessionReceiptSha256: D(`${name}:pop-receipt`),
    verifiedDownloadReceiptSha256: D(`${name}:download-receipt`),
    verifiedInstalledTreeAttestationSha256: D(`${name}:installed-tree-attestation`),
    verifiedInstalledTreeReceiptSha256: D(`${name}:tree-receipt`),
    credentialIssuanceProofSha256: D(`${name}:issuance`),
    credentialExpiresInSeconds: 600,
    credentialTokenSha256: D(`${name}:credential-token`),
    exchangeIdempotencyKey: `exchange:${name}`,
  });
  const tlsFingerprint = `sha256:${bootstrap.nodeId}`;
  const joinToken = `join:${name}`;
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
  assert.equal(mesh.consumeJoinToken(joinToken, bootstrap.nodeId, now), true);
  const joinTokenSha256 = mesh.snapshotRuntimeArtifacts(bootstrap.nodeId, joinToken).tokenHash;
  const nodeAdmission = nodeAdmissions.admit({
    workspaceId: "default",
    nodeId: bootstrap.nodeId,
    expectedAdmissionGeneration: 0,
    joinTokenSha256: joinTokenSha256!,
    mtlsRequired: true,
    tlsFingerprint,
    admittedByActorId: "operator-a",
    idempotencyKey: `node-admission:${name}`,
  });
  const assignment = assignments.createAssignment({
    manifest: {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      registryWorkspaceId: "default",
      ...parentInput,
      capabilityProfileSha256: D(`${name}:capability-profile`),
      contextSnapshotSha256: D(`${name}:context`),
      toolEffectPostureSha256: D(`${name}:posture`),
      pathJailSha256: D(`${name}:jail`),
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
    idempotencyKey: `assignment:${name}`,
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
    leaseTokenSha256: D(`${name}:lease:1`),
    idempotencyKey: `generation:${name}:1`,
  }).generation;

  const profile: RemoteWorkerCellProfile = {
    schemaVersion: REMOTE_WORKER_CELL_PROFILE_SCHEMA_VERSION,
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    assignmentGeneration: generation.assignmentGeneration,
    cellId: `cell-${name}`,
    workerId: worker.generation.workerId,
    workerGeneration: worker.generation.workerGeneration,
    backend: "container",
    logicalRootSha256: D(`${name}:root`),
    assignmentManifestSha256: D(`${name}:manifest`),
    pathJailSha256: D(`${name}:jail`),
    capabilityProfileSha256: D(`${name}:capability`),
    contextSnapshotSha256: D(`${name}:context`),
    toolEffectPostureSha256: D(`${name}:posture`),
    runtimeAttestationSha256: D(`${name}:runtime`),
    launcherAttestationSha256: D(`${name}:launcher`),
    capacity: {
      schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
      logicalDiskBytes: 1_000_000,
      allocatedDiskBytes: 4_000_000,
      fileLimit: 10_000,
      inodeLimit: 20_000,
      processLimit: 128,
      cpuLimitMilli: 2_000,
      wallLimitMs: 900_000,
      memoryLimitBytes: 2_000_000_000,
      rawOutputLimitBytes: 8_388_608,
      diagnosticLimitBytes: 65_536,
      artifactCeilingBytes: 67_108_864,
      backupStagingBytes: 33_554_432,
      backupPublicationBytes: 33_554_432,
    },
    egressPosture: "allowlisted",
    egressPolicySha256: D(`${name}:egress`),
    egressDnsRevision: 4,
    envAllowlistSha256: D(`${name}:env`),
  };

  return {
    db,
    cells: new RemoteWorkerCellRepository(db),
    key: {
      registryWorkspaceId: "default",
      assignmentId: assignment.assignmentId,
      assignmentGeneration: generation.assignmentGeneration,
    },
    profile,
    now,
  };
}

function platform(name: string): RemoteWorkerCellPlatformIdentity {
  return {
    schemaVersion: REMOTE_WORKER_CELL_PLATFORM_SCHEMA_VERSION,
    backend: "container",
    containerName: `gc-cell-${name}`,
    containerLabelSha256: D(`${name}:label`),
    imageDigest: `sha256:${"a".repeat(64)}`,
    networkName: `gc-cell-net-${name}`,
  };
}

function footprint(overrides: Partial<RemoteWorkerCellCapacityFootprint> = {}): RemoteWorkerCellCapacityFootprint {
  return {
    schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
    mutableRootBytes: 1_000,
    inputStagingBytes: 0,
    backupStagingBytes: 0,
    artifactStagingBytes: 0,
    immutableArtifactBytes: 0,
    retainedOutboxBytes: 0,
    databaseSidecarBytes: 0,
    backupPublicationBytes: 0,
    manifestBytes: 0,
    proxySidecarBytes: 0,
    diagnosticBytes: 0,
    failedCleanupBytes: 0,
    quarantineEvidenceBytes: 0,
    ...overrides,
  };
}

/** Drive a cell forward to `running` and return the running record. */
function toRunning(s: Seeded) {
  s.cells.profileOrReplay({ profile: s.profile, idempotencyKey: "cell:idem:1", createdAt: s.now });
  s.cells.claimProvisioning({
    ...s.key,
    provisioningOwner: "gateway-a",
    leaseExpiresAt: FUTURE,
    detailSha256: D("claim"),
    now: s.now,
  });
  s.cells.persistPlatformIdentity({
    ...s.key,
    provisioningOwner: "gateway-a",
    platformIdentity: platform("1"),
    detailSha256: D("plat"),
    now: s.now,
  });
  const ready = s.cells.getCell(s.key)!;
  s.cells.transitionExecution({
    ...s.key,
    expectedRevision: ready.executionRevision,
    toState: "starting",
    detailSha256: D("start"),
    now: s.now,
  });
  const starting = s.cells.getCell(s.key)!;
  return s.cells.transitionExecution({
    ...s.key,
    expectedRevision: starting.executionRevision,
    toState: "running",
    detailSha256: D("run"),
    now: s.now,
  });
}

describe("RemoteWorkerCellRepository (SQLite)", () => {
  it("profiles a cell once and exactly replays a repeated idempotency key", () => {
    const s = seed("profile");
    const created = s.cells.profileOrReplay({ profile: s.profile, idempotencyKey: "cell:idem:1", createdAt: s.now });
    assert.equal(created.disposition, "created");
    assert.equal(created.cell.executionState, "profiled");
    assert.equal(created.cell.cleanupState, "not_started");
    assert.equal(created.cell.backupState, "disabled");
    const replay = s.cells.profileOrReplay({ profile: s.profile, idempotencyKey: "cell:idem:1", createdAt: s.now });
    assert.equal(replay.disposition, "replayed");
    assert.throws(
      () =>
        s.cells.profileOrReplay({
          profile: { ...s.profile, egressDnsRevision: 9 },
          idempotencyKey: "cell:idem:1",
          createdAt: s.now,
        }),
      /does not match/u,
    );
  });

  it("cannot mutate an immutable profile binding through the database", () => {
    const s = seed("immutable");
    s.cells.profileOrReplay({ profile: s.profile, idempotencyKey: "cell:idem:1", createdAt: s.now });
    assert.throws(
      () =>
        s.db
          .prepare("UPDATE remote_worker_cells SET allocated_disk_bytes = 8000000 WHERE assignment_id = @assignmentId")
          .run({ assignmentId: s.key.assignmentId }),
      /immutable/u,
    );
    assert.throws(
      () =>
        s.db
          .prepare("UPDATE remote_worker_cells SET egress_posture = 'deny_all' WHERE assignment_id = @assignmentId")
          .run({ assignmentId: s.key.assignmentId }),
      /immutable/u,
    );
  });

  it("advances execution through a monotonic CAS with contiguous hash-chained evidence", () => {
    const s = seed("cas");
    const running = toRunning(s);
    assert.equal(running.executionState, "running");
    assert.equal(running.executionRevision, 5);
    // A stale expected revision loses the CAS.
    assert.throws(
      () =>
        s.cells.transitionExecution({
          ...s.key,
          expectedRevision: 2,
          toState: "exited",
          detailSha256: D("x"),
          now: s.now,
        }),
      /revision mismatch/u,
    );
    // The evidence chain is contiguous and byte-identical to a recomputed chain.
    const evidence = s.cells.listEvidenceAfter(s.key, 0);
    assert.deepEqual(
      evidence.map((entry) => entry.evidenceSequence),
      [1, 2, 3, 4],
    );
    let previous = "0".repeat(64);
    for (const entry of evidence) {
      assert.equal(entry.previousEvidenceSha256, previous);
      assert.equal(
        entry.evidenceSha256,
        remoteWorkerCellEvidenceSha256({
          registryWorkspaceId: entry.registryWorkspaceId,
          assignmentId: entry.assignmentId,
          assignmentGeneration: entry.assignmentGeneration,
          cellId: entry.cellId,
          evidenceSequence: entry.evidenceSequence,
          domain: entry.domain,
          payloadSha256: entry.payloadSha256,
          previousEvidenceSha256: entry.previousEvidenceSha256,
        }),
      );
      previous = entry.evidenceSha256;
    }
  });

  it("rejects an out-of-machine transition and refuses to leave a terminal state", () => {
    const s = seed("machine");
    const running = toRunning(s);
    assert.throws(
      () =>
        s.cells.transitionExecution({
          ...s.key,
          expectedRevision: running.executionRevision,
          toState: "ready",
          detailSha256: D("x"),
          now: s.now,
        }),
      /not permitted/u,
    );
    const exited = s.cells.finalizeDiagnostics({
      ...s.key,
      expectedRevision: running.executionRevision,
      toState: "exited",
      exitCode: 0,
      terminatedBySignal: null,
      diagnosticCaptureSha256: D("capture"),
      rawOutputBytes: 4_096,
      retainedDiagnosticBytes: 512,
      detailSha256: D("exit"),
      now: s.now,
    });
    assert.equal(exited.executionState, "exited");
    assert.throws(
      () =>
        s.db
          .prepare(
            "UPDATE remote_worker_cells SET execution_state = 'running', execution_revision = 99 WHERE assignment_id = @assignmentId",
          )
          .run({ assignmentId: s.key.assignmentId }),
      /monotonically|revision/u,
    );
  });

  it("keeps high-water and retained-byte accounting monotonic", () => {
    const s = seed("highwater");
    toRunning(s);
    s.cells.recordCapacityHighWater({
      ...s.key,
      footprint: footprint({ mutableRootBytes: 5_000 }),
      peakDiskBytes: 5_000,
      peakMemoryBytes: 1_000_000,
      peakFileCount: 40,
      peakProcessCount: 8,
      rawOutputBytes: 2_000,
      failedCleanupRetainedBytes: 0,
      quarantineRetainedBytes: 0,
      detailSha256: D("cap1"),
      now: s.now,
    });
    // A lower peak is clamped up (MAX) rather than regressing.
    const second = s.cells.recordCapacityHighWater({
      ...s.key,
      footprint: footprint({ mutableRootBytes: 1_000 }),
      peakDiskBytes: 1_000,
      peakMemoryBytes: 10,
      peakFileCount: 1,
      peakProcessCount: 1,
      rawOutputBytes: 1,
      failedCleanupRetainedBytes: 0,
      quarantineRetainedBytes: 0,
      detailSha256: D("cap2"),
      now: s.now,
    });
    assert.equal(second.peakDiskBytes, 5_000);
    assert.equal(second.peakMemoryBytes, 1_000_000);
    assert.equal(second.capacityRevision, 2);
    // The database rejects any direct high-water regression.
    assert.throws(
      () =>
        s.db
          .prepare("UPDATE remote_worker_cells SET peak_disk_bytes = 0 WHERE assignment_id = @assignmentId")
          .run({ assignmentId: s.key.assignmentId }),
      /cannot regress/u,
    );
  });

  it("records verified runtime removal while preserving the canonical record and its evidence", () => {
    const s = seed("cleanup");
    const running = toRunning(s);
    s.cells.finalizeDiagnostics({
      ...s.key,
      expectedRevision: running.executionRevision,
      toState: "exited",
      exitCode: 0,
      terminatedBySignal: null,
      diagnosticCaptureSha256: D("capture"),
      rawOutputBytes: 1,
      retainedDiagnosticBytes: 0,
      detailSha256: D("exit"),
      now: s.now,
    });
    // Cleanup pending -> stopping -> verifying_zero -> verified_clean.
    let cleanup = s.cells.getCell(s.key)!;
    for (const toState of ["pending", "stopping", "verifying_zero", "verified_clean"] as const) {
      cleanup = s.cells.transitionCleanup({
        ...s.key,
        expectedRevision: cleanup.cleanupRevision,
        toState,
        detailSha256: D(`cleanup:${toState}`),
        now: s.now,
      });
    }
    assert.equal(cleanup.cleanupState, "verified_clean");
    // The canonical record and its evidence are never deleted to reclaim a metric:
    // the append-only evidence FK keeps even a verified-clean row permanent.
    assert.ok(s.cells.getCell(s.key));
    assert.throws(
      () =>
        s.db
          .prepare("DELETE FROM remote_worker_cells WHERE assignment_id = @assignmentId")
          .run({ assignmentId: s.key.assignmentId }),
      /constraint failed/u,
    );
  });

  it("refuses to delete a live or unverified cell and never verifies unknown liveness clean", () => {
    const s = seed("unknown");
    toRunning(s);
    // A live cell cannot be deleted (verified zero liveness required).
    assert.throws(
      () =>
        s.db
          .prepare("DELETE FROM remote_worker_cells WHERE assignment_id = @assignmentId")
          .run({ assignmentId: s.key.assignmentId }),
      /verified zero liveness/u,
    );
    // Move to liveness_unknown; it can never reach verified_clean.
    const running = s.cells.getCell(s.key)!;
    s.cells.transitionExecution({
      ...s.key,
      expectedRevision: running.executionRevision,
      toState: "liveness_unknown",
      detailSha256: D("unknown"),
      now: s.now,
    });
    let cleanup = s.cells.getCell(s.key)!;
    for (const toState of ["pending", "stopping", "verifying_zero"] as const) {
      cleanup = s.cells.transitionCleanup({
        ...s.key,
        expectedRevision: cleanup.cleanupRevision,
        toState,
        detailSha256: D(`c:${toState}`),
        now: s.now,
      });
    }
    assert.throws(
      () =>
        s.cells.transitionCleanup({
          ...s.key,
          expectedRevision: cleanup.cleanupRevision,
          toState: "verified_clean",
          detailSha256: D("cc"),
          now: s.now,
        }),
      /unknown liveness cannot be verified clean/u,
    );
  });

  it("appends append-only evidence that the database refuses to update or delete", () => {
    const s = seed("append");
    toRunning(s);
    assert.throws(
      () =>
        s.db.prepare("UPDATE remote_worker_cell_evidence SET domain = 'capacity' WHERE evidence_sequence = 1").run(),
      /append-only/u,
    );
    assert.throws(
      () => s.db.prepare("DELETE FROM remote_worker_cell_evidence WHERE evidence_sequence = 1").run(),
      /append-only/u,
    );
  });

  it("reattaches only to exact matching identity and marks a mismatch liveness_unknown", () => {
    const s = seed("reattach");
    s.cells.profileOrReplay({ profile: s.profile, idempotencyKey: "cell:idem:1", createdAt: s.now });
    s.cells.claimProvisioning({
      ...s.key,
      provisioningOwner: "gateway-a",
      leaseExpiresAt: FUTURE,
      detailSha256: D("claim"),
      now: s.now,
    });
    s.cells.persistPlatformIdentity({
      ...s.key,
      provisioningOwner: "gateway-a",
      platformIdentity: platform("1"),
      detailSha256: D("plat"),
      now: s.now,
    });
    const ready = s.cells.getCell(s.key)!;
    s.cells.transitionExecution({
      ...s.key,
      expectedRevision: ready.executionRevision,
      toState: "starting",
      detailSha256: D("start"),
      now: s.now,
    });
    const confirmed = s.cells.reattachOrMarkUnknown({
      ...s.key,
      observedPlatformIdentitySha256: ready.platformIdentitySha256!,
      detailSha256: D("attach"),
      now: s.now,
    });
    assert.equal(confirmed.confirmed, true);
    assert.equal(confirmed.cell.executionState, "running");

    const s2 = seed("reattach2");
    s2.cells.profileOrReplay({ profile: s2.profile, idempotencyKey: "cell:idem:1", createdAt: s2.now });
    s2.cells.claimProvisioning({
      ...s2.key,
      provisioningOwner: "gateway-a",
      leaseExpiresAt: FUTURE,
      detailSha256: D("claim"),
      now: s2.now,
    });
    s2.cells.persistPlatformIdentity({
      ...s2.key,
      provisioningOwner: "gateway-a",
      platformIdentity: platform("2"),
      detailSha256: D("plat"),
      now: s2.now,
    });
    const ready2 = s2.cells.getCell(s2.key)!;
    s2.cells.transitionExecution({
      ...s2.key,
      expectedRevision: ready2.executionRevision,
      toState: "starting",
      detailSha256: D("start"),
      now: s2.now,
    });
    const mismatch = s2.cells.reattachOrMarkUnknown({
      ...s2.key,
      observedPlatformIdentitySha256: D("wrong-identity"),
      detailSha256: D("attach"),
      now: s2.now,
    });
    assert.equal(mismatch.confirmed, false);
    assert.equal(mismatch.cell.executionState, "liveness_unknown");
  });
});
