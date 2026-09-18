import { normalizeRemoteWorkerRuntimeResultExpectation, type RemoteWorkerRuntimeResultExpectation } from "./remote-worker-runtime-result.js";

export const REMOTE_WORKER_RUNTIME_AUTHORIZATION_SCHEMA_VERSION = "goatcitadel.remote-worker-runtime-authorization.v1" as const;
export interface RemoteWorkerRuntimeAuthorizationSubmission {
  readonly kind: "runtime.authorize";
  readonly nonce: string;
  readonly requestSha256: string;
  readonly phase: "execution" | "delivery";
  readonly challenge: string;
}
/** A fresh authority observation, never a reusable launch reservation. */
export interface RemoteWorkerRuntimeAuthorizationReceipt {
  readonly schemaVersion: typeof REMOTE_WORKER_RUNTIME_AUTHORIZATION_SCHEMA_VERSION;
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly leaseRevision: number;
  readonly submission: RemoteWorkerRuntimeAuthorizationSubmission;
  readonly expectation: RemoteWorkerRuntimeResultExpectation;
}
const refused = () => new TypeError("Native runtime authorization binding is invalid.");
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
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) throw refused();
  }
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw refused(); return value;
}
export function normalizeRemoteWorkerRuntimeAuthorizationSubmission(input: unknown): RemoteWorkerRuntimeAuthorizationSubmission {
  const value = fields(input, ["kind", "nonce", "requestSha256", "phase", "challenge"]);
  if (value.kind !== "runtime.authorize" || (value.phase !== "execution" && value.phase !== "delivery")) throw refused();
  return Object.freeze({ kind: value.kind, nonce: digest(value.nonce), requestSha256: digest(value.requestSha256), phase: value.phase, challenge: digest(value.challenge) });
}
export function normalizeRemoteWorkerRuntimeAuthorizationReceipt(input: unknown): RemoteWorkerRuntimeAuthorizationReceipt {
  const value = fields(input, ["schemaVersion", "registryWorkspaceId", "assignmentId", "assignmentGeneration", "leaseRevision", "submission", "expectation"]);
  if (value.schemaVersion !== REMOTE_WORKER_RUNTIME_AUTHORIZATION_SCHEMA_VERSION) throw refused();
  const submission = normalizeRemoteWorkerRuntimeAuthorizationSubmission(value.submission), expectation = normalizeRemoteWorkerRuntimeResultExpectation(value.expectation);
  if (submission.nonce !== expectation.nonce || submission.requestSha256 !== expectation.requestSha256) throw refused();
  return Object.freeze({ schemaVersion: value.schemaVersion, registryWorkspaceId: identifier(value.registryWorkspaceId), assignmentId: identifier(value.assignmentId),
    assignmentGeneration: revision(value.assignmentGeneration), leaseRevision: revision(value.leaseRevision), submission, expectation });
}
