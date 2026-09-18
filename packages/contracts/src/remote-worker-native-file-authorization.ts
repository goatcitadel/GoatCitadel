import { createRemoteWorkerNativeFileExportSelection, type RemoteWorkerNativeFileExportSelection } from "./remote-worker-native-file-export.js";
import type { RemoteWorkerCellProvisioningExchange } from "./remote-worker-cell-provisioning.js";

/** Decode a bounded file-control challenge against independently retained
 * execution evidence. The owner must separately approve its path and ceiling;
 * matching native metadata is not a disclosure grant. */
export function readRemoteWorkerNativeFileAuthorization(recordHex: unknown, expectation: unknown, resultHex: unknown,
  history: RemoteWorkerCellProvisioningExchange): RemoteWorkerNativeFileExportSelection {
  const invalid = () => new TypeError("Native file control differs from retained execution evidence.");
  if (typeof recordHex !== "string" || recordHex.length !== 2120 || !/^[a-f0-9]+$/u.test(recordHex)) throw invalid();
  const bytes = Uint8Array.from({ length: 1060 }, (_, index) => Number.parseInt(recordHex.slice(index * 2, index * 2 + 2), 16));
  const view = new DataView(bytes.buffer), length = view.getUint32(100, true);
  if (!length || length > 512 || bytes.subarray(104 + length).some(byte => byte !== 0)) throw invalid();
  const pathBytes = bytes.subarray(104, 104 + length), logicalPath = new TextDecoder("utf-8", { fatal: true }).decode(pathBytes);
  const encodedPath = new TextEncoder().encode(logicalPath);
  if (encodedPath.length !== pathBytes.length || encodedPath.some((byte, index) => byte !== pathBytes[index])) throw invalid();
  const selection = createRemoteWorkerNativeFileExportSelection({ fileIdentityHex: recordHex.slice(112, 160), logicalPath },
    expectation, resultHex, history, view.getUint32(96, true));
  if (selection.resultSha256 !== recordHex.slice(0, 64) || selection.workDirectoryIdentityHex !== recordHex.slice(64, 112) ||
      BigInt(selection.logicalFileBytes) !== view.getBigUint64(80, true) || BigInt(selection.allocatedBytes) !== view.getBigUint64(88, true)) throw invalid();
  return selection;
}
