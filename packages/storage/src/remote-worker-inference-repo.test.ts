import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerAssignmentParentContextSha256,
  type RemoteWorkerInferenceGovernanceReceipt,
  type RemoteWorkerInferenceRequestSubmission,
} from "@goatcitadel/contracts";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { ChatTurnTraceRepository } from "./chat-turn-trace-repo.js";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { MeshCapabilityNodeAdmissionRepository } from "./mesh-capability-node-admission-repo.js";
import { MeshRepository } from "./mesh-repo.js";
import { RemoteWorkerAdmissionRepository } from "./remote-worker-admission-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerInferenceRepository } from "./remote-worker-inference-repo.js";
import { createDatabase } from "./sqlite.js";
import { TaskRepository } from "./task-repo.js";

const clients: DatabaseClient[] = [];
const FUTURE = "2099-01-01T00:00:00.000Z";
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

interface SeededAuthority {
  db: DatabaseClient;
  repo: RemoteWorkerInferenceRepository;
  assignmentId: string;
  assignmentGeneration: number;
  workerId: string;
  workerGeneration: number;
  sessionId: string;
  turnId: string;
  now: string;
}

function seedAuthority(seed: string): SeededAuthority {
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
    platform: "windows" as const,
    architecture: "x64" as const,
  };
  const bootstrap = workerAdmissions.createBootstrap({
    registryWorkspaceId: "default",
    workerLabel: `Worker ${seed}`,
    platform: "windows",
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
    db,
    repo: new RemoteWorkerInferenceRepository(db),
    assignmentId: assignment.assignmentId,
    assignmentGeneration: generation.assignmentGeneration,
    workerId: worker.generation.workerId,
    workerGeneration: worker.generation.workerGeneration,
    sessionId,
    turnId,
    now,
  };
}

function submissionFor(
  a: SeededAuthority,
  overrides: Partial<RemoteWorkerInferenceRequestSubmission> = {},
): RemoteWorkerInferenceRequestSubmission {
  return {
    registryWorkspaceId: "default",
    assignmentId: a.assignmentId,
    assignmentGeneration: a.assignmentGeneration,
    inferenceRequestId: "inference-1",
    attempt: 1,
    idempotencyKey: "inference:idem:1",
    leaseToken: "seed:lease:1",
    messages: [{ role: "user", text: "Hello." }],
    inputSha256: D("input"),
    contextSha256: D("context"),
    modelIntentSha256: D("intent"),
    outputTokenCeiling: 4096,
    reasoningTokenCeiling: 1024,
    temperatureMilli: 700,
    ...overrides,
  };
}

function governanceReceipt(
  decision: RemoteWorkerInferenceGovernanceReceipt["decision"] = "allowed",
): RemoteWorkerInferenceGovernanceReceipt {
  return {
    schemaVersion: REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
    decision,
    effectiveRouteSha256: D("route"),
    policyRevision: 4,
    policySha256: D("policy"),
    ...(decision === "approval_required" ? { approvalReceiptSha256: D("approval") } : {}),
    outputTokenCeiling: 4096,
    reasoningTokenCeiling: 1024,
    expiresAt: FUTURE,
  };
}

function admissionFor(
  a: SeededAuthority,
  overrides: Partial<RemoteWorkerInferenceRequestSubmission> = {},
  decision: RemoteWorkerInferenceGovernanceReceipt["decision"] = "allowed",
) {
  return {
    submission: submissionFor(a, overrides),
    workerId: a.workerId,
    workerGeneration: a.workerGeneration,
    sessionId: a.sessionId,
    turnId: a.turnId,
    capabilityProfileSha256: D("capability-profile"),
    routedContextSha256: D("routed-context"),
    operationId: "operation-1",
    dispatchGeneration: "dispatch-generation-1",
    governance: governanceReceipt(decision),
    budgetReservationId: "reservation-1",
    admittedAt: a.now,
  };
}

function keyFor(a: SeededAuthority, inferenceRequestId = "inference-1", attempt = 1) {
  return {
    registryWorkspaceId: "default",
    assignmentId: a.assignmentId,
    assignmentGeneration: a.assignmentGeneration,
    inferenceRequestId,
    attempt,
  };
}

function claimInputFor(a: SeededAuthority, owner: string, key = keyFor(a)) {
  return {
    ...key,
    dispatchClaimOwner: owner,
    effectiveProviderId: "anthropic",
    effectiveModelId: "claude-opus-4",
    usageIntentEventId: `usage-intent-${owner}`,
    dispatchLeaseExpiresAt: FUTURE,
    now: a.now,
  };
}

describe("RemoteWorkerInferenceRepository SQLite", () => {
  it("admits, exactly replays, and conflicts on changed canonical bytes", () => {
    const a = seedAuthority("admit");
    const created = a.repo.admitOrReplay(admissionFor(a));
    assert.equal(created.disposition, "created");
    assert.equal(created.request.state, "admitted");
    assert.equal(created.request.accountingDisposition, undefined);

    const replay = a.repo.admitOrReplay(admissionFor(a));
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.request.requestSha256, created.request.requestSha256);

    assert.throws(() => a.repo.admitOrReplay(admissionFor(a, { temperatureMilli: 701 })), /replay does not match/u);
  });

  it("derives the initial state from the governance decision", () => {
    const a = seedAuthority("gov");
    const waiting = a.repo.admitOrReplay(
      admissionFor(a, { idempotencyKey: "w", inferenceRequestId: "w" }, "approval_required"),
    );
    assert.equal(waiting.request.state, "waiting_approval");
    const admitted = a.repo.resolveApproval(keyFor(a, "w"), "admitted", a.now);
    assert.equal(admitted?.state, "admitted");

    const denied = a.repo.admitOrReplay(admissionFor(a, { idempotencyKey: "d", inferenceRequestId: "d" }, "denied"));
    assert.equal(denied.request.state, "blocked");
  });

  it("lets exactly one dispatch claimant win", () => {
    const a = seedAuthority("claim");
    a.repo.admitOrReplay(admissionFor(a));
    const first = a.repo.claimDispatch(claimInputFor(a, "owner-a"));
    const second = a.repo.claimDispatch(claimInputFor(a, "owner-b"));
    assert.ok(first);
    assert.equal(first.state, "dispatch_claimed");
    assert.equal(first.dispatchClaimOwner, "owner-a");
    assert.equal(first.accountingDisposition, "delegated");
    assert.equal(second, undefined);
  });

  it("appends hash-chained frames, enforces output bounds, and finalizes an immutable terminal", () => {
    const a = seedAuthority("stream");
    a.repo.admitOrReplay(admissionFor(a));
    a.repo.claimDispatch(claimInputFor(a, "owner-a"));

    const frame1 = a.repo.appendOutputFrame({
      ...keyFor(a),
      dispatchClaimOwner: "owner-a",
      text: "Hello ",
      now: a.now,
    });
    const frame2 = a.repo.appendOutputFrame({ ...keyFor(a), dispatchClaimOwner: "owner-a", text: "world", now: a.now });
    assert.equal(frame1.frame.frameSequence, 1);
    assert.equal(frame2.frame.frameSequence, 2);
    assert.equal(frame2.frame.previousFrameSha256, frame1.frame.frameSha256);
    assert.equal(frame2.request.state, "streaming");
    assert.equal(frame2.request.outputFrameCount, 2);

    // A non-claimant cannot append.
    assert.throws(
      () => a.repo.appendOutputFrame({ ...keyFor(a), dispatchClaimOwner: "intruder", text: "x", now: a.now }),
      /claim owner mismatch/u,
    );

    const finalized = a.repo.finalizeTerminal({
      ...keyFor(a),
      dispatchClaimOwner: "owner-a",
      terminalState: "completed",
      usageTerminalEventId: "usage-terminal-1",
      now: a.now,
    });
    assert.equal(finalized.state, "completed");
    assert.equal(finalized.terminalFrameSequence, 3);
    assert.equal(finalized.usageTerminalEventId, "usage-terminal-1");
    assert.equal(finalized.accountingDisposition, "settled");

    // Terminal is immutable: a raw state change is rejected by the trigger.
    assert.throws(
      () =>
        a.db
          .prepare(
            "UPDATE remote_worker_inference_requests SET state = 'failed' WHERE inference_request_id = 'inference-1'",
          )
          .run(),
      /immutable/u,
    );
    // But acknowledgement still advances.
    const acked = a.repo.acknowledge(keyFor(a), 3, a.now);
    assert.equal(acked.workerAcknowledgedThrough, 3);
  });

  it("rejects out-of-order and mutated outbox frames at the database", () => {
    const a = seedAuthority("outbox");
    a.repo.admitOrReplay(admissionFor(a));
    a.repo.claimDispatch(claimInputFor(a, "owner-a"));
    const frame = a.repo.appendOutputFrame({ ...keyFor(a), dispatchClaimOwner: "owner-a", text: "hi", now: a.now });

    // Append-only: no update, no delete.
    assert.throws(
      () =>
        a.db.prepare("UPDATE remote_worker_inference_outbox SET frame_char_count = 9 WHERE frame_sequence = 1").run(),
      /append-only/u,
    );
    assert.throws(
      () => a.db.prepare("DELETE FROM remote_worker_inference_outbox WHERE frame_sequence = 1").run(),
      /append-only/u,
    );

    // Out-of-order raw insert is rejected by the chain guard.
    assert.throws(
      () =>
        a.db
          .prepare(
            `INSERT INTO remote_worker_inference_outbox (
               registry_workspace_id, assignment_id, assignment_generation, inference_request_id, attempt,
               frame_sequence, frame_kind, payload_json, payload_sha256, previous_frame_sha256, frame_sha256,
               effective_route_sha256, usage_event_id, frame_char_count, created_at
             ) VALUES ('default', @assignmentId, @gen, 'inference-1', 1, 5, 'output_text',
               '{"schemaVersion":"goatcitadel.remote-worker-inference-frame.v1","kind":"output_text","text":"x"}',
               @payload, @prev, @self, @route, NULL, 1, @now)`,
          )
          .run({
            assignmentId: a.assignmentId,
            gen: a.assignmentGeneration,
            payload: D("p"),
            prev: frame.frame.frameSha256,
            self: D("s"),
            route: D("route"),
            now: a.now,
          }),
      /out of order/u,
    );
  });

  it("bounds acknowledgement to delivered frames and forbids regression", () => {
    const a = seedAuthority("ack");
    a.repo.admitOrReplay(admissionFor(a));
    a.repo.claimDispatch(claimInputFor(a, "owner-a"));
    a.repo.appendOutputFrame({ ...keyFor(a), dispatchClaimOwner: "owner-a", text: "one", now: a.now });
    assert.throws(() => a.repo.acknowledge(keyFor(a), 5, a.now), /cannot exceed/u);
    a.repo.acknowledge(keyFor(a), 1, a.now);
    assert.throws(() => a.repo.acknowledge(keyFor(a), 0, a.now), /cannot regress/u);
  });

  it("marks dispatch_unknown without a terminal frame and blocks late finalization", () => {
    const a = seedAuthority("unknown");
    a.repo.admitOrReplay(admissionFor(a));
    a.repo.claimDispatch(claimInputFor(a, "owner-a"));
    const unknown = a.repo.markDispatchUnknown(keyFor(a), { dispatchClaimOwner: "owner-a", now: a.now });
    assert.equal(unknown.state, "dispatch_unknown");
    assert.equal(unknown.accountingDisposition, "unknown");
    assert.equal(unknown.terminalFrameSequence, undefined);
    assert.throws(
      () =>
        a.repo.finalizeTerminal({
          ...keyFor(a),
          dispatchClaimOwner: "owner-a",
          terminalState: "completed",
          now: a.now,
        }),
      /cannot terminate from state dispatch_unknown/u,
    );
  });

  it("replays durable outbox frames strictly after the acknowledgement watermark", () => {
    const a = seedAuthority("replay");
    a.repo.admitOrReplay(admissionFor(a));
    a.repo.claimDispatch(claimInputFor(a, "owner-a"));
    a.repo.appendOutputFrame({ ...keyFor(a), dispatchClaimOwner: "owner-a", text: "a", now: a.now });
    a.repo.appendOutputFrame({ ...keyFor(a), dispatchClaimOwner: "owner-a", text: "b", now: a.now });
    a.repo.acknowledge(keyFor(a), 1, a.now);
    const pending = a.repo.listFramesAfter(keyFor(a), 1);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.frameSequence, 2);
    // A fresh repository instance over the same durable rows replays identically.
    const restarted = new RemoteWorkerInferenceRepository(a.db);
    assert.deepEqual(
      restarted.listFramesAfter(keyFor(a), 1).map((frame) => frame.frameSequence),
      [2],
    );
  });
});
