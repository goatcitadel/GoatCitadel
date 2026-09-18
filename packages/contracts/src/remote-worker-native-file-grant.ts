import { canonicalJsonString } from "./canonical-json.js";
import { normalizeRemoteWorkerNativeFileExportSelection, type RemoteWorkerNativeFileExportSelection } from "./remote-worker-native-file-export.js";
import { normalizeRemoteWorkerNativeFileStaging, type RemoteWorkerNativeFileStaging } from "./remote-worker-native-file-staging.js";
import { normalizeRemoteWorkerNativeFileDisclosure, remoteWorkerNativeFileStagingSha256, type RemoteWorkerNativeFileDisclosure } from "./remote-worker-native-file-disclosure.js";

export const REMOTE_WORKER_NATIVE_FILE_GRANT_SCHEMA = "goatcitadel.native-file-grant.v1" as const;
export interface RemoteWorkerNativeFileGrantSubmission {
  readonly kind: "runtime.file.authorize";
  readonly selection: RemoteWorkerNativeFileExportSelection;
  readonly fileStaging: RemoteWorkerNativeFileStaging;
  readonly challenge: string;
}
/** A fresh response to one protected request, not a reusable capability token. */
export interface RemoteWorkerNativeFileGrantReceipt {
  readonly schemaVersion: typeof REMOTE_WORKER_NATIVE_FILE_GRANT_SCHEMA;
  readonly leaseRevision: number;
  readonly submission: RemoteWorkerNativeFileGrantSubmission;
  readonly disclosure: RemoteWorkerNativeFileDisclosure;
}
const invalid = () => new TypeError("Native file grant must match its exact protected selection and disclosure.");
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
export function normalizeRemoteWorkerNativeFileGrantSubmission(input: unknown): RemoteWorkerNativeFileGrantSubmission {
  const row = fields(input, ["kind", "selection", "fileStaging", "challenge"]);
  if (row.kind !== "runtime.file.authorize" || typeof row.challenge !== "string" || !/^[a-f0-9]{64}$/u.test(row.challenge) || /^0+$/u.test(row.challenge)) throw invalid();
  const selection = normalizeRemoteWorkerNativeFileExportSelection(row.selection), fileStaging = normalizeRemoteWorkerNativeFileStaging(row.fileStaging);
  if (!fileStaging.paths.includes(selection.logicalPath) || selection.maximumBytes !== fileStaging.maximumFileBytes || selection.logicalFileBytes > fileStaging.maximumTotalBytes) throw invalid();
  return Object.freeze({ kind: row.kind, selection, fileStaging, challenge: row.challenge });
}
export function normalizeRemoteWorkerNativeFileGrantReceipt(input: unknown): RemoteWorkerNativeFileGrantReceipt {
  const row = fields(input, ["schemaVersion", "leaseRevision", "submission", "disclosure"]);
  if (row.schemaVersion !== REMOTE_WORKER_NATIVE_FILE_GRANT_SCHEMA || typeof row.leaseRevision !== "number" || !Number.isSafeInteger(row.leaseRevision) || row.leaseRevision < 1) throw invalid();
  const submission = normalizeRemoteWorkerNativeFileGrantSubmission(row.submission), disclosure = normalizeRemoteWorkerNativeFileDisclosure(row.disclosure);
  const selection = submission.selection;
  if (canonicalJsonString({ registryWorkspaceId: selection.registryWorkspaceId, assignmentId: selection.assignmentId, assignmentGeneration: selection.assignmentGeneration,
    nonce: selection.nonce, requestSha256: selection.requestSha256 }) !== canonicalJsonString({ registryWorkspaceId: disclosure.registryWorkspaceId,
    assignmentId: disclosure.assignmentId, assignmentGeneration: disclosure.assignmentGeneration, nonce: disclosure.nonce, requestSha256: disclosure.requestSha256 }) ||
    disclosure.fileStagingSha256 !== remoteWorkerNativeFileStagingSha256(submission.fileStaging)) throw invalid();
  return Object.freeze({ schemaVersion: row.schemaVersion, leaseRevision: row.leaseRevision, submission, disclosure });
}
