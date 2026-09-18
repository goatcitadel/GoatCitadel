import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readRemoteWorkerCellCapacityObservation, readRemoteWorkerCellBackingCapacityObservation,
  REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT, REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_BACKING_CAPACITY_EXCHANGE_SCHEMA_VERSION, type RemoteWorkerCellCapacityRecord,
  type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";
import { objectInventoryHistoryFixture } from "../../../packages/contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import { capacityObservationFixture } from "../../../packages/contracts/src/remote-worker-cell-capacity-test-fixture.js";
import { backingCapacityObservationFixture } from "../../../packages/contracts/src/remote-worker-cell-backing-capacity-test-fixture.js";
import { createFileWorkerDurableState } from "./worker-durable-state.js";
import { workerLocalStateActivity } from "./worker-local-state-activity.js";
import { renewWorkerLeaseControl, readWorkerLeaseControl } from "./worker-lease-control.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import { createWindowsWorkerCellProvisioning, readWindowsWorkerCellControllerCustody } from "./worker-windows-cell-provisioning.js";
import { observeWindowsWorkerAssignmentCapacity, observeWindowsWorkerAssignmentBackingCapacity } from "./worker-windows-assignment-capacity.js";
import type { RouteContext } from "./connected-worker-routes.js";

vi.mock("./worker-lease-control.js", () => ({ renewWorkerLeaseControl: vi.fn(), readWorkerLeaseControl: vi.fn() }));
vi.mock("./worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));
vi.mock("./worker-windows-cell-provisioning.js", () => ({ createWindowsWorkerCellProvisioning: vi.fn(), readWindowsWorkerCellControllerCustody: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

async function fixture(backing: boolean) {
  const history = objectInventoryHistoryFixture();
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 0x31)]).toString("base64url");
  const reference = { kind: "windows_provisioner", keysetGeneration: 1, protectedStateSha256: "4".repeat(64),
    keysetReceiptSha256: "5".repeat(64), workerPublicKeySpkiBase64Url: spki };
  const context = { credential: { registryWorkspaceId: history.registryWorkspaceId, protectedKey: reference },
    protectedKeys: { reference, admissionSignerSpkiBase64Url: spki, signPopV2: vi.fn(), signAdmissionEnvelope: vi.fn() } } as unknown as RouteContext;
  const lease = { registryWorkspaceId: history.registryWorkspaceId, assignmentId: history.assignmentId,
    assignmentGeneration: history.assignmentGeneration, leaseRevision: history.leaseRevision, leaseToken: "private-lease" };
  let revision = lease.leaseRevision;
  vi.mocked(renewWorkerLeaseControl).mockImplementation(input => workerLocalStateActivity.mutation(async () => ({
    ...input, lease: { ...lease, leaseRevision: ++revision }, control: { status: 200, body: { disposition: "active" } } })));
  vi.mocked(readWorkerLeaseControl).mockResolvedValue({ status: 200, body: { disposition: "active" } });
  const state = createFileWorkerDurableState(await mkdtemp(join(tmpdir(), "gc-installed-capacity-"))), writes: string[] = [];
  const stop = new AbortController();
  const input = { context, lease, signal: stop.signal, observed: {},
    owner: { renew: vi.fn(), remainingLeaseMs: () => 120000, workerSentThrough: () => 0 },
    state: { ...state, write: async (key: string, value: string) => { await state.write(key, value); writes.push(value); } } };
  const status = { record: null as RemoteWorkerCellCapacityRecord | null, loseResponse: false, revokeAfterScan: false };
  vi.mocked(readWindowsWorkerCellControllerCustody).mockImplementation(async options => {
    await options.assertCurrent(); return { parentPath: "F:\\controlled-custody" } as Awaited<ReturnType<typeof readWindowsWorkerCellControllerCustody>>;
  });
  const native = vi.fn(async (current: RemoteWorkerCellProvisioningExchange, authorize: () => Promise<void>) =>
    workerLocalStateActivity.quiescent(async () => {
      const options = vi.mocked(createWindowsWorkerCellProvisioning).mock.calls.at(-1)![0];
      const renewals = vi.mocked(renewWorkerLeaseControl).mock.calls.length;
      await options.assertCurrent(); await authorize(); await options.assertCurrent();
      expect(renewWorkerLeaseControl).toHaveBeenCalledTimes(renewals);
      if (status.revokeAfterScan) vi.mocked(readWorkerLeaseControl).mockRejectedValue(new Error("revoked after scan"));
      const bytes = (backing ? backingCapacityObservationFixture : capacityObservationFixture)(current).toString("hex");
      return { ...(backing ? readRemoteWorkerCellBackingCapacityObservation : readRemoteWorkerCellCapacityObservation)(bytes, current),
        nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT };
    }, stop.signal));
  vi.mocked(createWindowsWorkerCellProvisioning).mockReturnValue({ observeCapacity: native, observeBackingCapacity: native } as unknown as ReturnType<typeof createWindowsWorkerCellProvisioning>);
  vi.mocked(callProtectedRoute).mockImplementation(async call => {
    const submission = call.payload.submission as { kind: string; expectedRevision: number; observationHex: string; nativeReceiptHex: string };
    const recording = submission.kind.endsWith(".observation");
    if (recording) {
      expect(JSON.parse(writes.at(-1)!).submission).toEqual(submission);
      status.record = { revision: submission.expectedRevision + 1, leaseRevision: Number(call.payload.leaseRevision),
        recordedAt: "2026-09-16T00:00:00.000Z", observationHex: submission.observationHex, nativeReceiptHex: submission.nativeReceiptHex };
      if (status.loseResponse) { status.loseResponse = false; throw new Error("lost response"); }
    }
    return { status: 200, body: { schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1", operation: "assignment.settlement.submit",
      disposition: `${backing ? "cell_backing_capacity" : "cell_capacity"}_${recording ? "recorded" : "snapshot"}`,
      registryWorkspaceId: history.registryWorkspaceId, [backing ? "cellBackingCapacity" : "cellCapacity"]: {
        schemaVersion: backing ? REMOTE_WORKER_CELL_BACKING_CAPACITY_EXCHANGE_SCHEMA_VERSION : REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION,
        history: { ...history, leaseRevision: call.payload.leaseRevision }, record: status.record } } };
  });
  return { input, native, status, writes, run: () => (backing ? observeWindowsWorkerAssignmentBackingCapacity : observeWindowsWorkerAssignmentCapacity)(input) };
}

describe.skipIf(process.platform !== "win32").each([false, true])("installed capacity composition (backing=%s)", backing => {
  it("uses stable read checks and persists evidence after native exclusion", async () => {
    const f = await fixture(backing), result = await f.run();
    expect(result.record?.revision).toBe(1); expect(f.native).toHaveBeenCalledOnce();
    expect(f.writes).toHaveLength(2); expect(f.writes.join()).not.toContain("private-lease");
    expect(vi.mocked(createWindowsWorkerCellProvisioning).mock.calls[0]![0]).toMatchObject({ controllerService: true, parentPath: "F:\\controlled-custody" });
  });
  it("replays retained delivery after response loss without measuring again", async () => {
    const f = await fixture(backing); f.status.loseResponse = true;
    await expect(f.run()).rejects.toThrow("lost response");
    expect((await f.run()).record?.revision).toBe(1); expect(f.native).toHaveBeenCalledOnce();
  });
  it.each(["native", "revoked"])("withholds evidence on %s failure", async mode => {
    const f = await fixture(backing);
    if (mode === "native") f.native.mockRejectedValue(new Error("native owner absent"));
    else f.status.revokeAfterScan = true;
    await expect(f.run()).rejects.toThrow(); expect(f.writes).toHaveLength(0); expect(f.status.record).toBeNull();
  });
});
