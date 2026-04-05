import { useEffect, useMemo, useState } from "react";

function formatRemainingDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function InlineApprovalPrompt({
  approvalId,
  toolName,
  reason,
  expiresAt,
  pending,
  onApprove,
  onDeny,
}: {
  approvalId: string;
  toolName?: string;
  reason?: string;
  expiresAt?: string;
  pending?: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) {
      return undefined;
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return undefined;
    }
    const interval = globalThis.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => globalThis.clearInterval(interval);
  }, [expiresAt]);

  const expiryState = useMemo(() => {
    if (!expiresAt) {
      return { expired: false, label: undefined as string | undefined };
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return { expired: false, label: undefined as string | undefined };
    }
    const remainingMs = expiresAtMs - now;
    if (remainingMs <= 0) {
      return { expired: true, label: "Approval expired, rerun the action." };
    }
    return {
      expired: false,
      label: `Expires in ${formatRemainingDuration(remainingMs)}`,
    };
  }, [expiresAt, now]);

  const actionsDisabled = pending || expiryState.expired;
  const isUrgent = expiryState.expired === false && expiresAt != null;
  const remainingMs = expiresAt ? Date.parse(expiresAt) - now : Infinity;
  const isLowTime = remainingMs > 0 && remainingMs < 120_000;

  return (
    <div className={`chat-approval-card${expiryState.expired ? " is-expired" : ""}${isLowTime ? " is-low-time" : ""}`} role="alert">
      <div className="chat-approval-header">
        <p className="chat-approval-title">Approval required</p>
        {isUrgent && !expiryState.expired ? (
          <span className={`chat-approval-countdown${isLowTime ? " is-low-time" : ""}`}>{expiryState.label}</span>
        ) : null}
        {expiryState.expired ? (
          <span className="chat-approval-countdown is-expired">{expiryState.label}</span>
        ) : null}
      </div>
      {toolName ? <p className="chat-approval-tool">{toolName}</p> : null}
      {reason ? <p className="chat-approval-reason">{reason}</p> : null}
      <div className="chat-approval-actions">
        <button type="button" className="chat-approval-allow" disabled={actionsDisabled} onClick={onApprove}>Allow once</button>
        <button type="button" className="chat-approval-deny" disabled={actionsDisabled} onClick={onDeny}>Deny</button>
      </div>
      <p className="chat-approval-id">{approvalId}</p>
    </div>
  );
}
