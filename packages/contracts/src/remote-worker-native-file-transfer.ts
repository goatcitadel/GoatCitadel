import { normalizeRemoteWorkerNativeFileReceipt, remoteWorkerNativeFileReceiptSha256, type RemoteWorkerNativeFileReceipt } from "./remote-worker-native-file-receipt.js";
export const REMOTE_WORKER_NATIVE_FILE_PAGE_BYTES = 32768;
export interface RemoteWorkerNativeFileTransferPage {
  readonly kind: "runtime.files.page";
  readonly nonce: string;
  readonly requestSha256: string;
  readonly transferSha256: string;
  readonly fileIndex: number;
  readonly pageIndex: number;
  readonly bytesHex: string;
}
const invalid = () => new TypeError("Native file transfer page differs from its bounded declared batch.");
export function normalizeRemoteWorkerNativeFileTransferPage(input: unknown): RemoteWorkerNativeFileTransferPage {
  const keys = ["kind", "nonce", "requestSha256", "transferSha256", "fileIndex", "pageIndex", "bytesHex"] as const;
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw invalid();
  const row = Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
  if (row.kind !== "runtime.files.page") throw invalid();
  for (const key of ["nonce", "requestSha256", "transferSha256"] as const)
    if (typeof row[key] !== "string" || !/^[0-9a-f]{64}$/u.test(row[key]) || /^0+$/u.test(row[key])) throw invalid();
  if (!Number.isSafeInteger(row.fileIndex) || row.fileIndex < 0 || row.fileIndex > 63 ||
      !Number.isSafeInteger(row.pageIndex) || row.pageIndex < 0 || row.pageIndex > 32 ||
      typeof row.bytesHex !== "string" || row.bytesHex.length < 2 || row.bytesHex.length > 2 * REMOTE_WORKER_NATIVE_FILE_PAGE_BYTES ||
      row.bytesHex.length % 2 || !/^[0-9a-f]+$/u.test(row.bytesHex)) throw invalid();
  return Object.freeze(row) as unknown as RemoteWorkerNativeFileTransferPage;
}
/** The declaration remains unverified until every complete native record has
 * been reconstructed, validated and installed by the Gateway artifact owner. */
export function nativeFileTransferPageForDeclaration(input: unknown, declaration: RemoteWorkerNativeFileReceipt): RemoteWorkerNativeFileTransferPage {
  const page = normalizeRemoteWorkerNativeFileTransferPage(input), draft = normalizeRemoteWorkerNativeFileReceipt(declaration);
  const file = draft.files[page.fileIndex], offset = page.pageIndex * REMOTE_WORKER_NATIVE_FILE_PAGE_BYTES;
  if (!file || page.nonce !== draft.disclosure.nonce || page.requestSha256 !== draft.disclosure.requestSha256 ||
      page.transferSha256 !== remoteWorkerNativeFileReceiptSha256(draft) || offset >= file.selection.logicalFileBytes + 200 ||
      page.bytesHex.length / 2 !== Math.min(REMOTE_WORKER_NATIVE_FILE_PAGE_BYTES, file.selection.logicalFileBytes + 200 - offset)) throw invalid();
  return page;
}
export function nativeFileTransferExpectedPages(declaration: RemoteWorkerNativeFileReceipt): number {
  return normalizeRemoteWorkerNativeFileReceipt(declaration).files.reduce((sum, file) => sum + Math.ceil((file.selection.logicalFileBytes + 200) / REMOTE_WORKER_NATIVE_FILE_PAGE_BYTES), 0);
}
