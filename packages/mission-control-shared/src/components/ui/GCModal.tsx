import { useRef, type ReactNode } from "react";
import {
  createDeferredDialogRuntime,
  PendingDialog,
  useDeferredDialogRuntime,
  type DialogFocusHandler,
} from "./deferred-dialog";

export interface GCModalProps {
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
  onOpenAutoFocus?: DialogFocusHandler;
}

const runtimeLoader = createDeferredDialogRuntime(() =>
  import("./GCModalRuntime").then(({ GCModalRuntime }) => GCModalRuntime),
);

export function GCModal(props: GCModalProps) {
  const { runtime: Runtime, failed } = useDeferredDialogRuntime(props.open, runtimeLoader);
  const handoff = useRef(false);
  handoff.current = props.open && Boolean(Runtime);
  if (Runtime) return <Runtime {...props} />;
  if (!props.open) return null;
  return (
    <PendingDialog
      title={props.title}
      description={props.description}
      closeLabel={props.cancelLabel ?? "Cancel"}
      className="gc-modal-content mc-gc-modal-content fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-xl rounded-lg border border-border/60 bg-popover p-4 text-popover-foreground backdrop:bg-black/40"
      dismissDisabled={props.dismissDisabled}
      onDismiss={() => props.onOpenChange(false)}
      handoff={handoff}
    >
      {failed ? <p role="alert">Dialog controls could not load. Close the dialog to keep using the app, or reload the app.</p> : <p role="status">Loading dialog controls…</p>}
    </PendingDialog>
  );
}
