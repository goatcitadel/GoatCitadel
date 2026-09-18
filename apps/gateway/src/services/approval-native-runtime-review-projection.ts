import type { ApprovalLifecycleHost } from "./approval-lifecycle-service.js";
import type { ApprovalReplayResult } from "./approval-types.js";

/** Add process-local launch context only after canonical replay/event work.
 * This projection has no persistence, resolution or execution authority. */
export function projectApprovalNativeRuntimeReview(
  host: Pick<ApprovalLifecycleHost, "readNativeRuntimeReview">,
  replay: ApprovalReplayResult,
): ApprovalReplayResult {
  try {
    const nativeRuntimeReview = host.readNativeRuntimeReview?.(replay.approval);
    return nativeRuntimeReview ? { ...replay, nativeRuntimeReview } : replay;
  } catch {
    // Retained history remains usable when process-local context is gone.
    return replay;
  }
}
