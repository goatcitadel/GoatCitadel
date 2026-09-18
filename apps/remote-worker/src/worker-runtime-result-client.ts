import { canonicalJsonString, REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
  REMOTE_WORKER_RUNTIME_RESULT_PAGE_BYTES, normalizeRemoteWorkerRuntimeResultSubmission, normalizeRemoteWorkerRuntimeResultExchange,
  readRemoteWorkerRuntimeResult, normalizeRemoteWorkerRuntimeResultExpectation, normalizeRemoteWorkerCellProvisioningExchange,
  type RemoteWorkerRuntimeResultSubmission, type RemoteWorkerRuntimeResultExchange, type RemoteWorkerRuntimeResultExpectation,
  type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";
import { sha256Utf8, type LeaseBinding, type RouteContext } from "./connected-worker-routes.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";

/** Exact lookup is the recovery path after a lost final acknowledgment. It
 * never dispatches or retries a workload and cannot create its expectation. */
export async function exchangeWorkerRuntimeResult(context: RouteContext, lease: LeaseBinding,
  submission: RemoteWorkerRuntimeResultSubmission, signal?: AbortSignal): Promise<RemoteWorkerRuntimeResultExchange> {
  const binding = Object.freeze({ ...lease }), selection = normalizeRemoteWorkerRuntimeResultSubmission(submission);
  signal?.throwIfAborted();
  const response = await callProtectedRoute({ ...context, rawPath: "/api/v1/remote-workers/assignment-settlement-submissions",
    operation: "assignment.settlement.submit", idempotencyKey: `runtime-result:${sha256Utf8(canonicalJsonString({ registryWorkspaceId: binding.registryWorkspaceId,
      assignmentId: binding.assignmentId, assignmentGeneration: binding.assignmentGeneration, leaseRevision: binding.leaseRevision, submission: selection }))}`,
    signal, payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...binding, submission: selection } });
  signal?.throwIfAborted();
  const body = response.body, result = normalizeRemoteWorkerRuntimeResultExchange(body.runtimeResult);
  if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" || body.operation !== "assignment.settlement.submit" ||
      body.disposition !== "runtime_result" || body.registryWorkspaceId !== binding.registryWorkspaceId || result.registryWorkspaceId !== binding.registryWorkspaceId ||
      result.assignmentId !== binding.assignmentId || result.assignmentGeneration !== binding.assignmentGeneration || result.leaseRevision !== binding.leaseRevision ||
      result.nonce !== selection.nonce || result.requestSha256 !== selection.requestSha256 ||
      (selection.kind === "runtime.result.lookup" ? result.accepted !== null : !result.accepted || canonicalJsonString(result.accepted.page) !== canonicalJsonString(selection)))
    throw new Error("Worker runtime result receipt does not bind this assignment submission.");
  return result;
}

/** Validate a complete terminal result against independently retained request
 * metadata before sending any page. Interrupted uploads are not auto-retried. */
export async function uploadWorkerRuntimeResult(context: RouteContext, lease: LeaseBinding, resultHex: string,
  suppliedExpectation: RemoteWorkerRuntimeResultExpectation, suppliedHistory: RemoteWorkerCellProvisioningExchange,
  signal?: AbortSignal): Promise<RemoteWorkerRuntimeResultExchange> {
  const binding = Object.freeze({ ...lease }), expectation = normalizeRemoteWorkerRuntimeResultExpectation(suppliedExpectation);
  const history = normalizeRemoteWorkerCellProvisioningExchange(suppliedHistory);
  if (history.registryWorkspaceId !== binding.registryWorkspaceId || history.assignmentId !== binding.assignmentId ||
      history.assignmentGeneration !== binding.assignmentGeneration || history.leaseRevision !== binding.leaseRevision)
    throw new Error("Worker runtime result does not bind this assignment lease.");
  signal?.throwIfAborted();
  const decoded = readRemoteWorkerRuntimeResult(resultHex, expectation, history);
  let result: RemoteWorkerRuntimeResultExchange | undefined;
  for (let offset = 0; offset < decoded.byteLength; offset += REMOTE_WORKER_RUNTIME_RESULT_PAGE_BYTES) {
    signal?.throwIfAborted();
    result = await exchangeWorkerRuntimeResult(context, binding, { kind: "runtime.result.page", nonce: expectation.nonce,
      requestSha256: expectation.requestSha256, resultSha256: decoded.resultSha256, byteLength: decoded.byteLength, offset,
      bytesHex: resultHex.slice(offset * 2, (offset + REMOTE_WORKER_RUNTIME_RESULT_PAGE_BYTES) * 2) }, signal);
  }
  if (!result?.record || result.record.resultSha256 !== decoded.resultSha256 || result.record.byteLength !== decoded.byteLength)
    throw new Error("Worker runtime result did not receive its exact retained receipt.");
  return result;
}
