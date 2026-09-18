import { canonicalJsonString } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import { normalizeRemoteWorkerCellProvisioningHistory, type RemoteWorkerCellProvisioningHistory } from "./remote-worker-cell-provisioning.js";

export const REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION = "goatcitadel.remote-worker-native-pool.v1" as const;
export const REMOTE_WORKER_NATIVE_POOL_MAXIMUM_MEMBERS = 64;
export interface RemoteWorkerNativePoolMember {
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly workerGeneration: number;
  readonly cellId: string;
  readonly profileSha256: string;
  /** Null preserves incomplete membership; consumers must reconcile it. */
  readonly history: RemoteWorkerCellProvisioningHistory | null;
}
export interface RemoteWorkerNativePoolSnapshot {
  readonly schemaVersion: typeof REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION;
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly leaseRevision: number;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly members: readonly RemoteWorkerNativePoolMember[];
  readonly membershipSha256: string;
}
const refused = () => new Error("Invalid retained native pool snapshot.");
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype ||
      Reflect.ownKeys(input).length !== keys.length) throw refused();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw refused();
    result[key] = descriptor.value;
  }
  return result;
}
function identifier(input: unknown): string {
  if (typeof input !== "string" || !input.length || input.length > 256 || input !== input.trim() || /\p{Cc}/u.test(input)) throw refused();
  return input;
}
function generation(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) throw refused();
  return input as number;
}
function digest(input: unknown): string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input)) throw refused();
  return input;
}
/** A bounded complete list, never a page or an execution grant. The digest
 * binds normalized membership only; it is not a signature or freshness proof. */
export function normalizeRemoteWorkerNativePoolSnapshot(input: unknown): RemoteWorkerNativePoolSnapshot {
  const value = fields(input, ["schemaVersion", "registryWorkspaceId", "assignmentId", "assignmentGeneration",
    "leaseRevision", "workerId", "workerGeneration", "members", "membershipSha256"]);
  if (value.schemaVersion !== REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION) throw refused();
  const raw = value.members;
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length > REMOTE_WORKER_NATIVE_POOL_MAXIMUM_MEMBERS ||
      Reflect.ownKeys(raw).length !== raw.length + 1) throw refused();
  const members: RemoteWorkerNativePoolMember[] = [], cells = new Set<string>(), names = new Set<string>();
  for (let index = 0; index < raw.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw refused();
    const member = fields(descriptor.value, ["assignmentId", "assignmentGeneration", "workerGeneration", "cellId", "profileSha256", "history"]);
    const history = member.history === null ? null : normalizeRemoteWorkerCellProvisioningHistory(member.history);
    const normalized = Object.freeze({ assignmentId: identifier(member.assignmentId), assignmentGeneration: generation(member.assignmentGeneration),
      workerGeneration: generation(member.workerGeneration), cellId: identifier(member.cellId), profileSha256: digest(member.profileSha256), history });
    const previous = members.at(-1);
    if (previous && (previous.assignmentId > normalized.assignmentId || (previous.assignmentId === normalized.assignmentId &&
        previous.assignmentGeneration >= normalized.assignmentGeneration))) throw refused();
    if (cells.has(normalized.cellId) || (history && (history.plan.profileSha256 !== normalized.profileSha256 || names.has(history.plan.cellName)))) throw refused();
    cells.add(normalized.cellId);
    if (history) names.add(history.plan.cellName);
    members.push(normalized);
  }
  const membershipSha256 = sha256Hex(canonicalJsonString(members));
  if (digest(value.membershipSha256) !== membershipSha256) throw refused();
  return Object.freeze({ schemaVersion: REMOTE_WORKER_NATIVE_POOL_SCHEMA_VERSION,
    registryWorkspaceId: identifier(value.registryWorkspaceId), assignmentId: identifier(value.assignmentId),
    assignmentGeneration: generation(value.assignmentGeneration), leaseRevision: generation(value.leaseRevision),
    workerId: identifier(value.workerId), workerGeneration: generation(value.workerGeneration), members: Object.freeze(members), membershipSha256 });
}
