import assert from "node:assert/strict";
import { normalizeRemoteWorkerNativeFileDisclosure, remoteWorkerNativeFileStagingSha256,
  REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA, type RemoteWorkerNativeFileStaging } from "@goatcitadel/contracts";
import { createHash } from "node:crypto";
import { readRemoteWorkerCellMountedWorkspaceCheckpoint, remoteWorkerCellProvisioningMountedWorkspaceAnchor, readRemoteWorkerCellProvisioningCheckpoint,
  remoteWorkerCellCapacityInventorySha256, remoteWorkerRuntimeBundleManifestSha256 } from "@goatcitadel/contracts";
import { prepareWindowsRuntimeDispatch } from "@goatcitadel/contracts/remote-worker-runtime-node";
import { capacityInventoryFixture } from "../../contracts/src/remote-worker-cell-capacity-inventory-test-fixture.js";
import { verifyCellProvisioningExchange } from "./remote-worker-cell-exchange-fixture.js";
import { RemoteWorkerRuntimeAdmissionRepository } from "./remote-worker-runtime-admission-repo.js";
import { RemoteWorkerRuntimeResultRepository } from "./remote-worker-runtime-result-repo.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { ApprovalRepository } from "./approval-repo.js";
import { ApprovalWaitRunRepository } from "./approval-wait-run-repo.js";

/** Real SQLite/PostgreSQL authority with controlled complete native journal and
 * inventory captures. No installed service, disk, provider or job is invoked. */
export const verifyRuntimeAdmission: typeof verifyCellProvisioningExchange = (...args) => verifyRuntimeAdmissionWithDisclosure(undefined, ...args);
export const verifyRuntimeAdmissionWithDisclosure = (fileStaging: RemoteWorkerNativeFileStaging | undefined,
  ...[db, key, token, fence, revoke, onComplete]: Parameters<typeof verifyCellProvisioningExchange>) => {
  verifyCellProvisioningExchange(db, key, token, fence, revoke, (authority, history) => {
    const owner = new RemoteWorkerRuntimeAdmissionRepository(db), cells = new RemoteWorkerCellRepository(db);
    const results = new RemoteWorkerRuntimeResultRepository(db), clock = new DurableRunRepository(db);
    const assignments = new RemoteWorkerAssignmentRepository(db), digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const journal = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]);
    const mounted = readRemoteWorkerCellMountedWorkspaceCheckpoint(remoteWorkerCellProvisioningMountedWorkspaceAnchor(history), history.mountedWorkspaceRecords![1]);
    const jobName = history.plan.cellName, parentPath = "C:\\controlled-mounted-volume", root = `${parentPath}\\${jobName}`;
    const identities = mounted.workspaceCheckpoint.directoryIdentityHex;
    const runtimeBundle = { schemaVersion: "goatcitadel.worker-runtime-bundle.v1" as const,
      files: [{ relativePath: "entry.exe", bytes: 3, sha256: digest("controlled-image") }] };
    const request = { nonce: digest("one-attempt"), ...(fileStaging ? { fileStaging } : {}), anchor: { fileIdentity: journal.journalIdentityHex, preparedSha256: journal.recordSha256 },
      checkpointSha256: mounted.recordSha256, inventoryLimits: { maxEntries: 20000, maxDepth: 64, wallMs: 10000 },
      launch: { jobName, appContainerName: `GoatCitadel.Worker.${jobName.slice(8)}`, image: `${root}\\runtime\\entry.exe`,
        commandLine: `"${root}\\runtime\\entry.exe" controlled`, directory: `${root}\\work`, runtimeRoot: `${root}\\runtime`,
        imageSha256: digest("controlled-image"), directoryIdentity: identities[3]!, runtimeRootIdentity: identities[2]!, runtimeBundle,
        runtimeBundleSha256: remoteWorkerRuntimeBundleManifestSha256(runtimeBundle), environment: { SystemRoot: "C:\\Windows" },
        limits: { processLimit: 1, memoryBytes: 64 * 1024 * 1024, cpuMilli: 1000, wallMs: 60000, rawOutputBytes: 65536, diagnosticBytes: 1024, inputBytes: 100 },
        protectedWorkspace: { parentPath, parentIdentity: mounted.workspaceCheckpoint.rootIdentityHex,
          rootIdentity: identities[0]!, controlIdentity: identities[1]!, runtimeIdentity: identities[2]!, workIdentity: identities[3]!,
          ownerSid: history.plan.ownerSid, controllerSid: history.plan.controllerSid } } };
    const expectation = prepareWindowsRuntimeDispatch(request).expectation;
    const approvals = new ApprovalRepository(db);
    const manifest = assignments.resolveActiveAuthorityByLeaseTokenHash(authority.leaseTokenSha256, fence)!.assignment.manifest;
    let approvalId = "";
    let capture = 0;
    const command = () => {
      const cell = cells.getCell(key)!, inventory = capacityInventoryFixture(cell.profileSha256, `${key.assignmentId}:${++capture}`);
      return { ...authority, approvalId, expectation, request: structuredClone(request), expectedCapacityRevision: cell.capacityRevision, expectedExecutionRevision: cell.executionRevision,
        expectedCleanupRevision: cell.cleanupRevision, expectedBackupRevision: cell.backupRevision, inventory,
        inventoryBinding: { profileSha256: inventory.profileSha256, captureSha256: inventory.captureSha256,
          inventorySha256: remoteWorkerCellCapacityInventorySha256(inventory) },
        observation: { reservation: cell.capacity, incomingBytes: 1000, peakDiskBytes: 0, peakMemoryBytes: 0,
          peakFileCount: 0, peakProcessCount: 0, rawOutputBytes: 0 } };
    };
    const counts = () => ["remote_worker_cell_capacity_inventories", "remote_worker_runtime_expectations", "remote_worker_runtime_results"]
      .map(table => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: number | string }>()!.count));
    const snapshot = () => ({ cell: cells.getCell(key), evidence: cells.listEvidenceAfter(key, 0), counts: counts() });
    assert.throws(() => owner.admitPreparedForAssignment(command()));
    const preparationInput = { ...authority, launch: request.launch, inventoryLimits: request.inventoryLimits,
      ...(fileStaging ? { fileStaging, discloseFilesToGateway: true } : {}) };
    assert.throws(() => owner.prepareRequestForAssignment(preparationInput));
    const prepared = cells.getCell(key)!, suffix = jobName.slice(8);
    cells.persistPlatformIdentity({ ...key, provisioningOwner: prepared.provisioningOwner!, provisioningLeaseExpiresAt: prepared.provisioningLeaseExpiresAt!,
      platformIdentity: { schemaVersion: "goatcitadel.remote-worker-cell-platform.v2", backend: "windows_native",
        jobName: `gc-cell-${suffix}`, appContainerName: `GoatCitadel.Worker.${suffix}`, volumeIdentitySha256: digest("planned-volume"),
        runtimeBundleSha256: expectation.runtimeBundleSha256, launcherSha256: digest("planned-launcher"), networkPolicy: "deny_all" },
      detailSha256: digest("controlled-platform"), now: clock.readDatabaseNow() });
    const reviewCell = cells.getCell(key)!;
    const review = { kind: "remote_worker.native_runtime", riskLevel: "danger" as const,
      payload: { nativeRuntime: { schemaVersion: "goatcitadel.native-runtime-approval.v1", ...key,
        profileSha256: reviewCell.profileSha256, expectation, expectedCapacityRevision: reviewCell.capacityRevision,
        expectedExecutionRevision: reviewCell.executionRevision, expectedCleanupRevision: reviewCell.cleanupRevision,
        expectedBackupRevision: reviewCell.backupRevision }, ...(fileStaging ? { nativeFileDisclosure: normalizeRemoteWorkerNativeFileDisclosure({
          schemaVersion: REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA, destination: "gateway_artifacts", ...key,
          nonce: expectation.nonce, requestSha256: expectation.requestSha256, executionWorkspaceId: manifest.executionWorkspaceId,
          pathJailSha256: manifest.pathJailSha256, fileStagingSha256: remoteWorkerNativeFileStagingSha256(fileStaging) }) } : {}) },
      preview: { title: "Controlled native launch review" },
      linkage: { workspaceId: manifest.executionWorkspaceId, taskId: manifest.taskId, durableRunId: manifest.durableRunId,
        sessionId: manifest.sessionId, turnId: manifest.turnId, actionType: "remote_worker.native_runtime" } };
    approvalId = approvals.createWithTtlDuration(review, 300_000).approvalId;
    // Exercise the persisted native Chat review lookup on both real dialects.
    const waits = new ApprovalWaitRunRepository(db);
    const lookupScope = { ...key, workspaceId: manifest.executionWorkspaceId, taskId: manifest.taskId,
      durableRunId: manifest.durableRunId, sessionId: "lookup-session", turnId: "lookup-turn" };
    const lookupReview = approvals.createWithTtlDuration({ ...review,
      linkage: { ...review.linkage, sessionId: lookupScope.sessionId, turnId: lookupScope.turnId } }, 300_000);
    waits.createOrGet({ approvalId: lookupReview.approvalId, runId: `wait-${lookupReview.approvalId}` });
    assert.equal(waits.findUnresolvedNativeForAssignment(lookupScope)?.approvalId, lookupReview.approvalId);
    assert.equal(waits.findUnresolvedNativeForAssignment({ ...lookupScope, assignmentGeneration: key.assignmentGeneration + 1 }), undefined);
    approvals.resolve(lookupReview.approvalId, { decision: "approve", resolvedBy: "controlled-operator" });
    assert.equal(waits.findUnresolvedNativeForAssignment(lookupScope)?.approvalId, lookupReview.approvalId);
    waits.markResolved(lookupReview.approvalId);
    assert.equal(waits.findUnresolvedNativeForAssignment(lookupScope), undefined);
    assert.throws(() => approvals.resolve(approvalId, { decision: "edit", editedPayload: {}, resolvedBy: "controlled-operator" }));
    assert.throws(() => approvals.resolve(approvalId, { decision: "approve", editedPayload: {}, resolvedBy: "controlled-operator" }));
    assert.throws(() => approvals.mergeLinkage(approvalId, { taskId: "foreign" }));
    approvals.resolve(approvalId, { decision: "approve", resolvedBy: "controlled-operator" });
    assert.throws(() => approvals.mergeLinkage(approvalId, { taskId: "foreign" }));
    const initial = snapshot();
    const mutableFileStaging = { paths: ["report.txt", "nested/result.json"], maximumFileBytes: 1024, maximumTotalBytes: 2048 };
    const candidate = owner.prepareRequestForAssignment({ ...preparationInput, fileStaging: mutableFileStaging });
    mutableFileStaging.paths[0] = "unreviewed.txt";
    assert.deepEqual(candidate.request.fileStaging?.paths, ["report.txt", "nested/result.json"]);
    assert.equal(Object.isFrozen(candidate.request.fileStaging?.paths), true);
    assert.equal(JSON.stringify(candidate.approvalDraft).includes("report.txt"), false);
    assert.equal(candidate.decision, "review_required");
    assert.deepEqual(candidate.request.anchor, request.anchor);
    assert.equal(candidate.request.checkpointSha256, request.checkpointSha256);
    assert.deepEqual(candidate.request.launch, request.launch);
    assert.notEqual(candidate.request.nonce, request.nonce);
    assert.notEqual(candidate.request.nonce, owner.prepareRequestForAssignment(preparationInput).request.nonce);
    assert.deepEqual(candidate.candidateExpectation, prepareWindowsRuntimeDispatch(candidate.request).expectation);
    assert.equal(candidate.revisions.expectedExecutionRevision, initial.cell!.executionRevision);
    assert.equal(Object.isFrozen(candidate.request.launch.limits), true);
    assert.equal(candidate.approvalDraft.linkage?.taskId, manifest.taskId);
    assert.equal(candidate.approvalDraft.linkage?.durableRunId, manifest.durableRunId);
    assert.equal(candidate.approvalDraft.linkage?.workspaceId, manifest.executionWorkspaceId);
    assert.equal(Object.isFrozen(candidate.approvalDraft.payload.nativeRuntime), true);
    assert.equal(JSON.stringify(candidate.approvalDraft).includes(request.launch.commandLine), false);
    const rollbackDraft = new Error("rollback controlled draft approval");
    assert.throws(() => db.transaction("immediate", () => {
      const drafted = approvals.createWithTtlDuration(candidate.approvalDraft, 300_000);
      owner.validatePendingReviewForAssignment({ ...authority, approvalId: drafted.approvalId, request: candidate.request });
      for (const fileStaging of [undefined, { paths: ["other.txt"], maximumFileBytes: 1024, maximumTotalBytes: 2048 },
        { ...candidate.request.fileStaging!, maximumFileBytes: 1025 }, { ...candidate.request.fileStaging!, maximumTotalBytes: 2049 }]) {
        assert.throws(() => owner.validatePendingReviewForAssignment({ ...authority, approvalId: drafted.approvalId,
          request: { ...candidate.request, fileStaging } }), "file collection substitutions invalidate the retained review");
      }
      assert.throws(() => owner.validatePendingReviewForAssignment({ ...authority, approvalId: drafted.approvalId,
        request: { ...candidate.request, nonce: digest("changed-review") } }));
      assert.throws(() => owner.admitPreparedForAssignment({ ...command(), approvalId: drafted.approvalId,
        request: candidate.request, expectation: candidate.candidateExpectation }));
      approvals.resolve(drafted.approvalId, { decision: "approve", resolvedBy: "controlled-operator" });
      assert.throws(() => owner.validatePendingReviewForAssignment({ ...authority, approvalId: drafted.approvalId, request: candidate.request }));
      const admitted = owner.admitPreparedForAssignment({ ...command(), approvalId: drafted.approvalId,
        request: candidate.request, expectation: candidate.candidateExpectation });
      assert.equal(admitted.decision, "accept");
      throw rollbackDraft;
    }), error => error === rollbackDraft);
    const approvalCount = () => Number(db.prepare("SELECT COUNT(*) AS count FROM approvals").get<{count: number | string}>()!.count);
    const reviewsBefore = approvalCount();
    assert.throws(() => db.transaction("immediate", () => {
      const drafted = approvals.createWithTtlDuration(candidate.approvalDraft, 300_000);
      cells.transitionCleanup({ ...key, expectedRevision: cells.getCell(key)!.cleanupRevision, toState: "pending", detailSha256: digest("review-stale"), now: clock.readDatabaseNow() });
      owner.validatePendingReviewForAssignment({ ...authority, approvalId: drafted.approvalId, request: candidate.request });
    }));
    assert.equal(approvalCount(), reviewsBefore, "a failed creation hook rolls back its approval");
    assert.deepEqual(snapshot(), initial, "preparation cannot persist capacity, state or expectation");
    assert.throws(() => results.findForAssignment({ ...authority, nonce: candidate.request.nonce }));
    const substituted = command(); substituted.request.launch.commandLine += " unapproved";
    assert.throws(() => owner.admitPreparedForAssignment(substituted));
    assert.deepEqual(snapshot(), initial);
    for (const patch of [
      { status: "pending" }, { status: "rejected" }, { status: "edited" }, { kind: "tool.invoke" },
      { risk_level: "safe" }, { expires_at: "2000-01-01T00:00:00.000Z" }, { expires_at: null },
      { resolved_by: "" }, { resolved_at: null },
      { linkage_json: JSON.stringify({ ...review.linkage, taskId: "foreign" }) },
      { linkage_json: JSON.stringify({ ...review.linkage, durableRunId: "foreign" }) },
      { linkage_json: JSON.stringify({ ...review.linkage, workspaceId: "foreign" }) },
      { linkage_json: JSON.stringify({ ...review.linkage, sessionId: "foreign", turnId: "foreign" }) },
      { linkage_json: JSON.stringify({ ...review.linkage, actionType: "tool.invoke" }) },
      { payload_json: JSON.stringify({ nativeRuntime: { ...review.payload.nativeRuntime, expectedCapacityRevision: 999 } }) },
      { payload_json: JSON.stringify({ nativeRuntime: { ...review.payload.nativeRuntime, expectedExecutionRevision: 999 } }) },
      { payload_json: JSON.stringify({ nativeRuntime: { ...review.payload.nativeRuntime, expectedCleanupRevision: 999 } }) },
      { payload_json: JSON.stringify({ nativeRuntime: { ...review.payload.nativeRuntime, expectedBackupRevision: 999 } }) },
      { payload_json: JSON.stringify({ nativeRuntime: { ...review.payload.nativeRuntime, assignmentGeneration: 999 } }) },
      { payload_json: JSON.stringify({ nativeRuntime: { ...review.payload.nativeRuntime, expectation: { ...expectation, nonce: digest("foreign") } } }) },
    ]) {
      const rollback = new Error("rollback controlled approval tamper");
      assert.throws(() => db.transaction("immediate", () => {
        for (const [column, value] of Object.entries(patch)) db.prepare(`UPDATE approvals SET ${column} = @value WHERE approval_id = @approvalId`).run({ value, approvalId });
        assert.throws(() => owner.admitPreparedForAssignment(command()));
        assert.deepEqual(snapshot(), initial);
        throw rollback;
      }), error => error === rollback);
    }
    assert.throws(() => owner.admitPreparedForAssignment({ ...command(), approvalId: "missing-review" }));
    for (const name of ["NODE_OPTIONS", "PATH", "GOATCITADEL_TOKEN", "TEMP_EXTRA"]) {
      const launch = { ...request.launch, environment: { ...request.launch.environment, [name]: "controlled-value" } };
      assert.throws(() => owner.prepareRequestForAssignment({ ...preparationInput, launch }), `refuse environment name ${name}`);
    }
    const allowedEnvironment = owner.prepareRequestForAssignment({ ...preparationInput,
      launch: { ...request.launch, environment: { systemroot: "C:\\Windows", temp: request.launch.directory, TMP: request.launch.directory } } });
    assert.equal(allowedEnvironment.request.launch.environment.temp, request.launch.directory);
    const readEnvironment = RemoteWorkerCellRepository.prototype.getEnvironmentAllowlistSha256;
    try {
      RemoteWorkerCellRepository.prototype.getEnvironmentAllowlistSha256 = () => digest("foreign-policy");
      assert.throws(() => owner.prepareRequestForAssignment(preparationInput), "a different persisted policy cannot use the native allowlist");
      assert.throws(() => owner.admitPreparedForAssignment(command()));
    } finally { RemoteWorkerCellRepository.prototype.getEnvironmentAllowlistSha256 = readEnvironment; }
    assert.deepEqual(snapshot(), initial);
    for (const change of [
      (value: typeof request) => { value.anchor.fileIdentity = "f".repeat(48); },
      (value: typeof request) => { value.anchor.preparedSha256 = digest("other-journal"); },
      (value: typeof request) => { value.launch.protectedWorkspace.ownerSid = "S-1-5-21-1-2-3-1001"; },
      (value: typeof request) => { value.launch.protectedWorkspace.controllerSid = "S-1-5-80-5-4-3-2-1"; },
      (value: typeof request) => { value.launch.protectedWorkspace.rootIdentity = value.launch.protectedWorkspace.parentIdentity.slice(0, 16) + "f".repeat(32); },
      (value: typeof request) => { value.launch.protectedWorkspace.parentIdentity = value.launch.protectedWorkspace.parentIdentity.slice(0, 16) + "f".repeat(32); },
      (value: typeof request) => { value.launch.protectedWorkspace.controlIdentity = value.launch.protectedWorkspace.parentIdentity.slice(0, 16) + "f".repeat(32); },
      (value: typeof request) => { value.launch.runtimeRootIdentity = value.launch.protectedWorkspace.runtimeIdentity = value.launch.protectedWorkspace.parentIdentity.slice(0, 16) + "f".repeat(32); },
      (value: typeof request) => { value.launch.directoryIdentity = value.launch.protectedWorkspace.workIdentity = value.launch.protectedWorkspace.parentIdentity.slice(0, 16) + "f".repeat(32); },
      (value: typeof request) => { value.launch.directory += "\\other"; },
      (value: typeof request) => { value.launch.runtimeRoot += "\\other"; value.launch.image = `${value.launch.runtimeRoot}\\entry.exe`; },
      (value: typeof request) => { value.launch.jobName = `gc-cell-${"a".repeat(32)}`; value.launch.appContainerName = `GoatCitadel.Worker.${"a".repeat(32)}`; },
      (value: typeof request) => { value.launch.limits.processLimit = 3; },
      (value: typeof request) => { value.launch.limits.memoryBytes += 1; },
      (value: typeof request) => { value.launch.limits.cpuMilli += 1; },
      (value: typeof request) => { value.launch.limits.wallMs += 1; },
      (value: typeof request) => { value.launch.limits.rawOutputBytes += 1; },
    ]) {
      const changed = command(); change(changed.request);
      // Even a self-consistent projection cannot override the canonical cell.
      changed.expectation = prepareWindowsRuntimeDispatch(changed.request).expectation;
      assert.throws(() => owner.admitPreparedForAssignment(changed));
      if (JSON.stringify(changed.request.launch) !== JSON.stringify(request.launch))
        assert.throws(() => owner.prepareRequestForAssignment({ ...preparationInput, launch: changed.request.launch }));
      assert.deepEqual(snapshot(), initial);
    }
    for (const patch of [{ assignmentId: "foreign" }, { assignmentGeneration: 999 }, { leaseRevision: 999 }, { leaseTokenSha256: "f".repeat(64) },
      { protectedAuthority: undefined }, { expectedCapacityRevision: 999 }, { expectedExecutionRevision: 999 }, { expectedCleanupRevision: 999 }, { expectedBackupRevision: 999 },
      { expectation: { ...expectation, runtimeBundleSha256: digest("foreign") } },
      { expectation: { ...expectation, checkpointSha256: digest("foreign") } }, { expectation: { ...expectation, maxOutputBytes: 65537 } },
      { protectedAuthority: { ...fence, credentialAuthority: { ...fence.credentialAuthority, credentialGeneration: 999 } } }]) {
      assert.throws(() => owner.admitPreparedForAssignment({ ...command(), ...patch } as ReturnType<typeof command>));
      assert.deepEqual(snapshot(), initial);
    }
    const rejected = command(); rejected.observation.incomingBytes = rejected.observation.reservation.allocatedDiskBytes + 1;
    assert.equal(owner.admitPreparedForAssignment(rejected).decision, "reject");
    assert.deepEqual(snapshot(), initial);

    // Quarantine evidence must commit without creating a runnable attempt.
    // Roll back this test-only outer transaction to exercise acceptance below.
    const rollbackFixture = new Error("rollback controlled quarantine fixture");
    assert.throws(() => db.transaction("immediate", () => {
      const high = command(); high.observation.peakMemoryBytes = high.observation.reservation.memoryLimitBytes + 1;
      const blocked = owner.admitPreparedForAssignment(high);
      assert.equal(blocked.decision, "quarantine"); assert.equal(blocked.cell.executionState, "ready");
      assert.deepEqual(counts(), [1, 0, 0]);
      assert.throws(() => owner.admitPreparedForAssignment(command()), "changed capacity revision requires fresh operator review");
      assert.deepEqual(counts(), [1, 0, 0]);
      throw rollbackFixture;
    }), error => error === rollbackFixture);
    assert.deepEqual(snapshot(), initial);

    const parentId = assignments.resolveActiveAuthorityByLeaseTokenHash(authority.leaseTokenSha256, fence)!.assignment.manifest.durableRunId;
    for (const interruption of ["capacity_write", "transition_write", "expectation_write", "approval", "revoke", "parent", "lease", "cleanup", "backup", "execution"] as const) {
      const prepare = db.prepare.bind(db); let applied = false;
      db.prepare = sql => {
        const statement = prepare(sql);
        const target = interruption === "capacity_write" ? /^INSERT INTO remote_worker_cell_capacity_inventories/u
          : interruption === "transition_write" ? /^UPDATE remote_worker_cells\s+SET execution_state/u
          : /^INSERT INTO remote_worker_runtime_expectations/u;
        if (target.test(sql)) {
          const run = statement.run.bind(statement);
          statement.run = params => {
            const result = run(params); if (applied) return result; applied = true;
            if (interruption.endsWith("_write")) throw new Error("controlled post-write failure");
            if (interruption === "approval") prepare("UPDATE approvals SET status = 'rejected' WHERE approval_id = @approvalId").run({ approvalId });
            else if (interruption === "revoke") revoke();
            else if (interruption === "parent") {
              const parent = clock.getRun(parentId);
              clock.updateRun({ runId: parentId, status: "cancelled", clearLease: true, expectedVersion: parent.version });
            } else if (interruption === "lease") {
              assignments.renewLease({ ...key, expectedAssignmentGeneration: key.assignmentGeneration, expectedLeaseRevision: authority.leaseRevision,
                expectedLeaseTokenSha256: authority.leaseTokenSha256, leaseTokenSha256: digest("changed-lease"),
                workerSentThrough: 0, idempotencyKey: "runtime-admission-renewal" }, fence);
            } else if (interruption === "cleanup") cells.transitionCleanup({ ...key, expectedRevision: cells.getCell(key)!.cleanupRevision, toState: "pending", detailSha256: digest("cleanup"), now: clock.readDatabaseNow() });
            else if (interruption === "backup") cells.transitionBackup({ ...key, expectedRevision: cells.getCell(key)!.backupRevision, toState: "pending", detailSha256: digest("backup"), now: clock.readDatabaseNow() });
            else cells.transitionExecution({ ...key, expectedRevision: cells.getCell(key)!.executionRevision, toState: "running", detailSha256: digest("unexpected-running"), now: clock.readDatabaseNow() });
            return result;
          };
        }
        return statement;
      };
      let interruptionError: unknown;
      try { assert.throws(() => owner.admitPreparedForAssignment(command()), error => { interruptionError = error; return true; }); }
      finally { db.prepare = prepare; }
      assert.equal(applied, true, `${interruption}: ${String(interruptionError)}`); assert.deepEqual(snapshot(), initial, interruption);
      assert.throws(() => results.findForAssignment({ ...authority, nonce: expectation.nonce }));
    }
    const input = command(), accepted = owner.admitPreparedForAssignment(input);
    assert.equal(accepted.decision, "accept"); if (accepted.decision !== "accept") throw new Error("Expected acceptance");
    assert.deepEqual(accepted.expectation, expectation); assert.equal(accepted.cell.executionState, "starting");
    assert.equal(accepted.cell.executionRevision, initial.cell!.executionRevision + 1);
    assert.equal(accepted.cell.capacityRevision, initial.cell!.capacityRevision + 1);
    assert.deepEqual(counts(), [1, 1, 0]);
    assert.equal(db.prepare(`SELECT approval_id FROM remote_worker_runtime_expectations
      WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
      AND assignment_generation = @assignmentGeneration AND nonce = @nonce`)
      .get<{ approval_id: string }>({ ...key, nonce: expectation.nonce })?.approval_id, approvalId);
    const retainedInput = { ...authority, expectation, expectedExecutionRevision: accepted.cell.executionRevision };
    assert.deepEqual(results.retainExpectationForAssignment({ ...retainedInput, approvalId }), expectation);
    assert.throws(() => results.retainExpectationForAssignment(retainedInput), "replay cannot remove the admitting approval");
    assert.throws(() => results.retainExpectationForAssignment({ ...retainedInput, approvalId: lookupReview.approvalId }), "replay cannot substitute another approval");
    assert.throws(() => db.prepare("UPDATE remote_worker_runtime_expectations SET approval_id = NULL WHERE approval_id = @approvalId")
      .run({ approvalId }), /immutable/u);
    assert.equal(results.findForAssignment({ ...authority, nonce: expectation.nonce }), null);
    const authorization = { ...authority, nonce: expectation.nonce, requestSha256: expectation.requestSha256, phase: "execution" as const };
    assert.deepEqual(results.authorizeForAssignment(authorization), expectation);
    assert.deepEqual(results.authorizeForAssignment({ ...authorization, phase: "delivery" }), expectation);
    for (const patch of [{ nonce: digest("another-request") }, { requestSha256: digest("different-bytes") },
      { leaseRevision: 999 }, { leaseTokenSha256: digest("old-lease") }, { assignmentGeneration: 999 },
      { protectedAuthority: undefined }, { phase: "unknown" }]) {
      assert.throws(() => results.authorizeForAssignment({ ...authorization, ...patch } as typeof authorization));
    }
    const authorizationSnapshot = snapshot(), rollbackAuthorization = new Error("rollback authorization fixture");
    for (const mutation of ["approval", "expiry", "binding", "cleanup", "backup", "running", "terminal", "result", "revoke"] as const) {
      assert.throws(() => db.transaction("immediate", () => {
        if (mutation === "approval") db.prepare("UPDATE approvals SET status = 'rejected' WHERE approval_id = @approvalId").run({ approvalId });
        else if (mutation === "expiry") db.prepare("UPDATE approvals SET expires_at = created_at WHERE approval_id = @approvalId").run({ approvalId });
        else if (mutation === "binding") db.prepare("UPDATE approvals SET payload_json = '{}' WHERE approval_id = @approvalId").run({ approvalId });
        else if (mutation === "cleanup") cells.transitionCleanup({ ...key, expectedRevision: cells.getCell(key)!.cleanupRevision, toState: "pending", detailSha256: digest(mutation), now: clock.readDatabaseNow() });
        else if (mutation === "backup") cells.transitionBackup({ ...key, expectedRevision: cells.getCell(key)!.backupRevision, toState: "pending", detailSha256: digest(mutation), now: clock.readDatabaseNow() });
        else if (mutation === "revoke") revoke();
        else if (mutation === "terminal") cells.transitionExecution({ ...key, expectedRevision: cells.getCell(key)!.executionRevision, toState: "failed", detailSha256: digest(mutation), now: clock.readDatabaseNow() });
        else if (mutation === "result") {
          const result = Buffer.alloc(256); result.write("GCRRS001");
          for (const [offset, value] of [[8, expectation.nonce], [40, expectation.requestSha256], [72, expectation.checkpointSha256]] as const)
            Buffer.from(value, "hex").copy(result, offset);
          result.writeUInt32LE(1, 104); result.writeUInt32LE(4, 108);
          results.retainForAssignment({ ...authority, nonce: expectation.nonce, resultHex: result.toString("hex") });
        }
        else cells.transitionExecution({ ...key, expectedRevision: cells.getCell(key)!.executionRevision, toState: "running", detailSha256: digest(mutation), now: clock.readDatabaseNow() });
        if (mutation === "running") {
          assert.deepEqual(results.authorizeForAssignment(authorization), expectation);
          assert.deepEqual(results.authorizeForAssignment({ ...authorization, phase: "delivery" }), expectation);
        } else if (mutation === "result") {
          assert.throws(() => results.authorizeForAssignment(authorization), "a retained failure is not permission to execute again");
          assert.deepEqual(results.authorizeForAssignment({ ...authorization, phase: "delivery" }), expectation);
        } else {
          assert.throws(() => results.authorizeForAssignment(authorization), mutation);
          assert.throws(() => results.authorizeForAssignment({ ...authorization, phase: "delivery" }), mutation);
        }
        throw rollbackAuthorization;
      }), error => error === rollbackAuthorization);
      assert.deepEqual(snapshot(), authorizationSnapshot);
      assert.deepEqual(results.authorizeForAssignment(authorization), expectation);
    }
    const afterRevoke = onComplete?.(authority, history);
    const saved = snapshot();
    assert.throws(() => owner.admitPreparedForAssignment(input));
    assert.throws(() => owner.admitPreparedForAssignment(command()), "fresh revisions cannot redispatch an admitted attempt");
    assert.throws(() => owner.prepareRequestForAssignment(preparationInput), "starting cells cannot mint another candidate");
    assert.deepEqual(snapshot(), saved);
    assert.equal(JSON.stringify(accepted).includes(authority.leaseTokenSha256), false);
    return () => {
      afterRevoke?.();
      assert.throws(() => owner.admitPreparedForAssignment(command()));
      assert.throws(() => owner.prepareRequestForAssignment(preparationInput));
      assert.throws(() => results.findForAssignment({ ...authority, nonce: expectation.nonce }));
      assert.throws(() => results.authorizeForAssignment(authorization));
      assert.deepEqual(snapshot(), saved);
    };
  });
};
