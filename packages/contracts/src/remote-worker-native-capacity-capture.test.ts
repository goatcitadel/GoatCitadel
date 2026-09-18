import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { capacityInventoryFixture, withNativeCapacityLayout } from "./remote-worker-cell-capacity-inventory-test-fixture.js";
import { readRemoteWorkerNativeCapacityCapture, REMOTE_WORKER_NATIVE_CAPACITY_CAPTURE_MAX_BYTES } from "./remote-worker-native-capacity-capture.js";
function fixture(files = 13) {
  const layout = withNativeCapacityLayout(capacityInventoryFixture("11".repeat(32), "capture"), "22".repeat(32)).nativeLayout;
  const nonce = "33".repeat(32), bytes = Buffer.alloc(840 + 48 * (13 + files));
  bytes.write("GCCAP001"); Buffer.from(nonce, "hex").copy(bytes, 8); bytes.write("GCLAY001", 40);
  Buffer.from(layout.assignmentBindingSha256, "hex").copy(bytes, 48); Buffer.from(layout.profileSha256, "hex").copy(bytes, 80);
  let position = 840;
  for (let area = 0; area < 13; area++) {
    Buffer.from(layout.rootIdentityHex[area]!, "hex").copy(bytes, 112 + area * 24);
    const count = area === 0 ? files : 0, summary = 424 + area * 32;
    bytes.writeUInt32LE(count + 1, summary); bytes.writeUInt32LE(count, summary + 4); bytes.writeUInt32LE(1, summary + 8);
    bytes.writeBigUInt64LE(BigInt(count * (count + 1) / 2), summary + 16); bytes.writeBigUInt64LE(BigInt((count + 1) * 4096), summary + 24);
    Buffer.from(layout.rootIdentityHex[area]!, "hex").copy(bytes, position); bytes.writeUInt32LE(2, position + 24);
    bytes.writeBigUInt64LE(4096n, position + 40); position += 48;
    for (let i = 0; i < count; i++, position += 48) {
      Buffer.from("1100000000000000" + (100 + i).toString(16).padStart(32, "0"), "hex").copy(bytes, position);
      bytes.writeUInt32LE(1, position + 24); bytes.writeBigUInt64LE(BigInt(i + 1), position + 32); bytes.writeBigUInt64LE(4096n, position + 40);
    }
  }
  return { bytes, layout, nonce, read: (value = bytes) => readRemoteWorkerNativeCapacityCapture(value.toString("hex"), nonce, layout) };
}
describe("native host-area capture wire", () => {
  it("preserves the complete declared areas with immutable source-bound evidence", () => {
    const f = fixture(), result = f.read();
    expect(result.nativeLayout).toEqual(f.layout); expect(result.areas).toHaveLength(13);
    expect(result.areas[0]?.objects).toHaveLength(14); expect(result.areas[12]?.objects).toHaveLength(1);
    expect(new Set(result.areas.map(area => area.evidenceSha256)).size).toBe(13);
    expect(result.captureSha256).toBe(createHash("sha256").update("goatcitadel.native-capacity-capture.v1\0").update(f.bytes).digest("hex"));
    expect(Object.isFrozen(result.areas[0]?.objects[0])).toBe(true);
    f.bytes.fill(0); expect(result.areas[0]?.objects).toHaveLength(14);
  });
  it("accepts exactly 20,000 objects within the native byte ceiling", () => {
    const f = fixture(19987); expect(f.bytes.length).toBe(REMOTE_WORKER_NATIVE_CAPACITY_CAPTURE_MAX_BYTES);
    expect(f.read().areas.reduce((count, area) => count + area.objects.length, 0)).toBe(20000);
  });
  it.each(["count", "files", "padding", "kind", "entryPadding", "root", "duplicate", "order", "directoryBytes", "logical", "allocated", "unsafe", "trailing", "partial"])("rejects %s corruption", mode => {
    const f = fixture(); let bytes = Buffer.from(f.bytes);
    if (mode === "count") bytes.writeUInt32LE(20001, 424);
    if (mode === "files") bytes.writeUInt32LE(12, 428);
    if (mode === "padding") bytes[436] = 1;
    if (mode === "kind") bytes.writeUInt32LE(3, 864);
    if (mode === "entryPadding") bytes[868] = 1;
    if (mode === "root") bytes[863] = 0xff;
    if (mode === "duplicate") bytes.copy(bytes, 888, 840, 864);
    if (mode === "order") bytes.copy(bytes, 936, 888, 912);
    if (mode === "directoryBytes") bytes.writeBigUInt64LE(1n, 872);
    if (mode === "logical") bytes.writeBigUInt64LE(0n, 440);
    if (mode === "allocated") bytes.writeBigUInt64LE(0n, 448);
    if (mode === "unsafe") bytes.writeBigUInt64LE(9007199254740992n, 880);
    if (mode === "trailing") bytes = Buffer.concat([bytes, Buffer.from([0])]);
    if (mode === "partial") bytes = bytes.subarray(0, bytes.length - 1);
    expect(() => f.read(bytes)).toThrow();
  });
  it("requires independently retained layout and nonce rather than trusting frame bindings", () => {
    const f = fixture();
    expect(() => readRemoteWorkerNativeCapacityCapture(f.bytes.toString("hex"), "44".repeat(32), f.layout)).toThrow();
    expect(() => readRemoteWorkerNativeCapacityCapture(f.bytes.toString("hex"), f.nonce, { ...f.layout, assignmentBindingSha256: "44".repeat(32) })).toThrow();
    expect(() => f.read(Buffer.alloc(REMOTE_WORKER_NATIVE_CAPACITY_CAPTURE_MAX_BYTES + 1))).toThrow();
  });
});
