import { nativePoolCapacityFixture } from "./remote-worker-native-pool-capacity-test-fixture.js";

/** Independent byte fixture for the native GCPRESP1 layout. */
export function nativePoolCapacityResponseFixture(count = 2) {
  const f = nativePoolCapacityFixture(count), header = Buffer.alloc(88), host = Buffer.from(f.source.hostCaptureHex, "hex");
  header.write("GCPRESP1"); header.writeUInt32LE(1, 8); header.writeUInt32LE(f.pool.members.length, 12); header.writeUInt32LE(host.length, 16);
  Buffer.from(f.window.connectionNonceHex, "hex").copy(header, 24); Buffer.from(f.window.poolSnapshotSha256, "hex").copy(header, 56);
  const parts = [header, host.subarray(40, 424), host];
  f.source.members.forEach((member, index) => {
    const prefix = Buffer.alloc(8); prefix.writeUInt32LE(index); prefix.writeUInt32LE(member.guestChunkHex.length, 4);
    parts.push(prefix, Buffer.from(member.guestObservationHex, "hex"), Buffer.from(member.backingObservationHex, "hex"),
      ...member.guestChunkHex.map(hex => Buffer.from(hex, "hex")));
  });
  return { ...f, bytes: Buffer.concat(parts), memberOffset: 88 + 384 + host.length };
}
