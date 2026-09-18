import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it, type TestContext } from "node:test";
import { remoteWorkerAssignmentCanonicalSha256 as digest, normalizeRemoteWorkerNativeContinuation } from "@goatcitadel/contracts";
import { runtimeResultPagesFixture } from "../../contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { RemoteWorkerRuntimeResultRepository } from "./remote-worker-runtime-result-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerChatResumeLedger } from "./remote-worker-chat-resume-ledger.js";
import { ApprovalRepository } from "./approval-repo.js";
import { RemoteWorkerCellProvisioningRepository } from "./remote-worker-cell-provisioning-repo.js";
import type { DatabaseClient } from "./db.js";
import { RemoteWorkerInferenceRepository } from "./remote-worker-inference-repo.js";
import { REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA, remoteWorkerRuntimeOutputEvidenceSha256, remoteWorkerNativeChatContextSha256,
  remoteWorkerChatInferenceIdentity } from "@goatcitadel/contracts";

/** Controlled repository snapshots around the real native binary decoder.
 * Separate SQLite/PostgreSQL resume tests exercise canonical parent storage. */
function fixture(t: TestContext) {
  const f = runtimeResultPagesFixture(2), scope = { registryWorkspaceId: f.history.registryWorkspaceId,
    assignmentId: f.history.assignmentId, assignmentGeneration: f.history.assignmentGeneration };
  const manifest = { durableRunId: "parent", executionWorkspaceId: "workspace", sessionId: "session", turnId: "turn", taskId: "task" };
  const approval = { approvalId: "approval", kind: "remote_worker.native_runtime", status: "approved", riskLevel: "danger",
    payload: { nativeRuntime: { expectation: f.expectation } }, linkage: { workspaceId: "workspace", sessionId: "session", turnId: "turn", taskId: "task", durableRunId: "parent" } };
  const continuation = normalizeRemoteWorkerNativeContinuation({ schemaVersion: "goatcitadel.remote-worker-native-continuation.v1", assignmentGeneration: scope.assignmentGeneration,
    resumeSha256: digest("resume"), approvalId: approval.approvalId, approvalSha256: digest(approval), nativeRuntimeBindingSha256: digest(approval.payload.nativeRuntime), decision: "approved" });
  const resume = { materialSha256: continuation.resumeSha256, material: { schemaVersion: "goatcitadel.remote-worker-native-runtime-resume.v1",
    durableRunId: "parent", approvalId: approval.approvalId, approvalSha256: continuation.approvalSha256, nativeRuntimeBindingSha256: continuation.nativeRuntimeBindingSha256 } };
  const admission = { expectation_json: JSON.stringify(f.expectation), approval_id: approval.approvalId, plan_sha256: f.history.planSha256, lease_revision: f.history.leaseRevision };
  const result = { result_hex: f.resultHex, result_sha256: f.resultSha256, lease_revision: f.history.leaseRevision, recorded_at: "2026-09-14T00:00:00.000Z" };
  const outputState: { row?: { evidence_json: string; evidence_sha256: string; result_sha256: string; lease_revision: number; recorded_at: string } } = {};
  const priorRequest = t.mock.method(RemoteWorkerInferenceRepository.prototype, "getRequestByIdempotency", () => undefined);
  const queries: string[] = [];
  const db = { transaction: (_mode: string, work: () => unknown) => work(), prepare: (sql: string) => ({ get: (params: unknown) => {
    queries.push(sql); assert.deepEqual(params, { ...scope, nonce: f.expectation.nonce });
    if (sql.startsWith("SELECT * FROM remote_worker_runtime_expectations WHERE")) return admission;
    if (sql.startsWith("SELECT * FROM remote_worker_runtime_results WHERE")) return result;
    if (sql.startsWith("SELECT * FROM remote_worker_runtime_output_evidence WHERE")) return outputState.row;
    throw new Error("Unexpected parent read query");
  } }) } as unknown as DatabaseClient;
  t.mock.method(RemoteWorkerAssignmentRepository.prototype, "findAssignmentAggregate", () => ({ assignment: { manifest }, generation: { assignmentGeneration: scope.assignmentGeneration } }));
  t.mock.method(ApprovalRepository.prototype, "get", () => approval);
  const readResume = t.mock.method(RemoteWorkerChatResumeLedger.prototype, "readLatest", () => resume);
  const records = (rows: readonly string[] | undefined) => (rows ?? []).map(recordHex => ({ recordHex }));
  const snapshot = { plan: { plan: f.history.plan, planSha256: f.history.planSha256 }, checkpoints: records(f.history.records),
    volumeCheckpoints: records(f.history.volumeRecords), formatCheckpoints: records(f.history.formatRecords), protectionCheckpoints: records(f.history.protectionRecords),
    mountCheckpoints: records(f.history.mountRecords), mountedWorkspaceCheckpoints: records(f.history.mountedWorkspaceRecords) };
  t.mock.method(RemoteWorkerCellProvisioningRepository.prototype, "getSnapshot", () => snapshot);
  const retainOutput = () => {
    const stream = { bytes: 0, sha256: createHash("sha256").update("").digest("hex"), text: "", truncated: false, provenance: "native_stream_local_diagnostic" as const };
    const evidence = { schemaVersion: REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA, nonce: f.expectation.nonce, requestSha256: f.expectation.requestSha256,
      resultSha256: f.resultSha256, streams: { stdout: stream, stderr: stream } };
    outputState.row = { evidence_json: JSON.stringify(evidence), evidence_sha256: remoteWorkerRuntimeOutputEvidenceSha256(evidence),
      result_sha256: f.resultSha256, lease_revision: result.lease_revision, recorded_at: result.recorded_at };
    return evidence;
  };
  return { ...f, approval, continuation, admission, result, resume, readResume, snapshot, queries, outputState, priorRequest, retainOutput,
    owner: new RemoteWorkerRuntimeResultRepository(db),
    input: { ...scope, durableRunId: "parent", continuation } };
}
it("decodes retained nonzero native facts for the parent without reading or renewing a worker lease", t => {
  const f = fixture(t), read = f.owner.readForChatContinuation(f.input);
  assert.equal(read.recorded!.result.exitCode, 23); assert.equal(read.recorded!.result.inventory!.entries.length, 6);
  assert.equal(read.recorded!.result.resultSha256, f.resultSha256); assert.equal(read.recorded!.leaseRevision, f.history.leaseRevision);
  assert.equal(f.queries.length, 2); assert.ok(Object.isFrozen(read));
  const chat = f.owner.readChatContextForParent(f.input);
  assert.equal(chat!.recorded!.outcome.exitCode, 23);
  assert.equal(chat!.recorded!.receipt.resultSha256, f.resultSha256);
  assert.deepEqual(chat!.continuation, f.continuation);
});
it("exposes only retained output in a versioned parent context without renewing authority", t => {
  const f = fixture(t), evidence = f.retainOutput();
  const chat = f.owner.readChatContextForParent(f.input)!;
  assert.equal(chat.schemaVersion, "goatcitadel.remote-worker-native-chat-context.v2");
  if (chat.schemaVersion !== "goatcitadel.remote-worker-native-chat-context.v2") throw new Error("Expected output context");
  assert.deepEqual(chat.output, evidence); assert.equal(chat.recorded!.outcome.exitCode, 23);
  assert.ok(f.queries.every(query => query.startsWith("SELECT * FROM remote_worker_runtime_")));
});
it("preserves a previously started metadata-only sequence when output arrives later", t => {
  const f = fixture(t), legacy = f.owner.readChatContextForParent(f.input)!;
  const identity = remoteWorkerChatInferenceIdentity({ registryWorkspaceId: f.input.registryWorkspaceId, assignmentId: f.input.assignmentId,
    assignmentGeneration: f.input.assignmentGeneration, continuationSha256: remoteWorkerNativeChatContextSha256(legacy) }, 0);
  f.retainOutput();
  f.priorRequest.mock.mockImplementation(() => ({ ...f.input, inferenceRequestId: identity.inferenceRequestId }) as never);
  assert.deepEqual(f.owner.readChatContextForParent(f.input), legacy);
});
it("snapshots parent scope before reading retained output", t => {
  const f = fixture(t); f.retainOutput();
  f.priorRequest.mock.mockImplementation(() => { f.input.assignmentId = "changed-caller"; return undefined; });
  assert.equal(f.owner.readChatContextForParent(f.input)!.schemaVersion, "goatcitadel.remote-worker-native-chat-context.v2");
});
for (const mode of ["hash", "result", "nonce", "revision", "time", "changed_parent", "foreign_prior"]) it(`refuses retained output with ${mode} drift`, t => {
  const f = fixture(t), evidence = f.retainOutput(), row = f.outputState.row!;
  if (mode === "hash") row.evidence_sha256 = "ff".repeat(32);
  if (mode === "result") row.result_sha256 = "ff".repeat(32);
  if (mode === "nonce") row.evidence_json = JSON.stringify({ ...evidence, nonce: "ff".repeat(32) });
  if (mode === "revision") row.lease_revision = 0;
  if (mode === "time") row.recorded_at = "2020-01-01T00:00:00.000Z";
  if (mode === "changed_parent") f.priorRequest.mock.mockImplementation(() => { f.resume.materialSha256 = "ff".repeat(32); return undefined; });
  if (mode === "foreign_prior") f.priorRequest.mock.mockImplementation(() => ({ assignmentId: "foreign" }) as never);
  assert.throws(() => f.owner.readChatContextForParent(f.input));
});
for (const mode of ["approval", "expectation", "digest", "lease", "date", "plan", "history", "changed_parent"]) it(`withholds retained parent result on changed ${mode}`, t => {
  const f = fixture(t);
  if (mode === "approval") f.admission.approval_id = "foreign";
  if (mode === "expectation") f.admission.expectation_json = JSON.stringify({ ...f.expectation, requestSha256: "ff".repeat(32) });
  if (mode === "digest") f.result.result_sha256 = "ff".repeat(32);
  if (mode === "lease") f.admission.lease_revision = f.result.lease_revision + 1;
  if (mode === "date") f.result.recorded_at = "2026-02-30T00:00:00.000Z";
  if (mode === "plan") f.admission.plan_sha256 = "ff".repeat(32);
  if (mode === "history") f.snapshot.mountedWorkspaceCheckpoints = [];
  if (mode === "changed_parent") f.readResume.mock.mockImplementationOnce(() => ({ ...f.resume, materialSha256: "ff".repeat(32) }), 1);
  assert.throws(() => f.owner.readForChatContinuation(f.input));
});
