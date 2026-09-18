import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION, type RemoteWorkerCellCapacityAdmissionObservation } from "@goatcitadel/contracts";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { RemoteWorkerCellCapacityAdmissionRepository } from "./remote-worker-cell-capacity-admission-repo.js";
import { verifyCellProvisioningExchange } from "./remote-worker-cell-exchange-fixture.js";

/** Both dialects use real protected worker/mesh/parent authority. Native history
 * and footprints are controlled fixtures; there is no volume or provider use. */
export const verifyCellCapacityAdmission: typeof verifyCellProvisioningExchange = (db, key, token, fence, revoke) => {
  verifyCellProvisioningExchange(db, key, token, fence, revoke, current => {
    const repo = new RemoteWorkerCellCapacityAdmissionRepository(db), cells = new RemoteWorkerCellRepository(db);
    const clock = new DurableRunRepository(db), assignments = new RemoteWorkerAssignmentRepository(db);
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    let authority = { registryWorkspaceId: current.registryWorkspaceId, assignmentId: current.assignmentId,
      assignmentGeneration: current.assignmentGeneration, leaseRevision: current.leaseRevision,
      leaseTokenSha256: current.leaseTokenSha256, protectedAuthority: current.protectedAuthority };
    const prepared = repo.readForAssignment(authority);
    // Model the existing planned-identity boundary before exercising diagnostic
    // transitions. These are controlled database identities, not OS readiness.
    const identitySuffix = digest(`${key.assignmentId}:planned-platform`).slice(0, 32);
    cells.persistPlatformIdentity({ ...key, provisioningOwner: prepared.provisioningOwner!,
      provisioningLeaseExpiresAt: prepared.provisioningLeaseExpiresAt!,
      platformIdentity: { schemaVersion: "goatcitadel.remote-worker-cell-platform.v2", backend: "windows_native",
        jobName: `gc-cell-${identitySuffix}`, appContainerName: `GoatCitadel.Worker.${identitySuffix}`,
        volumeIdentitySha256: digest("planned-volume"), runtimeBundleSha256: digest("planned-runtime"),
        launcherSha256: digest("planned-launcher"), networkPolicy: "deny_all" },
      detailSha256: digest("planned-platform"), now: clock.readDatabaseNow() });
    const original = repo.readForAssignment(authority);
    const base: RemoteWorkerCellCapacityAdmissionObservation = {
      reservation: original.capacity, incomingBytes: 1_000,
      peakDiskBytes: 1_000, peakMemoryBytes: 10, peakFileCount: 1, peakProcessCount: 1, rawOutputBytes: 100,
      footprint: { schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION, mutableRootBytes: 1_000,
        inputStagingBytes: 0, backupStagingBytes: 0, artifactStagingBytes: 0, immutableArtifactBytes: 0,
        retainedOutboxBytes: 0, databaseSidecarBytes: 0, backupPublicationBytes: 0, manifestBytes: 0,
        proxySidecarBytes: 0, diagnosticBytes: 0, failedCleanupBytes: 0, quarantineEvidenceBytes: 0 },
    };
    const command = (observation = base) => {
      const cell = cells.getCell(key)!;
      return { ...authority, observation, expectedCapacityRevision: cell.capacityRevision,
        expectedCleanupRevision: cell.cleanupRevision, expectedExecutionRevision: cell.executionRevision };
    };
    const evidence = () => cells.listEvidenceAfter(key, 0);
    const originalEvidence = evidence();
    for (const patch of [{ assignmentId: "foreign" }, { registryWorkspaceId: "foreign" }, { assignmentGeneration: 999 },
      { leaseRevision: 999 }, { leaseTokenSha256: "f".repeat(64) }, { protectedAuthority: undefined },
      { protectedAuthority: { ...fence, credentialAuthority: { ...fence.credentialAuthority, credentialGeneration: 999 } } }]) {
      assert.throws(() => repo.readForAssignment({ ...authority, ...patch } as typeof authority));
      assert.throws(() => repo.admit({ ...command(), ...patch } as ReturnType<typeof command>));
      assert.deepEqual(cells.getCell(key), original);
      assert.deepEqual(evidence(), originalEvidence);
    }
    assert.throws(() => repo.admit(command({ ...base, reservation: { ...base.reservation, allocatedDiskBytes: base.reservation.allocatedDiskBytes + 1 } })), /immutable.*reservation/u);
    const rejected = repo.admit(command({ ...base, incomingBytes: base.reservation.allocatedDiskBytes + 1 }));
    assert.equal(rejected.decision, "reject");
    assert.deepEqual(rejected.cell, original);
    assert.deepEqual(evidence(), originalEvidence);

    const firstCommand = command(), before = clock.readDatabaseNow();
    const accepted = repo.admit(firstCommand);
    assert.equal(accepted.decision, "accept");
    assert.equal(accepted.cell.capacityRevision, original.capacityRevision + 1);
    assert.ok(accepted.cell.updatedAt >= before && accepted.cell.updatedAt <= clock.readDatabaseNow());
    assert.deepEqual(new RemoteWorkerCellCapacityAdmissionRepository(db).readForAssignment(authority), accepted.cell);
    assert.throws(() => repo.admit(firstCommand), /capacity revision/u);
    assert.equal(evidence().filter(row => row.domain === "capacity").length, originalEvidence.filter(row => row.domain === "capacity").length + 1);

    // A protected lease renewal fences both prior reads and prior writes.
    const renewedToken = digest(`${key.assignmentId}:capacity-renewal`);
    const priorAuthority = authority;
    assignments.renewLease({ registryWorkspaceId: key.registryWorkspaceId, assignmentId: key.assignmentId,
      expectedAssignmentGeneration: key.assignmentGeneration, expectedLeaseRevision: authority.leaseRevision,
      expectedLeaseTokenSha256: authority.leaseTokenSha256, leaseTokenSha256: renewedToken,
      workerSentThrough: 0, idempotencyKey: "capacity-admission-renewal" }, fence);
    authority = { ...authority, leaseRevision: authority.leaseRevision + 1, leaseTokenSha256: renewedToken };
    assert.throws(() => repo.readForAssignment(priorAuthority));
    assert.throws(() => repo.admit({ ...command(), ...priorAuthority }));

    const parentId = assignments.resolveActiveAuthorityByLeaseTokenHash(authority.leaseTokenSha256, fence)!.assignment.manifest.durableRunId;
    for (const interruption of ["parent", "diagnostics", "cleanup", "lease"] as const) {
      const priorCell = cells.getCell(key)!, priorEvidence = evidence();
      const prepare = db.prepare.bind(db);
      let intercepted = false, interruptionApplied = false;
      db.prepare = sql => {
        const statement = prepare(sql);
        if (/^UPDATE remote_worker_cells\s+SET peak_disk_bytes/u.test(sql)) {
          const run = statement.run.bind(statement);
          statement.run = params => {
            const result = run(params);
            if (!intercepted) {
              intercepted = true;
              if (interruption === "parent") {
                const parent = clock.getRun(parentId);
                clock.updateRun({ runId: parentId, status: "cancelled", clearLease: true, expectedVersion: parent.version });
              } else if (interruption === "diagnostics") {
                cells.finalizeDiagnostics({ ...key, expectedRevision: priorCell.executionRevision, toState: "failed",
                  exitCode: 1, terminatedBySignal: null, diagnosticCaptureSha256: digest("diagnostics"),
                  rawOutputBytes: base.reservation.rawOutputLimitBytes + 1, retainedDiagnosticBytes: 1,
                  detailSha256: digest("diagnostics-detail"), now: clock.readDatabaseNow() });
              } else if (interruption === "cleanup") {
                cells.transitionCleanup({ ...key, expectedRevision: priorCell.cleanupRevision, toState: "pending",
                  failedCleanupRetainedBytes: 99, detailSha256: digest("cleanup"), now: clock.readDatabaseNow() });
              } else {
                assignments.renewLease({ registryWorkspaceId: key.registryWorkspaceId, assignmentId: key.assignmentId,
                  expectedAssignmentGeneration: key.assignmentGeneration, expectedLeaseRevision: authority.leaseRevision,
                  expectedLeaseTokenSha256: authority.leaseTokenSha256, leaseTokenSha256: digest("rolled-back-renewal"),
                  workerSentThrough: 0, idempotencyKey: "capacity-interrupted-renewal" }, fence);
              }
              interruptionApplied = true;
            }
            return result;
          };
        }
        return statement;
      };
      try { assert.throws(() => repo.admit(command())); }
      finally { db.prepare = prepare; }
      assert.ok(intercepted, `${interruption} crossed the real capacity write`);
      assert.ok(interruptionApplied, `${interruption} completed its competing mutation before final validation`);
      assert.deepEqual(cells.getCell(key), priorCell, `${interruption} rolled back high-water state`);
      assert.deepEqual(evidence(), priorEvidence, `${interruption} rolled back capacity evidence`);
      assert.equal(clock.getRun(parentId).status, "running");
      assert.ok(assignments.resolveActiveAuthorityByLeaseTokenHash(authority.leaseTokenSha256, fence));
    }

    for (const [metric, limit] of [["peakDiskBytes", "allocatedDiskBytes"], ["peakMemoryBytes", "memoryLimitBytes"],
      ["peakFileCount", "fileLimit"], ["peakProcessCount", "processLimit"], ["rawOutputBytes", "rawOutputLimitBytes"]] as const) {
      const exceeded = repo.admit(command({ ...base, [metric]: base.reservation[limit] + 1 }));
      assert.equal(exceeded.decision, "quarantine");
      assert.ok(exceeded.reason.includes(metric));
      assert.equal(exceeded.cell[metric], base.reservation[limit] + 1);
      const lower = new RemoteWorkerCellCapacityAdmissionRepository(db).admit(command());
      assert.equal(lower.decision, "quarantine");
      assert.equal(lower.cell[metric], base.reservation[limit] + 1);
    }

    const beforeDiagnostics = command(), diagCell = cells.getCell(key)!;
    cells.finalizeDiagnostics({ ...key, expectedRevision: diagCell.executionRevision, toState: "failed",
      exitCode: 1, terminatedBySignal: null, diagnosticCaptureSha256: digest("final-diagnostics"),
      rawOutputBytes: base.reservation.rawOutputLimitBytes + 2, retainedDiagnosticBytes: 1,
      detailSha256: digest("final-diagnostics-detail"), now: clock.readDatabaseNow() });
    assert.throws(() => repo.admit(beforeDiagnostics), /execution revision/u);
    const beforeCleanup = command(), cleanupCell = cells.getCell(key)!;
    cells.transitionCleanup({ ...key, expectedRevision: cleanupCell.cleanupRevision, toState: "pending",
      failedCleanupRetainedBytes: 99, detailSha256: digest("final-cleanup"), now: clock.readDatabaseNow() });
    assert.throws(() => repo.admit(beforeCleanup), /cleanup revision/u);
    const final = repo.admit(command());
    assert.equal(final.decision, "quarantine");
    assert.equal(final.cell.rawOutputBytes, base.reservation.rawOutputLimitBytes + 2);
    assert.equal(final.cell.failedCleanupRetainedBytes, 99);
    for (const secret of [authority.leaseTokenSha256, fence.credentialAuthority.authorizationCredentialSha256, "protectedAuthority"]) {
      assert.equal(JSON.stringify(final).includes(secret), false);
    }
    const finalEvidence = evidence();
    return () => {
      assert.throws(() => repo.readForAssignment(authority));
      assert.throws(() => repo.admit(command()));
      assert.deepEqual(cells.getCell(key), final.cell);
      assert.deepEqual(evidence(), finalEvidence);
    };
  });
};
