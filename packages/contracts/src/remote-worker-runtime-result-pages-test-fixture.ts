import { createHash } from "node:crypto";
import { objectInventoryFixture, objectInventoryHistoryFixture } from "./remote-worker-cell-object-inventory-test-fixture.js";
import { REMOTE_WORKER_RUNTIME_RESULT_EXCHANGE_SCHEMA_VERSION, type RemoteWorkerRuntimeResultPage, type RemoteWorkerRuntimeResultExchange } from "./remote-worker-runtime-result-pages.js";

/** Independent native wire fixture for transport tests; no runtime is invoked. */
export function runtimeResultPagesFixture(fileCount = 19996, withBacking = false) {
  const history = objectInventoryHistoryFixture(), { summary, chunks } = objectInventoryFixture(history, fileCount);
  const expectation = { nonce: summary.subarray(0, 32).toString("hex"), requestSha256: "aa".repeat(32),
    checkpointSha256: summary.subarray(152, 184).toString("hex"), runtimeBundleSha256: "dd".repeat(32),
    maxInputBytes: 100, maxOutputBytes: 100000, maxInventoryEntries: 20000 };
  const header = Buffer.alloc(256); header.write("GCRRS001");
  for (const [offset, value] of [[8, expectation.nonce], [40, expectation.requestSha256], [72, expectation.checkpointSha256], [184, expectation.runtimeBundleSha256]] as const)
    Buffer.from(value, "hex").copy(header, offset);
  header.writeUInt32LE(0x1fef, 104); header.writeUInt32LE(23, 116); header.writeUInt32LE(777, 120); header.writeUInt32LE(fileCount + 4, 216);
  if (withBacking) {
    header.writeUInt32LE(0x9fef, 104);
    for (const [offset, value] of [[220, history.plan.virtualDiskBytes], [228, history.plan.reservedDiskBytes],
      [236, 21 * 1024], [244, 24576]] as const) header.writeBigUInt64LE(BigInt(value), offset);
  }
  const bytes = Buffer.concat([header, summary, ...chunks]), resultHex = bytes.toString("hex");
  const resultSha256 = createHash("sha256").update("goatcitadel.worker-runtime-result.v1\0").update(bytes).digest("hex");
  const page = (offset = 0): RemoteWorkerRuntimeResultPage => ({ kind: "runtime.result.page", nonce: expectation.nonce, requestSha256: expectation.requestSha256,
    resultSha256, byteLength: bytes.length, offset, bytesHex: bytes.subarray(offset, offset + 32768).toString("hex") });
  const response = (selection: RemoteWorkerRuntimeResultPage | null, complete = selection !== null && selection.offset + selection.bytesHex.length / 2 === bytes.length): RemoteWorkerRuntimeResultExchange => ({
    schemaVersion: REMOTE_WORKER_RUNTIME_RESULT_EXCHANGE_SCHEMA_VERSION, registryWorkspaceId: history.registryWorkspaceId, assignmentId: history.assignmentId,
    assignmentGeneration: history.assignmentGeneration, leaseRevision: history.leaseRevision, nonce: expectation.nonce, requestSha256: expectation.requestSha256,
    record: complete ? { resultSha256, byteLength: bytes.length, leaseRevision: history.leaseRevision, recordedAt: "2026-09-14T00:00:00.000Z" } : null,
    accepted: selection ? { page: selection, nextOffset: complete ? bytes.length : selection.offset + selection.bytesHex.length / 2 } : null });
  return { history, expectation, bytes, resultHex, resultSha256, page, response };
}
