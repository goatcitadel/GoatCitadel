import { describe, expect, it } from "vitest";
import { nativePoolCapacityResponseFixture } from "./remote-worker-native-pool-capacity-response-test-fixture.js";
import { createRemoteWorkerNativePoolCapacityDelivery } from "./remote-worker-native-pool-capacity-delivery.js";
import {
  captureRemoteWorkerNativePoolCapacityResponse,
  readRemoteWorkerNativePoolCapacityResponse,
  REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES,
} from "./remote-worker-native-pool-capacity-response.js";

function fixture() {
  const f = nativePoolCapacityResponseFixture(),
    { bytes, memberOffset } = f;
  const read = (input: unknown = bytes.toString("hex")) =>
    readRemoteWorkerNativePoolCapacityResponse(input, f.pool, f.layout, f.window, f.source.references);
  return { ...f, bytes, memberOffset, read };
}
describe("complete native pool response", () => {
  it("derives a local capture window matching independently retained fixture evidence", () => {
    const f = fixture();
    expect(
      captureRemoteWorkerNativePoolCapacityResponse(
        f.bytes.toString("hex"),
        f.pool,
        f.layout,
        f.window.nonce,
        f.source.references,
      ),
    ).toEqual(f.read());
  }, 15000);
  it.each(["nonce", "pool", "references"])("local capture cannot replace independent %s bindings", (kind) => {
    const f = fixture();
    expect(() =>
      captureRemoteWorkerNativePoolCapacityResponse(
        f.bytes.toString("hex"),
        kind === "pool" ? { ...f.pool, leaseRevision: f.pool.leaseRevision + 1 } : f.pool,
        f.layout,
        kind === "nonce" ? "ab".repeat(32) : f.window.nonce,
        kind === "references"
          ? [{ referenceSha256: "cd".repeat(32), objectIdentitySha256: "ef".repeat(32) }]
          : f.source.references,
      ),
    ).toThrow();
  });
  it("preserves all evidence in the independently reconstructed delivery", () => {
    const f = fixture();
    expect(f.read()).toEqual(
      createRemoteWorkerNativePoolCapacityDelivery(
        JSON.stringify({ layout: f.layout, window: f.window, source: f.source }),
        f.pool,
        f.window.nonce,
      ),
    );
  }, 15000);
  it.each([0, 8, 12, 16, 20, 24, 56, 88, 472])("rejects altered header/layout/host bytes at %i", (offset) => {
    const f = fixture(),
      bytes = Buffer.from(f.bytes);
    bytes[offset] = bytes[offset]! ^ 1;
    expect(() => f.read(bytes.toString("hex"))).toThrow();
  });
  it.each([0, 1, 88, 472])("rejects truncation at %i", (length) => {
    const f = fixture();
    expect(() => f.read(f.bytes.subarray(0, length).toString("hex"))).toThrow();
  });
  it("rejects truncated final chunks and trailing bytes", () => {
    const f = fixture();
    expect(() => f.read(f.bytes.subarray(0, -1).toString("hex"))).toThrow();
    expect(() => f.read(f.bytes.toString("hex") + "00")).toThrow();
  });
  it.each([0, 1064, 0xffffffff])("refuses chunk count %i before allocation", (count) => {
    const f = fixture(),
      bytes = Buffer.from(f.bytes);
    bytes.writeUInt32LE(count, f.memberOffset + 4);
    expect(() => f.read(bytes.toString("hex"))).toThrow();
  });
  it("rejects member ordinal, guest and backing substitutions", () => {
    const f = fixture();
    for (const offset of [
      f.memberOffset,
      f.memberOffset + 8,
      f.memberOffset + 8 + 352,
      f.memberOffset + 8 + 352 + 424,
    ]) {
      const bytes = Buffer.from(f.bytes);
      bytes[offset] = bytes[offset]! ^ 1;
      expect(() => f.read(bytes.toString("hex"))).toThrow();
    }
    // Each substitution reconstructs the independent capacity evidence under coverage.
  }, 30_000);
  it("requires independent layout, window and references", () => {
    const f = fixture(),
      hex = f.bytes.toString("hex");
    expect(() =>
      readRemoteWorkerNativePoolCapacityResponse(
        hex,
        f.pool,
        { ...f.layout, profileSha256: "aa".repeat(32) },
        f.window,
        f.source.references,
      ),
    ).toThrow();
    expect(() =>
      readRemoteWorkerNativePoolCapacityResponse(
        hex,
        f.pool,
        f.layout,
        { ...f.window, nonce: "ab".repeat(32) },
        f.source.references,
      ),
    ).toThrow();
    expect(() => readRemoteWorkerNativePoolCapacityResponse(hex, f.pool, f.layout, f.window, [])).toThrow();
  });
  it("bounds and validates the complete encoding before inspecting retained inputs", () => {
    const read = (input: unknown) =>
      readRemoteWorkerNativePoolCapacityResponse(input, null as never, null, null as never, null);
    for (const input of [
      null,
      {},
      "gg".repeat(1312),
      "00".repeat(REMOTE_WORKER_NATIVE_POOL_CAPACITY_RESPONSE_MAXIMUM_BYTES + 1),
      "0".repeat(2625),
    ])
      expect(() => read(input)).toThrow(/complete independently retained capture/u);
  });
});
