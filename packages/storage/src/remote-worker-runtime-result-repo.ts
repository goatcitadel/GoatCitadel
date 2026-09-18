import { canonicalJsonString, normalizeRemoteWorkerRuntimeResultExpectation, readRemoteWorkerRuntimeResult,
  normalizeRemoteWorkerCellProvisioningHistory, type RemoteWorkerCellProvisioningHistory,
  remoteWorkerCellProvisioningMountedWorkspaceAnchor, readRemoteWorkerCellMountedWorkspaceCheckpoint,
  type RemoteWorkerRuntimeResultExpectation, type RemoteWorkerRuntimeResult, type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";
import { createRemoteWorkerNativeFileExportSelection, normalizeRemoteWorkerNativeFileExportSelection,
  type RemoteWorkerNativeFileExportSelection } from "@goatcitadel/contracts";
import { readRemoteWorkerNativeFileContent, type RemoteWorkerNativeFileContent } from "@goatcitadel/contracts";
import { normalizeRemoteWorkerNativeFileStaging, normalizeRemoteWorkerNativeFileDisclosure, remoteWorkerNativeFileStagingSha256,
  REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { normalizeRemoteWorkerRuntimeOutputEvidence, verifyRemoteWorkerRuntimeOutputEvidence,
  remoteWorkerRuntimeOutputEvidenceSha256, redactSecretText, type RemoteWorkerRuntimeOutputEvidence } from "@goatcitadel/contracts";
import { ApprovalRepository } from "./approval-repo.js";
import { RemoteWorkerChatResumeLedger } from "./remote-worker-chat-resume-ledger.js";
import { RemoteWorkerCellProvisioningRepository } from "./remote-worker-cell-provisioning-repo.js";
import { normalizeRemoteWorkerNativeContinuation, normalizeRemoteWorkerCellProvisioningExchange,
  REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION, remoteWorkerAssignmentCanonicalSha256,
  type RemoteWorkerNativeContinuation } from "@goatcitadel/contracts";
import { normalizeRemoteWorkerNativeChatContext, projectRemoteWorkerRuntimeOutcome, type RemoteWorkerNativeChatContext } from "@goatcitadel/contracts";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerInferenceRepository } from "./remote-worker-inference-repo.js";
import { remoteWorkerNativeChatContextSha256, remoteWorkerChatInferenceIdentity } from "@goatcitadel/contracts";
import { normalizeRemoteWorkerRuntimeReadKey, normalizeRemoteWorkerRuntimeOutputArtifact, REMOTE_WORKER_RUNTIME_OUTPUT_ARTIFACT_SCHEMA,
  type RemoteWorkerRuntimeOutputArtifact } from "@goatcitadel/contracts";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { assertNativeRuntimeChatResume } from "./remote-worker-native-runtime-resume-admission.js";
import { snapshotRemoteWorkerCellCapacityAuthority } from "./remote-worker-cell-capacity-admission-repo.js";
import { RemoteWorkerCellCapacityStore, type RemoteWorkerCellCapacityAssignmentInput } from "./remote-worker-cell-capacity-store.js";
import { RemoteWorkerCellRepository, RemoteWorkerCellConflictError } from "./remote-worker-cell-repo.js";
import { REMOTE_WORKER_CAPACITY_POSTGRES_CLOCK, REMOTE_WORKER_CAPACITY_SQLITE_CLOCK } from "./remote-worker-cell-capacity-observation-schema.js";
import { normalizeRemoteWorkerRuntimeResultSubmission, normalizeRemoteWorkerRuntimeResultExchange,
  REMOTE_WORKER_RUNTIME_RESULT_EXCHANGE_SCHEMA_VERSION, type RemoteWorkerRuntimeResultSubmission,
  type RemoteWorkerRuntimeResultExchange } from "@goatcitadel/contracts";

export type RemoteWorkerRuntimeResultAuthority = Omit<RemoteWorkerCellCapacityAssignmentInput, "submission">;
type Scope = Pick<RemoteWorkerRuntimeResultAuthority, "registryWorkspaceId" | "assignmentId" | "assignmentGeneration">;
export interface RemoteWorkerRuntimeResultPageAssignmentInput extends RemoteWorkerRuntimeResultAuthority {
  readonly submission: RemoteWorkerRuntimeResultSubmission;
}
export interface RemoteWorkerRuntimeResultRecord {
  readonly expectation: RemoteWorkerRuntimeResultExpectation;
  readonly result: RemoteWorkerRuntimeResult;
  readonly leaseRevision: number;
  readonly recordedAt: string;
}
type ExpectationRow = { expectation_json: string; plan_sha256: string; execution_revision: number; cleanup_revision: number; lease_revision: number; approval_id: string | null };
type ResultRow = { result_hex: string; result_sha256: string; lease_revision: number; recorded_at: string };
type OutputRow = { evidence_json: string; evidence_sha256: string; result_sha256: string; lease_revision: number; recorded_at: string };
export interface RemoteWorkerRuntimeOutputRecord {
  readonly evidence: RemoteWorkerRuntimeOutputEvidence;
  readonly evidenceSha256: string;
  readonly leaseRevision: number;
  readonly recordedAt: string;
}
type StagingRow = { request_sha256: string; result_sha256: string; byte_length: number; prefix_hex: string;
  lease_revision: number; execution_revision: number; cleanup_revision: number };
const WHERE = "registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration";
const conflict = () => new RemoteWorkerCellConflictError("Native runtime retention requires the exact protected request and current cell authority.");

/** Internal execution-owner admission and immutable result retention. Do not
 * expose retainExpectationForAssignment through worker-controlled RPC. This
 * store neither transitions a cell nor authorizes a request on its own. */
export class RemoteWorkerRuntimeResultRepository {
  private readonly history: RemoteWorkerCellCapacityStore;
  private readonly cells: RemoteWorkerCellRepository;
  public constructor(private readonly db: DatabaseClient) {
    this.history = new RemoteWorkerCellCapacityStore(db); this.cells = new RemoteWorkerCellRepository(db);
  }

  /** Request-specific authority observation, not a launch reservation. The native
   * helper must still enforce its one-attempt intent ledger. An absent result
   * never establishes that the request has not already executed. */
  public authorizeForAssignment(input: RemoteWorkerRuntimeResultAuthority & {
    nonce: string; requestSha256: string; phase: "execution" | "delivery";
  }): RemoteWorkerRuntimeResultExpectation {
    const command = snapshotRemoteWorkerCellCapacityAuthority(input), nonce = this.nonce(input.nonce);
    const requestSha256 = input.requestSha256, phase = input.phase;
    if (!/^[0-9a-f]{64}$/u.test(requestSha256) || !["execution", "delivery"].includes(phase)) throw conflict();
    return this.db.transaction("immediate", () => {
      // The association is immutable. Read it before taking approval ->
      // credential -> mesh -> assignment -> cell locks, as admission does.
      const admission = this.expectation(command, nonce);
      if (!admission?.approval_id) throw conflict();
      const approvalId = admission.approval_id;
      const approvals = new ApprovalRepository(this.db), approval = approvals.lockApprovedForUpdate(approvalId);
      return this.fenced(command, (authority, history) => {
        const expected = this.loadExpectation(authority, nonce, history), cell = this.cells.getCell(authority)!;
        const assignments = new RemoteWorkerAssignmentRepository(this.db);
        const manifest = assignments.resolveActiveAuthorityByLeaseTokenHash(command.leaseTokenSha256, command.protectedAuthority)?.assignment.manifest;
        this.assertExecution(authority, admission);
        if (!manifest || expected.requestSha256 !== requestSha256 || cell.nativePlatform?.backend !== "windows_native" ||
            cell.nativePlatform.runtimeBundleSha256 !== expected.runtimeBundleSha256 || cell.cleanupState !== "not_started" ||
            !["disabled", "verified", "restored"].includes(cell.backupState) ||
            (phase === "execution" && this.result(authority, nonce))) throw conflict();
        const binding = { schemaVersion: "goatcitadel.native-runtime-approval.v1", ...this.key(command),
          profileSha256: cell.profileSha256, expectation: expected,
          expectedCapacityRevision: cell.capacityRevision - 1, expectedExecutionRevision: admission.execution_revision - 1,
          expectedCleanupRevision: admission.cleanup_revision, expectedBackupRevision: cell.backupRevision };
        const current = approvals.lockApprovedForUpdate(approvalId), now = Date.parse(new DurableRunRepository(this.db).readDatabaseNow());
        const created = Date.parse(current.createdAt), resolved = Date.parse(current.resolvedAt ?? ""), expiry = Date.parse(current.expiresAt ?? "");
        if (current.kind !== "remote_worker.native_runtime" || !["danger", "nuclear"].includes(current.riskLevel) ||
            !Number.isFinite(created) || !Number.isFinite(resolved) || !Number.isFinite(expiry) ||
            created > resolved || resolved > now || expiry <= now || !current.resolvedBy?.trim() ||
            current.linkage?.workspaceId !== manifest.executionWorkspaceId || current.linkage.taskId !== manifest.taskId ||
            current.linkage.durableRunId !== manifest.durableRunId || current.linkage.sessionId !== manifest.sessionId ||
            current.linkage.turnId !== manifest.turnId || current.linkage.actionType !== "remote_worker.native_runtime" ||
            canonicalJsonString(current.payload.nativeRuntime) !== canonicalJsonString(binding) ||
            canonicalJsonString(current) !== canonicalJsonString(approval)) throw conflict();
        if (manifest.sessionId || manifest.turnId) assertNativeRuntimeChatResume(assignments, command, command.protectedAuthority, current);
        return expected;
      });
    });
  }

  /** Worker-facing transport: expectations can only be read, never supplied or
   * created here. Partial pages cannot produce a retained-result receipt. */
  public exchangePageForAssignment(input: RemoteWorkerRuntimeResultPageAssignmentInput): RemoteWorkerRuntimeResultExchange {
    const submission = normalizeRemoteWorkerRuntimeResultSubmission(input.submission);
    return this.fenced(input, (authority, history) => {
      const expected = this.loadExpectation(authority, submission.nonce, history);
      if (expected.requestSha256 !== submission.requestSha256) throw conflict();
      let row = this.result(authority, submission.nonce), accepted: RemoteWorkerRuntimeResultExchange["accepted"] = null;
      if (submission.kind === "runtime.result.page") {
        if (row) {
          const saved = this.decode(row, expected, history);
          if (saved.result.resultSha256 !== submission.resultSha256 || saved.result.byteLength !== submission.byteLength ||
              row.result_hex.slice(submission.offset * 2, submission.offset * 2 + submission.bytesHex.length) !== submission.bytesHex) throw conflict();
          accepted = { page: submission, nextOffset: submission.byteLength };
        } else {
          const admission = this.expectation(authority, submission.nonce)!, cell = this.cells.getCell(authority)!;
          this.assertExecution(authority, admission);
          const params = { ...this.key(authority), nonce: submission.nonce };
          const stage = this.db.prepare(`SELECT * FROM remote_worker_runtime_result_staging WHERE ${WHERE} AND nonce = @nonce`).get<StagingRow>(params);
          let prefix = stage?.prefix_hex ?? "";
          if (stage) {
            if (stage.request_sha256 !== submission.requestSha256 || stage.result_sha256 !== submission.resultSha256 || stage.byte_length !== submission.byteLength ||
                prefix.length < 65536 || prefix.length % 65536 || prefix.length >= submission.byteLength * 2 || !/^[0-9a-f]+$/u.test(prefix)) throw conflict();
            if (stage.lease_revision !== authority.leaseRevision || stage.execution_revision !== cell.executionRevision || stage.cleanup_revision !== cell.cleanupRevision) {
              if (submission.offset !== 0) throw conflict(); prefix = "";
            }
          }
          const offset = submission.offset * 2;
          if (offset > prefix.length) throw conflict();
          if (offset < prefix.length) {
            if (prefix.slice(offset, offset + submission.bytesHex.length) !== submission.bytesHex) throw conflict();
          } else prefix += submission.bytesHex;
          if (prefix.length === submission.byteLength * 2) {
            const decoded = readRemoteWorkerRuntimeResult(prefix, expected, history);
            if (decoded.resultSha256 !== submission.resultSha256) throw conflict();
            this.retainForAssignment({ ...authority, nonce: submission.nonce, resultHex: prefix });
            this.db.prepare(`DELETE FROM remote_worker_runtime_result_staging WHERE ${WHERE} AND nonce = @nonce`).run(params);
            row = this.result(authority, submission.nonce); if (!row) throw conflict();
          } else {
            this.db.prepare(`INSERT INTO remote_worker_runtime_result_staging
              (registry_workspace_id, assignment_id, assignment_generation, nonce, request_sha256, result_sha256, byte_length, lease_revision, execution_revision, cleanup_revision, prefix_hex)
              VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @nonce, @requestSha256, @resultSha256, @byteLength, @leaseRevision, @executionRevision, @cleanupRevision, @prefix)
              ON CONFLICT (registry_workspace_id, assignment_id, assignment_generation, nonce) DO UPDATE SET
                prefix_hex = excluded.prefix_hex, lease_revision = excluded.lease_revision,
                execution_revision = excluded.execution_revision, cleanup_revision = excluded.cleanup_revision`)
              .run({ ...params, requestSha256: submission.requestSha256, resultSha256: submission.resultSha256, byteLength: submission.byteLength,
                leaseRevision: authority.leaseRevision, executionRevision: cell.executionRevision, cleanupRevision: cell.cleanupRevision, prefix });
          }
          accepted = { page: submission, nextOffset: prefix.length / 2 };
        }
      }
      const saved = row ? this.decode(row, expected, history) : null;
      return normalizeRemoteWorkerRuntimeResultExchange({ schemaVersion: REMOTE_WORKER_RUNTIME_RESULT_EXCHANGE_SCHEMA_VERSION,
        ...this.key(authority), leaseRevision: authority.leaseRevision, nonce: expected.nonce, requestSha256: expected.requestSha256,
        record: saved ? { resultSha256: saved.result.resultSha256, byteLength: saved.result.byteLength,
          leaseRevision: saved.leaseRevision, recordedAt: saved.recordedAt } : null, accepted });
    });
  }

  /** Called only after the canonical execution owner admits exact executable
   * bytes and moves the cell to starting, before those bytes are dispatched. */
  public retainExpectationForAssignment(input: RemoteWorkerRuntimeResultAuthority & {
    expectedExecutionRevision: number; expectation: RemoteWorkerRuntimeResultExpectation; approvalId?: string;
  }): RemoteWorkerRuntimeResultExpectation {
    const expected = normalizeRemoteWorkerRuntimeResultExpectation(input.expectation), revision = input.expectedExecutionRevision;
    const approvalId = input.approvalId ?? null;
    if (approvalId !== null && (typeof approvalId !== "string" || !approvalId.length || approvalId.length > 200 || approvalId.trim() !== approvalId)) throw conflict();
    return this.fenced(input, (authority, history) => {
      const cell = this.cells.getCell(authority)!;
      this.assertExpectationHistory(expected, history);
      if (cell.executionState !== "starting" || cell.executionRevision !== revision || cell.nativePlatform?.backend !== "windows_native" ||
          cell.nativePlatform.runtimeBundleSha256 !== expected.runtimeBundleSha256) throw conflict();
      const expectationJson = JSON.stringify(expected), row = this.expectation(authority, expected.nonce);
      if (row) {
        if (row.expectation_json !== expectationJson || row.execution_revision !== revision || row.cleanup_revision !== cell.cleanupRevision || row.plan_sha256 !== history.planSha256 || row.approval_id !== approvalId) throw conflict();
        return expected;
      }
      this.db.prepare(`INSERT INTO remote_worker_runtime_expectations
        (registry_workspace_id, assignment_id, assignment_generation, nonce, expectation_json, plan_sha256, execution_revision, cleanup_revision, lease_revision, approval_id, recorded_at)
        VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @nonce, @expectationJson, @planSha256, @executionRevision, @cleanupRevision, @leaseRevision, @approvalId, ${this.clock()})`)
        .run({ ...this.key(authority), nonce: expected.nonce, expectationJson, planSha256: history.planSha256,
          executionRevision: revision, cleanupRevision: cell.cleanupRevision, leaseRevision: authority.leaseRevision, approvalId });
      return expected;
    });
  }

  /** Complete historical metadata for native cleanup reconciliation. This does
   * not select executable bytes, renew an approval, or authorize another run.
   * Over-limit sets refuse rather than presenting a truncated set as complete. */
  public readCleanupExpectationsForAssignment(input: RemoteWorkerRuntimeResultAuthority) {
    return this.fenced(input, (authority, history) => {
      const rows = this.db.prepare(`SELECT * FROM remote_worker_runtime_expectations WHERE ${WHERE} ORDER BY nonce ASC LIMIT 1001`)
        .all<ExpectationRow & { nonce: string }>(this.key(authority));
      if (rows.length > 1000) throw conflict();
      const expectations = rows.map(row => this.decodeExpectation(row, authority, this.nonce(row.nonce), history));
      return Object.freeze({ history, expectations: Object.freeze(expectations) });
    });
  }

  /** Internal complete-pool historical read. The caller must derive the scope
   * and history from retained pool membership inside its protected transaction.
   * Old attempts do not acquire the active assignment's lease or approvals.
   * Never expose this scope-selected read directly as a worker RPC. */
  public readRetainedCleanupForPool(input: Scope, retained: RemoteWorkerCellProvisioningHistory | null) {
    const scope = this.key(input), history = retained ? normalizeRemoteWorkerCellProvisioningHistory(retained) : null;
    const rows = this.db.prepare(`SELECT * FROM remote_worker_runtime_expectations WHERE ${WHERE} ORDER BY nonce ASC LIMIT 1001`)
      .all<ExpectationRow & { nonce: string }>(scope);
    if (rows.length > 1000) throw conflict();
    return Object.freeze(rows.map(row => {
      if (!history || history.mountedWorkspaceRecords?.length !== 2 || row.plan_sha256 !== history.planSha256 ||
          !Number.isSafeInteger(row.lease_revision) || row.lease_revision < 1) throw conflict();
      const expected = normalizeRemoteWorkerRuntimeResultExpectation(JSON.parse(row.expectation_json));
      if (expected.nonce !== this.nonce(row.nonce) || expected.checkpointSha256 !== history.mountedWorkspaceRecords[1]!.slice(-64)) throw conflict();
      return expected;
    }));
  }

  /** Lost responses are recovered by exact nonce lookup; never rerun a command
   * to obtain another result. This read cannot create an expectation. */
  public findForAssignment(input: RemoteWorkerRuntimeResultAuthority & { nonce: string }): RemoteWorkerRuntimeResultRecord | null {
    const nonce = this.nonce(input.nonce);
    return this.fenced(input, (authority, history) => {
      const expected = this.loadExpectation(authority, nonce, history), row = this.result(authority, nonce);
      return row ? this.decode(row, expected, history) : null;
    });
  }

  /** Canonical parent-side historical read, not worker execution authority.
   * The Chat owner must already authorize its durable run and retain its write
   * fence when consuming this snapshot. No live worker lease is manufactured,
   * renewed or required to inspect an immutable result after worker shutdown.
   * Never expose this method as a worker-controlled RPC. */
  public readForChatContinuation(input: Scope & { durableRunId: string; continuation: RemoteWorkerNativeContinuation }): {
    continuation: RemoteWorkerNativeContinuation; recorded: RemoteWorkerRuntimeResultRecord | null;
  } {
    const scope = Object.freeze(this.key(input)), continuation = normalizeRemoteWorkerNativeContinuation(input.continuation);
    const durableRunId = input.durableRunId;
    if (typeof durableRunId !== "string" || !durableRunId.trim() || continuation.assignmentGeneration !== scope.assignmentGeneration) throw conflict();
    return this.db.transaction("immediate", () => {
      const validate = () => {
        const aggregate = new RemoteWorkerAssignmentRepository(this.db).findAssignmentAggregate(scope.registryWorkspaceId, scope.assignmentId);
        const manifest = aggregate?.assignment.manifest;
        const resume = new RemoteWorkerChatResumeLedger(this.db).readLatest(scope.registryWorkspaceId, scope.assignmentId, scope.assignmentGeneration);
        const approval = new ApprovalRepository(this.db).get(continuation.approvalId);
        if (!manifest || aggregate?.generation?.assignmentGeneration !== scope.assignmentGeneration || manifest.durableRunId !== durableRunId ||
            !resume || resume.material.schemaVersion !== "goatcitadel.remote-worker-native-runtime-resume.v1" ||
            resume.material.durableRunId !== durableRunId || resume.materialSha256 !== continuation.resumeSha256 ||
            resume.material.approvalId !== continuation.approvalId || resume.material.approvalSha256 !== continuation.approvalSha256 ||
            resume.material.nativeRuntimeBindingSha256 !== continuation.nativeRuntimeBindingSha256 ||
            approval.kind !== "remote_worker.native_runtime" || approval.status !== continuation.decision ||
            remoteWorkerAssignmentCanonicalSha256(approval) !== continuation.approvalSha256 ||
            remoteWorkerAssignmentCanonicalSha256(approval.payload.nativeRuntime) !== continuation.nativeRuntimeBindingSha256 ||
            approval.linkage?.workspaceId !== manifest.executionWorkspaceId || approval.linkage.taskId !== manifest.taskId ||
            approval.linkage.durableRunId !== durableRunId || approval.linkage.sessionId !== manifest.sessionId || approval.linkage.turnId !== manifest.turnId)
          throw conflict();
        return approval;
      };
      const approval = validate();
      const expected = normalizeRemoteWorkerRuntimeResultExpectation((approval.payload.nativeRuntime as Record<string, unknown>).expectation);
      const admission = this.expectation(scope, expected.nonce), row = this.result(scope, expected.nonce);
      if (continuation.decision === "rejected") {
        if (admission || row) throw conflict();
        validate(); return Object.freeze({ continuation, recorded: null });
      }
      if (!admission) {
        if (row) throw conflict();
        validate(); return Object.freeze({ continuation, recorded: null });
      }
      if (admission.approval_id !== approval.approvalId ||
          canonicalJsonString(normalizeRemoteWorkerRuntimeResultExpectation(JSON.parse(admission.expectation_json))) !== canonicalJsonString(expected)) throw conflict();
      if (!row) { validate(); return Object.freeze({ continuation, recorded: null }); }
      const recorded = this.decodeRetainedResult(scope, admission, row, expected);
      validate(); return Object.freeze({ continuation, recorded });
    });
  }

  /** Internal operator read: the caller must authorize access to the registry
   * workspace. This never grants worker execution, delivery or model authority.
   * Historical generations remain inspectable after revocation and shutdown. */
  public readOutputArtifactForOperator(input: Scope & { nonce: string }): RemoteWorkerRuntimeOutputArtifact | null {
    const scope = this.operatorScope(input), nonce = this.nonce(input.nonce);
    return this.db.transaction("immediate", () => {
      const row = this.output(scope, nonce);
      if (!row) return null;
      const admission = this.expectation(scope, nonce), native = this.result(scope, nonce);
      if (!admission || !native) throw conflict();
      const expected = normalizeRemoteWorkerRuntimeResultExpectation(JSON.parse(admission.expectation_json));
      if (expected.nonce !== nonce) throw conflict();
      const result = this.decodeRetainedResult(scope, admission, native, expected), output = this.decodeOutput(row, result);
      return normalizeRemoteWorkerRuntimeOutputArtifact({ schemaVersion: REMOTE_WORKER_RUNTIME_OUTPUT_ARTIFACT_SCHEMA,
        ...scope, expectation: result.expectation, resultReceipt: { resultSha256: result.result.resultSha256,
          byteLength: result.result.byteLength, leaseRevision: result.leaseRevision, recordedAt: result.recordedAt },
        outcome: projectRemoteWorkerRuntimeOutcome(result.result), output: output.evidence, evidenceSha256: output.evidenceSha256,
        recordedLeaseRevision: output.leaseRevision, recordedAt: output.recordedAt });
    });
  }

  /** Bounded discovery; exact nonce reads can still inspect older retained rows. */
  public listOutputArtifactNoncesForOperator(input: Scope): { nonces: readonly string[]; truncated: boolean } {
    const scope = this.operatorScope(input);
    const rows = this.db.prepare(`SELECT nonce FROM remote_worker_runtime_output_evidence WHERE ${WHERE} ORDER BY recorded_at DESC, nonce DESC LIMIT 33`)
      .all<{ nonce: string }>(scope);
    return Object.freeze({ nonces: Object.freeze(rows.slice(0, 32).map(row => this.nonce(row.nonce))), truncated: rows.length > 32 });
  }

  private operatorScope(input: Scope): Scope {
    const scope = normalizeRemoteWorkerRuntimeReadKey({ registryWorkspaceId: input.registryWorkspaceId, assignmentId: input.assignmentId });
    const assignmentGeneration = input.assignmentGeneration;
    if (!Number.isSafeInteger(assignmentGeneration) || assignmentGeneration < 1 || assignmentGeneration > 2147483647) throw conflict();
    return Object.freeze({ ...scope, assignmentGeneration });
  }

  private decodeRetainedResult(scope: Scope, admission: ExpectationRow, row: ResultRow, expected: RemoteWorkerRuntimeResultExpectation): RemoteWorkerRuntimeResultRecord {
    const snapshot = new RemoteWorkerCellProvisioningRepository(this.db).getSnapshot(scope);
    if (!snapshot || snapshot.plan.planSha256 !== admission.plan_sha256 || row.lease_revision < admission.lease_revision) throw conflict();
    const history = normalizeRemoteWorkerCellProvisioningExchange({ schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
      ...scope, leaseRevision: row.lease_revision, plan: snapshot.plan.plan, planSha256: snapshot.plan.planSha256,
      records: snapshot.checkpoints.map(record => record.recordHex), volumeRecords: snapshot.volumeCheckpoints.map(record => record.recordHex),
      formatRecords: snapshot.formatCheckpoints.map(record => record.recordHex), protectionRecords: snapshot.protectionCheckpoints.map(record => record.recordHex),
      mountRecords: snapshot.mountCheckpoints.map(record => record.recordHex), mountedWorkspaceRecords: snapshot.mountedWorkspaceCheckpoints.map(record => record.recordHex) });
    this.assertExpectationHistory(expected, history);
    return this.decode(row, expected, history);
  }

  /** Bounded canonical model context. Missing or unquiesced results remain
   * unavailable; they cannot open the Chat inference/settlement path. */
  public readChatContextForParent(input: Parameters<RemoteWorkerRuntimeResultRepository["readForChatContinuation"]>[0]): RemoteWorkerNativeChatContext | null {
    const command = Object.freeze({ ...this.key(input), durableRunId: input.durableRunId,
      continuation: normalizeRemoteWorkerNativeContinuation(input.continuation) });
    return this.db.transaction("immediate", () => {
      const { continuation, recorded } = this.readForChatContinuation(command);
      if (continuation.decision === "rejected")
        return normalizeRemoteWorkerNativeChatContext({ schemaVersion: "goatcitadel.remote-worker-native-chat-context.v1", continuation, recorded: null });
      if (!recorded) return null;
      const outcome = projectRemoteWorkerRuntimeOutcome(recorded.result), checks = outcome.checks;
      if (!checks.bindingVerified || !checks.runtimeBundleVerified || !checks.protectedWorkspaceVerified || !checks.zeroProcessesVerified ||
          !checks.outputDrained || !checks.captureVerified || !checks.inventoryVerified) return null;
      const legacy = normalizeRemoteWorkerNativeChatContext({ schemaVersion: "goatcitadel.remote-worker-native-chat-context.v1", continuation,
        recorded: { expectation: recorded.expectation, outcome, receipt: { resultSha256: recorded.result.resultSha256,
          byteLength: recorded.result.byteLength, leaseRevision: recorded.leaseRevision, recordedAt: recorded.recordedAt } } });
      const row = this.output(command, recorded.expectation.nonce);
      if (!row) return legacy;
      // Parent historical reads do not manufacture a current worker lease. The
      // output's immutable foreign key retains the lease that recorded it.
      const output = this.decodeOutput(row, recorded);
      const identity = remoteWorkerChatInferenceIdentity({ ...this.key(command), continuationSha256: remoteWorkerNativeChatContextSha256(legacy) }, 0);
      const prior = new RemoteWorkerInferenceRepository(this.db).getRequestByIdempotency(command.registryWorkspaceId, identity.idempotencyKey);
      if (prior && (prior.registryWorkspaceId !== command.registryWorkspaceId || prior.assignmentId !== command.assignmentId ||
          prior.assignmentGeneration !== command.assignmentGeneration || prior.inferenceRequestId !== identity.inferenceRequestId)) throw conflict();
      const after = this.readForChatContinuation(command);
      if (canonicalJsonString(after) !== canonicalJsonString({ continuation, recorded })) throw conflict();
      // Once a metadata-only model sequence exists, late output cannot change its
      // input hash or invalidate its canonical answer/artifact during replay.
      return prior ? legacy : normalizeRemoteWorkerNativeChatContext({ ...legacy,
        schemaVersion: "goatcitadel.remote-worker-native-chat-context.v2", output: output.evidence });
    });
  }

  public retainForAssignment(input: RemoteWorkerRuntimeResultAuthority & { nonce: string; resultHex: string }): RemoteWorkerRuntimeResultRecord {
    const nonce = this.nonce(input.nonce), resultHex = input.resultHex;
    return this.fenced(input, (authority, history) => {
      const expected = this.loadExpectation(authority, nonce, history), decoded = readRemoteWorkerRuntimeResult(resultHex, expected, history);
      const prior = this.result(authority, nonce);
      if (prior) {
        if (prior.result_hex !== resultHex) throw conflict();
        return this.decode(prior, expected, history);
      }
      this.assertExecution(authority, this.expectation(authority, nonce)!);
      this.db.prepare(`INSERT INTO remote_worker_runtime_results
        (registry_workspace_id, assignment_id, assignment_generation, nonce, result_hex, result_sha256, lease_revision, recorded_at)
        VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @nonce, @resultHex, @digest, @leaseRevision, ${this.clock()})`)
        .run({ ...this.key(authority), nonce, resultHex, digest: decoded.resultSha256, leaseRevision: authority.leaseRevision });
      const row = this.result(authority, nonce); if (!row) throw conflict();
      return this.decode(row, expected, history);
    });
  }

  /** Retain only after independent binary result retention. Matching byte counts
   * bind diagnostics to the result; they do not verify the reported text/hash. */
  public retainOutputForAssignment(input: RemoteWorkerRuntimeResultAuthority & { evidence: RemoteWorkerRuntimeOutputEvidence }): RemoteWorkerRuntimeOutputRecord {
    const evidence = normalizeRemoteWorkerRuntimeOutputEvidence(input.evidence);
    const command = snapshotRemoteWorkerCellCapacityAuthority(input);
    const authorization = { ...command, nonce: evidence.nonce, requestSha256: evidence.requestSha256, phase: "delivery" as const };
    return this.db.transaction("immediate", () => {
      // Approval locks precede credential/assignment/cell locks, as in admission.
      this.authorizeForAssignment(authorization);
      const saved = this.fenced(command, (authority, history) => {
        const expected = this.loadExpectation(authority, evidence.nonce, history), resultRow = this.result(authority, evidence.nonce);
        if (!resultRow) throw conflict();
        const result = this.decode(resultRow, expected, history);
        const digest = remoteWorkerRuntimeOutputEvidenceSha256(evidence);
        const prior = this.output(authority, evidence.nonce);
        if (prior) {
          const decoded = this.decodeOutput(prior, result, history.leaseRevision);
          if (decoded.evidenceSha256 !== digest || canonicalJsonString(decoded.evidence) !== canonicalJsonString(evidence)) throw conflict();
          return decoded;
        }
        const candidate = { evidence_json: JSON.stringify(evidence), evidence_sha256: digest, result_sha256: evidence.resultSha256,
          lease_revision: authority.leaseRevision, recorded_at: new DurableRunRepository(this.db).readDatabaseNow() };
        this.decodeOutput(candidate, result, history.leaseRevision);
        this.db.prepare(`INSERT INTO remote_worker_runtime_output_evidence
          (registry_workspace_id, assignment_id, assignment_generation, nonce, evidence_json, evidence_sha256, result_sha256, lease_revision, recorded_at)
          VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @nonce, @evidenceJson, @digest, @resultSha256, @leaseRevision, @recordedAt)`)
          .run({ ...this.key(authority), nonce: evidence.nonce, evidenceJson: candidate.evidence_json, digest,
            resultSha256: evidence.resultSha256, leaseRevision: authority.leaseRevision, recordedAt: candidate.recorded_at });
        const row = this.output(authority, evidence.nonce); if (!row) throw conflict();
        return this.decodeOutput(row, result, history.leaseRevision);
      });
      this.authorizeForAssignment(authorization);
      return saved;
    });
  }

  /** Internal delivery-owner check, not a durable export grant or publication
   * approval. The caller supplies its own byte ceiling, must separately govern
   * artifact disclosure, and must recheck authority during native transfer. */
  public authorizeFileSelectionForAssignment(input: RemoteWorkerRuntimeResultAuthority & {
    selection: RemoteWorkerNativeFileExportSelection;
  }, maximumBytes: number): RemoteWorkerNativeFileExportSelection {
    const selection = normalizeRemoteWorkerNativeFileExportSelection(input.selection);
    const command = snapshotRemoteWorkerCellCapacityAuthority(input);
    if (canonicalJsonString(this.key(command)) !== canonicalJsonString(this.key(selection))) throw conflict();
    const authorization = { ...command, nonce: selection.nonce, requestSha256: selection.requestSha256, phase: "delivery" as const };
    return this.db.transaction("immediate", () => {
      this.authorizeForAssignment(authorization);
      const verified = this.fenced(command, (authority, history) => {
        const expected = this.loadExpectation(authority, selection.nonce, history), row = this.result(authority, selection.nonce);
        if (!row) throw conflict();
        this.decode(row, expected, history);
        const derived = createRemoteWorkerNativeFileExportSelection({ fileIdentityHex: selection.fileIdentityHex,
          logicalPath: selection.logicalPath }, expected, row.result_hex, history, maximumBytes);
        if (canonicalJsonString(derived) !== canonicalJsonString(selection)) throw conflict();
        return derived;
      });
      this.authorizeForAssignment(authorization);
      return verified;
    });
  }

  /** Internal protected-delivery validation before artifact staging. The owner
   * supplies native-origin bytes and separately governs disclosure. This is not
   * durable receipt, publication, or proof of origin for arbitrary worker data. */
  public verifyFileContentForAssignment(input: RemoteWorkerRuntimeResultAuthority & {
    selection: RemoteWorkerNativeFileExportSelection; recordHex: string;
  }, maximumBytes: number): RemoteWorkerNativeFileContent {
    const command = snapshotRemoteWorkerCellCapacityAuthority(input);
    const selection = normalizeRemoteWorkerNativeFileExportSelection(input.selection), recordHex = input.recordHex;
    // Reject malformed bounded data before taking database locks. No bytes are
    // released until the independent retained selection and authority pass.
    const content = readRemoteWorkerNativeFileContent(recordHex, selection);
    // This owner already rechecks approval and the complete selection under
    // its transaction. There is no I/O or mutation after it returns, so repeating
    // that entire admission adds database work without another authority boundary.
    this.authorizeFileSelectionForAssignment({ ...command, selection }, maximumBytes);
    return content;
  }

  /** Explicit current operator permission to transfer this exact retained file
   * to Gateway artifact storage. Local collection approval alone cannot pass.
   * The supplied plan is checked against its immutable approval digest; this
   * method does not store content, publish an artifact or grant model access. */
  public authorizeFileDisclosureForAssignment(input: RemoteWorkerRuntimeResultAuthority & {
    selection: RemoteWorkerNativeFileExportSelection; fileStaging: unknown;
  }) {
    const command = snapshotRemoteWorkerCellCapacityAuthority(input), plan = normalizeRemoteWorkerNativeFileStaging(input.fileStaging);
    const supplied = normalizeRemoteWorkerNativeFileExportSelection(input.selection);
    if (!plan.paths.includes(supplied.logicalPath)) throw conflict();
    return this.db.transaction("immediate", () => {
      const selection = this.authorizeFileSelectionForAssignment({ ...command, selection: supplied }, plan.maximumFileBytes);
      const expectation = this.expectation(command, selection.nonce);
      if (!expectation?.approval_id) throw conflict();
      const approvals = new ApprovalRepository(this.db), approval = approvals.lockApprovedForUpdate(expectation.approval_id);
      const manifest = new RemoteWorkerAssignmentRepository(this.db).resolveActiveAuthorityByLeaseTokenHash(
        command.leaseTokenSha256, command.protectedAuthority)?.assignment.manifest;
      if (!manifest) throw conflict();
      const disclosure = normalizeRemoteWorkerNativeFileDisclosure(approval.payload.nativeFileDisclosure);
      const expected = normalizeRemoteWorkerNativeFileDisclosure({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA,
        destination: "gateway_artifacts", ...this.key(command), nonce: selection.nonce, requestSha256: selection.requestSha256,
        executionWorkspaceId: manifest.executionWorkspaceId, pathJailSha256: manifest.pathJailSha256,
        fileStagingSha256: remoteWorkerNativeFileStagingSha256(plan) });
      if (canonicalJsonString(disclosure) !== canonicalJsonString(expected)) throw conflict();
      this.authorizeForAssignment({ ...command, nonce: selection.nonce, requestSha256: selection.requestSha256, phase: "delivery" });
      if (canonicalJsonString(approvals.lockApprovedForUpdate(expectation.approval_id)) !== canonicalJsonString(approval)) throw conflict();
      return Object.freeze({ selection, disclosure });
    });
  }

  public verifyDisclosedFileContentForAssignment(input: RemoteWorkerRuntimeResultAuthority & {
    selection: RemoteWorkerNativeFileExportSelection; fileStaging: unknown; recordHex: string;
  }) {
    const command = snapshotRemoteWorkerCellCapacityAuthority(input), plan = normalizeRemoteWorkerNativeFileStaging(input.fileStaging);
    const selection = normalizeRemoteWorkerNativeFileExportSelection(input.selection);
    const content = readRemoteWorkerNativeFileContent(input.recordHex, selection);
    const authorized = this.authorizeFileDisclosureForAssignment({ ...command, selection, fileStaging: plan });
    return Object.freeze({ ...authorized, content });
  }

  public findOutputForAssignment(input: RemoteWorkerRuntimeResultAuthority & { nonce: string }): RemoteWorkerRuntimeOutputRecord | null {
    const nonce = this.nonce(input.nonce);
    return this.fenced(input, (authority, history) => {
      const expected = this.loadExpectation(authority, nonce, history), row = this.output(authority, nonce);
      if (!row) return null;
      const result = this.result(authority, nonce); if (!result) throw conflict();
      return this.decodeOutput(row, this.decode(result, expected, history), history.leaseRevision);
    });
  }

  private decodeOutput(row: OutputRow, result: RemoteWorkerRuntimeResultRecord, currentLease?: number): RemoteWorkerRuntimeOutputRecord {
    const evidence = verifyRemoteWorkerRuntimeOutputEvidence(JSON.parse(row.evidence_json), result.expectation,
      { resultSha256: result.result.resultSha256, byteLength: result.result.byteLength, leaseRevision: result.leaseRevision, recordedAt: result.recordedAt },
      projectRemoteWorkerRuntimeOutcome(result.result));
    if (row.result_sha256 !== result.result.resultSha256 || row.evidence_sha256 !== remoteWorkerRuntimeOutputEvidenceSha256(evidence) ||
        !Number.isSafeInteger(row.lease_revision) || row.lease_revision < result.leaseRevision || row.lease_revision > 2147483647 ||
        (currentLease !== undefined && row.lease_revision > currentLease) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.recorded_at) || !Number.isFinite(Date.parse(row.recorded_at)) ||
        new Date(row.recorded_at).toISOString() !== row.recorded_at || Date.parse(row.recorded_at) < Date.parse(result.recordedAt) ||
        Object.values(evidence.streams).some(stream => redactSecretText(stream.text, { redactEmailAddresses: true }).value !== stream.text)) throw conflict();
    return Object.freeze({ evidence, evidenceSha256: row.evidence_sha256, leaseRevision: row.lease_revision, recordedAt: row.recorded_at });
  }

  private output(authority: Scope, nonce: string) {
    return this.db.prepare(`SELECT * FROM remote_worker_runtime_output_evidence WHERE ${WHERE} AND nonce = @nonce`).get<OutputRow>({ ...this.key(authority), nonce });
  }

  private fenced<T>(input: RemoteWorkerRuntimeResultAuthority, action: (authority: RemoteWorkerRuntimeResultAuthority, history: RemoteWorkerCellProvisioningExchange) => T): T {
    if (!input.protectedAuthority) throw conflict();
    const authority = { ...this.key(input), leaseRevision: input.leaseRevision, leaseTokenSha256: input.leaseTokenSha256,
      protectedAuthority: { credentialAuthority: { ...input.protectedAuthority.credentialAuthority }, meshAdmission: { ...input.protectedAuthority.meshAdmission } } };
    return this.db.transaction("immediate", () => {
      // Reuse the canonical assignment -> cell lock order, complete journal
      // validation and protected credential/mesh/lease fences in one transaction.
      const snapshot = () => this.history.exchange({ ...authority, submission: { kind: "cell.capacity.snapshot" } }, "mounted").history;
      const history = snapshot(), cell = this.cells.getCell(authority)!;
      const result = action(authority, history);
      const after = snapshot(), current = this.cells.getCell(authority)!;
      if (JSON.stringify(after) !== JSON.stringify(history) || current.executionRevision !== cell.executionRevision || current.cleanupRevision !== cell.cleanupRevision) throw conflict();
      return result;
    });
  }
  private assertExpectationHistory(expected: RemoteWorkerRuntimeResultExpectation, history: RemoteWorkerCellProvisioningExchange) {
    if (history.mountedWorkspaceRecords?.length !== 2 || readRemoteWorkerCellMountedWorkspaceCheckpoint(
      remoteWorkerCellProvisioningMountedWorkspaceAnchor(history), history.mountedWorkspaceRecords[1]).recordSha256 !== expected.checkpointSha256) throw conflict();
  }
  private assertExecution(authority: RemoteWorkerRuntimeResultAuthority, admission: ExpectationRow) {
    const cell = this.cells.getCell(authority)!;
    // Only the admitted starting -> running transition may precede publication.
    if (cell.cleanupRevision !== admission.cleanup_revision || !(
      (cell.executionState === "starting" && cell.executionRevision === admission.execution_revision) ||
      (cell.executionState === "running" && cell.executionRevision === admission.execution_revision + 1))) throw conflict();
  }
  private loadExpectation(authority: RemoteWorkerRuntimeResultAuthority, nonce: string, history: RemoteWorkerCellProvisioningExchange) {
    return this.decodeExpectation(this.expectation(authority, nonce), authority, nonce, history);
  }
  private decodeExpectation(row: ExpectationRow | undefined, authority: RemoteWorkerRuntimeResultAuthority, nonce: string, history: RemoteWorkerCellProvisioningExchange) {
    if (!row || row.plan_sha256 !== history.planSha256 || row.lease_revision > authority.leaseRevision) throw conflict();
    const expected = normalizeRemoteWorkerRuntimeResultExpectation(JSON.parse(row.expectation_json));
    if (expected.nonce !== nonce) throw conflict(); this.assertExpectationHistory(expected, history); return expected;
  }
  private decode(row: ResultRow, expectation: RemoteWorkerRuntimeResultExpectation, history: RemoteWorkerCellProvisioningExchange): RemoteWorkerRuntimeResultRecord {
    const result = readRemoteWorkerRuntimeResult(row.result_hex, expectation, history);
    if (result.resultSha256 !== row.result_sha256 || !Number.isSafeInteger(row.lease_revision) || row.lease_revision < 1 || row.lease_revision > history.leaseRevision ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.recorded_at) || !Number.isFinite(Date.parse(row.recorded_at)) || new Date(row.recorded_at).toISOString() !== row.recorded_at) throw conflict();
    return Object.freeze({ expectation, result, leaseRevision: row.lease_revision, recordedAt: row.recorded_at });
  }
  private expectation(authority: Scope, nonce: string) {
    return this.db.prepare(`SELECT * FROM remote_worker_runtime_expectations WHERE ${WHERE} AND nonce = @nonce`).get<ExpectationRow>({ ...this.key(authority), nonce });
  }
  private result(authority: Scope, nonce: string) {
    return this.db.prepare(`SELECT * FROM remote_worker_runtime_results WHERE ${WHERE} AND nonce = @nonce`).get<ResultRow>({ ...this.key(authority), nonce });
  }
  private key(input: Scope) { return { registryWorkspaceId: input.registryWorkspaceId, assignmentId: input.assignmentId, assignmentGeneration: input.assignmentGeneration }; }
  private nonce(value: unknown): string { if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value) || /^0+$/u.test(value)) throw conflict(); return value; }
  private clock() { return this.db.dialect === "postgres" ? REMOTE_WORKER_CAPACITY_POSTGRES_CLOCK : REMOTE_WORKER_CAPACITY_SQLITE_CLOCK; }
}
