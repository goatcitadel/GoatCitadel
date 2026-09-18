import { createHash } from "node:crypto";
import { canonicalJsonString, normalizeRemoteWorkerRuntimeRequestPageSubmission, normalizeRemoteWorkerRuntimeRequestPage,
  REMOTE_WORKER_RUNTIME_REQUEST_PAGE_SCHEMA, REMOTE_WORKER_RUNTIME_REQUEST_PAGE_BYTES, REMOTE_WORKER_RUNTIME_REQUEST_MAX_BYTES,
  type RemoteWorkerRuntimeRequestPageSubmission } from "@goatcitadel/contracts";
import { normalizeWindowsRuntimeDispatch, prepareWindowsRuntimeDispatch } from "@goatcitadel/contracts/remote-worker-runtime-node";
import { snapshotRemoteWorkerCellCapacityAuthority } from "@goatcitadel/storage";
import type { RemoteWorkerRuntimeRequestProducer } from "./remote-worker-runtime-request-producer.js";
import { rejected } from "./remote-worker-assignment-execution-validators.js";

export type RemoteWorkerRuntimeRequestSelectionPort = Pick<RemoteWorkerRuntimeRequestProducer, "selectAdmittedForAssignment">;
export async function readRemoteWorkerRuntimeRequestPage(owner: RemoteWorkerRuntimeRequestSelectionPort | undefined,
  input: Parameters<RemoteWorkerRuntimeRequestProducer["selectAdmittedForAssignment"]>[0] & { submission: RemoteWorkerRuntimeRequestPageSubmission }) {
  if (!owner) throw rejected("Native workload selection is unavailable.");
  const authority = snapshotRemoteWorkerCellCapacityAuthority(input), signal = input.signal;
  const submission = normalizeRemoteWorkerRuntimeRequestPageSubmission(input.submission);
  signal?.throwIfAborted();
  const selected = await owner.selectAdmittedForAssignment({ ...authority, signal,
    ...(submission.continuation ? { continuation: submission.continuation } : {}) });
  signal?.throwIfAborted();
  const request = normalizeWindowsRuntimeDispatch(selected.request), expectation = prepareWindowsRuntimeDispatch(request).expectation;
  if (canonicalJsonString(expectation) !== canonicalJsonString(selected.expectation)) throw rejected("Native request selection is inconsistent.");
  const bytes = Buffer.from(canonicalJsonString(request), "utf8");
  if (bytes.length > REMOTE_WORKER_RUNTIME_REQUEST_MAX_BYTES) throw rejected("Native request exceeds the transfer limit.");
  return normalizeRemoteWorkerRuntimeRequestPage({ schemaVersion: REMOTE_WORKER_RUNTIME_REQUEST_PAGE_SCHEMA,
    registryWorkspaceId: authority.registryWorkspaceId, assignmentId: authority.assignmentId, assignmentGeneration: authority.assignmentGeneration,
    leaseRevision: authority.leaseRevision, submission, expectation, totalBytes: bytes.length,
    jsonSha256: createHash("sha256").update(bytes).digest("hex"), bytesHex: bytes.subarray(submission.offset, submission.offset + REMOTE_WORKER_RUNTIME_REQUEST_PAGE_BYTES).toString("hex") });
}
