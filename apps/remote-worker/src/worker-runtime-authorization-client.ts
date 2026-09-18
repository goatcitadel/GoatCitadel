import { randomBytes } from "node:crypto";
import { canonicalJsonString, REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
  normalizeRemoteWorkerRuntimeAuthorizationSubmission, normalizeRemoteWorkerRuntimeAuthorizationReceipt,
  normalizeRemoteWorkerRuntimeResultExpectation, type RemoteWorkerRuntimeResultExpectation } from "@goatcitadel/contracts";
import { sha256Utf8, type LeaseBinding, type RouteContext } from "./connected-worker-routes.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";

/** Every call uses a fresh challenge and signed transport proof. A receipt is
 * consumed by this call only; it cannot authorize a retry or a different lease. */
export async function authorizeWorkerRuntime(context: RouteContext, lease: LeaseBinding,
  suppliedExpectation: RemoteWorkerRuntimeResultExpectation, phase: "execution" | "delivery", signal?: AbortSignal): Promise<void> {
  const binding = Object.freeze({ ...lease }), expected = normalizeRemoteWorkerRuntimeResultExpectation(suppliedExpectation);
  const captured = Object.freeze({ ...context, credential: Object.freeze({ ...context.credential }) });
  const submission = normalizeRemoteWorkerRuntimeAuthorizationSubmission({ kind: "runtime.authorize", nonce: expected.nonce,
    requestSha256: expected.requestSha256, phase, challenge: randomBytes(32).toString("hex") });
  // A slow or interrupted observation cannot be retained for later dispatch.
  const stop = signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
  stop.throwIfAborted();
  const response = await callProtectedRoute({ ...captured, rawPath: "/api/v1/remote-workers/assignment-settlement-submissions",
    operation: "assignment.settlement.submit", idempotencyKey: `runtime-auth:${sha256Utf8(canonicalJsonString({ registryWorkspaceId: binding.registryWorkspaceId,
      assignmentId: binding.assignmentId, assignmentGeneration: binding.assignmentGeneration, leaseRevision: binding.leaseRevision, submission }))}`,
    signal: stop, payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...binding, submission } });
  stop.throwIfAborted();
  const body = response.body, receipt = normalizeRemoteWorkerRuntimeAuthorizationReceipt(body.runtimeAuthorization);
  if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" || body.operation !== "assignment.settlement.submit" ||
      body.disposition !== "runtime_authorization" || body.registryWorkspaceId !== binding.registryWorkspaceId ||
      receipt.registryWorkspaceId !== binding.registryWorkspaceId || receipt.assignmentId !== binding.assignmentId ||
      receipt.assignmentGeneration !== binding.assignmentGeneration || receipt.leaseRevision !== binding.leaseRevision ||
      canonicalJsonString(receipt.submission) !== canonicalJsonString(submission) || canonicalJsonString(receipt.expectation) !== canonicalJsonString(expected))
    throw new Error("Native runtime authorization does not bind this current request.");
}
