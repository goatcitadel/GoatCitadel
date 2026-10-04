import { useState } from "react";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import type { ChatPendingApprovalState } from "@goatcitadel/mission-control-shared/components/chat/ChatPendingApprovalPanel";
import { buildApprovalEvidenceModel } from "@goatcitadel/mission-control-shared/content/approval-helpers";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

/** The deliberate, untimed confirmation word for nuclear risk and for risk levels this build doesn't know. */
const CRITICAL_CONFIRMATION = "approve";

export function RiskApprovalAction({
  approval,
  reviewedApproval,
  pending,
  onApprove,
}: {
  approval: ChatPendingApprovalState;
  reviewedApproval?: ApprovalRequest;
  pending: boolean;
  onApprove: () => void;
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
  const evidence = reviewed ? buildApprovalEvidenceModel(reviewed.preview) : null;
  const hasActionPreview = Boolean(
    evidence?.commands.length ||
    evidence?.targets.length ||
    evidence?.changes.length ||
    evidence?.supporting.some((detail) => /^(?:Url|Uri|Selector|Field|Input):/.test(detail)),
  );

  if (!approval.riskLevel)
    return <p className="text-xs text-fg-muted">Risk is unavailable. Review the persisted approval before deciding.</p>;
  if (approval.kind === "remote_worker.native_runtime")
    return (
      <p className="text-xs text-fg-muted">This runtime request needs the native review shown in current approvals.</p>
    );
  // Only the two lowest tiers approve in one click. Danger opens the evidence review, and nuclear
  // or any risk level this build doesn't know also needs the typed confirmation.
  if (approval.riskLevel !== "safe" && approval.riskLevel !== "caution") {
    const critical = approval.riskLevel !== "danger";
    const riskName = humanizeToken(approval.riskLevel);
    const confirmed = !critical || typed.trim().toLowerCase() === CRITICAL_CONFIRMATION;
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
          Review approval
        </Button>
        <Dialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={`Confirm ${riskName.toLowerCase()} risk action`}
          description="Review the exact action before approving once."
        >
          <div className="mb-3 max-h-72 space-y-2 overflow-y-auto text-sm text-fg-secondary">
            <p>
              <strong>Action:</strong>{" "}
              {reviewed?.linkage?.toolName ?? approval.toolName ?? reviewed?.kind ?? approval.kind ?? "Action request"}
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
                      <code className="block overflow-x-auto rounded bg-sunken p-2 font-mono text-xs text-fg">
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
                      <pre className="max-h-28 overflow-auto rounded bg-sunken p-2 text-xs">{change.content}</pre>
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
            {reviewed ? (
              <details open className="rounded border border-line p-2">
                <summary className="cursor-pointer">Full persisted action preview</summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-sunken p-2 font-mono text-xs">
                  {JSON.stringify(reviewed.preview, null, 2)}
                </pre>
              </details>
            ) : null}
            {!hasActionPreview ? (
              <p role="alert">
                The current action preview is unavailable here. Open the persisted approval before deciding.
              </p>
            ) : null}
          </div>
          {critical ? (
            <label className="mb-3 block text-sm text-fg-secondary">
              Type <strong className="font-mono text-fg">{CRITICAL_CONFIRMATION}</strong> to approve this action once
              <input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="mt-1 block min-h-10 w-full rounded-md border border-line-strong bg-canvas px-3 text-fg"
              />
            </label>
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
    <Button type="button" size="sm" variant="primary" disabled={disabled} onClick={onApprove}>
      Approve once
    </Button>
  );
}
