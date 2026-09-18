import { randomBytes } from "node:crypto";
import { canonicalJsonString, normalizeRemoteWorkerControllerEnrollment, normalizeRemoteWorkerRuntimeInstallRequest, remoteWorkerRuntimeInstallRequestSha256,
  normalizeRemoteWorkerCellProvisioningHistory, type RemoteWorkerCellProvisioningHistory,
  normalizeRemoteWorkerRuntimeBundleManifest, remoteWorkerRuntimeBundleManifestSha256, REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION,
  type ApprovalCreateInput, type RemoteWorkerRuntimeBundleManifest,
  readRemoteWorkerRuntimeInstallOutcome, readRemoteWorkerCellProvisioningCheckpoint,
  type RemoteWorkerRuntimeInstallRequest, type RemoteWorkerRuntimeInstallOutcome, type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ApprovalRepository } from "./approval-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerNativeCapacityPagesRepository } from "./remote-worker-native-capacity-pages-repo.js";
import { assertRuntimeInstallFitsCapturedCapacity } from "./remote-worker-runtime-install-capacity.js";
import { snapshotRuntimeInstallPoolCapture, validateRuntimeInstallPoolCapture, type RuntimeInstallPoolCapture } from "./remote-worker-runtime-install-capture.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerCellRepository, RemoteWorkerCellConflictError } from "./remote-worker-cell-repo.js";
import { RemoteWorkerCellCapacityStore } from "./remote-worker-cell-capacity-store.js";
import { snapshotRemoteWorkerCellCapacityAuthority, type RemoteWorkerCellCapacityAuthority } from "./remote-worker-cell-capacity-admission-repo.js";
import { REMOTE_WORKER_CAPACITY_POSTGRES_CLOCK, REMOTE_WORKER_CAPACITY_SQLITE_CLOCK } from "./remote-worker-cell-capacity-observation-schema.js";
import { normalizeRemoteWorkerRuntimeInstallSubmission, normalizeRemoteWorkerRuntimeInstallExchange,
  normalizeRemoteWorkerRuntimeInstallSelectionSubmission, normalizeRemoteWorkerRuntimeInstallSelection,
  REMOTE_WORKER_RUNTIME_INSTALL_SELECTION_SCHEMA_VERSION, type RemoteWorkerRuntimeInstallSelectionSubmission,
  REMOTE_WORKER_RUNTIME_INSTALL_EXCHANGE_SCHEMA_VERSION, type RemoteWorkerRuntimeInstallSubmission,
  type RemoteWorkerRuntimeInstallExchange } from "@goatcitadel/contracts";

export interface RemoteWorkerRuntimeInstallExchangeInput extends RemoteWorkerCellCapacityAuthority {
  readonly submission: RemoteWorkerRuntimeInstallSubmission;
}
export interface RemoteWorkerRuntimeInstallSelectionInput extends RemoteWorkerCellCapacityAuthority {
  readonly submission: RemoteWorkerRuntimeInstallSelectionSubmission;
}
export interface RemoteWorkerRuntimeInstallPreparationInput extends RemoteWorkerCellCapacityAuthority {
  /** Supplied only by the trusted package owner, never a worker admission RPC. */
  readonly packageSha256: string;
  readonly runtimeBundle: RemoteWorkerRuntimeBundleManifest;
}

export interface RemoteWorkerRuntimeInstallRequestInput extends RemoteWorkerCellCapacityAuthority {
  readonly request: RemoteWorkerRuntimeInstallRequest;
  readonly approvalId: string;
  readonly expectedExecutionRevision: number;
  readonly expectedCleanupRevision: number;
  readonly expectedCapacityRevision: number;
  readonly expectedBackupRevision: number;
}
export interface RemoteWorkerRuntimeInstallRecord {
  readonly request: RemoteWorkerRuntimeInstallRequest;
  readonly outcomeHex: string;
  readonly outcome: RemoteWorkerRuntimeInstallOutcome;
  readonly leaseRevision: number;
  readonly recordedAt: string;
}
type RequestRow = { request_json: string; request_sha256: string; nonce: string; approval_id: string; plan_sha256: string;
  execution_revision: number; cleanup_revision: number; capacity_revision: number; backup_revision: number; lease_revision: number };
type OutcomeRow = { outcome_hex: string; outcome_sha256: string; lease_revision: number; recorded_at: string };
const WHERE = "registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration";
const conflict = () => new RemoteWorkerCellConflictError("Installation retention requires the exact reviewed request and current protected cell authority.");
const key = (value: Pick<RemoteWorkerCellCapacityAuthority, "registryWorkspaceId" | "assignmentId" | "assignmentGeneration">) => ({ registryWorkspaceId: value.registryWorkspaceId,
  assignmentId: value.assignmentId, assignmentGeneration: value.assignmentGeneration });

/** Internal reviewed-request and immutable-outcome storage, never a worker
 * admission RPC. The installation owner must separately enforce current policy,
 * installed package custody and complete-pool reservation/quiescence. These
 * methods do not authorize copying, transition readiness or permit retries. */
export class RemoteWorkerRuntimeInstallRepository {
  private readonly history: RemoteWorkerCellCapacityStore;
  private readonly cells: RemoteWorkerCellRepository;
  constructor(private readonly db: DatabaseClient) { this.history = new RemoteWorkerCellCapacityStore(db); this.cells = new RemoteWorkerCellRepository(db); }

  /** Read-only review preparation. The approval owner must create and resolve
   * the draft separately. No request, reservation or readiness is persisted. */
  public prepareRequestForAssignment(input: RemoteWorkerRuntimeInstallPreparationInput) {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), packageSha256 = this.nonce(input.packageSha256);
    const runtimeBundle = normalizeRemoteWorkerRuntimeBundleManifest(input.runtimeBundle);
    return this.fenced(authority, history => {
      if (this.request(authority)) throw conflict(); // An existing attempt requires recovery, never a fresh nonce.
      const cell = this.cells.getCell(authority)!;
      const revisions = Object.freeze({ expectedExecutionRevision: cell.executionRevision, expectedCleanupRevision: cell.cleanupRevision,
        expectedCapacityRevision: cell.capacityRevision, expectedBackupRevision: cell.backupRevision });
      // The phase-specific reader refuses ready cells and partial/missing or
      // stale captures. This is retained evidence, not live pool quiescence.
      const capacity = new RemoteWorkerNativeCapacityPagesRepository(this.db).readInstallationCapacityForAssignment({ ...authority, ...revisions });
      assertRuntimeInstallFitsCapturedCapacity(history, runtimeBundle, capacity);
      const first = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]!);
      const request = normalizeRemoteWorkerRuntimeInstallRequest({ schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION,
        nonce: randomBytes(32).toString("hex"), journalIdentityHex: first.journalIdentityHex, preparedSha256: first.recordSha256,
        checkpointSha256: history.mountedWorkspaceRecords![1]!.slice(-64), packageSha256, runtimeBundle });
      this.assertRequest(request, history);
      const manifest = new RemoteWorkerAssignmentRepository(this.db).resolveActiveAuthorityByLeaseTokenHash(
        authority.leaseTokenSha256, authority.protectedAuthority)?.assignment.manifest;
      if (!manifest) throw conflict();
      const requestSha256 = remoteWorkerRuntimeInstallRequestSha256(request);
      const approvalDraft: ApprovalCreateInput = Object.freeze({ kind: "remote_worker.native_runtime_install", riskLevel: "danger",
        payload: Object.freeze({ nativeRuntimeInstall: Object.freeze({ schemaVersion: "goatcitadel.native-runtime-install-approval.v1",
          ...key(authority), profileSha256: cell.profileSha256, request, ...revisions }) }),
        preview: Object.freeze({ title: "Install reviewed runtime package", packageSha256, requestSha256,
          runtimeBundleSha256: remoteWorkerRuntimeBundleManifestSha256(runtimeBundle),
          files: runtimeBundle.files, totalBytes: runtimeBundle.files.reduce((total, file) => total + file.bytes, 0) }),
        linkage: Object.freeze({ workspaceId: manifest.executionWorkspaceId, taskId: manifest.taskId, durableRunId: manifest.durableRunId,
          sessionId: manifest.sessionId, turnId: manifest.turnId, actionType: "remote_worker.native_runtime_install" }) });
      return Object.freeze({ decision: "review_required" as const, request, requestSha256, revisions, approvalDraft });
    });
  }

  /** ApprovalRuntime invokes this inside its creation transaction. Invalid or
   * stale input aborts approval/wait/event creation without retaining a request. */
  public validatePendingReviewForAssignment(input: RemoteWorkerCellCapacityAuthority & { readonly approvalId: string; readonly request: unknown }): void {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), request = normalizeRemoteWorkerRuntimeInstallRequest(input.request);
    const approvalId = input.approvalId;
    if (typeof approvalId !== "string" || !approvalId.trim() || approvalId.trim() !== approvalId || approvalId.length > 200) throw conflict();
    this.db.transaction("immediate", () => {
      const approvals = new ApprovalRepository(this.db), pending = approvals.lockPendingForUpdate(approvalId);
      this.fenced(authority, history => {
        if (this.request(authority)) throw conflict();
        this.assertRequest(request, history);
        const cell = this.cells.getCell(authority)!;
        const revisions = { expectedExecutionRevision: cell.executionRevision, expectedCleanupRevision: cell.cleanupRevision,
          expectedCapacityRevision: cell.capacityRevision, expectedBackupRevision: cell.backupRevision };
        const capacity = new RemoteWorkerNativeCapacityPagesRepository(this.db).readInstallationCapacityForAssignment({ ...authority, ...revisions });
        assertRuntimeInstallFitsCapturedCapacity(history, request.runtimeBundle, capacity);
        const manifest = new RemoteWorkerAssignmentRepository(this.db).resolveActiveAuthorityByLeaseTokenHash(
          authority.leaseTokenSha256, authority.protectedAuthority)?.assignment.manifest;
        if (!manifest) throw conflict();
        const binding = { schemaVersion: "goatcitadel.native-runtime-install-approval.v1", ...key(authority),
          profileSha256: cell.profileSha256, request, ...revisions };
        const now = Date.parse(new DurableRunRepository(this.db).readDatabaseNow());
        const created = Date.parse(pending.createdAt), expiry = Date.parse(pending.expiresAt ?? "");
        if (pending.kind !== "remote_worker.native_runtime_install" || !["danger", "nuclear"].includes(pending.riskLevel) ||
            !Number.isFinite(created) || !Number.isFinite(expiry) || created > now || expiry <= now ||
            pending.linkage?.workspaceId !== manifest.executionWorkspaceId || pending.linkage.taskId !== manifest.taskId ||
            pending.linkage.durableRunId !== manifest.durableRunId || pending.linkage.sessionId !== manifest.sessionId ||
            pending.linkage.turnId !== manifest.turnId || pending.linkage.actionType !== "remote_worker.native_runtime_install" ||
            canonicalJsonString(pending.payload.nativeRuntimeInstall) !== canonicalJsonString(binding) ||
            canonicalJsonString(approvals.lockPendingForUpdate(approvalId)) !== canonicalJsonString(pending)) throw conflict();
      });
    });
  }

  public retainRequestForAssignment(input: RemoteWorkerRuntimeInstallRequestInput): RemoteWorkerRuntimeInstallRequest {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), request = normalizeRemoteWorkerRuntimeInstallRequest(input.request);
    const approvalId = input.approvalId;
    const revisions = { expectedExecutionRevision: input.expectedExecutionRevision, expectedCleanupRevision: input.expectedCleanupRevision,
      expectedCapacityRevision: input.expectedCapacityRevision, expectedBackupRevision: input.expectedBackupRevision };
    if (typeof approvalId !== "string" || !approvalId.trim() || approvalId.length > 200 || approvalId.trim() !== approvalId ||
        Object.entries(revisions).some(([name, value]) => !Number.isSafeInteger(value) || value < (name === "expectedCapacityRevision" ? 0 : 1) || value > 2147483647)) throw conflict();
    return this.db.transaction("immediate", () => {
      // Lock approval before credential -> mesh -> assignment -> cell.
      const approvals = new ApprovalRepository(this.db), approved = approvals.lockApprovedForUpdate(approvalId);
      return this.fenced(authority, history => {
        this.assertRequest(request, history);
        const cell = this.cells.getCell(authority)!;
        if (cell.executionState !== "provisioning" || cell.nativePlatform || cell.executionRevision !== revisions.expectedExecutionRevision ||
            cell.cleanupRevision !== revisions.expectedCleanupRevision || cell.capacityRevision !== revisions.expectedCapacityRevision ||
            cell.backupRevision !== revisions.expectedBackupRevision) throw conflict();
        const manifest = new RemoteWorkerAssignmentRepository(this.db).resolveActiveAuthorityByLeaseTokenHash(authority.leaseTokenSha256, authority.protectedAuthority)?.assignment.manifest;
        if (!manifest) throw conflict();
        const binding = { schemaVersion: "goatcitadel.native-runtime-install-approval.v1", ...key(authority), profileSha256: cell.profileSha256,
          request, ...revisions };
        const checkApproval = () => {
          const current = approvals.lockApprovedForUpdate(approvalId), now = Date.parse(new DurableRunRepository(this.db).readDatabaseNow());
          const created = Date.parse(current.createdAt), resolved = Date.parse(current.resolvedAt ?? ""), expiry = Date.parse(current.expiresAt ?? "");
          if (current.kind !== "remote_worker.native_runtime_install" || !["danger", "nuclear"].includes(current.riskLevel) ||
              !Number.isFinite(created) || !Number.isFinite(resolved) || !Number.isFinite(expiry) || created > resolved || resolved > now || expiry <= now || !current.resolvedBy?.trim() ||
              current.linkage?.workspaceId !== manifest.executionWorkspaceId || current.linkage.taskId !== manifest.taskId ||
              current.linkage.durableRunId !== manifest.durableRunId || current.linkage.sessionId !== manifest.sessionId || current.linkage.turnId !== manifest.turnId ||
              current.linkage.actionType !== "remote_worker.native_runtime_install" || canonicalJsonString(current.payload.nativeRuntimeInstall) !== canonicalJsonString(binding) ||
              canonicalJsonString(current) !== canonicalJsonString(approved)) throw conflict();
        };
        checkApproval();
        const requestJson = canonicalJsonString(request), requestSha256 = remoteWorkerRuntimeInstallRequestSha256(request), prior = this.request(authority);
        if (prior) {
          if (prior.request_json !== requestJson || prior.request_sha256 !== requestSha256 || prior.approval_id !== approvalId ||
              prior.plan_sha256 !== history.planSha256 || prior.execution_revision !== cell.executionRevision || prior.cleanup_revision !== cell.cleanupRevision ||
              prior.capacity_revision !== cell.capacityRevision || prior.backup_revision !== cell.backupRevision) throw conflict();
        } else this.db.prepare(`INSERT INTO remote_worker_runtime_install_requests
          (registry_workspace_id, assignment_id, assignment_generation, nonce, request_sha256, request_json, plan_sha256, approval_id,
           execution_revision, cleanup_revision, capacity_revision, backup_revision, lease_revision, recorded_at)
          VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @nonce, @requestSha256, @requestJson, @planSha256, @approvalId,
           @executionRevision, @cleanupRevision, @capacityRevision, @backupRevision, @leaseRevision, ${this.clock()})`).run({ ...key(authority), nonce: request.nonce,
            requestSha256, requestJson, planSha256: history.planSha256, approvalId, executionRevision: cell.executionRevision,
            cleanupRevision: cell.cleanupRevision, capacityRevision: cell.capacityRevision, backupRevision: cell.backupRevision, leaseRevision: authority.leaseRevision });
        checkApproval(); return request;
      });
    });
  }

  public findForAssignment(input: RemoteWorkerCellCapacityAuthority & { nonce: string }): RemoteWorkerRuntimeInstallRecord | null {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), nonce = this.nonce(input.nonce);
    return this.fenced(authority, history => {
      const { request } = this.load(authority, nonce, history), row = this.outcome(authority, nonce);
      return row ? this.decode(row, request, history) : null;
    });
  }

  /** Read the already retained request under current protected assignment
   * authority. Expired installation approval does not erase recovery evidence;
   * callers must use validateReviewForAssignment for any new copy admission. */
  public selectForAssignment(input: RemoteWorkerRuntimeInstallSelectionInput) {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input);
    const submission = normalizeRemoteWorkerRuntimeInstallSelectionSubmission(input.submission);
    return this.fenced(authority, history => {
      const row = this.request(authority);
      const request = row ? this.load(authority, row.nonce, history).request : null;
      return normalizeRemoteWorkerRuntimeInstallSelection({ schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SELECTION_SCHEMA_VERSION,
        challenge: submission.challenge, history, request });
    });
  }

  /** Internal historical pool coverage only. The enclosing pool owner derives
   * this scope/history under its protected transaction. Reading a retained
   * request neither renews its approval nor authorizes another installation. */
  public readRetainedCleanupForPool(input: Pick<RemoteWorkerCellCapacityAuthority, "registryWorkspaceId" | "assignmentId" | "assignmentGeneration">,
    retained: RemoteWorkerCellProvisioningHistory | null) {
    const scope = key(input), history = retained ? normalizeRemoteWorkerCellProvisioningHistory(retained) : null;
    const rows = this.db.prepare(`SELECT * FROM remote_worker_runtime_install_requests WHERE ${WHERE} LIMIT 2`).all<RequestRow>(scope);
    if (rows.length > 1) throw conflict();
    const row = rows[0]; if (!row) return null;
    if (!history || row.plan_sha256 !== history.planSha256 || !Number.isSafeInteger(row.lease_revision) || row.lease_revision < 1) throw conflict();
    const request = normalizeRemoteWorkerRuntimeInstallRequest(JSON.parse(row.request_json));
    if (request.nonce !== row.nonce || remoteWorkerRuntimeInstallRequestSha256(request) !== row.request_sha256) throw conflict();
    this.assertRequest(request, history);
    return request;
  }

  /** Current review evidence for the installation admission owner. This is not
   * copy permission: policy, package custody, complete-pool capacity and native
   * replay prevention must still be checked by their respective owners. */
  public validateReviewForAssignment(input: RemoteWorkerCellCapacityAuthority & { nonce: string; requestSha256: string }): RemoteWorkerRuntimeInstallRequest {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), nonce = this.nonce(input.nonce), requestSha256 = this.nonce(input.requestSha256);
    return this.db.transaction("immediate", () => {
      // This immutable row is read without locking. retainRequestForAssignment
      // acquires approval before credential/mesh/assignment/cell locks.
      const row = this.request(authority);
      if (!row || row.nonce !== nonce || row.request_sha256 !== requestSha256 || row.lease_revision > authority.leaseRevision) throw conflict();
      const request = normalizeRemoteWorkerRuntimeInstallRequest(JSON.parse(row.request_json));
      if (remoteWorkerRuntimeInstallRequestSha256(request) !== requestSha256) throw conflict();
      const current = this.retainRequestForAssignment({ ...authority, request, approvalId: row.approval_id,
        expectedExecutionRevision: row.execution_revision, expectedCleanupRevision: row.cleanup_revision,
        expectedCapacityRevision: row.capacity_revision, expectedBackupRevision: row.backup_revision });
      if (this.outcome(authority, nonce)) throw conflict();
      return current;
    });
  }

  /** The operator's public controller pin is part of the canonical approval,
   * never learned from worker RPC or a self-signed enrollment response. Reuse
   * the same approval/lease/parent fences as installation admission. */
  public readControllerEnrollmentForAssignment(input: RemoteWorkerCellCapacityAuthority & { nonce: string; requestSha256: string }) {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), nonce = this.nonce(input.nonce), requestSha256 = this.nonce(input.requestSha256);
    return this.db.transaction("immediate", () => {
      this.validateReviewForAssignment({ ...authority, nonce, requestSha256 });
      const row = this.request(authority);
      if (!row || row.nonce !== nonce || row.request_sha256 !== requestSha256) throw conflict();
      const approval = new ApprovalRepository(this.db).lockApprovedForUpdate(row.approval_id);
      const enrollment = normalizeRemoteWorkerControllerEnrollment(approval.payload.controllerEnrollment);
      this.validateReviewForAssignment({ ...authority, nonce, requestSha256 });
      return enrollment;
    });
  }

  /** Join current installation review to its exact accepted complete capture.
   * This read neither changes capacity nor supplies live quiescence or policy. */
  public readAdmissionMaterialForAssignment(input: RemoteWorkerCellCapacityAuthority & { nonce: string; requestSha256: string }) {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), nonce = this.nonce(input.nonce), requestSha256 = this.nonce(input.requestSha256);
    return this.db.transaction("immediate", () => {
      const request = this.validateReviewForAssignment({ ...authority, nonce, requestSha256 }), row = this.request(authority)!;
      const capacity = new RemoteWorkerNativeCapacityPagesRepository(this.db).readInstallationCapacityForAssignment({ ...authority,
        expectedExecutionRevision: row.execution_revision, expectedCleanupRevision: row.cleanup_revision,
        expectedCapacityRevision: row.capacity_revision, expectedBackupRevision: row.backup_revision });
      const history = this.history.exchange({ ...authority, submission: { kind: "cell.capacity.snapshot" } }, "mounted").history;
      assertRuntimeInstallFitsCapturedCapacity(history, request.runtimeBundle, capacity);
      this.validateReviewForAssignment({ ...authority, nonce, requestSha256 });
      return Object.freeze({ request, requestSha256, capacity });
    });
  }

  /** Atomic canonical inputs for the live reservation owner. This deliberately
   * requires full-pool review evidence and does not return the old capture's
   * window as new authority. Reading it neither reserves nor permits a copy. */
  public readPoolAdmissionMaterialForAssignment(input: RemoteWorkerCellCapacityAuthority & { nonce: string; requestSha256: string }) {
    const command = Object.freeze({ ...snapshotRemoteWorkerCellCapacityAuthority(input),
      nonce: this.nonce(input.nonce), requestSha256: this.nonce(input.requestSha256) });
    return this.db.transaction("immediate", () => {
      const material = this.readAdmissionMaterialForAssignment(command);
      const baseline = new RemoteWorkerNativeCapacityPagesRepository(this.db).readInstallationPoolBaselineForAssignment({
        ...command, ...material.capacity });
      const history = this.history.exchange({ ...command, submission: { kind: "cell.capacity.snapshot" } }, "mounted").history;
      if (canonicalJsonString(baseline.capacity) !== canonicalJsonString(material.capacity) ||
          canonicalJsonString(this.readAdmissionMaterialForAssignment(command)) !== canonicalJsonString(material)) throw conflict();
      return Object.freeze({ ...material, history, pool: baseline.pool, layout: baseline.layout });
    });
  }

  /** Canonical reference context for the installed controller's fresh capture.
   * This does not promote the prior capture window into live authority. */
  public readControllerCaptureContextForAssignment(input: RemoteWorkerCellCapacityAuthority & { nonce: string; requestSha256: string }) {
    const command = Object.freeze({ ...snapshotRemoteWorkerCellCapacityAuthority(input),
      nonce: this.nonce(input.nonce), requestSha256: this.nonce(input.requestSha256) });
    return this.db.transaction("immediate", () => {
      const baseline = this.readPoolAdmissionMaterialForAssignment(command);
      const pool = new RemoteWorkerNativeCapacityPagesRepository(this.db).readInstallationPoolBaselineForAssignment({ ...command, ...baseline.capacity });
      const enrollment = this.readControllerEnrollmentForAssignment(command);
      if (canonicalJsonString(this.readPoolAdmissionMaterialForAssignment(command)) !== canonicalJsonString(baseline)) throw conflict();
      return Object.freeze({ baseline, enrollment, referencesJson: pool.referencesJson });
    });
  }

  /** Internal capture-owner validation under canonical fences. The caller must
   * independently retain the live window and references. This is not an RPC
   * that lets a worker choose its own capture authority or reserve by hash. */
  public validatePoolCaptureForAssignment(input: RemoteWorkerCellCapacityAuthority & {
    nonce: string; requestSha256: string; capture: RuntimeInstallPoolCapture;
  }) {
    const command = Object.freeze({ ...snapshotRemoteWorkerCellCapacityAuthority(input),
      nonce: this.nonce(input.nonce), requestSha256: this.nonce(input.requestSha256) });
    const capture = snapshotRuntimeInstallPoolCapture(input.capture);
    return this.db.transaction("immediate", () => {
      const baseline = this.readPoolAdmissionMaterialForAssignment(command), cell = this.cells.getCell(command);
      if (!cell) throw conflict();
      const result = validateRuntimeInstallPoolCapture(baseline, cell, capture);
      if (canonicalJsonString(this.readPoolAdmissionMaterialForAssignment(command)) !== canonicalJsonString(baseline) ||
          canonicalJsonString(this.cells.getCell(command)) !== canonicalJsonString(cell)) throw conflict();
      return result;
    });
  }

  /** Worker delivery can only address an already reviewed request; a lookup
   * never creates admission, and an absent outcome never authorizes a retry. */
  public exchangeForAssignment(input: RemoteWorkerRuntimeInstallExchangeInput): RemoteWorkerRuntimeInstallExchange {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), submission = normalizeRemoteWorkerRuntimeInstallSubmission(input.submission);
    return this.fenced(authority, history => {
      const { row } = this.load(authority, submission.nonce, history);
      if (row.request_sha256 !== submission.requestSha256) throw conflict();
      const record = submission.kind === "runtime.install.retain" ? this.retainForAssignment({ ...authority, nonce: submission.nonce, outcomeHex: submission.outcomeHex }) :
        this.findForAssignment({ ...authority, nonce: submission.nonce });
      return normalizeRemoteWorkerRuntimeInstallExchange({ schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_EXCHANGE_SCHEMA_VERSION,
        ...key(authority), leaseRevision: authority.leaseRevision, nonce: submission.nonce, requestSha256: submission.requestSha256,
        record: record ? { outcomeHex: record.outcomeHex, outcomeSha256: record.outcome.outcomeSha256,
          leaseRevision: record.leaseRevision, recordedAt: record.recordedAt } : null });
    });
  }

  public retainForAssignment(input: RemoteWorkerCellCapacityAuthority & { nonce: string; outcomeHex: string }): RemoteWorkerRuntimeInstallRecord {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), nonce = this.nonce(input.nonce), outcomeHex = input.outcomeHex;
    return this.fenced(authority, history => {
      const { request, row } = this.load(authority, nonce, history), decoded = readRemoteWorkerRuntimeInstallOutcome(outcomeHex, request, history);
      if (!decoded.installation || !decoded.outcomeSha256) throw conflict();
      const prior = this.outcome(authority, nonce);
      if (prior) { if (prior.outcome_hex !== outcomeHex) throw conflict(); return this.decode(prior, request, history); }
      const cell = this.cells.getCell(authority)!;
      if (cell.executionState !== "provisioning" || cell.nativePlatform || cell.executionRevision !== row.execution_revision || cell.cleanupRevision !== row.cleanup_revision ||
          cell.capacityRevision !== row.capacity_revision || cell.backupRevision !== row.backup_revision) throw conflict();
      this.db.prepare(`INSERT INTO remote_worker_runtime_install_outcomes
        (registry_workspace_id, assignment_id, assignment_generation, nonce, outcome_hex, outcome_sha256, lease_revision, recorded_at)
        VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @nonce, @outcomeHex, @outcomeSha256, @leaseRevision, ${this.clock()})`)
        .run({ ...key(authority), nonce, outcomeHex, outcomeSha256: decoded.outcomeSha256, leaseRevision: authority.leaseRevision });
      return this.decode(this.outcome(authority, nonce)!, request, history);
    });
  }
  private fenced<T>(input: RemoteWorkerCellCapacityAuthority, action: (history: RemoteWorkerCellProvisioningExchange) => T): T {
    return this.db.transaction("immediate", () => {
      const snapshot = () => this.history.exchange({ ...input, submission: { kind: "cell.capacity.snapshot" } }, "mounted").history;
      const history = snapshot(), before = this.cells.getCell(input)!, result = action(history), after = snapshot(), cell = this.cells.getCell(input)!;
      if (canonicalJsonString(history) !== canonicalJsonString(after) || before.executionRevision !== cell.executionRevision ||
          before.cleanupRevision !== cell.cleanupRevision || before.capacityRevision !== cell.capacityRevision || before.backupRevision !== cell.backupRevision) throw conflict();
      return result;
    });
  }
  private assertRequest(request: RemoteWorkerRuntimeInstallRequest, history: RemoteWorkerCellProvisioningHistory) {
    const first = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]!);
    if (request.journalIdentityHex !== first.journalIdentityHex || request.preparedSha256 !== first.recordSha256 ||
        history.mountedWorkspaceRecords?.length !== 2 || request.checkpointSha256 !== history.mountedWorkspaceRecords[1]!.slice(-64)) throw conflict();
  }
  private load(authority: RemoteWorkerCellCapacityAuthority, nonce: string, history: RemoteWorkerCellProvisioningExchange) {
    const row = this.request(authority); if (!row || row.nonce !== nonce || row.plan_sha256 !== history.planSha256 || row.lease_revision > authority.leaseRevision) throw conflict();
    const request = normalizeRemoteWorkerRuntimeInstallRequest(JSON.parse(row.request_json));
    if (request.nonce !== nonce || remoteWorkerRuntimeInstallRequestSha256(request) !== row.request_sha256) throw conflict();
    this.assertRequest(request, history); return { row, request };
  }
  private decode(row: OutcomeRow, request: RemoteWorkerRuntimeInstallRequest, history: RemoteWorkerCellProvisioningExchange): RemoteWorkerRuntimeInstallRecord {
    const outcome = readRemoteWorkerRuntimeInstallOutcome(row.outcome_hex, request, history);
    if (!outcome.installation || outcome.outcomeSha256 !== row.outcome_sha256 || !Number.isSafeInteger(row.lease_revision) || row.lease_revision < 1 ||
        row.lease_revision > history.leaseRevision || !Number.isFinite(Date.parse(row.recorded_at)) || new Date(row.recorded_at).toISOString() !== row.recorded_at) throw conflict();
    return Object.freeze({ request, outcomeHex: row.outcome_hex, outcome, leaseRevision: row.lease_revision, recordedAt: row.recorded_at });
  }
  private request(authority: RemoteWorkerCellCapacityAuthority) { return this.db.prepare(`SELECT * FROM remote_worker_runtime_install_requests WHERE ${WHERE}`).get<RequestRow>(key(authority)); }
  private outcome(authority: RemoteWorkerCellCapacityAuthority, nonce: string) { return this.db.prepare(`SELECT * FROM remote_worker_runtime_install_outcomes WHERE ${WHERE} AND nonce = @nonce`).get<OutcomeRow>({ ...key(authority), nonce }); }
  private nonce(value: unknown): string { if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value) || /^0+$/u.test(value)) throw conflict(); return value; }
  private clock() { return this.db.dialect === "postgres" ? REMOTE_WORKER_CAPACITY_POSTGRES_CLOCK : REMOTE_WORKER_CAPACITY_SQLITE_CLOCK; }
}
