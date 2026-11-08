import type { ApprovalRequest } from "@goatcitadel/contracts";
import {
  buildApprovalReviewEvidenceModel,
  hasPurposeSpecificApprovalEvidence,
  type ApprovalEvidenceModel,
} from "@goatcitadel/mission-control-shared/content/approval-generic-evidence";
import { createApprovalCodeLoader, useDeferredApprovalCode } from "./use-deferred-approval-code";

const purposeCode = createApprovalCodeLoader(
  () => import("@goatcitadel/mission-control-shared/content/approval-purpose-evidence"),
);

export function useApprovalReviewEvidence(approval: ApprovalRequest | null, supplied?: ApprovalEvidenceModel | null) {
  const needsCode = Boolean(approval && supplied === undefined && hasPurposeSpecificApprovalEvidence(approval.kind));
  const { code, loading, unavailable } = useDeferredApprovalCode(purposeCode, needsCode);

  const evidence =
    supplied !== undefined
      ? supplied
      : approval
        ? needsCode
          ? (code?.buildApprovalRequestReviewEvidenceModel(approval) ?? null)
          : buildApprovalReviewEvidenceModel(approval.preview)
        : null;
  return { evidence, loading, unavailable };
}
