import { globalCopy } from "../content/copy";

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  pending?: boolean;
  confirmDisabled?: boolean;
  cancelDisabled?: boolean;
  disableDismiss?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = globalCopy.common.apply,
  cancelLabel = globalCopy.common.cancel,
  danger = false,
  pending = false,
  confirmDisabled = false,
  cancelDisabled = false,
  disableDismiss = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={() => {
        if (!disableDismiss) {
          onCancel();
        }
      }}
    >
      <div
        className="modal-card confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="confirm-modal-title">{title}</h3>
        <p className="confirm-modal-message">{message}</p>
        <div className="actions confirm-modal-actions">
          <button
            type="button"
            className="gc-action-button gc-action-tertiary"
            disabled={cancelDisabled || pending}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`gc-action-button ${danger ? "gc-action-danger" : "gc-action-primary"}`}
            disabled={confirmDisabled || pending}
            onClick={onConfirm}
          >
            {pending ? "Working..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
