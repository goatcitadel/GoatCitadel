import { randomBytes } from "node:crypto";
import { canonicalJsonString, REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
  normalizeRemoteWorkerNativeFileReconciliationSubmission, normalizeRemoteWorkerNativeFileReconciliationExchange,
  type RemoteWorkerRuntimeResultExpectation } from "@goatcitadel/contracts";
import { sha256Utf8, type LeaseBinding, type RouteContext } from "./connected-worker-routes.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";

/** Fresh challenge prevents a cached pending lookup becoming completion truth.
 * This carries metadata only; it neither uploads files nor dispatches execution. */
export async function reconcileWorkerNativeFiles(context: RouteContext, lease: LeaseBinding,
  expected: Pick<RemoteWorkerRuntimeResultExpectation, "nonce" | "requestSha256">, signal?: AbortSignal) {
  const binding = Object.freeze({ ...lease });
  const submission = normalizeRemoteWorkerNativeFileReconciliationSubmission({ kind: "runtime.files.reconcile",
    nonce: expected.nonce, requestSha256: expected.requestSha256, challenge: randomBytes(32).toString("hex") });
  signal?.throwIfAborted();
  const response = await callProtectedRoute({ ...context, rawPath: "/api/v1/remote-workers/assignment-settlement-submissions",
    operation: "assignment.settlement.submit", idempotencyKey: `native-files:${sha256Utf8(canonicalJsonString({ ...binding, submission }))}`,
    signal, payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...binding, submission } });
  signal?.throwIfAborted();
  const body = response.body, result = normalizeRemoteWorkerNativeFileReconciliationExchange(body.nativeFileReconciliation), lookup = result.lookup;
  if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" || body.operation !== "assignment.settlement.submit" ||
      body.disposition !== "native_file_reconciliation" || body.registryWorkspaceId !== binding.registryWorkspaceId || result.challenge !== submission.challenge ||
      lookup.registryWorkspaceId !== binding.registryWorkspaceId || lookup.assignmentId !== binding.assignmentId || lookup.assignmentGeneration !== binding.assignmentGeneration ||
      lookup.leaseRevision !== binding.leaseRevision || lookup.nonce !== submission.nonce || lookup.requestSha256 !== submission.requestSha256)
    throw new Error("Native file reconciliation does not bind the current protected request.");
  return result;
}
