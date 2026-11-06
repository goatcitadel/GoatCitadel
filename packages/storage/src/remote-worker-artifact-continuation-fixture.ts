import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION, REMOTE_WORKER_CHAT_OUTPUT_PROFILE_SHA256,
  canonicalJsonString, normalizeRemoteWorkerArtifactManifest, remoteWorkerAssignmentCanonicalSha256,
  ConflictError,
  type StartRemoteWorkerAssignmentGenerationCommand } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerArtifactRepository } from "./remote-worker-artifact-repo.js";
import { RemoteWorkerAdmissionRepository } from "./remote-worker-admission-repo.js";
import { RemoteWorkerMeshNodeAdmissionRepository } from "./remote-worker-mesh-node-admission-repo.js";
import { MeshCapabilityNodeAdmissionRepository } from "./mesh-capability-node-admission-repo.js";
import {
  RemoteWorkerAssignmentRepository,
  snapshotRemoteWorkerChatArtifactAdmission,
  type AdmitRemoteWorkerChatArtifactInput,
  type RemoteWorkerArtifactPublicationBinding,
  type RemoteWorkerAssignmentProtectedCommitFence,
} from "./remote-worker-assignment-repo.js";
import { prepareChatOfferFixture } from "./remote-worker-chat-offer-fixture.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** The same real-authority continuation checks run on SQLite and PostgreSQL. */
export async function verifyWorkerArtifactContinuation(
  db: DatabaseClient,
  seed: string,
  worker: Pick<
    StartRemoteWorkerAssignmentGenerationCommand,
    "workerId" | "workerGeneration" | "nodeId" | "nodeAdmissionGeneration"
  >,
  fence: RemoteWorkerAssignmentProtectedCommitFence,
): Promise<void> {
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
  const upload = artifacts.openUpload({
    ...ref,
    uploadAttempt: 1,
    declaredFileCount: 1,
    declaredTotalBytes: 5,
    stagingRootSha256: digest(`${seed}:staging`),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    idempotencyKey: `${seed}:upload`,
  });
  const logicalPathSha256 = digest(canonicalJsonString({ logicalPath: "response.txt" }));
  const publication = { idempotencyKey: `${seed}:publication`, manifest: normalizeRemoteWorkerArtifactManifest({
    schemaVersion: REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION, identity: upload.identity,
    pathJailSha256: assignment.manifest.pathJailSha256, workerClaimIds: [], workerClaimSha256: digest(canonicalJsonString([])),
    requiredVerifierProfileSha256: REMOTE_WORKER_CHAT_OUTPUT_PROFILE_SHA256, fileCount: 1, totalBytes: 5,
    entries: [{ entryIndex: 0, logicalPath: "response.txt", logicalPathSha256, blobSha256: digest("hello"),
      byteCount: 5, mimeType: "text/plain" }],
  }), files: [{ logicalPath: "response.txt", logicalPathSha256, blobSha256: digest("hello"), byteCount: 5, mimeType: "text/plain" }] };
  const admissionInput: AdmitRemoteWorkerChatArtifactInput = { ...ref, leaseTokenSha256,
    expectedLeaseRevision: initial.lease.leaseRevision, uploadId: upload.uploadId, publication };
  const admitted = assignments.admitChatArtifactPublication(admissionInput, fence);
  const continuingArtifact = admitted.admission.continuingArtifact;
  assert.equal(admitted.admission.publicationSha256, remoteWorkerAssignmentCanonicalSha256(publication));
  assert.ok(Object.isFrozen(admitted.records.lease.parentDispatchAuthority));
  assert.ok(Object.isFrozen(admitted.admission.protectedAuthority.credentialAuthority));
  assert.ok(Object.isFrozen(continuingArtifact.parentDispatchAuthority));
  const transportCopy = snapshotRemoteWorkerChatArtifactAdmission(structuredClone(admitted.admission));
  assert.ok(Object.isFrozen(transportCopy.continuingArtifact.parentDispatchAuthority));
  assert.deepEqual(transportCopy, admitted.admission);
  const mutableFence = structuredClone(fence);
  const independent = assignments.admitChatArtifactPublication(admissionInput, mutableFence);
  Reflect.set(mutableFence.credentialAuthority, "workerId", "mutated-after-capture");
  assert.equal(independent.admission.protectedAuthority.credentialAuthority.workerId, worker.workerId);
  for (const invalid of [
    { leaseTokenSha256: digest("wrong-token") }, { expectedLeaseRevision: initial.lease.leaseRevision + 1 },
    { assignmentId: "missing-assignment" }, { assignmentGeneration: initial.generation.assignmentGeneration + 1 },
    { registryWorkspaceId: "foreign-workspace" }, { uploadId: "missing-upload" },
    { publication: { ...publication, files: [{ ...publication.files[0]!, blobSha256: digest("wrong-bytes") }] } },
    { publication: { ...publication, files: [{ ...publication.files[0]!, byteCount: 6 }] } },
    { publication: { ...publication, files: [{ ...publication.files[0]!, logicalPath: "other.txt" }] } },
    { publication: { ...publication, files: [{ ...publication.files[0]!, mimeType: "application/octet-stream" }] } },
    { publication: { ...publication, manifest: { ...publication.manifest,
      identity: { ...publication.manifest.identity, workerGeneration: worker.workerGeneration + 1 } } } },
    { publication: { ...publication, manifest: { ...publication.manifest, pathJailSha256: digest("foreign-jail") } } },
  ] satisfies Partial<AdmitRemoteWorkerChatArtifactInput>[]) {
    assert.throws(() => assignments.admitChatArtifactPublication({ ...admissionInput, ...invalid }, fence));
  }
  assert.throws(() => assignments.admitChatArtifactPublication(admissionInput, { ...fence,
    credentialAuthority: { ...fence.credentialAuthority, workerGeneration: worker.workerGeneration + 1 } }));
  assert.equal(artifacts.getUpload(ref.registryWorkspaceId, ref.assignmentId, ref.assignmentGeneration, upload.uploadId)
    .committedManifestSha256, null);
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
  assert.throws(() => assignments.admitChatArtifactPublication(admissionInput, fence));
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
  assert.throws(() => assignments.admitChatArtifactPublication(admissionInput, fence));
  const rotatedAdmission = assignments.admitChatArtifactPublication({ ...admissionInput,
    leaseTokenSha256: nextToken, expectedLeaseRevision: rotated.lease.leaseRevision }, fence);
  assert.equal(rotatedAdmission.admission.continuingArtifact.leaseRevision, 2);
  assert.equal(continuingArtifact.leaseRevision, 1);
  const rollback = new Error("Controlled artifact authority rollback.");
  const rejectDuring = (mutate: () => void) => {
    assert.throws(() => db.transaction("immediate", () => {
      mutate();
      assert.throws(() => resolve());
      throw rollback;
    }), error => error === rollback);
    assert.equal(resolve().authority.lease.leaseRevision, 2);
  };
  for (const patch of [
    { attemptCount: parent.attemptCount + 1 },
    { status: "completed" as const }, { status: "cancelled" as const },
    { leaseExpiresAt: new Date(Date.parse(continuingArtifact.parentDispatchAuthority.durableRunLeaseExpiresAt) - 1).toISOString() },
    { leaseExpiresAt: "2000-01-01T00:00:00.000Z" },
  ]) rejectDuring(() => {
    const live = runs.getRun(parent.runId);
    runs.updateRun({ runId: live.runId, expectedVersion: live.version, status: live.status, ...patch });
  });
  // Deliberate corrupt-version negative in the mutable durable owner. Lease,
  // upload and manifest expiry are exercised below through valid creation
  // inputs and actual database time, never by rewriting immutable records.
  rejectDuring(() => {
    assert.equal(db.prepare(`UPDATE durable_runs SET version = @version WHERE run_id = @runId`)
      .run({ runId: parent.runId, version: continuingArtifact.parentDispatchAuthority.durableRunVersion - 1 }).changes, 1);
  });
  rejectDuring(() => {
    new RemoteWorkerAdmissionRepository(db).revokeGeneration({ registryWorkspaceId: ref.registryWorkspaceId,
      workerId: worker.workerId, workerGeneration: worker.workerGeneration, reasonCode: "operator_revoked",
      reasonSha256: digest("fixture-revocation"), actorId: "fixture-operator", idempotencyKey: `${seed}:worker-revocation` });
  });
  rejectDuring(() => {
    new RemoteWorkerAdmissionRepository(db).rotateRuntimeCredential({ registryWorkspaceId: ref.registryWorkspaceId,
      workerId: worker.workerId, workerGeneration: worker.workerGeneration,
      expectedCredentialId: fence.credentialAuthority.credentialId,
      expectedCredentialGeneration: fence.credentialAuthority.credentialGeneration,
      verifiedTransportReceiptSha256: digest(`${seed}:rotation-transport`),
      verifiedProofOfPossessionReceiptSha256: digest(`${seed}:rotation-pop`),
      credentialIssuanceProofSha256: digest(`${seed}:rotation-issuance`), expiresInSeconds: 600,
      credentialTokenSha256: digest(`${seed}:rotated-credential`), idempotencyKey: `${seed}:credential-rotation` });
  });
  rejectDuring(() => {
    new RemoteWorkerMeshNodeAdmissionRepository(db).revokeJoinAuthority({
      registryWorkspaceId: ref.registryWorkspaceId, workerId: worker.workerId, workerGeneration: worker.workerGeneration,
      workspaceId: fence.meshAdmission.workspaceId, joinAuthorityGeneration: fence.meshAdmission.joinAuthorityGeneration,
      reasonCode: "operator_revoked", reason: "Controlled fixture revocation", revokedByActorId: "fixture-operator",
      idempotencyKey: `${seed}:mesh-revocation` });
  });
  rejectDuring(() => {
    new MeshCapabilityNodeAdmissionRepository(db).revoke({ workspaceId: fence.meshAdmission.workspaceId,
      nodeId: worker.nodeId, admissionGeneration: worker.nodeAdmissionGeneration, reason: "Controlled fixture revocation",
      revokedByActorId: "fixture-operator", idempotencyKey: `${seed}:node-revocation` });
  });
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
  await verifyNaturalArtifactExpiry(db, seed, worker, fence, publication);
}

/** Independent lease/upload expiry and a valid deadline-capped expiry. No
 * transaction is held across the bounded wait; both backends use their own
 * real database clock. Immutable rows are never updated to manufacture time.
 */
async function verifyNaturalArtifactExpiry(db: DatabaseClient, seed: string,
  worker: Parameters<typeof verifyWorkerArtifactContinuation>[2], fence: RemoteWorkerAssignmentProtectedCommitFence,
  template: RemoteWorkerArtifactPublicationBinding): Promise<void> {
  const assignments = new RemoteWorkerAssignmentRepository(db), artifacts = new RemoteWorkerArtifactRepository(db);
  const runs = new DurableRunRepository(db);
  const scenarios = (["lease", "upload", "deadline"] as const).map(kind => {
    const prepared = prepareChatOfferFixture(db, true, `-expiry-${kind}-${seed}`);
    const deadlineAt = kind === "deadline" ? new Date(Date.parse(runs.readDatabaseNow()) + 4_000).toISOString()
      : prepared.offerInput.deadlineAt;
    const assignment = assignments.scheduleTaskBoundChatOffer({ ...prepared.offerInput, deadlineAt,
      limits: { ...prepared.offerInput.limits, leaseTtlSeconds: kind === "lease" ? 2 : 300 } }).assignment;
    const parent = runs.getRun(prepared.durableRunId);
    const leaseTokenSha256 = digest(`${seed}:${kind}:lease`);
    const started = assignments.startGeneration({ ...worker, registryWorkspaceId: "default", assignmentId: assignment.assignmentId,
      dispatchOwnerId: parent.leaseOwnerId!, durableRunAttempt: parent.attemptCount,
      leaseTokenSha256, idempotencyKey: `${seed}:${kind}:generation` });
    const ref = { registryWorkspaceId: "default", assignmentId: assignment.assignmentId,
      assignmentGeneration: started.generation.assignmentGeneration };
    const expiresAt = kind === "upload" ? new Date(Date.parse(runs.readDatabaseNow()) + 2_000).toISOString()
      : kind === "deadline" ? deadlineAt : new Date(Date.parse(runs.readDatabaseNow()) + 60_000).toISOString();
    const upload = artifacts.openUpload({ ...ref, uploadAttempt: 1, declaredFileCount: 1, declaredTotalBytes: 5,
      stagingRootSha256: digest(`${seed}:${kind}:staging`), expiresAt, idempotencyKey: `${seed}:${kind}:upload` });
    const input: AdmitRemoteWorkerChatArtifactInput = { ...ref, leaseTokenSha256, expectedLeaseRevision: started.lease.leaseRevision,
      uploadId: upload.uploadId, publication: { ...template, idempotencyKey: `${seed}:${kind}:publication`,
        manifest: { ...template.manifest, identity: upload.identity, pathJailSha256: assignment.manifest.pathJailSha256 } } };
    const admitted = assignments.admitChatArtifactPublication(input, fence).admission;
    assert.equal(assignments.resolveActiveChatExecution({ ...ref, continuingArtifact: admitted.continuingArtifact }, fence)
      .authority.lease.leaseRevision, started.lease.leaseRevision);
    return { kind, ref, input, admitted, parent, assignment, started, upload,
      expiresAt: kind === "lease" ? started.lease.expiresAt : kind === "upload" ? upload.expiresAt : deadlineAt };
  });
  const target = Math.max(...scenarios.map(scenario => Date.parse(scenario.expiresAt)));
  const waitDeadline = performance.now() + 10_000;
  let databaseNow = Date.parse(runs.readDatabaseNow());
  while (databaseNow <= target && performance.now() < waitDeadline) {
    await delay(25);
    databaseNow = Date.parse(runs.readDatabaseNow());
  }
  assert.ok(databaseNow > target, "real database time must pass the fixture expiries within the bounded wait");
  for (const scenario of scenarios) {
    assert.ok(Date.parse(scenario.parent.leaseExpiresAt!) > databaseNow);
    if (scenario.kind === "lease") {
      assert.ok(Date.parse(scenario.upload.expiresAt) > databaseNow);
      assert.ok(Date.parse(scenario.assignment.manifest.deadlineAt) > databaseNow);
    } else if (scenario.kind === "upload") {
      assert.ok(Date.parse(scenario.started.lease.expiresAt) > databaseNow);
      assert.ok(Date.parse(scenario.assignment.manifest.deadlineAt) > databaseNow);
    } else {
      // The production lease clock caps the lease at assignment deadline;
      // a later lease would be an invalid fixture. Require the actual deadline
      // guard, which executes before the current-lease lookup, explicitly.
      assert.equal(scenario.started.lease.expiresAt, scenario.assignment.manifest.deadlineAt);
      assert.equal(scenario.upload.expiresAt, scenario.assignment.manifest.deadlineAt);
    }
    const reason = scenario.kind === "lease" ? "remote worker inference current lease" : scenario.kind === "upload"
      ? "remote worker continuing artifact ownership" : "remote worker inference current generation";
    assert.throws(() => assignments.resolveActiveChatExecution({ ...scenario.ref,
      continuingArtifact: scenario.admitted.continuingArtifact }, fence), error => error instanceof ConflictError &&
        error.message === `${reason} conflicts with durable assignment authority.`);
  }
  const expired = scenarios.find(scenario => scenario.kind === "lease")!;
  const recovered = assignments.recoverExpiredAssignment({ registryWorkspaceId: expired.ref.registryWorkspaceId,
    assignmentId: expired.ref.assignmentId, ...worker,
    expectedAssignmentGeneration: expired.ref.assignmentGeneration, expectedLeaseRevision: expired.started.lease.leaseRevision,
    dispatchOwnerId: expired.parent.leaseOwnerId!, durableRunAttempt: expired.parent.attemptCount,
    leaseTokenSha256: digest(`${seed}:replacement-generation`), reasonCode: "lease.expired",
    reasonSha256: digest(`${seed}:replacement-reason`), actorId: "fixture-operator", idempotencyKey: `${seed}:replacement-generation` });
  assert.equal(recovered.generation.assignmentGeneration, expired.ref.assignmentGeneration + 1);
  assert.throws(() => assignments.resolveActiveChatExecution({ ...expired.ref,
    continuingArtifact: expired.admitted.continuingArtifact }, fence));
}
