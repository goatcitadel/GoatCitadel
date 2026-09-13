import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ConflictError, canonicalJsonString, remoteWorkerAssignmentCanonicalSha256 as digest,
  type StartRemoteWorkerAssignmentGenerationCommand } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerAssignmentRepository, type RemoteWorkerAssignmentProtectedCommitFence } from "./remote-worker-assignment-repo.js";
import { prepareChatOfferFixture } from "./remote-worker-chat-offer-fixture.js";
import { RemoteWorkerChatContextRepository } from "./remote-worker-chat-context-repo.js";

/** Shared repository proof over real admitted Chat state. Process recovery and
 * the native transport are exercised by their Gateway owners separately. */
export async function verifyWorkerChatParentRecovery(db: DatabaseClient, seed: string,
  worker: Pick<StartRemoteWorkerAssignmentGenerationCommand,
    "workerId" | "workerGeneration" | "nodeId" | "nodeAdmissionGeneration">,
  fence?: RemoteWorkerAssignmentProtectedCommitFence): Promise<void> {
  const runs = new DurableRunRepository(db);
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const prepared = prepareChatOfferFixture(db, true, `-parent-${seed}`);
  const assignment = assignments.createAssignment({ ...prepared.legacyCommand,
    manifest: { ...prepared.legacyCommand.manifest, leaseTtlSeconds: 1,
      contextSnapshotSha256: new RemoteWorkerChatContextRepository(db).findForRun(prepared.durableRunId)!.contextSha256,
      requiredCapabilityClasses: ["durable_compute", "gateway_inference"] },
  }).assignment;
  const ref = { registryWorkspaceId: "default", assignmentId: assignment.assignmentId };
  let token = digest(`parent-token:${seed}`);
  const started = assignments.startGeneration({ ...ref,
    workerId: worker.workerId, workerGeneration: worker.workerGeneration,
    nodeId: worker.nodeId, nodeAdmissionGeneration: worker.nodeAdmissionGeneration,
    dispatchOwnerId: prepared.offerInput.dispatchOwnerId, durableRunAttempt: prepared.offerInput.durableRunAttempt,
    leaseTokenSha256: token, idempotencyKey: `parent-generation:${seed}` });
  const generation = started.generation;
  let lease = started.lease;
  const recoveryRef = { ...ref, assignmentGeneration: generation.assignmentGeneration };
  const originalRun = runs.getRun(prepared.durableRunId);
  assert.equal(assignments.bindChatParentRecoveryDispatch({ ...ref, durableRunId: originalRun.runId,
    leaseOwnerId: originalRun.leaseOwnerId!, attemptCount: originalRun.attemptCount }), undefined);
  await delay(1_010);
  let previous = assignments.findChatParentRecovery(recoveryRef);
  for (let index = 1; index <= 3; index += 1) {
    const run = runs.getRun(prepared.durableRunId);
    const observation = { ...ref, expectedAssignmentGeneration: generation.assignmentGeneration,
      expectedLeaseRevision: lease.leaseRevision, leaseTokenSha256: token };
    const renewal = { ...ref, expectedAssignmentGeneration: generation.assignmentGeneration,
      expectedLeaseRevision: lease.leaseRevision, expectedLeaseTokenSha256: token,
      leaseTokenSha256: digest(`parent-token:${seed}:${index}`), workerSentThrough: 0,
      idempotencyKey: `parent-renew:${seed}:${index}` };
    if (index === 1 && fence) {
      assert.equal(assignments.resolveChatParentRecoveryByLeaseTokenHash(observation, fence), undefined);
      assert.throws(() => assignments.renewLease(renewal, fence), ConflictError,
        "An expired worker lease alone must not manufacture a recovery handoff.");
    }
    const expired = runs.updateRun({ runId: run.runId, status: "running", expectedVersion: run.version,
      leaseExpiresAt: "2000-01-01T00:00:00.000Z" });
    if (fence) {
      assert.equal(assignments.resolveChatParentRecoveryByLeaseTokenHash(observation, fence)?.phase, "waiting");
      assert.throws(() => assignments.renewLease(renewal, fence), ConflictError);
    }
    runs.updateRun({ runId: run.runId, status: "queued", clearLease: true, expectedVersion: expired.version });
    if (fence) assert.equal(assignments.resolveChatParentRecoveryByLeaseTokenHash(observation, fence)?.phase, "waiting");
    const claimed = runs.tryClaimQueuedRunWithDatabaseClock({ runId: run.runId,
      workerId: `parent-recovered:${seed}:${index}`, leaseDurationMs: 300_000 })!;
    assert.equal(claimed.attemptCount, originalRun.attemptCount);
    const bind = { ...ref, durableRunId: run.runId, leaseOwnerId: claimed.leaseOwnerId!, attemptCount: claimed.attemptCount };
    assert.throws(() => assignments.bindChatParentRecoveryDispatch({ ...bind, leaseOwnerId: run.leaseOwnerId! }), ConflictError);
    if (fence) assert.equal(assignments.resolveChatParentRecoveryByLeaseTokenHash(observation, fence)?.phase, "waiting");
    for (const change of [{ attemptCount: claimed.attemptCount + 1 },
      { payload: { ...claimed.payload, request: { ...(claimed.payload.request as Record<string, unknown>), content: "Changed task" } } },
      { payload: { ...claimed.payload, sessionId: "unrelated-session" } }]) {
      assert.throws(() => db.transaction("immediate", () => {
        runs.updateRun({ runId: run.runId, status: "running", expectedVersion: claimed.version, ...change });
        assignments.bindChatParentRecoveryDispatch(bind);
      }), ConflictError, `Reject changed parent ${Object.keys(change)[0]}`);
    }
    const bound = assignments.bindChatParentRecoveryDispatch(bind)!;
    assert.equal(bound.material.recoveryRevision, index);
    assert.equal(bound.material.originalDispatchAuthoritySha256, generation.dispatchAuthoritySha256);
    assert.equal(bound.material.priorAuthorityRecordSha256, previous?.materialSha256 ?? generation.dispatchAuthoritySha256);
    assert.equal(bound.material.priorLeaseRequestSha256, lease.requestSha256);
    assert.equal(bound.material.priorLeaseRevision, lease.leaseRevision);
    assert.deepEqual(assignments.bindChatParentRecoveryDispatch(bind), bound);
    assert.deepEqual(assignments.findAssignmentAggregate(ref.registryWorkspaceId, ref.assignmentId)!.generation, generation);
    const insertLease = (owner: string, version: number) => {
      const authority = { ...bound.material.dispatchAuthority, dispatchOwnerId: owner, durableRunVersion: version };
      const now = runs.readDatabaseNow();
      db.prepare(`INSERT INTO remote_worker_assignment_leases (
        registry_workspace_id, assignment_id, assignment_generation, lease_revision,
        lease_token_sha256, worker_sent_through, server_acknowledged_through,
        parent_dispatch_authority_json, parent_dispatch_authority_sha256,
        heartbeat_at, expires_at, idempotency_key, request_sha256
      ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`).run(ref.registryWorkspaceId, ref.assignmentId,
        generation.assignmentGeneration, lease.leaseRevision + 1, digest(`parent-probe:${seed}:${index}`),
        canonicalJsonString(authority), digest(authority), now, new Date(Date.parse(now) + 1_000).toISOString(),
        `parent-probe:${seed}:${index}`, digest(`parent-probe-request:${seed}:${index}`));
    };
    const rollback = new Error("parent recovery SQL probe rollback");
    assert.throws(() => db.transaction("immediate", () => {
      insertLease(claimed.leaseOwnerId!, claimed.version);
      throw rollback;
    }), (error: unknown) => error === rollback);
    assert.throws(() => db.transaction("immediate", () => {
      const stale = runs.updateRun({ runId: run.runId, status: "running", expectedVersion: claimed.version,
        leaseOwnerId: originalRun.leaseOwnerId });
      insertLease(originalRun.leaseOwnerId!, stale.version);
    }), /remote worker assignment lease/);
    assert.throws(() => assignments.renewLease(renewal), ConflictError);
    if (fence) {
      assert.deepEqual(assignments.resolveChatParentRecoveryByLeaseTokenHash(observation, fence)?.recovery,
        { bindingSha256: bound.materialSha256 });
      assert.equal(assignments.resolveChatParentRecoveryByLeaseTokenHash(observation, fence)?.phase, "renew");
      assert.throws(() => assignments.renewLease({ ...renewal, expectedLeaseTokenSha256: digest("obsolete") }, fence), ConflictError);
      assert.throws(() => assignments.renewLease(renewal, { ...fence, credentialAuthority: {
        ...fence.credentialAuthority, authorizationCredentialSha256: digest("obsolete") } }), ConflictError);
      lease = assignments.renewLease(renewal, fence).lease;
      token = renewal.leaseTokenSha256;
      assert.equal(assignments.renewLease(renewal, fence).disposition, "replayed_without_lease_secret");
      assert.equal(assignments.resolveChatParentRecoveryByLeaseTokenHash(observation, fence), undefined);
      assert.equal(assignments.resolveActiveAuthorityByLeaseTokenHash(token, fence)?.lease.leaseRevision, lease.leaseRevision);
    }
    previous = bound;
  }
  for (const sql of ["UPDATE remote_worker_chat_parent_recoveries SET created_at = created_at",
    "DELETE FROM remote_worker_chat_parent_recoveries"]) {
    assert.throws(() => db.transaction("immediate", () => db.prepare(sql).run()), /immutable/);
  }
}
