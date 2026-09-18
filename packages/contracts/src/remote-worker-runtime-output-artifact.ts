import { canonicalJsonString } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import { normalizeRemoteWorkerRuntimeReadKey } from "./remote-worker-runtime-read.js";
import { normalizeRemoteWorkerRuntimeResultExpectation, type RemoteWorkerRuntimeResultExpectation } from "./remote-worker-runtime-result.js";
import { normalizeRemoteWorkerRuntimeResultReceipt, type RemoteWorkerRuntimeResultReceipt } from "./remote-worker-runtime-result-pages.js";
import { normalizeRemoteWorkerRuntimeOutcome, type RemoteWorkerRuntimeOutcome } from "./remote-worker-runtime-outcome.js";
import { verifyRemoteWorkerRuntimeOutputEvidence, remoteWorkerRuntimeOutputEvidenceSha256, type RemoteWorkerRuntimeOutputEvidence } from "./remote-worker-runtime-output.js";

export const REMOTE_WORKER_RUNTIME_OUTPUT_ARTIFACT_SCHEMA = "goatcitadel.remote-worker-native-output-artifact.v1" as const;
/** A downloadable evidence document, not a verified model or native-file artifact. */
export interface RemoteWorkerRuntimeOutputArtifact {
  readonly schemaVersion: typeof REMOTE_WORKER_RUNTIME_OUTPUT_ARTIFACT_SCHEMA;
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly expectation: RemoteWorkerRuntimeResultExpectation;
  readonly resultReceipt: RemoteWorkerRuntimeResultReceipt;
  readonly outcome: RemoteWorkerRuntimeOutcome;
  readonly output: RemoteWorkerRuntimeOutputEvidence;
  readonly evidenceSha256: string;
  readonly recordedLeaseRevision: number;
  readonly recordedAt: string;
}
const invalid = () => new TypeError("Native output artifact is invalid or differs from retained evidence.");
export function normalizeRemoteWorkerRuntimeOutputArtifact(input: unknown): RemoteWorkerRuntimeOutputArtifact {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
  const keys = ["schemaVersion", "registryWorkspaceId", "assignmentId", "assignmentGeneration", "expectation", "resultReceipt", "outcome", "output", "evidenceSha256", "recordedLeaseRevision", "recordedAt"];
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw invalid();
  const row = Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
  if (row.schemaVersion !== REMOTE_WORKER_RUNTIME_OUTPUT_ARTIFACT_SCHEMA || !Number.isSafeInteger(row.assignmentGeneration) || row.assignmentGeneration < 1 || row.assignmentGeneration > 2147483647) throw invalid();
  const scope = normalizeRemoteWorkerRuntimeReadKey({ registryWorkspaceId: row.registryWorkspaceId, assignmentId: row.assignmentId });
  const expectation = normalizeRemoteWorkerRuntimeResultExpectation(row.expectation), resultReceipt = normalizeRemoteWorkerRuntimeResultReceipt(row.resultReceipt);
  const outcome = normalizeRemoteWorkerRuntimeOutcome(row.outcome), output = verifyRemoteWorkerRuntimeOutputEvidence(row.output, expectation, resultReceipt, outcome);
  if (row.evidenceSha256 !== remoteWorkerRuntimeOutputEvidenceSha256(output) || !Number.isSafeInteger(row.recordedLeaseRevision) ||
      row.recordedLeaseRevision < resultReceipt.leaseRevision || row.recordedLeaseRevision > 2147483647 || typeof row.recordedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.recordedAt) || !Number.isFinite(Date.parse(row.recordedAt)) ||
      new Date(row.recordedAt).toISOString() !== row.recordedAt || Date.parse(row.recordedAt) < Date.parse(resultReceipt.recordedAt)) throw invalid();
  return Object.freeze({ schemaVersion: row.schemaVersion, ...scope, assignmentGeneration: row.assignmentGeneration, expectation, resultReceipt, outcome,
    output, evidenceSha256: row.evidenceSha256, recordedLeaseRevision: row.recordedLeaseRevision, recordedAt: row.recordedAt });
}
export function serializeRemoteWorkerRuntimeOutputArtifact(input: RemoteWorkerRuntimeOutputArtifact) {
  const document = normalizeRemoteWorkerRuntimeOutputArtifact(input), content = canonicalJsonString(document) + "\n";
  return Object.freeze({ document, content, fileName: `native-output-${document.evidenceSha256}.json`, contentType: "application/json" as const,
    byteLength: new TextEncoder().encode(content).length, sha256: sha256Hex(content) });
}
