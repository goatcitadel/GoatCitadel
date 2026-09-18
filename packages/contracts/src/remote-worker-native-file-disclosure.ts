import { canonicalJsonString } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import { normalizeRemoteWorkerRuntimeReadKey } from "./remote-worker-runtime-read.js";
import { normalizeRemoteWorkerNativeFileStaging } from "./remote-worker-native-file-staging.js";

export const REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA = "goatcitadel.remote-worker-native-file-disclosure.v1" as const;
/** Explicit operator approval scope for transferring selected native files to
 * the assignment's Gateway artifact workspace. It grants no model, channel or
 * external-publication access. Paths remain in the ephemeral reviewed plan;
 * only its canonical digest is retained in this approval payload. */
export interface RemoteWorkerNativeFileDisclosure {
  readonly schemaVersion: typeof REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA;
  readonly destination: "gateway_artifacts";
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly nonce: string;
  readonly requestSha256: string;
  readonly executionWorkspaceId: string;
  readonly pathJailSha256: string;
  readonly fileStagingSha256: string;
}
export function remoteWorkerNativeFileStagingSha256(plan: unknown): string {
  return sha256Hex(canonicalJsonString(normalizeRemoteWorkerNativeFileStaging(plan)));
}
export function normalizeRemoteWorkerNativeFileDisclosure(input: unknown): RemoteWorkerNativeFileDisclosure {
  const invalid = () => new TypeError("Native file disclosure must match the exact reviewed request, plan and artifact workspace.");
  const keys = ["schemaVersion", "destination", "registryWorkspaceId", "assignmentId", "assignmentGeneration", "nonce", "requestSha256",
    "executionWorkspaceId", "pathJailSha256", "fileStagingSha256"] as const;
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !fields[key]?.enumerable || !("value" in fields[key]))) throw invalid();
  const row = Object.fromEntries(keys.map(key => [key, fields[key]!.value])) as Record<typeof keys[number], unknown>;
  if (row.schemaVersion !== REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA || row.destination !== "gateway_artifacts" ||
      typeof row.assignmentGeneration !== "number" || !Number.isSafeInteger(row.assignmentGeneration) || row.assignmentGeneration < 1 ||
      row.assignmentGeneration > 2147483647) throw invalid();
  const scope = normalizeRemoteWorkerRuntimeReadKey({ registryWorkspaceId: row.registryWorkspaceId, assignmentId: row.assignmentId });
  const workspace = normalizeRemoteWorkerRuntimeReadKey({ registryWorkspaceId: row.executionWorkspaceId, assignmentId: row.assignmentId }).registryWorkspaceId;
  for (const field of ["nonce", "requestSha256", "pathJailSha256", "fileStagingSha256"] as const)
    if (typeof row[field] !== "string" || !/^[a-f0-9]{64}$/u.test(row[field]) || /^0+$/u.test(row[field])) throw invalid();
  return Object.freeze({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA, destination: "gateway_artifacts", ...scope,
    assignmentGeneration: row.assignmentGeneration, nonce: row.nonce as string, requestSha256: row.requestSha256 as string,
    executionWorkspaceId: workspace, pathJailSha256: row.pathJailSha256 as string, fileStagingSha256: row.fileStagingSha256 as string });
}
export function remoteWorkerNativeFileDisclosureSha256(input: unknown): string {
  return sha256Hex(canonicalJsonString(normalizeRemoteWorkerNativeFileDisclosure(input)));
}
