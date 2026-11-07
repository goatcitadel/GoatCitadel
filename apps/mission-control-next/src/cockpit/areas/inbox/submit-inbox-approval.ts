import type { ApprovalRequest, OperatorInboxItem } from "@goatcitadel/contracts";
import { resolveApproval } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import type { ReactNode } from "react";
import { approvalDecisionMessage } from "./approval-settlement";
import { updateInboxApprovalAttempt } from "./inbox-approval-attempts";
import { CHANGED_APPROVAL_RECORD, canResolveInboxApproval, matchesInboxApprovalDecision } from "./inbox-approval-guard";
import { runPrepareApprove, type PrepareApprove } from "./prepare-approve";
import type { SpecialistEvidence } from "./specialist-approval-evidence";
import { specialistEvidenceKey } from "./specialist-approval-key";

type Submission = {
  approval: ApprovalRequest;
  decision: "approve" | "reject";
  workspaceId: string;
  item?: OperatorInboxItem;
  token: symbol;
  specializedReview: boolean;
  specialistReady: boolean;
  specialistEvidence?: SpecialistEvidence;
  specialistCode?: typeof import("./specialist-approval-code");
  prepareApprove?: PrepareApprove;
  readCurrent: () => Promise<ApprovalRequest | null>;
  isCurrent: () => boolean;
  onError: (line: ReactNode) => void;
  onInvalidated: (message?: string, line?: ReactNode) => void;
};

/** Revalidate the reviewed record and caller after loading code and before dispatch. */
export async function submitInboxApproval({
  approval,
  decision,
  workspaceId,
  item,
  token,
  specializedReview,
  specialistReady,
  specialistEvidence,
  specialistCode,
  prepareApprove,
  readCurrent,
  isCurrent,
  onError,
  onInvalidated,
}: Submission): Promise<string | undefined> {
  if (!isCurrent()) return;
  let mutationAttempted = false;
  try {
    const latest = await readCurrent();
    if (!isCurrent()) return;
    const record = latest ?? undefined;
    if (
      !canResolveInboxApproval(
        item,
        approval,
        record,
        workspaceId,
        Date.now(),
        specialistReady || decision === "reject",
      )
    ) {
      onError(CHANGED_APPROVAL_RECORD);
      onInvalidated();
      return;
    }
    if (specializedReview && decision === "approve") {
      if (!specialistCode) return;
      const fresh = await specialistCode.readSpecialistEvidence(approval);
      if (!isCurrent()) return;
      if (
        !canResolveInboxApproval(item, approval, record, workspaceId, Date.now(), true) ||
        !specialistEvidence ||
        !specialistCode.specialistEvidenceMatches(approval, fresh) ||
        specialistEvidenceKey(fresh) !== specialistEvidenceKey(specialistEvidence)
      ) {
        const message = "Specialist review changed. Refresh and review the current target before approving.";
        onError(message);
        onInvalidated(message);
        return;
      }
    }
    if (decision === "approve" && prepareApprove) {
      const failure = await runPrepareApprove(prepareApprove, workspaceId, approval.approvalId, token);
      // Preparation may already have changed something. The owner explains why a departed review stopped.
      const outlived = !isCurrent();
      if (outlived) onInvalidated(failure?.summary, failure?.line);
      else if (failure) onError(failure.line);
      if (outlived || failure) return;
    }
    updateInboxApprovalAttempt(
      workspaceId,
      approval.approvalId,
      token,
      "submitted",
      "Recording the approval decision…",
    );
    mutationAttempted = true;
    const result = await resolveApproval(approval.approvalId, decision);
    if (!matchesInboxApprovalDecision(item, approval, result.approval, workspaceId, decision)) {
      throw new Error("The returned record does not confirm this approval and decision.");
    }
    const message = approvalDecisionMessage(result.approval, result.effects);
    updateInboxApprovalAttempt(workspaceId, approval.approvalId, token, "resolved", message);
    return message;
  } catch (cause) {
    if (mutationAttempted) {
      updateInboxApprovalAttempt(
        workspaceId,
        approval.approvalId,
        token,
        "uncertain",
        "Decision outcome is uncertain. Check again to read the current record before taking another action.",
      );
    } else if (isCurrent()) {
      onError(`Could not check the current approval. ${describeApiError(cause).summary}`);
    }
  }
}
