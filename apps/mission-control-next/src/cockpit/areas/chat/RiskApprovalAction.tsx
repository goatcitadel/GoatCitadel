import { lazy, useState, type ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import type { ChatPendingApprovalState } from "@goatcitadel/mission-control-shared/components/chat/ChatPendingApprovalPanel";
import type { ApprovalEvidenceModel } from "@goatcitadel/mission-control-shared/content/approval-generic-evidence";
import { presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { DeferredChatLeaf } from "./DeferredChatLeaves";
import { useApprovalReviewEvidence } from "../inbox/use-approval-review-evidence";

const RiskApprovalConfirmationBody = lazy(async () => ({
  default: (await import("./RiskApprovalConfirmationBody")).RiskApprovalConfirmationBody,
}));

export function RiskApprovalAction({
  approval,
  workspaceId,
  reviewedApproval,
  reviewEvidence,
  pending,
  onApprove,
  specialistReview,
  reviewedInPlace = false,
  approveLabel,
  reviewLabel,
  confirmLabel,
  consequence,
  approveDanger = false,
  approveVariant = "primary",
  loading = false,
  loadingLabel,
}: {
  approval: ChatPendingApprovalState;
  workspaceId?: string;
  reviewedApproval?: ApprovalRequest;
  reviewEvidence?: ApprovalEvidenceModel | null;
  pending: boolean;
  onApprove: () => void;
  specialistReview?: ReactNode;
  /**
   * The surrounding dialog already shows this approval's review, so a danger-level approval with an action
   * preview approves in one click instead of opening a second review. Nuclear keeps its typed confirmation.
   */
  reviewedInPlace?: boolean;
  /** Names the one-click approve button for an action with its own wording, such as "Run it". */
  approveLabel?: string;
  /** Names the button that opens a danger-level review; nuclear keeps "Review nuclear approval" so its tier shows. */
  reviewLabel?: string;
  /** Names the review's confirm button, for an approval that does more than approve once. */
  confirmLabel?: string;
  /** What else approving does, shown in the review before the action details. */
  consequence?: ReactNode;
  /** Styles the one-click approve button as a danger action with a shield. */
  approveDanger?: boolean;
  /** The one-click approve button's style when it is not a danger action, for an approve beside the primary one. */
  approveVariant?: "primary" | "secondary";
  /** Shows the one-click approve button as busy, with `loadingLabel` in place of its label. */
  loading?: boolean;
  loadingLabel?: string;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmAction = confirmLabel ?? "Approve once";
  const disabled = pending || Boolean(approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now());
  const reviewed =
    reviewedApproval?.approvalId === approval.approvalId &&
    reviewedApproval.status === "pending" &&
    reviewedApproval.riskLevel === approval.riskLevel
      ? reviewedApproval
      : null;
  const review = useApprovalReviewEvidence(reviewed, reviewed ? reviewEvidence : undefined);
  const evidence = review.evidence;
  const hasActionPreview =
    Boolean(specialistReview) ||
    Boolean(
      evidence?.commands.length ||
      evidence?.targets.length ||
      evidence?.changes.length ||
      evidence?.supporting.some((detail) => /^(?:Url|Uri|Selector|Field|Input):/.test(detail)),
    );

  // These sentences name the controls beside them (the approval summary and Deny), not a page they can't link to.
  if (!approval.riskLevel)
    return (
      <p className="text-xs text-fg-muted">
        Risk is unavailable, so Approve once is off. Check the approval summary above, or use Deny.
      </p>
    );
  if (review.loading) return <p aria-busy="true">Loading the exact approval preview…</p>;
  if (review.unavailable)
    return <p role="alert">The approval preview could not load. Reopen the review or use Deny.</p>;
  if (approval.kind === "remote_worker.native_runtime" && !specialistReview)
    return (
      <p className="text-xs text-fg-muted">
        This runtime request can be approved only after its runtime review loads. Use Deny to refuse it now.
      </p>
    );
  // Only the two lowest tiers approve in one click. Danger opens the evidence review, and nuclear
  // or any risk level this build doesn't know also needs the typed confirmation.
  if (specialistReview || (approval.riskLevel !== "safe" && approval.riskLevel !== "caution")) {
    const critical = !["safe", "caution", "danger"].includes(approval.riskLevel);
    const riskName = presentRiskLevel(approval.riskLevel).label;
    if (reviewedInPlace && !critical && !specialistReview && hasActionPreview)
      return (
        <Button type="button" variant="danger" size="sm" disabled={disabled} onClick={onApprove}>
          <ShieldAlert aria-hidden="true" className="size-4 shrink-0" />
          {approveLabel ?? "Approve once"}
        </Button>
      );
    return (
      <>
        <Button type="button" variant="danger" size="sm" disabled={disabled} onClick={() => setConfirmOpen(true)}>
          <ShieldAlert aria-hidden="true" className="size-4 shrink-0" />
          {critical
            ? "Review nuclear approval"
            : (reviewLabel ?? (approval.riskLevel === "danger" ? "Review danger approval" : "Review approval"))}
        </Button>
        <Dialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={`Confirm ${riskName.toLowerCase()}-level action`}
          description={
            confirmLabel
              ? `Review the exact action before you choose ${confirmLabel}.`
              : "Review the exact action before approving once."
          }
        >
          {confirmOpen ? (
            <DeferredChatLeaf label="Approval details" identity={approval.approvalId}>
              <RiskApprovalConfirmationBody
                approval={approval}
                workspaceId={workspaceId}
                reviewed={reviewed}
                evidence={evidence}
                hasActionPreview={hasActionPreview}
                critical={critical}
                disabled={disabled}
                riskName={riskName}
                confirmAction={confirmAction}
                specialistReview={specialistReview}
                consequence={consequence}
                onConfirm={() => {
                  setConfirmOpen(false);
                  onApprove();
                }}
                onCancel={() => setConfirmOpen(false)}
              />
            </DeferredChatLeaf>
          ) : null}
        </Dialog>
      </>
    );
  }
  return (
    <Button
      type="button"
      size="sm"
      variant={approveDanger ? "danger" : approveVariant}
      // A busy button ignores clicks and keeps keyboard focus (aria-disabled); native disabled would drop it.
      disabled={disabled && !loading}
      loading={loading}
      loadingLabel={loadingLabel}
      onClick={onApprove}
    >
      {approveDanger ? <ShieldAlert aria-hidden="true" className="size-4 shrink-0" /> : null}
      {approveLabel ?? "Approve once"}
    </Button>
  );
}
