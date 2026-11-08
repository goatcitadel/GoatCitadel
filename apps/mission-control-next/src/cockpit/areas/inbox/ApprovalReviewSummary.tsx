import type { ComponentProps } from "react";
import { buildApprovalRequestReviewEvidenceModel } from "@goatcitadel/mission-control-shared/content/approval-purpose-evidence";
import { ApprovalReviewSummaryContent } from "./ApprovalReviewSummaryContent";

export function ApprovalReviewSummary(props: Omit<ComponentProps<typeof ApprovalReviewSummaryContent>, "evidence">) {
  return <ApprovalReviewSummaryContent {...props} evidence={buildApprovalRequestReviewEvidenceModel(props.approval)} />;
}
