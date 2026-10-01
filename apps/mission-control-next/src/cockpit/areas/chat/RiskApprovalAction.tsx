import { useEffect, useRef, useState } from "react";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import type { ChatPendingApprovalState } from "@goatcitadel/mission-control-shared/components/chat/ChatPendingApprovalPanel";
import { buildApprovalEvidenceModel } from "@goatcitadel/mission-control-shared/content/approval-helpers";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

const HOLD_MS = 1_000;

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
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
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
  const start = () => {
    if (disabled || timer.current) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      onApprove();
    }, HOLD_MS);
  };

  if (!approval.riskLevel)
    return <p className="text-xs text-fg-muted">Risk is unavailable. Review the persisted approval before deciding.</p>;
  if (approval.kind === "remote_worker.native_runtime")
    return (
      <p className="text-xs text-fg-muted">This runtime request needs the native review shown in current approvals.</p>
    );
  if (approval.riskLevel === "nuclear")
    return (
      <Button
        type="button"
        variant="danger"
        size="sm"
        disabled={disabled}
        onPointerDown={start}
        onPointerUp={clear}
        onPointerLeave={clear}
        onPointerCancel={clear}
        onKeyDown={(event) => {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            if (!event.repeat) start();
          }
        }}
        onKeyUp={(event) => {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            clear();
          }
        }}
        onClick={(event) => event.preventDefault()}
        aria-label="Hold to approve nuclear risk action"
      >
        {holding ? "Keep holding…" : "Hold 1 second to approve once"}
      </Button>
    );
  if (approval.riskLevel === "danger")
    return (
      <>
        <Button type="button" variant="danger" size="sm" disabled={disabled} onClick={() => setConfirmOpen(true)}>
          Review approval
        </Button>
        <Dialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Confirm danger risk action"
          description="Review the exact action before approving once."
        >
          <div className="mb-3 max-h-72 space-y-2 overflow-y-auto text-sm text-fg-secondary">
            <p>
              <strong>Action:</strong>{" "}
              {reviewed?.linkage?.toolName ?? approval.toolName ?? reviewed?.kind ?? approval.kind ?? "Action request"}
            </p>
            <p>
              <strong>Risk:</strong> Danger{approval.reason ? ` · ${approval.reason}` : ""}
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
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              disabled={disabled || !hasActionPreview}
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
  return (
    <Button type="button" size="sm" variant="primary" disabled={disabled} onClick={onApprove}>
      Approve once
    </Button>
  );
}
