import { canonicalJsonString, REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
  normalizeRemoteWorkerRuntimeOutputSubmission, normalizeRemoteWorkerRuntimeOutputReceipt, remoteWorkerRuntimeOutputEvidenceSha256,
  redactSecretText, type RemoteWorkerRuntimeOutputEvidence } from "@goatcitadel/contracts";
import { sha256Utf8, type RouteContext, type LeaseBinding } from "./connected-worker-routes.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";

/** Retries submit the same evidence; they never relaunch native execution. */
export async function retainWorkerRuntimeOutput(context: RouteContext, lease: LeaseBinding,
  evidence: RemoteWorkerRuntimeOutputEvidence, signal?: AbortSignal) {
  const submission = normalizeRemoteWorkerRuntimeOutputSubmission({ kind: "runtime.output.retain", evidence }), binding = Object.freeze({ ...lease });
  const route = Object.freeze({ ...context, credential: Object.freeze({ ...context.credential }) });
  if (Object.values(submission.evidence.streams).some(stream => redactSecretText(stream.text,
    { env: { WORKER_LEASE_TOKEN: binding.leaseToken }, redactEmailAddresses: true }).value !== stream.text))
    throw new Error("Native output must be redacted before delivery.");
  const deadline = AbortSignal.timeout(5000), stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  stop.throwIfAborted();
  const response = await callProtectedRoute({ ...route, rawPath: "/api/v1/remote-workers/assignment-settlement-submissions",
    operation: "assignment.settlement.submit", idempotencyKey: `runtime-output:${sha256Utf8(canonicalJsonString({ registryWorkspaceId: binding.registryWorkspaceId,
      assignmentId: binding.assignmentId, assignmentGeneration: binding.assignmentGeneration, leaseRevision: binding.leaseRevision, submission }))}`,
    signal: stop, payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...binding, submission } });
  stop.throwIfAborted();
  const body = response.body, result = normalizeRemoteWorkerRuntimeOutputReceipt(body.runtimeOutput), submitted = submission.evidence;
  if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" || body.operation !== "assignment.settlement.submit" ||
      body.disposition !== "runtime_output" || body.registryWorkspaceId !== binding.registryWorkspaceId ||
      result.registryWorkspaceId !== binding.registryWorkspaceId || result.assignmentId !== binding.assignmentId || result.assignmentGeneration !== binding.assignmentGeneration ||
      result.leaseRevision !== binding.leaseRevision || result.nonce !== submitted.nonce || result.requestSha256 !== submitted.requestSha256 ||
      result.resultSha256 !== submitted.resultSha256 || result.evidenceSha256 !== remoteWorkerRuntimeOutputEvidenceSha256(submitted))
    throw new Error("Native output receipt does not bind this submission.");
  return result;
}
