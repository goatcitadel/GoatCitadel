import { Maximize2, Minimize2 } from "lucide-react";
import type { ReactNode } from "react";
import { Dialog } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { Sheet } from "../ui/Sheet";
import { InspectorResizeHandle } from "./InspectorResizeHandle";

export function InspectorExpandButton({ onExpand }: { onExpand: () => void }) {
  return (
    <IconButton
      label="Expand inspector"
      icon={<Maximize2 className="size-4" aria-hidden="true" />}
      onClick={onExpand}
    />
  );
}

export { InspectorResizeHandle };

export function InspectorModal({
  title,
  children,
  close,
  phone,
  restore,
  returnFocus,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  phone: boolean;
  restore?: () => void;
  returnFocus: (event: Event) => void;
}) {
  const onOpenChange = (open: boolean) => {
    if (!open) close();
  };
  if (phone) {
    return (
      <Sheet open onOpenChange={onOpenChange} title={title} closeLabel="Close inspector" onCloseAutoFocus={returnFocus}>
        {children}
      </Sheet>
    );
  }
  return (
    <Dialog
      open
      title={title}
      contentClassName="inset-y-4 flex max-w-5xl flex-col sm:top-4"
      closeLabel="Close inspector"
      actions={
        restore ? (
          <IconButton
            label="Restore docked inspector"
            icon={<Minimize2 className="size-4" aria-hidden="true" />}
            onClick={restore}
          />
        ) : undefined
      }
      onOpenChange={onOpenChange}
      onCloseAutoFocus={returnFocus}
    >
      {children}
    </Dialog>
  );
}
