import type { ComponentProps, ReactNode } from "react";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { IconButton } from "./IconButton";

export function Dialog({
  open, onOpenChange, title, description, children, onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  onCloseAutoFocus?: ComponentProps<typeof DialogPrimitive.Content>["onCloseAutoFocus"];
}) {
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-canvas/70" />
      <DialogPrimitive.Content onCloseAutoFocus={onCloseAutoFocus} className="cockpit-dialog fixed top-24 left-1/2 z-50 w-full max-w-xl -translate-x-1/2 rounded-lg border border-line bg-overlay p-4 shadow-overlay">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <DialogPrimitive.Title className="font-display text-md font-semibold text-fg">{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description className="mt-1 text-sm text-fg-secondary">{description}</DialogPrimitive.Description> : null}
          </div>
          <DialogPrimitive.Close asChild><IconButton label="Close dialog" icon={<X aria-hidden="true" className="size-4" />} /></DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
