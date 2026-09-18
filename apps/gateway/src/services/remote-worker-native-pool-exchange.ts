import { normalizeRemoteWorkerNativePoolPage, normalizeRemoteWorkerNativePoolPageSubmission,
  normalizeRemoteWorkerNativePoolCleanupPageSubmission, type RemoteWorkerNativePoolCleanupPageSubmission,
  type RemoteWorkerNativePoolPage, type RemoteWorkerNativePoolPageSubmission } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority, type RemoteWorkerCellCapacityAuthority } from "@goatcitadel/storage";
import { rejected } from "./remote-worker-assignment-execution-validators.js";

export interface RemoteWorkerNativePoolPageInput extends RemoteWorkerCellCapacityAuthority {
  readonly submission: RemoteWorkerNativePoolPageSubmission | RemoteWorkerNativePoolCleanupPageSubmission;
  readonly signal?: AbortSignal;
}
export interface RemoteWorkerNativePoolExchangePort {
  read(input: RemoteWorkerNativePoolPageInput): RemoteWorkerNativePoolPage | Promise<RemoteWorkerNativePoolPage>;
}
export async function exchangeRemoteWorkerNativePoolPage(owner: RemoteWorkerNativePoolExchangePort | undefined,
  input: RemoteWorkerNativePoolPageInput): Promise<RemoteWorkerNativePoolPage> {
  if (!owner) throw rejected("Worker native pool lookup is unavailable.");
  const command = Object.freeze({ ...snapshotRemoteWorkerCellCapacityAuthority(input),
    submission: input.submission.kind === "cell.native_pool.cleanup.page" ? normalizeRemoteWorkerNativePoolCleanupPageSubmission(input.submission)
      : normalizeRemoteWorkerNativePoolPageSubmission(input.submission), signal: input.signal });
  command.signal?.throwIfAborted();
  const result = normalizeRemoteWorkerNativePoolPage(await owner.read(command));
  command.signal?.throwIfAborted();
  if (result.offset !== command.submission.offset || (command.submission.snapshotSha256 !== null &&
      result.snapshotSha256 !== command.submission.snapshotSha256)) throw rejected("Worker native pool page does not bind this request.");
  return result;
}
