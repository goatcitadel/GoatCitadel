import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonString, createRemoteWorkerNativePoolCapacityDelivery, normalizeRemoteWorkerNativeCapacityLayout,
  remoteWorkerCellCanonicalSha256, REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
  REMOTE_WORKER_NATIVE_CAPACITY_PAGE_EXCHANGE_SCHEMA, type RemoteWorkerNativeCapacityPageSubmission,
  type RemoteWorkerNativePoolCapacityDelivery } from "@goatcitadel/contracts";
import { nativePoolCapacityFixture } from "../../../packages/contracts/src/remote-worker-native-pool-capacity-test-fixture.js";
import { createFileWorkerDurableState } from "./worker-durable-state.js";
import { workerLocalStateActivity } from "./worker-local-state-activity.js";
import { renewWorkerLeaseControl, readWorkerLeaseControl } from "./worker-lease-control.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import { readWorkerNativePoolOnLease } from "./worker-native-pool-client.js";
import { exchangeWorkerCellCapacity } from "./worker-cell-capacity-client.js";
import { exchangeWorkerCellProvisioning } from "./worker-cell-provisioning-client.js";
import { createWindowsWorkerCellProvisioning, readWindowsWorkerCellControllerCustody } from "./worker-windows-cell-provisioning.js";
import { observeWindowsWorkerAssignmentPoolCapacity } from "./worker-windows-assignment-pool-capacity.js";
import { sha256Utf8, type RouteContext } from "./connected-worker-routes.js";

vi.mock("./worker-lease-control.js", () => ({ renewWorkerLeaseControl: vi.fn(), readWorkerLeaseControl: vi.fn() }));
vi.mock("./worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));
vi.mock("./worker-native-pool-client.js", () => ({ readWorkerNativePoolOnLease: vi.fn(), readWorkerNativePoolCleanupOnLease: vi.fn() }));
vi.mock("./worker-cell-capacity-client.js", () => ({ exchangeWorkerCellCapacity: vi.fn() }));
vi.mock("./worker-cell-provisioning-client.js", () => ({ exchangeWorkerCellProvisioning: vi.fn() }));
vi.mock("./worker-windows-cell-provisioning.js", () => ({ createWindowsWorkerCellProvisioning: vi.fn(), readWindowsWorkerCellControllerCustody: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

async function fixture(phase: "ready" | "provisioning" = "ready") {
  const f = nativePoolCapacityFixture(2), stop = new AbortController();
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 0x31)]).toString("base64url");
  const reference = { kind: "windows_provisioner", keysetGeneration: 1, protectedStateSha256: "44".repeat(32),
    keysetReceiptSha256: "55".repeat(32), workerPublicKeySpkiBase64Url: spki };
  const context = { credential: { registryWorkspaceId: f.pool.registryWorkspaceId, protectedKey: reference },
    protectedKeys: { reference, admissionSignerSpkiBase64Url: spki, signPopV2: vi.fn(), signAdmissionEnvelope: vi.fn() } } as unknown as RouteContext;
  const lease = { registryWorkspaceId: f.pool.registryWorkspaceId, assignmentId: f.pool.assignmentId,
    assignmentGeneration: f.pool.assignmentGeneration, leaseRevision: f.pool.leaseRevision, leaseToken: "private-pool-lease" };
  const root = await mkdtemp(join(tmpdir(), "gc-assignment-pool-")), state = createFileWorkerDurableState(root), writes: string[] = [];
  const input = { context, lease, phase, signal: stop.signal, observed: {},
    owner: { renew: vi.fn(), remainingLeaseMs: () => 120000, workerSentThrough: () => 0 },
    state: { ...state, write: async (key: string, value: string) => { await state.write(key, value); writes.push(value); } },
    capture: { layout: normalizeRemoteWorkerNativeCapacityLayout(f.layout), captureNonce: f.window.nonce, referencesJson: canonicalJsonString(f.source.references) } };
  let revision = lease.leaseRevision, nextOffset = 0, lost = false;
  let captured: RemoteWorkerNativePoolCapacityDelivery | undefined;
  const status = { lostResponse: false, revokeAfterScan: false, changedPool: false, changeAfterScan: false,
    cancelUpload: false, missingExpectation: false, quarantine: false };
  vi.mocked(renewWorkerLeaseControl).mockImplementation(command => workerLocalStateActivity.mutation(async () => ({
    ...command, lease: { ...lease, leaseRevision: ++revision }, control: { status: 200, body: { disposition: "active" } } })));
  vi.mocked(readWorkerLeaseControl).mockResolvedValue({ status: 200, body: { disposition: "active" } });
  vi.mocked(readWorkerNativePoolOnLease).mockImplementation(async command => {
    await command.assertCurrent();
    return { ...f.pool, leaseRevision: command.lease.leaseRevision, ...(status.changedPool ? { workerId: "foreign" } : {}) };
  });
  const history = (currentRevision: number) => ({ schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
    registryWorkspaceId: f.pool.registryWorkspaceId, assignmentId: f.pool.assignmentId, assignmentGeneration: f.pool.assignmentGeneration,
    leaseRevision: currentRevision, ...f.pool.members.find(member => member.assignmentId === f.pool.assignmentId)!.history! });
  vi.mocked(exchangeWorkerCellCapacity).mockImplementation(async (_context, binding) => ({ history: history(binding.leaseRevision) }) as Awaited<ReturnType<typeof exchangeWorkerCellCapacity>>);
  vi.mocked(exchangeWorkerCellProvisioning).mockImplementation(async (_context, binding) => history(binding.leaseRevision));
  vi.mocked(readWindowsWorkerCellControllerCustody).mockImplementation(async options => {
    await options.assertCurrent(); return { parentPath: "F:\\controlled-pool-custody" } as Awaited<ReturnType<typeof readWindowsWorkerCellControllerCustody>>;
  });
  const native = vi.fn<ReturnType<typeof createWindowsWorkerCellProvisioning>["observePoolCapacity"]>(async (_history, request, authorize) =>
    workerLocalStateActivity.quiescent(async () => {
      const renewals = vi.mocked(renewWorkerLeaseControl).mock.calls.length;
      await authorize();
      expect(renewWorkerLeaseControl).toHaveBeenCalledTimes(renewals);
      expect(request.pool.leaseRevision).toBe(_history.leaseRevision);
      captured = createRemoteWorkerNativePoolCapacityDelivery(canonicalJsonString({ layout: request.layout,
        window: { ...f.window, poolSnapshotSha256: remoteWorkerCellCanonicalSha256(request.pool) }, source: f.source }), request.pool, request.captureNonce);
      if (status.revokeAfterScan) vi.mocked(readWorkerLeaseControl).mockRejectedValue(new Error("revoked after capture"));
      if (status.changeAfterScan) status.changedPool = true;
      return { delivery: captured, nativeReceiptHex: "00".repeat(16) };
    }, stop.signal));
  vi.mocked(createWindowsWorkerCellProvisioning).mockReturnValue({ observePoolCapacity: native } as unknown as ReturnType<typeof createWindowsWorkerCellProvisioning>);
  vi.mocked(callProtectedRoute).mockImplementation(async request => {
    expect(captured).toBeDefined();
    expect(writes.length).toBeGreaterThan(0);
    expect(JSON.parse(writes[0]!).receipt).toBeNull();
    if (status.missingExpectation) throw new Error("capture requires independently registered expectation");
    const page = request.payload.submission as RemoteWorkerNativeCapacityPageSubmission;
    const bytes = Buffer.from(canonicalJsonString(captured));
    if (page.kind === "cell.native_capacity.page") {
      expect(page.bytesHex).toBe(bytes.subarray(page.offset, page.offset + 32768).toString("hex"));
      nextOffset = Math.max(nextOffset, page.offset + page.bytesHex.length / 2);
      if (status.lostResponse && !lost) { lost = true; throw new Error("page response lost"); }
      if (status.cancelUpload) stop.abort();
    }
    return { status: 200, body: { schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1",
      operation: "assignment.settlement.submit", disposition: "native_capacity_page", registryWorkspaceId: lease.registryWorkspaceId,
      nativeCapacityPage: { schemaVersion: REMOTE_WORKER_NATIVE_CAPACITY_PAGE_EXCHANGE_SCHEMA,
        registryWorkspaceId: lease.registryWorkspaceId, assignmentId: lease.assignmentId, assignmentGeneration: lease.assignmentGeneration,
        leaseRevision: request.payload.leaseRevision, nonce: page.nonce, bundleSha256: page.bundleSha256,
        record: nextOffset === bytes.length ? { bundleSha256: captured!.bundleSha256, deliverySha256: sha256Utf8(bytes.toString("utf8")),
          captureSha256: captured!.inventoryBinding.captureSha256, inventorySha256: captured!.inventoryBinding.inventorySha256,
          byteLength: bytes.length, revision: 4, decision: status.quarantine ? "quarantine" : "accept" } : null,
        accepted: page.kind === "cell.native_capacity.lookup" ? null : { page, nextOffset } } } };
  });
  return { input, native, status, writes, root, captured: () => captured!, run: () => observeWindowsWorkerAssignmentPoolCapacity(input) };
}

describe.skipIf(process.platform !== "win32")("Windows assignment full-pool capture composition", () => {
  it.each(["ready", "provisioning"] as const)("retains under a stable lease then renews upload requests for %s", async phase => {
    const f = await fixture(phase), result = await f.run();
    expect(result.receipt.bundleSha256).toBe(f.captured().bundleSha256); expect(result.decision).toBe("accept");
    expect(f.native).toHaveBeenCalledOnce(); expect(f.writes).toHaveLength(2); expect(f.writes.join()).not.toContain("private-pool-lease");
    const revisions = vi.mocked(callProtectedRoute).mock.calls.map(call => Number(call[0].payload.leaseRevision));
    expect(revisions[0]).toBeGreaterThan(f.captured().pool.leaseRevision);
    expect(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!)).toBe(true);
    expect(phase === "ready" ? exchangeWorkerCellCapacity : exchangeWorkerCellProvisioning).toHaveBeenCalledOnce();
    expect(phase === "ready" ? exchangeWorkerCellProvisioning : exchangeWorkerCellCapacity).not.toHaveBeenCalled();
  }, 20000);
  it("reopens the captured source after response loss without another native scan", async () => {
    const f = await fixture(); f.status.lostResponse = true; f.status.quarantine = true;
    await expect(f.run()).rejects.toThrow(/response lost/u);
    f.input.state = createFileWorkerDurableState(f.root);
    const result = await f.run();
    expect(result.decision).toBe("quarantine"); expect(f.native).toHaveBeenCalledOnce();
    expect(await f.run()).toMatchObject({ receipt: result.receipt, decision: "quarantine" });
    expect(f.native).toHaveBeenCalledOnce();
  }, 20000);
  it.each(["native", "revoked", "membership"])("withholds local and remote evidence on %s failure", async mode => {
    const f = await fixture();
    if (mode === "native") f.native.mockRejectedValue(new Error("installed owner unavailable"));
    if (mode === "revoked") f.status.revokeAfterScan = true;
    if (mode === "membership") f.status.changeAfterScan = true;
    await expect(f.run()).rejects.toThrow(); expect(f.writes).toHaveLength(0); expect(callProtectedRoute).not.toHaveBeenCalled();
  }, 20000);
  it("retains capture but refuses upload without an independently registered Gateway expectation", async () => {
    const f = await fixture(); f.status.missingExpectation = true;
    await expect(f.run()).rejects.toThrow(/independently registered/u);
    expect(f.writes).toHaveLength(1); f.status.missingExpectation = false;
    await f.run(); expect(f.native).toHaveBeenCalledOnce();
  }, 20000);
  it("refuses changed capture bindings on replay", async () => {
    const f = await fixture(); await f.run(); const calls = vi.mocked(callProtectedRoute).mock.calls.length;
    f.input.capture.referencesJson = "[]";
    await expect(f.run()).rejects.toThrow(/retained bindings/u);
    expect(callProtectedRoute).toHaveBeenCalledTimes(calls); expect(f.native).toHaveBeenCalledOnce();
  }, 20000);
  it("preserves the source without a receipt when upload is cancelled", async () => {
    const f = await fixture(); f.status.cancelUpload = true;
    await expect(f.run()).rejects.toThrow(); expect(f.writes).toHaveLength(1);
    expect(JSON.parse(f.writes[0]!).receipt).toBeNull();
  }, 20000);
});
