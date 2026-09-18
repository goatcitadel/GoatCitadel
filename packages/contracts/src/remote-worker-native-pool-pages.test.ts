import { describe, expect, it } from "vitest";
import { remoteWorkerCellCanonicalSha256 } from "./remote-worker-cell.js";
import { objectInventoryHistoryFixture } from "./remote-worker-cell-object-inventory-test-fixture.js";
import { normalizeRemoteWorkerNativePoolSnapshot, REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION } from "./remote-worker-native-pool.js";
import { assembleRemoteWorkerNativePoolPages, createRemoteWorkerNativePoolPage, normalizeRemoteWorkerNativePoolPageSubmission,
  REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES } from "./remote-worker-native-pool-pages.js";

function fixture() {
  const { schemaVersion: _schema, registryWorkspaceId: _registry, assignmentId: _id, assignmentGeneration: _generation,
    leaseRevision: _revision, ...history } = objectInventoryHistoryFixture();
  const members = [{ assignmentId: "retained", assignmentGeneration: 1, workerGeneration: 1, cellId: "cell",
    profileSha256: history.plan.profileSha256, history }];
  const snapshot = normalizeRemoteWorkerNativePoolSnapshot({ schemaVersion: REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION,
    registryWorkspaceId: "registry", assignmentId: "active", assignmentGeneration: 2, leaseRevision: 1,
    workerId: "worker", workerGeneration: 1, members, membershipSha256: remoteWorkerCellCanonicalSha256(members) });
  const first = createRemoteWorkerNativePoolPage(snapshot, { kind: "cell.native_pool.page", offset: 0, snapshotSha256: null });
  const pages = [first];
  for (let offset = REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES; offset < first.byteLength; offset += REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES)
    pages.push(createRemoteWorkerNativePoolPage(snapshot, { kind: "cell.native_pool.page", offset, snapshotSha256: first.snapshotSha256 }));
  return { snapshot, pages };
}
describe("complete native pool page transport", () => {
  it("reassembles bounded pages only after exact complete snapshot verification", () => {
    const { snapshot, pages } = fixture();
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every(page => page.bytesHex.length <= 65536)).toBe(true);
    expect(assembleRemoteWorkerNativePoolPages(pages)).toEqual(snapshot);
  });
  it("rejects continuation after membership or lease changes", () => {
    const { snapshot, pages } = fixture();
    const request = { kind: "cell.native_pool.page" as const, offset: REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES, snapshotSha256: pages[0]!.snapshotSha256 };
    expect(() => createRemoteWorkerNativePoolPage({ ...snapshot, leaseRevision: 2 }, request)).toThrow();
    expect(() => createRemoteWorkerNativePoolPage({ ...snapshot, members: [], membershipSha256: remoteWorkerCellCanonicalSha256([]) }, request)).toThrow();
  });
  it("rejects missing, duplicated, shuffled, changed and mixed pages", () => {
    const { pages } = fixture();
    for (const input of [pages.slice(1), [...pages, pages[0]!], [...pages].reverse(),
      [{ ...pages[0]!, bytesHex: "00" + pages[0]!.bytesHex.slice(2) }, ...pages.slice(1)],
      [pages[0]!, ...pages.slice(1).map(page => ({ ...page, snapshotSha256: "a".repeat(64) }))]])
      expect(() => assembleRemoteWorkerNativePoolPages(input)).toThrow();
  });
  it("rejects unbound continuation, misalignment, injected scope and getters", () => {
    const request = { kind: "cell.native_pool.page", offset: 0, snapshotSha256: null };
    for (const patch of [{ offset: 32768 }, { offset: 1 }, { offset: -1 }, { workerId: "foreign" }, { approved: true }])
      expect(() => normalizeRemoteWorkerNativePoolPageSubmission({ ...request, ...patch })).toThrow();
    let invoked = false;
    expect(() => normalizeRemoteWorkerNativePoolPageSubmission({ ...request, get offset() { invoked = true; return 0; } })).toThrow();
    expect(invoked).toBe(false);
  });
});
