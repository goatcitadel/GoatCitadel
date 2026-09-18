import assert from "node:assert/strict";
import { REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT, readRemoteWorkerCellObjectInventory } from "@goatcitadel/contracts";
import { objectInventoryFixture } from "../../contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import { verifyCellProvisioningExchange } from "./remote-worker-cell-exchange-fixture.js";
import { RemoteWorkerCellCapacityRepository } from "./remote-worker-cell-capacity-repo.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";

export const verifyCellObjectInventoryPages: typeof verifyCellProvisioningExchange = (db, key, token, fence, revoke) => {
  verifyCellProvisioningExchange(db, key, token, fence, revoke, (current, history) => {
    const repo = new RemoteWorkerCellCapacityRepository(db), cells = new RemoteWorkerCellRepository(db);
    const original = cells.getCell(key), evidence = cells.listEvidenceAfter(key, 0);
    const count = (table: string) => db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE assignment_id = @assignmentId`)
      .get<{ count: number }>({ assignmentId: key.assignmentId })!.count;
    const stageCount = () => count("remote_worker_cell_object_inventory_staging"), retainedCount = () => count("remote_worker_cell_object_inventory_observations");
    const full = objectInventoryFixture(history, 19996), hex = full.chunks.map(chunk => chunk.toString("hex"));
    const page = (startChunk = 0, nonce = "71", expectedRevision = 0) => ({ ...current, submission: { kind: "cell.object_inventory.page" as const,
      expectedRevision, observationHex: nonce.repeat(32) + full.summary.toString("hex").slice(64), nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT,
      startChunk, chunkHex: hex.slice(startChunk, startChunk + 64).map(chunk => nonce.repeat(32) + chunk.slice(64)) } });
    const snapshot = { ...current, submission: { kind: "cell.object_inventory.page_snapshot" as const } };
    assert.equal(repo.exchangeInventoryPageWithAssignment(snapshot).record, null);
    assert.throws(() => repo.exchangeInventoryPageWithAssignment(page(64))); assert.equal(stageCount(), 0);
    for (const patch of [{ assignmentId: "foreign" }, { assignmentGeneration: 999 }, { leaseRevision: 999 }, { leaseTokenSha256: "f".repeat(64) },
      { protectedAuthority: undefined }, { protectedAuthority: { ...fence, credentialAuthority: { ...fence.credentialAuthority, credentialGeneration: 999 } } }]) {
      assert.throws(() => repo.exchangeInventoryPageWithAssignment({ ...page(), ...patch } as ReturnType<typeof page>)); assert.equal(stageCount(), 0);
    }
    const malformed = page(); malformed.submission.chunkHex.reverse();
    assert.throws(() => repo.exchangeInventoryPageWithAssignment(malformed)); assert.equal(stageCount(), 0);
    const parentId = new RemoteWorkerAssignmentRepository(db).resolveActiveAuthorityByLeaseTokenHash(current.leaseTokenSha256, fence)!.assignment.manifest.durableRunId;
    const runs = new DurableRunRepository(db), prepare = db.prepare.bind(db); let intercepted = false;
    db.prepare = sql => {
      const statement = prepare(sql);
      if (/^INSERT INTO remote_worker_cell_object_inventory_staging/u.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = params => {
          const result = run(params); intercepted = true;
          const parent = runs.getRun(parentId); runs.updateRun({ runId: parentId, status: "cancelled", clearLease: true, expectedVersion: parent.version });
          return result;
        };
      }
      return statement;
    };
    try { assert.throws(() => repo.exchangeInventoryPageWithAssignment(page())); } finally { db.prepare = prepare; }
    assert.equal(intercepted, true); assert.equal(stageCount(), 0); assert.notEqual(runs.getRun(parentId).status, "cancelled");
    const first = repo.exchangeInventoryPageWithAssignment(page());
    assert.equal(first.accepted?.nextChunk, 64); assert.equal(first.accepted?.committedRevision, null);
    assert.equal(stageCount(), 1); assert.equal(retainedCount(), 0); assert.equal(first.record, null);
    const conflicting = page(), conflictingSummary = Buffer.from(conflicting.submission.observationHex, "hex");
    conflictingSummary.writeBigUInt64LE(conflictingSummary.readBigUInt64LE(328) + 1n, 328);
    conflicting.submission.observationHex = conflictingSummary.toString("hex");
    assert.throws(() => repo.exchangeInventoryPageWithAssignment(conflicting), "an existing nonce cannot replace its staged summary");
    assert.deepEqual(new RemoteWorkerCellCapacityRepository(db).exchangeInventoryPageWithAssignment(page()), first, "restart resumes durable staging");
    const second = repo.exchangeInventoryPageWithAssignment(page(64));
    assert.equal(second.accepted?.nextChunk, 128);
    assert.equal(repo.exchangeInventoryPageWithAssignment(page()).accepted?.nextChunk, 128, "duplicate old page acknowledges retained progress");
    repo.exchangeInventoryPageWithAssignment(page(0, "72")); assert.equal(stageCount(), 1);
    assert.throws(() => repo.exchangeInventoryPageWithAssignment(page(128)), "replaced capture cannot append");
    repo.exchangeInventoryPageWithAssignment(page());
    for (let start = 64; start < 1000; start += 64) {
      const result = new RemoteWorkerCellCapacityRepository(db).exchangeInventoryPageWithAssignment(page(start));
      assert.equal(result.accepted?.nextChunk, Math.min(1000, start + 64));
      assert.equal(result.accepted?.committedRevision, start === 960 ? 1 : null);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 256 * 1024);
      assert.equal(retainedCount(), start === 960 ? 1 : 0);
    }
    assert.equal(stageCount(), 0);
    const complete = repo.exchangeInventoryWithAssignment({ ...current, submission: { kind: "cell.object_inventory.snapshot" } });
    assert.equal(readRemoteWorkerCellObjectInventory(complete.record!.observationHex, complete.record!.chunkHex, complete.history).entries.length, 20000);
    const replay = repo.exchangeInventoryPageWithAssignment(page());
    assert.equal(replay.accepted?.nextChunk, 1000); assert.equal(replay.record?.revision, 1);
    const changed = page(); changed.submission.chunkHex[0] = "f" + changed.submission.chunkHex[0]!.slice(1);
    assert.throws(() => repo.exchangeInventoryPageWithAssignment(changed));
    assert.throws(() => repo.exchangeInventoryPageWithAssignment(page(0, "72", 0)));
    const small = objectInventoryFixture(history), finish = page(0, "73", 1);
    finish.submission.observationHex = "73".repeat(32) + small.summary.toString("hex").slice(64);
    finish.submission.chunkHex = small.chunks.map(chunk => "73".repeat(32) + chunk.toString("hex").slice(64));
    assert.equal(repo.exchangeInventoryPageWithAssignment(finish).record?.revision, 2); assert.equal(retainedCount(), 2);
    assert.deepEqual(repo.exchangeInventoryPageWithAssignment(page()), replay, "old completed capture remains replayable after a newer capture");
    assert.deepEqual(cells.getCell(key), original); assert.deepEqual(cells.listEvidenceAfter(key, 0), evidence);
    assert.equal(JSON.stringify(replay).includes(current.leaseTokenSha256), false); assert.equal(JSON.stringify(replay).includes("protectedAuthority"), false);
    return () => {
      assert.throws(() => repo.exchangeInventoryPageWithAssignment(snapshot));
      assert.throws(() => repo.exchangeInventoryPageWithAssignment(page()));
      assert.throws(() => repo.exchangeInventoryPageWithAssignment(finish));
      assert.equal(retainedCount(), 2); assert.equal(stageCount(), 0);
    };
  });
};
