import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeArtifactFixture } from "../../../../packages/contracts/src/remote-worker-native-artifact-test-fixture.js";
import type { RemoteWorkerNativeFileGrantSubmission } from "@goatcitadel/contracts";
import { authorizeRemoteWorkerNativeFile } from "./remote-worker-native-file-grant.js";
import { authorizeWorkerNativeFile } from "../../../remote-worker/src/worker-native-file-grant-client.js";
import { callProtectedRoute } from "../../../remote-worker/src/worker-protected-route-client.js";
import type { RouteContext } from "../../../remote-worker/src/connected-worker-routes.js";
vi.mock("../../../remote-worker/src/worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));
function fixture() {
  const f = nativeArtifactFixture(), selection = f.receipt.files[0]!.selection, stop = new AbortController();
  const lease = { registryWorkspaceId: selection.registryWorkspaceId, assignmentId: selection.assignmentId, assignmentGeneration: selection.assignmentGeneration,
    leaseRevision: 2, leaseToken: "private-lease" };
  const authority = { ...lease, leaseTokenSha256: "99".repeat(32), protectedAuthority: { credentialAuthority: {}, meshAdmission: {} } as never };
  const owner = { authorizeFile: vi.fn(async () => ({ selection, disclosure: f.receipt.disclosure })) };
  const reply = async (submission: RemoteWorkerNativeFileGrantSubmission) => ({ status: 200, body: {
    schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1", operation: "assignment.settlement.submit", disposition: "native_file_grant",
    registryWorkspaceId: lease.registryWorkspaceId, nativeFileGrant: await authorizeRemoteWorkerNativeFile(owner, { ...authority, submission, signal: stop.signal }) } });
  return { ...f, selection, stop, lease, authority, owner, reply };
}
describe("protected native file authorization", () => {
  beforeEach(() => vi.clearAllMocks());
  it("checks the exact selection and complete admitted plan afresh at each boundary", async () => {
    const f = fixture(); vi.mocked(callProtectedRoute).mockImplementation(input => f.reply(input.payload.submission as RemoteWorkerNativeFileGrantSubmission));
    for (let index = 0; index < 2; index++) await authorizeWorkerNativeFile({} as RouteContext, f.lease, f.selection, f.receipt.fileStaging, f.stop.signal);
    expect(f.owner.authorizeFile).toHaveBeenCalledTimes(2);
    expect(f.owner.authorizeFile).toHaveBeenCalledWith(expect.objectContaining({ selection: f.selection, fileStaging: f.receipt.fileStaging,
      leaseRevision: 2, protectedAuthority: f.authority.protectedAuthority }));
    const calls = vi.mocked(callProtectedRoute).mock.calls;
    expect(calls[0]![0].idempotencyKey).not.toBe(calls[1]![0].idempotencyKey);
    expect(calls[0]![0].idempotencyKey).not.toContain(f.lease.leaseToken);
    expect(Buffer.byteLength(JSON.stringify(calls[0]![0].payload))).toBeLessThan(4096);
  });
  it.each(["lease", "challenge", "selection", "disclosure", "scope", "operation", "extra", "cancelled", "lost", "revoked"])("refuses %s without a grant or automatic retry", async mode => {
    const f = fixture();
    if (mode === "revoked") f.owner.authorizeFile.mockRejectedValue(new Error("revoked"));
    if (mode === "selection") f.owner.authorizeFile.mockResolvedValue({ selection: { ...f.selection, fileIdentityHex: "0100000000000000" + "bb".repeat(16) }, disclosure: f.receipt.disclosure });
    if (mode === "disclosure") f.owner.authorizeFile.mockResolvedValue({ selection: f.selection, disclosure: { ...f.receipt.disclosure, nonce: "ff".repeat(32) } });
    vi.mocked(callProtectedRoute).mockImplementation(async input => {
      if (mode === "lost") throw new Error("lost");
      const response = await f.reply(input.payload.submission as RemoteWorkerNativeFileGrantSubmission), value = response.body.nativeFileGrant;
      if (mode === "lease") response.body.nativeFileGrant = { ...value, leaseRevision: 3 };
      if (mode === "challenge") response.body.nativeFileGrant = { ...value, submission: { ...value.submission, challenge: "ff".repeat(32) } };
      if (mode === "scope") response.body.registryWorkspaceId = "foreign";
      if (mode === "operation") response.body.operation = "assignment.inference";
      if (mode === "extra") response.body.nativeFileGrant = { ...value, approved: true } as never;
      if (mode === "cancelled") f.stop.abort(); return response;
    });
    await expect(authorizeWorkerNativeFile({} as RouteContext, f.lease, f.selection, f.receipt.fileStaging, f.stop.signal)).rejects.toThrow();
    expect(callProtectedRoute).toHaveBeenCalledOnce();
  });
  it("rejects foreign assignment selections before the owner or transport", async () => {
    const f = fixture(), selection = { ...f.selection, assignmentId: "foreign" };
    await expect(authorizeWorkerNativeFile({} as RouteContext, f.lease, selection, f.receipt.fileStaging, f.stop.signal)).rejects.toThrow();
    await expect(authorizeRemoteWorkerNativeFile(f.owner, { ...f.authority, submission: { kind: "runtime.file.authorize", selection,
      fileStaging: f.receipt.fileStaging, challenge: "11".repeat(32) } })).rejects.toThrow();
    expect(callProtectedRoute).not.toHaveBeenCalled(); expect(f.owner.authorizeFile).not.toHaveBeenCalled();
  });
  it("rejects unavailable authority and already-cancelled calls", async () => {
    const f = fixture(); f.stop.abort();
    await expect(authorizeWorkerNativeFile({} as RouteContext, f.lease, f.selection, f.receipt.fileStaging, f.stop.signal)).rejects.toThrow();
    await expect(authorizeRemoteWorkerNativeFile(undefined, { ...f.authority, submission: { kind: "runtime.file.authorize", selection: f.selection,
      fileStaging: f.receipt.fileStaging, challenge: "11".repeat(32) } })).rejects.toThrow(); expect(callProtectedRoute).not.toHaveBeenCalled();
  });
  it("times out a slow observation instead of retaining it for a later transfer", async () => {
    const deadline = new AbortController(), timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      const f = fixture(); vi.mocked(callProtectedRoute).mockImplementation(async input => {
        const response = await f.reply(input.payload.submission as RemoteWorkerNativeFileGrantSubmission);
        deadline.abort(new Error("deadline elapsed")); return response;
      });
      await expect(authorizeWorkerNativeFile({} as RouteContext, f.lease, f.selection, f.receipt.fileStaging, f.stop.signal)).rejects.toThrow();
      expect(timeout).toHaveBeenCalledWith(5000); expect(f.stop.signal.aborted).toBe(false);
    } finally { timeout.mockRestore(); }
  });
});
