import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
  ConflictError,
  REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
  REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerArtifactBlobRelPath,
  remoteWorkerArtifactWorkspaceShard,
  remoteWorkerAssignmentParentContextSha256,
  type CreateRemoteWorkerBootstrapCommand,
  type FinalizeRemoteWorkerBootstrapAdmissionCommand,
  type RemoteWorkerAssignmentEventInput,
  type RemoteWorkerAssignmentManifest,
  type RemoteWorkerRuntimeManifest,
  type StartRemoteWorkerAssignmentGenerationCommand,
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

const clients: DatabaseClient[] = [];
const FUTURE = "2099-01-01T00:00:00.000Z";
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

function runtimeManifest(seed: string): RemoteWorkerRuntimeManifest {
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
  };
  return {
    payload,
    payloadSha256: D(canonicalJsonString(payload)),
    signatureAlgorithm: "ed25519",
    signerKeyId: `release-key-${seed}`,
    signatureBase64Url: "A".repeat(86),
  };
}

function bootstrapInput(seed: string): CreateRemoteWorkerBootstrapCommand {
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
    idempotencyKey: `bootstrap:${seed}`,
    bootstrapSecretSha256: D(`${seed}:bootstrap-secret`),
  };
}

function finalizeInput(
  bootstrap: ReturnType<RemoteWorkerAdmissionRepository["createBootstrap"]>["record"],
  seed: string,
): FinalizeRemoteWorkerBootstrapAdmissionCommand {
  return {
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
  };
}

function statusEvent(
  sequence: number,
  previousEventSha256: string,
  workerSentThrough = sequence,
  statusSha256 = D(`status:${sequence}`),
): RemoteWorkerAssignmentEventInput {
  return {
    sequence,
    eventId: `status-${sequence}`,
    eventType: "status",
    payload: {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
      phase: "running",
      statusSha256,
    },
    previousEventSha256,
    workerSentThrough,
  };
}

function transcriptEvent(sequence: number, previousEventSha256: string): RemoteWorkerAssignmentEventInput {
  return {
    sequence,
    eventId: `transcript-${sequence}`,
    eventType: "transcript_delta",
    payload: {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
      role: "assistant",
      text: `chunk-${sequence}`,
    },
    previousEventSha256,
    workerSentThrough: sequence,
  };
}

function createHarness(seed: string, leaseTtlSeconds = 60, maxOutputBytes = 65_536) {
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
  const parentInput = {
    executionWorkspaceId: "default",
    durableRunId,
    taskId,
    sessionId,
    turnId,
  } as const;
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

  const bootstrap = workerAdmissions.createBootstrap(bootstrapInput(seed)).record;
  const worker = workerAdmissions.finalizeBootstrapAdmission(finalizeInput(bootstrap, seed));
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
  assert.equal(mesh.consumeJoinToken(joinToken, bootstrap.nodeId, now), true);
  const joinTokenSha256 = mesh.snapshotRuntimeArtifacts(bootstrap.nodeId, joinToken).tokenHash;
  assert.ok(joinTokenSha256);
  const nodeAdmission = nodeAdmissions.admit({
    workspaceId: "default",
    nodeId: bootstrap.nodeId,
    expectedAdmissionGeneration: 0,
    joinTokenSha256,
    mtlsRequired: true,
    tlsFingerprint,
    admittedByActorId: "operator-a",
    idempotencyKey: `node-admission:${seed}`,
  });

  const manifest: RemoteWorkerAssignmentManifest = {
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
    leaseTtlSeconds,
    maxEventCount: 100,
    maxEventBytes: 4_096,
    eventLowWatermark: 2,
    eventHighWatermark: 5,
    maxOutputBytes,
    maxArtifactBytes: 1_048_576,
  };
  const createInput = {
    manifest,
    createdByActorId: "gateway-a",
    idempotencyKey: `assignment:${seed}`,
  } as const;
  const assignment = assignments.createAssignment(createInput).assignment;
  const startInput: StartRemoteWorkerAssignmentGenerationCommand = {
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
  };
  return {
    db,
    durableRuns,
    assignments,
    worker,
    bootstrap,
    nodeAdmission,
    manifest,
    createInput,
    assignment,
    startInput,
    taskId,
    sessionId,
    turnId,
    durableRunId,
  };
}

// HX-506 settlement seam: commit a real assignment-generation manifest so the
// assignment settlement gate can prove the output manifest names it. Requires the
// generation to be started first.
function commitOutputManifest(h: ReturnType<typeof createHarness>): string {
  const artifacts = new RemoteWorkerArtifactRepository(h.db);
  const key = { registryWorkspaceId: "default", assignmentId: h.assignment.assignmentId, assignmentGeneration: 1 };
  const logicalPath = "out/result.bin";
  const blobSha256 = D("hx506:blob");
  const opened = artifacts.openUpload({
    ...key,
    uploadAttempt: 1,
    declaredFileCount: 1,
    declaredTotalBytes: 10,
    stagingRootSha256: D("hx506:staging"),
    expiresAt: "2099-01-01T00:00:00.000Z",
    idempotencyKey: "hx506:open",
  });
  artifacts.appendPart({
    ...key,
    uploadId: opened.uploadId,
    part: {
      globalSequence: 1,
      logicalPathSha256: D(canonicalJsonString({ logicalPath })),
      filePartIndex: 0,
      isFinalPart: true,
      partBytes: 10,
      partSha256: blobSha256,
    },
    idempotencyKey: "hx506:part",
  });
  artifacts.commitArtifact({
    ...key,
    uploadId: opened.uploadId,
    manifest: {
      schemaVersion: REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
      identity: opened.identity,
      pathJailSha256: D("hx506:jail"),
      workerClaimIds: [],
      workerClaimSha256: D("hx506:claims"),
      requiredVerifierProfileSha256: null,
      fileCount: 1,
      totalBytes: 10,
      entries: [
        {
          entryIndex: 0,
          logicalPath,
          logicalPathSha256: D(canonicalJsonString({ logicalPath })),
          blobSha256,
          byteCount: 10,
          mimeType: "application/octet-stream",
        },
      ],
    },
    blobs: [
      {
        blobSha256,
        byteCount: 10,
        physicalRelPath: remoteWorkerArtifactBlobRelPath(
          remoteWorkerArtifactWorkspaceShard(opened.identity.executionWorkspaceId),
          blobSha256,
        ),
      },
    ],
    idempotencyKey: "hx506:commit",
  });
  return artifacts.getManifestSha256(key.registryWorkspaceId, key.assignmentId, key.assignmentGeneration)!;
}

function assertDirectEventRejected(
  h: ReturnType<typeof createHarness>,
  seed: string,
  eventType: RemoteWorkerAssignmentEventInput["eventType"],
  payload: Record<string, unknown>,
  workerSentThrough = 1,
): void {
  const payloadJson = JSON.stringify(payload);
  assert.throws(() =>
    h.db
      .prepare(
        `INSERT INTO remote_worker_assignment_events (
           registry_workspace_id, assignment_id, assignment_generation, sequence, event_id,
           event_type, payload_json, payload_sha256, previous_event_sha256, event_sha256,
           worker_sent_through, received_at
         ) VALUES (
           'default', @assignmentId, 1, 1, @eventId, @eventType, @payloadJson, @payloadSha256,
           @genesis, @eventSha256, @workerSentThrough, @receivedAt
         )`,
      )
      .run({
        assignmentId: h.assignment.assignmentId,
        eventId: `direct-invalid-${seed}`,
        eventType,
        payloadJson,
        payloadSha256: D(`payload:${seed}`),
        genesis: REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
        eventSha256: D(`event:${seed}`),
        workerSentThrough,
        receivedAt: h.durableRuns.readDatabaseNow(),
      }),
  );
}

describe("RemoteWorkerAssignmentRepository", () => {
  it("keeps committed create/start receipts replayable but blocks new mutations after parent-context drift", () => {
    const h = createHarness("parent-drift");
    const started = h.assignments.startGeneration(h.startInput);
    assert.equal(started.disposition, "started");
    assert.equal(h.assignments.startGeneration(h.startInput).disposition, "replayed_without_lease_secret");

    h.db.prepare("UPDATE tasks SET deleted_at = @now, updated_at = @now WHERE task_id = @taskId").run({
      taskId: h.taskId,
      now: h.durableRuns.readDatabaseNow(),
    });
    assert.equal(h.assignments.createAssignment(h.createInput).disposition, "replayed");
    assert.equal(h.assignments.startGeneration(h.startInput).disposition, "replayed_without_lease_secret");
    assert.throws(
      () =>
        h.assignments.renewLease({
          registryWorkspaceId: "default",
          assignmentId: h.assignment.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 1,
          expectedLeaseTokenSha256: h.startInput.leaseTokenSha256,
          leaseTokenSha256: D("parent-drift:lease:2"),
          workerSentThrough: 0,
          idempotencyKey: "parent-drift:renew",
        }),
      ConflictError,
    );
    assert.throws(
      () =>
        h.assignments.appendEvents({
          registryWorkspaceId: "default",
          assignmentId: h.assignment.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 1,
          leaseTokenSha256: h.startInput.leaseTokenSha256,
          events: [statusEvent(1, REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256)],
        }),
      ConflictError,
    );
  });

  it("refreshes an exact parent heartbeat fence before accepting later worker progress", () => {
    const h = createHarness("heartbeat");
    const started = h.assignments.startGeneration(h.startInput);
    assert.equal(started.lease.parentDispatchAuthority.durableRunVersion, 1);
    assert.ok(started.lease.expiresAt <= started.lease.parentDispatchAuthority.durableRunLeaseExpiresAt);

    const parentV2 = h.durableRuns.renewLeaseWithDatabaseClock({
      runId: h.durableRunId,
      workerId: "gateway-a",
      leaseDurationMs: 120_000,
    });
    assert.equal(parentV2?.version, 2);
    assert.throws(
      () =>
        h.assignments.appendEvents({
          registryWorkspaceId: "default",
          assignmentId: h.assignment.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 1,
          leaseTokenSha256: h.startInput.leaseTokenSha256,
          events: [statusEvent(1, REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256, 5)],
        }),
      ConflictError,
    );

    const leaseV2Token = D("heartbeat:lease:2");
    const leaseV2 = h.assignments.renewLease({
      registryWorkspaceId: "default",
      assignmentId: h.assignment.assignmentId,
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 1,
      expectedLeaseTokenSha256: h.startInput.leaseTokenSha256,
      leaseTokenSha256: leaseV2Token,
      workerSentThrough: 5,
      idempotencyKey: "heartbeat:renew:2",
    }).lease;
    assert.equal(leaseV2.parentDispatchAuthority.durableRunVersion, 2);
    assert.equal(leaseV2.parentDispatchAuthority.durableRunLeaseExpiresAt, parentV2?.leaseExpiresAt);
    assert.ok(leaseV2.expiresAt <= leaseV2.parentDispatchAuthority.durableRunLeaseExpiresAt);
    const first = h.assignments.appendEvents({
      registryWorkspaceId: "default",
      assignmentId: h.assignment.assignmentId,
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 2,
      leaseTokenSha256: leaseV2Token,
      events: [statusEvent(1, REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256, 5)],
    });
    assert.equal(first.disposition, "appended");
    assert.equal(first.workerSentThrough, 5);
    assert.equal(first.flowControl.action, "pause");

    const parentV3 = h.durableRuns.renewLeaseWithDatabaseClock({
      runId: h.durableRunId,
      workerId: "gateway-a",
      leaseDurationMs: 120_000,
    });
    assert.equal(parentV3?.version, 3);
    assert.throws(
      () =>
        h.assignments.appendEvents({
          registryWorkspaceId: "default",
          assignmentId: h.assignment.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 2,
          leaseTokenSha256: leaseV2Token,
          events: [statusEvent(2, first.events[0]!.eventSha256, 5)],
        }),
      ConflictError,
    );
    assert.throws(
      () =>
        h.assignments.renewLease({
          registryWorkspaceId: "default",
          assignmentId: h.assignment.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 2,
          expectedLeaseTokenSha256: leaseV2Token,
          leaseTokenSha256: D("heartbeat:regressed"),
          workerSentThrough: 4,
          idempotencyKey: "heartbeat:regressed",
        }),
      ConflictError,
    );

    const leaseV3Token = D("heartbeat:lease:3");
    const leaseV3 = h.assignments.renewLease({
      registryWorkspaceId: "default",
      assignmentId: h.assignment.assignmentId,
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 2,
      expectedLeaseTokenSha256: leaseV2Token,
      leaseTokenSha256: leaseV3Token,
      workerSentThrough: 5,
      idempotencyKey: "heartbeat:renew:3",
    }).lease;
    assert.equal(leaseV3.parentDispatchAuthority.durableRunVersion, 3);
    assert.ok(leaseV3.expiresAt <= leaseV3.parentDispatchAuthority.durableRunLeaseExpiresAt);
    assert.equal(
      h.assignments.appendEvents({
        registryWorkspaceId: "default",
        assignmentId: h.assignment.assignmentId,
        expectedAssignmentGeneration: 1,
        expectedLeaseRevision: 3,
        leaseTokenSha256: leaseV3Token,
        events: [statusEvent(2, first.events[0]!.eventSha256, 5)],
      }).acknowledgedThrough,
      2,
    );
  });

  it("returns exact event and settlement receipts after terminal or parent drift but rejects changed bytes", () => {
    const h = createHarness("terminal-replay");
    h.assignments.startGeneration(h.startInput);
    const event = statusEvent(1, REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256, 3);
    const appended = h.assignments.appendEvents({
      registryWorkspaceId: "default",
      assignmentId: h.assignment.assignmentId,
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 1,
      leaseTokenSha256: h.startInput.leaseTokenSha256,
      events: [event],
    });
    const settleInput = {
      registryWorkspaceId: "default",
      assignmentId: h.assignment.assignmentId,
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 1,
      origin: "worker" as const,
      leaseTokenSha256: h.startInput.leaseTokenSha256,
      outcome: "completed" as const,
      finalEventSequence: 1,
      finalEventSha256: appended.events[0]!.eventSha256,
      resultSha256: D("terminal-replay:result"),
      outputManifestSha256: commitOutputManifest(h),
      idempotencyKey: "terminal-replay:settle",
    };
    // A completed settlement is refused unless its output manifest names a committed
    // HX-506 manifest for the same generation.
    assert.throws(
      () => h.assignments.settleAssignment({ ...settleInput, outputManifestSha256: D("unbacked-manifest") }),
      ConflictError,
    );
    assert.equal(h.assignments.settleAssignment(settleInput).disposition, "settled");
    assert.ok(
      h.durableRuns.renewLeaseWithDatabaseClock({
        runId: h.durableRunId,
        workerId: "gateway-a",
        leaseDurationMs: 120_000,
      }),
    );
    const replay = h.assignments.appendEvents({
      registryWorkspaceId: "default",
      assignmentId: h.assignment.assignmentId,
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 1,
      leaseTokenSha256: h.startInput.leaseTokenSha256,
      events: [event],
    });
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.acknowledgedThrough, 1);
    assert.equal(replay.workerSentThrough, 3);
    assert.equal(h.assignments.settleAssignment(settleInput).disposition, "replayed");
    assert.throws(
      () =>
        h.assignments.appendEvents({
          registryWorkspaceId: "default",
          assignmentId: h.assignment.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 1,
          leaseTokenSha256: h.startInput.leaseTokenSha256,
          events: [statusEvent(1, REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256, 3, D("changed"))],
        }),
      ConflictError,
    );
    assert.throws(
      () => h.assignments.settleAssignment({ ...settleInput, leaseTokenSha256: D("changed-token") }),
      ConflictError,
    );
  });

  it("gateway-terminalizes a cancelled assignment after its worker dies and lease expires", async () => {
    const h = createHarness("cancel-expiry", 1);
    h.assignments.startGeneration(h.startInput);
    const control = h.assignments.requestCancellation({
      registryWorkspaceId: "default",
      assignmentId: h.assignment.assignmentId,
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 1,
      reasonCode: "operator.cancelled",
      reasonSha256: D("cancel-expiry:reason"),
      actorId: "operator-a",
      idempotencyKey: "cancel-expiry:control",
    });
    await sleep(1_150);
    const settleInput = {
      registryWorkspaceId: "default",
      assignmentId: h.assignment.assignmentId,
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 1,
      origin: "gateway_recovery" as const,
      gatewayActorId: "gateway-a",
      recoveryEvidenceSha256: control.requestSha256,
      outcome: "cancelled" as const,
      finalEventSequence: 0,
      finalEventSha256: REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
      idempotencyKey: "cancel-expiry:settle",
    };
    const settled = h.assignments.settleAssignment(settleInput);
    assert.equal(settled.disposition, "settled");
    assert.equal(settled.settlement.origin, "gateway_recovery");
    assert.equal(h.assignments.settleAssignment(settleInput).disposition, "replayed");
    assert.throws(
      () =>
        h.assignments.settleAssignment({
          ...settleInput,
          recoveryEvidenceSha256: D("changed-evidence"),
        }),
      ConflictError,
    );
    assert.throws(
      () =>
        h.assignments.settleAssignment({
          ...settleInput,
          idempotencyKey: "cancel-expiry:wrong-outcome",
          outcome: "failed",
          failureSha256: D("failure"),
        }),
      ConflictError,
    );
  });

  it("recovers only an expired current generation and fences its old token", async () => {
    const h = createHarness("recovery", 1);
    h.assignments.startGeneration(h.startInput);
    await sleep(1_150);
    const recoverInput = {
      ...h.startInput,
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 1,
      leaseTokenSha256: D("recovery:lease:2"),
      reasonCode: "lease.expired",
      reasonSha256: D("recovery:reason"),
      actorId: "gateway-a",
      idempotencyKey: "recovery:generation:2",
    };
    const recovered = h.assignments.recoverExpiredAssignment(recoverInput);
    assert.equal(recovered.disposition, "recovered");
    assert.equal(recovered.generation.assignmentGeneration, 2);
    assert.equal(recovered.abandoned.action, "generation_abandoned");
    assert.equal(h.assignments.resolveActiveAuthorityByLeaseTokenHash(h.startInput.leaseTokenSha256), undefined);
    assert.equal(
      h.assignments.resolveActiveAuthorityByLeaseTokenHash(recoverInput.leaseTokenSha256)?.generation
        .assignmentGeneration,
      2,
    );
    assert.equal(h.assignments.recoverExpiredAssignment(recoverInput).disposition, "replayed_without_lease_secret");
    assert.throws(
      () => h.assignments.recoverExpiredAssignment({ ...recoverInput, reasonSha256: D("changed") }),
      ConflictError,
    );
  });

  it("records explicit event/settlement materialization owners and replays immutable receipts", () => {
    const h = createHarness("materialization");
    h.assignments.startGeneration(h.startInput);
    const appended = h.assignments.appendEvents({
      registryWorkspaceId: "default",
      assignmentId: h.assignment.assignmentId,
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 1,
      leaseTokenSha256: h.startInput.leaseTokenSha256,
      events: [transcriptEvent(1, REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256)],
    });
    const eventInput = {
      registryWorkspaceId: "default",
      assignmentId: h.assignment.assignmentId,
      sourceKind: "event" as const,
      sourceGeneration: 1,
      sourceSequence: 1,
      sourceSha256: appended.events[0]!.eventSha256,
      targetKind: "chat_transcript" as const,
      targetId: "assistant-message-a",
      targetSha256: D("materialized-transcript"),
      targetOwnerSessionId: h.sessionId,
      targetOwnerTurnId: h.turnId,
      gatewayActorId: "gateway-a",
      idempotencyKey: "materialization:event",
    };
    const eventReceipt = h.assignments.recordMaterialization(eventInput);
    assert.equal(eventReceipt.disposition, "recorded");
    assert.equal(h.assignments.recordMaterialization(eventInput).disposition, "replayed");
    assert.throws(
      () => h.assignments.recordMaterialization({ ...eventInput, targetSha256: D("changed-target") }),
      ConflictError,
    );

    const settled = h.assignments.settleAssignment({
      registryWorkspaceId: "default",
      assignmentId: h.assignment.assignmentId,
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 1,
      origin: "worker",
      leaseTokenSha256: h.startInput.leaseTokenSha256,
      outcome: "completed",
      finalEventSequence: 1,
      finalEventSha256: appended.events[0]!.eventSha256,
      resultSha256: D("materialization:result"),
      outputManifestSha256: commitOutputManifest(h),
      idempotencyKey: "materialization:settle",
    });
    const settlementInput = {
      registryWorkspaceId: "default",
      assignmentId: h.assignment.assignmentId,
      sourceKind: "settlement" as const,
      sourceGeneration: 1,
      sourceSha256: settled.settlement.requestSha256,
      targetKind: "durable_run_result" as const,
      targetId: h.durableRunId,
      targetSha256: D("durable-result"),
      targetOwnerDurableRunId: h.durableRunId,
      gatewayActorId: "gateway-a",
      idempotencyKey: "materialization:settlement",
    };
    const settlementReceipt = h.assignments.recordMaterialization(settlementInput);
    assert.equal(settlementReceipt.disposition, "recorded");
    assert.notEqual(settlementReceipt.materialization.receiptSha256, settlementReceipt.materialization.requestSha256);
    assert.equal(h.assignments.recordMaterialization(settlementInput).disposition, "replayed");
    assert.throws(
      () =>
        h.assignments.recordMaterialization({
          ...settlementInput,
          targetOwnerDurableRunId: "wrong-run",
          idempotencyKey: "materialization:wrong-owner",
        }),
      ConflictError,
    );
  });

  it("enforces immutable seven-ledger rows and direct-SQL sent-through guards", () => {
    const h = createHarness("sql-guards", 60, 131_072);
    h.assignments.startGeneration(h.startInput);
    assert.throws(() =>
      h.db
        .prepare(
          "UPDATE remote_worker_assignments SET created_by_actor_id = 'tampered' WHERE assignment_id = @assignmentId",
        )
        .run({ assignmentId: h.assignment.assignmentId }),
    );
    assert.throws(() =>
      h.db
        .prepare(
          `INSERT INTO remote_worker_assignment_events (
             registry_workspace_id, assignment_id, assignment_generation, sequence, event_id,
             event_type, payload_json, payload_sha256, previous_event_sha256, event_sha256,
             worker_sent_through, received_at
           ) VALUES (
             'default', @assignmentId, 1, 1, 'bad-watermark', 'status', @payloadJson, @payloadSha256,
             @genesis, @eventSha256, 0, @receivedAt
           )`,
        )
        .run({
          assignmentId: h.assignment.assignmentId,
          payloadJson: canonicalJsonString({
            schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
            phase: "running",
            statusSha256: D("bad"),
          }),
          payloadSha256: D("not-relevant"),
          genesis: REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
          eventSha256: D("bad-event"),
          receivedAt: h.durableRuns.readDatabaseNow(),
        }),
    );

    const missingManifestField = { ...h.manifest } as Record<string, unknown>;
    delete missingManifestField.maxEventBytes;
    const missingManifestJson = canonicalJsonString(missingManifestField);
    assert.throws(() =>
      h.db
        .prepare(
          `INSERT INTO remote_worker_assignments (
             registry_workspace_id, assignment_id, execution_workspace_id, durable_run_id, task_id,
             session_id, turn_id, manifest_json, manifest_sha256, created_by_actor_id,
             idempotency_key, request_sha256, created_at
           ) VALUES (
             'default', 'assignment-missing-manifest-field', 'default', @durableRunId, @taskId,
             @sessionId, @turnId, @manifestJson, @manifestSha256, 'gateway-a',
             'assignment:missing-manifest-field', @requestSha256, @createdAt
           )`,
        )
        .run({
          durableRunId: h.durableRunId,
          taskId: h.taskId,
          sessionId: h.sessionId,
          turnId: h.turnId,
          manifestJson: missingManifestJson,
          manifestSha256: D(missingManifestJson),
          requestSha256: D("assignment:missing-manifest-field"),
          createdAt: h.durableRuns.readDatabaseNow(),
        }),
    );

    assertDirectEventRejected(h, "terminal-negative", "terminal_output", {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
      stream: "stdout",
      chunkSha256: D("terminal-negative"),
      byteLength: -1,
    });
    assertDirectEventRejected(h, "terminal-text", "terminal_output", {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
      stream: "stdout",
      chunkSha256: D("terminal-text"),
      byteLength: "1",
    });
    assertDirectEventRejected(h, "terminal-oversize", "terminal_output", {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
      stream: "stderr",
      chunkSha256: D("terminal-oversize"),
      byteLength: 65_537,
    });
    assertDirectEventRejected(h, "transcript-non-text", "transcript_delta", {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
      role: "assistant",
      text: 7,
    });
    assertDirectEventRejected(h, "status-missing-digest", "status", {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
      phase: "running",
    });
    assertDirectEventRejected(
      h,
      "watermark-over-manifest",
      "status",
      {
        schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
        phase: "running",
        statusSha256: D("watermark-over-manifest"),
      },
      101,
    );
  });
});
