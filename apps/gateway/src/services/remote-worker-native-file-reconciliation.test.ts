import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { RemoteWorkerNativeFileReconciliationSubmission } from "@goatcitadel/contracts";
import { runtimeResultPagesFixture } from "../../../../packages/contracts/src/remote-worker-runtime-result-pages-test-fixture.js";
import { createRemoteWorkerNativeFileReconciler, reconcileRemoteWorkerNativeFiles } from "./remote-worker-native-file-reconciliation.js";
import type { RemoteWorkerNativeArtifactSettlement } from "./remote-worker-native-artifact-settlement.js";
import { reconcileWorkerNativeFiles } from "../../../remote-worker/src/worker-native-file-reconciliation-client.js";
import { callProtectedRoute } from "../../../remote-worker/src/worker-protected-route-client.js";
import type { RouteContext } from "../../../remote-worker/src/connected-worker-routes.js";
vi.mock("../../../remote-worker/src/worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));
function fixture() {
  const f = runtimeResultPagesFixture(2), lookup = f.response(null, true), stop = new AbortController();
  const receipt = { receipt: { resultSha256: f.resultSha256 }, receiptSha256: "22".repeat(32) };
  const exchangePageForAssignment = vi.fn(async () => lookup), findForAssignment = vi.fn(async () => receipt as typeof receipt | undefined);
  const settlement = { receiptSha256: receipt.receiptSha256, manifestSha256: "33".repeat(32), uploadId: "native-upload" };
  const settle = vi.fn(async () => settlement);
  const owner = createRemoteWorkerNativeFileReconciler({ remoteWorkerRuntimeResults: { exchangePageForAssignment }, remoteWorkerNativeFileReceipts: { findForAssignment } } as unknown as AsyncStorage,
    { settle } as unknown as RemoteWorkerNativeArtifactSettlement);
  const lease = { registryWorkspaceId: lookup.registryWorkspaceId, assignmentId: lookup.assignmentId, assignmentGeneration: lookup.assignmentGeneration,
    leaseRevision: lookup.leaseRevision, leaseToken: "private-lease" };
  const authority = { ...lease, leaseTokenSha256: "99".repeat(32), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} } as never };
  const reply = async (submission: RemoteWorkerNativeFileReconciliationSubmission) => ({ status: 200, body: {
    schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1", operation: "assignment.settlement.submit", disposition: "native_file_reconciliation",
    registryWorkspaceId: lease.registryWorkspaceId, nativeFileReconciliation: await reconcileRemoteWorkerNativeFiles(owner, { ...authority, submission, signal: stop.signal }) } });
  return { ...f, lookup, receipt, settlement, stop, exchangePageForAssignment, findForAssignment, settle, owner, authority, lease, reply };
}
describe("protected native file reconciliation", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["complete", "partial", "missing-receipt", "wrong-receipt", "revoked", "cancelled"])("reconciles stored pages without replaying execution: %s", async mode => {
    const f = fixture(), complete = vi.fn(async () => {
      if (mode === "revoked") throw new Error("revoked");
      if (mode === "cancelled") f.stop.abort();
      return mode === "partial" ? null : mode === "wrong-receipt" ? { ...f.settlement, receiptSha256: "ff".repeat(32) } : f.settlement;
    });
    if (mode === "partial" || mode === "missing-receipt") f.findForAssignment.mockResolvedValue(undefined);
    const owner = createRemoteWorkerNativeFileReconciler({ remoteWorkerRuntimeResults: { exchangePageForAssignment: f.exchangePageForAssignment },
      remoteWorkerNativeFileReceipts: { findForAssignment: f.findForAssignment } } as unknown as AsyncStorage, { settle: f.settle }, { complete });
    const work = owner.reconcile({ ...f.authority, signal: f.stop.signal, submission: { kind: "runtime.files.reconcile",
      nonce: f.expectation.nonce, requestSha256: f.expectation.requestSha256, challenge: "11".repeat(32) } });
    if (mode === "complete" || mode === "partial") expect((await work).settlement).toEqual(mode === "complete" ? f.settlement : null);
    else await expect(work).rejects.toThrow();
    expect(complete).toHaveBeenCalledOnce(); expect(f.settle).not.toHaveBeenCalled();
  });
  it("connects the worker to canonical receipt settlement using a fresh challenge on every read", async () => {
    const f = fixture(); vi.mocked(callProtectedRoute).mockImplementation(input => f.reply(input.payload.submission as RemoteWorkerNativeFileReconciliationSubmission));
    for (let index = 0; index < 2; index++) {
      const result = await reconcileWorkerNativeFiles({} as RouteContext, f.lease, f.expectation, f.stop.signal);
      expect(result.settlement).toEqual(f.settlement); expect(result.lookup.record?.resultSha256).toBe(f.resultSha256);
      expect(JSON.stringify(result)).not.toContain("private-lease"); expect(JSON.stringify(result).length).toBeLessThan(2048);
    }
    expect(f.settle).toHaveBeenCalledTimes(2); expect(f.exchangePageForAssignment).toHaveBeenCalledTimes(4);
    expect(f.settle).toHaveBeenCalledWith(expect.objectContaining({ nonce: f.expectation.nonce, requestSha256: f.expectation.requestSha256, protectedAuthority: f.authority.protectedAuthority }));
    const calls = vi.mocked(callProtectedRoute).mock.calls;
    expect(calls[0]![0].idempotencyKey).not.toBe(calls[1]![0].idempotencyKey);
    expect(calls[0]![0].idempotencyKey).not.toContain(f.lease.leaseToken);
  });
  it.each(["result", "receipt"])("keeps missing %s pending without invoking artifact settlement", async missing => {
    const f = fixture(); if (missing === "result") f.exchangePageForAssignment.mockResolvedValue(f.response(null, false));
    else f.findForAssignment.mockResolvedValue(undefined);
    vi.mocked(callProtectedRoute).mockImplementation(input => f.reply(input.payload.submission as RemoteWorkerNativeFileReconciliationSubmission));
    expect((await reconcileWorkerNativeFiles({} as RouteContext, f.lease, f.expectation)).settlement).toBeNull();
    expect(f.settle).not.toHaveBeenCalled(); if (missing === "result") expect(f.findForAssignment).not.toHaveBeenCalled();
  });
  it.each(["receipt-result", "settled-receipt", "changed-result", "revoked", "corrupt-cas", "challenge", "scope", "lease", "generation", "operation", "extra", "cancel", "lost"])("refuses %s without retrying execution or transport", async mode => {
    const f = fixture();
    if (mode === "receipt-result") f.receipt.receipt.resultSha256 = "ff".repeat(32);
    if (mode === "settled-receipt") f.settlement.receiptSha256 = "ff".repeat(32);
    if (mode === "changed-result") f.exchangePageForAssignment.mockResolvedValueOnce(f.lookup).mockResolvedValue(f.response(null, false));
    if (mode === "revoked") f.findForAssignment.mockRejectedValue(new Error("revoked"));
    if (mode === "corrupt-cas") f.settle.mockRejectedValue(new Error("CAS integrity failure"));
    vi.mocked(callProtectedRoute).mockImplementation(async input => {
      if (mode === "lost") throw new Error("lost response");
      const response = await f.reply(input.payload.submission as RemoteWorkerNativeFileReconciliationSubmission), value = response.body.nativeFileReconciliation;
      if (mode === "challenge") response.body.nativeFileReconciliation = { ...value, challenge: "ff".repeat(32) };
      if (mode === "scope") response.body.nativeFileReconciliation = { ...value, lookup: { ...value.lookup, assignmentId: "foreign" } };
      if (mode === "lease") response.body.nativeFileReconciliation = { ...value, lookup: { ...value.lookup, leaseRevision: value.lookup.leaseRevision + 1 } };
      if (mode === "generation") response.body.nativeFileReconciliation = { ...value, lookup: { ...value.lookup, assignmentGeneration: 2 } };
      if (mode === "operation") response.body.operation = "assignment.inference";
      if (mode === "extra") response.body.nativeFileReconciliation = { ...value, completed: true } as never;
      if (mode === "cancel") f.stop.abort(); return response;
    });
    await expect(reconcileWorkerNativeFiles({} as RouteContext, f.lease, f.expectation, f.stop.signal)).rejects.toThrow();
    expect(callProtectedRoute).toHaveBeenCalledOnce();
  });
  it("does not invoke transport when already cancelled", async () => {
    const f = fixture(); f.stop.abort();
    await expect(reconcileWorkerNativeFiles({} as RouteContext, f.lease, f.expectation, f.stop.signal)).rejects.toThrow(); expect(callProtectedRoute).not.toHaveBeenCalled();
  });
});
