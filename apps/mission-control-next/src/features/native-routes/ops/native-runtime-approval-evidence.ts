import type { ApprovalNativeRuntimeReview, ApprovalReplaySnapshot, ApprovalRequest } from "@goatcitadel/contracts";

export function nativeRuntimeReviewForApproval(approval: ApprovalRequest, replay?: ApprovalReplaySnapshot): ApprovalNativeRuntimeReview | undefined {
  const binding = approval.payload.nativeRuntime as { expectation?: { requestSha256?: unknown } } | undefined;
  const review = replay?.nativeRuntimeReview;
  const disclosure = approval.payload.nativeFileDisclosure as { destination?: unknown; executionWorkspaceId?: unknown } | undefined;
  if (Boolean(disclosure) !== Boolean(review?.fileDisclosure) || (disclosure &&
      (disclosure.destination !== "gateway_artifacts" || review?.fileDisclosure?.destination !== disclosure.destination ||
       review.fileDisclosure.workspaceId !== disclosure.executionWorkspaceId))) return undefined;
  return approval.kind === "remote_worker.native_runtime" && replay?.approval.approvalId === approval.approvalId &&
    typeof binding?.expectation?.requestSha256 === "string" && review?.requestSha256 === binding.expectation.requestSha256
    ? review : undefined;
}
