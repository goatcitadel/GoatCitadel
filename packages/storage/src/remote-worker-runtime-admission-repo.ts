import path from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalJsonString, normalizeRemoteWorkerNativeFileStaging, normalizeRemoteWorkerNativeFileDisclosure, remoteWorkerNativeFileStagingSha256,
  REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA, normalizeRemoteWorkerRuntimeResultExpectation, readRemoteWorkerCellMountedWorkspaceCheckpoint, readRemoteWorkerCellProvisioningCheckpoint,
  remoteWorkerCellProvisioningMountedWorkspaceAnchor, type ApprovalCreateInput, type RemoteWorkerRuntimeResultExpectation, type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";
import { normalizeWindowsRuntimeDispatch, prepareWindowsRuntimeDispatch, normalizeWindowsWorkerStdioLaunch, normalizeWindowsRuntimeInventoryLimits,
  type WindowsRuntimeDispatchRequest } from "@goatcitadel/contracts/remote-worker-runtime-node";
import type { DatabaseClient } from "./db.js";
import { ApprovalRepository } from "./approval-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { assertNativeRuntimeChatResume } from "./remote-worker-native-runtime-resume-admission.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerCellCapacityStore } from "./remote-worker-cell-capacity-store.js";
import { RemoteWorkerCellCapacityAdmissionRepository, snapshotRemoteWorkerCellCapacityInventoryAdmission, snapshotRemoteWorkerCellCapacityAuthority,
  type RemoteWorkerCellCapacityInventoryAdmissionInput, type RemoteWorkerCellCapacityAuthority } from "./remote-worker-cell-capacity-admission-repo.js";
import { RemoteWorkerCellConflictError, RemoteWorkerCellRepository, type RemoteWorkerCellRecord } from "./remote-worker-cell-repo.js";
import { RemoteWorkerRuntimeResultRepository } from "./remote-worker-runtime-result-repo.js";
import { REMOTE_WORKER_NATIVE_ENVIRONMENT_NAMES, REMOTE_WORKER_NATIVE_ENVIRONMENT_SHA256 } from "./remote-worker-cell-native-profile.js";

export interface RemoteWorkerRuntimeAdmissionInput extends RemoteWorkerCellCapacityInventoryAdmissionInput {
  /** Canonical, resolved operator review; never a worker-authored decision. */
  readonly approvalId: string;
  /** Derived from the independently approved exact request, never worker input. */
  readonly expectation: RemoteWorkerRuntimeResultExpectation;
  /** Complete executable request, checked against independent approval metadata. */
  readonly request: unknown;
}
export type RemoteWorkerRuntimeAdmissionResult =
  | { readonly decision: "accept"; readonly cell: RemoteWorkerCellRecord; readonly expectation: RemoteWorkerRuntimeResultExpectation }
  | { readonly decision: "reject" | "quarantine"; readonly cell: RemoteWorkerCellRecord; readonly reason: string };

export interface RemoteWorkerRuntimeRequestPreparationInput extends RemoteWorkerCellCapacityAuthority {
  readonly launch: unknown;
  readonly inventoryLimits: unknown;
  readonly fileStaging?: unknown;
  /** Explicit additional operator review scope; omitted/false is local collection only. */
  readonly discloseFilesToGateway?: boolean;
}
export interface RemoteWorkerRuntimeRequestPreparation {
  readonly decision: "review_required";
  readonly request: WindowsRuntimeDispatchRequest;
  readonly candidateExpectation: RemoteWorkerRuntimeResultExpectation;
  /** Metadata-only draft; creation and resolution still belong to ApprovalRuntime. */
  readonly approvalDraft: ApprovalCreateInput;
  readonly revisions: Readonly<{ expectedCapacityRevision: number; expectedExecutionRevision: number;
    expectedCleanupRevision: number; expectedBackupRevision: number }>;
}
/** Freeze launch configuration before crossing the asynchronous storage bridge. */
export function snapshotRemoteWorkerRuntimeRequestPreparation(input: RemoteWorkerRuntimeRequestPreparationInput): RemoteWorkerRuntimeRequestPreparationInput {
  if (input.discloseFilesToGateway !== undefined && typeof input.discloseFilesToGateway !== "boolean") throw conflict();
  if (input.discloseFilesToGateway && input.fileStaging === undefined) throw conflict();
  return Object.freeze({ ...snapshotRemoteWorkerCellCapacityAuthority(input),
    launch: normalizeWindowsWorkerStdioLaunch(input.launch, 86_400_000), inventoryLimits: normalizeWindowsRuntimeInventoryLimits(input.inventoryLimits),
    ...(input.fileStaging === undefined ? {} : { fileStaging: normalizeRemoteWorkerNativeFileStaging(input.fileStaging) }),
    ...(input.discloseFilesToGateway === undefined ? {} : { discloseFilesToGateway: input.discloseFilesToGateway }) });
}

const conflict = () => new RemoteWorkerCellConflictError("Native runtime admission requires current prepared request, inventory and cell authority.");

/** Internal commit boundary for the trusted execution owner. This is NOT a
 * worker RPC or a command approval service. The owner must independently bind
 * policy approval and the complete collector's capture before calling here.
 * No command, environment, executable bytes or raw output are persisted.
 *
 * Only a fresh ready cell can commit. An uncertain response must be reconciled
 * from retained state; repeating this call never authorizes another dispatch. */
export class RemoteWorkerRuntimeAdmissionRepository {
  private readonly history: RemoteWorkerCellCapacityStore;
  private readonly capacity: RemoteWorkerCellCapacityAdmissionRepository;
  private readonly cells: RemoteWorkerCellRepository;
  private readonly results: RemoteWorkerRuntimeResultRepository;
  private readonly clock: DurableRunRepository;
  public constructor(private readonly db: DatabaseClient) {
    this.history = new RemoteWorkerCellCapacityStore(db);
    this.capacity = new RemoteWorkerCellCapacityAdmissionRepository(db);
    this.cells = new RemoteWorkerCellRepository(db);
    this.results = new RemoteWorkerRuntimeResultRepository(db);
    this.clock = new DurableRunRepository(db);
  }

  /** Read-only candidate preparation for the governed Gateway execution owner.
   * A candidate is neither approved nor retained for execution. It cannot start
   * a job, write an expectation or substitute for a complete inventory capture. */
  public prepareRequestForAssignment(input: RemoteWorkerRuntimeRequestPreparationInput): RemoteWorkerRuntimeRequestPreparation {
    const command = snapshotRemoteWorkerRuntimeRequestPreparation(input);
    return this.db.transaction("immediate", () => {
      const snapshot = () => this.history.exchange({ ...command, submission: { kind: "cell.capacity.snapshot" } }, "mounted").history;
      const history = snapshot(), before = this.cells.getCell(command);
      const journal = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]);
      const mounted = readRemoteWorkerCellMountedWorkspaceCheckpoint(remoteWorkerCellProvisioningMountedWorkspaceAnchor(history), history.mountedWorkspaceRecords![1]);
      const request = normalizeWindowsRuntimeDispatch({ nonce: randomBytes(32).toString("hex"),
        anchor: { fileIdentity: journal.journalIdentityHex, preparedSha256: journal.recordSha256 }, checkpointSha256: mounted.recordSha256,
        launch: command.launch, inventoryLimits: command.inventoryLimits,
        ...(command.fileStaging === undefined ? {} : { fileStaging: command.fileStaging }) });
      const candidateExpectation = prepareWindowsRuntimeDispatch(request).expectation;
      this.assertRequest(request, candidateExpectation, before, history);
      const manifest = new RemoteWorkerAssignmentRepository(this.db).resolveActiveAuthorityByLeaseTokenHash(
        command.leaseTokenSha256, command.protectedAuthority)?.assignment.manifest;
      if (!manifest) throw conflict();
      const revisions = Object.freeze({ expectedCapacityRevision: before.capacityRevision, expectedExecutionRevision: before.executionRevision,
        expectedCleanupRevision: before.cleanupRevision, expectedBackupRevision: before.backupRevision });
      const fileDisclosure = command.discloseFilesToGateway ? normalizeRemoteWorkerNativeFileDisclosure({
        schemaVersion: REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA, destination: "gateway_artifacts",
        registryWorkspaceId: command.registryWorkspaceId, assignmentId: command.assignmentId, assignmentGeneration: command.assignmentGeneration,
        nonce: candidateExpectation.nonce, requestSha256: candidateExpectation.requestSha256,
        executionWorkspaceId: manifest.executionWorkspaceId, pathJailSha256: manifest.pathJailSha256,
        fileStagingSha256: remoteWorkerNativeFileStagingSha256(request.fileStaging) }) : undefined;
      const approvalDraft: ApprovalCreateInput = Object.freeze({ kind: "remote_worker.native_runtime", riskLevel: "danger",
        payload: Object.freeze({ nativeRuntime: Object.freeze({ schemaVersion: "goatcitadel.native-runtime-approval.v1",
          registryWorkspaceId: command.registryWorkspaceId, assignmentId: command.assignmentId, assignmentGeneration: command.assignmentGeneration,
          profileSha256: before.profileSha256, expectation: candidateExpectation, ...revisions }),
          ...(fileDisclosure ? { nativeFileDisclosure: fileDisclosure } : {}) }),
        preview: Object.freeze({ title: "Review native runtime launch", requestSha256: candidateExpectation.requestSha256,
          runtimeBundleSha256: candidateExpectation.runtimeBundleSha256, maxOutputBytes: candidateExpectation.maxOutputBytes }),
        linkage: Object.freeze({ workspaceId: manifest.executionWorkspaceId, taskId: manifest.taskId, durableRunId: manifest.durableRunId,
          ...(manifest.sessionId === undefined ? {} : { sessionId: manifest.sessionId, turnId: manifest.turnId }), actionType: "remote_worker.native_runtime" }) });
      if (JSON.stringify(snapshot()) !== JSON.stringify(history) || JSON.stringify(this.cells.getCell(command)) !== JSON.stringify(before)) throw conflict();
      return Object.freeze({ decision: "review_required", request, candidateExpectation, approvalDraft, revisions });
    });
  }

  public admitPreparedForAssignment(input: RemoteWorkerRuntimeAdmissionInput): RemoteWorkerRuntimeAdmissionResult {
    const approvalId = input.approvalId;
    if (typeof approvalId !== "string" || !approvalId.trim() || approvalId.length > 200) throw conflict();
    const command = snapshotRemoteWorkerCellCapacityInventoryAdmission(input);
    const expectation = normalizeRemoteWorkerRuntimeResultExpectation(input.expectation);
    const request = normalizeWindowsRuntimeDispatch(input.request);
    if (JSON.stringify(prepareWindowsRuntimeDispatch(request).expectation) !== JSON.stringify(expectation)) throw conflict();
    return this.db.transaction("immediate", () => {
      // Approval precedes assignment locks, matching approval-owned resume.
      const approvals = new ApprovalRepository(this.db);
      const approval = approvals.lockApprovedForUpdate(approvalId);
      // The first history read takes the canonical credential -> mesh ->
      // assignment -> cell locks and requires all 21 native journal records.
      const snapshot = () => this.history.exchange({ ...command, submission: { kind: "cell.capacity.snapshot" } }, "mounted").history;
      const history = snapshot(), before = this.cells.getCell(command);
      this.assertRequest(request, expectation, before, history);
      if (before.executionRevision !== command.expectedExecutionRevision || before.backupRevision !== command.expectedBackupRevision) throw conflict();
      const manifest = new RemoteWorkerAssignmentRepository(this.db).resolveActiveAuthorityByLeaseTokenHash(
        command.leaseTokenSha256, command.protectedAuthority)?.assignment.manifest;
      if (!manifest) throw conflict();
      const binding = { schemaVersion: "goatcitadel.native-runtime-approval.v1", registryWorkspaceId: command.registryWorkspaceId,
        assignmentId: command.assignmentId, assignmentGeneration: command.assignmentGeneration,
        profileSha256: before.profileSha256, expectation,
        expectedCapacityRevision: command.expectedCapacityRevision, expectedExecutionRevision: command.expectedExecutionRevision,
        expectedCleanupRevision: command.expectedCleanupRevision, expectedBackupRevision: command.expectedBackupRevision };
      const assertApproval = () => {
        const current = approvals.lockApprovedForUpdate(approvalId), now = Date.parse(this.clock.readDatabaseNow());
        const created = Date.parse(current.createdAt), resolved = Date.parse(current.resolvedAt ?? ""), expiry = Date.parse(current.expiresAt ?? "");
        if (current.kind !== "remote_worker.native_runtime" || !["danger", "nuclear"].includes(current.riskLevel) ||
            !Number.isFinite(created) || !Number.isFinite(resolved) || !Number.isFinite(expiry) ||
            created > resolved || resolved > now || expiry <= now || !current.resolvedBy?.trim() ||
            current.linkage?.workspaceId !== manifest.executionWorkspaceId || current.linkage.taskId !== manifest.taskId ||
            current.linkage.durableRunId !== manifest.durableRunId || current.linkage.sessionId !== manifest.sessionId ||
            current.linkage.turnId !== manifest.turnId || current.linkage.actionType !== "remote_worker.native_runtime" ||
            canonicalJsonString(current.payload.nativeRuntime) !== canonicalJsonString(binding) ||
            canonicalJsonString(current) !== canonicalJsonString(approval)) throw conflict();
        this.assertDisclosure(current.payload, command, request, expectation, manifest);
        if (manifest.sessionId || manifest.turnId)
          assertNativeRuntimeChatResume(new RemoteWorkerAssignmentRepository(this.db), command, command.protectedAuthority, current);
      };
      assertApproval();

      const capacity = this.capacity.admitInventory(command);
      let committed = capacity.cell;
      if (capacity.decision === "accept") {
        committed = this.cells.transitionExecution({ ...command, expectedRevision: before.executionRevision,
          toState: "starting", detailSha256: expectation.requestSha256, now: this.clock.readDatabaseNow() });
        this.results.retainExpectationForAssignment({ ...command, approvalId, expectedExecutionRevision: committed.executionRevision, expectation });
      }
      // Recheck canonical authority after every write. Any interruption rolls
      // back inventory, high-water evidence, transition and expectation together.
      const after = snapshot(), current = this.cells.getCell(command);
      assertApproval();
      if (JSON.stringify(after) !== JSON.stringify(history) || JSON.stringify(current) !== JSON.stringify(committed) ||
          committed.cleanupRevision !== before.cleanupRevision || committed.backupRevision !== before.backupRevision ||
          committed.profileSha256 !== before.profileSha256 || committed.platformIdentitySha256 !== before.platformIdentitySha256 ||
          committed.executionRevision !== before.executionRevision + (capacity.decision === "accept" ? 1 : 0)) throw conflict();
      return capacity.decision === "accept"
        ? Object.freeze({ decision: "accept", cell: committed, expectation })
        : Object.freeze({ decision: capacity.decision, cell: committed, reason: capacity.reason });
    });
  }

  /** Called by ApprovalRuntime's creation hook inside its transaction. A stale
   * candidate aborts creation and its wait/event writes; this does not approve
   * the request, retain an execution expectation or advance the cell. */
  public validatePendingReviewForAssignment(input: RemoteWorkerCellCapacityAuthority & { readonly approvalId: string; readonly request: unknown }): void {
    const command = snapshotRemoteWorkerCellCapacityAuthority(input), approvalId = input.approvalId;
    const request = normalizeWindowsRuntimeDispatch(input.request), expectation = prepareWindowsRuntimeDispatch(request).expectation;
    if (typeof approvalId !== "string" || !approvalId.trim() || approvalId.length > 200) throw conflict();
    this.db.transaction("immediate", () => {
      const approvals = new ApprovalRepository(this.db), approval = approvals.lockPendingForUpdate(approvalId);
      const snapshot = () => this.history.exchange({ ...command, submission: { kind: "cell.capacity.snapshot" } }, "mounted").history;
      const history = snapshot(), cell = this.cells.getCell(command);
      this.assertRequest(request, expectation, cell, history);
      const manifest = new RemoteWorkerAssignmentRepository(this.db).resolveActiveAuthorityByLeaseTokenHash(
        command.leaseTokenSha256, command.protectedAuthority)?.assignment.manifest;
      if (!manifest) throw conflict();
      const binding = { schemaVersion: "goatcitadel.native-runtime-approval.v1", registryWorkspaceId: command.registryWorkspaceId,
        assignmentId: command.assignmentId, assignmentGeneration: command.assignmentGeneration, profileSha256: cell.profileSha256, expectation,
        expectedCapacityRevision: cell.capacityRevision, expectedExecutionRevision: cell.executionRevision,
        expectedCleanupRevision: cell.cleanupRevision, expectedBackupRevision: cell.backupRevision };
      const now = Date.parse(this.clock.readDatabaseNow()), expiry = Date.parse(approval.expiresAt ?? ""), created = Date.parse(approval.createdAt);
      if (approval.kind !== "remote_worker.native_runtime" || !["danger", "nuclear"].includes(approval.riskLevel) ||
          !Number.isFinite(created) || !Number.isFinite(expiry) || created > now || expiry <= now ||
          approval.linkage?.workspaceId !== manifest.executionWorkspaceId || approval.linkage.taskId !== manifest.taskId ||
          approval.linkage.durableRunId !== manifest.durableRunId || approval.linkage.sessionId !== manifest.sessionId ||
          approval.linkage.turnId !== manifest.turnId || approval.linkage.actionType !== "remote_worker.native_runtime" ||
          canonicalJsonString(approval.payload.nativeRuntime) !== canonicalJsonString(binding)) throw conflict();
      this.assertDisclosure(approval.payload, command, request, expectation, manifest);
      if (canonicalJsonString(snapshot()) !== canonicalJsonString(history) || canonicalJsonString(this.cells.getCell(command)) !== canonicalJsonString(cell) ||
          canonicalJsonString(approvals.lockPendingForUpdate(approvalId)) !== canonicalJsonString(approval)) throw conflict();
    });
  }

  private assertDisclosure(payload: Record<string, unknown>, command: RemoteWorkerCellCapacityAuthority,
    request: WindowsRuntimeDispatchRequest, expected: RemoteWorkerRuntimeResultExpectation,
    manifest: { executionWorkspaceId: string; pathJailSha256: string }): void {
    if (payload.nativeFileDisclosure === undefined) return;
    const disclosure = normalizeRemoteWorkerNativeFileDisclosure(payload.nativeFileDisclosure);
    const wanted = normalizeRemoteWorkerNativeFileDisclosure({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA,
      destination: "gateway_artifacts", registryWorkspaceId: command.registryWorkspaceId, assignmentId: command.assignmentId,
      assignmentGeneration: command.assignmentGeneration, nonce: expected.nonce, requestSha256: expected.requestSha256,
      executionWorkspaceId: manifest.executionWorkspaceId, pathJailSha256: manifest.pathJailSha256,
      fileStagingSha256: remoteWorkerNativeFileStagingSha256(request.fileStaging) });
    if (canonicalJsonString(disclosure) !== canonicalJsonString(wanted)) throw conflict();
  }

  private assertRequest(request: WindowsRuntimeDispatchRequest, expectation: RemoteWorkerRuntimeResultExpectation,
    before: RemoteWorkerCellRecord | undefined, history: RemoteWorkerCellProvisioningExchange): asserts before is RemoteWorkerCellRecord {
    if (!before || before.executionState !== "ready" || before.cleanupState !== "not_started" ||
        before.nativePlatform?.backend !== "windows_native" || before.nativePlatform.runtimeBundleSha256 !== expectation.runtimeBundleSha256 ||
        !["disabled", "verified", "restored"].includes(before.backupState) ||
        expectation.maxOutputBytes > before.capacity.rawOutputLimitBytes ||
        history.mountedWorkspaceRecords?.length !== 2 || readRemoteWorkerCellMountedWorkspaceCheckpoint(
          remoteWorkerCellProvisioningMountedWorkspaceAnchor(history), history.mountedWorkspaceRecords[1]).recordSha256 !== expectation.checkpointSha256) throw conflict();

    const prepared = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]);
    const mounted = readRemoteWorkerCellMountedWorkspaceCheckpoint(remoteWorkerCellProvisioningMountedWorkspaceAnchor(history), history.mountedWorkspaceRecords[1]);
    const launch = request.launch, workspace = launch.protectedWorkspace!;
    if (this.cells.getEnvironmentAllowlistSha256(before) !== REMOTE_WORKER_NATIVE_ENVIRONMENT_SHA256 ||
        Object.keys(launch.environment).some(name => !REMOTE_WORKER_NATIVE_ENVIRONMENT_NAMES.some(allowed => allowed.toLowerCase() === name.toLowerCase()))) throw conflict();
    const identities = mounted.workspaceCheckpoint.directoryIdentityHex;
    const samePath = (left: string, right: string) => path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
    if (request.anchor.fileIdentity !== prepared.journalIdentityHex || request.anchor.preparedSha256 !== prepared.recordSha256 ||
        launch.jobName !== history.plan.cellName || launch.jobName !== before.nativePlatform.jobName ||
        launch.appContainerName !== before.nativePlatform.appContainerName || workspace.ownerSid !== history.plan.ownerSid ||
        workspace.controllerSid !== history.plan.controllerSid || workspace.parentIdentity !== mounted.workspaceCheckpoint.rootIdentityHex ||
        workspace.rootIdentity !== identities[0] || workspace.controlIdentity !== identities[1] ||
        workspace.runtimeIdentity !== identities[2] || workspace.workIdentity !== identities[3] ||
        !samePath(launch.runtimeRoot, path.win32.join(workspace.parentPath, launch.jobName, "runtime")) ||
        !samePath(launch.directory, path.win32.join(workspace.parentPath, launch.jobName, "work"))) throw conflict();
    for (const [limit, ceiling] of [["processLimit", "processLimit"], ["memoryBytes", "memoryLimitBytes"],
      ["cpuMilli", "cpuLimitMilli"], ["wallMs", "wallLimitMs"], ["rawOutputBytes", "rawOutputLimitBytes"],
      ["diagnosticBytes", "diagnosticLimitBytes"]] as const) {
      if (launch.limits[limit] > before.capacity[ceiling]) throw conflict();
    }
  }
}
