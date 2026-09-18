import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonString, remoteWorkerCellCanonicalSha256, readRemoteWorkerNativeCapacityDelivery } from "@goatcitadel/contracts";
import { nativeCapacityCompositionFixture } from "../../../packages/contracts/src/remote-worker-native-capacity-composition-test-fixture.js";
import { deliverWorkerNativeCapacityInventory, type WorkerNativeCapacityDelivery, type WorkerNativeCapacityDeliveryInput } from "./worker-native-capacity-delivery.js";
import { createFileWorkerDurableState, createInMemoryWorkerDurableState } from "./worker-durable-state.js";

function fixture() {
  const f = nativeCapacityCompositionFixture();
  const payload = canonicalJsonString({ layout: f.layout, window: f.window, source: f.source });
  const ack = (delivery: WorkerNativeCapacityDelivery) => ({ inventorySha256: delivery.inventoryBinding.inventorySha256,
    captureSha256: delivery.inventory.captureSha256, bundleSha256: delivery.bundleSha256, revision: 7 });
  const input = { history: f.history, captureNonce: f.window.nonce, state: createInMemoryWorkerDurableState(), signal: new AbortController().signal,
    assertCurrent: vi.fn(async () => undefined),
    capture: vi.fn(async (_history, authorize: () => Promise<void>) => { await authorize(); return payload; }),
    deliver: vi.fn(async (delivery: WorkerNativeCapacityDelivery) => ack(delivery)),
  } satisfies WorkerNativeCapacityDeliveryInput;
  const key = `native-capacity-${remoteWorkerCellCanonicalSha256({ registryWorkspaceId: f.history.registryWorkspaceId,
    assignmentId: f.history.assignmentId, assignmentGeneration: f.history.assignmentGeneration, nonce: f.window.nonce })}`;
  return { input, key, ack, payload };
}
describe("retained composed native capacity delivery", () => {
  it("delivers source that independently verifies against the capture owner's retained bindings", async () => {
    const f = fixture(), retained = JSON.parse(f.payload);
    f.input.deliver.mockImplementation(async delivery => {
      const verified = readRemoteWorkerNativeCapacityDelivery(JSON.stringify(delivery), f.input.history, retained.layout, retained.window);
      expect(verified).toEqual(delivery);
      return f.ack(verified);
    });
    await deliverWorkerNativeCapacityInventory(f.input);
    expect(f.input.deliver).toHaveBeenCalledTimes(1);
  });
  it("retains the complete source bundle before delivery and reuses the exact acknowledgement", async () => {
    const f = fixture();
    f.input.deliver.mockImplementation(async delivery => {
      const saved = JSON.parse((await f.input.state.read(f.key))!);
      if (saved.receipt !== null) expect(saved.receipt).toEqual(f.ack(delivery));
      expect(saved.payloadJson).toBe(f.payload);
      expect(Object.isFrozen(delivery.source)).toBe(true); expect(Object.isFrozen(delivery.inventory.areas[0]?.objects)).toBe(true);
      return f.ack(delivery);
    });
    const first = await deliverWorkerNativeCapacityInventory(f.input);
    expect(await deliverWorkerNativeCapacityInventory(f.input)).toEqual(first);
    expect(f.input.capture).toHaveBeenCalledTimes(1); expect(f.input.deliver).toHaveBeenCalledTimes(2);
    expect(JSON.parse((await f.input.state.read(f.key))!).receipt).toEqual(first);
  });
  it("reopens actual file-backed pending evidence after response loss without collecting again", async () => {
    const f = fixture(), root = await mkdtemp(join(tmpdir(), "gc-native-capacity-delivery-"));
    f.input.state = createFileWorkerDurableState(root);
    let first = true;
    f.input.deliver.mockImplementation(async delivery => {
      if (first) { first = false; throw new Error("response lost after protected retention"); }
      return f.ack(delivery);
    });
    await expect(deliverWorkerNativeCapacityInventory(f.input)).rejects.toThrow(/response lost/u);
    f.input.state = createFileWorkerDurableState(root);
    const result = await deliverWorkerNativeCapacityInventory(f.input);
    expect(result.revision).toBe(7); expect(f.input.capture).toHaveBeenCalledTimes(1);
    expect(f.input.deliver.mock.calls[0]![0]).toEqual(f.input.deliver.mock.calls[1]![0]);
  });
  it("retries an acknowledgement write failure using retained source bytes", async () => {
    const f = fixture(), state = f.input.state; let writes = 0;
    f.input.state = { ...state, write: async (key, value) => { if (++writes === 2) throw new Error("ack write failed"); await state.write(key, value); } };
    await expect(deliverWorkerNativeCapacityInventory(f.input)).rejects.toThrow(/ack write failed/u);
    expect(JSON.parse((await state.read(f.key))!).receipt).toBeNull();
    await deliverWorkerNativeCapacityInventory(f.input);
    expect(f.input.capture).toHaveBeenCalledTimes(1); expect(f.input.deliver).toHaveBeenCalledTimes(2);
  });
  it("allows a renewed lease while preserving original capture history and bundle identity", async () => {
    const f = fixture(); f.input.deliver.mockRejectedValueOnce(new Error("offline"));
    await expect(deliverWorkerNativeCapacityInventory(f.input)).rejects.toThrow(/offline/u);
    f.input.history = { ...f.input.history, leaseRevision: f.input.history.leaseRevision + 1 };
    await deliverWorkerNativeCapacityInventory(f.input);
    expect(f.input.capture).toHaveBeenCalledTimes(1);
    expect(f.input.deliver.mock.calls[1]![0].bundleSha256).toBe(f.input.deliver.mock.calls[0]![0].bundleSha256);
    expect(f.input.assertCurrent).toHaveBeenLastCalledWith(f.input.history);
  });
  it.each(["bundleSha256", "inventorySha256", "captureSha256"] as const)("refuses an acknowledgement for another %s", field => {
    const f = fixture(); f.input.deliver.mockImplementation(async delivery => ({ ...f.ack(delivery), [field]: "ef".repeat(32) }));
    return expect(deliverWorkerNativeCapacityInventory(f.input)).rejects.toThrow(/retained capture/u);
  });
  it("refuses corrupt durable data without replacing it or taking another capture", async () => {
    const f = fixture(); await f.input.state.write(f.key, "{broken");
    await expect(deliverWorkerNativeCapacityInventory(f.input)).rejects.toThrow();
    expect(await f.input.state.read(f.key)).toBe("{broken"); expect(f.input.capture).not.toHaveBeenCalled(); expect(f.input.deliver).not.toHaveBeenCalled();
  });
  it("refuses delivery when the durable adapter does not retain the exact write", async () => {
    const f = fixture(); f.input.state = { ...f.input.state, write: async () => undefined };
    await expect(deliverWorkerNativeCapacityInventory(f.input)).rejects.toThrow(/readback differs/u);
    expect(f.input.deliver).not.toHaveBeenCalled();
  });
  it("preserves pending evidence when authority is revoked after the durable write", async () => {
    const f = fixture(), state = f.input.state; let revoked = false;
    f.input.assertCurrent.mockImplementation(async () => { if (revoked) throw new Error("revoked"); });
    f.input.state = { ...state, write: async (key, value) => { await state.write(key, value); revoked = true; } };
    await expect(deliverWorkerNativeCapacityInventory(f.input)).rejects.toThrow(/revoked/u);
    expect(JSON.parse((await state.read(f.key))!).receipt).toBeNull(); expect(f.input.deliver).not.toHaveBeenCalled();
  });
  it("serializes concurrent capture owners for the same assignment", async () => {
    const f = fixture(); let release!: () => void;
    f.input.capture.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return f.payload; });
    const first = deliverWorkerNativeCapacityInventory(f.input);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(deliverWorkerNativeCapacityInventory(f.input)).rejects.toThrow(/active delivery owner/u);
    release(); await first; expect(f.input.capture).toHaveBeenCalledTimes(1);
  });
  it("preserves pending evidence when cancellation follows remote retention", async () => {
    const f = fixture(), stop = new AbortController(); f.input.signal = stop.signal; let first = true;
    f.input.deliver.mockImplementation(async delivery => { if (first) { first = false; stop.abort(); } return f.ack(delivery); });
    await expect(deliverWorkerNativeCapacityInventory(f.input)).rejects.toThrow();
    expect(JSON.parse((await f.input.state.read(f.key))!).receipt).toBeNull();
    f.input.signal = new AbortController().signal; await deliverWorkerNativeCapacityInventory(f.input);
    expect(f.input.capture).toHaveBeenCalledTimes(1); expect(f.input.deliver).toHaveBeenCalledTimes(2);
  });
  it("fences escaped capture callbacks after the owning call has finished", async () => {
    const f = fixture(); let escaped!: () => Promise<void>;
    f.input.capture.mockImplementation(async (_history, authorize) => { escaped = authorize; return f.payload; });
    await deliverWorkerNativeCapacityInventory(f.input);
    await expect(escaped()).rejects.toThrow(/retained capture/u);
  });
  it("does not accept a changed saved acknowledgement or overwrite its evidence", async () => {
    const f = fixture(); await deliverWorkerNativeCapacityInventory(f.input);
    const saved = JSON.parse((await f.input.state.read(f.key))!); saved.receipt.bundleSha256 = "ee".repeat(32);
    const changed = JSON.stringify(saved); await f.input.state.write(f.key, changed);
    await expect(deliverWorkerNativeCapacityInventory(f.input)).rejects.toThrow(/retained capture/u);
    expect(await f.input.state.read(f.key)).toBe(changed); expect(f.input.capture).toHaveBeenCalledTimes(1); expect(f.input.deliver).toHaveBeenCalledTimes(1);
  });
  it("confirms a saved receipt remotely and refuses silent canonical revision changes", async () => {
    const f = fixture(); await deliverWorkerNativeCapacityInventory(f.input);
    const saved = await f.input.state.read(f.key);
    f.input.deliver.mockImplementation(async delivery => ({ ...f.ack(delivery), revision: 8 }));
    await expect(deliverWorkerNativeCapacityInventory(f.input)).rejects.toThrow(/canonical receipt changed/u);
    expect(await f.input.state.read(f.key)).toBe(saved); expect(f.input.capture).toHaveBeenCalledTimes(1);
  });
});
