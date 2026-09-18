import { canonicalJsonString, REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
  normalizeRemoteWorkerCellObjectInventoryPageSubmission, normalizeRemoteWorkerCellObjectInventoryPageExchange,
  normalizeRemoteWorkerCellObjectInventorySubmission, normalizeRemoteWorkerCellProvisioningExchange, readRemoteWorkerCellObjectInventory,
  type RemoteWorkerCellObjectInventoryPageSubmission, type RemoteWorkerCellObjectInventoryPageExchange,
  type RemoteWorkerCellObjectInventorySubmission, type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";
import { sha256Utf8, type LeaseBinding, type RouteContext } from "./connected-worker-routes.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";

export async function exchangeWorkerCellObjectInventoryPage(context: RouteContext, lease: LeaseBinding,
  submission: RemoteWorkerCellObjectInventoryPageSubmission, signal?: AbortSignal): Promise<RemoteWorkerCellObjectInventoryPageExchange> {
  const binding = Object.freeze({ ...lease }), selection = normalizeRemoteWorkerCellObjectInventoryPageSubmission(submission);
  signal?.throwIfAborted();
  const response = await callProtectedRoute({ ...context,
    rawPath: "/api/v1/remote-workers/assignment-settlement-submissions", operation: "assignment.settlement.submit",
    idempotencyKey: `cell-inventory-page:${sha256Utf8(canonicalJsonString({ registryWorkspaceId: binding.registryWorkspaceId,
      assignmentId: binding.assignmentId, assignmentGeneration: binding.assignmentGeneration, leaseRevision: binding.leaseRevision, submission: selection }))}`,
    signal, payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...binding, submission: selection } });
  signal?.throwIfAborted();
  const body = response.body, result = normalizeRemoteWorkerCellObjectInventoryPageExchange(body.cellObjectInventoryPage), { history, accepted } = result;
  if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" || body.operation !== "assignment.settlement.submit" ||
      body.disposition !== "cell_object_inventory_page" || body.registryWorkspaceId !== binding.registryWorkspaceId ||
      history.registryWorkspaceId !== binding.registryWorkspaceId || history.assignmentId !== binding.assignmentId ||
      history.assignmentGeneration !== binding.assignmentGeneration || history.leaseRevision !== binding.leaseRevision ||
      (selection.kind === "cell.object_inventory.page_snapshot" ? accepted !== null : (!accepted || canonicalJsonString(accepted.page) !== canonicalJsonString(selection))))
    throw new Error("Worker inventory page response does not bind this assignment submission.");
  return result;
}

/** Sends a complete, terminally successful native capture. This does not invoke
 * a scanner or enable installed execution. Every page gets an exact byte
 * acknowledgement, including retries of already-completed captures. */
export async function uploadWorkerCellObjectInventory(context: RouteContext, lease: LeaseBinding,
  submission: RemoteWorkerCellObjectInventorySubmission, retained: RemoteWorkerCellProvisioningExchange,
  signal?: AbortSignal): Promise<RemoteWorkerCellObjectInventoryPageExchange> {
  const binding = Object.freeze({ ...lease }), selection = normalizeRemoteWorkerCellObjectInventorySubmission(submission);
  const history = normalizeRemoteWorkerCellProvisioningExchange(retained);
  if (selection.kind !== "cell.object_inventory.observation" || history.registryWorkspaceId !== binding.registryWorkspaceId ||
      history.assignmentId !== binding.assignmentId || history.assignmentGeneration !== binding.assignmentGeneration || history.leaseRevision !== binding.leaseRevision)
    throw new Error("Worker inventory capture does not bind this assignment lease.");
  const capture = readRemoteWorkerCellObjectInventory(selection.observationHex, selection.chunkHex, history);
  const historyIdentity = canonicalJsonString(history);
  let result: RemoteWorkerCellObjectInventoryPageExchange | undefined;
  for (let startChunk = 0; startChunk < capture.chunkHex.length; startChunk += 64) {
    signal?.throwIfAborted();
    result = await exchangeWorkerCellObjectInventoryPage(context, binding, { ...selection, kind: "cell.object_inventory.page", startChunk,
      chunkHex: capture.chunkHex.slice(startChunk, startChunk + 64) }, signal);
    if (canonicalJsonString(result.history) !== historyIdentity) throw new Error("Worker inventory history changed during delivery.");
  }
  if (!result?.accepted || result.accepted.committedRevision !== selection.expectedRevision + 1)
    throw new Error("Worker inventory upload did not commit its complete capture.");
  return result;
}
