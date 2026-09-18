import type { RemoteWorkerCellProvisioningExchange } from "./remote-worker-cell-provisioning.js";

/** Independent native-wire encoder using raw history offsets. No disk access. */
export function capacityObservationFixture(exchange: RemoteWorkerCellProvisioningExchange, nonce = 0x71): Buffer {
  const prepared = Buffer.from(exchange.records[0]!, "hex");
  const mounted = Buffer.from(exchange.mountedWorkspaceRecords![1]!, "hex");
  const bytes = Buffer.alloc(352);
  bytes.fill(nonce, 0, 32); prepared.subarray(168, 192).copy(bytes, 32); prepared.subarray(992).copy(bytes, 56);
  prepared.subarray(48, 112).copy(bytes, 88); mounted.subarray(992).copy(bytes, 152);
  mounted.subarray(432, 552).copy(bytes, 184); mounted.subarray(456, 480).copy(bytes, 304);
  bytes.writeBigUInt64LE(9000n, 328); bytes.writeBigUInt64LE(4096n, 336);
  bytes.writeUInt32LE(2, 344); bytes.writeUInt32LE(4, 348);
  return bytes;
}
