import assert from "node:assert/strict";
import type { RemoteWorkerNativeFileExportSelection, RemoteWorkerNativeFileStaging } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import type { RemoteWorkerCellCapacityAuthority } from "./remote-worker-cell-capacity-admission-repo.js";
import { RemoteWorkerNativeFileReceiptRepository } from "./remote-worker-native-file-receipt-repo.js";
import { verifyNativeArtifactSettlement } from "./remote-worker-native-artifact-settlement-fixture.js";
import { verifyNativeFileTransfer } from "./remote-worker-native-file-transfer-fixture.js";

/** Complete controlled bytes, real canonical approval/assignment and real DB. */
export function verifyNativeFileReceipt(db: DatabaseClient, authority: RemoteWorkerCellCapacityAuthority,
  fileStaging: RemoteWorkerNativeFileStaging, selection: RemoteWorkerNativeFileExportSelection, recordHex: string, disclosed: boolean, revoke: () => void) {
  const repo = new RemoteWorkerNativeFileReceiptRepository(db), input = { ...authority, fileStaging, files: [{ selection, recordHex }] };
  const lookup = { ...authority, nonce: selection.nonce, requestSha256: selection.requestSha256 };
  const count = () => Number(db.prepare("SELECT COUNT(*) AS count FROM remote_worker_native_file_receipts").get<{ count: number }>()!.count);
  assert.equal(repo.findForAssignment(lookup), null);
  const operatorKey = { registryWorkspaceId: authority.registryWorkspaceId, assignmentId: authority.assignmentId,
    assignmentGeneration: authority.assignmentGeneration, nonce: selection.nonce };
  assert.equal(repo.readVerifiedForOperator(operatorKey), null);
  assert.deepEqual(repo.listReceiptNoncesForOperator(operatorKey), { nonces: [], truncated: false });
  if (!disclosed) { assert.throws(() => repo.retainForAssignment(input)); assert.equal(count(), 0); return () => {}; }
  assert.throws(() => repo.retainForAssignment({ ...input, files: [] }));
  assert.throws(() => repo.retainForAssignment({ ...input, files: [{ selection, recordHex: recordHex + "00" }] }));
  assert.throws(() => repo.retainForAssignment({ ...input, fileStaging: { ...fileStaging, paths: ["unapproved.txt"] } }));
  const transfer = verifyNativeFileTransfer(db, authority, fileStaging, selection, recordHex, revoke);
  const prepare = db.prepare.bind(db); let applied = false;
  db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith("INSERT INTO remote_worker_native_file_receipts")) {
      const run = statement.run.bind(statement);
      statement.run = params => { const result = run(params); applied = true; revoke(); return result; };
    }
    return statement;
  };
  try { assert.throws(() => repo.retainForAssignment(input)); } finally { db.prepare = prepare; }
  assert.equal(applied, true); assert.equal(count(), 0, "a post-write revocation rolls back the entire batch receipt");
  const retained = repo.retainForAssignment(input);
  assert.deepEqual(repo.listReceiptNoncesForOperator(operatorKey), { nonces: [selection.nonce], truncated: false });
  assert.equal(repo.readVerifiedForOperator(operatorKey), null, "an unverified receipt cannot expose downloadable files");
  assert.equal(count(), 1); assert.equal(retained.receipt.totalBytes, 0); assert.equal(retained.receipt.files.length, 1);
  assert.equal(JSON.stringify(retained).includes("recordHex"), false);
  assert.deepEqual(new RemoteWorkerNativeFileReceiptRepository(db).findForAssignment(lookup), retained, "new owner recovers the immutable receipt");
  assert.deepEqual(repo.retainForAssignment(input), retained, "exact replay converges without a new record");
  assert.throws(() => repo.findForAssignment({ ...lookup, leaseRevision: 999 }));
  for (const sql of ["UPDATE remote_worker_native_file_receipts SET receipt_json = receipt_json", "DELETE FROM remote_worker_native_file_receipts"])
    assert.throws(() => db.prepare(sql).run(), /immutable|retained/u);
  transfer.afterReceipt(); verifyNativeArtifactSettlement(db, retained); transfer.afterVerification();
  const operatorReceipt = repo.readVerifiedForOperator(operatorKey)!;
  assert.equal(operatorReceipt.receiptSha256, retained.receiptSha256);
  assert.equal(operatorReceipt.manifest.entries[0]!.blobSha256, retained.receipt.files[0]!.contentSha256);
  for (const patch of [{ registryWorkspaceId: "foreign" }, { assignmentId: "foreign" }, { assignmentGeneration: authority.assignmentGeneration + 1 }, { nonce: "ff".repeat(32) }])
    assert.equal(repo.readVerifiedForOperator({ ...operatorKey, ...patch }), null);
  for (const patch of [{ assignmentGeneration: 0 }, { nonce: "00".repeat(32) }, { nonce: "../file" }])
    assert.throws(() => repo.readVerifiedForOperator({ ...operatorKey, ...patch }));
  return () => {
    assert.throws(() => repo.findForAssignment(lookup)); assert.throws(() => repo.retainForAssignment(input));
    assert.equal(count(), 1, "revocation retains historical evidence");
    transfer.afterRevoke();
    assert.deepEqual(repo.readVerifiedForOperator(operatorKey), operatorReceipt, "worker revocation does not erase verified historical operator evidence");
    assert.deepEqual(repo.listReceiptNoncesForOperator(operatorKey), { nonces: [selection.nonce], truncated: false });
  };
}
