import { snapshotRemoteWorkerCellCapacityAuthority } from "@goatcitadel/storage";
import { dispatchNativeFileSubmission, isNativeFileSubmission, type RemoteWorkerNativeFileSubmissionOwners } from "./remote-worker-native-file-submissions.js";
import { dispatchNativeRuntimeSubmission, isNativeRuntimeSubmission, type NativeRuntimeSubmissionOwners } from "./remote-worker-native-runtime-submissions.js";
import { dispatchNativeCellSubmission, isNativeCellSubmission, type NativeCellSubmissionOwners } from "./remote-worker-native-cell-submissions.js";
import type { RemoteWorkerCellCapacityAuthority } from "@goatcitadel/storage";

export interface NativeReviewAuthorityPort {
  observe(input: RemoteWorkerCellCapacityAuthority): void;
}

export interface NativeSubmissionDependencies extends RemoteWorkerNativeFileSubmissionOwners, NativeRuntimeSubmissionOwners, NativeCellSubmissionOwners {
  readonly nativeReviewAuthority?: NativeReviewAuthorityPort;
}
/** The signed route supplies current authority once; domain owners remain
 * responsible for their own policy, approvals and transactional fences. */
export async function dispatchNativeSubmission(dependencies: NativeSubmissionDependencies,
  input: ReturnType<typeof snapshotRemoteWorkerCellCapacityAuthority> & { submission: { kind: string }; signal: AbortSignal }) {
  const authority = snapshotRemoteWorkerCellCapacityAuthority(input), submission = input.submission;
  input.signal.throwIfAborted();
  dependencies.nativeReviewAuthority?.observe(authority);
  if (isNativeFileSubmission(submission)) return dispatchNativeFileSubmission(dependencies, { ...authority, submission, signal: input.signal });
  if (isNativeRuntimeSubmission(submission)) return dispatchNativeRuntimeSubmission(dependencies, { ...authority, submission, signal: input.signal });
  if (isNativeCellSubmission(submission)) return dispatchNativeCellSubmission(dependencies, { ...authority, submission, signal: input.signal });
  return null;
}
