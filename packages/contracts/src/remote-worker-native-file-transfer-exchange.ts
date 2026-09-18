import { normalizeRemoteWorkerNativeFileReceipt, type RemoteWorkerNativeFileReceipt } from "./remote-worker-native-file-receipt.js";
import { normalizeRemoteWorkerRuntimeReadKey } from "./remote-worker-runtime-read.js";
export const REMOTE_WORKER_NATIVE_FILE_TRANSFER_EXCHANGE_SCHEMA = "goatcitadel.native-file-transfer-exchange.v1" as const;
export interface RemoteWorkerNativeFileTransferBegin { readonly kind: "runtime.files.begin"; readonly declaration: RemoteWorkerNativeFileReceipt }
export interface RemoteWorkerNativeFileTransferExchange {
  readonly schemaVersion: typeof REMOTE_WORKER_NATIVE_FILE_TRANSFER_EXCHANGE_SCHEMA;
  readonly registryWorkspaceId: string; readonly assignmentId: string; readonly assignmentGeneration: number; readonly leaseRevision: number;
  readonly nonce: string; readonly requestSha256: string; readonly transferSha256: string;
  readonly acceptedPage: Readonly<{ fileIndex: number; pageIndex: number; pageSha256: string }> | null;
}
const invalid = () => new TypeError("Native file transfer acknowledgement differs from its protected request.");
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid(); return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value) || /^0+$/u.test(value)) throw invalid(); return value;
}
export function normalizeRemoteWorkerNativeFileTransferBegin(input: unknown): RemoteWorkerNativeFileTransferBegin {
  const row = fields(input, ["kind", "declaration"]); if (row.kind !== "runtime.files.begin") throw invalid();
  return Object.freeze({ kind: row.kind, declaration: normalizeRemoteWorkerNativeFileReceipt(row.declaration) });
}
export function normalizeRemoteWorkerNativeFileTransferExchange(input: unknown): RemoteWorkerNativeFileTransferExchange {
  const row = fields(input, ["schemaVersion", "registryWorkspaceId", "assignmentId", "assignmentGeneration", "leaseRevision", "nonce", "requestSha256", "transferSha256", "acceptedPage"]);
  if (row.schemaVersion !== REMOTE_WORKER_NATIVE_FILE_TRANSFER_EXCHANGE_SCHEMA) throw invalid();
  const key = normalizeRemoteWorkerRuntimeReadKey({ registryWorkspaceId: row.registryWorkspaceId, assignmentId: row.assignmentId });
  let acceptedPage: RemoteWorkerNativeFileTransferExchange["acceptedPage"] = null;
  if (row.acceptedPage !== null) {
    const page = fields(row.acceptedPage, ["fileIndex", "pageIndex", "pageSha256"]);
    acceptedPage = Object.freeze({ fileIndex: integer(page.fileIndex, 0, 63), pageIndex: integer(page.pageIndex, 0, 32), pageSha256: digest(page.pageSha256) });
  }
  return Object.freeze({ schemaVersion: row.schemaVersion, ...key, assignmentGeneration: integer(row.assignmentGeneration, 1, 2147483647),
    leaseRevision: integer(row.leaseRevision, 1, 2147483647), nonce: digest(row.nonce), requestSha256: digest(row.requestSha256), transferSha256: digest(row.transferSha256), acceptedPage });
}
