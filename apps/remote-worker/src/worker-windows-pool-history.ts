import { canonicalJsonString, normalizeRemoteWorkerNativePoolSnapshot, normalizeRemoteWorkerCellProvisioningExchange,
  readRemoteWorkerCellProvisioningCheckpoint, type RemoteWorkerNativePoolSnapshot, type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";
import { sha256Utf8 } from "./connected-worker-routes.js";

export const WINDOWS_POOL_HISTORY_HEADER_BYTES = 136;
export const WINDOWS_POOL_HISTORY_MEMBER_BYTES = 256 + 21 * 1024;
/** Retained metadata only. The native receiver injects its own session nonce,
 * checks every history against trusted principals and proves physical closure. */
export function encodeWindowsWorkerPoolHistory(input: RemoteWorkerNativePoolSnapshot, expected: RemoteWorkerCellProvisioningExchange,
  operation: 14 | 15 | 16 | 20, wallMs: number): Buffer {
  const pool = normalizeRemoteWorkerNativePoolSnapshot(input), current = normalizeRemoteWorkerCellProvisioningExchange(expected);
  if (![14, 15, 16, 20].includes(operation) || !Number.isSafeInteger(wallMs) || wallMs < 100 || wallMs > 60000 || !pool.members.length ||
      pool.registryWorkspaceId !== current.registryWorkspaceId || pool.assignmentId !== current.assignmentId ||
      pool.assignmentGeneration !== current.assignmentGeneration || pool.leaseRevision !== current.leaseRevision)
    throw new Error("Native pool history differs from its retained measurement request.");
  const { schemaVersion: _schema, registryWorkspaceId: _registry, assignmentId: _assignment,
    assignmentGeneration: _generation, leaseRevision: _lease, ...currentHistory } = current;
  const active = pool.members.find(member => member.assignmentId === current.assignmentId && member.assignmentGeneration === current.assignmentGeneration);
  if (!active || active.workerGeneration !== pool.workerGeneration || canonicalJsonString(active.history) !== canonicalJsonString(currentHistory))
    throw new Error("Native pool does not contain its exact current history.");
  const bytes = Buffer.alloc(WINDOWS_POOL_HISTORY_HEADER_BYTES + pool.members.length * WINDOWS_POOL_HISTORY_MEMBER_BYTES);
  bytes.write("GCPPOOL1"); bytes.writeUInt32LE(pool.members.length, 8); bytes.writeUInt32LE(1, 12);
  Buffer.from(sha256Utf8(canonicalJsonString(pool)), "hex").copy(bytes, 48);
  Buffer.from(current.plan.assignmentBindingSha256, "hex").copy(bytes, 80);
  Buffer.from(current.plan.parentIdentityHex, "hex").copy(bytes, 112);
  let position = WINDOWS_POOL_HISTORY_HEADER_BYTES;
  for (const member of pool.members) {
    const history = member.history;
    if (!history || history.records.length !== 5 || history.volumeRecords?.length !== 6 || history.formatRecords?.length !== 2 ||
        history.protectionRecords?.length !== 2 || history.mountRecords?.length !== 4 || history.mountedWorkspaceRecords?.length !== 2 ||
        history.plan.parentIdentityHex !== current.plan.parentIdentityHex || history.plan.ownerSid !== current.plan.ownerSid ||
        history.plan.controllerSid !== current.plan.controllerSid)
      throw new Error("Native pool contains incomplete or foreign retained history.");
    const plan = history.plan, prepared = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]);
    bytes.writeUInt32LE(operation, position); bytes.writeUInt32LE(wallMs, position + 4);
    bytes.write(plan.cellName, position + 40, 40, "ascii");
    for (const [offset, value] of [[80, plan.assignmentBindingSha256], [112, plan.profileSha256], [144, plan.diskIdentifierHex],
      [176, plan.parentIdentityHex], [200, prepared.journalIdentityHex], [224, prepared.recordSha256]] as const)
      Buffer.from(value, "hex").copy(bytes, position + offset);
    bytes.writeBigUInt64LE(BigInt(plan.virtualDiskBytes), position + 160);
    bytes.writeBigUInt64LE(BigInt(plan.reservedDiskBytes), position + 168);
    position += 256;
    for (const record of [...history.records, ...history.volumeRecords, ...history.formatRecords, ...history.protectionRecords,
      ...history.mountRecords, ...history.mountedWorkspaceRecords]) {
      Buffer.from(record, "hex").copy(bytes, position); position += 1024;
    }
  }
  return bytes;
}
