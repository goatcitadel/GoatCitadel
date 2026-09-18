import { normalizeRemoteWorkerRuntimeResultExpectation, type RemoteWorkerRuntimeResultExpectation } from "./remote-worker-runtime-result.js";
import { normalizeRemoteWorkerNativeContinuation, type RemoteWorkerNativeContinuation } from "./remote-worker-native-continuation.js";

export const REMOTE_WORKER_RUNTIME_REQUEST_PAGE_BYTES = 32768;
export const REMOTE_WORKER_RUNTIME_REQUEST_MAX_BYTES = 4 * 1024 * 1024;
export const REMOTE_WORKER_RUNTIME_REQUEST_PAGE_SCHEMA = "goatcitadel.remote-worker-runtime-request-page.v1" as const;
export interface RemoteWorkerRuntimeRequestPageSubmission {
  readonly kind: "runtime.request.page";
  readonly offset: number;
  readonly nonce: string | null;
  readonly requestSha256: string | null;
  readonly challenge: string;
  readonly continuation?: RemoteWorkerNativeContinuation;
}
export interface RemoteWorkerRuntimeRequestPage {
  readonly schemaVersion: typeof REMOTE_WORKER_RUNTIME_REQUEST_PAGE_SCHEMA;
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly leaseRevision: number;
  readonly submission: RemoteWorkerRuntimeRequestPageSubmission;
  readonly expectation: RemoteWorkerRuntimeResultExpectation;
  readonly totalBytes: number;
  readonly jsonSha256: string;
  readonly bytesHex: string;
}
const refused = () => new TypeError("Native request page binding is invalid.");
function fields(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw refused();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw refused();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value) || /^0+$/u.test(value)) throw refused(); return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw refused(); return value;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256) throw refused();
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) throw refused();
  }
  return value;
}
export function normalizeRemoteWorkerRuntimeRequestPageSubmission(input: unknown): RemoteWorkerRuntimeRequestPageSubmission {
  const hasContinuation = Boolean(input && typeof input === "object" && Object.hasOwn(input, "continuation"));
  const value = fields(input, ["kind", "offset", "nonce", "requestSha256", "challenge", ...(hasContinuation ? ["continuation"] : [])]);
  if (value.kind !== "runtime.request.page") throw refused();
  const offset = integer(value.offset, 0, REMOTE_WORKER_RUNTIME_REQUEST_MAX_BYTES - 1);
  if (offset % REMOTE_WORKER_RUNTIME_REQUEST_PAGE_BYTES || ((value.nonce === null || value.requestSha256 === null) &&
      (offset !== 0 || value.nonce !== null || value.requestSha256 !== null))) throw refused();
  const continuation = hasContinuation ? normalizeRemoteWorkerNativeContinuation(value.continuation) : undefined;
  if (continuation && continuation.decision !== "approved") throw refused();
  return Object.freeze({ kind: value.kind, offset, nonce: value.nonce === null ? null : digest(value.nonce),
    requestSha256: value.requestSha256 === null ? null : digest(value.requestSha256), challenge: digest(value.challenge),
    ...(continuation ? { continuation } : {}) });
}
export function normalizeRemoteWorkerRuntimeRequestPage(input: unknown): RemoteWorkerRuntimeRequestPage {
  const value = fields(input, ["schemaVersion", "registryWorkspaceId", "assignmentId", "assignmentGeneration", "leaseRevision", "submission", "expectation", "totalBytes", "jsonSha256", "bytesHex"]);
  if (value.schemaVersion !== REMOTE_WORKER_RUNTIME_REQUEST_PAGE_SCHEMA) throw refused();
  const submission = normalizeRemoteWorkerRuntimeRequestPageSubmission(value.submission), expectation = normalizeRemoteWorkerRuntimeResultExpectation(value.expectation);
  const totalBytes = integer(value.totalBytes, 1, REMOTE_WORKER_RUNTIME_REQUEST_MAX_BYTES);
  if ((submission.nonce !== null && (submission.nonce !== expectation.nonce || submission.requestSha256 !== expectation.requestSha256)) ||
      submission.offset >= totalBytes || typeof value.bytesHex !== "string" || !/^[0-9a-f]+$/u.test(value.bytesHex) ||
      value.bytesHex.length !== 2 * Math.min(REMOTE_WORKER_RUNTIME_REQUEST_PAGE_BYTES, totalBytes - submission.offset)) throw refused();
  return Object.freeze({ schemaVersion: value.schemaVersion, registryWorkspaceId: identifier(value.registryWorkspaceId), assignmentId: identifier(value.assignmentId),
    assignmentGeneration: integer(value.assignmentGeneration, 1, 2147483647), leaseRevision: integer(value.leaseRevision, 1, 2147483647),
    submission, expectation, totalBytes, jsonSha256: digest(value.jsonSha256), bytesHex: value.bytesHex });
}
