import { GCModal } from "./ui";

export interface RemoteApprovalActionPrompt {
  approvalId: string;
  actionType: "approval.resolve";
  tokenId: string;
  token: string;
  kind: string;
  riskLevel: string;
  status: string;
  preview?: Record<string, unknown>;
  expiresAt?: string;
}

interface RemoteApprovalActionModalProps {
  prompt?: RemoteApprovalActionPrompt;
  open: boolean;
  busy?: boolean;
  onApprove: () => void | Promise<void>;
  onReject: () => void | Promise<void>;
  onDismiss: () => void;
}

export function RemoteApprovalActionModal({
  prompt,
  open,
  busy = false,
  onApprove,
  onReject,
  onDismiss,
}: RemoteApprovalActionModalProps) {
  return (
    <GCModal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onDismiss();
        }
      }}
      title="Resolve remote approval"
      description={prompt
        ? `${prompt.kind} is ready for a Mission Control decision with a single-use connector action token.`
        : "A remote approval action is ready."}
      confirmLabel="Approve action"
      cancelLabel="Dismiss"
      confirmPending={busy}
      onConfirm={onApprove}
    >
      {prompt ? (
        <>
          <div className="gc-modal-detail-list">
            <div className="gc-modal-detail-item">
              <span className="shell-action-label">Approval</span>
              <strong>{prompt.approvalId}</strong>
            </div>
            <div className="gc-modal-detail-item">
              <span className="shell-action-label">Kind</span>
              <strong>{prompt.kind}</strong>
            </div>
            <div className="gc-modal-detail-item">
              <span className="shell-action-label">Risk</span>
              <strong>{prompt.riskLevel}</strong>
            </div>
            <div className="gc-modal-detail-item">
              <span className="shell-action-label">Token</span>
              <strong>{prompt.tokenId}</strong>
            </div>
            {prompt.expiresAt ? (
              <div className="gc-modal-detail-item">
                <span className="shell-action-label">Expires</span>
                <strong>{new Date(prompt.expiresAt).toLocaleString()}</strong>
              </div>
            ) : null}
          </div>
          {prompt.preview ? (
            <pre style={{ marginTop: "1rem", maxHeight: "14rem", overflow: "auto" }}>
              {JSON.stringify(prompt.preview, null, 2)}
            </pre>
          ) : null}
        </>
      ) : null}
      <div className="gc-modal-actions" style={{ marginTop: "1rem" }}>
        <button type="button" className="danger" disabled={busy} onClick={() => void onReject()}>
          {busy ? "Working..." : "Reject action"}
        </button>
      </div>
    </GCModal>
  );
}
