import { normalizeRemoteWorkerRuntimeResultSubmission, normalizeRemoteWorkerRuntimeResultExchange,
  type RemoteWorkerRuntimeResultExchange } from "./remote-worker-runtime-result-pages.js";

export const REMOTE_WORKER_NATIVE_FILE_RECONCILIATION_SCHEMA = "goatcitadel.native-file-reconciliation.v1" as const;
export interface RemoteWorkerNativeFileReconciliationSubmission {
  readonly kind: "runtime.files.reconcile"; readonly nonce: string; readonly requestSha256: string; readonly challenge: string;
}
export interface RemoteWorkerNativeFileReconciliationExchange {
  readonly schemaVersion: typeof REMOTE_WORKER_NATIVE_FILE_RECONCILIATION_SCHEMA;
  readonly challenge: string;
  readonly lookup: RemoteWorkerRuntimeResultExchange;
  readonly settlement: Readonly<{ receiptSha256: string; manifestSha256: string; uploadId: string }> | null;
}
function invalid(): TypeError { return new TypeError("Native file reconciliation must bind current result and artifact settlement evidence."); }
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value) || /^0+$/u.test(value)) throw invalid(); return value;
}
export function normalizeRemoteWorkerNativeFileReconciliationSubmission(input: unknown): RemoteWorkerNativeFileReconciliationSubmission {
  const row = fields(input, ["kind", "nonce", "requestSha256", "challenge"]);
  if (row.kind !== "runtime.files.reconcile") throw invalid();
  const lookup = normalizeRemoteWorkerRuntimeResultSubmission({ kind: "runtime.result.lookup", nonce: row.nonce, requestSha256: row.requestSha256 });
  return Object.freeze({ kind: row.kind, nonce: lookup.nonce, requestSha256: lookup.requestSha256, challenge: digest(row.challenge) });
}
export function normalizeRemoteWorkerNativeFileReconciliationExchange(input: unknown): RemoteWorkerNativeFileReconciliationExchange {
  const row = fields(input, ["schemaVersion", "challenge", "lookup", "settlement"]);
  if (row.schemaVersion !== REMOTE_WORKER_NATIVE_FILE_RECONCILIATION_SCHEMA) throw invalid();
  const lookup = normalizeRemoteWorkerRuntimeResultExchange(row.lookup);
  if (lookup.accepted !== null || (!lookup.record && row.settlement !== null)) throw invalid();
  let settlement: RemoteWorkerNativeFileReconciliationExchange["settlement"] = null;
  if (row.settlement !== null) {
    const entry = fields(row.settlement, ["receiptSha256", "manifestSha256", "uploadId"]);
    if (typeof entry.uploadId !== "string" || !/^[a-zA-Z0-9._:-]{1,512}$/u.test(entry.uploadId)) throw invalid();
    settlement = Object.freeze({ receiptSha256: digest(entry.receiptSha256), manifestSha256: digest(entry.manifestSha256), uploadId: entry.uploadId });
  }
  return Object.freeze({ schemaVersion: row.schemaVersion, challenge: digest(row.challenge), lookup, settlement });
}
