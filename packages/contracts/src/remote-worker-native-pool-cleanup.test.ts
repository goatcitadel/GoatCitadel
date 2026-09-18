import { describe, expect, it } from "vitest";
import { objectInventoryHistoryFixture } from "./remote-worker-cell-object-inventory-test-fixture.js";
import { readRemoteWorkerCellProvisioningCheckpoint } from "./remote-worker-cell-provisioning.js";
import { remoteWorkerCellCanonicalSha256 } from "./remote-worker-cell.js";
import { REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION } from "./remote-worker-native-pool.js";
import { REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION } from "./remote-worker-runtime-install.js";
import { REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION } from "./remote-worker-runtime-bundle.js";
import { normalizeRemoteWorkerNativePoolCleanupSnapshot as normalize, REMOTE_WORKER_NATIVE_POOL_CLEANUP_SCHEMA_VERSION,
  type RemoteWorkerNativePoolCleanupSnapshot } from "./remote-worker-native-pool-cleanup.js";
import { createRemoteWorkerNativePoolCleanupPage as page, assembleRemoteWorkerNativePoolCleanupPages as assemble,
  assembleRemoteWorkerNativePoolPages, createRemoteWorkerNativePoolPage, normalizeRemoteWorkerNativePoolCleanupPageSubmission,
  REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES } from "./remote-worker-native-pool-pages.js";

function fixture(): RemoteWorkerNativePoolCleanupSnapshot {
  const { schemaVersion: _schema, registryWorkspaceId: _registry, assignmentId: _id, assignmentGeneration: _generation,
    leaseRevision: _lease, ...history } = objectInventoryHistoryFixture();
  const first = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]!);
  const head = history.mountedWorkspaceRecords![1]!.slice(-64);
  const members = [{ assignmentId: "old", assignmentGeneration: 1, workerGeneration: 1, cellId: "old-cell",
    profileSha256: history.plan.profileSha256, history }, { assignmentId: "pending", assignmentGeneration: 2,
    workerGeneration: 2, cellId: "pending-cell", profileSha256: history.plan.profileSha256, history: null }];
  return normalize({ schemaVersion: REMOTE_WORKER_NATIVE_POOL_CLEANUP_SCHEMA_VERSION,
    pool: { schemaVersion: REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION, registryWorkspaceId: "registry", assignmentId: "active",
      assignmentGeneration: 4, leaseRevision: 7, workerId: "worker", workerGeneration: 3,
      members, membershipSha256: remoteWorkerCellCanonicalSha256(members) },
    members: [{ registryWorkspaceId: "registry", assignmentId: "old", assignmentGeneration: 1,
      expectations: [{ nonce: "11".repeat(32), requestSha256: "22".repeat(32), checkpointSha256: head,
        runtimeBundleSha256: "33".repeat(32), maxInputBytes: 0, maxOutputBytes: 4096, maxInventoryEntries: 20 }],
      installation: { schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, nonce: "44".repeat(32),
        journalIdentityHex: first.journalIdentityHex, preparedSha256: first.recordSha256, checkpointSha256: head, packageSha256: "55".repeat(32),
        runtimeBundle: { schemaVersion: REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION, files: [
          { relativePath: "node.exe", bytes: 123, sha256: "66".repeat(32) },
          { relativePath: "worker-host-receipt.json", bytes: 456, sha256: "77".repeat(32) },
        ] } } }, { registryWorkspaceId: "registry", assignmentId: "pending", assignmentGeneration: 2, expectations: [], installation: null }] });
}
const request = { kind: "cell.native_pool.cleanup.page" as const, offset: 0, snapshotSha256: null };
function pages(value: RemoteWorkerNativePoolCleanupSnapshot) {
  const first = page(value, request), result = [first];
  for (let offset = REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES; offset < first.byteLength; offset += REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES)
    result.push(page(value, { ...request, offset, snapshotSha256: first.snapshotSha256 }));
  return result;
}
describe("complete native pool cleanup transport", () => {
  it("preserves old attempts and incomplete members without manufacturing live leases", () => {
    const value = fixture();
    expect(normalize(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(value.members[0]).not.toHaveProperty("leaseRevision");
    expect(value.pool.members[1]!.history).toBeNull();
    expect(Object.isFrozen(value.members[0]!.expectations[0])).toBe(true);
    expect(Object.isFrozen(value.members[0]!.installation!.runtimeBundle.files)).toBe(true);
  });
  it("rejects omitted, reordered, duplicate and foreign member coverage", () => {
    const value = fixture();
    for (const members of [[], value.members.slice(0, 1), [...value.members].reverse(), [value.members[0], value.members[0]],
      [{ ...value.members[0], registryWorkspaceId: "foreign" }, value.members[1]],
      [{ ...value.members[0], assignmentGeneration: 9 }, value.members[1]]]) expect(() => normalize({ ...value, members })).toThrow();
  });
  it("refuses changed histories, duplicate attempts and installations bound to another journal", () => {
    const value = fixture(), first = value.members[0]!;
    for (const patch of [
      { expectations: [{ ...first.expectations[0], checkpointSha256: "ee".repeat(32) }] },
      { expectations: [first.expectations[0], first.expectations[0]] },
      { installation: { ...first.installation, journalIdentityHex: "ee".repeat(24) } },
      { installation: { ...first.installation, preparedSha256: "ee".repeat(32) } },
      { installation: { ...first.installation, checkpointSha256: "ee".repeat(32) } },
      { leaseRevision: 7 },
    ]) expect(() => normalize({ ...value, members: [{ ...first, ...patch }, value.members[1]] })).toThrow();
    expect(() => normalize({ ...value, members: [first, { ...value.members[1], expectations: first.expectations }] })).toThrow();
    expect(() => normalize({ ...value, members: [first, { ...value.members[1], installation: first.installation }] })).toThrow();
  });
  it("rejects oversized, sparse and accessor-supplied arrays without invoking getters", () => {
    const value = fixture(), first = value.members[0]!;
    expect(() => normalize({ ...value, members: [{ ...first, expectations: Array(1001).fill(first.expectations[0]) }, value.members[1]] })).toThrow();
    expect(() => normalize({ ...value, members: new Array(2) })).toThrow();
    let invoked = false;
    const members = [...value.members];
    Object.defineProperty(members, "0", { enumerable: true, get: () => { invoked = true; return first; } });
    expect(() => normalize({ ...value, members })).toThrow(); expect(invoked).toBe(false);
  });
  it("reassembles bounded pages and keeps the previous pool format separate", () => {
    const value = fixture(), encoded = pages(value);
    expect(encoded.length).toBeGreaterThan(1);
    expect(encoded.every(item => item.bytesHex.length <= 65536)).toBe(true);
    expect(assemble(encoded)).toEqual(value);
    expect(() => assembleRemoteWorkerNativePoolPages(encoded)).toThrow();
    const old = createRemoteWorkerNativePoolPage(value.pool, { ...request, kind: "cell.native_pool.page" });
    expect(() => assemble([old, ...encoded.slice(1)])).toThrow();
    expect(() => normalizeRemoteWorkerNativePoolCleanupPageSubmission({ ...request, kind: "cell.native_pool.page" })).toThrow();
  });
  it("rejects missing, reordered, mixed and altered pages and changed continuation snapshots", () => {
    const value = fixture(), encoded = pages(value);
    for (const changed of [encoded.slice(1), encoded.slice(0, -1), [...encoded].reverse(),
      [{ ...encoded[0]!, bytesHex: `ff${encoded[0]!.bytesHex.slice(2)}` }, ...encoded.slice(1)],
      [encoded[0]!, { ...encoded[1]!, snapshotSha256: "ee".repeat(32) }, ...encoded.slice(2)]]) expect(() => assemble(changed)).toThrow();
    const changed = normalize({ ...value, members: [{ ...value.members[0], installation: null }, value.members[1]] });
    expect(() => page(changed, { ...request, offset: REMOTE_WORKER_NATIVE_POOL_PAGE_BYTES, snapshotSha256: encoded[0]!.snapshotSha256 })).toThrow();
  });
});
