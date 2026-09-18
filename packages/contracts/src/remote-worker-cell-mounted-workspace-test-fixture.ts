import { normalizeRemoteWorkerCellMountedWorkspaceAnchor, type RemoteWorkerCellMountedWorkspaceAnchor } from "./remote-worker-cell-mounted-workspace.js";
import { normalizeRemoteWorkerCellProvisioningExchange, remoteWorkerCellProvisioningMountedWorkspaceAnchor } from "./remote-worker-cell-provisioning.js";
import { mountExchangeFixture } from "./remote-worker-cell-mount-test-fixture.js";
import { rehashVolumeFixture } from "./remote-worker-cell-volume-test-fixture.js";
import type { CellVolumeFixtureIdentity } from "./remote-worker-cell-format-test-fixture.js";

/** Independent byte encoder; no filesystem or volume operations. */
export function mountedWorkspaceCheckpointFixture(input: RemoteWorkerCellMountedWorkspaceAnchor, sequence: number,
  previous?: string, workspacePrevious = "0".repeat(64)): string {
  const anchor = normalizeRemoteWorkerCellMountedWorkspaceAnchor(input);
  const mount = Buffer.from(anchor.mountRecords[3]!, "hex"), binding = mount.subarray(280, 792);
  const bytes = Buffer.alloc(1024), inner = bytes.subarray(280, 792);
  bytes.write("GCCMWP01"); bytes.writeUInt32LE(sequence, 8); bytes.writeUInt32LE(sequence, 12);
  Buffer.from(previous ?? mount.subarray(992).toString("hex"), "hex").copy(bytes, 16);
  mount.subarray(48, 216).copy(bytes, 48); mount.subarray(992).copy(bytes, 216); mount.subarray(248, 280).copy(bytes, 248);
  inner.write("GCCWRK01"); inner.writeUInt32LE(sequence, 8); Buffer.from(workspacePrevious, "hex").copy(inner, 16);
  binding.subarray(480).copy(inner, 48); binding.subarray(80, 112).copy(inner, 80);
  inner.write(anchor.cellName, 112, "ascii"); binding.subarray(152, 176).copy(inner, 152);
  if (sequence === 2) for (let index = 0; index < 4; index++) {
    const offset = 176 + index * 24;
    binding.subarray(152, 160).copy(inner, offset); inner.fill(0xe8 + index, offset + 8, offset + 24);
  }
  rehashVolumeFixture(inner); return rehashVolumeFixture(bytes);
}
export function mountedWorkspaceExchangeFixture(input: unknown, identity: CellVolumeFixtureIdentity = {}) {
  const exchange = mountExchangeFixture(input, identity), anchor = remoteWorkerCellProvisioningMountedWorkspaceAnchor(exchange);
  const mountedWorkspaceRecords: string[] = [];
  for (let sequence = 1; sequence <= 2; sequence++) {
    const prior = mountedWorkspaceRecords.at(-1);
    mountedWorkspaceRecords.push(mountedWorkspaceCheckpointFixture(anchor, sequence, prior?.slice(-64), prior?.slice(1520, 1584)));
  }
  return normalizeRemoteWorkerCellProvisioningExchange({ ...exchange, mountedWorkspaceRecords });
}
