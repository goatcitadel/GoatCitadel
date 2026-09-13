import assert from "node:assert/strict";
import {
  REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_DISPATCH_AUTHORITY_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
  REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
  canonicalJsonString,
  remoteWorkerAssignmentCanonicalSha256 as digest,
  type StartRemoteWorkerAssignmentGenerationCommand,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ApprovalRepository } from "./approval-repo.js";
import { ApprovalEffectRepository } from "./approval-effect-repo.js";
import { ChatToolRunRepository } from "./chat-tool-run-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { PendingApprovalActionRepository } from "./pending-approval-action-repo.js";
import { RemoteWorkerEffectRepository } from "./remote-worker-effect-repo.js";
import { RemoteWorkerAssignmentRepository, type RemoteWorkerAssignmentProtectedCommitFence } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerChatResumeLedger } from "./remote-worker-chat-resume-ledger.js";
import { prepareChatOfferFixture } from "./remote-worker-chat-offer-fixture.js";
import { RemoteWorkerChatContextRepository } from "./remote-worker-chat-context-repo.js";
import { verifyWorkerChatResumeRecovery } from "./remote-worker-chat-resume-recovery-fixture.js";

/** Storage-boundary proof shared by SQLite and actual PostgreSQL. The full
 * Gateway seal/finalizer and native transport journeys have separate owners. */
export async function verifyWorkerChatApprovalResume(
  db: DatabaseClient,
  seed: string,
  worker: Pick<StartRemoteWorkerAssignmentGenerationCommand,
    "workerId" | "workerGeneration" | "nodeId" | "nodeAdmissionGeneration">,
  fence?: RemoteWorkerAssignmentProtectedCommitFence,
  decision: "approve" | "reject" | "edit" = "approve",
): Promise<void> {
  const runs = new DurableRunRepository(db);
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const ledger = new RemoteWorkerChatResumeLedger(db);
  const effects = new RemoteWorkerEffectRepository(db);
  const approvals = new ApprovalRepository(db);
  const pendingActions = new PendingApprovalActionRepository(db);
  const approvalEffects = new ApprovalEffectRepository(db);
  const tools = new ChatToolRunRepository(db);
  const prepared = prepareChatOfferFixture(db, true, `-resume-${seed}`);
  const assignment = assignments.createAssignment({ ...prepared.legacyCommand,
    manifest: { ...prepared.legacyCommand.manifest, leaseTtlSeconds: 1,
      contextSnapshotSha256: new RemoteWorkerChatContextRepository(db).findForRun(prepared.durableRunId)!.contextSha256,
      requiredCapabilityClasses: ["durable_compute", "gateway_inference"] },
  }).assignment;
  const token = digest(`resume-token:${seed}`);
  const { generation, lease } = assignments.startGeneration({
    registryWorkspaceId: "default", assignmentId: assignment.assignmentId,
    workerId: worker.workerId, workerGeneration: worker.workerGeneration,
    nodeId: worker.nodeId, nodeAdmissionGeneration: worker.nodeAdmissionGeneration,
    dispatchOwnerId: prepared.offerInput.dispatchOwnerId, durableRunAttempt: prepared.offerInput.durableRunAttempt,
    leaseTokenSha256: token, idempotencyKey: `resume-generation:${seed}`,
  });
  const ref = { registryWorkspaceId: "default", assignmentId: assignment.assignmentId, assignmentGeneration: generation.assignmentGeneration };
  const args = { path: "note.txt" };
  const intent = effects.recordNextIntent({ ...ref, effectSelector: "fs.read", canonicalArgs: args,
    workerIdempotencyKey: `resume-tool:${seed}`, idempotencyKey: `resume-tool:${seed}` });
  const approvalId = `resume-approval:${seed}`;
  const manifest = assignment.manifest;
  approvals.createDeterministicDetachedWithTtlDuration({
    approvalId, kind: "tool.invoke", riskLevel: "caution", payload: {}, preview: {},
    linkage: { workspaceId: manifest.executionWorkspaceId, sessionId: manifest.sessionId,
      turnId: manifest.turnId, runId: manifest.durableRunId, toolName: "fs.read" },
  }, 300_000);
  const originalApproval = approvals.get(approvalId);
  const baseCorrelation = {
    schemaVersion: REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION,
    externalSideEffectRunId: null, approvalRecordSha256: null, boundaryReceiptSha256: null,
    hx305OutcomeSha256: null, reconciliationRecordSha256: null, sanitizedError: null,
  };
  effects.appendTransition({ ...ref, intentId: intent.intentId, idempotencyKey: `recorded:${seed}`,
    correlation: { ...baseCorrelation, transitionState: "recorded" } });
  effects.appendTransition({ ...ref, intentId: intent.intentId, idempotencyKey: `waiting:${seed}`,
    correlation: { ...baseCorrelation, transitionState: "approval_wait", approvalRecordSha256: digest(originalApproval) } });
  tools.create({ toolRunId: `remote-tool:${intent.intentId}`, sessionId: manifest.sessionId!, turnId: manifest.turnId!,
    toolName: "fs.read", args, status: "approval_required", approvalId });
  pendingActions.upsertPending({ approvalId, actionType: "tool.invoke", createdAt: runs.readDatabaseNow(),
    request: { toolName: "fs.read", args, workspaceId: manifest.executionWorkspaceId,
      sessionId: manifest.sessionId, turnId: manifest.turnId, runId: manifest.durableRunId, agentId: "assistant" } });
  const run = runs.getRun(manifest.durableRunId);
  const waitForEvent = { eventKey: "approval.resolved", correlationId: approvalId };
  const material = { runId: run.runId, turnId: manifest.turnId, transitionKind: "waiting",
    durableStatus: "waiting", traceStatus: "waiting_for_approval", waitForEvent };
  const seal = { material, materialSha256: digest(material) };
  const waiting = runs.updateRun({ runId: run.runId, status: "waiting", clearLease: true, expectedVersion: run.version,
    metadata: { ...run.metadata, waitForEvent, chatTurnRuntimeAuthority: seal } });
  const checkpoint = runs.createCheckpoint({ runId: run.runId, checkpointKind: "run_waiting",
    state: { waitForEvent, chatTurnRuntimeAuthority: seal } });
  const wakeInput = { registryWorkspaceId: "default", assignmentId: assignment.assignmentId, approvalId,
    expectedParentVersion: waiting.version, waitingCheckpointId: checkpoint.checkpointId,
    waitingRuntimeAuthoritySha256: seal.materialSha256 };
  assert.throws(() => assignments.recordChatApprovalResumeWake(wakeInput), /resume/);
  const resolved = approvals.resolve(approvalId, { decision, resolvedBy: "operator-a" });
  assert.throws(() => assignments.recordChatApprovalResumeWake(wakeInput), /resume/);
  if (decision !== "approve") pendingActions.markResolved(approvalId, "rejected", { decision });
  const pending = pendingActions.find(approvalId)!;
  const handoff = assignments.prepareChatApprovalResumeHandoff(wakeInput);
  assert.equal(handoff.intentId, intent.intentId);
  assert.equal(handoff.pendingActionSha256, digest(pending));
  assert.equal(ledger.readLatest(ref.registryWorkspaceId, ref.assignmentId, ref.assignmentGeneration), undefined);
  const observation = { ...ref, expectedAssignmentGeneration: ref.assignmentGeneration,
    expectedLeaseRevision: lease.leaseRevision, leaseTokenSha256: token };
  if (fence) assert.equal(assignments.resolveChatApprovalResumeByLeaseTokenHash(observation, fence), undefined);
  if (decision === "approve") {
    const action = approvalEffects.upsert({ approvalId, effectKind: "pending_action_execute", targetKind: "pending_action",
      targetId: approvalId, payload: {} });
    const claimed = approvalEffects.claimNextPendingEffect(`handoff:${seed}`, runs.readDatabaseNow(),
      new Date(Date.parse(runs.readDatabaseNow()) + 60_000).toISOString())!;
    assert.equal(claimed.effectId, action.effectId);
    approvalEffects.skipEffect(action.effectId, `handoff:${seed}`, claimed.version, { result: {
      reason: "remote_worker_resume_handoff", ...ref, intentId: intent.intentId,
      pendingActionSha256: digest(pending), approvalSha256: digest(resolved),
    } });
  } else assert.equal(approvalEffects.listByApproval(approvalId).length, 0);
  for (const drift of [
    { expectedParentVersion: waiting.version + 1 }, { waitingCheckpointId: "different-checkpoint" },
    { waitingRuntimeAuthoritySha256: digest("different-seal") }, { approvalId: "missing-approval" },
  ]) assert.throws(() => assignments.recordChatApprovalResumeWake({ ...wakeInput, ...drift }));
  assert.throws(() => db.transaction("immediate", () => {
    assignments.recordChatApprovalResumeWake(wakeInput);
    throw new Error("wake CAS rolled back");
  }), /rolled back/);
  assert.equal(ledger.readLatest(ref.registryWorkspaceId, ref.assignmentId, ref.assignmentGeneration), undefined);
  db.transaction("immediate", () => {
    const recorded = assignments.recordChatApprovalResumeWake(wakeInput);
    assert.deepEqual(assignments.recordChatApprovalResumeWake(wakeInput), recorded);
    const metadata = { ...waiting.metadata };
    delete metadata.waitForEvent;
    delete metadata.chatTurnRuntimeAuthority;
    runs.updateRun({ runId: run.runId, status: "queued", clearLease: true, metadata, expectedVersion: waiting.version });
  });
  if (fence) assert.equal(assignments.resolveChatApprovalResumeByLeaseTokenHash(observation, fence)?.phase, "waiting");
  assert.throws(() => assignments.bindChatApprovalResumeDispatch({ ...ref, durableRunId: run.runId,
    leaseOwnerId: "resumed-owner", attemptCount: run.attemptCount }));
  const resumed = runs.tryClaimQueuedRunWithDatabaseClock({ runId: run.runId,
    workerId: `resumed-owner:${seed}`, leaseDurationMs: 300_000 })!;
  const bind = { ...ref, durableRunId: run.runId, leaseOwnerId: resumed.leaseOwnerId!, attemptCount: resumed.attemptCount };
  if (fence) assert.equal(assignments.resolveChatApprovalResumeByLeaseTokenHash(observation, fence)?.phase, "waiting");
  // Exercise the database guard independently of the repository's native
  // credential checks. Every SQL probe rolls back; it cannot issue a lease.
  const probeLease = (owner: string, parentVersion = resumed.version) => {
    const authority = {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_DISPATCH_AUTHORITY_SCHEMA_VERSION,
      durableRunId: run.runId, durableRunAttempt: resumed.attemptCount,
      dispatchOwnerId: owner, durableRunVersion: parentVersion,
      durableRunLeaseExpiresAt: resumed.leaseExpiresAt!,
    };
    const now = runs.readDatabaseNow();
    db.prepare(`INSERT INTO remote_worker_assignment_leases (
      registry_workspace_id, assignment_id, assignment_generation, lease_revision,
      lease_token_sha256, worker_sent_through, server_acknowledged_through,
      parent_dispatch_authority_json, parent_dispatch_authority_sha256,
      heartbeat_at, expires_at, idempotency_key, request_sha256
    ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`).run(
      ref.registryWorkspaceId, ref.assignmentId, ref.assignmentGeneration, lease.leaseRevision + 1,
      digest(`sql-probe-token:${seed}`), canonicalJsonString(authority), digest(authority), now,
      new Date(Date.parse(now) + 1_000).toISOString(), `sql-probe:${seed}`, digest(`sql-probe:${seed}`),
    );
  };
  const leaseGuardError = /remote worker assignment lease (?:revision or database-clock invariant violated|lacks current worker, node, or parent dispatch authority)/;
  assert.throws(() => db.transaction("immediate", () => {
    db.prepare("UPDATE durable_runs SET lease_owner_id = ? WHERE run_id = ?")
      .run(prepared.offerInput.dispatchOwnerId, run.runId);
    probeLease(prepared.offerInput.dispatchOwnerId);
  }), leaseGuardError);
  assert.throws(() => assignments.bindChatApprovalResumeDispatch({ ...bind, leaseOwnerId: "wrong-owner" }));
  assert.throws(() => db.transaction("immediate", () => {
    runs.updateRun({ runId: run.runId, status: resumed.status,
      payload: { ...resumed.payload, changedAfterApproval: true }, expectedVersion: resumed.version });
    assignments.bindChatApprovalResumeDispatch(bind);
  }), /resume dispatch claim/);
  const bound = assignments.bindChatApprovalResumeDispatch(bind)!;
  assert.equal(bound.binding?.dispatchOwnerId, resumed.leaseOwnerId);
  assert.deepEqual(assignments.bindChatApprovalResumeDispatch(bind), bound);
  if (fence) {
    assert.equal(assignments.resolveChatApprovalResumeByLeaseTokenHash(observation, fence)?.phase, "renew");
    assert.equal(assignments.resolveChatApprovalResumeByLeaseTokenHash({ ...observation, leaseTokenSha256: digest("wrong") }, fence), undefined);
  }
  const probeRollback = new Error("SQL authority probe rolled back");
  assert.throws(() => db.transaction("immediate", () => {
    probeLease(resumed.leaseOwnerId!);
    const progress = assignments.appendEvents({
      registryWorkspaceId: ref.registryWorkspaceId, assignmentId: ref.assignmentId,
      expectedAssignmentGeneration: ref.assignmentGeneration, expectedLeaseRevision: lease.leaseRevision + 1,
      leaseTokenSha256: digest(`sql-probe-token:${seed}`),
      events: [{ sequence: 1, eventId: `resumed-status:${seed}`, eventType: "status",
        payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
          phase: "running", statusSha256: digest(`resumed-status:${seed}`) },
        previousEventSha256: REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256, workerSentThrough: 1 }],
    }, fence);
    assert.equal(progress.disposition, "appended");
    throw probeRollback;
  }), (error: unknown) => error === probeRollback);
  assert.throws(() => db.transaction("immediate", () => probeLease(resumed.leaseOwnerId!, resumed.version - 1)), leaseGuardError);
  assert.throws(() => db.transaction("immediate", () => {
    db.prepare("UPDATE durable_runs SET lease_owner_id = ? WHERE run_id = ?")
      .run(prepared.offerInput.dispatchOwnerId, run.runId);
    probeLease(prepared.offerInput.dispatchOwnerId);
  }), leaseGuardError);
  assert.throws(() => db.transaction("immediate", () => {
    db.prepare(`INSERT INTO remote_worker_chat_resume_wakes (
      resume_id, registry_workspace_id, assignment_id, assignment_generation,
      prior_lease_revision, durable_run_id, waiting_checkpoint_id, material_json, material_sha256, created_at
    ) SELECT resume_id || ':sql-probe', registry_workspace_id, assignment_id, assignment_generation,
      prior_lease_revision + 1, durable_run_id, waiting_checkpoint_id || ':sql-probe', material_json, material_sha256, created_at
      FROM remote_worker_chat_resume_wakes WHERE resume_id = ?`).run(bound.resumeId);
    probeLease(resumed.leaseOwnerId!);
  }), leaseGuardError);
  assert.throws(() => db.transaction("immediate", () => {
    db.prepare("UPDATE durable_runs SET lease_owner_id = ? WHERE run_id = ?").run("other-parent-owner", run.runId);
    assignments.bindChatApprovalResumeDispatch({ ...bind, leaseOwnerId: "other-parent-owner" });
  }), /resume/);
  for (const table of ["remote_worker_chat_resume_wakes", "remote_worker_chat_resume_bindings"]) {
    assert.throws(() => db.transaction("immediate", () => db.prepare(`UPDATE ${table} SET created_at = created_at`).run()), /immutable/);
    assert.throws(() => db.transaction("immediate", () => db.prepare(`DELETE FROM ${table}`).run()), /immutable/);
  }
  const renewal = { registryWorkspaceId: "default", assignmentId: assignment.assignmentId,
    expectedAssignmentGeneration: generation.assignmentGeneration, expectedLeaseRevision: lease.leaseRevision,
    expectedLeaseTokenSha256: token, leaseTokenSha256: digest(`new-token:${seed}`), workerSentThrough: 0,
    idempotencyKey: `renew-resume:${seed}` };
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(lease.expiresAt) - Date.parse(runs.readDatabaseNow()) + 50)));
  assert.throws(() => assignments.renewLease(renewal));
  assert.throws(() => assignments.recoverExpiredAssignment({
    registryWorkspaceId: ref.registryWorkspaceId, assignmentId: ref.assignmentId,
    workerId: worker.workerId, workerGeneration: worker.workerGeneration,
    nodeId: worker.nodeId, nodeAdmissionGeneration: worker.nodeAdmissionGeneration,
    dispatchOwnerId: resumed.leaseOwnerId!, durableRunAttempt: resumed.attemptCount,
    expectedAssignmentGeneration: ref.assignmentGeneration, expectedLeaseRevision: lease.leaseRevision,
    leaseTokenSha256: digest(`recovery-token:${seed}`), reasonCode: "lease.expired", reasonSha256: digest("expired"),
    actorId: "gateway", idempotencyKey: `recovery:${seed}`,
  }), /resume owns the retained generation/);
  assert.equal(assignments.resolveActiveAuthorityByLeaseTokenHash(token, fence), undefined);
  if (fence) {
    assert.throws(() => assignments.renewLease({ ...renewal, expectedLeaseTokenSha256: digest("wrong-token") }, fence));
    assert.throws(() => assignments.renewLease(renewal, { ...fence,
      credentialAuthority: { ...fence.credentialAuthority, authorizationCredentialSha256: digest("wrong-credential") } }));
    const renewed = assignments.renewLease(renewal, fence);
    assert.equal(renewed.lease.leaseRevision, lease.leaseRevision + 1);
    assert.equal(assignments.renewLease(renewal, fence).disposition, "replayed_without_lease_secret");
    assert.ok(assignments.resolveActiveAuthorityByLeaseTokenHash(renewal.leaseTokenSha256, fence));
    const activeResume = assignments.resolveActiveChatApprovalResume({ ...ref,
      leaseTokenSha256: renewal.leaseTokenSha256 }, fence);
    assert.equal(activeResume?.materialSha256, bound.materialSha256);
    assert.equal(activeResume?.binding?.dispatchOwnerId, resumed.leaseOwnerId);
    assert.throws(() => assignments.resolveActiveChatApprovalResume({ ...ref,
      leaseTokenSha256: token }, fence));
    assert.equal(assignments.resolveActiveAuthorityByLeaseTokenHash(token, fence), undefined);
    assert.equal(assignments.resolveChatApprovalResumeByLeaseTokenHash(observation, fence), undefined);
  }
  assert.deepEqual(pendingActions.find(approvalId), pending);
  assert.equal(effects.readTransitionHistory(ref.registryWorkspaceId, ref.assignmentId,
    ref.assignmentGeneration, intent.intentId).at(-1)?.record.transitionState, "approval_wait");
  assert.equal(assignments.findAssignmentAggregate(ref.registryWorkspaceId, ref.assignmentId)?.generation?.assignmentGeneration,
    generation.assignmentGeneration);
  verifyWorkerChatResumeRecovery(db, ref, fence ? renewal.leaseTokenSha256 : token, fence);
  if (decision !== "approve") return;
  // Projection parity only: an approval still in flight cannot claim no effect;
  // a terminal trusted read can, without being converted to malformed evidence.
  const safeReadId = `approved-safe-read:${seed}`;
  tools.create({ toolRunId: safeReadId, sessionId: manifest.sessionId!, turnId: manifest.turnId!, toolName: "fs.read",
    approvalId, status: "started", effectPotential: "none", effectDisposition: "none", effectOutcomeKind: "none",
    effectEvidence: { version: "goatcitadel.tool-effect.v1", outcomeKind: "none", reason: "trusted_safe_read", refs: [] } });
  assert.equal(tools.get(safeReadId).effectOutcomeKind, "uncertain");
  tools.patch(safeReadId, { status: "executed", finishedAt: runs.readDatabaseNow(),
    effectPotential: "none", effectDisposition: "none", effectOutcomeKind: "none",
    effectEvidence: { version: "goatcitadel.tool-effect.v1", outcomeKind: "none", reason: "trusted_safe_read", refs: [] } });
  assert.equal(tools.get(safeReadId).effectOutcomeKind, "none");
  assert.equal(tools.get(safeReadId).effectEvidence?.reason, "trusted_safe_read");
  tools.patch(safeReadId, { effectPotential: "unknown" });
  assert.equal(tools.get(safeReadId).effectOutcomeKind, "uncertain");
}
