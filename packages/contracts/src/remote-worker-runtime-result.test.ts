import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { objectInventoryFixture, objectInventoryHistoryFixture } from "./remote-worker-cell-object-inventory-test-fixture.js";
import { normalizeRemoteWorkerRuntimeResultExpectation, readRemoteWorkerRuntimeResult, REMOTE_WORKER_RUNTIME_RESULT_MAX_BYTES } from "./remote-worker-runtime-result.js";

function fixture(fileCount = 22, withBacking = false) {
  const history = objectInventoryHistoryFixture(), { summary, chunks } = objectInventoryFixture(history, fileCount);
  const expectation = { nonce: summary.subarray(0, 32).toString("hex"), requestSha256: "aa".repeat(32),
    checkpointSha256: summary.subarray(152, 184).toString("hex"), runtimeBundleSha256: "dd".repeat(32),
    maxInputBytes: 100, maxOutputBytes: 100000, maxInventoryEntries: 20000 };
  const header = Buffer.alloc(256); header.write("GCRRS001");
  for (const [offset, hex] of [[8, expectation.nonce], [40, expectation.requestSha256], [72, expectation.checkpointSha256], [184, expectation.runtimeBundleSha256]] as const)
    Buffer.from(hex, "hex").copy(header, offset);
  header.writeUInt32LE(0x1fef, 104); header.writeUInt32LE(23, 116); header.writeUInt32LE(777, 120);
  header.writeUInt32LE(10000, 124); header.writeUInt32LE(2, 128); header.writeUInt32LE(2, 132);
  for (const [offset, value] of [[144, 100000n], [152, 23456n], [160, 3n], [168, 3n], [176, 1n]] as const) header.writeBigUInt64LE(value, offset);
  header.writeUInt32LE(fileCount + 4, 216);
  if (withBacking) {
    header.writeUInt32LE(header.readUInt32LE(104) | 0x8000, 104);
    for (const [offset, value] of [[220, history.plan.virtualDiskBytes], [228, history.plan.reservedDiskBytes],
      [236, 21 * 1024], [244, 24576]] as const) header.writeBigUInt64LE(BigInt(value), offset);
  }
  const bytes = Buffer.concat([header, summary, ...chunks]);
  return { history, expectation, bytes, read: (value = bytes, expected: unknown = expectation, retained = history) => readRemoteWorkerRuntimeResult(value.toString("hex"), expected, retained) };
}

describe("protected native runtime result decoding", () => {
  it("retains exact accounting, inventory and digest independently of nonzero workload exit", () => {
    const { bytes, read } = fixture(), result = read();
    expect(result.end).toBe("exited"); expect(result.exitCode).toBe(23);
    expect(result.backing).toBeNull();
    expect(result.flags.captureVerified).toBe(true); expect(result.inventory?.entries).toHaveLength(26);
    expect(result.stdinBytes).toBe(3); expect(result.stdoutBytes).toBe(3); expect(result.stderrBytes).toBe(1);
    expect(result.resultSha256).toBe(createHash("sha256").update("goatcitadel.worker-runtime-result.v1\0").update(bytes).digest("hex"));
    expect(Object.isFrozen(result) && Object.isFrozen(result.flags)).toBe(true);
    expect(Object.keys(result).some(key => /command|environment|prefix|tail/i.test(key))).toBe(false);
    bytes.fill(0); expect(result.inventory?.entries).toHaveLength(26);
  });
  it("retains paired host charges separately from guest allocation and binds them into the digest", () => {
    const { bytes, read, history } = fixture(22, true), result = read();
    expect(result.backing).toEqual({ backingFileBytes: history.plan.virtualDiskBytes,
      backingAllocatedBytes: history.plan.reservedDiskBytes, journalBytes: 21504, journalAllocatedBytes: 24576,
      hostFileAllocatedBytes: history.plan.reservedDiskBytes + 24576 });
    expect(Object.isFrozen(result.backing)).toBe(true);
    expect(result.exitCode).toBe(23); expect(result.inventory?.entries).toHaveLength(26);
    bytes.writeBigUInt64LE(65536n, 244);
    expect(read().resultSha256).not.toBe(result.resultSha256);
    expect(result.backing?.journalAllocatedBytes).toBe(24576);
  });
  it.each(["flag", "inventory", "file", "allocated", "reserve", "journal", "journalAllocation", "journalCeiling", "unsafe", "reserved", "unknownFlag"])(
    "refuses paired backing %s violations", mode => {
      const { bytes, read, history } = fixture(22, true);
      if (mode === "flag") bytes.writeUInt32LE(bytes.readUInt32LE(104) & ~0x8000, 104);
      if (mode === "inventory") bytes.writeUInt32LE(bytes.readUInt32LE(104) & ~8, 104);
      if (mode === "file") bytes.writeBigUInt64LE(BigInt(history.plan.virtualDiskBytes - 1), 220);
      if (mode === "allocated") bytes.writeBigUInt64LE(BigInt(history.plan.virtualDiskBytes - 1), 228);
      if (mode === "reserve") bytes.writeBigUInt64LE(BigInt(history.plan.reservedDiskBytes + 1), 228);
      if (mode === "journal") bytes.writeBigUInt64LE(20480n, 236);
      if (mode === "journalAllocation") bytes.writeBigUInt64LE(21503n, 244);
      if (mode === "journalCeiling") bytes.writeBigUInt64LE(65537n, 244);
      if (mode === "unsafe") bytes.writeBigUInt64LE(9007199254740992n, 228);
      if (mode === "reserved") bytes[252] = 1;
      if (mode === "unknownFlag") bytes.writeUInt32LE(bytes.readUInt32LE(104) | 0x10000, 104);
      expect(() => read()).toThrow();
    });
  it("accepts all 20,000 declared objects within the native maximum", () => {
    const { bytes, read } = fixture(19996);
    expect(bytes.length).toBe(REMOTE_WORKER_RUNTIME_RESULT_MAX_BYTES); expect(read().inventory?.entries).toHaveLength(20000);
  });
  it.each([0, 8, 40, 72, 107, 108, 140, 184, 216, 220, 255, 256, 608, 640, 660])("refuses corrupted identity, framing or inventory at byte %s", offset => {
    const { bytes, read } = fixture(); bytes[offset] = bytes[offset]! ^ 0x80; expect(() => read()).toThrow();
  });
  it.each([1, 2, 4, 8, 32, 64, 128, 256, 512, 1024, 2048])("refuses missing verification flag %s for a complete inventory", flag => {
    const { bytes, read } = fixture(); bytes.writeUInt32LE(bytes.readUInt32LE(104) & ~flag, 104); expect(() => read()).toThrow();
  });
  it("requires the independently retained complete journal even for failure metadata", () => {
    const { bytes, read, history, expectation } = fixture();
    const failed = Buffer.from(bytes.subarray(0, 256)); failed.writeUInt32LE(1, 104); failed.fill(0, 184, 220); failed.writeUInt32LE(5, 108); failed.writeUInt32LE(5, 112);
    expect(read(failed).inventory).toBeNull(); expect(read(failed).end).toBe("control_failed"); expect(read(failed).error).toBe(5);
    expect(() => read(failed, expectation, { ...history, mountedWorkspaceRecords: [] })).toThrow();
    expect(() => read(failed, { ...expectation, checkpointSha256: "bb".repeat(32) })).toThrow();
    failed[184] = 1; expect(() => read(failed)).toThrow();
  });
  it.each(["cpu", "input", "output", "memory", "time", "capture", "count", "pid", "trailing", "short"])("refuses %s violations", mode => {
    const source = fixture(); let bytes = Buffer.from(source.bytes);
    if (mode === "cpu") bytes.writeUInt32LE(10001, 124);
    if (mode === "input") bytes.writeBigUInt64LE(101n, 160);
    if (mode === "output") bytes.writeBigUInt64LE(100000n, 168);
    if (mode === "memory") bytes.writeBigUInt64LE(9007199254740992n, 144);
    if (mode === "time") bytes.writeBigUInt64LE(9007199254740992n, 152);
    if (mode === "capture") bytes.writeUInt32LE(5, 136);
    if (mode === "count") bytes.writeUInt32LE(27, 216);
    if (mode === "pid") bytes.writeUInt32LE(0, 120);
    if (mode === "trailing") bytes = Buffer.concat([bytes, Buffer.alloc(1)]);
    if (mode === "short") bytes = bytes.subarray(0, 255);
    expect(() => source.read(bytes)).toThrow();
  });
  it("rejects oversized or noncanonical encoding before decoding", () => {
    const { bytes, expectation, history } = fixture();
    for (const value of [bytes, "0".repeat(2 * REMOTE_WORKER_RUNTIME_RESULT_MAX_BYTES + 2), bytes.toString("hex").toUpperCase(), bytes.toString("hex") + "0"])
      expect(() => readRemoteWorkerRuntimeResult(value, expectation, history)).toThrow();
  });
  it("snapshots the expectation without executing getters or accepting authority-shaped extras", () => {
    const { expectation } = fixture(); let reads = 0;
    const getter = { ...expectation, get requestSha256() { reads += 1; return expectation.requestSha256; } };
    for (const value of [getter, { ...expectation, approved: true }, { ...expectation, maxInputBytes: -1 },
      { ...expectation, maxOutputBytes: 67108865 }, { ...expectation, maxInventoryEntries: 20001 }, { ...expectation, nonce: "0".repeat(64) }])
      expect(() => normalizeRemoteWorkerRuntimeResultExpectation(value)).toThrow();
    expect(reads).toBe(0);
    const frozen = normalizeRemoteWorkerRuntimeResultExpectation(expectation); expectation.maxInputBytes = 1;
    expect(frozen.maxInputBytes).toBe(100); expect(Object.isFrozen(frozen)).toBe(true);
  });
});
