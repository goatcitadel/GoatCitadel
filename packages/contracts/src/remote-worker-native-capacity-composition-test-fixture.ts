import { createHash } from "node:crypto";
import { composeRemoteWorkerNativeCapacityInventory } from "./remote-worker-native-capacity-composition.js";
import { objectInventoryFixture, objectInventoryHistoryFixture } from "./remote-worker-cell-object-inventory-test-fixture.js";
import { backingCapacityObservationFixture } from "./remote-worker-cell-backing-capacity-test-fixture.js";
import { remoteWorkerCellCanonicalSha256 } from "./remote-worker-cell.js";
import { remoteWorkerNativeCapacityIdentitySha256 } from "./remote-worker-native-capacity-layout.js";
import type { RemoteWorkerCellProvisioningExchange } from "./remote-worker-cell-provisioning.js";

export function nativeCapacityCompositionFixture(options: { omit?: number; backingDelta?: number; extra?: number; history?: RemoteWorkerCellProvisioningExchange; nonce?: string; unallocatedRetentionRoots?: boolean; guestLogicalBytes?: number } = {}) {
  const history = options.history ?? objectInventoryHistoryFixture(), guest = objectInventoryFixture(history, 22, options.guestLogicalBytes), backing = backingCapacityObservationFixture(history);
  const raw = (id: number) => "0100000000000000" + id.toString(16).padStart(32, "0");
  const layout = { schemaVersion: "goatcitadel.native-capacity-layout.v1", assignmentBindingSha256: history.plan.assignmentBindingSha256,
    profileSha256: history.plan.profileSha256, rootIdentityHex: Array.from({ length: 13 }, (_, i) => i ? raw(200 + i) : history.plan.parentIdentityHex) };
  const nonce = options.nonce ?? "33".repeat(32);
  const areas = layout.rootIdentityHex.map((id, index) => [{ id, kind: 2, logical: 0,
    allocated: options.unallocatedRetentionRoots && index >= 11 ? 0 : 4096 }]);
  for (const id of [3, 4, 5, 6]) if (id !== options.omit) areas[0]!.push({ id: raw(id), kind: 2, logical: 0, allocated: 4096 });
  if (options.omit !== 2) areas[0]!.push({ id: raw(2), kind: 1, logical: Number(backing.readBigUInt64LE(400)), allocated: Number(backing.readBigUInt64LE(408)) });
  if (options.omit !== 7) areas[0]!.push({ id: raw(7), kind: 1, logical: Number(backing.readBigUInt64LE(384)),
    allocated: Number(backing.readBigUInt64LE(392)) + (options.backingDelta ?? 0) });
  areas[4]!.push({ id: raw(30), kind: 1, logical: 42, allocated: 4096 });
  for (let i = 0; i < (options.extra ?? 0); i++) areas[4]!.push({ id: raw(1000 + i), kind: 1, logical: 0, allocated: 0 });
  const bytes = Buffer.alloc(840 + areas.reduce((total, area) => total + area.length * 48, 0));
  bytes.write("GCCAP001"); Buffer.from(nonce, "hex").copy(bytes, 8); bytes.write("GCLAY001", 40);
  Buffer.from(layout.assignmentBindingSha256, "hex").copy(bytes, 48); Buffer.from(layout.profileSha256, "hex").copy(bytes, 80);
  let position = 840;
  areas.forEach((area, index) => {
    Buffer.from(layout.rootIdentityHex[index]!, "hex").copy(bytes, 112 + index * 24);
    const summary = 424 + index * 32, files = area.filter(entry => entry.kind === 1).length;
    bytes.writeUInt32LE(area.length, summary); bytes.writeUInt32LE(files, summary + 4); bytes.writeUInt32LE(area.length - files, summary + 8);
    bytes.writeBigUInt64LE(BigInt(area.reduce((total, entry) => total + entry.logical, 0)), summary + 16);
    bytes.writeBigUInt64LE(BigInt(area.reduce((total, entry) => total + entry.allocated, 0)), summary + 24);
    area.sort((a, b) => a.id.localeCompare(b.id)).forEach(entry => {
      Buffer.from(entry.id, "hex").copy(bytes, position); bytes.writeUInt32LE(entry.kind, position + 24);
      bytes.writeBigUInt64LE(BigInt(entry.logical), position + 32); bytes.writeBigUInt64LE(BigInt(entry.allocated), position + 40); position += 48;
    });
  });
  const references = ["ab", "cd"].map(id => ({ referenceSha256: id.repeat(32), objectIdentitySha256: remoteWorkerNativeCapacityIdentitySha256(raw(30)) }));
  const source = { hostCaptureHex: bytes.toString("hex"), guestObservationHex: guest.summary.toString("hex"),
    guestChunkHex: guest.chunks.map(chunk => chunk.toString("hex")), backingObservationHex: backing.toString("hex"), references };
  const window = { nonce, hostCaptureSha256: createHash("sha256").update("goatcitadel.native-capacity-capture.v1\0").update(bytes).digest("hex"),
    guestObservationSha256: remoteWorkerCellCanonicalSha256({ schemaVersion: "goatcitadel.native-capacity-guest-source.v1",
      observationHex: source.guestObservationHex, chunkHex: source.guestChunkHex }),
    backingObservationSha256: remoteWorkerCellCanonicalSha256({ schemaVersion: "goatcitadel.native-capacity-backing-source.v1", observationHex: source.backingObservationHex }),
    referencesSha256: remoteWorkerCellCanonicalSha256(references) };
  return { source, window, history, layout, raw, hostAllocated: areas.flat().reduce((sum, entry) => sum + entry.allocated, 0),
    compose: () => composeRemoteWorkerNativeCapacityInventory(source, history, layout, window) };
}
