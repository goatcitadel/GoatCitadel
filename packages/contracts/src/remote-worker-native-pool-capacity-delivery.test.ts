import { describe, expect, it } from "vitest";
import { canonicalJsonString } from "./canonical-json.js";
import { nativePoolCapacityFixture } from "./remote-worker-native-pool-capacity-test-fixture.js";
import { remoteWorkerCellCanonicalSha256 } from "./remote-worker-cell.js";
import { REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES } from "./remote-worker-native-capacity-delivery.js";
import {
  createRemoteWorkerNativePoolCapacityDelivery,
  readRemoteWorkerNativePoolCapacityDelivery,
} from "./remote-worker-native-pool-capacity-delivery.js";

function fixture() {
  const f = nativePoolCapacityFixture();
  const payload = canonicalJsonString({ layout: f.layout, window: f.window, source: f.source });
  const delivery = createRemoteWorkerNativePoolCapacityDelivery(payload, f.pool, f.window.nonce);
  return {
    ...f,
    payload,
    delivery,
    read: (value: unknown = delivery) =>
      readRemoteWorkerNativePoolCapacityDelivery(JSON.stringify(value), f.pool, f.layout, f.window),
  };
}
describe("independently retained complete-pool delivery", () => {
  it.each([2, 64])(
    "round-trips %s members inside the unchanged byte limit",
    (count) => {
      const f = nativePoolCapacityFixture(count),
        payload = canonicalJsonString({ layout: f.layout, window: f.window, source: f.source });
      const delivery = createRemoteWorkerNativePoolCapacityDelivery(payload, f.pool, f.window.nonce),
        wire = JSON.stringify(delivery);
      expect(new TextEncoder().encode(wire).byteLength).toBeLessThan(
        REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES,
      );
      expect(readRemoteWorkerNativePoolCapacityDelivery(wire, f.pool, f.layout, f.window)).toEqual(delivery);
      expect(Object.isFrozen(delivery.source)).toBe(true);
      expect(Object.isFrozen(delivery.pool.members)).toBe(true);
      // Encoding and revalidating 64 independent members exceeded 90 seconds in CI.
    },
    180000,
  );
  it.each(["pool", "layout", "window", "source", "inventory", "inventoryBinding", "bundleSha256"] as const)(
    "refuses substituted %s",
    (key) => {
      const f = fixture();
      expect(() => f.read({ ...f.delivery, [key]: null })).toThrow();
    },
  );
  it("recomposes totals even when an attacker supplies matching forged inventory hashes", () => {
    const f = fixture(),
      inventory = { ...f.delivery.inventory, references: [] };
    expect(() =>
      f.read({
        ...f.delivery,
        inventory,
        inventoryBinding: {
          ...f.delivery.inventoryBinding,
          inventorySha256: remoteWorkerCellCanonicalSha256(inventory),
        },
      }),
    ).toThrow();
  });
  it("requires the original pool and window even when current lease authority has renewed", () => {
    const f = fixture();
    expect(() =>
      readRemoteWorkerNativePoolCapacityDelivery(
        JSON.stringify(f.delivery),
        { ...f.pool, leaseRevision: f.pool.leaseRevision + 1 },
        f.layout,
        f.window,
      ),
    ).toThrow();
    expect(() => createRemoteWorkerNativePoolCapacityDelivery(f.payload, f.pool, "aa".repeat(32))).toThrow();
  });
  it("rejects oversized UTF-8 ingress and accessor bindings", () => {
    const f = fixture(),
      oversized = '"' + "é".repeat(REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES / 2) + '"';
    expect(() => readRemoteWorkerNativePoolCapacityDelivery(oversized, f.pool, f.layout, f.window)).toThrow();
    expect(() => createRemoteWorkerNativePoolCapacityDelivery(oversized, f.pool, f.window.nonce)).toThrow();
    let calls = 0;
    const window = Object.defineProperty({ ...f.window }, "nonce", {
      enumerable: true,
      get() {
        calls++;
        return f.window.nonce;
      },
    });
    expect(() =>
      readRemoteWorkerNativePoolCapacityDelivery(JSON.stringify(f.delivery), f.pool, f.layout, window),
    ).toThrow();
    expect(calls).toBe(0);
  });
});
