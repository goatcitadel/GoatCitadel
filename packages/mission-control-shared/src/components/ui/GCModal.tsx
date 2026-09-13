import { useRef, type ReactNode } from "react";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog";

interface GCModalProps {
  className?: string;
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
  className,
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
  const returnFocusRef = useRef<HTMLElement | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && dismissDisabled) {
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        onOpenAutoFocus={() => {
          returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          const opener = returnFocusRef.current;
          if (opener?.isConnected && opener !== document.body) {
            event.preventDefault();
            opener.focus({ preventScroll: true });
          }
        }}
        className={["gc-modal-content mc-gc-modal-content max-w-xl border-border/60 bg-popover/96", className]
          .filter(Boolean)
          .join(" ")}
      >
        <DialogHeader>
          <DialogTitle className="gc-modal-title">{title}</DialogTitle>
          {description ? <DialogDescription className="gc-modal-description">{description}</DialogDescription> : null}
        </DialogHeader>
        {children ? <div className="gc-modal-body">{children}</div> : null}
        <DialogFooter className="gc-modal-actions bg-transparent p-0 pt-4">
          <Button type="button" variant="outline" disabled={dismissDisabled} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          {onConfirm ? (
            <Button
              type="button"
              variant={danger ? "destructive" : "default"}
              disabled={confirmPending || confirmDisabled}
              onClick={() => void onConfirm()}
            >
              {confirmPending ? "Working..." : confirmLabel}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
