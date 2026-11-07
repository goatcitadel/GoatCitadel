import { useState, type ReactNode } from "react";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import type { ChatPendingApprovalState } from "@goatcitadel/mission-control-shared/components/chat/ChatPendingApprovalPanel";
import type { ApprovalEvidenceModel } from "@goatcitadel/mission-control-shared/content/approval-helpers";
import { ApprovalReviewSummaryContent } from "../inbox/ApprovalReviewSummaryContent";
import { Button } from "../../ui/Button";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TypedConfirmation, typedConfirmationMatches } from "../../ui/TypedConfirmation";
import { handleEvidenceScrollKeyDown } from "../../ui/evidence-scroll";
import { presentApprovalAction } from "./chat-vocabulary";

/** The deliberate, untimed confirmation word for nuclear risk and for risk levels this build doesn't know. */
const CRITICAL_CONFIRMATION = "approve";

export function RiskApprovalConfirmationBody({
  approval,
  workspaceId,
  reviewed,
  evidence,
  hasActionPreview,
  critical,
  disabled,
  riskName,
  confirmAction,
  specialistReview,
  consequence,
  onConfirm,
  onCancel,
}: {
  approval: ChatPendingApprovalState;
  workspaceId?: string;
  reviewed: ApprovalRequest | null;
  evidence: ApprovalEvidenceModel | null;
  hasActionPreview: boolean;
  critical: boolean;
  disabled: boolean;
  riskName: string;
  confirmAction: string;
  specialistReview?: ReactNode;
  consequence?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const actionToolName = reviewed?.linkage?.toolName ?? approval.toolName;
  const actionKind = reviewed?.kind ?? approval.kind;
  const confirmed = !critical || typedConfirmationMatches(typed, CRITICAL_CONFIRMATION);
  return (
    <>
      {specialistReview}
      {reviewed ? (
        <ApprovalReviewSummaryContent
          approval={reviewed}
          evidence={evidence}
          workspaceId={workspaceId ?? reviewed.linkage?.workspaceId ?? "Scope unavailable"}
        />
      ) : null}
      {consequence}
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
            The current action preview is unavailable, so {confirmAction} is off. Cancel, then use Deny or wait for the
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
            consequence={confirmAction}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" disabled={disabled || !hasActionPreview || !confirmed} onClick={onConfirm}>
          {confirmAction}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </>
  );
}
