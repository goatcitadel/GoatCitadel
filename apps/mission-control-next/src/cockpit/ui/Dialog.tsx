import { useAccessBoundReview } from "@goatcitadel/mission-control-shared/hooks/use-access-bound-review";
import {
  createDeferredDialogRuntime,
  PendingDialog,
  useDeferredDialogRuntime,
  type DialogFocusHandler,
} from "@goatcitadel/mission-control-shared/components/ui/deferred-dialog";
import { useRef, type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface DialogProps {
  contentClassName?: string;
  portalContainer?: HTMLElement | null;
  closeLabel?: string;
  actions?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  onCloseAutoFocus?: DialogFocusHandler;
  onOpenAutoFocus?: DialogFocusHandler;
}

const runtimeLoader = createDeferredDialogRuntime(() => import("./DialogRuntime").then(({ DialogRuntime }) => DialogRuntime));

export function Dialog(props: DialogProps) {
  const accessCurrent = useAccessBoundReview(props.open, () => props.onOpenChange(false));
  const open = props.open && accessCurrent;
  const { runtime: Runtime, failed } = useDeferredDialogRuntime(open, runtimeLoader);
  const handoff = useRef(false);
  handoff.current = open && Boolean(Runtime);
  if (Runtime) return <Runtime {...props} open={open} />;
  if (!open) return null;
  return (
    <PendingDialog
      title={props.title}
      description={props.description}
      closeLabel={props.closeLabel ?? "Close dialog"}
      className={cn(
        "cockpit-dialog fixed inset-x-4 top-4 m-0 mx-auto w-[calc(100%-2rem)] max-w-xl rounded-lg border border-line bg-overlay p-4 text-fg shadow-overlay backdrop:bg-scrim sm:top-24",
        props.contentClassName,
      )}
      onDismiss={() => props.onOpenChange(false)}
      onCloseAutoFocus={props.onCloseAutoFocus}
      handoff={handoff}
      container={props.portalContainer}
    >
      {failed ? <p role="alert">Dialog controls could not load. Close the dialog to keep using the app, or reload the app.</p> : <p role="status">Loading dialog controls…</p>}
    </PendingDialog>
  );
}
