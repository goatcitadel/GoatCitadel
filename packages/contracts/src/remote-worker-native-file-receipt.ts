import { canonicalJsonString } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import { normalizeRemoteWorkerNativeFileDisclosure, remoteWorkerNativeFileStagingSha256,
  type RemoteWorkerNativeFileDisclosure } from "./remote-worker-native-file-disclosure.js";
import { normalizeRemoteWorkerNativeFileStaging, type RemoteWorkerNativeFileStaging } from "./remote-worker-native-file-staging.js";
import { normalizeRemoteWorkerNativeFileExportSelection, type RemoteWorkerNativeFileExportSelection } from "./remote-worker-native-file-export.js";

export const REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA = "goatcitadel.remote-worker-native-file-receipt.v1" as const;
export interface RemoteWorkerNativeFileReceipt {
  readonly schemaVersion: typeof REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA;
  readonly disclosure: RemoteWorkerNativeFileDisclosure;
  readonly fileStaging: RemoteWorkerNativeFileStaging;
  readonly resultSha256: string;
  readonly totalBytes: number;
  readonly files: readonly Readonly<{ selection: RemoteWorkerNativeFileExportSelection; recordSha256: string; contentSha256: string }>[];
}
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
function invalid(): TypeError { return new TypeError("Native file receipt must bind the complete approved batch and exact retained content."); }
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value) || /^0+$/u.test(value)) throw invalid();
  return value;
}
/** Metadata only. This is not a signature or independent proof of native origin;
 * the protected receiver owns custody, and recovery must rehash every CAS blob. */
export function normalizeRemoteWorkerNativeFileReceipt(input: unknown): RemoteWorkerNativeFileReceipt {
  const row = fields(input, ["schemaVersion", "disclosure", "fileStaging", "resultSha256", "totalBytes", "files"]);
  if (row.schemaVersion !== REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA) throw invalid();
  const disclosure = normalizeRemoteWorkerNativeFileDisclosure(row.disclosure), fileStaging = normalizeRemoteWorkerNativeFileStaging(row.fileStaging);
  const resultSha256 = digest(row.resultSha256);
  if (remoteWorkerNativeFileStagingSha256(fileStaging) !== disclosure.fileStagingSha256 ||
      !Array.isArray(row.files) || row.files.length !== fileStaging.paths.length) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(row.files);
  if (Reflect.ownKeys(row.files).length !== row.files.length + 1 ||
      Array.from({ length: row.files.length }, (_, index) => descriptors[index]).some(item => !item?.enumerable || !("value" in item))) throw invalid();
  const identities = new Set<string>(); let totalBytes = 0;
  const files = Array.from({ length: row.files.length }, (_, index) => {
    const value = descriptors[index]!.value;
    const entry = fields(value, ["selection", "recordSha256", "contentSha256"]), selection = normalizeRemoteWorkerNativeFileExportSelection(entry.selection);
    if (selection.registryWorkspaceId !== disclosure.registryWorkspaceId || selection.assignmentId !== disclosure.assignmentId ||
        selection.assignmentGeneration !== disclosure.assignmentGeneration || selection.nonce !== disclosure.nonce ||
        selection.requestSha256 !== disclosure.requestSha256 || selection.resultSha256 !== resultSha256 ||
        selection.logicalPath !== fileStaging.paths[index] || selection.maximumBytes !== fileStaging.maximumFileBytes ||
        identities.has(selection.fileIdentityHex)) throw invalid();
    identities.add(selection.fileIdentityHex); totalBytes += selection.logicalFileBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > fileStaging.maximumTotalBytes) throw invalid();
    return Object.freeze({ selection, recordSha256: digest(entry.recordSha256), contentSha256: digest(entry.contentSha256) });
  });
  if (totalBytes !== row.totalBytes) throw invalid();
  return Object.freeze({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA, disclosure, fileStaging,
    resultSha256, totalBytes, files: Object.freeze(files) });
}
export function remoteWorkerNativeFileReceiptSha256(input: unknown): string {
  return sha256Hex(canonicalJsonString(normalizeRemoteWorkerNativeFileReceipt(input)));
}
