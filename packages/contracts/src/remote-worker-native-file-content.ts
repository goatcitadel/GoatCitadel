import { normalizeRemoteWorkerNativeFileExportSelection, remoteWorkerNativeFileExportSelectionSha256 } from "./remote-worker-native-file-export.js";
import { sha256BytesHex } from "./sha256.js";

/** Decoded GCRFA001 content. The caller independently authorizes the selection
 * and supplies bytes from the protected native owner; this is integrity checking,
 * not a signature, ancestry proof, disclosure approval or publication grant. */
export interface RemoteWorkerNativeFileContent {
  readonly selectionSha256: string;
  readonly recordSha256: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly contentHex: string;
}
export function readRemoteWorkerNativeFileContent(input: unknown, expectedSelection: unknown): RemoteWorkerNativeFileContent {
  const selected = normalizeRemoteWorkerNativeFileExportSelection(expectedSelection);
  const invalid = () => new TypeError("Native file content differs from the independently authorized selection.");
  // Validate the exact bounded size before decoding or hashing attacker input.
  if (typeof input !== "string" || input.length !== (200 + selected.logicalFileBytes) * 2 || !/^[0-9a-f]+$/u.test(input)) throw invalid();
  const field = (offset: number, length: number) => input.slice(offset * 2, (offset + length) * 2);
  if (field(0, 8) !== "4743524641303031" || field(8, 32) !== selected.nonce || field(40, 32) !== selected.requestSha256 ||
      field(72, 32) !== selected.resultSha256 || field(104, 24) !== selected.workDirectoryIdentityHex ||
      field(128, 24) !== selected.fileIdentityHex) throw invalid();
  const bytes = new Uint8Array(input.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(input.slice(i * 2, i * 2 + 2), 16);
  const view = new DataView(bytes.buffer);
  if (view.getBigUint64(152, true) !== BigInt(selected.logicalFileBytes) ||
      view.getBigUint64(160, true) !== BigInt(selected.allocatedBytes)) throw invalid();
  const contentSha256 = sha256BytesHex(bytes.subarray(200));
  if (field(168, 32) !== contentSha256) throw invalid();
  return Object.freeze({ selectionSha256: remoteWorkerNativeFileExportSelectionSha256(selected), recordSha256: sha256BytesHex(bytes),
    contentSha256, byteLength: selected.logicalFileBytes, contentHex: input.slice(400) });
}
