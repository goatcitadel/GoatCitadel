import { randomBytes } from "node:crypto";
import { canonicalJsonString, normalizeRemoteWorkerRuntimeInstallSelection, REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
  normalizeRemoteWorkerRuntimeInstallExchange, normalizeRemoteWorkerRuntimeInstallRequest, remoteWorkerRuntimeInstallRequestSha256,
  normalizeRemoteWorkerCellProvisioningExchange, readRemoteWorkerRuntimeInstallOutcome,
  type RemoteWorkerRuntimeInstallRequest, type RemoteWorkerRuntimeInstallExchange, type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";
import { sha256Utf8, type LeaseBinding, type RouteContext } from "./connected-worker-routes.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";

/** Fresh selection of retained input, never worker-supplied installation data. */
export async function selectWorkerRuntimeInstallation(context: RouteContext, lease: LeaseBinding, signal?: AbortSignal) {
  const binding = Object.freeze({ ...lease }), submission = Object.freeze({ kind: "runtime.install.select", challenge: randomBytes(32).toString("hex") });
  signal?.throwIfAborted();
  const response = await callProtectedRoute({ ...context, rawPath: "/api/v1/remote-workers/assignment-settlement-submissions",
    operation: "assignment.settlement.submit", idempotencyKey: `runtime-install-select:${sha256Utf8(canonicalJsonString({ registryWorkspaceId: binding.registryWorkspaceId,
      assignmentId: binding.assignmentId, assignmentGeneration: binding.assignmentGeneration, leaseRevision: binding.leaseRevision, submission }))}`,
    signal, payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...binding, submission } });
  signal?.throwIfAborted();
  const body = response.body, result = normalizeRemoteWorkerRuntimeInstallSelection(body.runtimeInstallSelection), history = result.history;
  if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" || body.operation !== "assignment.settlement.submit" ||
      body.disposition !== "runtime_install_selection" || body.registryWorkspaceId !== binding.registryWorkspaceId || result.challenge !== submission.challenge ||
      history.registryWorkspaceId !== binding.registryWorkspaceId || history.assignmentId !== binding.assignmentId ||
      history.assignmentGeneration !== binding.assignmentGeneration || history.leaseRevision !== binding.leaseRevision)
    throw new Error("Worker installation selection differs from its current assignment.");
  return result;
}

/** A null outcome selects read-only recovery. Neither lookup nor delivery
 * admits installation, retries copying or publishes cell readiness. */
export async function exchangeWorkerRuntimeInstallation(context: RouteContext, lease: LeaseBinding,
  suppliedRequest: RemoteWorkerRuntimeInstallRequest, suppliedHistory: RemoteWorkerCellProvisioningExchange,
  outcomeHex: string | null, signal?: AbortSignal): Promise<RemoteWorkerRuntimeInstallExchange> {
  const binding = Object.freeze({ ...lease }), request = normalizeRemoteWorkerRuntimeInstallRequest(suppliedRequest);
  const history = normalizeRemoteWorkerCellProvisioningExchange(suppliedHistory), requestSha256 = remoteWorkerRuntimeInstallRequestSha256(request);
  if (history.registryWorkspaceId !== binding.registryWorkspaceId || history.assignmentId !== binding.assignmentId ||
      history.assignmentGeneration !== binding.assignmentGeneration || history.leaseRevision !== binding.leaseRevision)
    throw new Error("Worker installation evidence does not bind this assignment lease.");
  signal?.throwIfAborted();
  if (outcomeHex !== null && !readRemoteWorkerRuntimeInstallOutcome(outcomeHex, request, history).installation)
    throw new Error("Worker installation evidence is not terminal.");
  const submission = Object.freeze(outcomeHex === null ? { kind: "runtime.install.lookup", nonce: request.nonce, requestSha256 } :
    { kind: "runtime.install.retain", nonce: request.nonce, requestSha256, outcomeHex });
  const response = await callProtectedRoute({ ...context, rawPath: "/api/v1/remote-workers/assignment-settlement-submissions",
    operation: "assignment.settlement.submit", idempotencyKey: `runtime-install:${sha256Utf8(canonicalJsonString({ registryWorkspaceId: binding.registryWorkspaceId,
      assignmentId: binding.assignmentId, assignmentGeneration: binding.assignmentGeneration, leaseRevision: binding.leaseRevision, submission }))}`,
    signal, payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...binding, submission } });
  signal?.throwIfAborted();
  const body = response.body, result = normalizeRemoteWorkerRuntimeInstallExchange(body.runtimeInstall);
  if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" || body.operation !== "assignment.settlement.submit" ||
      body.disposition !== "runtime_install" || body.registryWorkspaceId !== binding.registryWorkspaceId || result.registryWorkspaceId !== binding.registryWorkspaceId ||
      result.assignmentId !== binding.assignmentId || result.assignmentGeneration !== binding.assignmentGeneration || result.leaseRevision !== binding.leaseRevision ||
      result.nonce !== request.nonce || result.requestSha256 !== requestSha256 || (outcomeHex !== null && result.record?.outcomeHex !== outcomeHex))
    throw new Error("Worker installation receipt does not bind this assignment submission.");
  if (result.record && !readRemoteWorkerRuntimeInstallOutcome(result.record.outcomeHex, request, history).installation)
    throw new Error("Worker installation receipt is not terminal.");
  return result;
}
