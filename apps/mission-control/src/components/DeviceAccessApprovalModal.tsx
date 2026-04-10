import { GCModal } from "./ui";

export interface DeviceAccessApprovalPrompt {
  approvalId: string;
  requestId: string;
  deviceLabel: string;
  deviceType?: string;
  platform?: string;
  requestedIp?: string;
  requestedOrigin?: string;
  createdAt?: string;
}

interface DeviceAccessApprovalModalProps {
  prompt?: DeviceAccessApprovalPrompt;
  open: boolean;
  busy?: boolean;
  onApprove: () => void | Promise<void>;
  onReject: () => void | Promise<void>;
  onDismiss: () => void;
}

export function DeviceAccessApprovalModal({
  prompt,
  open,
  busy = false,
  onApprove,
  onReject,
  onDismiss,
}: DeviceAccessApprovalModalProps) {
  return (
    <GCModal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onDismiss();
        }
      }}
      title="Approve new device access"
      description={prompt
        ? `${prompt.deviceLabel} is waiting for an authenticated session to grant gateway access.`
        : "A new device is requesting access."}
      confirmLabel="Allow device"
      cancelLabel="Not now"
      confirmPending={busy}
      onConfirm={onApprove}
    >
      {prompt ? (
        <div className="gc-modal-detail-list">
          <div className="gc-modal-detail-item">
            <span className="shell-action-label">Device</span>
            <strong>{prompt.deviceLabel}</strong>
          </div>
          {prompt.platform ? (
            <div className="gc-modal-detail-item">
              <span className="shell-action-label">Platform</span>
              <strong>{prompt.platform}</strong>
            </div>
          ) : null}
          {prompt.deviceType ? (
            <div className="gc-modal-detail-item">
              <span className="shell-action-label">Type</span>
              <strong>{prompt.deviceType}</strong>
            </div>
          ) : null}
          {prompt.requestedIp ? (
            <div className="gc-modal-detail-item">
              <span className="shell-action-label">Remote IP</span>
              <strong>{prompt.requestedIp}</strong>
            </div>
          ) : null}
          {prompt.requestedOrigin ? (
            <div className="gc-modal-detail-item">
              <span className="shell-action-label">Origin</span>
              <strong>{prompt.requestedOrigin}</strong>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="gc-modal-actions" style={{ marginTop: "1rem" }}>
        <button type="button" className="gc-button danger" disabled={busy} onClick={() => void onReject()}>
          {busy ? "Working..." : "Reject device"}
        </button>
      </div>
    </GCModal>
  );
}
