import { randomBytes } from "node:crypto";
import { canonicalJsonString, REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, normalizeRemoteWorkerRuntimeCleanupSubmission,
  normalizeRemoteWorkerRuntimeCleanupExchange } from "@goatcitadel/contracts";
import { sha256Utf8, type RouteContext, type LeaseBinding } from "./connected-worker-routes.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";

/** Read the complete historical set through current protected assignment
 * authority. No cached response grants permission to measure or execute. */
export async function readWorkerRuntimeCleanup(context: RouteContext, lease: LeaseBinding, signal?: AbortSignal) {
  const binding = Object.freeze({ ...lease }), route = Object.freeze({ ...context, credential: Object.freeze({ ...context.credential }) });
  const submission = normalizeRemoteWorkerRuntimeCleanupSubmission({ kind: "runtime.cleanup.read", challenge: randomBytes(32).toString("hex") });
  const deadline = AbortSignal.timeout(5000), stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  stop.throwIfAborted();
  const response = await callProtectedRoute({ ...route, rawPath: "/api/v1/remote-workers/assignment-settlement-submissions",
    operation: "assignment.settlement.submit", idempotencyKey: `runtime-cleanup:${sha256Utf8(canonicalJsonString({ registryWorkspaceId: binding.registryWorkspaceId,
      assignmentId: binding.assignmentId, assignmentGeneration: binding.assignmentGeneration, leaseRevision: binding.leaseRevision, submission }))}`,
    signal: stop, payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...binding, submission } });
  stop.throwIfAborted();
  const body = response.body, result = normalizeRemoteWorkerRuntimeCleanupExchange(body.runtimeCleanup), history = result.history;
  if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" || body.operation !== "assignment.settlement.submit" ||
      body.disposition !== "runtime_cleanup" || body.registryWorkspaceId !== binding.registryWorkspaceId || result.challenge !== submission.challenge ||
      history.registryWorkspaceId !== binding.registryWorkspaceId || history.assignmentId !== binding.assignmentId ||
      history.assignmentGeneration !== binding.assignmentGeneration || history.leaseRevision !== binding.leaseRevision)
    throw new Error("Native cleanup history does not bind this lease.");
  return result;
}
