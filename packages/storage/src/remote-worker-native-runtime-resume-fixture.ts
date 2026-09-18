import assert from "node:assert/strict";
import { remoteWorkerAssignmentCanonicalSha256 as digest, type StartRemoteWorkerAssignmentGenerationCommand } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ApprovalRepository } from "./approval-repo.js";
import { ApprovalWaitRunRepository } from "./approval-wait-run-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerAssignmentRepository, type RemoteWorkerAssignmentProtectedCommitFence } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerChatResumeLedger } from "./remote-worker-chat-resume-ledger.js";
import { RemoteWorkerChatContextRepository } from "./remote-worker-chat-context-repo.js";
import { prepareChatOfferFixture } from "./remote-worker-chat-offer-fixture.js";
import { assertNativeRuntimeChatResume } from "./remote-worker-native-runtime-resume-admission.js";
import { RemoteWorkerRuntimeResultRepository } from "./remote-worker-runtime-result-repo.js";

/** Real protected repository/lease proof. The request and waiting seal are
 * controlled fixtures; no provider, native process, disk or installed service. */
export async function verifyNativeRuntimeLeaseResume(db: DatabaseClient, seed: string,
  worker: Pick<StartRemoteWorkerAssignmentGenerationCommand, "workerId" | "workerGeneration" | "nodeId" | "nodeAdmissionGeneration">,
  fence: RemoteWorkerAssignmentProtectedCommitFence, decision: "approve" | "reject", options?: {
    prepareReview?: (input: { ref: { registryWorkspaceId: string; assignmentId: string; assignmentGeneration: number };
      token: string; lease: ReturnType<RemoteWorkerAssignmentRepository["startGeneration"]>["lease"] }) => {
        nativeRuntime: Record<string, unknown>; token: string; lease: ReturnType<RemoteWorkerAssignmentRepository["startGeneration"]>["lease"] };
    recoveryCount?: number;
    expireBeforeRenewal?: boolean;
  }) {
  const runs = new DurableRunRepository(db), assignments = new RemoteWorkerAssignmentRepository(db);
  const approvals = new ApprovalRepository(db), ledger = new RemoteWorkerChatResumeLedger(db);
  const prepared = prepareChatOfferFixture(db, true, `-native-resume-${seed}`);
  const assignment = assignments.createAssignment({ ...prepared.legacyCommand, manifest: { ...prepared.legacyCommand.manifest,
    leaseTtlSeconds: options?.prepareReview ? 60 : 1,
    contextSnapshotSha256: new RemoteWorkerChatContextRepository(db).findForRun(prepared.durableRunId)!.contextSha256 } }).assignment;
  let token = digest(`native-lease:${seed}:0`);
  const started = assignments.startGeneration({ registryWorkspaceId: "default", assignmentId: assignment.assignmentId, ...worker,
    dispatchOwnerId: prepared.offerInput.dispatchOwnerId, durableRunAttempt: prepared.offerInput.durableRunAttempt,
    leaseTokenSha256: token, idempotencyKey: `native-start:${seed}` });
  let lease = started.lease;
  const ref = { registryWorkspaceId: "default", assignmentId: assignment.assignmentId, assignmentGeneration: started.generation.assignmentGeneration };
  const manifest = assignment.manifest;
  const nativeReview = options?.prepareReview?.({ ref, token, lease });
  if (nativeReview) { token = nativeReview.token; lease = nativeReview.lease; }
  const approval = approvals.createWithTtlDuration({ kind: "remote_worker.native_runtime", riskLevel: "danger", preview: {},
    payload: { nativeRuntime: nativeReview?.nativeRuntime ?? { schemaVersion: "goatcitadel.native-runtime-approval.v1", ...ref, profileSha256: digest("native-profile"),
      expectedCapacityRevision: 1, expectedExecutionRevision: 1, expectedCleanupRevision: 0, expectedBackupRevision: 0,
      expectation: { nonce: digest(seed), requestSha256: digest(`request:${seed}`), checkpointSha256: digest("checkpoint"),
        runtimeBundleSha256: digest("bundle"), maxInputBytes: 100, maxOutputBytes: 100, maxInventoryEntries: 100 } } },
    linkage: { workspaceId: manifest.executionWorkspaceId, taskId: manifest.taskId, durableRunId: manifest.durableRunId,
      sessionId: manifest.sessionId, turnId: manifest.turnId, actionType: "remote_worker.native_runtime" } }, 300_000);
  new ApprovalWaitRunRepository(db).createOrGet({ approvalId: approval.approvalId, runId: `native-wait:${seed}` });
  const run = runs.getRun(manifest.durableRunId), waitForEvent = { eventKey: "approval.resolved", correlationId: approval.approvalId };
  const material = { runId: run.runId, turnId: manifest.turnId, transitionKind: "waiting", durableStatus: "waiting",
    traceStatus: "waiting_for_approval", waitForEvent };
  const seal = { material, materialSha256: digest(material) };
  const waiting = runs.updateRun({ runId: run.runId, status: "waiting", clearLease: true, expectedVersion: run.version,
    metadata: { ...run.metadata, waitForEvent, chatTurnRuntimeAuthority: seal } });
  const checkpoint = runs.createCheckpoint({ runId: run.runId, checkpointKind: "run_waiting", state: { waitForEvent, chatTurnRuntimeAuthority: seal } });
  const wakeInput = { ...ref, approvalId: approval.approvalId, expectedParentVersion: waiting.version,
    waitingCheckpointId: checkpoint.checkpointId, waitingRuntimeAuthoritySha256: seal.materialSha256 };
  assert.throws(() => assignments.recordChatApprovalResumeWake(wakeInput));
  approvals.resolve(approval.approvalId, { decision, resolvedBy: "operator" });
  const rollback = new Error("controlled native wake rollback");
  assert.throws(() => db.transaction("immediate", () => { assignments.recordChatApprovalResumeWake(wakeInput); throw rollback; }), error => error === rollback);
  assert.equal(ledger.readLatest(ref.registryWorkspaceId, ref.assignmentId, ref.assignmentGeneration), undefined);
  db.transaction("immediate", () => {
    assignments.recordChatApprovalResumeWake(wakeInput);
    const metadata = { ...waiting.metadata }; delete metadata.waitForEvent; delete metadata.chatTurnRuntimeAuthority;
    runs.updateRun({ runId: run.runId, status: "queued", clearLease: true, metadata, expectedVersion: waiting.version });
  });
  const originalHash = ledger.readLatest(ref.registryWorkspaceId, ref.assignmentId, ref.assignmentGeneration)!.materialSha256;
  const assertAdmission = (leaseTokenSha256: string) => db.transaction("immediate", () =>
    assertNativeRuntimeChatResume(assignments, { ...ref, leaseTokenSha256 }, fence, approvals.get(approval.approvalId)));
  assert.throws(() => assertAdmission(token), "a queued wake is not execution authority");
  for (let recovery = 0; recovery <= (options?.recoveryCount ?? 2); recovery++) {
    if (recovery) {
      const prior = runs.getRun(run.runId);
      runs.updateRun({ runId: run.runId, status: "queued", clearLease: true, expectedVersion: prior.version });
    }
    const parent = runs.tryClaimQueuedRunWithDatabaseClock({ runId: run.runId, workerId: `native-resumed:${seed}:${recovery}`, leaseDurationMs: 300_000 })!;
    const bind = { ...ref, durableRunId: run.runId, leaseOwnerId: parent.leaseOwnerId!, attemptCount: parent.attemptCount };
    assert.throws(() => assignments.bindChatApprovalResumeDispatch({ ...bind, leaseOwnerId: "foreign" }));
    const bound = assignments.bindChatApprovalResumeDispatch(bind)!;
    assert.equal(bound.materialSha256, originalHash);
    assert.equal(bound.recovery?.material.recoveryRevision ?? 0, recovery);
    assert.equal(Object.hasOwn(bound.material, "pendingActionSha256"), false);
    if (bound.recovery) assert.equal(Object.hasOwn(bound.recovery.material, "pendingActionSha256"), false);
    const observation = { ...ref, expectedAssignmentGeneration: ref.assignmentGeneration, expectedLeaseRevision: lease.leaseRevision, leaseTokenSha256: token };
    assert.equal(assignments.resolveChatApprovalResumeByLeaseTokenHash(observation, fence)?.phase, "renew");
    assert.throws(() => assertAdmission(token), "a bound parent still needs the rotated worker lease");
    const nextToken = digest(`native-lease:${seed}:${recovery + 1}`);
    const renewal = { registryWorkspaceId: ref.registryWorkspaceId, assignmentId: ref.assignmentId, expectedAssignmentGeneration: ref.assignmentGeneration,
      expectedLeaseRevision: lease.leaseRevision, expectedLeaseTokenSha256: token, leaseTokenSha256: nextToken, workerSentThrough: 0,
      idempotencyKey: `native-renew:${seed}:${recovery}` };
    if (options?.expireBeforeRenewal !== false)
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(lease.expiresAt) - Date.parse(runs.readDatabaseNow()) + 30)));
    assert.throws(() => assignments.renewLease(renewal));
    assert.throws(() => assignments.renewLease({ ...renewal, expectedLeaseTokenSha256: digest("foreign-token") }, fence));
    assert.throws(() => assignments.renewLease(renewal, { ...fence, credentialAuthority: { ...fence.credentialAuthority,
      authorizationCredentialSha256: digest("foreign-credential") } }));
    const renewed = assignments.renewLease(renewal, fence);
    assert.equal(renewed.lease.leaseRevision, lease.leaseRevision + 1);
    assert.equal(assignments.renewLease(renewal, fence).disposition, "replayed_without_lease_secret");
    assert.equal(assignments.resolveActiveAuthorityByLeaseTokenHash(token, fence), undefined);
    assert.equal(assignments.resolveChatApprovalResumeByLeaseTokenHash(observation, fence), undefined);
    assert.equal(assignments.resolveActiveChatApprovalResume({ ...ref, leaseTokenSha256: nextToken }, fence)?.materialSha256, originalHash);
    const workload = assignments.resolveActiveChatExecution({ ...ref, leaseTokenSha256: nextToken }, fence).workload;
    assert.deepEqual(workload.nativeContinuation, {
      schemaVersion: "goatcitadel.remote-worker-native-continuation.v1", assignmentGeneration: ref.assignmentGeneration,
      resumeSha256: originalHash, approvalId: approval.approvalId, approvalSha256: digest(approvals.get(approval.approvalId)),
      nativeRuntimeBindingSha256: digest(approval.payload.nativeRuntime), decision: decision === "approve" ? "approved" : "rejected",
    });
    const { payload: _payload, chatContext: _context, artifactPolicy: _policy, workloadSha256, ...identity } = workload;
    assert.equal(digest(identity), workloadSha256, "continuation must be covered by workload identity");
    const outcomes = new RemoteWorkerRuntimeResultRepository(db);
    const parentRead = { ...ref, durableRunId: run.runId, continuation: workload.nativeContinuation! };
    assert.deepEqual(outcomes.readForChatContinuation(parentRead), { continuation: workload.nativeContinuation, recorded: null });
    const nativeChatContext = outcomes.readChatContextForParent(parentRead);
    if (decision === "approve") {
      assert.equal(nativeChatContext, null, "approval alone must not supply execution evidence to Chat");
      assert.equal(workload.nativeChatContext, undefined);
    } else {
      assert.deepEqual(nativeChatContext, { schemaVersion: "goatcitadel.remote-worker-native-chat-context.v1",
        continuation: workload.nativeContinuation, recorded: null });
      assert.deepEqual(workload.nativeChatContext, nativeChatContext);
    }
    for (const patch of [{ durableRunId: "foreign-run" }, { assignmentGeneration: ref.assignmentGeneration + 1 },
      { continuation: { ...parentRead.continuation, resumeSha256: digest("foreign-resume") } },
      { continuation: { ...parentRead.continuation, approvalId: "foreign-approval" } }])
      assert.throws(() => outcomes.readForChatContinuation({ ...parentRead, ...patch }));
    if (decision === "approve") {
      assert.doesNotThrow(() => assertAdmission(nextToken));
      const canonical = approvals.get(approval.approvalId);
      assert.throws(() => assertNativeRuntimeChatResume(assignments, { ...ref, leaseTokenSha256: nextToken }, fence,
        { ...canonical, approvalId: "foreign" }));
      assert.throws(() => assertNativeRuntimeChatResume(assignments, { ...ref, leaseTokenSha256: nextToken }, fence,
        { ...canonical, payload: { ...canonical.payload, nativeRuntime: { substituted: true } } }));
    } else assert.throws(() => assertAdmission(nextToken), "rejection resumes Chat but never admits execution");
    assert.throws(() => assertAdmission(token), "rotation invalidates the previous token for admission");
    lease = renewed.lease; token = nextToken;
  }
  return { ref, lease, token, parent: runs.getRun(run.runId), approval: approvals.get(approval.approvalId), manifest,
    continuation: assignments.resolveActiveChatExecution({ ...ref, leaseTokenSha256: token }, fence).workload.nativeContinuation! };
}
