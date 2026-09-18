import { randomBytes } from "node:crypto";
import { canonicalJsonString, REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, normalizeRemoteWorkerRuntimeOutcomeSubmission,
  normalizeRemoteWorkerRuntimeOutcomeExchange, normalizeRemoteWorkerRuntimeResultExpectation, type RemoteWorkerRuntimeResultExpectation } from "@goatcitadel/contracts";
import { sha256Utf8, type RouteContext, type LeaseBinding } from "./connected-worker-routes.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";

/** Read recorded exit/check facts without treating them as Chat completion or
 * permission to relaunch. A missing outcome remains explicitly null. */
export async function readWorkerRuntimeOutcome(context: RouteContext, lease: LeaseBinding,
  suppliedExpectation: RemoteWorkerRuntimeResultExpectation, signal?: AbortSignal) {
  const expected = normalizeRemoteWorkerRuntimeResultExpectation(suppliedExpectation), binding = Object.freeze({ ...lease });
  const route = Object.freeze({ ...context, credential: Object.freeze({ ...context.credential }) });
  const submission = normalizeRemoteWorkerRuntimeOutcomeSubmission({ kind: "runtime.outcome.read", nonce: expected.nonce,
    requestSha256: expected.requestSha256, challenge: randomBytes(32).toString("hex") });
  const deadline = AbortSignal.timeout(5000), stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  stop.throwIfAborted();
  const response = await callProtectedRoute({ ...route, rawPath: "/api/v1/remote-workers/assignment-settlement-submissions",
    operation: "assignment.settlement.submit", idempotencyKey: `runtime-outcome:${sha256Utf8(canonicalJsonString({ registryWorkspaceId: binding.registryWorkspaceId,
      assignmentId: binding.assignmentId, assignmentGeneration: binding.assignmentGeneration, leaseRevision: binding.leaseRevision, submission }))}`,
    signal: stop, payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...binding, submission } });
  stop.throwIfAborted();
  const body = response.body, result = normalizeRemoteWorkerRuntimeOutcomeExchange(body.runtimeOutcome), lookup = result.lookup;
  if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" || body.operation !== "assignment.settlement.submit" ||
      body.disposition !== "runtime_outcome" || body.registryWorkspaceId !== binding.registryWorkspaceId || result.challenge !== submission.challenge ||
      lookup.registryWorkspaceId !== binding.registryWorkspaceId || lookup.assignmentId !== binding.assignmentId || lookup.assignmentGeneration !== binding.assignmentGeneration ||
      lookup.leaseRevision !== binding.leaseRevision || lookup.nonce !== expected.nonce || lookup.requestSha256 !== expected.requestSha256 ||
      (result.outcome && (result.outcome.stdinBytes > expected.maxInputBytes || result.outcome.stdoutBytes + result.outcome.stderrBytes > expected.maxOutputBytes ||
        (result.outcome.inventoryEntries ?? 0) > expected.maxInventoryEntries))) throw new Error("Native outcome does not bind the admitted request.");
  return result;
}
