import assert from "node:assert/strict";
import { ConflictError, canonicalJsonString, remoteWorkerAssignmentCanonicalSha256 as digest } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { PendingApprovalActionRepository } from "./pending-approval-action-repo.js";
import { ApprovalRepository } from "./approval-repo.js";
import { RemoteWorkerAssignmentRepository, type RemoteWorkerAssignmentProtectedCommitFence } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerChatResumeLedger } from "./remote-worker-chat-resume-ledger.js";

/** Shared storage proof. Gateway recovery scheduling and actual native transport
 * are verified separately; these transitions exercise the repository boundary. */
export function verifyWorkerChatResumeRecovery(db: DatabaseClient, ref: {
  registryWorkspaceId: string; assignmentId: string; assignmentGeneration: number;
}, leaseTokenSha256: string, fence?: RemoteWorkerAssignmentProtectedCommitFence): void {
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const ledger = new RemoteWorkerChatResumeLedger(db);
  const runs = new DurableRunRepository(db);
  const actions = new PendingApprovalActionRepository(db);
  const original = ledger.readLatest(ref.registryWorkspaceId, ref.assignmentId, ref.assignmentGeneration)!;
  const originalRows = () => [
    db.prepare("SELECT * FROM remote_worker_chat_resume_wakes WHERE resume_id = ?").get(original.resumeId),
    db.prepare("SELECT * FROM remote_worker_chat_resume_bindings WHERE resume_id = ?").get(original.resumeId),
  ];
  const before = originalRows();
  let previous = original;
  let lease = assignments.findAssignmentAggregate(ref.registryWorkspaceId, ref.assignmentId)!.lease!;
  const approval = new ApprovalRepository(db).get(original.material.approvalId);
  for (let index = 1; index <= 3; index += 1) {
    const current = runs.getRun(original.material.durableRunId);
    const observation = { ...ref, expectedAssignmentGeneration: ref.assignmentGeneration,
      expectedLeaseRevision: lease.leaseRevision, leaseTokenSha256 };
    const renewal = { registryWorkspaceId: ref.registryWorkspaceId, assignmentId: ref.assignmentId,
      expectedAssignmentGeneration: ref.assignmentGeneration,
      expectedLeaseRevision: lease.leaseRevision, expectedLeaseTokenSha256: leaseTokenSha256,
      leaseTokenSha256: digest(`${ref.assignmentId}:recovery-token:${index}`), workerSentThrough: 0,
      idempotencyKey: `${ref.assignmentId}:recovery-renewal:${index}` };
    const expired = runs.updateRun({ runId: current.runId, status: "running", expectedVersion: current.version,
      leaseExpiresAt: "2000-01-01T00:00:00.000Z" });
    if (fence) {
      assert.deepEqual(pickObservation(assignments.resolveChatApprovalResumeByLeaseTokenHash(observation, fence)),
        { phase: "waiting", pendingRecovery: true });
      assert.throws(() => assignments.renewLease(renewal, fence), ConflictError);
    }
    runs.updateRun({ runId: current.runId, status: "queued", clearLease: true, expectedVersion: expired.version });
    if (fence) assert.deepEqual(pickObservation(assignments.resolveChatApprovalResumeByLeaseTokenHash(observation, fence)),
      { phase: "waiting", pendingRecovery: true });
    const claimed = runs.tryClaimQueuedRunWithDatabaseClock({ runId: current.runId,
      workerId: `${ref.assignmentId}:recovered-owner:${index}`, leaseDurationMs: 300_000 })!;
    const bind = { ...ref, durableRunId: current.runId, leaseOwnerId: claimed.leaseOwnerId!, attemptCount: claimed.attemptCount };
    assert.equal(claimed.attemptCount, current.attemptCount);
    assert.throws(() => assignments.bindChatApprovalResumeDispatch({ ...bind, leaseOwnerId: current.leaseOwnerId! }));
    if (fence) assert.deepEqual(pickObservation(assignments.resolveChatApprovalResumeByLeaseTokenHash(observation, fence)),
      { phase: "waiting", pendingRecovery: true });
    for (const drift of ["attempt", "payload", "request", "approval"] as const) {
      assert.throws(() => db.transaction("immediate", () => {
        if (drift === "attempt") runs.updateRun({ runId: current.runId, status: "running",
          expectedVersion: claimed.version, attemptCount: claimed.attemptCount + 1 });
        if (drift === "payload") runs.updateRun({ runId: current.runId, status: "running",
          expectedVersion: claimed.version, payload: { ...claimed.payload, changed: true } });
        if (drift === "request") db.prepare("UPDATE pending_approval_actions SET request_json = ? WHERE approval_id = ?")
          .run(canonicalJsonString({ ...actions.get(approval.approvalId).request, args: { path: "different.txt" } }), approval.approvalId);
        if (drift === "approval") db.prepare("UPDATE approvals SET status = 'pending' WHERE approval_id = ?").run(approval.approvalId);
        assignments.bindChatApprovalResumeDispatch(bind);
      }), ConflictError, `${drift} drift must not gain a recovery binding`);
    }
    const recovered = assignments.bindChatApprovalResumeDispatch(bind)!;
    assert.deepEqual(assignments.bindChatApprovalResumeDispatch(bind), recovered);
    assert.equal(recovered.resumeId, original.resumeId);
    assert.equal(recovered.materialSha256, original.materialSha256);
    assert.equal(recovered.recovery?.material.recoveryRevision, index);
    assert.equal(recovered.recovery?.material.priorAuthorityRecordSha256,
      previous.recovery?.materialSha256 ?? digest(original.binding));
    assert.equal(recovered.recovery?.material.priorLeaseRevision, lease.leaseRevision);
    assert.equal(recovered.recovery?.material.priorLeaseRequestSha256, lease.requestSha256);
    assert.equal(recovered.recovery?.material.pendingActionSha256, digest(actions.get(approval.approvalId)));
    assert.deepEqual(originalRows(), before);
    // Probe SQL directly, rolling back every insert. Even a stale process that
    // presents a currently matching run row cannot bypass the retained owner.
    const insertProbeLease = (owner: string, parentVersion: number) => {
      const authority = { ...recovered.binding!, dispatchOwnerId: owner, durableRunVersion: parentVersion };
      const now = runs.readDatabaseNow();
      db.prepare(`INSERT INTO remote_worker_assignment_leases (
        registry_workspace_id, assignment_id, assignment_generation, lease_revision,
        lease_token_sha256, worker_sent_through, server_acknowledged_through,
        parent_dispatch_authority_json, parent_dispatch_authority_sha256,
        heartbeat_at, expires_at, idempotency_key, request_sha256
      ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`).run(
        ref.registryWorkspaceId, ref.assignmentId, ref.assignmentGeneration, lease.leaseRevision + 1,
        digest(`probe-token:${index}`), canonicalJsonString(authority), digest(authority), now,
        new Date(Date.parse(now) + 1_000).toISOString(), `${ref.assignmentId}:probe:${index}`, digest(`probe:${index}`));
    };
    const rollback = new Error("recovery SQL lease probe rollback");
    assert.throws(() => db.transaction("immediate", () => {
      insertProbeLease(claimed.leaseOwnerId!, claimed.version);
      throw rollback;
    }), (error: unknown) => error === rollback);
    for (const owner of [original.binding!.dispatchOwnerId, previous.binding!.dispatchOwnerId]) {
      assert.throws(() => db.transaction("immediate", () => {
        const stale = runs.updateRun({ runId: current.runId, status: "running", expectedVersion: claimed.version,
          leaseOwnerId: owner });
        insertProbeLease(owner, stale.version);
      }), /remote worker assignment lease/);
    }
    assert.throws(() => assignments.renewLease(renewal), ConflictError);
    if (fence) {
      assert.deepEqual(pickObservation(assignments.resolveChatApprovalResumeByLeaseTokenHash(observation, fence)),
        { phase: "renew", pendingRecovery: false });
      assert.throws(() => assignments.renewLease({ ...renewal, expectedLeaseTokenSha256: digest("obsolete-token") }, fence), ConflictError);
      assert.throws(() => assignments.renewLease(renewal, { ...fence, credentialAuthority: {
        ...fence.credentialAuthority, authorizationCredentialSha256: digest("obsolete-credential") } }), ConflictError);
      lease = assignments.renewLease(renewal, fence).lease;
      leaseTokenSha256 = renewal.leaseTokenSha256;
      assert.equal(assignments.renewLease(renewal, fence).disposition, "replayed_without_lease_secret");
      assert.equal(assignments.resolveChatApprovalResumeByLeaseTokenHash(observation, fence), undefined);
      assert.equal(assignments.resolveActiveChatApprovalResume({ ...ref, leaseTokenSha256 }, fence)
        ?.recovery?.materialSha256, recovered.recovery!.materialSha256);
    }
    if (approval.status === "approved" && index === 1) {
      // Canonical storage terminal state, without pretending to execute a tool.
      actions.markResolved(approval.approvalId, "executed", { outcome: "executed", result: { fixture: true } });
    }
    previous = recovered;
  }
  for (const operation of ["UPDATE remote_worker_chat_resume_recoveries SET created_at = created_at",
    "DELETE FROM remote_worker_chat_resume_recoveries"]) {
    assert.throws(() => db.transaction("immediate", () => db.prepare(operation).run()), /immutable/);
  }
  const recovery = previous.recovery!;
  for (const drift of [{ priorAuthorityRecordSha256: digest("wrong-predecessor") },
    { recoveryRevision: recovery.material.recoveryRevision + 2 }, { approvalSha256: digest("wrong-approval") },
    { priorLeaseRevision: 0 }, { pendingActionSha256: "invalid" }]) {
    assert.throws(() => db.transaction("immediate", () => {
      const material = { ...recovery.material, recoveryRevision: recovery.material.recoveryRevision + 1,
        priorAuthorityRecordSha256: recovery.materialSha256, dispatchAuthority: { ...recovery.material.dispatchAuthority,
          dispatchOwnerId: "untrusted-owner", durableRunVersion: recovery.material.dispatchAuthority.durableRunVersion + 1 }, ...drift };
      db.prepare(`INSERT INTO remote_worker_chat_resume_recoveries
        (resume_id, recovery_revision, material_json, material_sha256, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(original.resumeId, material.recoveryRevision, canonicalJsonString(material), digest(material), runs.readDatabaseNow());
      ledger.readLatest(ref.registryWorkspaceId, ref.assignmentId, ref.assignmentGeneration);
    }), /recovery/);
  }
}

function pickObservation(value: { phase: string; pendingRecovery: boolean } | undefined) {
  return value && { phase: value.phase, pendingRecovery: value.pendingRecovery };
}
