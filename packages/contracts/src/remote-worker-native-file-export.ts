import { canonicalJsonString } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import { assertRemoteWorkerLogicalPath } from "./remote-worker-settlement.js";
import { normalizeRemoteWorkerRuntimeReadKey } from "./remote-worker-runtime-read.js";
import { normalizeRemoteWorkerCellProvisioningExchange, type RemoteWorkerCellProvisioningExchange } from "./remote-worker-cell-provisioning.js";
import { normalizeRemoteWorkerRuntimeResultExpectation, readRemoteWorkerRuntimeResult } from "./remote-worker-runtime-result.js";

export const REMOTE_WORKER_NATIVE_FILE_EXPORT_SCHEMA = "goatcitadel.remote-worker-native-file-export.v1" as const;
export const REMOTE_WORKER_NATIVE_FILE_EXPORT_MAX_BYTES = 1048576;
/** A selection for a separately authorized native read, never publication or
 * ancestry proof. The native owner must prove the file is under workDirectoryIdentityHex. */
export interface RemoteWorkerNativeFileExportSelection {
  readonly schemaVersion: typeof REMOTE_WORKER_NATIVE_FILE_EXPORT_SCHEMA;
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly nonce: string;
  readonly requestSha256: string;
  readonly resultSha256: string;
  readonly workDirectoryIdentityHex: string;
  readonly fileIdentityHex: string;
  readonly logicalFileBytes: number;
  readonly allocatedBytes: number;
  readonly maximumBytes: number;
  /** Artifact label, not a native filesystem locator. */
  readonly logicalPath: string;
}
const invalid = () => new TypeError("Native file export selection differs from retained execution evidence.");
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid();
  return value;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{48}$/u.test(value) || /^0{16}/u.test(value) || /^0{32}$/u.test(value.slice(16))) throw invalid();
  return value;
}
export function normalizeRemoteWorkerNativeFileExportSelection(input: unknown): RemoteWorkerNativeFileExportSelection {
  const row = record(input, ["schemaVersion", "registryWorkspaceId", "assignmentId", "assignmentGeneration", "nonce", "requestSha256", "resultSha256",
    "workDirectoryIdentityHex", "fileIdentityHex", "logicalFileBytes", "allocatedBytes", "maximumBytes", "logicalPath"]);
  if (row.schemaVersion !== REMOTE_WORKER_NATIVE_FILE_EXPORT_SCHEMA) throw invalid();
  const scope = normalizeRemoteWorkerRuntimeReadKey({ registryWorkspaceId: row.registryWorkspaceId, assignmentId: row.assignmentId });
  const maximumBytes = integer(row.maximumBytes, 1, REMOTE_WORKER_NATIVE_FILE_EXPORT_MAX_BYTES);
  const directory = identity(row.workDirectoryIdentityHex), file = identity(row.fileIdentityHex);
  if (directory === file || directory.slice(0, 16) !== file.slice(0, 16)) throw invalid();
  for (const field of ["nonce", "requestSha256", "resultSha256"] as const)
    if (typeof row[field] !== "string" || !/^[0-9a-f]{64}$/u.test(row[field]) || /^0+$/u.test(row[field])) throw invalid();
  return Object.freeze({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_EXPORT_SCHEMA, ...scope,
    assignmentGeneration: integer(row.assignmentGeneration, 1, 2147483647), nonce: row.nonce as string,
    requestSha256: row.requestSha256 as string, resultSha256: row.resultSha256 as string,
    workDirectoryIdentityHex: directory, fileIdentityHex: file,
    logicalFileBytes: integer(row.logicalFileBytes, 0, maximumBytes), allocatedBytes: integer(row.allocatedBytes, 0, Number.MAX_SAFE_INTEGER),
    maximumBytes, logicalPath: assertRemoteWorkerLogicalPath(row.logicalPath) });
}
/** The execution owner supplies expectation/history and its independent export
 * ceiling. Flat inventory membership cannot attest ancestry; native checking is mandatory. */
export function createRemoteWorkerNativeFileExportSelection(request: unknown, expectation: unknown, resultHex: unknown,
  suppliedHistory: RemoteWorkerCellProvisioningExchange, maximumBytes: number): RemoteWorkerNativeFileExportSelection {
  const selected = record(request, ["fileIdentityHex", "logicalPath"]);
  const fileIdentityHex = identity(selected.fileIdentityHex), logicalPath = assertRemoteWorkerLogicalPath(selected.logicalPath);
  const expected = normalizeRemoteWorkerRuntimeResultExpectation(expectation), history = normalizeRemoteWorkerCellProvisioningExchange(suppliedHistory);
  const result = readRemoteWorkerRuntimeResult(resultHex, expected, history);
  if (!result.flags.bindingVerified || !result.flags.protectedWorkspaceVerified || !result.flags.zeroProcessesVerified ||
      !result.flags.outputDrained || !result.flags.captureVerified || !result.inventory) throw invalid();
  const file = result.inventory.entries.find(entry => entry.identityHex === fileIdentityHex && !entry.directory);
  if (!file) throw invalid();
  return normalizeRemoteWorkerNativeFileExportSelection({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_EXPORT_SCHEMA,
    registryWorkspaceId: history.registryWorkspaceId, assignmentId: history.assignmentId, assignmentGeneration: history.assignmentGeneration,
    nonce: expected.nonce, requestSha256: expected.requestSha256, resultSha256: result.resultSha256,
    workDirectoryIdentityHex: result.inventory.directoryIdentityHex[3], fileIdentityHex,
    logicalFileBytes: file.logicalFileBytes, allocatedBytes: file.allocatedBytes, maximumBytes, logicalPath });
}
export function remoteWorkerNativeFileExportSelectionSha256(input: RemoteWorkerNativeFileExportSelection): string {
  return sha256Hex(canonicalJsonString(normalizeRemoteWorkerNativeFileExportSelection(input)));
}
