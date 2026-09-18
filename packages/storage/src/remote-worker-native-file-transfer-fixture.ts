import assert from "node:assert/strict";
import { readRemoteWorkerNativeFileContent, normalizeRemoteWorkerNativeFileReceipt, REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA,
  type RemoteWorkerNativeFileExportSelection, type RemoteWorkerNativeFileStaging, type RemoteWorkerNativeFileTransferPage } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import type { RemoteWorkerCellCapacityAuthority } from "./remote-worker-cell-capacity-admission-repo.js";
import { RemoteWorkerNativeFileTransferRepository } from "./remote-worker-native-file-transfer-repo.js";
import { RemoteWorkerRuntimeResultRepository } from "./remote-worker-runtime-result-repo.js";

/** Real protected authority and DB; controlled native empty-file bytes. */
export function verifyNativeFileTransfer(db: DatabaseClient, authority: RemoteWorkerCellCapacityAuthority,
  fileStaging: RemoteWorkerNativeFileStaging, selection: RemoteWorkerNativeFileExportSelection, recordHex: string, revoke: () => void) {
  const results = new RemoteWorkerRuntimeResultRepository(db), repo = new RemoteWorkerNativeFileTransferRepository(db);
  const disclosure = results.authorizeFileDisclosureForAssignment({ ...authority, selection, fileStaging }).disclosure;
  const content = readRemoteWorkerNativeFileContent(recordHex, selection);
  const declaration = normalizeRemoteWorkerNativeFileReceipt({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA, disclosure, fileStaging,
    resultSha256: selection.resultSha256, totalBytes: selection.logicalFileBytes,
    files: [{ selection, recordSha256: content.recordSha256, contentSha256: content.contentSha256 }] });
  const input = { ...authority, declaration }, lookup = { ...authority, nonce: selection.nonce, requestSha256: selection.requestSha256 };
  const count = (table: "remote_worker_native_file_transfers" | "remote_worker_native_file_transfer_pages" | "remote_worker_native_file_receipts") =>
    Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: number }>()!.count);
  const rolledBackWrite = (prefix: string, operation: () => unknown) => {
    const prepare = db.prepare.bind(db); let reached = false, failure: unknown;
    db.prepare = sql => {
      const statement = prepare(sql);
      if (sql.startsWith(prefix)) { const run = statement.run.bind(statement); statement.run = params => { const value = run(params); reached = true; revoke(); return value; }; }
      return statement;
    };
    try { try { operation(); } catch (error) { failure = error; } } finally { db.prepare = prepare; }
    assert.ok(failure, "the injected revocation must reject the operation");
    assert.equal(reached, true, `the injected revocation must reach the write: ${String(failure)}`);
  };
  assert.equal(repo.readForAssignment(lookup), null);
  assert.throws(() => repo.beginForAssignment({ ...input, declaration: { ...declaration, disclosure: { ...disclosure, fileStagingSha256: "ff".repeat(32) } } }));
  rolledBackWrite("INSERT INTO remote_worker_native_file_transfers", () => repo.beginForAssignment(input));
  assert.equal(count("remote_worker_native_file_transfers"), 0);
  const opened = repo.beginForAssignment(input);
  assert.equal(count("remote_worker_native_file_receipts"), 0, "a declaration is not a content receipt");
  assert.deepEqual(repo.beginForAssignment(input), opened);
  assert.throws(() => repo.beginForAssignment({ ...input, declaration: { ...declaration, files: [{ ...declaration.files[0]!, contentSha256: "ff".repeat(32) }] } }));
  const page: RemoteWorkerNativeFileTransferPage = { kind: "runtime.files.page", nonce: selection.nonce, requestSha256: selection.requestSha256,
    transferSha256: opened.transferSha256, fileIndex: 0, pageIndex: 0, bytesHex: recordHex };
  for (const patch of [{ fileIndex: 1 }, { pageIndex: 1 }, { bytesHex: recordHex + "00" }, { transferSha256: "ff".repeat(32) }])
    assert.throws(() => repo.appendPageForAssignment({ ...authority, page: { ...page, ...patch } }));
  assert.equal(count("remote_worker_native_file_transfer_pages"), 0);
  rolledBackWrite("INSERT INTO remote_worker_native_file_transfer_pages", () => repo.appendPageForAssignment({ ...authority, page }));
  assert.equal(count("remote_worker_native_file_transfer_pages"), 0);
  const ack = repo.appendPageForAssignment({ ...authority, page });
  assert.equal(Object.hasOwn(ack, "bytesHex"), false);
  assert.deepEqual(repo.appendPageForAssignment({ ...authority, page }), ack);
  assert.throws(() => repo.appendPageForAssignment({ ...authority, page: { ...page, bytesHex: "ff" + recordHex.slice(2) } }));
  const recovered = new RemoteWorkerNativeFileTransferRepository(db).readForAssignment(lookup)!;
  assert.equal(recovered.pages.length, 1); assert.equal(recovered.pages[0]!.bytesHex, recordHex);
  assert.equal(readRemoteWorkerNativeFileContent(recovered.pages[0]!.bytesHex, selection).recordSha256, content.recordSha256);
  assert.throws(() => repo.readForAssignment({ ...lookup, leaseRevision: 999 }));
  assert.throws(() => repo.releasePagesForAssignment(lookup));
  for (const sql of ["DELETE FROM remote_worker_native_file_transfers", "UPDATE remote_worker_native_file_transfers SET declaration_json = declaration_json",
    "UPDATE remote_worker_native_file_transfer_pages SET bytes_hex = bytes_hex", "DELETE FROM remote_worker_native_file_transfer_pages"])
    assert.throws(() => db.prepare(sql).run(), /immutable|retained|receipt retention/u);
  return {
    afterReceipt: () => { assert.throws(() => repo.releasePagesForAssignment(lookup), "a content receipt alone is not a verified manifest"); },
    afterVerification: () => {
      assert.equal(repo.releasePagesForAssignment(lookup), 1); assert.equal(repo.releasePagesForAssignment(lookup), 0);
      assert.equal(count("remote_worker_native_file_transfer_pages"), 0); assert.equal(count("remote_worker_native_file_transfers"), 1);
      assert.deepEqual(repo.readForAssignment(lookup)!.pages, []); assert.deepEqual(repo.beginForAssignment(input), opened);
      assert.throws(() => repo.appendPageForAssignment({ ...authority, page }), "a completed receipt cannot recreate raw staging pages");
    },
    afterRevoke: () => {
      assert.throws(() => repo.beginForAssignment(input)); assert.throws(() => repo.readForAssignment(lookup));
      assert.throws(() => repo.appendPageForAssignment({ ...authority, page })); assert.throws(() => repo.releasePagesForAssignment(lookup));
      assert.equal(count("remote_worker_native_file_transfers"), 1);
    },
  };
}
