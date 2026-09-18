import { normalizeRemoteWorkerCellProvisioningExchange, readRemoteWorkerCellProvisioningCheckpoint, type RemoteWorkerCellProvisioningExchange } from "./remote-worker-cell-provisioning.js";
import { normalizeRemoteWorkerRuntimeInstallRequest, type RemoteWorkerRuntimeInstallRequest } from "./remote-worker-runtime-install.js";

export const REMOTE_WORKER_RUNTIME_INSTALL_SELECTION_SCHEMA_VERSION = "goatcitadel.remote-worker-runtime-install-selection.v1" as const;
export type RemoteWorkerRuntimeInstallSelectionSubmission = Readonly<{ kind: "runtime.install.select"; challenge: string }>;
export interface RemoteWorkerRuntimeInstallSelection {
  readonly schemaVersion: typeof REMOTE_WORKER_RUNTIME_INSTALL_SELECTION_SCHEMA_VERSION;
  readonly challenge: string;
  readonly history: RemoteWorkerCellProvisioningExchange;
  readonly request: RemoteWorkerRuntimeInstallRequest | null;
}
export function normalizeRemoteWorkerRuntimeInstallSelectionSubmission(input: unknown): RemoteWorkerRuntimeInstallSelectionSubmission {
  const value = fields(input, ["kind", "challenge"]);
  if (value.kind !== "runtime.install.select") throw refused();
  return Object.freeze({ kind: value.kind, challenge: hash(value.challenge) });
}
/** Selection retrieves immutable reviewed input; it conveys no copy grant. */
export function normalizeRemoteWorkerRuntimeInstallSelection(input: unknown): RemoteWorkerRuntimeInstallSelection {
  const value = fields(input, ["schemaVersion", "challenge", "history", "request"]);
  if (value.schemaVersion !== REMOTE_WORKER_RUNTIME_INSTALL_SELECTION_SCHEMA_VERSION) throw refused();
  const history = normalizeRemoteWorkerCellProvisioningExchange(value.history);
  if (history.mountedWorkspaceRecords?.length !== 2) throw refused();
  const request = value.request === null ? null : normalizeRemoteWorkerRuntimeInstallRequest(value.request);
  const first = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]!);
  if (request && (request.journalIdentityHex !== first.journalIdentityHex || request.preparedSha256 !== first.recordSha256 ||
      request.checkpointSha256 !== history.mountedWorkspaceRecords[1]!.slice(-64))) throw refused();
  return Object.freeze({ schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SELECTION_SCHEMA_VERSION, challenge: hash(value.challenge), history, request });
}

export const REMOTE_WORKER_RUNTIME_INSTALL_EXCHANGE_SCHEMA_VERSION = "goatcitadel.remote-worker-runtime-install-exchange.v1" as const;
export type RemoteWorkerRuntimeInstallSubmission = Readonly<{ kind: "runtime.install.lookup"; nonce: string; requestSha256: string }> |
  Readonly<{ kind: "runtime.install.retain"; nonce: string; requestSha256: string; outcomeHex: string }>;
export interface RemoteWorkerRuntimeInstallReceipt {
  readonly outcomeHex: string;
  readonly outcomeSha256: string;
  readonly leaseRevision: number;
  readonly recordedAt: string;
}
export interface RemoteWorkerRuntimeInstallExchange {
  readonly schemaVersion: typeof REMOTE_WORKER_RUNTIME_INSTALL_EXCHANGE_SCHEMA_VERSION;
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly leaseRevision: number;
  readonly nonce: string;
  readonly requestSha256: string;
  readonly record: RemoteWorkerRuntimeInstallReceipt | null;
}
const refused = () => new TypeError("Installation evidence exchange does not bind its protected request.");
function fields(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw refused();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw refused();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value) || /^0+$/u.test(value)) throw refused(); return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw refused(); return value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw refused(); return value;
}
function outcome(value: unknown, nonce: string, requestSha256: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{704}$/u.test(value) || value.slice(0, 16) !== "4743524c49303031" ||
      value.slice(512, 528) !== "4743524c49543031" || value.slice(16, 80) !== nonce || value.slice(80, 144) !== requestSha256) throw refused();
  return value;
}
/** Envelope validation only; the storage/worker owner must separately decode
 * seals, copy counters and journal bindings against independent admission. */
export function normalizeRemoteWorkerRuntimeInstallSubmission(input: unknown): RemoteWorkerRuntimeInstallSubmission {
  const kind = input && typeof input === "object" ? Object.getOwnPropertyDescriptor(input, "kind")?.value : undefined;
  if (kind !== "runtime.install.lookup" && kind !== "runtime.install.retain") throw refused();
  const value = fields(input, kind === "runtime.install.lookup" ? ["kind", "nonce", "requestSha256"] : ["kind", "nonce", "requestSha256", "outcomeHex"]);
  const nonce = hash(value.nonce), requestSha256 = hash(value.requestSha256);
  return Object.freeze(kind === "runtime.install.lookup" ? { kind, nonce, requestSha256 } :
    { kind, nonce, requestSha256, outcomeHex: outcome(value.outcomeHex, nonce, requestSha256) });
}
export function normalizeRemoteWorkerRuntimeInstallExchange(input: unknown): RemoteWorkerRuntimeInstallExchange {
  const value = fields(input, ["schemaVersion", "registryWorkspaceId", "assignmentId", "assignmentGeneration", "leaseRevision", "nonce", "requestSha256", "record"]);
  if (value.schemaVersion !== REMOTE_WORKER_RUNTIME_INSTALL_EXCHANGE_SCHEMA_VERSION) throw refused();
  const nonce = hash(value.nonce), requestSha256 = hash(value.requestSha256), leaseRevision = integer(value.leaseRevision);
  let record: RemoteWorkerRuntimeInstallReceipt | null = null;
  if (value.record !== null) {
    const row = fields(value.record, ["outcomeHex", "outcomeSha256", "leaseRevision", "recordedAt"]);
    const outcomeHex = outcome(row.outcomeHex, nonce, requestSha256), outcomeSha256 = hash(row.outcomeSha256), recordedLease = integer(row.leaseRevision);
    if (outcomeHex.slice(640) !== outcomeSha256 || recordedLease > leaseRevision || typeof row.recordedAt !== "string" ||
        !Number.isFinite(Date.parse(row.recordedAt)) || new Date(row.recordedAt).toISOString() !== row.recordedAt) throw refused();
    record = Object.freeze({ outcomeHex, outcomeSha256, leaseRevision: recordedLease, recordedAt: row.recordedAt });
  }
  return Object.freeze({ schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_EXCHANGE_SCHEMA_VERSION, registryWorkspaceId: id(value.registryWorkspaceId),
    assignmentId: id(value.assignmentId), assignmentGeneration: integer(value.assignmentGeneration), leaseRevision, nonce, requestSha256, record });
}
