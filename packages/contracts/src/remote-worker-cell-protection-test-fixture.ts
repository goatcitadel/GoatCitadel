import { createHash } from "node:crypto";
import { normalizeRemoteWorkerCellProtectionAnchor, type RemoteWorkerCellProtectionAnchor } from "./remote-worker-cell-protection.js";
import { normalizeRemoteWorkerCellProvisioningExchange, remoteWorkerCellProvisioningProtectionAnchor } from "./remote-worker-cell-provisioning.js";
import { formatExchangeFixture, type CellVolumeFixtureIdentity } from "./remote-worker-cell-format-test-fixture.js";
import { rehashVolumeFixture } from "./remote-worker-cell-volume-test-fixture.js";

/** Independent encoder; fixture code never authorizes native operations. */
export function protectionCheckpointFixture(input: RemoteWorkerCellProtectionAnchor, sequence: number,
  previous?: string, rootPrevious = "0".repeat(64)): string {
  const anchor = normalizeRemoteWorkerCellProtectionAnchor(input);
  const format = Buffer.from(anchor.formatRecords[1]!, "hex"), ntfs = format.subarray(280, 792);
  const bytes = Buffer.alloc(1024), inner = bytes.subarray(280, 792);
  bytes.write("GCCPRV01"); bytes.writeUInt32LE(sequence, 8); bytes.writeUInt32LE(sequence, 12);
  Buffer.from(previous ?? format.subarray(992).toString("hex"), "hex").copy(bytes, 16);
  format.subarray(48, 216).copy(bytes, 48); format.subarray(992).copy(bytes, 216); format.subarray(248, 280).copy(bytes, 248);
  inner.write("GCCPRT01"); inner.writeUInt32LE(sequence, 8); Buffer.from(rootPrevious, "hex").copy(inner, 16);
  ntfs.subarray(480).copy(inner, 48);
  const policy = [Buffer.from("goatcitadel.native-cell-volume-root-security.v1\0", "ascii")];
  for (const sid of [anchor.ownerSid, anchor.controllerSid]) {
    const size = Buffer.alloc(2); size.writeUInt16LE(sid.length); policy.push(size, Buffer.from(sid, "ascii"));
  }
  createHash("sha256").update(Buffer.concat(policy)).digest().copy(inner, 80);
  ntfs.subarray(80, 104).copy(inner, 112); ntfs.subarray(184, 208).copy(inner, 136);
  ntfs.subarray(184, 192).copy(inner, 160); inner.fill(0xd6, 168, 184);
  rehashVolumeFixture(inner); return rehashVolumeFixture(bytes);
}
export function protectionExchangeFixture(input: unknown, identity: CellVolumeFixtureIdentity = {}) {
  const exchange = formatExchangeFixture(input, identity), anchor = remoteWorkerCellProvisioningProtectionAnchor(exchange);
  const intent = protectionCheckpointFixture(anchor, 1);
  const completion = protectionCheckpointFixture(anchor, 2, intent.slice(-64), intent.slice(1520, 1584));
  return normalizeRemoteWorkerCellProvisioningExchange({ ...exchange, protectionRecords: [intent, completion] });
}
