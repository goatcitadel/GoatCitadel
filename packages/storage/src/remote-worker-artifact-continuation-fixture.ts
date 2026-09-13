import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { StartRemoteWorkerAssignmentGenerationCommand } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerArtifactRepository } from "./remote-worker-artifact-repo.js";
import {
  RemoteWorkerAssignmentRepository,
  type RemoteWorkerAssignmentProtectedCommitFence,
} from "./remote-worker-assignment-repo.js";
import { prepareChatOfferFixture } from "./remote-worker-chat-offer-fixture.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** The same real-authority continuation checks run on SQLite and PostgreSQL. */
export function verifyWorkerArtifactContinuation(
  db: DatabaseClient,
  seed: string,
  worker: Pick<
    StartRemoteWorkerAssignmentGenerationCommand,
    "workerId" | "workerGeneration" | "nodeId" | "nodeAdmissionGeneration"
  >,
  fence: RemoteWorkerAssignmentProtectedCommitFence,
): void {
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const artifacts = new RemoteWorkerArtifactRepository(db);
  const runs = new DurableRunRepository(db);
  const prepared = prepareChatOfferFixture(db, true, `-artifact-${seed}`);
  const assignment = assignments.scheduleTaskBoundChatOffer(prepared.offerInput).assignment;
  const leaseTokenSha256 = digest(`${seed}:lease`);
  const initial = assignments.startGeneration({
    ...worker,
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    dispatchOwnerId: prepared.offerInput.dispatchOwnerId,
    durableRunAttempt: prepared.offerInput.durableRunAttempt,
    leaseTokenSha256,
    idempotencyKey: `${seed}:generation`,
  });
  const ref = {
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    assignmentGeneration: initial.generation.assignmentGeneration,
  };
  const admitted = assignments.resolveActiveChatExecution({ ...ref, leaseTokenSha256 }, fence);
  const upload = artifacts.openUpload({
    ...ref,
    uploadAttempt: 1,
    declaredFileCount: 1,
    declaredTotalBytes: 5,
    stagingRootSha256: digest(`${seed}:staging`),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    idempotencyKey: `${seed}:upload`,
  });
  const continuingArtifact = {
    uploadId: upload.uploadId,
    leaseRevision: admitted.authority.lease.leaseRevision,
    parentDispatchAuthority: admitted.authority.lease.parentDispatchAuthority,
    durableRunPayloadSha256: admitted.workload.durableRunPayloadSha256,
  };
  const resolve = (overrides: Partial<typeof continuingArtifact> = {}) =>
    assignments.resolveActiveChatExecution(
      { ...ref, continuingArtifact: { ...continuingArtifact, ...overrides } },
      fence,
    );
  assert.equal(resolve().authority.lease.leaseRevision, 1);

  const parent = runs.getRun(prepared.durableRunId);
  assert.ok(
    runs.renewLease({
      runId: parent.runId,
      workerId: parent.leaseOwnerId!,
      leaseHeartbeatAt: runs.readDatabaseNow(),
      leaseExpiresAt: parent.leaseExpiresAt!,
    }),
  );
  // A heartbeat still invalidates a NEW request using the stale exact fence.
  assert.throws(() => assignments.resolveActiveChatExecution({ ...ref, leaseTokenSha256 }, fence));
  assert.equal(resolve().authority.lease.leaseRevision, 1);
  const nextToken = digest(`${seed}:rotated`);
  const rotated = assignments.renewLease(
    {
      registryWorkspaceId: ref.registryWorkspaceId,
      assignmentId: ref.assignmentId,
      expectedAssignmentGeneration: ref.assignmentGeneration,
      expectedLeaseRevision: 1,
      expectedLeaseTokenSha256: leaseTokenSha256,
      leaseTokenSha256: nextToken,
      workerSentThrough: 0,
      idempotencyKey: `${seed}:renew`,
    },
    fence,
  );
  assert.equal(resolve().authority.lease.leaseRevision, 2);
  assert.throws(() => assignments.resolveActiveChatExecution({ ...ref, leaseTokenSha256 }, fence));
  assert.throws(() =>
    assignments.resolveActiveChatExecution({ ...ref, leaseTokenSha256: nextToken, continuingArtifact }, fence),
  );
  assert.throws(() => resolve({ uploadId: "missing-upload" }));
  assert.throws(() => resolve({ leaseRevision: 3 }));
  assert.throws(() => resolve({ durableRunPayloadSha256: digest("changed-payload") }));
  for (const parentChange of [
    { dispatchOwnerId: "replacement-owner" },
    { durableRunAttempt: parent.attemptCount + 1 },
    { durableRunId: "other-run" },
    { durableRunVersion: parent.version + 100 },
    { durableRunLeaseExpiresAt: "2199-01-01T00:00:00.000Z" },
  ]) {
    assert.throws(() =>
      resolve({ parentDispatchAuthority: { ...continuingArtifact.parentDispatchAuthority, ...parentChange } }),
    );
  }

  const current = runs.getRun(parent.runId);
  const drifted = runs.updateRun({
    runId: current.runId,
    status: current.status,
    expectedVersion: current.version,
    payload: { ...current.payload, changedDuringPublication: true },
  });
  assert.throws(() => resolve());
  runs.updateRun({
    runId: current.runId,
    status: current.status,
    expectedVersion: drifted.version,
    payload: current.payload,
  });
  assert.equal(resolve().authority.lease.leaseRevision, 2);

  const beforeReplacement = runs.getRun(parent.runId);
  const replaced = runs.updateRun({
    runId: parent.runId,
    status: "running",
    expectedVersion: beforeReplacement.version,
    leaseOwnerId: "replacement-parent",
  });
  assert.throws(() => resolve());
  runs.updateRun({
    runId: parent.runId,
    status: "running",
    expectedVersion: replaced.version,
    leaseOwnerId: beforeReplacement.leaseOwnerId,
  });
  assert.equal(resolve().authority.lease.leaseRevision, 2);

  const quarantined = artifacts.openUpload({
    ...ref,
    uploadAttempt: 2,
    declaredFileCount: 1,
    declaredTotalBytes: 5,
    stagingRootSha256: digest(`${seed}:quarantined`),
    expiresAt: upload.expiresAt,
    idempotencyKey: `${seed}:quarantined`,
  });
  artifacts.terminateUpload({
    ...ref,
    uploadId: quarantined.uploadId,
    expectedUploadRevision: quarantined.uploadRevision,
    reason: "quarantined",
  });
  assert.throws(() => resolve({ uploadId: quarantined.uploadId }));

  assignments.requestCancellation({
    registryWorkspaceId: ref.registryWorkspaceId,
    assignmentId: ref.assignmentId,
    expectedAssignmentGeneration: ref.assignmentGeneration,
    expectedLeaseRevision: rotated.lease.leaseRevision,
    reasonCode: "operator_cancelled",
    reasonSha256: digest("cancel"),
    actorId: "fixture-operator",
    idempotencyKey: `${seed}:cancel`,
  });
  assert.throws(() => resolve());
}
