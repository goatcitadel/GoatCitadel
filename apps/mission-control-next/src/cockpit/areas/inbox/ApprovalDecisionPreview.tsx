import { isGoogleWorkspaceReadTool, type ApprovalRequest } from "@goatcitadel/contracts";
import { ApprovalReviewSummaryContent } from "./ApprovalReviewSummaryContent";
import type { useApprovalReviewEvidence } from "./use-approval-review-evidence";

export function ApprovalDecisionPreview({
  approval,
  workspaceId,
  review,
  loading,
  unavailable,
  showSummary,
  hasPreview,
  showExpiry,
}: {
  approval: ApprovalRequest;
  workspaceId: string;
  review: ReturnType<typeof useApprovalReviewEvidence>;
  loading: boolean;
  unavailable: boolean;
  showSummary: boolean;
  hasPreview: boolean;
  showExpiry: boolean;
}) {
  return review.loading || loading ? (
    <p aria-busy="true">Loading the exact approval preview…</p>
  ) : review.unavailable || unavailable || !hasPreview ? (
    <p role="alert">
      {review.unavailable || unavailable
        ? "The approval preview could not load. Reopen the review or use Deny."
        : isGoogleWorkspaceReadTool(approval.kind) && !approval.payload.connectionId
          ? "This read is missing the Google connection. Deny this request and retry from Chat."
          : "The exact action preview is unavailable. Retry from its source. You can still deny it."}
    </p>
  ) : !showSummary ? null : (
    <ApprovalReviewSummaryContent
      approval={approval}
      workspaceId={workspaceId}
      evidence={review.evidence}
      showExpiry={showExpiry}
    />
  );
}

export { ApprovalDecisionHelp } from "./ApprovalDecisionHelp";
