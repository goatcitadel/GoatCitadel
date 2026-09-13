import { createHash } from "node:crypto";
import { normalizeRemoteWorkerCellProvisioningExchange, remoteWorkerCellProvisioningVolumeAnchor } from "./remote-worker-cell-provisioning.js";
import type { RemoteWorkerCellVolumeAnchor } from "./remote-worker-cell-volume.js";

/** Independent wire encoder for tests; never exported as a runtime capability. */
export function volumeCheckpointFixture(anchor: RemoteWorkerCellVolumeAnchor, sequence: number,
  previous = anchor.diskRecordedSha256, layoutPrevious = "0".repeat(64)): string {
  const plan = anchor.layoutPlan, mib = 1024 * 1024;
  const bytes = Buffer.alloc(1024);
  bytes.write("GCCVOL01"); bytes.writeUInt32LE(sequence, 8); bytes.writeUInt32LE(sequence, 12);
  for (const [offset, value] of [[16, previous], [48, plan.assignmentBindingSha256], [80, plan.profileSha256],
    [112, plan.diskIdentifierHex], [144, anchor.journalIdentityHex], [168, plan.controlIdentityHex],
    [192, plan.backingIdentityHex], [216, anchor.diskRecordedSha256], [248, plan.gptDiskIdentifierHex],
    [264, plan.dataPartitionIdentifierHex]] as const) Buffer.from(value, "hex").copy(bytes, offset);
  bytes.writeBigUInt64LE(BigInt(plan.virtualDiskBytes), 128); bytes.writeBigUInt64LE(BigInt(plan.reservedDiskBytes), 136);
  if (sequence > 2) {
    const inner = bytes.subarray(280, 792);
    inner.write("GCCGPT01"); inner.writeUInt32LE(sequence - 2, 8);
    for (const [offset, value] of [[16, layoutPrevious], [48, plan.diskIdentifierHex], [80, plan.controlIdentityHex],
      [104, plan.backingIdentityHex], [128, plan.gptDiskIdentifierHex], [144, plan.dataPartitionIdentifierHex]] as const)
      Buffer.from(value, "hex").copy(inner, offset);
    inner.writeBigUInt64LE(BigInt(plan.virtualDiskBytes), 64); inner.writeBigUInt64LE(BigInt(plan.reservedDiskBytes), 72);
    inner.writeUInt32LE(512, 388);
    if (sequence >= 4) {
      inner.writeBigUInt64LE(17408n, 160); inner.writeBigUInt64LE(BigInt(plan.virtualDiskBytes - 34304), 168);
      inner.writeUInt32LE(128, 176); Buffer.from("44444444555566468708090a0b0c0d0e", "hex").copy(inner, 180);
      inner.writeBigUInt64LE(BigInt(mib), 196); inner.writeBigUInt64LE(BigInt(16 * mib), 204);
      inner.write("Microsoft reserved partition", 220, "utf16le");
      inner.writeBigUInt64LE(BigInt(17 * mib), 292); inner.writeBigUInt64LE(BigInt(plan.virtualDiskBytes - 18 * mib), 300);
      inner.writeBigUInt64LE(0x8000000000000000n, 308); inner.write("GoatCitadel cell", 316, "utf16le");
    }
    rehashVolumeFixture(inner);
  }
  return rehashVolumeFixture(bytes);
}

export function rehashVolumeFixture(bytes: Buffer): string {
  createHash("sha256").update(bytes.subarray(0, bytes.length - 32)).digest().copy(bytes, bytes.length - 32);
  return bytes.toString("hex");
}

export function volumeExchangeFixture(input: unknown) {
  const exchange = normalizeRemoteWorkerCellProvisioningExchange(input);
  const anchor = remoteWorkerCellProvisioningVolumeAnchor(exchange);
  const volumeRecords: string[] = [];
  for (let sequence = 1; sequence <= 6; sequence++) {
    const prior = volumeRecords.at(-1);
    volumeRecords.push(volumeCheckpointFixture(anchor, sequence, prior?.slice(-64),
      sequence > 3 ? prior!.slice(1520, 1584) : undefined));
  }
  return normalizeRemoteWorkerCellProvisioningExchange({ ...exchange, volumeRecords });
}
