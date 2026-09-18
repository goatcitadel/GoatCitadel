import { describe, expect, it, vi } from "vitest";
import { normalizeRemoteWorkerCellCapacityExchange, readRemoteWorkerCellCapacityObservation,
  REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION, REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT } from "@goatcitadel/contracts";
import { mountedWorkspaceExchangeFixture } from "../../../packages/contracts/src/remote-worker-cell-mounted-workspace-test-fixture.js";
import { capacityObservationFixture } from "../../../packages/contracts/src/remote-worker-cell-capacity-test-fixture.js";
import { workerCellProvisioningFixture } from "./worker-cell-provisioning-test-fixture.js";
import { exchangeWorkerCellCapacity, projectWorkerCellCapacityResponse, observeAndRecordWorkerCellCapacityOnConnection } from "./worker-cell-capacity-client.js";
import { createInMemoryWorkerDurableState } from "./worker-durable-state.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import type { RouteContext } from "./connected-worker-routes.js";

vi.mock("./worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));
function fixture() {
  const native = workerCellProvisioningFixture(64);
  const history = mountedWorkspaceExchangeFixture({ ...native.exchange, records: native.records });
  const observation = readRemoteWorkerCellCapacityObservation(capacityObservationFixture(history).toString("hex"), history);
  const submission = { kind: "cell.capacity.observation" as const, expectedRevision: 0, observationHex: observation.observationHex,
    nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT };
  const result = normalizeRemoteWorkerCellCapacityExchange({ schemaVersion: REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION, history,
    record: { revision: 1, leaseRevision: history.leaseRevision, recordedAt: "2026-09-13T00:00:00.000Z",
      observationHex: submission.observationHex, nativeReceiptHex: submission.nativeReceiptHex } });
  return { lease: native.lease, history, observation, submission, result,
    body: { schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1", operation: "assignment.settlement.submit",
      disposition: "cell_capacity_recorded", registryWorkspaceId: history.registryWorkspaceId, cellCapacity: result } };
}
describe("worker capacity exchange client", () => {
  it("binds exact native receipts to the protected current lease without including its secret in idempotency", async () => {
    const f = fixture(), signal = new AbortController().signal;
    vi.mocked(callProtectedRoute).mockResolvedValueOnce({ status: 200, body: f.body });
    expect(await exchangeWorkerCellCapacity({ client: {}, credential: {} } as RouteContext, f.lease, f.submission, signal)).toEqual(f.result);
    const request = vi.mocked(callProtectedRoute).mock.calls.at(-1)![0];
    expect(request).toMatchObject({ signal, operation: "assignment.settlement.submit",
      rawPath: "/api/v1/remote-workers/assignment-settlement-submissions", payload: { ...f.lease, submission: f.submission } });
    expect(request.idempotencyKey).toMatch(/^cell-capacity:[0-9a-f]{64}$/u);
    expect(request.idempotencyKey).not.toContain(f.lease.leaseToken);
  });
  it("permits an empty current snapshot and replay under a renewed lease", () => {
    const f = fixture();
    expect(projectWorkerCellCapacityResponse({ ...f.body, disposition: "cell_capacity_snapshot",
      cellCapacity: { ...f.result, record: null } }, f.lease, { kind: "cell.capacity.snapshot" }).record).toBeNull();
    expect(projectWorkerCellCapacityResponse({ ...f.body, cellCapacity: { ...f.result, history: { ...f.history, leaseRevision: 3 } } },
      { ...f.lease, leaseRevision: 3 }, f.submission).record?.leaseRevision).toBe(2);
  });
  it("composes native observation, durable delivery and the RPC client across lease renewal", async () => {
    const f = fixture();
    let lease = { ...f.lease };
    vi.mocked(callProtectedRoute).mockImplementation(async (request) => {
      const payload = request.payload as { leaseRevision: number; submission: { kind: string } };
      const submitted = payload.submission.kind === "cell.capacity.observation";
      return { status: 200, body: { ...f.body, disposition: submitted ? "cell_capacity_recorded" : "cell_capacity_snapshot",
        cellCapacity: { ...f.result, history: { ...f.history, leaseRevision: payload.leaseRevision },
          record: submitted ? { ...f.result.record!, leaseRevision: payload.leaseRevision } : null } } };
    });
    const observe = vi.fn(async (_history, authorize: () => Promise<void>) => {
      lease = { ...lease, leaseRevision: 3 }; await authorize();
      return { ...f.observation, nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT };
    });
    const result = await observeAndRecordWorkerCellCapacityOnConnection({ scope: {
      registryWorkspaceId: lease.registryWorkspaceId, assignmentId: lease.assignmentId, assignmentGeneration: lease.assignmentGeneration },
      context: { client: {}, credential: {} } as RouteContext, currentLease: () => lease,
      state: createInMemoryWorkerDurableState(), signal: new AbortController().signal, assertCurrent: async () => undefined, observe });
    expect(result.record?.leaseRevision).toBe(3);
    expect(observe.mock.calls[0]![0].leaseRevision).toBe(2);
    expect(vi.mocked(callProtectedRoute).mock.calls.at(-1)![0].payload).toMatchObject({ leaseRevision: 3, submission: f.submission });
  });
  it.each(["scope", "assignment", "generation", "lease", "missing", "revision", "changed", "receipt", "history", "disposition"])(
    "rejects a %s response mismatch", (failure) => {
      const f = fixture(), body = structuredClone(f.body);
      if (failure === "scope") body.registryWorkspaceId = "foreign";
      if (failure === "disposition") body.disposition = "cell_capacity_snapshot";
      const result = { ...body.cellCapacity, history: { ...body.cellCapacity.history }, record: body.cellCapacity.record && { ...body.cellCapacity.record } };
      if (failure === "assignment") result.history.assignmentId = "foreign";
      if (failure === "generation") result.history.assignmentGeneration++;
      if (failure === "lease") result.history.leaseRevision++;
      if (failure === "missing") result.record = null;
      if (failure === "revision") result.record!.revision++;
      if (failure === "receipt") result.record!.nativeReceiptHex = "00".repeat(16);
      if (failure === "changed") { const bytes = Buffer.from(result.record!.observationHex, "hex"); bytes.writeBigUInt64LE(10000n, 328); result.record!.observationHex = bytes.toString("hex"); }
      if (failure === "history") result.history.mountedWorkspaceRecords = [];
      expect(() => projectWorkerCellCapacityResponse({ ...body, cellCapacity: result }, f.lease, f.submission)).toThrow();
    });
});
