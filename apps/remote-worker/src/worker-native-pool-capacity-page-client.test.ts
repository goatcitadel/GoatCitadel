import { describe, expect, it, vi } from "vitest";
import { canonicalJsonString, createRemoteWorkerNativePoolCapacityDelivery, REMOTE_WORKER_NATIVE_CAPACITY_PAGE_EXCHANGE_SCHEMA,
  type RemoteWorkerNativeCapacityPageSubmission } from "@goatcitadel/contracts";
import { nativePoolCapacityFixture } from "../../../packages/contracts/src/remote-worker-native-pool-capacity-test-fixture.js";
import { uploadWorkerNativeCapacityDelivery, deliverWorkerNativePoolCapacityOnConnection } from "./worker-native-capacity-page-client.js";
import { createInMemoryWorkerDurableState } from "./worker-durable-state.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import { sha256Utf8, type RouteContext, type LeaseBinding } from "./connected-worker-routes.js";
vi.mock("./worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));

function fixture() {
  const f = nativePoolCapacityFixture(2, 160);
  const delivery = createRemoteWorkerNativePoolCapacityDelivery(canonicalJsonString({ layout: f.layout, window: f.window, source: f.source }), f.pool, f.window.nonce);
  const json = canonicalJsonString(delivery), bytes = Buffer.from(json, "utf8"), controller = new AbortController();
  let lease: LeaseBinding = { registryWorkspaceId: f.pool.registryWorkspaceId, assignmentId: f.pool.assignmentId,
    assignmentGeneration: f.pool.assignmentGeneration, leaseRevision: f.pool.leaseRevision, leaseToken: "synthetic-test-lease" };
  let nextOffset = 0, lost = false;
  const record = { bundleSha256: delivery.bundleSha256, deliverySha256: sha256Utf8(json), captureSha256: delivery.inventoryBinding.captureSha256,
    inventorySha256: delivery.inventoryBinding.inventorySha256, byteLength: bytes.length, revision: 8, decision: "accept" as "accept" | "quarantine" };
  const settings = { loseFirstPage: false, renew: false, foreignScope: false, cancel: false, corruptReceipt: false };
  vi.mocked(callProtectedRoute).mockReset();
  vi.mocked(callProtectedRoute).mockImplementation(async request => {
    const payload = request.payload as unknown as LeaseBinding & { submission: RemoteWorkerNativeCapacityPageSubmission }, page = payload.submission;
    expect(Buffer.byteLength(JSON.stringify(request.payload))).toBeLessThan(80_000);
    expect(request.operation).toBe("assignment.settlement.submit");
    expect(request.rawPath).toBe("/api/v1/remote-workers/assignment-settlement-submissions");
    if (page.kind === "cell.native_capacity.page") {
      expect(page.offset).toBeLessThanOrEqual(nextOffset);
      expect(page.bytesHex).toBe(bytes.subarray(page.offset, page.offset + 32768).toString("hex"));
      nextOffset = Math.max(nextOffset, page.offset + page.bytesHex.length / 2);
      if (settings.renew) lease = { ...lease, leaseRevision: lease.leaseRevision + 1 };
      if (settings.foreignScope) lease = { ...lease, assignmentId: "foreign" };
      if (settings.cancel) controller.abort(new Error("capture delivery cancelled"));
      if (settings.loseFirstPage && !lost) { lost = true; throw new Error("response lost after page retention"); }
    }
    return { status: 200, body: { schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1",
      operation: "assignment.settlement.submit", disposition: "native_capacity_page", registryWorkspaceId: payload.registryWorkspaceId,
      nativeCapacityPage: { schemaVersion: REMOTE_WORKER_NATIVE_CAPACITY_PAGE_EXCHANGE_SCHEMA, registryWorkspaceId: payload.registryWorkspaceId,
        assignmentId: payload.assignmentId, assignmentGeneration: payload.assignmentGeneration, leaseRevision: payload.leaseRevision,
        nonce: page.nonce, bundleSha256: page.bundleSha256,
        record: nextOffset === bytes.length ? { ...record, ...(settings.corruptReceipt ? { captureSha256: "ab".repeat(32) } : {}) } : null,
        accepted: page.kind === "cell.native_capacity.lookup" ? null : { page, nextOffset } } } };
  });
  const input = { context: { client: {}, credential: {} } as RouteContext, currentLease: () => lease, delivery, signal: controller.signal };
  return { input, settings, record, bytes };
}
describe("protected native pool capacity page client", () => {
  it("composes the durable capture ledger with page retry and a confirmed quarantine decision", async () => {
    const f = fixture(); f.settings.loseFirstPage = true; f.record.decision = "quarantine";
    const delivery = f.input.delivery;
    const input = { context: f.input.context, currentLease: f.input.currentLease, signal: f.input.signal,
      pool: delivery.pool, captureNonce: delivery.window.nonce, state: createInMemoryWorkerDurableState(),
      assertCurrent: async () => undefined,
      capture: vi.fn(async () => canonicalJsonString({ layout: delivery.layout, window: delivery.window, source: delivery.source })) };
    await expect(deliverWorkerNativePoolCapacityOnConnection(input)).rejects.toThrow(/response lost/u);
    const result = await deliverWorkerNativePoolCapacityOnConnection(input);
    expect(result).toEqual({ receipt: { bundleSha256: f.record.bundleSha256, captureSha256: f.record.captureSha256,
      inventorySha256: f.record.inventorySha256, revision: f.record.revision }, decision: "quarantine" });
    expect(await deliverWorkerNativePoolCapacityOnConnection(input)).toEqual(result);
    expect(input.capture).toHaveBeenCalledTimes(1);
  });
  it("delivers a complete source in bounded pages and confirms retained replay with lookup", async () => {
    const f = fixture(); expect(f.bytes.length).toBeGreaterThan(65536);
    expect(await uploadWorkerNativeCapacityDelivery(f.input)).toEqual(f.record);
    const calls = vi.mocked(callProtectedRoute).mock.calls.length;
    expect(await uploadWorkerNativeCapacityDelivery(f.input)).toEqual(f.record);
    expect(callProtectedRoute).toHaveBeenCalledTimes(calls + 1);
  });
  it("replays exact retained source after a page response is lost", async () => {
    const f = fixture(); f.settings.loseFirstPage = true;
    await expect(uploadWorkerNativeCapacityDelivery(f.input)).rejects.toThrow(/response lost/u);
    expect(await uploadWorkerNativeCapacityDelivery(f.input)).toEqual(f.record);
    const pages = vi.mocked(callProtectedRoute).mock.calls.map(call => (call[0].payload as { submission: RemoteWorkerNativeCapacityPageSubmission }).submission)
      .filter(page => page.kind === "cell.native_capacity.page");
    expect(pages[0]).toEqual(pages[1]);
  });
  it("renews request authority without changing the original capture identity", async () => {
    const f = fixture(); f.settings.renew = true;
    expect(await uploadWorkerNativeCapacityDelivery(f.input)).toEqual(f.record);
    const calls = vi.mocked(callProtectedRoute).mock.calls;
    expect(calls.at(-1)![0].payload.leaseRevision).toBeGreaterThan(f.input.delivery.pool.leaseRevision);
  });
  it("keeps quarantine visible in a completed receipt", async () => {
    const f = fixture(); f.record.decision = "quarantine";
    expect((await uploadWorkerNativeCapacityDelivery(f.input)).decision).toBe("quarantine");
  });
  it.each(["foreignScope", "cancel", "corruptReceipt"] as const)("refuses %s without claiming successful delivery", async failure => {
    const f = fixture(); f.settings[failure] = true;
    await expect(uploadWorkerNativeCapacityDelivery(f.input)).rejects.toThrow();
    if (failure !== "corruptReceipt") expect(callProtectedRoute).toHaveBeenCalledTimes(2);
  });
});
