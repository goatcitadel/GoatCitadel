import { globalCopy } from "../content/copy";
import { GCModal } from "./ui";

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
  return (
    <GCModal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onCancel();
        }
      }}
      title={title}
      description={message}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      danger={danger}
      confirmPending={pending}
      confirmDisabled={confirmDisabled}
      dismissDisabled={disableDismiss || cancelDisabled || pending}
      onConfirm={onConfirm}
    />
  );
}
