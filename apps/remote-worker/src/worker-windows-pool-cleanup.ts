import { canonicalJsonString, normalizeRemoteWorkerNativePoolCleanupSnapshot, normalizeRemoteWorkerNativePoolSnapshot,
  encodeRemoteWorkerRuntimeCleanupHistory, encodeRemoteWorkerRuntimeInstallRequest, remoteWorkerRuntimeInstallRequestSha256,
  type RemoteWorkerNativePoolCleanupSnapshot, type RemoteWorkerNativePoolSnapshot } from "@goatcitadel/contracts";
import { encodeWindowsAssignmentCleanupAdmission } from "./worker-windows-assignment-cleanup.js";
import { sha256Utf8 } from "./connected-worker-routes.js";

export const WINDOWS_POOL_CLEANUP_HEADER_BYTES = 80;
export const WINDOWS_POOL_CLEANUP_MEMBER_HEADER_BYTES = 40;
export const WINDOWS_POOL_CLEANUP_MAXIMUM_BYTES = 80 + 64 * (40 + 416 + 252) + 108 * 1000;
/** GCPCLN01 carries every member in the already admitted pool order. The
 * challenge comes from the independent current cleanup admission. Fingerprints
 * are provenance, not signatures; native reconciliation still owns readiness. */
export function encodeWindowsWorkerPoolCleanup(input: RemoteWorkerNativePoolCleanupSnapshot,
  expected: RemoteWorkerNativePoolSnapshot, challenge: string): Buffer {
  const cleanup = normalizeRemoteWorkerNativePoolCleanupSnapshot(input), pool = normalizeRemoteWorkerNativePoolSnapshot(expected);
  if (!pool.members.length || canonicalJsonString(cleanup.pool) !== canonicalJsonString(pool))
    throw new Error("Native pool cleanup differs from its admitted pool history.");
  const members = cleanup.members.map((member, index) => {
    const history = pool.members[index]!.history;
    if (!history) throw new Error("Native pool cleanup contains an incomplete member.");
    const encoded = encodeRemoteWorkerRuntimeCleanupHistory({ history, challenge, expectations: member.expectations });
    const installations = member.installation ? [{ nonce: member.installation.nonce,
      requestSha256: remoteWorkerRuntimeInstallRequestSha256(member.installation),
      requestHex: Buffer.from(encodeRemoteWorkerRuntimeInstallRequest(member.installation)).toString("hex") }] : [];
    const admission = encodeWindowsAssignmentCleanupAdmission({ challenge, setSha256: encoded.setSha256, installations });
    return { binding: history.plan.assignmentBindingSha256, admission, data: Buffer.from(encoded.bytesHex, "hex") };
  });
  const size = WINDOWS_POOL_CLEANUP_HEADER_BYTES + members.reduce((sum, member) => sum + WINDOWS_POOL_CLEANUP_MEMBER_HEADER_BYTES + member.admission.length + member.data.length, 0);
  if (size > WINDOWS_POOL_CLEANUP_MAXIMUM_BYTES) throw new Error("Native pool cleanup exceeds its complete-set bound.");
  const bytes = Buffer.alloc(size);
  bytes.write("GCPCLN01", "ascii"); bytes.writeUInt32LE(members.length, 8); bytes.writeUInt32LE(1, 12);
  Buffer.from(sha256Utf8(canonicalJsonString(pool)), "hex").copy(bytes, 16);
  Buffer.from(sha256Utf8(canonicalJsonString(cleanup)), "hex").copy(bytes, 48);
  let position = WINDOWS_POOL_CLEANUP_HEADER_BYTES;
  for (const member of members) {
    Buffer.from(member.binding, "hex").copy(bytes, position);
    bytes.writeUInt32LE(member.admission.length, position + 32); bytes.writeUInt32LE(member.data.length, position + 36);
    position += WINDOWS_POOL_CLEANUP_MEMBER_HEADER_BYTES;
    member.admission.copy(bytes, position); position += member.admission.length;
    member.data.copy(bytes, position); position += member.data.length;
  }
  return bytes;
}
