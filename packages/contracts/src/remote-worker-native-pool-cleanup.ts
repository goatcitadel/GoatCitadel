import { normalizeRemoteWorkerNativePoolSnapshot, type RemoteWorkerNativePoolSnapshot } from "./remote-worker-native-pool.js";
import { normalizeRemoteWorkerRuntimeResultExpectation, type RemoteWorkerRuntimeResultExpectation } from "./remote-worker-runtime-result.js";
import { normalizeRemoteWorkerRuntimeInstallRequest, type RemoteWorkerRuntimeInstallRequest } from "./remote-worker-runtime-install.js";
import { readRemoteWorkerCellProvisioningCheckpoint } from "./remote-worker-cell-provisioning.js";

export const REMOTE_WORKER_NATIVE_POOL_CLEANUP_SCHEMA_VERSION = "goatcitadel.remote-worker-native-pool-cleanup.v1" as const;
export const REMOTE_WORKER_NATIVE_POOL_MAXIMUM_RUNTIME_ATTEMPTS = 1000;
export interface RemoteWorkerNativePoolCleanupMember {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly expectations: readonly RemoteWorkerRuntimeResultExpectation[];
  readonly installation: RemoteWorkerRuntimeInstallRequest | null;
}
/** Complete historical coverage, not proof of local cleanup or permission to
 * copy, execute or measure. Missing resource history remains explicit. */
export interface RemoteWorkerNativePoolCleanupSnapshot {
  readonly schemaVersion: typeof REMOTE_WORKER_NATIVE_POOL_CLEANUP_SCHEMA_VERSION;
  readonly pool: RemoteWorkerNativePoolSnapshot;
  readonly members: readonly RemoteWorkerNativePoolCleanupMember[];
}
const refused = () => new Error("Native pool cleanup does not match complete retained membership.");
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null) ||
      Reflect.ownKeys(input).length !== keys.length) throw refused();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw refused();
    result[key] = descriptor.value;
  }
  return result;
}
function array(input: unknown, maximum: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > maximum ||
      Reflect.ownKeys(input).length !== input.length + 1) throw refused();
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw refused();
    return descriptor.value;
  });
}
export function normalizeRemoteWorkerNativePoolCleanupSnapshot(input: unknown): RemoteWorkerNativePoolCleanupSnapshot {
  const value = fields(input, ["schemaVersion", "pool", "members"]);
  if (value.schemaVersion !== REMOTE_WORKER_NATIVE_POOL_CLEANUP_SCHEMA_VERSION) throw refused();
  const pool = normalizeRemoteWorkerNativePoolSnapshot(value.pool), supplied = array(value.members, pool.members.length);
  if (supplied.length !== pool.members.length) throw refused();
  let total = 0;
  const members = supplied.map((input, index) => {
    const member = fields(input, ["registryWorkspaceId", "assignmentId", "assignmentGeneration", "expectations", "installation"]);
    const retained = pool.members[index]!, history = retained.history;
    if (member.registryWorkspaceId !== pool.registryWorkspaceId || member.assignmentId !== retained.assignmentId ||
        member.assignmentGeneration !== retained.assignmentGeneration) throw refused();
    const rows = array(member.expectations, REMOTE_WORKER_NATIVE_POOL_MAXIMUM_RUNTIME_ATTEMPTS - total);
    total += rows.length;
    const expectations = rows.map(normalizeRemoteWorkerRuntimeResultExpectation);
    const installation = member.installation === null ? null : normalizeRemoteWorkerRuntimeInstallRequest(member.installation);
    if (expectations.length || installation) {
      if (!history || history.mountedWorkspaceRecords?.length !== 2) throw refused();
      const head = history.mountedWorkspaceRecords[1]!.slice(-64);
      expectations.forEach((expected, position) => {
        if (expected.checkpointSha256 !== head || (position > 0 && expectations[position - 1]!.nonce >= expected.nonce)) throw refused();
      });
      if (installation) {
        const first = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]!);
        if (installation.checkpointSha256 !== head || installation.journalIdentityHex !== first.journalIdentityHex ||
            installation.preparedSha256 !== first.recordSha256) throw refused();
      }
    }
    return Object.freeze({ registryWorkspaceId: pool.registryWorkspaceId, assignmentId: retained.assignmentId,
      assignmentGeneration: retained.assignmentGeneration, expectations: Object.freeze(expectations), installation });
  });
  return Object.freeze({ schemaVersion: REMOTE_WORKER_NATIVE_POOL_CLEANUP_SCHEMA_VERSION, pool, members: Object.freeze(members) });
}
