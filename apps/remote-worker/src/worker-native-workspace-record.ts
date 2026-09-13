import { snapshotWorkerMeshValue, workerMeshHash, workerMeshRecord, workerMeshRejected } from "./worker-mesh-capability-data.js";
import { normalizeWindowsWorkerStdioLaunch, normalizeWindowsWorkerStdioWorkspace,
  type WindowsWorkerStdioWorkspace } from "./worker-windows-stdio-codec.js";

const VERSION = "goatcitadel.worker-native-workspace-record.v1";
const MAX_BYTES = 32 * 1024;
export interface WorkerNativeWorkspaceRecord {
  readonly schemaVersion: typeof VERSION;
  readonly invocationId: string;
  readonly envelopeSha256: string;
  readonly launchSha256: string;
  readonly jobName: string;
  readonly runtimeBundleSha256: string;
  readonly workspace: WindowsWorkerStdioWorkspace;
  readonly recordSha256: string;
}

/** Private recovery metadata, never execution permission or native cleanup proof.
 * Command lines, arguments, environment values and tool output are not retained. */
export function createWorkerNativeWorkspaceRecord(launch: unknown, binding: {
  readonly invocationId: string; readonly envelopeSha256: string;
}): WorkerNativeWorkspaceRecord {
  const frozen = normalizeWindowsWorkerStdioLaunch(launch);
  if (!frozen.protectedWorkspace) throw workerMeshRejected();
  const record = { schemaVersion: VERSION, invocationId: binding.invocationId, envelopeSha256: binding.envelopeSha256,
    launchSha256: workerMeshHash(frozen), jobName: frozen.jobName, runtimeBundleSha256: frozen.runtimeBundleSha256,
    workspace: frozen.protectedWorkspace };
  return normalizeWorkerNativeWorkspaceRecord({ ...record, recordSha256: workerMeshHash(record) }, binding);
}

export function normalizeWorkerNativeWorkspaceRecord(value: unknown, binding: {
  readonly invocationId: string; readonly envelopeSha256: string;
}): WorkerNativeWorkspaceRecord {
  const record = workerMeshRecord(snapshotWorkerMeshValue(value, MAX_BYTES, true), ["schemaVersion", "invocationId",
    "envelopeSha256", "launchSha256", "jobName", "runtimeBundleSha256", "workspace", "recordSha256"]);
  if (record.schemaVersion !== VERSION || typeof record.invocationId !== "string" || !record.invocationId ||
    record.invocationId.length > 256 || record.invocationId !== binding.invocationId || record.envelopeSha256 !== binding.envelopeSha256 ||
    typeof record.jobName !== "string" || !/^gc-cell-[a-f0-9]{32}$/u.test(record.jobName)) throw workerMeshRejected();
  for (const key of ["envelopeSha256", "launchSha256", "runtimeBundleSha256", "recordSha256"])
    if (typeof record[key] !== "string" || !/^[a-f0-9]{64}$/u.test(record[key] as string)) throw workerMeshRejected();
  normalizeWindowsWorkerStdioWorkspace(record.workspace);
  const { recordSha256, ...material } = record;
  if (workerMeshHash(material) !== recordSha256) throw workerMeshRejected();
  return record as unknown as WorkerNativeWorkspaceRecord;
}
