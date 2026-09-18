export { normalizeWindowsWorkerStdioWorkspace, normalizeWindowsWorkerStdioLaunch, encodeWindowsWorkerStdioLaunch,
  type WindowsWorkerStdioWorkspace, type WindowsWorkerStdioLaunch } from "@goatcitadel/contracts/remote-worker-runtime-node";
import { workerMeshRecord, workerMeshRejected } from "./worker-mesh-capability-data.js";

export interface WindowsWorkerStdioCompletion {
  readonly schemaVersion: "goatcitadel.worker-native-stdio.v1";
  readonly bridgeError: number;
  readonly end: number;
  readonly error: number;
  readonly processExitCode: number;
  readonly processId: number;
  readonly runtimeBundleVerified: boolean;
  readonly runtimeBundleSha256: string;
  readonly zeroProcessesVerified: boolean;
  readonly outputDrained: boolean;
  readonly appContainerVerified: boolean;
  readonly launchFilesVerified: boolean;
  readonly processImageVerified: boolean;
  readonly protectedWorkspaceVerified: boolean;
  readonly standardInputBytesWritten: number;
  readonly standardInputComplete: boolean;
  readonly standardOutputBytes: number;
  readonly standardErrorBytes: number;
}
export function encodeWindowsWorkerStdioFrame(kind: 1 | 2 | 3, value: Uint8Array = Buffer.alloc(0)): Buffer {
  if (![1, 2, 3].includes(kind) || !(value instanceof Uint8Array) || value.byteLength > 65536 ||
    (kind === 1 ? !value.byteLength : value.byteLength !== 0)) throw workerMeshRejected();
  const header = Buffer.alloc(5); header[0] = kind; header.writeUInt32LE(value.byteLength, 1);
  return Buffer.concat([header, value]);
}
export function decodeWindowsWorkerStdioCompletion(bytes: Uint8Array): WindowsWorkerStdioCompletion {
  if (bytes.length > 4096) throw workerMeshRejected();
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  const numeric = ["bridgeError", "end", "error", "processExitCode", "processId", "standardInputBytesWritten", "standardOutputBytes", "standardErrorBytes"];
  const booleans = ["runtimeBundleVerified", "zeroProcessesVerified", "outputDrained", "appContainerVerified", "launchFilesVerified", "processImageVerified", "protectedWorkspaceVerified", "standardInputComplete"];
  const record = workerMeshRecord(value, ["schemaVersion", "runtimeBundleSha256", ...numeric, ...booleans]);
  if (record.schemaVersion !== "goatcitadel.worker-native-stdio.v1" || typeof record.runtimeBundleSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.runtimeBundleSha256)) throw workerMeshRejected();
  for (const name of numeric) if (typeof record[name] !== "number" || !Number.isSafeInteger(record[name]) || (record[name] as number) < 0) throw workerMeshRejected();
  for (const name of booleans) if (typeof record[name] !== "boolean") throw workerMeshRejected();
  if ((record.end as number) > 5 || (record.standardInputBytesWritten as number) > 1024 * 1024 ||
    (record.standardOutputBytes as number) + (record.standardErrorBytes as number) > 64 * 1024 * 1024 + 8192) throw workerMeshRejected();
  return Object.freeze(record) as unknown as WindowsWorkerStdioCompletion;
}
