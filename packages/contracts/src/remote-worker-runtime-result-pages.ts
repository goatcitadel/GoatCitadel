import { REMOTE_WORKER_RUNTIME_RESULT_MAX_BYTES } from "./remote-worker-runtime-result.js";

export const REMOTE_WORKER_RUNTIME_RESULT_PAGE_BYTES = 32768;
export const REMOTE_WORKER_RUNTIME_RESULT_EXCHANGE_SCHEMA_VERSION = "goatcitadel.remote-worker-runtime-result-exchange.v1" as const;
export interface RemoteWorkerRuntimeResultPage {
  readonly kind: "runtime.result.page";
  readonly nonce: string;
  readonly requestSha256: string;
  readonly resultSha256: string;
  readonly byteLength: number;
  readonly offset: number;
  readonly bytesHex: string;
}
export type RemoteWorkerRuntimeResultSubmission = RemoteWorkerRuntimeResultPage | Readonly<{
  kind: "runtime.result.lookup"; nonce: string; requestSha256: string;
}>;
export interface RemoteWorkerRuntimeResultReceipt {
  readonly resultSha256: string;
  readonly byteLength: number;
  readonly leaseRevision: number;
  readonly recordedAt: string;
}
export interface RemoteWorkerRuntimeResultExchange {
  readonly schemaVersion: typeof REMOTE_WORKER_RUNTIME_RESULT_EXCHANGE_SCHEMA_VERSION;
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly leaseRevision: number;
  readonly nonce: string;
  readonly requestSha256: string;
  readonly record: RemoteWorkerRuntimeResultReceipt | null;
  readonly accepted: Readonly<{ page: RemoteWorkerRuntimeResultPage; nextOffset: number }> | null;
}
const refused = () => new TypeError("Runtime result page or receipt does not bind its protected request.");
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw refused();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw refused();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value) || /^0+$/u.test(value)) throw refused(); return value;
}
function integer(value: unknown, min: number, max = 2147483647): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw refused(); return value;
}
function size(value: unknown): number {
  const bytes = integer(value, 256, REMOTE_WORKER_RUNTIME_RESULT_MAX_BYTES);
  if (bytes !== 256 && (bytes < 1608 || (bytes - 608) % 1000)) throw refused(); return bytes;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256) throw refused();
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) throw refused();
  }
  return value;
}
export function normalizeRemoteWorkerRuntimeResultSubmission(input: unknown): RemoteWorkerRuntimeResultSubmission {
  const kind = input && typeof input === "object" ? Object.getOwnPropertyDescriptor(input, "kind")?.value : undefined;
  if (kind !== "runtime.result.lookup" && kind !== "runtime.result.page") throw refused();
  const value = fields(input, kind === "runtime.result.lookup" ? ["kind", "nonce", "requestSha256"] :
    ["kind", "nonce", "requestSha256", "resultSha256", "byteLength", "offset", "bytesHex"]);
  const nonce = digest(value.nonce), requestSha256 = digest(value.requestSha256);
  if (kind === "runtime.result.lookup") return Object.freeze({ kind, nonce, requestSha256 });
  const byteLength = size(value.byteLength), offset = integer(value.offset, 0, byteLength - 1);
  if (offset % REMOTE_WORKER_RUNTIME_RESULT_PAGE_BYTES || typeof value.bytesHex !== "string" ||
      value.bytesHex.length !== Math.min(REMOTE_WORKER_RUNTIME_RESULT_PAGE_BYTES, byteLength - offset) * 2 || !/^[0-9a-f]+$/u.test(value.bytesHex)) throw refused();
  return Object.freeze({ kind, nonce, requestSha256, resultSha256: digest(value.resultSha256), byteLength, offset, bytesHex: value.bytesHex });
}
export function normalizeRemoteWorkerRuntimeResultExchange(input: unknown): RemoteWorkerRuntimeResultExchange {
  const value = fields(input, ["schemaVersion", "registryWorkspaceId", "assignmentId", "assignmentGeneration", "leaseRevision", "nonce", "requestSha256", "record", "accepted"]);
  if (value.schemaVersion !== REMOTE_WORKER_RUNTIME_RESULT_EXCHANGE_SCHEMA_VERSION) throw refused();
  const binding = { schemaVersion: REMOTE_WORKER_RUNTIME_RESULT_EXCHANGE_SCHEMA_VERSION, registryWorkspaceId: identifier(value.registryWorkspaceId),
    assignmentId: identifier(value.assignmentId), assignmentGeneration: integer(value.assignmentGeneration, 1), leaseRevision: integer(value.leaseRevision, 1),
    nonce: digest(value.nonce), requestSha256: digest(value.requestSha256) };
  let record: RemoteWorkerRuntimeResultReceipt | null = null, accepted: RemoteWorkerRuntimeResultExchange["accepted"] = null;
  if (value.record !== null) {
    record = normalizeRemoteWorkerRuntimeResultReceipt(value.record);
    if (record.leaseRevision > binding.leaseRevision) throw refused();
  }
  if (value.accepted !== null) {
    const receipt = fields(value.accepted, ["page", "nextOffset"]), page = normalizeRemoteWorkerRuntimeResultSubmission(receipt.page);
    if (page.kind !== "runtime.result.page" || page.nonce !== binding.nonce || page.requestSha256 !== binding.requestSha256) throw refused();
    const nextOffset = integer(receipt.nextOffset, page.offset + page.bytesHex.length / 2, page.byteLength);
    if (record ? nextOffset !== page.byteLength || record.resultSha256 !== page.resultSha256 || record.byteLength !== page.byteLength :
      nextOffset === page.byteLength || nextOffset % REMOTE_WORKER_RUNTIME_RESULT_PAGE_BYTES !== 0) throw refused();
    accepted = Object.freeze({ page, nextOffset });
  }
  return Object.freeze({ ...binding, record, accepted });
}
export function normalizeRemoteWorkerRuntimeResultReceipt(input: unknown): RemoteWorkerRuntimeResultReceipt {
  const row = fields(input, ["resultSha256", "byteLength", "leaseRevision", "recordedAt"]);
  if (typeof row.recordedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.recordedAt) ||
      !Number.isFinite(Date.parse(row.recordedAt)) || new Date(row.recordedAt).toISOString() !== row.recordedAt) throw refused();
  return Object.freeze({ resultSha256: digest(row.resultSha256), byteLength: size(row.byteLength),
    leaseRevision: integer(row.leaseRevision, 1), recordedAt: row.recordedAt });
}
