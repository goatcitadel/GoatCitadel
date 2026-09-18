import { createHash } from "node:crypto";
import { nativeCapacityCompositionFixture } from "./remote-worker-native-capacity-composition-test-fixture.js";
import { objectInventoryHistoryFixture, objectInventoryFixture } from "./remote-worker-cell-object-inventory-test-fixture.js";
import { backingCapacityObservationFixture } from "./remote-worker-cell-backing-capacity-test-fixture.js";
import { remoteWorkerCellCanonicalSha256 } from "./remote-worker-cell.js";
import { normalizeRemoteWorkerNativePoolSnapshot } from "./remote-worker-native-pool.js";
import { composeRemoteWorkerNativePoolCapacityInventory } from "./remote-worker-native-pool-capacity-composition.js";

/** Independent multi-member bytes; no native or filesystem operations. */
export function nativePoolCapacityFixture(count = 2, extraHostObjects = 0) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 64) throw new RangeError("Invalid fixture pool size.");
  if (!Number.isSafeInteger(extraHostObjects) || extraHostObjects < 0 || extraHostObjects > 20000) throw new RangeError("Invalid fixture host size.");
  const base = nativeCapacityCompositionFixture({ extra: extraHostObjects });
  const histories = Array.from({ length: count }, (_, seed) => objectInventoryHistoryFixture(seed))
    .sort((a, b) => a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0);
  const members = histories.map(({ schemaVersion: _schema, registryWorkspaceId: _registry, assignmentId, assignmentGeneration, leaseRevision: _lease, ...history }) => ({
    assignmentId, assignmentGeneration, workerGeneration: 1, cellId: `cell-${assignmentId}`, profileSha256: history.plan.profileSha256, history,
  }));
  const current = histories[0]!;
  const pool = normalizeRemoteWorkerNativePoolSnapshot({ schemaVersion: "goatcitadel.remote-worker-native-pool.v1",
    registryWorkspaceId: current.registryWorkspaceId, assignmentId: current.assignmentId, assignmentGeneration: current.assignmentGeneration,
    leaseRevision: current.leaseRevision, workerId: "fixture-worker", workerGeneration: 1, members, membershipSha256: remoteWorkerCellCanonicalSha256(members) });
  const bytes = Buffer.from(base.source.hostCaptureHex, "hex"), header = Buffer.from(bytes.subarray(0, 840));
  let position = 840;
  const areas = Array.from({ length: 13 }, (_, index) => Array.from({ length: bytes.readUInt32LE(424 + index * 32) }, () => {
    const entry = Buffer.from(bytes.subarray(position, position + 48)); position += 48; return entry;
  }));
  const observed = histories.map((history, index) => {
    const guest = objectInventoryFixture(history), backing = backingCapacityObservationFixture(history);
    if (index) {
      for (const offset of [208, 232, 256, 280]) {
        const entry = Buffer.alloc(48); backing.copy(entry, 0, offset, offset + 24); entry.writeUInt32LE(2, 24); entry.writeBigUInt64LE(4096n, 40);
        areas[0]!.push(entry);
      }
      for (const [id, logical, allocated] of [[32, 400, 408], [360, 384, 392]]) {
        const entry = Buffer.alloc(48); backing.copy(entry, 0, id, id! + 24); entry.writeUInt32LE(1, 24);
        entry.writeBigUInt64LE(backing.readBigUInt64LE(logical!), 32); entry.writeBigUInt64LE(backing.readBigUInt64LE(allocated!), 40); areas[0]!.push(entry);
      }
    }
    return { guestObservationHex: guest.summary.toString("hex"), guestChunkHex: guest.chunks.map(chunk => chunk.toString("hex")), backingObservationHex: backing.toString("hex") };
  });
  let hostAllocated = 0;
  areas.forEach((area, index) => {
    area.sort((a, b) => a.subarray(0, 24).compare(b.subarray(0, 24)));
    const offset = 424 + index * 32, files = area.filter(entry => entry.readUInt32LE(24) === 1).length;
    header.writeUInt32LE(area.length, offset); header.writeUInt32LE(files, offset + 4); header.writeUInt32LE(area.length - files, offset + 8);
    header.writeBigUInt64LE(area.reduce((sum, entry) => sum + entry.readBigUInt64LE(32), 0n), offset + 16);
    const allocated = area.reduce((sum, entry) => sum + entry.readBigUInt64LE(40), 0n);
    header.writeBigUInt64LE(allocated, offset + 24); hostAllocated += Number(allocated);
  });
  const host = Buffer.concat([header, ...areas.flat()]);
  const source = { hostCaptureHex: host.toString("hex"), members: observed, references: base.source.references };
  const window = { nonce: base.window.nonce, connectionNonceHex: "71".repeat(32), poolSnapshotSha256: remoteWorkerCellCanonicalSha256(pool),
    hostCaptureSha256: createHash("sha256").update("goatcitadel.native-capacity-capture.v1\0").update(host).digest("hex"),
    membersSha256: remoteWorkerCellCanonicalSha256(observed), referencesSha256: remoteWorkerCellCanonicalSha256(source.references) };
  return { source, pool, layout: base.layout, window, hostAllocated,
    compose: () => composeRemoteWorkerNativePoolCapacityInventory(source, pool, base.layout, window) };
}
