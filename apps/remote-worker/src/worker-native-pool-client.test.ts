import { describe, expect, it, vi } from "vitest";
import { createRemoteWorkerNativePoolPage, normalizeRemoteWorkerNativePoolSnapshot, remoteWorkerCellCanonicalSha256,
  createRemoteWorkerNativePoolCleanupPage, normalizeRemoteWorkerNativePoolCleanupSnapshot, REMOTE_WORKER_NATIVE_POOL_CLEANUP_SCHEMA_VERSION,
  type RemoteWorkerNativePoolSnapshot, type RemoteWorkerNativePoolCleanupPageSubmission,
  REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION, type RemoteWorkerNativePoolPageSubmission } from "@goatcitadel/contracts";
import { objectInventoryHistoryFixture } from "../../../packages/contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import { readWorkerNativePoolOnLease, readWorkerNativePoolCleanupOnLease } from "./worker-native-pool-client.js";
import type { RouteContext } from "./connected-worker-routes.js";
vi.mock("./worker-protected-route-client.js", () => ({ callProtectedRoute: vi.fn() }));

function fixture(cleanup: boolean) {
  const { schemaVersion: _schema, registryWorkspaceId: _registry, assignmentId: _assignment,
    assignmentGeneration: _generation, leaseRevision: _lease, ...history } = objectInventoryHistoryFixture();
  const members = [{ assignmentId: "old", assignmentGeneration: 1, workerGeneration: 1, cellId: "old-cell",
    profileSha256: history.plan.profileSha256, history }];
  const snapshot = normalizeRemoteWorkerNativePoolSnapshot({ schemaVersion: REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION,
    registryWorkspaceId: "registry", assignmentId: "active", assignmentGeneration: 2, leaseRevision: 3,
    workerId: "worker", workerGeneration: 2, members, membershipSha256: remoteWorkerCellCanonicalSha256(members) });
  const cleanupSnapshot = (pool: RemoteWorkerNativePoolSnapshot) => normalizeRemoteWorkerNativePoolCleanupSnapshot({
    schemaVersion: REMOTE_WORKER_NATIVE_POOL_CLEANUP_SCHEMA_VERSION, pool,
    members: pool.members.map(member => ({ registryWorkspaceId: pool.registryWorkspaceId, assignmentId: member.assignmentId,
      assignmentGeneration: member.assignmentGeneration, expectations: [], installation: null })) });
  const makePage = (pool: RemoteWorkerNativePoolSnapshot, submission: RemoteWorkerNativePoolPageSubmission | RemoteWorkerNativePoolCleanupPageSubmission) => cleanup
    ? createRemoteWorkerNativePoolCleanupPage(cleanupSnapshot(pool), submission as RemoteWorkerNativePoolCleanupPageSubmission)
    : createRemoteWorkerNativePoolPage(pool, submission as RemoteWorkerNativePoolPageSubmission);
  const stop = new AbortController();
  const input = { context: { client: {}, credential: { registryWorkspaceId: "registry", workerGeneration: 2 } } as RouteContext,
    lease: { registryWorkspaceId: "registry", assignmentId: "active", assignmentGeneration: 2, leaseRevision: 3, leaseToken: "retained-secret" },
    signal: stop.signal, assertCurrent: vi.fn(async () => undefined) };
  const settings = { mutate: (page: ReturnType<typeof createRemoteWorkerNativePoolPage>) => page,
    snapshot, cancel: false, foreignEnvelope: false, foreignDisposition: false };
  vi.mocked(callProtectedRoute).mockReset().mockImplementation(async request => {
    const payload = request.payload as { submission: RemoteWorkerNativePoolPageSubmission };
    const page = settings.mutate(makePage(settings.snapshot, payload.submission));
    if (settings.cancel) stop.abort();
    return { status: 200, body: { schemaVersion: "goatcitadel.remote-worker-assignment-execution-response.v1",
      operation: "assignment.settlement.submit", disposition: (cleanup !== settings.foreignDisposition) ? "native_pool_cleanup_page" : "native_pool_page",
      registryWorkspaceId: settings.foreignEnvelope ? "foreign" : "registry", nativePoolPage: page } };
  });
  return { input, settings, snapshot, stop, read: cleanup ? readWorkerNativePoolCleanupOnLease : readWorkerNativePoolOnLease,
    expected: cleanup ? cleanupSnapshot(snapshot) : snapshot,
    first: makePage(snapshot, { kind: cleanup ? "cell.native_pool.cleanup.page" : "cell.native_pool.page", offset: 0, snapshotSha256: null }) };
}
describe.each([false, true])("native pool acquisition on a stable lease (cleanup=%s)", cleanup => {
  it("returns only a complete assignment-bound snapshot and uses fresh read keys", async () => {
    const f = fixture(cleanup);
    expect(await f.read(f.input)).toEqual(f.expected);
    const calls = vi.mocked(callProtectedRoute).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    expect(f.input.assertCurrent).toHaveBeenCalledTimes(calls.length * 2 + 1);
    const firstKey = calls[0]![0].idempotencyKey, count = calls.length;
    expect(JSON.stringify(calls.map(([request]) => request.idempotencyKey))).not.toContain("retained-secret");
    await f.read(f.input);
    expect(calls[count]![0].idempotencyKey).not.toBe(firstKey);
  });
  it.each(["assignmentId", "assignmentGeneration", "leaseRevision", "workerGeneration"] as const)("rejects a complete foreign %s snapshot", async field => {
    const f = fixture(cleanup);
    f.settings.snapshot = { ...f.snapshot, [field]: field === "assignmentId" ? "foreign" : 99 };
    await expect(f.read(f.input)).rejects.toThrow(/current assignment/u);
  });
  it("rejects changed hashes, changed sizes, duplicate offsets, tampering and foreign envelopes", async () => {
    for (const mode of ["hash", "size", "offset", "bytes", "envelope", "disposition"]) {
      const f = fixture(cleanup); let count = 0;
      f.settings.foreignEnvelope = mode === "envelope";
      f.settings.foreignDisposition = mode === "disposition";
      f.settings.mutate = page => {
        count++;
        if (mode === "bytes") return { ...page, bytesHex: "00" + page.bytesHex.slice(2) };
        if (count === 1) return page;
        return mode === "hash" ? { ...page, snapshotSha256: "f".repeat(64) } : mode === "size" ? { ...page, byteLength: page.byteLength + 1 } :
          mode === "offset" ? { ...page, offset: 0 } : page;
      };
      await expect(f.read(f.input)).rejects.toThrow();
    }
  });
  it("withholds cancelled, expired and lost-response transfers", async () => {
    for (const mode of ["before", "after", "authority", "lost"]) {
      const f = fixture(cleanup);
      if (mode === "before") f.stop.abort();
      if (mode === "after") f.settings.cancel = true;
      if (mode === "authority") f.input.assertCurrent.mockRejectedValue(new Error("expired"));
      if (mode === "lost") vi.mocked(callProtectedRoute).mockRejectedValueOnce(new Error("lost response"));
      await expect(f.read(f.input)).rejects.toThrow();
      expect(callProtectedRoute).toHaveBeenCalledTimes(mode === "before" || mode === "authority" ? 0 : 1);
    }
  });
  it("withholds the result when authority is revoked between pages or at final publication", async () => {
    for (const stage of ["between", "final"]) {
      const f = fixture(cleanup);
      const first = f.first;
      const pageCount = Math.ceil(first.byteLength / 32768);
      let checks = 0;
      f.input.assertCurrent.mockImplementation(async () => {
        if (++checks === (stage === "between" ? 3 : pageCount * 2 + 1)) throw new Error("authority revoked");
      });
      await expect(f.read(f.input)).rejects.toThrow(/authority revoked/u);
      expect(callProtectedRoute).toHaveBeenCalledTimes(stage === "between" ? 1 : pageCount);
    }
  });
});
