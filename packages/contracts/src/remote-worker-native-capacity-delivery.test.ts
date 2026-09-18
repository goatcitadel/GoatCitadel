import { describe, expect, it } from "vitest";
import { canonicalJsonString } from "./canonical-json.js";
import { remoteWorkerCellCanonicalSha256 } from "./remote-worker-cell.js";
import { nativeCapacityCompositionFixture } from "./remote-worker-native-capacity-composition-test-fixture.js";
import { readRemoteWorkerNativeCapacityCapture } from "./remote-worker-native-capacity-capture.js";
import { createRemoteWorkerNativeCapacityDelivery, readRemoteWorkerNativeCapacityDelivery,
  REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES } from "./remote-worker-native-capacity-delivery.js";

function fixture() {
  const f = nativeCapacityCompositionFixture();
  const payload = canonicalJsonString({ layout: f.layout, window: f.window, source: f.source });
  const delivery = createRemoteWorkerNativeCapacityDelivery(payload, f.history, f.window.nonce);
  return { ...f, payload, delivery,
    read: (wire: unknown = delivery) => readRemoteWorkerNativeCapacityDelivery(JSON.stringify(wire), f.history, f.layout, f.window) };
}
describe("independent native capacity delivery verification", () => {
  it("reconstructs and freezes the retained source with the existing durable bundle identity", () => {
    const f = fixture(), result = f.read();
    expect(result).toEqual(f.delivery);
    expect(result.inventory).toEqual(f.compose());
    expect(result.bundleSha256).toBe(remoteWorkerCellCanonicalSha256({ schemaVersion: "goatcitadel.worker-native-capacity-delivery.v1",
      history: f.history, layout: f.layout, window: f.window, source: f.source }));
    expect(Object.isFrozen(result.source)).toBe(true);
    expect(Object.isFrozen(result.inventory.areas[0]!.objects)).toBe(true);
  });
  it.each(["history", "layout", "window", "source", "inventory", "inventoryBinding", "bundleSha256"] as const)("refuses substituted %s", field => {
    const f = fixture();
    expect(() => f.read({ ...f.delivery, [field]: null })).toThrow();
  });
  it("rejects a self-consistent new nonce when the independent capture is unchanged", () => {
    const f = fixture();
    const window = { ...f.window, nonce: "ef".repeat(32) };
    const source = { ...f.source, hostCaptureHex: f.source.hostCaptureHex.slice(0, 16) + window.nonce + f.source.hostCaptureHex.slice(80) };
    window.hostCaptureSha256 = readRemoteWorkerNativeCapacityCapture(source.hostCaptureHex, window.nonce, f.layout).captureSha256;
    const forged = createRemoteWorkerNativeCapacityDelivery(canonicalJsonString({ layout: f.layout, window, source }), f.history, window.nonce);
    expect(readRemoteWorkerNativeCapacityDelivery(JSON.stringify(forged), f.history, f.layout, window)).toEqual(forged);
    expect(() => f.read(forged)).toThrow(/independently retained capture/u);
  });
  it("requires the original capture lease even when the current lease has renewed", () => {
    const f = fixture(), newer = { ...f.history, leaseRevision: f.history.leaseRevision + 1 };
    const changed = createRemoteWorkerNativeCapacityDelivery(f.payload, newer, f.window.nonce);
    expect(changed.bundleSha256).not.toBe(f.delivery.bundleSha256);
    expect(() => f.read(changed)).toThrow(/independently retained capture/u);
    expect(() => readRemoteWorkerNativeCapacityDelivery(JSON.stringify(f.delivery), newer, f.layout, f.window)).toThrow(/independently retained capture/u);
  });
  it("does not accept a forged inventory accompanied by a forged inventory hash", () => {
    const f = fixture(), inventory = { ...f.delivery.inventory, references: [] };
    expect(() => f.read({ ...f.delivery, inventory, inventoryBinding: { ...f.delivery.inventoryBinding,
      inventorySha256: remoteWorkerCellCanonicalSha256(inventory) } })).toThrow(/independently retained capture/u);
  });
  it("rejects unknown envelope keys and missing bindings", () => {
    const f = fixture();
    expect(() => f.read({ ...f.delivery, approved: true })).toThrow(/independently retained capture/u);
    const { bundleSha256: _omitted, ...missing } = f.delivery;
    expect(() => f.read(missing)).toThrow(/independently retained capture/u);
  });
  it("applies the UTF-8 byte ceiling before parsing both ingress shapes", () => {
    const f = fixture(), oversized = '"' + "é".repeat(REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES / 2) + '"';
    expect(oversized.length).toBeLessThan(REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES);
    expect(() => readRemoteWorkerNativeCapacityDelivery(oversized, f.history, f.layout, f.window)).toThrow(/independently retained capture/u);
    expect(() => createRemoteWorkerNativeCapacityDelivery(oversized, f.history, f.window.nonce)).toThrow(/independently retained capture/u);
  });
  it("does not retain aliases to mutable caller evidence", () => {
    const f = fixture(), result = f.read();
    f.source.references.length = 0;
    f.window.nonce = "ee".repeat(32);
    expect(result.source).toEqual(f.delivery.source);
    expect(result.window.nonce).toBe(f.delivery.window.nonce);
  });
  it("rejects accessor bindings without executing them", () => {
    const f = fixture(); let invoked = false;
    const window = { ...f.window };
    Object.defineProperty(window, "nonce", { enumerable: true, get() { invoked = true; return f.window.nonce; } });
    expect(() => readRemoteWorkerNativeCapacityDelivery(JSON.stringify(f.delivery), f.history, f.layout, window)).toThrow(/independently retained capture/u);
    expect(invoked).toBe(false);
  });
});
