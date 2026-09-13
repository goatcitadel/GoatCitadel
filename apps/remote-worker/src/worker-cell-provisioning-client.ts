import {
  REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
  canonicalJsonString,
  normalizeRemoteWorkerCellProvisioningExchange,
  normalizeRemoteWorkerCellProvisioningSubmission,
  normalizeRemoteWorkerCellPreparation, normalizeRemoteWorkerCellPreparationSubmission,
  type RemoteWorkerCellPreparation, type RemoteWorkerCellPreparationSubmission,
  type RemoteWorkerCellProvisioningExchange,
  type RemoteWorkerCellProvisioningSubmission,
} from "@goatcitadel/contracts";
import { sha256Utf8, type LeaseBinding, type RouteContext } from "./connected-worker-routes.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";

/** Shares the protected assignment connection and its current lease. Reading a
 * prepared plan is recovery metadata, never permission to create native state. */
export async function exchangeWorkerCellProvisioning(
  context: RouteContext,
  lease: LeaseBinding,
  submission: RemoteWorkerCellProvisioningSubmission,
  signal?: AbortSignal,
): Promise<RemoteWorkerCellProvisioningExchange> {
  const binding = Object.freeze({ ...lease });
  const selection = normalizeRemoteWorkerCellProvisioningSubmission(submission);
  const response = await callProtectedRoute({
    ...context,
    rawPath: "/api/v1/remote-workers/assignment-settlement-submissions",
    operation: "assignment.settlement.submit",
    idempotencyKey: `cell-provisioning:${sha256Utf8(canonicalJsonString({
      registryWorkspaceId: binding.registryWorkspaceId, assignmentId: binding.assignmentId,
      assignmentGeneration: binding.assignmentGeneration, leaseRevision: binding.leaseRevision, submission: selection,
    }))}`,
    signal,
    payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
      ...binding, submission: selection },
  });
  return projectWorkerCellProvisioningResponse(response.body, binding, selection);
}

export function projectWorkerCellProvisioningResponse(
  body: Record<string, unknown>,
  lease: LeaseBinding,
  submission: RemoteWorkerCellProvisioningSubmission,
): RemoteWorkerCellProvisioningExchange {
  const selection = normalizeRemoteWorkerCellProvisioningSubmission(submission);
  const result = normalizeRemoteWorkerCellProvisioningExchange(body.cellProvisioning);
  if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" ||
      body.operation !== "assignment.settlement.submit" || body.disposition !== "cell_provisioning_recorded" ||
      body.registryWorkspaceId !== lease.registryWorkspaceId || result.registryWorkspaceId !== lease.registryWorkspaceId ||
      result.assignmentId !== lease.assignmentId || result.assignmentGeneration !== lease.assignmentGeneration ||
      result.leaseRevision !== lease.leaseRevision ||
      (selection.kind === "cell.provisioning.checkpoint" && result.records[selection.expectedSequence] !== selection.recordHex) ||
      (selection.kind === "cell.volume.checkpoint" && result.volumeRecords?.[selection.expectedSequence] !== selection.recordHex) ||
      (selection.kind === "cell.format.checkpoint" && result.formatRecords?.[selection.expectedSequence] !== selection.recordHex) ||
      (selection.kind === "cell.protection.checkpoint" && result.protectionRecords?.[selection.expectedSequence] !== selection.recordHex) ||
      (selection.kind === "cell.mount.checkpoint" && result.mountRecords?.[selection.expectedSequence] !== selection.recordHex) ||
      (selection.kind === "cell.mounted-workspace.checkpoint" && result.mountedWorkspaceRecords?.[selection.expectedSequence] !== selection.recordHex)) {
    throw new Error("Worker cell provisioning response does not bind this assignment submission.");
  }
  return result;
}

/** The Gateway derives the profile and creation decision. A retry is a fresh
 * protected request and must retain the returned reconcile decision. */
export async function prepareWorkerCellProvisioning(
  context: RouteContext, lease: LeaseBinding, submission: RemoteWorkerCellPreparationSubmission, signal?: AbortSignal,
): Promise<RemoteWorkerCellPreparation> {
  const binding = Object.freeze({ ...lease });
  const selection = normalizeRemoteWorkerCellPreparationSubmission(submission);
  const response = await callProtectedRoute({ ...context,
    rawPath: "/api/v1/remote-workers/assignment-settlement-submissions", operation: "assignment.settlement.submit",
    idempotencyKey: `cell-prepare:${sha256Utf8(canonicalJsonString({ registryWorkspaceId: binding.registryWorkspaceId,
      assignmentId: binding.assignmentId, assignmentGeneration: binding.assignmentGeneration,
      leaseRevision: binding.leaseRevision, submission: selection }))}`, signal,
    payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...binding, submission: selection } });
  const body = response.body;
  const result = normalizeRemoteWorkerCellPreparation(body.cellPreparation);
  const { exchange } = result;
  if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" ||
      body.operation !== "assignment.settlement.submit" || body.disposition !== "cell_provisioning_prepared" ||
      body.registryWorkspaceId !== binding.registryWorkspaceId || exchange.registryWorkspaceId !== binding.registryWorkspaceId ||
      exchange.assignmentId !== binding.assignmentId || exchange.assignmentGeneration !== binding.assignmentGeneration ||
      exchange.leaseRevision !== binding.leaseRevision || exchange.plan.parentIdentityHex !== selection.parentIdentityHex ||
      Date.parse(result.provisioningExpiresAt) <= Date.now()) {
    throw new Error("Worker cell preparation does not bind this current assignment submission.");
  }
  return result;
}
