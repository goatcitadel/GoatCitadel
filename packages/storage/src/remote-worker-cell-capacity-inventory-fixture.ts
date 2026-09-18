import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { remoteWorkerCellCapacityInventorySha256, normalizeRemoteWorkerCellCapacityInventory, remoteWorkerNativeCapacityIdentitySha256 } from "@goatcitadel/contracts";
import { capacityInventoryFixture, withNativeCapacityLayout } from "../../contracts/src/remote-worker-cell-capacity-inventory-test-fixture.js";
import { RemoteWorkerCellCapacityAdmissionRepository } from "./remote-worker-cell-capacity-admission-repo.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { verifyCellProvisioningExchange } from "./remote-worker-cell-exchange-fixture.js";

export const verifyCellCapacityInventory: typeof verifyCellProvisioningExchange = (db, key, token, fence, revoke) => {
  verifyCellProvisioningExchange(db, key, token, fence, revoke, (authority, exchange) => {
    const owner = new RemoteWorkerCellCapacityAdmissionRepository(db), cells = new RemoteWorkerCellRepository(db);
    const clock = new DurableRunRepository(db), assignments = new RemoteWorkerAssignmentRepository(db);
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const prepared = owner.readForAssignment(authority);
    const plannedSuffix = digest(`${key.assignmentId}:planned-platform`).slice(0, 32);
    // Controlled planned identity permits canonical diagnostic transitions. It
    // does not establish OS resource readiness or an actual capacity capture.
    cells.persistPlatformIdentity({ ...key, provisioningOwner: prepared.provisioningOwner!, provisioningLeaseExpiresAt: prepared.provisioningLeaseExpiresAt!,
      platformIdentity: { schemaVersion: "goatcitadel.remote-worker-cell-platform.v2", backend: "windows_native",
        jobName: `gc-cell-${plannedSuffix}`, appContainerName: `GoatCitadel.Worker.${plannedSuffix}`,
        volumeIdentitySha256: digest("planned-volume"), runtimeBundleSha256: digest("planned-runtime"), launcherSha256: digest("planned-launcher"), networkPolicy: "deny_all" },
      detailSha256: digest("planned-platform"), now: clock.readDatabaseNow() });
    let capture = 0;
    const command = (inventory = capacityInventoryFixture(prepared.profileSha256, `${key.assignmentId}:${++capture}`)) => {
      const cell = cells.getCell(key)!;
      return { ...authority, expectedCapacityRevision: cell.capacityRevision, expectedExecutionRevision: cell.executionRevision,
        expectedCleanupRevision: cell.cleanupRevision, expectedBackupRevision: cell.backupRevision, inventory,
        inventoryBinding: { profileSha256: inventory.profileSha256, captureSha256: inventory.captureSha256,
          inventorySha256: remoteWorkerCellCapacityInventorySha256(inventory) },
        observation: { reservation: cell.capacity, incomingBytes: 1_000, peakDiskBytes: 0, peakMemoryBytes: 0,
          peakFileCount: 0, peakProcessCount: 0, rawOutputBytes: 0 } };
    };
    const count = () => Number(db.prepare("SELECT COUNT(*) AS count FROM remote_worker_cell_capacity_inventories").get<{ count: number | string }>()!.count);
    const evidence = () => cells.listEvidenceAfter(key, 0);
    assert.equal(owner.readInventory({ ...authority, capacityRevision: 1 }), null);
    const first = command(), accepted = owner.admitInventory(first);
    assert.equal(accepted.decision, "accept");
    assert.equal(accepted.cell.peakDiskBytes, 86_016);
    assert.equal(accepted.cell.peakFileCount, 4);
    assert.equal(count(), 1);
    const record = owner.readInventory({ ...authority, capacityRevision: accepted.cell.capacityRevision })!;
    assert.equal(record.accounting.logicalReferenceBytes, 29_000);
    assert.equal(record.accounting.hostAllocatedBytes, 86_016);
    assert.equal(record.accounting.guestAllocatedBytes, 4_608);
    assert.equal(record.peakLogicalBytes, 29_000);
    assert.equal(record.peakInodeCount, 5);
    assert.deepEqual(record.inventory, normalizeRemoteWorkerCellCapacityInventory(first.inventory));
    assert.deepEqual(new RemoteWorkerCellCapacityAdmissionRepository(db).readInventory({ ...authority, capacityRevision: record.capacityRevision }), record);
    const firstEvidence = evidence();
    assert.throws(() => owner.admitInventory(first), /capacity revision/u);
    assert.throws(() => owner.admitInventory(command(first.inventory)), /unique|duplicate/iu);
    assert.deepEqual(cells.getCell(key), accepted.cell);
    assert.deepEqual(evidence(), firstEvidence);
    assert.equal(count(), 1);
    for (const sql of ["UPDATE remote_worker_cell_capacity_inventories SET recorded_at=recorded_at", "DELETE FROM remote_worker_cell_capacity_inventories"]) {
      assert.throws(() => db.prepare(sql).run(), /immutable|retained/u);
    }
    for (const patch of [{ assignmentId: "foreign" }, { leaseRevision: 999 }, { protectedAuthority: undefined }, { expectedBackupRevision: -1 }]) {
      assert.throws(() => owner.admitInventory({ ...command(), ...patch } as ReturnType<typeof command>));
      assert.equal(count(), 1);
    }
    const malformed = command();
    malformed.observation.peakFileCount = -1;
    assert.throws(() => owner.admitInventory(malformed), /peakFileCount/u);
    const foreign = command(capacityInventoryFixture(digest("foreign-profile"), "foreign-capture"));
    assert.throws(() => owner.admitInventory(foreign), /profile/u);
    const rejected = command();
    rejected.observation.incomingBytes = rejected.observation.reservation.allocatedDiskBytes + 1;
    assert.equal(owner.admitInventory(rejected).decision, "reject");
    assert.equal(count(), 1);
    assert.deepEqual(evidence(), firstEvidence);

    const parentId = assignments.resolveActiveAuthorityByLeaseTokenHash(authority.leaseTokenSha256, fence)!.assignment.manifest.durableRunId;
    for (const interruption of ["parent", "lease", "backup", "cleanup", "diagnostics"] as const) {
      const prior = cells.getCell(key)!, priorEvidence = evidence(), beforeCount = count();
      const prepare = db.prepare.bind(db);
      let applied = false, failure: unknown;
      db.prepare = sql => {
        const statement = prepare(sql);
        if (/^INSERT INTO remote_worker_cell_capacity_inventories/u.test(sql)) {
          const run = statement.run.bind(statement);
          statement.run = params => {
            const result = run(params);
            if (interruption === "parent") {
              const parent = clock.getRun(parentId);
              clock.updateRun({ runId: parentId, expectedVersion: parent.version, status: "cancelled", clearLease: true });
            } else if (interruption === "lease") assignments.renewLease({ registryWorkspaceId: key.registryWorkspaceId,
              assignmentId: key.assignmentId, expectedAssignmentGeneration: key.assignmentGeneration,
              expectedLeaseRevision: authority.leaseRevision, expectedLeaseTokenSha256: authority.leaseTokenSha256,
              leaseTokenSha256: digest("interrupted-lease"), workerSentThrough: 0, idempotencyKey: "interrupted-inventory-lease" }, fence);
            else if (interruption === "backup") cells.transitionBackup({ ...key, expectedRevision: prior.backupRevision, toState: "pending", detailSha256: digest("backup"), now: clock.readDatabaseNow() });
            else if (interruption === "cleanup") cells.transitionCleanup({ ...key, expectedRevision: prior.cleanupRevision, toState: "pending", failedCleanupRetainedBytes: 99, detailSha256: digest("cleanup"), now: clock.readDatabaseNow() });
            else cells.finalizeDiagnostics({ ...key, expectedRevision: prior.executionRevision, toState: "failed", exitCode: 1,
              terminatedBySignal: null, diagnosticCaptureSha256: digest("diagnostics"), rawOutputBytes: 99, retainedDiagnosticBytes: 1,
              detailSha256: digest("diagnostics"), now: clock.readDatabaseNow() });
            applied = true;
            return result;
          };
        }
        return statement;
      };
      try { assert.throws(() => { try { owner.admitInventory(command()); } catch (error) { failure = error; throw error; } }); }
      finally { db.prepare = prepare; }
      assert.equal(applied, true, `${interruption} must complete after the actual inventory insert: ${failure instanceof Error ? failure.message : "unknown failure"}`);
      assert.equal(count(), beforeCount);
      assert.deepEqual(cells.getCell(key), prior);
      assert.deepEqual(evidence(), priorEvidence);
      assert.equal(clock.getRun(parentId).status, "running");
    }
    const staleBackup = command();
    cells.transitionBackup({ ...key, expectedRevision: staleBackup.expectedBackupRevision, toState: "pending", detailSha256: digest("backup-committed"), now: clock.readDatabaseNow() });
    assert.throws(() => owner.admitInventory(staleBackup), /backup revision/u);
    const high = command();
    high.inventory.areas[0]!.objects[1] = { ...high.inventory.areas[0]!.objects[1]!, logicalBytes: prepared.capacity.logicalDiskBytes + 1 };
    high.inventoryBinding.inventorySha256 = remoteWorkerCellCapacityInventorySha256(high.inventory);
    high.observation.incomingBytes = prepared.capacity.allocatedDiskBytes + 1;
    const exceeded = owner.admitInventory(high);
    assert.equal(exceeded.decision, "quarantine");
    assert.match(exceeded.reason, /logical bytes/u);
    const lower = owner.admitInventory(command());
    assert.equal(lower.decision, "quarantine");
    const retained = owner.readInventory({ ...authority, capacityRevision: lower.cell.capacityRevision })!;
    assert.equal(retained.peakLogicalBytes, prepared.capacity.logicalDiskBytes + 20_001);
    assert.equal(retained.accounting.logicalReferenceBytes, 29_000);
    const rawCommand = command(), inventoriesBeforeRawAdmission = count();
    const raw = owner.admit({ ...rawCommand,
      observation: { ...rawCommand.observation, footprint: retained.accounting.footprint } });
    assert.equal(raw.decision, "quarantine", "footprint-only admission cannot forget a retained logical-byte violation");
    assert.match(raw.reason, /logical bytes/u);
    assert.equal(count(), inventoriesBeforeRawAdmission, "raw admission must not manufacture an inventory");
    assert.equal(owner.admitInventory(command()).decision, "quarantine", "inventory peaks survive intervening raw capacity revisions");
    const nativeCommand = () => {
      const next = command(), inventory = withNativeCapacityLayout(next.inventory, exchange.plan.assignmentBindingSha256);
      return { ...next, inventory, inventoryBinding: { ...next.inventoryBinding,
        inventorySha256: remoteWorkerCellCapacityInventorySha256(inventory) } };
    };
    const bound = nativeCommand(), nativeSaved = owner.admitInventory(bound);
    const nativeRecord = new RemoteWorkerCellCapacityAdmissionRepository(db).readInventory({ ...authority, capacityRevision: nativeSaved.cell.capacityRevision })!;
    assert.deepEqual(nativeRecord.inventory.nativeLayout, bound.inventory.nativeLayout);
    assert.equal(nativeRecord.accounting.hostDirectoryCount, 13);
    assert.equal(owner.admitInventory(nativeCommand()).decision, "quarantine", "same retained roots permit a new current capture");
    const beforeLayoutRefusals = count(), beforeLayoutEvidence = evidence();
    assert.throws(() => owner.admitInventory(command()), /layout/u, "bound inventory cannot silently lose its native layout");
    const foreignLayout = nativeCommand(); foreignLayout.inventory.nativeLayout.assignmentBindingSha256 = digest("foreign-layout-assignment");
    foreignLayout.inventoryBinding.inventorySha256 = remoteWorkerCellCapacityInventorySha256(foreignLayout.inventory);
    assert.throws(() => owner.admitInventory(foreignLayout), /provisioning assignment/u);
    const replacedRoot = nativeCommand(), replacement = "1100000000000000" + "ff".repeat(16);
    replacedRoot.inventory.nativeLayout.rootIdentityHex[0] = replacement;
    const replacedObjects = replacedRoot.inventory.areas[0]!.objects;
    replacedObjects[replacedObjects.length - 1] = { ...replacedObjects.at(-1)!, identitySha256: remoteWorkerNativeCapacityIdentitySha256(replacement) };
    replacedRoot.inventoryBinding.inventorySha256 = remoteWorkerCellCapacityInventorySha256(replacedRoot.inventory);
    assert.throws(() => owner.admitInventory(replacedRoot), /layout/u, "matching new objects cannot relabel a previously retained host root");
    assert.equal(count(), beforeLayoutRefusals); assert.deepEqual(evidence(), beforeLayoutEvidence);
    const finalCount = count(), finalEvidence = evidence();
    assert.equal(JSON.stringify(retained).includes(authority.leaseTokenSha256), false);
    return () => {
      assert.throws(() => owner.admitInventory(command()));
      assert.throws(() => owner.readInventory({ ...authority, capacityRevision: retained.capacityRevision }));
      assert.equal(count(), finalCount);
      assert.deepEqual(evidence(), finalEvidence);
    };
  });
};
