import { normalizeRemoteWorkerCellFormatAnchor, type RemoteWorkerCellFormatAnchor } from "./remote-worker-cell-format.js";
import { normalizeRemoteWorkerCellProvisioningExchange, remoteWorkerCellProvisioningFormatAnchor } from "./remote-worker-cell-provisioning.js";
import { rehashVolumeFixture, volumeExchangeFixture } from "./remote-worker-cell-volume-test-fixture.js";

/** Independent test encoder, never exported as a runtime capability. */
export function formatCheckpointFixture(input: RemoteWorkerCellFormatAnchor, sequence: number,
  previous?: string, ntfsPrevious = "0".repeat(64)): string {
  const anchor = normalizeRemoteWorkerCellFormatAnchor(input);
  const volume = Buffer.from(anchor.volumeRecords[5]!, "hex"), layout = volume.subarray(280, 792);
  const bytes = Buffer.alloc(1024), inner = bytes.subarray(280, 792);
  bytes.write("GCCFMT01"); bytes.writeUInt32LE(sequence, 8); bytes.writeUInt32LE(sequence, 12);
  Buffer.from(previous ?? volume.subarray(992).toString("hex"), "hex").copy(bytes, 16);
  volume.subarray(48, 216).copy(bytes, 48); volume.subarray(992).copy(bytes, 216); volume.subarray(248, 280).copy(bytes, 248);
  inner.write("GCCNTF01"); inner.writeUInt32LE(sequence, 8); Buffer.from(ntfsPrevious, "hex").copy(inner, 16);
  layout.subarray(480).copy(inner, 48); Buffer.from("78563412bc9aef4d8123456789abcdef", "hex").copy(inner, 80);
  const partition = layout.readBigUInt64LE(300);
  inner.writeBigUInt64LE(partition, 96); inner.writeUInt32LE(512, 104); inner.writeUInt32LE(4096, 108);
  inner.write("GoatCitadel cell", 112, "utf16le");
  if (sequence === 2) {
    const sectors = partition / 512n - 1n;
    inner.writeBigUInt64LE(0xfedcba9876543210n, 184); inner.writeBigUInt64LE(sectors, 192); inner.writeBigUInt64LE(sectors / 8n, 200);
  }
  rehashVolumeFixture(inner);
  return rehashVolumeFixture(bytes);
}
export function formatExchangeFixture(input: unknown) {
  const exchange = volumeExchangeFixture(input), anchor = remoteWorkerCellProvisioningFormatAnchor(exchange);
  const intent = formatCheckpointFixture(anchor, 1);
  const completion = formatCheckpointFixture(anchor, 2, intent.slice(-64), intent.slice(1520, 1584));
  return normalizeRemoteWorkerCellProvisioningExchange({ ...exchange, formatRecords: [intent, completion] });
}
