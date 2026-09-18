import { normalizeRemoteWorkerCellMountAnchor, type RemoteWorkerCellMountAnchor } from "./remote-worker-cell-mount.js";
import { normalizeRemoteWorkerCellProvisioningExchange, remoteWorkerCellProvisioningMountAnchor } from "./remote-worker-cell-provisioning.js";
import { protectionExchangeFixture } from "./remote-worker-cell-protection-test-fixture.js";
import { rehashVolumeFixture } from "./remote-worker-cell-volume-test-fixture.js";
import type { CellVolumeFixtureIdentity } from "./remote-worker-cell-format-test-fixture.js";

/** Independent byte encoder; it never performs a Windows mount. */
export function mountCheckpointFixture(input: RemoteWorkerCellMountAnchor, sequence: number,
  previous?: string, mountPrevious = "0".repeat(64), identity: CellVolumeFixtureIdentity = {}): string {
  const anchor = normalizeRemoteWorkerCellMountAnchor(input);
  const protection = Buffer.from(anchor.protectionRecords[1]!, "hex"), root = protection.subarray(280, 792);
  const parent = Buffer.from(anchor.workspaceIdentityHex[0]!, "hex");
  const bytes = Buffer.alloc(1024), inner = bytes.subarray(280, 792);
  bytes.write("GCCMNV01"); bytes.writeUInt32LE(sequence, 8); bytes.writeUInt32LE(sequence, 12);
  Buffer.from(previous ?? protection.subarray(992).toString("hex"), "hex").copy(bytes, 16);
  protection.subarray(48, 216).copy(bytes, 48); protection.subarray(992).copy(bytes, 216); protection.subarray(248, 280).copy(bytes, 248);
  inner.write("GCCMNT01"); inner.writeUInt32LE(sequence, 8); Buffer.from(mountPrevious, "hex").copy(inner, 16);
  root.subarray(480).copy(inner, 48); root.subarray(80, 128).copy(inner, 80);
  parent.copy(inner, 128); root.subarray(160, 184).copy(inner, 152);
  if (sequence > 1) { parent.subarray(0, 8).copy(inner, 176); inner.fill(identity.mountIdByte ?? 0xe7, 184, 200); }
  rehashVolumeFixture(inner); return rehashVolumeFixture(bytes);
}
export function mountExchangeFixture(input: unknown, identity: CellVolumeFixtureIdentity = {}) {
  const exchange = protectionExchangeFixture(input, identity), anchor = remoteWorkerCellProvisioningMountAnchor(exchange);
  const mountRecords: string[] = [];
  for (let sequence = 1; sequence <= 4; sequence++) {
    const prior = mountRecords.at(-1);
    mountRecords.push(mountCheckpointFixture(anchor, sequence, prior?.slice(-64), prior?.slice(1520, 1584), identity));
  }
  return normalizeRemoteWorkerCellProvisioningExchange({ ...exchange, mountRecords });
}
