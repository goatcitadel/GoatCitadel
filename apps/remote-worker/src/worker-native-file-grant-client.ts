import { randomBytes } from "node:crypto";
import { canonicalJsonString, REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
  normalizeRemoteWorkerNativeFileGrantSubmission, normalizeRemoteWorkerNativeFileGrantReceipt,
  type RemoteWorkerNativeFileExportSelection, type RemoteWorkerNativeFileStaging } from "@goatcitadel/contracts";
import { sha256Utf8, type LeaseBinding, type RouteContext } from "./connected-worker-routes.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";

/** Used immediately at the native file boundary. Carries no content and cannot
 * grant model/channel publication or replace a subsequent transfer check. */
export async function authorizeWorkerNativeFile(context: RouteContext, lease: LeaseBinding, selection: RemoteWorkerNativeFileExportSelection,
  fileStaging: RemoteWorkerNativeFileStaging, signal: AbortSignal): Promise<void> {
  await requestWorkerNativeFileGrant(context, lease, selection, fileStaging, signal);
}
/** Returns canonical disclosure metadata for a declaration, never a reusable permission. */
export async function requestWorkerNativeFileGrant(context: RouteContext, lease: LeaseBinding, selection: RemoteWorkerNativeFileExportSelection,
  fileStaging: RemoteWorkerNativeFileStaging, signal: AbortSignal) {
  const binding = Object.freeze({ ...lease }), captured = Object.freeze({ ...context, credential: Object.freeze({ ...context.credential }) });
  const submission = normalizeRemoteWorkerNativeFileGrantSubmission({ kind: "runtime.file.authorize", selection, fileStaging, challenge: randomBytes(32).toString("hex") });
  if (submission.selection.registryWorkspaceId !== binding.registryWorkspaceId || submission.selection.assignmentId !== binding.assignmentId || submission.selection.assignmentGeneration !== binding.assignmentGeneration)
    throw new Error("Native file grant requires its current assignment.");
  const stop = AbortSignal.any([signal, AbortSignal.timeout(5000)]); stop.throwIfAborted();
  const response = await callProtectedRoute({ ...captured, rawPath: "/api/v1/remote-workers/assignment-settlement-submissions",
    operation: "assignment.settlement.submit", idempotencyKey: `native-file-auth:${sha256Utf8(canonicalJsonString({ registryWorkspaceId: binding.registryWorkspaceId,
      assignmentId: binding.assignmentId, assignmentGeneration: binding.assignmentGeneration, leaseRevision: binding.leaseRevision, submission }))}`,
    signal: stop, payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...binding, submission } });
  stop.throwIfAborted();
  const body = response.body, receipt = normalizeRemoteWorkerNativeFileGrantReceipt(body.nativeFileGrant);
  if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" || body.operation !== "assignment.settlement.submit" ||
      body.disposition !== "native_file_grant" || body.registryWorkspaceId !== binding.registryWorkspaceId || receipt.leaseRevision !== binding.leaseRevision ||
      canonicalJsonString(receipt.submission) !== canonicalJsonString(submission)) throw new Error("Native file authorization does not bind this protected request.");
  return receipt;
}
