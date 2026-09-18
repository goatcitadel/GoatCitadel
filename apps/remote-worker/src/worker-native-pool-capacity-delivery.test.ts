import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonString, readRemoteWorkerNativePoolCapacityDelivery, remoteWorkerCellCanonicalSha256,
  type RemoteWorkerNativePoolCapacityDelivery } from "@goatcitadel/contracts";
import { nativePoolCapacityFixture } from "../../../packages/contracts/src/remote-worker-native-pool-capacity-test-fixture.js";
import { nativeCapacityCompositionFixture } from "../../../packages/contracts/src/remote-worker-native-capacity-composition-test-fixture.js";
import { deliverWorkerNativeCapacityInventory, deliverWorkerNativePoolCapacityInventory, type WorkerNativePoolCapacityDeliveryInput } from "./worker-native-capacity-delivery.js";
import { createFileWorkerDurableState, createInMemoryWorkerDurableState } from "./worker-durable-state.js";

function fixture() {
  const f = nativePoolCapacityFixture(), stop = new AbortController();
  const payload = canonicalJsonString({ layout: f.layout, window: f.window, source: f.source });
  const ack = (delivery: RemoteWorkerNativePoolCapacityDelivery) => ({ inventorySha256: delivery.inventoryBinding.inventorySha256,
    captureSha256: delivery.inventory.captureSha256, bundleSha256: delivery.bundleSha256, revision: 7 });
  const input = { pool: f.pool, captureNonce: f.window.nonce, state: createInMemoryWorkerDurableState(), signal: stop.signal,
    assertCurrent: vi.fn(async () => undefined), capture: vi.fn(async (_pool, authorize: () => Promise<void>) => { await authorize(); return payload; }),
    deliver: vi.fn<WorkerNativePoolCapacityDeliveryInput["deliver"]>(async delivery => ack(delivery)),
  } satisfies WorkerNativePoolCapacityDeliveryInput;
  const key = `native-pool-capacity-${remoteWorkerCellCanonicalSha256({ registryWorkspaceId: f.pool.registryWorkspaceId,
    assignmentId: f.pool.assignmentId, assignmentGeneration: f.pool.assignmentGeneration, nonce: f.window.nonce })}`;
  return { ...f, input, stop, payload, key, ack };
}
describe("durable full-pool delivery owner", () => {
  it("retains and independently verifies complete evidence before delivery, then reconfirms the receipt", async () => {
    const f = fixture();
    f.input.deliver.mockImplementation(async delivery => {
      expect(JSON.parse((await f.input.state.read(f.key))!).payloadJson).toBe(f.payload);
      expect(readRemoteWorkerNativePoolCapacityDelivery(JSON.stringify(delivery), f.pool, f.layout, f.window)).toEqual(delivery);
      return f.ack(delivery);
    });
    const first = await deliverWorkerNativePoolCapacityInventory(f.input);
    expect(await deliverWorkerNativePoolCapacityInventory(f.input)).toEqual(first);
    expect(f.input.capture).toHaveBeenCalledTimes(1); expect(f.input.deliver).toHaveBeenCalledTimes(2);
    expect(f.input.deliver.mock.calls[1]![2]).toEqual(first);
  }, 15000);
  it("reopens file-backed evidence after response loss and lease renewal without rescanning", async () => {
    const f = fixture(), root = await mkdtemp(join(tmpdir(), "gc-pool-delivery-"));
    f.input.state = createFileWorkerDurableState(root); f.input.deliver.mockRejectedValueOnce(new Error("response lost"));
    await expect(deliverWorkerNativePoolCapacityInventory(f.input)).rejects.toThrow(/response lost/u);
    f.input.state = createFileWorkerDurableState(root); f.input.pool = { ...f.pool, leaseRevision: f.pool.leaseRevision + 1 };
    await deliverWorkerNativePoolCapacityInventory(f.input);
    expect(f.input.capture).toHaveBeenCalledTimes(1);
    expect(f.input.deliver.mock.calls[0]![0]).toEqual(f.input.deliver.mock.calls[1]![0]);
    expect(f.input.assertCurrent).toHaveBeenLastCalledWith(f.input.pool);
  }, 15000);
  it("does not replace retained evidence when pool membership changes", async () => {
    const f = fixture(); f.input.deliver.mockRejectedValueOnce(new Error("offline"));
    await expect(deliverWorkerNativePoolCapacityInventory(f.input)).rejects.toThrow();
    const saved = await f.input.state.read(f.key), members = f.pool.members.slice(0, 1);
    f.input.pool = { ...f.pool, members, membershipSha256: remoteWorkerCellCanonicalSha256(members) };
    await expect(deliverWorkerNativePoolCapacityInventory(f.input)).rejects.toThrow();
    expect(await f.input.state.read(f.key)).toBe(saved); expect(f.input.capture).toHaveBeenCalledTimes(1); expect(f.input.deliver).toHaveBeenCalledTimes(1);
  });
  it.each(["write", "readback", "revoked", "cancelled"])("withholds delivery after %s failure", async mode => {
    const f = fixture(), state = f.input.state;
    if (mode === "write") f.input.state = { ...state, write: async () => { throw new Error("write failed"); } };
    if (mode === "readback") f.input.state = { ...state, write: async () => undefined };
    if (mode === "revoked") f.input.capture.mockImplementation(async () => { f.input.assertCurrent.mockRejectedValue(new Error("revoked")); return f.payload; });
    if (mode === "cancelled") f.input.capture.mockImplementation(async () => { f.stop.abort(); return f.payload; });
    await expect(deliverWorkerNativePoolCapacityInventory(f.input)).rejects.toThrow(); expect(f.input.deliver).not.toHaveBeenCalled();
  });
  it("rejects changed canonical receipts while preserving the original local record", async () => {
    const f = fixture(); await deliverWorkerNativePoolCapacityInventory(f.input); const saved = await f.input.state.read(f.key);
    f.input.deliver.mockImplementation(async delivery => ({ ...f.ack(delivery), revision: 8 }));
    await expect(deliverWorkerNativePoolCapacityInventory(f.input)).rejects.toThrow(/canonical receipt changed/u);
    expect(await f.input.state.read(f.key)).toBe(saved); expect(f.input.capture).toHaveBeenCalledTimes(1);
  });
  it("shares assignment exclusion with the existing single-member owner", async () => {
    const f = fixture(), legacy = nativeCapacityCompositionFixture();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.input.capture.mockImplementation(async () => { enter(); await gate; return f.payload; });
    const first = deliverWorkerNativePoolCapacityInventory(f.input); await entered;
    try {
      await expect(deliverWorkerNativeCapacityInventory({ history: legacy.history, captureNonce: legacy.window.nonce,
        state: f.input.state, signal: f.input.signal, assertCurrent: async () => undefined,
        capture: async () => { throw new Error("unexpected collection"); }, deliver: async () => { throw new Error("unexpected delivery"); } })).rejects.toThrow(/active delivery owner/u);
    } finally { release(); await first; }
  });
});
