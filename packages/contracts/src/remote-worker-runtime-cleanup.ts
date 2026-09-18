import { normalizeRemoteWorkerCellProvisioningExchange, remoteWorkerCellProvisioningMountedWorkspaceAnchor,
  normalizeRemoteWorkerCellProvisioningHistory, type RemoteWorkerCellProvisioningHistory,
  type RemoteWorkerCellProvisioningExchange } from "./remote-worker-cell-provisioning.js";
import { readRemoteWorkerCellMountedWorkspaceCheckpoint } from "./remote-worker-cell-mounted-workspace.js";
import { normalizeRemoteWorkerRuntimeResultExpectation, type RemoteWorkerRuntimeResultExpectation } from "./remote-worker-runtime-result.js";

export const REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA = "goatcitadel.remote-worker-runtime-cleanup.v1" as const;
export interface RemoteWorkerRuntimeCleanupSubmission { readonly kind: "runtime.cleanup.read"; readonly challenge: string }
/** Complete historical expectations, not execution or measurement authority. */
export interface RemoteWorkerRuntimeCleanupExchange {
  readonly schemaVersion: typeof REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA;
  readonly challenge: string;
  readonly history: RemoteWorkerCellProvisioningExchange;
  readonly expectations: readonly RemoteWorkerRuntimeResultExpectation[];
}
export interface RemoteWorkerRuntimeCleanupHistory {
  readonly challenge: string;
  readonly history: RemoteWorkerCellProvisioningHistory;
  readonly expectations: readonly RemoteWorkerRuntimeResultExpectation[];
}
const refused = () => new TypeError("Native cleanup expectations are invalid.");
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw refused();
  const properties = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !properties[key]?.enumerable || !("value" in properties[key]))) throw refused();
  return Object.fromEntries(keys.map(key => [key, properties[key]!.value]));
}
function challenge(input: unknown): string {
  if (typeof input !== "string" || !/^[0-9a-f]{64}$/u.test(input) || /^0+$/u.test(input)) throw refused(); return input;
}
export function normalizeRemoteWorkerRuntimeCleanupSubmission(input: unknown): RemoteWorkerRuntimeCleanupSubmission {
  const value = fields(input, ["kind", "challenge"]);
  if (value.kind !== "runtime.cleanup.read") throw refused();
  return Object.freeze({ kind: value.kind, challenge: challenge(value.challenge) });
}
export function normalizeRemoteWorkerRuntimeCleanupExchange(input: unknown): RemoteWorkerRuntimeCleanupExchange {
  const value = fields(input, ["schemaVersion", "challenge", "history", "expectations"]);
  if (value.schemaVersion !== REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA) throw refused();
  const history = normalizeRemoteWorkerCellProvisioningExchange(value.history);
  if (history.mountedWorkspaceRecords?.length !== 2) throw refused();
  const head = readRemoteWorkerCellMountedWorkspaceCheckpoint(remoteWorkerCellProvisioningMountedWorkspaceAnchor(history), history.mountedWorkspaceRecords[1]).recordSha256;
  return Object.freeze({ schemaVersion: value.schemaVersion, challenge: challenge(value.challenge), history,
    expectations: cleanupExpectations(value.expectations, head) });
}
/** Resource history has no current-assignment lease. The caller must provide
 * independently protected pool admission before using its encoded cleanup. */
export function normalizeRemoteWorkerRuntimeCleanupHistory(input: unknown): RemoteWorkerRuntimeCleanupHistory {
  const value = fields(input, ["challenge", "history", "expectations"]);
  const history = normalizeRemoteWorkerCellProvisioningHistory(value.history);
  if (history.mountedWorkspaceRecords?.length !== 2) throw refused();
  return Object.freeze({ challenge: challenge(value.challenge), history,
    expectations: cleanupExpectations(value.expectations, history.mountedWorkspaceRecords[1]!.slice(-64)) });
}
function cleanupExpectations(input: unknown, head: string): readonly RemoteWorkerRuntimeResultExpectation[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > 1000 ||
      Reflect.ownKeys(input).length !== input.length + 1) throw refused();
  const expectations: RemoteWorkerRuntimeResultExpectation[] = [];
  for (let index = 0; index < input.length; index++) {
    const property = Object.getOwnPropertyDescriptor(input, String(index));
    if (!property?.enumerable || !("value" in property)) throw refused();
    const expected = normalizeRemoteWorkerRuntimeResultExpectation(property.value);
    if (expected.checkpointSha256 !== head || (index > 0 && expectations[index - 1]!.nonce >= expected.nonce)) throw refused();
    expectations.push(expected);
  }
  return Object.freeze(expectations);
}
