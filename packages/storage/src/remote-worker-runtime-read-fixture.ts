import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_PROFILE_SCHEMA_VERSION,
  REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION,
  canonicalJsonString,
  remoteWorkerArtifactBlobRelPath,
  remoteWorkerArtifactWorkspaceShard,
  remoteWorkerChatInferenceIdentity,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { RemoteWorkerArtifactRepository } from "./remote-worker-artifact-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { workerBudgetFixture } from "./remote-worker-budget-fixture.js";
import { relatedWorkerBudgetFixture } from "./remote-worker-budget-related-fixture.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { RemoteWorkerEffectRepository } from "./remote-worker-effect-repo.js";
import { RemoteWorkerNonceRepository } from "./remote-worker-nonce-repo.js";
import { RemoteWorkerRuntimeReadRepository } from "./remote-worker-runtime-read-repo.js";

const D = (value: string) => createHash("sha256").update(value).digest("hex");
function withContactClock(db: DatabaseClient, evaluatedAt: string): DatabaseClient {
  return new Proxy(db, { get(target, property) {
    if (property === "prepare") return (sql: string) => {
      const statement = target.prepare(sql);
      if (!sql.includes("MAX(consumed_at) AS last_authenticated_at")) return statement;
      return new Proxy(statement, { get(stmt, method) {
        if (method === "get") return (...args: unknown[]) => ({ ...stmt.get<Record<string, unknown>>(...args), evaluated_at: evaluatedAt });
        const value = Reflect.get(stmt, method);
        return typeof value === "function" ? value.bind(stmt) : value;
      } });
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
function contactFixture(db: DatabaseClient, seed: string) {
  const f = workerBudgetFixture(db, seed);
  const key = { registryWorkspaceId: "default", workerId: f.workerId, workerGeneration: f.workerGeneration };
  const credential = db.prepare(`SELECT credential_id, credential_generation FROM remote_worker_runtime_credentials
    WHERE registry_workspace_id = @registryWorkspaceId AND worker_id = @workerId AND worker_generation = @workerGeneration
    ORDER BY credential_generation DESC LIMIT 1`).get<{ credential_id: string; credential_generation: number }>(key)!;
  const authority = { kind: "credential" as const, ...key, credentialId: credential.credential_id, credentialGeneration: Number(credential.credential_generation) };
  return { ...f, key, authority, nonces: new RemoteWorkerNonceRepository(db) };
}
function readOnly(db: DatabaseClient): DatabaseClient {
  return new Proxy(db, { get(target, property) {
    if (property === "prepare") return (sql: string) => {
      const statement = target.prepare(sql);
      return new Proxy(statement, { get(stmt, method) {
        const value = Reflect.get(stmt, method);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          assert.match(sql.trim(), /^SELECT\b/u);
          assert.doesNotMatch(sql, /FOR UPDATE/iu);
          return value.apply(stmt, args);
        };
      } });
    };
    if (property === "transaction" || property === "exec") return () => { throw new Error("Runtime read attempted a write."); };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

export const remoteWorkerRuntimeReadCases = [
  { name: "reads authenticated contact by worker generation using the database acceptance clock", run(db: DatabaseClient) {
    const f = contactFixture(db, "read-contact");
    const reader = new RemoteWorkerNonceRepository(readOnly(db));
    assert.equal(reader.readContact(f.key).freshness, "not_observed");
    const requestTimestamp = new Date(Date.now() + 30_000).toISOString();
    const input = { authority: f.authority, nonceSha256: D("contact-proof"), timestamp: requestTimestamp,
      expiresAt: new Date(Date.parse(requestTimestamp) + 60_000).toISOString() };
    assert.equal(f.nonces.consume(input), true);
    const contact = reader.readContact(f.key);
    assert.equal(contact.freshness, "recent");
    assert.equal(contact.connectionStatus, "unavailable");
    assert.ok(Date.parse(contact.lastAuthenticatedAt!) < Date.parse(requestTimestamp));
    assert.equal(Date.parse(contact.staleAfter!) - Date.parse(contact.lastAuthenticatedAt!), 60_000);
    assert.ok(Date.parse(contact.staleAfter!) < Date.parse(input.expiresAt));
    assert.equal(f.nonces.consume(input), false);
    assert.equal(reader.readContact(f.key).lastAuthenticatedAt, contact.lastAuthenticatedAt);
    for (const key of [{ ...f.key, registryWorkspaceId: "foreign" }, { ...f.key, workerId: "other" },
      { ...f.key, workerGeneration: f.workerGeneration + 1 }]) assert.equal(reader.readContact(key).freshness, "not_observed");
    for (const [offset, freshness] of [[59_999, "recent"], [60_000, "stale"], [60_001, "stale"]] as const) {
      const evaluatedAt = new Date(Date.parse(contact.lastAuthenticatedAt!) + offset).toISOString();
      assert.equal(new RemoteWorkerNonceRepository(withContactClock(readOnly(db), evaluatedAt)).readContact(f.key).freshness, freshness);
    }
    const rollback = new Date(Date.parse(contact.lastAuthenticatedAt!) - 1).toISOString();
    assert.throws(() => new RemoteWorkerNonceRepository(withContactClock(readOnly(db), rollback)).readContact(f.key));
    const runtime = new RemoteWorkerRuntimeReadRepository(readOnly(db)).findAssignmentRuntime({ registryWorkspaceId: "default", assignmentId: f.assignmentId })!;
    assert.equal(runtime.connectionHealth.owner, "storage.remoteWorkerNonces");
    assert.equal(runtime.connectionHealth.authorityClass, "derived_projection");
    assert.equal(runtime.connectionHealth.value!.lastAuthenticatedAt, contact.lastAuthenticatedAt);
    assert.doesNotMatch(JSON.stringify(runtime.connectionHealth), /credentialId|nonceSha256|requestTimestamp|publicKey|certificate|token_sha/u);
  } },
  { name: "treats pruned authentication evidence as unknown without refreshing or pruning it during reads", async run(db: DatabaseClient) {
    const f = contactFixture(db, "read-contact-pruned");
    const reader = new RemoteWorkerNonceRepository(readOnly(db));
    const timestamp = new Date(Date.now() - 58_000).toISOString();
    const expiresAt = new Date(Date.parse(timestamp) + 60_000).toISOString();
    assert.equal(f.nonces.consume({ authority: f.authority, nonceSha256: D("short-contact-proof"), timestamp, expiresAt }), true);
    const before = reader.readContact(f.key);
    assert.equal(before.freshness, "recent");
    await delay(Math.max(0, Date.parse(expiresAt) - Date.now() + 100));
    const retained = reader.readContact(f.key);
    assert.equal(retained.lastAuthenticatedAt, before.lastAuthenticatedAt);
    assert.equal(retained.freshness, "recent");
    assert.equal(f.nonces.pruneExpired().credential, 1);
    const pruned = reader.readContact(f.key);
    assert.equal(pruned.freshness, "not_observed");
    assert.equal(pruned.lastAuthenticatedAt, null);
    assert.equal(pruned.staleAfter, null);
    assert.equal(pruned.connectionStatus, "unavailable");
  } },
  { name: "retains unattached holds and refuses other workspaces without writing", run(db: DatabaseClient) {
    const f = workerBudgetFixture(db, "read-hold");
    const reader = new RemoteWorkerRuntimeReadRepository(readOnly(db));
    const key = { registryWorkspaceId: "default", assignmentId: f.assignmentId };
    f.budget.createGrant(f.grant, "operator-a");
    const op = f.admit("held");
    const reservation = f.budget.reserve(op)!;
    assert.equal(db.prepare("SELECT budget_reservation_id FROM remote_worker_inference_requests WHERE operation_id = ?")
      .get<{ budget_reservation_id: string | null }>(op.operation.operationId)!.budget_reservation_id, null);
    const result = reader.findAssignmentRuntime(key)!;
    assert.equal(result.usageAndCost.value!.reservedRequests, 2);
    assert.equal(result.usageAndCost.value!.reservedCostMicrousd, reservation.reservedCostMicrousd);
    assert.equal(result.usageAndCost.value!.pendingReservations, 1);
    assert.equal(result.usageAndCost.value!.usage.attemptCount, 0);
    assert.equal(result.usageAndCost.value!.usage.costUsd, undefined);
    assert.equal(result.resourceCell.value, null);
    assert.equal(result.connectionHealth.authorityClass, "derived_projection");
    assert.equal(result.connectionHealth.owner, "storage.remoteWorkerNonces");
    assert.equal(result.connectionHealth.value!.connectionStatus, "unavailable");
    assert.equal(result.connectionHealth.value!.freshness, "not_observed");
    assert.equal(reader.findAssignmentRuntime({ ...key, registryWorkspaceId: "other" }), undefined);
    assert.equal(reader.findAssignmentRuntime({ ...key, assignmentId: "missing" }), undefined);
    assert.throws(() => reader.findAssignmentRuntime({ ...key, assignmentGeneration: 1 } as typeof key));
    assert.equal(f.budget.listGrants("default", "default")[0]!.heldRequests, 2);
    const assignments = new RemoteWorkerAssignmentRepository(db);
    const unstarted = assignments.createAssignment({ manifest: assignments.getAssignment("default", f.assignmentId).manifest,
      createdByActorId: "gateway-a", idempotencyKey: "read-unstarted" }).assignment;
    const pending = reader.findAssignmentRuntime({ ...key, assignmentId: unstarted.assignmentId })!;
    assert.equal(pending.assignmentGeneration, null);
    assert.equal(pending.workerId, null);
    assert.equal(pending.usageAndCost.value, null);
    assert.equal(pending.artifactAndEffects.value, null);
  } },
  { name: "attributes primary and related attempts while preserving partial usage and pending holds", run(db: DatabaseClient) {
    const f = relatedWorkerBudgetFixture(db, "read-usage");
    const reader = new RemoteWorkerRuntimeReadRepository(readOnly(db));
    const key = { registryWorkspaceId: "default", assignmentId: f.assignmentId };
    const primary = f.begin("primary", { operationId: f.op.operation.operationId, dispatchGeneration: f.op.operation.dispatchGeneration, parentOperationId: undefined });
    f.finish(primary.usageEventId, 0);
    const known = f.begin("known");
    const unknown = f.begin("unknown");
    const uncertain = f.begin("uncertain");
    for (const attempt of [known, unknown, uncertain]) f.budget.authorizeRelatedAttempt(attempt);
    f.finish(known.usageEventId, 0.001);
    f.finish(unknown.usageEventId);
    f.usage.markDispatchUnknown(uncertain.usageEventId, "related-owner", f.now, "transport outcome unavailable");
    const foreign = f.begin("unattributed");
    f.finish(foreign.usageEventId, 99);
    const events = f.usage;
    const allAttempts = events.listRemoteWorkerAssignment(key.registryWorkspaceId, key.assignmentId, f.assignmentGeneration);
    assert.deepEqual(allAttempts.map(event => event.eventId).sort(),
      [primary, known, unknown, uncertain].map(attempt => attempt.usageEventId).sort());
    assert.equal(allAttempts.find(event => event.eventId === uncertain.usageEventId)!.transportStatus, "dispatch_unknown");
    assert.deepEqual(events.listRemoteWorkerAssignment("foreign", key.assignmentId, f.assignmentGeneration), []);
    assert.deepEqual(events.listRemoteWorkerAssignment(key.registryWorkspaceId, key.assignmentId, f.assignmentGeneration + 1), []);
    assert.throws(() => events.listRemoteWorkerAssignment(key.registryWorkspaceId, key.assignmentId, 0));
    const projection = reader.findAssignmentRuntime(key)!.usageAndCost.value!;
    assert.equal(projection.usage.attemptCount, 3);
    assert.equal(projection.usage.trackedAttemptCount, 2);
    assert.equal(projection.usage.unknownAttemptCount, 1);
    assert.equal(projection.usage.uncertainDispatchCount, 1);
    assert.equal(projection.usage.costUsd, 0.001);
    assert.equal(projection.usage.inputTokens, 20);
    assert.deepEqual(projection.usage.metricAvailability.costUsd, { knownAttemptCount: 2, unknownAttemptCount: 2, complete: false });
    assert.equal(projection.usage.cachedInputTokens, undefined);
    assert.equal(projection.pendingReservations, 4);
    assert.equal(projection.reservedRequests, 5);
    f.budget.reconcileRelatedAttempts(f.reservation);
    assert.equal(reader.findAssignmentRuntime(key)!.usageAndCost.value!.pendingReservations, 3);
  } },
  { name: "distinguishes the current native model sequence from earlier history without writes", run(db: DatabaseClient) {
    const f = workerBudgetFixture(db, "native-history");
    const scope = { registryWorkspaceId: "default", assignmentId: f.assignmentId,
      assignmentGeneration: f.assignmentGeneration, continuationSha256: D("native-wake") };
    assert.equal(f.repo.hasInferenceOutsideChatSequence(scope), false);
    assert.deepEqual(f.repo.listAssignmentChatRequests(scope), []);
    f.admit("current", f.route, remoteWorkerChatInferenceIdentity(scope, 0));
    f.admit("current-next", f.route, remoteWorkerChatInferenceIdentity(scope, 1));
    assert.equal(f.repo.hasInferenceOutsideChatSequence(scope), false);
    assert.equal(f.repo.hasInferenceOutsideChatSequence({ ...scope, continuationSha256: D("another-wake") }), true);
    f.admit("older", f.route, remoteWorkerChatInferenceIdentity({ ...scope, continuationSha256: undefined }, 0));
    assert.equal(f.repo.listAssignmentChatRequests(scope).length, 3);
    assert.deepEqual(f.repo.listAssignmentChatRequests({ ...scope, registryWorkspaceId: "foreign" }), []);
    assert.deepEqual(f.repo.listAssignmentChatRequests({ ...scope, assignmentGeneration: scope.assignmentGeneration + 1 }), []);
    assert.equal(f.repo.hasInferenceOutsideChatSequence(scope), true);
    assert.equal(f.repo.hasInferenceOutsideChatSequence({ ...scope, registryWorkspaceId: "foreign" }), false);
    assert.equal(f.repo.hasInferenceOutsideChatSequence({ ...scope, assignmentGeneration: scope.assignmentGeneration + 1 }), false);
    for (let i = 0; i < 14; i++) f.admit(`overflow-${i}`);
    assert.throws(() => f.repo.listAssignmentChatRequests(scope), /assignment-wide model step limit/u);
  } },
  { name: "projects cell capacity and committed artifacts without raw paths, profiles or effect arguments", run(db: DatabaseClient) {
    const f = workerBudgetFixture(db, "read-owners");
    const key = { registryWorkspaceId: "default", assignmentId: f.assignmentId };
    const scope = { ...key, assignmentGeneration: f.assignmentGeneration };
    const manifestSha256 = db.prepare("SELECT manifest_sha256 FROM remote_worker_assignments WHERE assignment_id = ?")
      .get<{ manifest_sha256: string }>(f.assignmentId)!.manifest_sha256;
    const capacity = { schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION, logicalDiskBytes: 1_000_000, allocatedDiskBytes: 4_000_000,
      fileLimit: 100, inodeLimit: 200, processLimit: 2, cpuLimitMilli: 1000, wallLimitMs: 60_000, memoryLimitBytes: 64_000_000,
      rawOutputLimitBytes: 65_536, diagnosticLimitBytes: 65_536, artifactCeilingBytes: 65_536, backupStagingBytes: 65_536, backupPublicationBytes: 65_536 };
    const cell = new RemoteWorkerCellRepository(db).profileOrReplay({ createdAt: f.now, idempotencyKey: "read-cell",
      profile: { schemaVersion: REMOTE_WORKER_CELL_PROFILE_SCHEMA_VERSION, ...scope, workerId: f.workerId, workerGeneration: f.workerGeneration,
        cellId: "read-cell", backend: "container", logicalRootSha256: D("root"), assignmentManifestSha256: manifestSha256,
        pathJailSha256: D("jail"), capabilityProfileSha256: D("capability"), contextSnapshotSha256: D("context"), toolEffectPostureSha256: D("posture"),
        runtimeAttestationSha256: D("runtime"), launcherAttestationSha256: D("launcher"), capacity, egressPosture: "allowlisted",
        egressPolicySha256: D("egress"), egressDnsRevision: 1, envAllowlistSha256: D("env") } }).cell;
    const artifacts = new RemoteWorkerArtifactRepository(db);
    const upload = artifacts.openUpload({ ...scope, uploadAttempt: 1, declaredFileCount: 1, declaredTotalBytes: 10,
      stagingRootSha256: D("staging"), expiresAt: "2099-01-01T00:00:00.000Z", idempotencyKey: "read-upload" });
    const reader = new RemoteWorkerRuntimeReadRepository(readOnly(db));
    const before = reader.findAssignmentRuntime(key)!;
    assert.equal(before.resourceCell.value!.cellId, cell.cellId);
    assert.equal(before.resourceCell.value!.executionState, cell.executionState);
    assert.deepEqual(before.resourceCell.value!.capacity, capacity);
    assert.equal(before.artifactAndEffects.value!.uploadCount, 1);
    assert.equal(before.artifactAndEffects.value!.manifestTotalBytes, null);
    const logicalPath = "private-output.txt", blobSha256 = D("blob");
    const logicalPathSha256 = D(canonicalJsonString({ logicalPath }));
    artifacts.appendPart({ ...scope, uploadId: upload.uploadId, idempotencyKey: "read-part",
      part: { globalSequence: 1, logicalPathSha256, filePartIndex: 0, isFinalPart: true, partBytes: 10, partSha256: blobSha256 } });
    artifacts.commitArtifact({ ...scope, uploadId: upload.uploadId, idempotencyKey: "read-commit",
      manifest: { schemaVersion: REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION, identity: upload.identity, pathJailSha256: D("jail"),
        workerClaimIds: ["private-claim"], workerClaimSha256: D("claims"), requiredVerifierProfileSha256: null, fileCount: 1, totalBytes: 10,
        entries: [{ entryIndex: 0, logicalPath, logicalPathSha256, blobSha256, byteCount: 10, mimeType: "text/plain" }] },
      blobs: [{ blobSha256, byteCount: 10, physicalRelPath: remoteWorkerArtifactBlobRelPath(remoteWorkerArtifactWorkspaceShard("default"), blobSha256) }] });
    const effects = new RemoteWorkerEffectRepository(db);
    const intent = effects.recordIntent({ ...scope, intentIndex: 0, effectSelector: "email.send",
      canonicalArgs: { to: "private@example.com" }, workerIdempotencyKey: "read-effect", idempotencyKey: "read-effect" });
    const after = reader.findAssignmentRuntime(key)!;
    assert.equal(after.artifactAndEffects.value!.committedUploadCount, 1);
    assert.equal(after.artifactAndEffects.value!.manifestTotalBytes, 10);
    assert.equal(after.artifactAndEffects.value!.manifestFileCount, 1);
    assert.equal(after.artifactAndEffects.value!.verificationState, "not_required");
    assert.equal(after.artifactAndEffects.value!.effectIntentCount, 1);
    assert.equal(after.artifactAndEffects.value!.effectReceiptCount, 0);
    assert.doesNotMatch(JSON.stringify(after), /private-|private@|profileSha256|nativePlatform|physicalRelPath|leaseToken|canonicalArgs|receipt_json/u);
    const correlation = { schemaVersion: REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION,
      externalSideEffectRunId: null, approvalRecordSha256: null, boundaryReceiptSha256: null,
      hx305OutcomeSha256: null, reconciliationRecordSha256: null, sanitizedError: null };
    for (const transitionState of ["recorded", "dispatch_claimed"] as const) effects.appendTransition({ ...scope, intentId: intent.intentId,
      correlation: { ...correlation, transitionState }, idempotencyKey: `read-effect-${transitionState}` });
    const manual = effects.appendTransition({ ...scope, intentId: intent.intentId,
      correlation: { ...correlation, transitionState: "manual_reconciliation" }, idempotencyKey: "read-effect-manual" });
    effects.recordReceipt({ ...scope, intentId: intent.intentId, receiptState: "manual_reconciliation",
      finalTransitionSequence: manual.transitionSequence, finalTransitionSha256: manual.transitionSha256,
      hx305OutcomeSha256: null, idempotencyKey: "read-effect-receipt" });
    assert.equal(reader.findAssignmentRuntime(key)!.artifactAndEffects.value!.effectReceiptCount, 1);
    assert.equal(reader.findAssignmentRuntime(key)!.artifactAndEffects.value!.effectReconciliationCount, 1);
  } },
  { name: "refuses an assignment generation change during a composed read", run(db: DatabaseClient) {
    const f = workerBudgetFixture(db, "read-race");
    let heads = 0;
    const racing = new Proxy(readOnly(db), { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("SELECT a.manifest_sha256")) return statement;
        return new Proxy(statement, { get(stmt, method) {
          if (method === "get") return (...args: unknown[]) => {
            const row = stmt.get<Record<string, unknown>>(...args)!;
            return ++heads === 2 ? { ...row, assignment_generation: 2 } : row;
          };
          const value = Reflect.get(stmt, method);
          return typeof value === "function" ? value.bind(stmt) : value;
        } });
      };
      return Reflect.get(target, property);
    } });
    assert.throws(() => new RemoteWorkerRuntimeReadRepository(racing).findAssignmentRuntime({ registryWorkspaceId: "default", assignmentId: f.assignmentId }), /generation changed/u);
  } },
];
