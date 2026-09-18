import { beforeEach, describe, expect, it, vi } from "vitest";
import { objectInventoryFixture, objectInventoryHistoryFixture } from "../../../packages/contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import { REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT, REMOTE_WORKER_CELL_OBJECT_INVENTORY_PAGE_SCHEMA_VERSION,
  type RemoteWorkerCellObjectInventoryPage } from "@goatcitadel/contracts";
import { exchangeWorkerCellObjectInventoryPage, uploadWorkerCellObjectInventory } from "./worker-cell-object-inventory-client.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import type { RouteContext } from "./connected-worker-routes.js";
vi.mock("./worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));
const context = { client: {}, credential: {} } as RouteContext;
function fixture() {
  const history = objectInventoryHistoryFixture(), bytes = objectInventoryFixture(history, 19996);
  const lease = { registryWorkspaceId: history.registryWorkspaceId, assignmentId: history.assignmentId, assignmentGeneration: history.assignmentGeneration,
    leaseRevision: history.leaseRevision, leaseToken: "private-lease-fixture" };
  const submission = { kind: "cell.object_inventory.observation" as const, expectedRevision: 0, observationHex: bytes.summary.toString("hex"),
    nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT, chunkHex: bytes.chunks.map(chunk => chunk.toString("hex")) };
  const reply = (page: RemoteWorkerCellObjectInventoryPage, alreadyCommitted = false) => {
    const nextChunk = alreadyCommitted ? 1000 : page.startChunk + page.chunkHex.length, done = nextChunk === 1000;
    return { status: 200, body: { schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1", operation: "assignment.settlement.submit",
      disposition: "cell_object_inventory_page", registryWorkspaceId: history.registryWorkspaceId,
      cellObjectInventoryPage: { schemaVersion: REMOTE_WORKER_CELL_OBJECT_INVENTORY_PAGE_SCHEMA_VERSION, history,
        record: done ? { revision: 1, leaseRevision: history.leaseRevision, recordedAt: "2026-09-14T00:00:00.000Z",
          observationHex: page.observationHex, nativeReceiptHex: page.nativeReceiptHex } : null,
        accepted: { page, nextChunk, committedRevision: done ? 1 : null } } } };
  };
  return { history, lease, submission, reply };
}
describe("worker inventory page delivery", () => {
  beforeEach(() => { vi.mocked(callProtectedRoute).mockReset(); });
  it.each([false, true])("delivers every page with exact acknowledgement, including completed replay=%s", async replay => {
    const f = fixture(), original = { ...f.lease };
    vi.mocked(callProtectedRoute).mockImplementation(async input => {
      expect(input.operation).toBe("assignment.settlement.submit"); expect(input.rawPath).toBe("/api/v1/remote-workers/assignment-settlement-submissions");
      expect(Buffer.byteLength(JSON.stringify(input.payload))).toBeLessThan(256 * 1024);
      expect(input.idempotencyKey).not.toContain(original.leaseToken);
      expect(input.payload.assignmentId).toBe(original.assignmentId);
      f.lease.assignmentId = "caller-changed"; f.submission.chunkHex.fill("changed");
      return f.reply(input.payload.submission as RemoteWorkerCellObjectInventoryPage, replay);
    });
    const result = await uploadWorkerCellObjectInventory(context, f.lease, f.submission, f.history);
    expect(result.record?.revision).toBe(1); expect(callProtectedRoute).toHaveBeenCalledTimes(16);
    expect(vi.mocked(callProtectedRoute).mock.calls.map(([call]) => (call.payload.submission as RemoteWorkerCellObjectInventoryPage).startChunk))
      .toEqual(Array.from({ length: 16 }, (_, index) => index * 64));
    expect(new Set(vi.mocked(callProtectedRoute).mock.calls.map(([call]) => call.idempotencyKey)).size).toBe(16);
  });
  it.each(["scope", "lease", "bytes", "history", "operation", "lost", "cancel"])("stops delivery after %s response", async mode => {
    const f = fixture(), controller = new AbortController();
    vi.mocked(callProtectedRoute).mockImplementation(async input => {
      const result = f.reply(input.payload.submission as RemoteWorkerCellObjectInventoryPage);
      if (mode === "scope") result.body.registryWorkspaceId = "foreign";
      if (mode === "lease") result.body.cellObjectInventoryPage.history = { ...f.history, leaseRevision: f.history.leaseRevision + 1 };
      if (mode === "bytes") result.body.cellObjectInventoryPage.accepted.page = { ...result.body.cellObjectInventoryPage.accepted.page,
        chunkHex: [...result.body.cellObjectInventoryPage.accepted.page.chunkHex].reverse() };
      if (mode === "history") result.body.cellObjectInventoryPage.history = { ...f.history, mountedWorkspaceRecords: [] };
      if (mode === "operation") result.body.operation = "assignment.inference";
      if (mode === "lost") throw new Error("Controlled disconnect after page dispatch");
      if (mode === "cancel") controller.abort();
      return result;
    });
    await expect(uploadWorkerCellObjectInventory(context, f.lease, f.submission, f.history, controller.signal)).rejects.toThrow();
    expect(callProtectedRoute).toHaveBeenCalledTimes(1);
  });
  it("refuses incomplete, failed or cancelled captures before transport", async () => {
    const f = fixture();
    await expect(uploadWorkerCellObjectInventory(context, f.lease, { ...f.submission, chunkHex: f.submission.chunkHex.slice(0, 64) }, f.history)).rejects.toThrow();
    await expect(uploadWorkerCellObjectInventory(context, f.lease, { ...f.submission, nativeReceiptHex: "00".repeat(16) }, f.history)).rejects.toThrow();
    await expect(uploadWorkerCellObjectInventory(context, { ...f.lease, leaseRevision: f.lease.leaseRevision + 1 }, f.submission, f.history)).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(uploadWorkerCellObjectInventory(context, f.lease, f.submission, f.history, controller.signal)).rejects.toThrow();
    expect(callProtectedRoute).not.toHaveBeenCalled();
  });
  it("reads a protected metadata snapshot without exposing staged or complete chunks", async () => {
    const f = fixture();
    const value = { schemaVersion: REMOTE_WORKER_CELL_OBJECT_INVENTORY_PAGE_SCHEMA_VERSION, history: f.history, record: null, accepted: null };
    vi.mocked(callProtectedRoute).mockResolvedValueOnce({ status: 200, body: { schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1",
      operation: "assignment.settlement.submit", disposition: "cell_object_inventory_page", registryWorkspaceId: f.history.registryWorkspaceId, cellObjectInventoryPage: value } });
    await expect(exchangeWorkerCellObjectInventoryPage(context, f.lease, { kind: "cell.object_inventory.page_snapshot" })).resolves.toEqual(value);
  });
});
