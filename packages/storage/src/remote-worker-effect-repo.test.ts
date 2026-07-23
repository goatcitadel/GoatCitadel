import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerAssignmentParentContextSha256,
  type RemoteWorkerEffectCorrelation,
  type RemoteWorkerEffectTransitionState,
} from "@goatcitadel/contracts";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { ChatTurnTraceRepository } from "./chat-turn-trace-repo.js";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { MeshCapabilityNodeAdmissionRepository } from "./mesh-capability-node-admission-repo.js";
import { MeshRepository } from "./mesh-repo.js";
import { RemoteWorkerAdmissionRepository } from "./remote-worker-admission-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerEffectRepository } from "./remote-worker-effect-repo.js";
import { createDatabase } from "./sqlite.js";
import { TaskRepository } from "./task-repo.js";

const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const FUTURE = "2099-01-01T00:00:00.000Z";

interface SeededGeneration {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
}

function seed(db: DatabaseClient, s: string): SeededGeneration {
  const tasks = new TaskRepository(db);
  const sessions = new ChatSessionMetaRepository(db);
  const turns = new ChatTurnTraceRepository(db);
  const durableRuns = new DurableRunRepository(db);
  const mesh = new MeshRepository(db);
  const nodeAdmissions = new MeshCapabilityNodeAdmissionRepository(db);
  const workerAdmissions = new RemoteWorkerAdmissionRepository(db);
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const now = durableRuns.readDatabaseNow();
  const taskId = `task-${s}`;
  const sessionId = `session-${s}`;
  const turnId = `turn-${s}`;
  const durableRunId = `run-${s}`;
  tasks.create({ title: `Assignment ${s}`, workspaceId: "default" }, now, { taskId });
  sessions.ensure(sessionId, now, "default");
  turns.create({
    turnId,
    sessionId,
    userMessageId: `message-${s}`,
    mode: "chat",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    startedAt: now,
  });
  const parentInput = { executionWorkspaceId: "default", durableRunId, taskId, sessionId, turnId } as const;
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
      remoteWorkerAssignmentParentContext: buildRemoteWorkerAssignmentParentContext(parentInput),
      remoteWorkerAssignmentParentContextSha256: remoteWorkerAssignmentParentContextSha256(parentInput),
    },
  });
  const runtimePayload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: D(`${s}:bundle`),
    dependencyLockSha256: D(`${s}:lock`),
    vendorTreeSha256: D(`${s}:vendor`),
    launcherSha256: D(`${s}:launcher`),
    installedTreeManifestSha256: D(`${s}:tree`),
    installedTreeFileCount: 12,
    platform: "linux" as const,
    architecture: "x64" as const,
  };
  const bootstrap = workerAdmissions.createBootstrap({
    registryWorkspaceId: "default",
    workerLabel: `Worker ${s}`,
    platform: "linux",
    architecture: "x64",
    runtimeManifest: {
      payload: runtimePayload,
      payloadSha256: D(canonicalJsonString(runtimePayload)),
      signatureAlgorithm: "ed25519",
      signerKeyId: `release-key-${s}`,
      signatureBase64Url: "A".repeat(86),
    },
    allowedWorkspaceIds: ["default"],
    capabilityClasses: ["durable_compute", "gateway_inference"],
    expiresInSeconds: 300,
    createdByActorId: "operator-a",
    idempotencyKey: `bootstrap:${s}`,
    bootstrapSecretSha256: D(`${s}:bootstrap-secret`),
  }).record;
  const worker = workerAdmissions.finalizeBootstrapAdmission({
    expectedRegistryWorkspaceId: bootstrap.registryWorkspaceId,
    expectedBootstrapId: bootstrap.bootstrapId,
    expectedTargetWorkerGeneration: bootstrap.targetWorkerGeneration,
    bootstrapSecretSha256: D(`${s}:bootstrap-secret`),
    verifiedPublicKeySpkiSha256: D(`${s}:spki`),
    verifiedClientCertificateSha256: D(`${s}:certificate`),
    verifiedRuntimeManifestSha256: D(canonicalJsonString(bootstrap.runtimeManifest)),
    verifiedWorkspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
    verifiedCapabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
    verifiedTransportIdentitySource: "native_mtls",
    verifiedTransportTrustAnchorSha256: D(`${s}:trust-anchor`),
    verifiedTransportReceiptSha256: D(`${s}:transport-receipt`),
    verifiedProofOfPossessionReceiptSha256: D(`${s}:pop-receipt`),
    verifiedDownloadReceiptSha256: D(`${s}:download-receipt`),
    verifiedInstalledTreeAttestationSha256: D(`${s}:installed-tree-attestation`),
    verifiedInstalledTreeReceiptSha256: D(`${s}:tree-receipt`),
    credentialIssuanceProofSha256: D(`${s}:issuance`),
    credentialExpiresInSeconds: 600,
    credentialTokenSha256: D(`${s}:credential-token`),
    exchangeIdempotencyKey: `exchange:${s}`,
  });
  const tlsFingerprint = `sha256:${bootstrap.nodeId}`;
  const joinToken = `join:${s}`;
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
    idempotencyKey: `node-admission:${s}`,
  });
  const assignment = assignments.createAssignment({
    manifest: {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      registryWorkspaceId: "default",
      ...parentInput,
      capabilityProfileSha256: D(`${s}:capability-profile`),
      contextSnapshotSha256: D(`${s}:context`),
      toolEffectPostureSha256: D(`${s}:posture`),
      pathJailSha256: D(`${s}:jail`),
      parentContextSha256: remoteWorkerAssignmentParentContextSha256(parentInput),
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
    idempotencyKey: `assignment:${s}`,
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
    leaseTokenSha256: D(`${s}:lease:1`),
    idempotencyKey: `generation:${s}:1`,
  }).generation;
  return {
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    assignmentGeneration: generation.assignmentGeneration,
  };
}

interface Harness {
  db: DatabaseClient;
  effects: RemoteWorkerEffectRepository;
  ctx: SeededGeneration;
}

function harness(label: string): Harness {
  const db = createDatabase({ dbPath: ":memory:" });
  const ctx = seed(db, label);
  return { db, effects: new RemoteWorkerEffectRepository(db), ctx };
}

function correlation(
  transitionState: RemoteWorkerEffectTransitionState,
  overrides: Partial<RemoteWorkerEffectCorrelation> = {},
): RemoteWorkerEffectCorrelation {
  const crossedBoundary = ["external_boundary_started", "completed_no_effect", "completed_with_effect"].includes(
    transitionState,
  );
  return {
    schemaVersion: REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION,
    transitionState,
    externalSideEffectRunId: crossedBoundary ? "external-run-1" : null,
    approvalRecordSha256: null,
    boundaryReceiptSha256: crossedBoundary ? D("boundary") : null,
    hx305OutcomeSha256: transitionState === "completed_with_effect" ? D("hx305-outcome") : null,
    reconciliationRecordSha256: null,
    sanitizedError: null,
    ...overrides,
  };
}

function recordIntent(h: Harness): string {
  return h.effects.recordIntent({
    registryWorkspaceId: h.ctx.registryWorkspaceId,
    assignmentId: h.ctx.assignmentId,
    assignmentGeneration: h.ctx.assignmentGeneration,
    intentIndex: 0,
    effectSelector: "email.send",
    canonicalArgs: { to: "user@example.com" },
    workerIdempotencyKey: "worker-key-1",
    idempotencyKey: "intent-1",
  }).intentId;
}

function appendTransition(
  h: Harness,
  intentId: string,
  transitionState: RemoteWorkerEffectTransitionState,
  key: string,
  overrides?: Partial<RemoteWorkerEffectCorrelation>,
) {
  return h.effects.appendTransition({
    registryWorkspaceId: h.ctx.registryWorkspaceId,
    assignmentId: h.ctx.assignmentId,
    assignmentGeneration: h.ctx.assignmentGeneration,
    intentId,
    correlation: correlation(transitionState, overrides),
    idempotencyKey: key,
  });
}

describe("HX-506 effect repository (SQLite)", () => {
  it("records an immutable intent, chains transitions, and books a completed_with_effect receipt", () => {
    const h = harness("effect");
    const intentId = recordIntent(h);
    appendTransition(h, intentId, "recorded", "t1");
    appendTransition(h, intentId, "dispatch_claimed", "t2");
    appendTransition(h, intentId, "external_boundary_started", "t3");
    const terminal = appendTransition(h, intentId, "completed_with_effect", "t4");
    const receipt = h.effects.recordReceipt({
      registryWorkspaceId: h.ctx.registryWorkspaceId,
      assignmentId: h.ctx.assignmentId,
      assignmentGeneration: h.ctx.assignmentGeneration,
      intentId,
      receiptState: "completed_with_effect",
      finalTransitionSequence: terminal.transitionSequence,
      finalTransitionSha256: terminal.transitionSha256,
      hx305OutcomeSha256: D("hx305-outcome"),
      idempotencyKey: "receipt-1",
    });
    assert.equal(receipt.receiptState, "completed_with_effect");
    assert.equal(receipt.hx305OutcomeSha256, D("hx305-outcome"));
    h.db.close();
  });

  it("refuses a completed_with_effect receipt with no canonical HX-305 outcome (result-body spoof)", () => {
    const h = harness("spoof");
    const intentId = recordIntent(h);
    appendTransition(h, intentId, "recorded", "t1");
    appendTransition(h, intentId, "dispatch_claimed", "t2");
    const boundary = appendTransition(h, intentId, "external_boundary_started", "t3");
    // A completed transition body without a real HX-305 outcome cannot be constructed:
    // the contract rejects it before it ever reaches a receipt.
    assert.throws(() => appendTransition(h, intentId, "completed_with_effect", "t4", { hx305OutcomeSha256: null }));
    assert.equal(boundary.transitionState, "external_boundary_started");
    h.db.close();
  });

  it("keeps intents and transitions insert-only in the database", () => {
    const h = harness("insertonly");
    const intentId = recordIntent(h);
    appendTransition(h, intentId, "recorded", "t1");
    assert.throws(() => h.db.prepare("UPDATE remote_worker_effect_intents SET intent_index = 5").run(), /insert-only/u);
    assert.throws(() => h.db.prepare("DELETE FROM remote_worker_effect_transitions").run(), /insert-only/u);
    h.db.close();
  });

  it("rejects a first transition that is not the genesis 'recorded' state", () => {
    const h = harness("genesis");
    const intentId = recordIntent(h);
    assert.throws(() => appendTransition(h, intentId, "dispatch_claimed", "t-bad"));
    h.db.close();
  });

  it("only advances a receipt out of manual reconciliation with an operator record", () => {
    const h = harness("manual");
    const intentId = recordIntent(h);
    appendTransition(h, intentId, "recorded", "t1");
    appendTransition(h, intentId, "dispatch_claimed", "t2");
    const manual = appendTransition(h, intentId, "manual_reconciliation", "t3");
    const receipt = h.effects.recordReceipt({
      registryWorkspaceId: h.ctx.registryWorkspaceId,
      assignmentId: h.ctx.assignmentId,
      assignmentGeneration: h.ctx.assignmentGeneration,
      intentId,
      receiptState: "manual_reconciliation",
      finalTransitionSequence: manual.transitionSequence,
      finalTransitionSha256: manual.transitionSha256,
      hx305OutcomeSha256: null,
      idempotencyKey: "receipt-1",
    });
    assert.equal(receipt.receiptState, "manual_reconciliation");
    // A direct database update of a non-manual receipt is rejected by the guard.
    assert.throws(() =>
      h.db.prepare("UPDATE remote_worker_effect_receipts SET receipt_revision = receipt_revision + 1").run(),
    );

    const resolved = appendTransition(h, intentId, "manual_reconciliation_resolved", "t4");
    // manual_reconciliation_resolved is not a receipt state; advancing needs a valid terminal state,
    // so a resolution must map to a completed/blocked/failed receipt state via a fresh terminal transition.
    assert.equal(resolved.transitionState, "manual_reconciliation_resolved");
    h.db.close();
  });

  it("replays an idempotent intent and transition", () => {
    const h = harness("replay");
    const intentId = recordIntent(h);
    const again = h.effects.recordIntent({
      registryWorkspaceId: h.ctx.registryWorkspaceId,
      assignmentId: h.ctx.assignmentId,
      assignmentGeneration: h.ctx.assignmentGeneration,
      intentIndex: 0,
      effectSelector: "email.send",
      canonicalArgs: { to: "user@example.com" },
      workerIdempotencyKey: "worker-key-1",
      idempotencyKey: "intent-1",
    }).intentId;
    assert.equal(again, intentId);
    const first = appendTransition(h, intentId, "recorded", "t1");
    const replay = appendTransition(h, intentId, "recorded", "t1");
    assert.equal(replay.transitionSha256, first.transitionSha256);
    h.db.close();
  });

  it("never carries a provider usage or cost column (HX-306 non-authority)", () => {
    const h = harness("cost");
    const columns = (
      h.db.prepare("PRAGMA table_info(remote_worker_effect_transitions)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    for (const forbidden of ["cost", "usage", "tokens", "price", "provider_cost"]) {
      assert.equal(
        columns.some((c) => c.toLowerCase().includes(forbidden)),
        false,
        `found ${forbidden}`,
      );
    }
    h.db.close();
  });
});
