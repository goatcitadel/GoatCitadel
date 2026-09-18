import { normalizeRemoteWorkerRuntimeOutputEvidence, type RemoteWorkerRuntimeOutputEvidence } from "./remote-worker-runtime-output.js";

export const REMOTE_WORKER_RUNTIME_OUTPUT_RECEIPT_SCHEMA = "goatcitadel.remote-worker-runtime-output-receipt.v1" as const;
export interface RemoteWorkerRuntimeOutputSubmission {
  readonly kind: "runtime.output.retain";
  readonly evidence: RemoteWorkerRuntimeOutputEvidence;
}
/** Immutable retention acknowledgement, never execution or task-success authority. */
export interface RemoteWorkerRuntimeOutputReceipt {
  readonly schemaVersion: typeof REMOTE_WORKER_RUNTIME_OUTPUT_RECEIPT_SCHEMA;
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly leaseRevision: number;
  readonly nonce: string;
  readonly requestSha256: string;
  readonly resultSha256: string;
  readonly evidenceSha256: string;
  readonly recordedLeaseRevision: number;
  readonly recordedAt: string;
}
const refused = () => new TypeError("Native output retention binding is invalid.");
function fields(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw refused();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw refused();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value) || /^0+$/u.test(value)) throw refused(); return value;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256) throw refused();
  for (const character of value) if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) throw refused();
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw refused(); return value;
}
export function normalizeRemoteWorkerRuntimeOutputSubmission(input: unknown): RemoteWorkerRuntimeOutputSubmission {
  const row = fields(input, ["kind", "evidence"]);
  if (row.kind !== "runtime.output.retain") throw refused();
  return Object.freeze({ kind: row.kind, evidence: normalizeRemoteWorkerRuntimeOutputEvidence(row.evidence) });
}
export function normalizeRemoteWorkerRuntimeOutputReceipt(input: unknown): RemoteWorkerRuntimeOutputReceipt {
  const row = fields(input, ["schemaVersion", "registryWorkspaceId", "assignmentId", "assignmentGeneration", "leaseRevision",
    "nonce", "requestSha256", "resultSha256", "evidenceSha256", "recordedLeaseRevision", "recordedAt"]);
  if (row.schemaVersion !== REMOTE_WORKER_RUNTIME_OUTPUT_RECEIPT_SCHEMA) throw refused();
  const leaseRevision = revision(row.leaseRevision), recordedLeaseRevision = revision(row.recordedLeaseRevision);
  if (recordedLeaseRevision > leaseRevision || typeof row.recordedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.recordedAt) || !Number.isFinite(Date.parse(row.recordedAt)) ||
      new Date(row.recordedAt).toISOString() !== row.recordedAt) throw refused();
  return Object.freeze({ schemaVersion: row.schemaVersion, registryWorkspaceId: identifier(row.registryWorkspaceId), assignmentId: identifier(row.assignmentId),
    assignmentGeneration: revision(row.assignmentGeneration), leaseRevision, nonce: digest(row.nonce), requestSha256: digest(row.requestSha256),
    resultSha256: digest(row.resultSha256), evidenceSha256: digest(row.evidenceSha256), recordedLeaseRevision, recordedAt: row.recordedAt });
}
