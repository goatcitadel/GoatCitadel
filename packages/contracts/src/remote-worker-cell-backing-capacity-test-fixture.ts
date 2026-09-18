import type { RemoteWorkerCellProvisioningExchange } from "./remote-worker-cell-provisioning.js";

/** Independent test encoder, never exported from the product barrel. No native
 * operation runs; values are controlled host-file observations. */
export function backingCapacityObservationFixture(exchange: RemoteWorkerCellProvisioningExchange, nonceByte = 0x71): Buffer {
  const first = Buffer.from(exchange.records[0]!, "hex"), disk = Buffer.from(exchange.records[4]!, "hex");
  const last = Buffer.from(exchange.mountedWorkspaceRecords![1]!, "hex"), bytes = Buffer.alloc(424);
  bytes.fill(nonceByte, 0, 32); first.copy(bytes, 32, 168, 192); first.copy(bytes, 56, 992, 1024);
  first.copy(bytes, 88, 48, 112); last.copy(bytes, 152, 992, 1024);
  first.copy(bytes, 184, 144, 168); disk.copy(bytes, 208, 600, 696); first.copy(bytes, 304, 112, 144);
  disk.copy(bytes, 336, 624, 648); disk.copy(bytes, 360, 696, 720);
  const allocated = BigInt(exchange.plan.virtualDiskBytes) + 2n * 1024n * 1024n;
  bytes.writeBigUInt64LE(allocated, 384); bytes.writeBigUInt64LE(allocated, 392);
  bytes.writeBigUInt64LE(21504n, 400); bytes.writeBigUInt64LE(24576n, 408); bytes.writeBigUInt64LE(allocated + 24576n, 416);
  return bytes;
}
