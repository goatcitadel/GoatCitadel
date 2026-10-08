import { useRef, type ComponentProps, type ReactNode } from "react";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "../lib/cn";
import { IconButton } from "./IconButton";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  onCloseAutoFocus,
  contentClassName,
  closeLabel = "Close dialog",
  actions,
}: {
  contentClassName?: string;
  closeLabel?: string;
  actions?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  onCloseAutoFocus?: ComponentProps<typeof DialogPrimitive.Content>["onCloseAutoFocus"];
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-canvas/70" />
        <DialogPrimitive.Content
          onOpenAutoFocus={() => {
            returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={
            onCloseAutoFocus ??
            ((event) => {
              event.preventDefault();
              if (returnFocus.current?.isConnected) returnFocus.current.focus();
            })
          }
          className={cn(
            "cockpit-dialog fixed top-24 left-1/2 z-50 w-full max-w-xl -translate-x-1/2 rounded-lg border border-line bg-overlay p-4 shadow-overlay",
            contentClassName,
          )}
        >
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <DialogPrimitive.Title className="font-display text-md font-semibold text-fg">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-1 text-sm text-fg-secondary">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            {actions}
            <DialogPrimitive.Close asChild>
              <IconButton label={closeLabel} icon={<X aria-hidden="true" className="size-4" />} />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
