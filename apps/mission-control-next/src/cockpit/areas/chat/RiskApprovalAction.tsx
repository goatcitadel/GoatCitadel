import { useState, type ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import type { ChatPendingApprovalState } from "@goatcitadel/mission-control-shared/components/chat/ChatPendingApprovalPanel";
import { buildApprovalRequestReviewEvidenceModel } from "@goatcitadel/mission-control-shared/content/approval-helpers";
import { presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { ApprovalReviewSummary } from "../inbox/ApprovalReviewSummary";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { handleEvidenceScrollKeyDown } from "../../ui/evidence-scroll";
import { TypedConfirmation, typedConfirmationMatches } from "../../ui/TypedConfirmation";
import { presentApprovalAction } from "./chat-vocabulary";

/** The deliberate, untimed confirmation word for nuclear risk and for risk levels this build doesn't know. */
const CRITICAL_CONFIRMATION = "approve";

export function RiskApprovalAction({
  approval,
  workspaceId,
  reviewedApproval,
  pending,
  onApprove,
  specialistReview,
  reviewedInPlace = false,
  approveLabel,
  approveDanger = false,
}: {
  approval: ChatPendingApprovalState;
  workspaceId?: string;
  reviewedApproval?: ApprovalRequest;
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
  /** Styles the one-click approve button as a danger action with a shield. */
  approveDanger?: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const disabled = pending || Boolean(approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now());
  const reviewed =
    reviewedApproval?.approvalId === approval.approvalId &&
    reviewedApproval.status === "pending" &&
    reviewedApproval.riskLevel === approval.riskLevel
      ? reviewedApproval
      : null;
  const evidence = reviewed ? buildApprovalRequestReviewEvidenceModel(reviewed) : null;
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
    const actionToolName = reviewed?.linkage?.toolName ?? approval.toolName;
    const actionKind = reviewed?.kind ?? approval.kind;
    const confirmed = !critical || typedConfirmationMatches(typed, CRITICAL_CONFIRMATION);
    if (reviewedInPlace && !critical && !specialistReview && hasActionPreview)
      return (
        <Button type="button" variant="danger" size="sm" disabled={disabled} onClick={onApprove}>
          <ShieldAlert aria-hidden="true" className="size-4 shrink-0" />
          {approveLabel ?? "Approve once"}
        </Button>
      );
    return (
      <>
        <Button
          type="button"
          variant="danger"
          size="sm"
          disabled={disabled}
          onClick={() => {
            setTyped("");
            setConfirmOpen(true);
          }}
        >
          <ShieldAlert aria-hidden="true" className="size-4 shrink-0" />
          {critical
            ? "Review nuclear approval"
            : approval.riskLevel === "danger"
              ? "Review danger approval"
              : "Review approval"}
        </Button>
        <Dialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={`Confirm ${riskName.toLowerCase()}-level action`}
          description="Review the exact action before approving once."
        >
          {specialistReview}
          {reviewed ? (
            <ApprovalReviewSummary
              approval={reviewed}
              workspaceId={workspaceId ?? reviewed.linkage?.workspaceId ?? "Scope unavailable"}
            />
          ) : null}
          <div
            role="region"
            aria-label="Approval action details"
            tabIndex={0}
            onKeyDown={handleEvidenceScrollKeyDown}
            className="mb-3 min-w-0 max-w-full max-h-72 space-y-2 overflow-y-auto wrap-anywhere text-sm text-fg-secondary"
          >
            <p>
              <strong>Action:</strong> {presentApprovalAction(actionToolName, actionKind)}
            </p>
            <p>
              <strong>Risk:</strong> {riskName}
              {approval.reason ? ` · ${approval.reason}` : ""}
            </p>
            {evidence?.targets.length ? (
              <div>
                <strong>Targets</strong>
                <ul className="list-disc pl-5">
                  {evidence.targets.map((target) => (
                    <li key={target}>{target}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {evidence?.commands.length ? (
              <div>
                <strong>Commands</strong>
                <ul className="space-y-1">
                  {evidence.commands.map((command) => (
                    <li key={command}>
                      <code className="block overflow-x-auto rounded-md bg-sunken p-2 font-mono text-xs text-fg">
                        {command}
                      </code>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {evidence?.changes.length ? (
              <div>
                <strong>Changes</strong>
                <ul className="space-y-1">
                  {evidence.changes.map((change) => (
                    <li key={change.label}>
                      <span>{change.label}</span>
                      <pre className="max-h-28 overflow-auto rounded-md bg-sunken p-2 text-xs">{change.content}</pre>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {evidence?.supporting.length ? (
              <div>
                <strong>Other action details</strong>
                <ul className="list-disc pl-5">
                  {evidence.supporting.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {actionToolName || actionKind ? (
              <TechnicalDetails label="Action technical details">
                <p className="font-mono text-xs wrap-anywhere">
                  {[actionToolName && `Tool: ${actionToolName}`, actionKind && `Kind: ${actionKind}`]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </TechnicalDetails>
            ) : null}
            {reviewed ? (
              <TechnicalDetails label="Full persisted action preview">
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-sunken p-2 font-mono text-xs">
                  {JSON.stringify(reviewed.preview, null, 2)}
                </pre>
              </TechnicalDetails>
            ) : null}
            {!hasActionPreview ? (
              <p role="alert">
                The current action preview is unavailable, so Approve once is off. Cancel, then use Deny or wait for the
                preview.
              </p>
            ) : null}
          </div>
          {critical ? (
            <div className="mb-3">
              <TypedConfirmation
                phrase={CRITICAL_CONFIRMATION}
                value={typed}
                onChange={setTyped}
                consequence="Approve once"
              />
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              disabled={disabled || !hasActionPreview || !confirmed}
              onClick={() => {
                setConfirmOpen(false);
                onApprove();
              }}
            >
              Approve once
            </Button>
            <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          </div>
        </Dialog>
      </>
    );
  }
  return (
    <Button
      type="button"
      size="sm"
      variant={approveDanger ? "danger" : "primary"}
      disabled={disabled}
      onClick={onApprove}
    >
      {approveDanger ? <ShieldAlert aria-hidden="true" className="size-4 shrink-0" /> : null}
      {approveLabel ?? "Approve once"}
    </Button>
  );
}
