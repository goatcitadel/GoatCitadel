import { describe, expect, it } from "vitest";
import { canonicalJsonString } from "./canonical-json.js";
import { sha256Hex as sha256Utf8 } from "./sha256.js";
import { objectInventoryHistoryFixture } from "./remote-worker-cell-object-inventory-test-fixture.js";
import { normalizeRemoteWorkerCellProvisioningHistory } from "./remote-worker-cell-provisioning.js";
import { normalizeRemoteWorkerNativePoolSnapshot, REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION } from "./remote-worker-native-pool.js";

function fixture() {
  const exchange = objectInventoryHistoryFixture();
  const { schemaVersion: _schema, registryWorkspaceId: _registry, assignmentId: _assignment,
    assignmentGeneration: _generation, leaseRevision: _lease, ...history } = exchange;
  const members = [{ assignmentId: "old-assignment", assignmentGeneration: 1, workerGeneration: 1,
    cellId: "old-cell", profileSha256: history.plan.profileSha256, history }];
  return { schemaVersion: REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION, registryWorkspaceId: "registry",
    assignmentId: "current-assignment", assignmentGeneration: 3, leaseRevision: 7, workerId: "worker", workerGeneration: 2,
    members, membershipSha256: sha256Utf8(canonicalJsonString(members)) };
}
describe("retained native pool transport", () => {
  it("carries complete historical checkpoints independently of the active request lease", () => {
    const result = normalizeRemoteWorkerNativePoolSnapshot(fixture());
    expect(result.assignmentId).toBe("current-assignment");
    expect(result.members[0]!.assignmentId).toBe("old-assignment");
    expect(result.members[0]!.history!.mountedWorkspaceRecords).toHaveLength(2);
    expect(result.members[0]!.history).not.toHaveProperty("leaseRevision");
    expect(Object.isFrozen(result.members[0]!.history!.records)).toBe(true);
    expect(normalizeRemoteWorkerNativePoolSnapshot(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });
  it("preserves missing history and accepts a complete empty list", () => {
    const value = fixture();
    const members = [{ ...value.members[0]!, history: null }];
    expect(normalizeRemoteWorkerNativePoolSnapshot({ ...value, members,
      membershipSha256: sha256Utf8(canonicalJsonString(members)) }).members[0]!.history).toBeNull();
    expect(normalizeRemoteWorkerNativePoolSnapshot({ ...value, members: [],
      membershipSha256: sha256Utf8(canonicalJsonString([])) }).members).toEqual([]);
  });
  it("rejects altered checkpoint bytes and injected lease/owner fields in standalone history", () => {
    const history = fixture().members[0]!.history;
    for (const patch of [{ leaseRevision: 1 }, { provisioningOwner: "worker" }, { planSha256: "0".repeat(64) },
      { records: ["00".repeat(1024)] }, { mountedWorkspaceRecords: [...history.mountedWorkspaceRecords!].reverse() }]) {
      expect(() => normalizeRemoteWorkerCellProvisioningHistory({ ...history, ...patch })).toThrow();
    }
  });
  it("rejects omitted members, duplicates, noncanonical order, excess and foreign profiles", () => {
    const value = fixture(), first = value.members[0]!;
    const missing = { ...value, members: [] };
    expect(() => normalizeRemoteWorkerNativePoolSnapshot(missing)).toThrow();
    for (const members of [[first, first], [{ ...first, history: null, cellId: "second", assignmentId: "z" }, first],
      Array.from({ length: 65 }, (_, i) => ({ ...first, assignmentId: String(i).padStart(3, "0"), cellId: String(i), history: null })),
      [{ ...first, profileSha256: "0".repeat(64) }]]) {
      expect(() => normalizeRemoteWorkerNativePoolSnapshot({ ...value, members,
        membershipSha256: sha256Utf8(canonicalJsonString(members)) })).toThrow();
    }
  });
  it("rejects sparse and accessor-bearing wire values without invoking getters", () => {
    const value = fixture(); let accessed = false;
    const getter = { ...value };
    Object.defineProperty(getter, "members", { enumerable: true, get() { accessed = true; return []; } });
    expect(() => normalizeRemoteWorkerNativePoolSnapshot(getter)).toThrow();
    const members = new Array(1);
    expect(() => normalizeRemoteWorkerNativePoolSnapshot({ ...value, members })).toThrow();
    Object.defineProperty(members, "0", { enumerable: true, get() { accessed = true; return value.members[0]; } });
    expect(() => normalizeRemoteWorkerNativePoolSnapshot({ ...value, members })).toThrow();
    expect(accessed).toBe(false);
  });
});
