import { canonicalJsonString } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import { normalizeRemoteWorkerRuntimeResultExpectation } from "./remote-worker-runtime-result.js";
import { normalizeRemoteWorkerRuntimeResultReceipt } from "./remote-worker-runtime-result-pages.js";
import { normalizeRemoteWorkerRuntimeOutcome } from "./remote-worker-runtime-outcome.js";

export const REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA = "goatcitadel.remote-worker-runtime-output.v1" as const;
export const REMOTE_WORKER_RUNTIME_OUTPUT_TEXT_MAX_BYTES = 32 * 1024;
export interface RemoteWorkerRuntimeStreamDiagnostic {
  readonly bytes: number;
  /** Hash of all bytes observed by the protected parent, before redaction. */
  readonly sha256: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly provenance: "native_stream_local_diagnostic";
}
/** Redacted stream evidence, not a raw file artifact or proof of task success. */
export interface RemoteWorkerRuntimeOutputEvidence {
  readonly schemaVersion: typeof REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA;
  readonly nonce: string;
  readonly requestSha256: string;
  readonly resultSha256: string;
  readonly streams: Readonly<{ stdout: RemoteWorkerRuntimeStreamDiagnostic; stderr: RemoteWorkerRuntimeStreamDiagnostic }>;
}
const refused = () => new TypeError("Native runtime output evidence is invalid or differs from its retained result.");
function fields(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw refused();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== names.length || names.some(name => !descriptors[name]?.enumerable || !("value" in descriptors[name]))) throw refused();
  return Object.fromEntries(names.map(name => [name, descriptors[name]!.value]));
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value) || /^0+$/u.test(value)) throw refused();
  return value;
}
function stream(input: unknown): RemoteWorkerRuntimeStreamDiagnostic {
  const row = fields(input, ["bytes", "sha256", "text", "truncated", "provenance"]);
  if (typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || row.bytes < 0 ||
      typeof row.text !== "string" || new TextEncoder().encode(row.text).length > REMOTE_WORKER_RUNTIME_OUTPUT_TEXT_MAX_BYTES ||
      typeof row.truncated !== "boolean" || row.provenance !== "native_stream_local_diagnostic") throw refused();
  const hash = digest(row.sha256);
  if (row.bytes === 0 && (hash !== sha256Hex("") || row.text !== "" || row.truncated)) throw refused();
  return Object.freeze({ bytes: row.bytes, sha256: hash, text: row.text, truncated: row.truncated, provenance: row.provenance });
}
export function normalizeRemoteWorkerRuntimeOutputEvidence(input: unknown): RemoteWorkerRuntimeOutputEvidence {
  const row = fields(input, ["schemaVersion", "nonce", "requestSha256", "resultSha256", "streams"]);
  if (row.schemaVersion !== REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA) throw refused();
  const streams = fields(row.streams, ["stdout", "stderr"]);
  return Object.freeze({ schemaVersion: row.schemaVersion, nonce: digest(row.nonce), requestSha256: digest(row.requestSha256),
    resultSha256: digest(row.resultSha256), streams: Object.freeze({ stdout: stream(streams.stdout), stderr: stream(streams.stderr) }) });
}
/** Call with independently read canonical expectation, receipt and outcome.
 * Content hashes are parent-reported; matching counts do not independently
 * verify the text against native file bytes. Redaction may change text length. */
export function verifyRemoteWorkerRuntimeOutputEvidence(input: unknown, expectedInput: unknown, receiptInput: unknown, outcomeInput: unknown): RemoteWorkerRuntimeOutputEvidence {
  const evidence = normalizeRemoteWorkerRuntimeOutputEvidence(input);
  const expected = normalizeRemoteWorkerRuntimeResultExpectation(expectedInput);
  const receipt = normalizeRemoteWorkerRuntimeResultReceipt(receiptInput), outcome = normalizeRemoteWorkerRuntimeOutcome(outcomeInput);
  if (evidence.nonce !== expected.nonce || evidence.requestSha256 !== expected.requestSha256 || evidence.resultSha256 !== receipt.resultSha256 ||
      !outcome.checks.bindingVerified || !outcome.checks.captureVerified || !outcome.checks.outputDrained || !outcome.checks.zeroProcessesVerified ||
      evidence.streams.stdout.bytes !== outcome.stdoutBytes || evidence.streams.stderr.bytes !== outcome.stderrBytes ||
      evidence.streams.stdout.bytes + evidence.streams.stderr.bytes > expected.maxOutputBytes) throw refused();
  return evidence;
}
export function remoteWorkerRuntimeOutputEvidenceSha256(input: RemoteWorkerRuntimeOutputEvidence): string {
  return sha256Hex(canonicalJsonString(normalizeRemoteWorkerRuntimeOutputEvidence(input)));
}
