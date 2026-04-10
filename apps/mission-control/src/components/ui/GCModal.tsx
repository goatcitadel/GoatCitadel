import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";

interface GCModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  confirmPending?: boolean;
  confirmDisabled?: boolean;
  dismissDisabled?: boolean;
  onConfirm?: () => void | Promise<void>;
}

export function GCModal({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  confirmPending = false,
  confirmDisabled = false,
  dismissDisabled = false,
  onConfirm,
}: GCModalProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && dismissDisabled) {
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="gc-modal-overlay" />
        <Dialog.Content className="gc-modal-content">
          <Dialog.Title className="gc-modal-title">{title}</Dialog.Title>
          {description ? <Dialog.Description className="gc-modal-description">{description}</Dialog.Description> : null}
          {children ? <div className="gc-modal-body">{children}</div> : null}
          <div className="gc-modal-actions">
            <button
              type="button"
              className="gc-button gc-action-button gc-action-tertiary"
              disabled={dismissDisabled}
              onClick={() => onOpenChange(false)}
            >
              {cancelLabel}
            </button>
            {onConfirm ? (
              <button
                type="button"
                className={["gc-button", (`gc-action-button ${danger ? "gc-action-danger" : "gc-action-primary"}`)].filter(Boolean).join(" ")}
                disabled={confirmPending || confirmDisabled}
                onClick={() => void onConfirm()}
              >
                {confirmPending ? "Working..." : confirmLabel}
              </button>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
