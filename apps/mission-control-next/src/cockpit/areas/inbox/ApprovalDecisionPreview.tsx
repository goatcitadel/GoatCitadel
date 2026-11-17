import type { ApprovalRequest } from "@goatcitadel/contracts";
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
        : "The exact action preview is unavailable, so this approval can't be approved. You can still deny it."}
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

export function ApprovalDecisionHelp() {
  return (
    <details className="text-xs text-fg-muted">
      <summary className="cursor-pointer font-medium text-fg-secondary">How this decision works</summary>
      <div className="mt-1 space-y-1">
        <p>
          The current pending record is checked again before either decision. Approval alone does not prove the action
          ran.
        </p>
        <p>
          To change this request, open its source and submit a new request. Editing an approval withdraws the original
          action; it does not authorize a replacement. Project-wide always-allow is unavailable here.
        </p>
      </div>
    </details>
  );
}
