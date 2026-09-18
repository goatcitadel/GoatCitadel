import {
  normalizeRemoteWorkerCellProvisioningExchange,
  normalizeRemoteWorkerCellProvisioningSubmission,
  normalizeRemoteWorkerCellPreparationSubmission,
  normalizeRemoteWorkerCellPreparation,
  type RemoteWorkerCellPreparation,
  type RemoteWorkerCellProvisioningExchange,
} from "@goatcitadel/contracts";
import type {
  RemoteWorkerCellProvisioningAssignmentInput,
  RemoteWorkerCellPreparationAssignmentInput,
} from "@goatcitadel/storage";
import { snapshotRemoteWorkerCellCapacityAuthority } from "@goatcitadel/storage";
import { rejected } from "./remote-worker-assignment-execution-validators.js";

export interface RemoteWorkerCellProvisioningExchangePort {
  exchange(
    input: RemoteWorkerCellProvisioningAssignmentInput & { readonly signal?: AbortSignal },
  ): RemoteWorkerCellProvisioningExchange | Promise<RemoteWorkerCellProvisioningExchange>;
  prepare?(
    input: RemoteWorkerCellPreparationAssignmentInput & { readonly signal?: AbortSignal },
  ): RemoteWorkerCellPreparation | Promise<RemoteWorkerCellPreparation>;
}

/** Validate the allowlisted owner projection before it crosses the protected
 * transport. A checkpoint response acknowledges only the exact submitted bytes. */
export async function exchangeRemoteWorkerCellProvisioning(
  owner: RemoteWorkerCellProvisioningExchangePort | undefined,
  input: RemoteWorkerCellProvisioningAssignmentInput & { readonly signal?: AbortSignal },
): Promise<RemoteWorkerCellProvisioningExchange> {
  if (!owner) throw rejected("Worker cell provisioning exchange is unavailable.");
  input = Object.freeze({
    ...snapshotRemoteWorkerCellCapacityAuthority(input),
    submission: normalizeRemoteWorkerCellProvisioningSubmission(input.submission),
    signal: input.signal,
  });
  input.signal?.throwIfAborted();
  const result = normalizeRemoteWorkerCellProvisioningExchange(await owner.exchange(input));
  input.signal?.throwIfAborted();
  if (
    result.registryWorkspaceId !== input.registryWorkspaceId ||
    result.assignmentId !== input.assignmentId ||
    result.assignmentGeneration !== input.assignmentGeneration ||
    result.leaseRevision !== input.leaseRevision ||
    (input.submission.kind === "cell.provisioning.checkpoint" &&
      result.records[input.submission.expectedSequence] !== input.submission.recordHex) ||
    (input.submission.kind === "cell.volume.checkpoint" &&
      result.volumeRecords?.[input.submission.expectedSequence] !== input.submission.recordHex) ||
    (input.submission.kind === "cell.format.checkpoint" &&
      result.formatRecords?.[input.submission.expectedSequence] !== input.submission.recordHex) ||
    (input.submission.kind === "cell.protection.checkpoint" &&
      result.protectionRecords?.[input.submission.expectedSequence] !== input.submission.recordHex) ||
    (input.submission.kind === "cell.mount.checkpoint" &&
      result.mountRecords?.[input.submission.expectedSequence] !== input.submission.recordHex) ||
    (input.submission.kind === "cell.mounted-workspace.checkpoint" &&
      result.mountedWorkspaceRecords?.[input.submission.expectedSequence] !== input.submission.recordHex)
  ) {
    throw rejected("Worker cell provisioning result does not bind this assignment submission.");
  }
  return result;
}

export async function prepareRemoteWorkerCellProvisioning(
  owner: RemoteWorkerCellProvisioningExchangePort | undefined,
  input: RemoteWorkerCellPreparationAssignmentInput & { readonly signal?: AbortSignal },
): Promise<RemoteWorkerCellPreparation> {
  if (!owner?.prepare) throw rejected("Worker native cell preparation is unavailable.");
  input = Object.freeze({
    ...snapshotRemoteWorkerCellCapacityAuthority(input),
    submission: normalizeRemoteWorkerCellPreparationSubmission(input.submission),
    signal: input.signal,
  });
  input.signal?.throwIfAborted();
  const result = normalizeRemoteWorkerCellPreparation(await owner.prepare(input));
  input.signal?.throwIfAborted();
  const { exchange } = result;
  if (
    exchange.registryWorkspaceId !== input.registryWorkspaceId ||
    exchange.assignmentId !== input.assignmentId ||
    exchange.assignmentGeneration !== input.assignmentGeneration ||
    exchange.leaseRevision !== input.leaseRevision ||
    exchange.plan.parentIdentityHex !== input.submission.parentIdentityHex ||
    Date.parse(result.provisioningExpiresAt) <= Date.now()
  ) {
    throw rejected("Worker cell preparation does not bind this current assignment submission.");
  }
  return result;
}
