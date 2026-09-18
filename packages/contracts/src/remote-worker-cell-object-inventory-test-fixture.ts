import type { RemoteWorkerCellProvisioningExchange } from "./remote-worker-cell-provisioning.js";
import { capacityObservationFixture } from "./remote-worker-cell-capacity-test-fixture.js";
import { mountedWorkspaceExchangeFixture } from "./remote-worker-cell-mounted-workspace-test-fixture.js";
import { rehashVolumeFixture } from "./remote-worker-cell-volume-test-fixture.js";
import { REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION, REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
  remoteWorkerCellProvisioningPlanSha256 } from "./remote-worker-cell-provisioning.js";

export function objectInventoryHistoryFixture(seed = 0) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 63) throw new RangeError("Fixture seed must identify one of at most 64 members.");
  const identity = (value: number) => "0100000000000000" + (value === 1 ? value : value + seed * 32).toString(16).padStart(32, "0");
  const plan = { schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION,
    assignmentBindingSha256: seed ? (seed + 1).toString(16).padStart(64, "0") : "1".repeat(64), profileSha256: "2".repeat(64), parentIdentityHex: identity(1),
    cellName: `gc-cell-${seed ? (seed + 1).toString(16).padStart(32, "0") : "1".repeat(32)}`, ownerSid: "S-1-5-18", controllerSid: "S-1-5-80-1-2-3-4-5",
    diskIdentifierHex: seed ? (seed + 3).toString(16).padStart(32, "0") : "3".repeat(32), virtualDiskBytes: 64 * 1024 ** 2, reservedDiskBytes: 128 * 1024 ** 2 } as const;
  const records: string[] = [];
  for (let sequence = 1; sequence <= 5; sequence += 1) {
    const bytes = Buffer.alloc(1024); bytes.write("GCCELLP1"); bytes.writeUInt32LE(sequence, 8); bytes.writeUInt32LE(sequence, 12);
    for (const [offset, value] of [[16, records.at(-1)?.slice(-64) ?? "0".repeat(64)], [48, plan.assignmentBindingSha256],
      [80, plan.profileSha256], [112, plan.diskIdentifierHex], [144, identity(1)], [168, identity(2)]] as const) Buffer.from(value, "hex").copy(bytes, offset);
    bytes.writeBigUInt64LE(BigInt(plan.virtualDiskBytes), 128); bytes.writeBigUInt64LE(BigInt(plan.reservedDiskBytes), 136);
    bytes.write(plan.cellName, 192); bytes.write(plan.ownerSid, 232); bytes.write(plan.controllerSid, 416);
    if (sequence >= 3) for (let index = 0; index < 4; index += 1) Buffer.from(identity(index + 3), "hex").copy(bytes, 600 + index * 24);
    if (sequence === 5) Buffer.from(identity(7), "hex").copy(bytes, 696);
    records.push(rehashVolumeFixture(bytes));
  }
  return mountedWorkspaceExchangeFixture({ schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
    registryWorkspaceId: "default", assignmentId: seed ? `native-inventory-${seed}` : "native-inventory", assignmentGeneration: 1, leaseRevision: 1,
    plan, planSha256: remoteWorkerCellProvisioningPlanSha256(plan), records }, seed ? {
      ntfsSerial: 0xfedcba9876543210n + BigInt(seed), volumeIdHex: `78563412bc9aef4d8123456789abcd${seed.toString(16).padStart(2, "0")}`,
      mountIdByte: 0x80 + seed } : {});
}

/** Independent wire fixture: four retained roots and distinct sparse/empty files. */
export function objectInventoryFixture(exchange: RemoteWorkerCellProvisioningExchange, fileCount = 22, logicalFileBytes = 0x200000005) {
  if (!Number.isSafeInteger(logicalFileBytes) || logicalFileBytes < 0) throw new RangeError("Fixture logical bytes must be a non-negative safe integer.");
  const summary = capacityObservationFixture(exchange);
  summary.writeBigUInt64LE(BigInt(logicalFileBytes), 328); summary.writeBigUInt64LE(BigInt(fileCount) * 4096n, 336);
  summary.writeUInt32LE(fileCount, 344);
  const records: Buffer[] = [];
  for (let index = 0; index < 4; index += 1) {
    const record = Buffer.alloc(48); summary.copy(record, 0, 208 + index * 24, 232 + index * 24);
    record.writeUInt32LE(1, 24); records.push(record);
  }
  for (let index = 0; index < fileCount; index += 1) {
    const record = Buffer.alloc(48); summary.copy(record, 0, 304, 312);
    record.fill(0xf0, 8, 24); record.writeUInt32BE(index + 1, 20);
    record.writeBigUInt64LE(index ? 0n : BigInt(logicalFileBytes), 32); record.writeBigUInt64LE(4096n, 40); records.push(record);
  }
  records.sort((a, b) => a.subarray(8, 24).compare(b.subarray(8, 24)));
  const chunks: Buffer[] = [];
  for (let start = 0; start < records.length; start += 20) {
    const chunk = Buffer.alloc(1000); summary.copy(chunk, 0, 0, 32);
    chunk.writeUInt32LE(start, 32); chunk.writeUInt32LE(Math.min(20, records.length - start), 36);
    records.slice(start, start + 20).forEach((record, index) => record.copy(chunk, 40 + index * 48)); chunks.push(chunk);
  }
  return { summary, chunks, records };
}
