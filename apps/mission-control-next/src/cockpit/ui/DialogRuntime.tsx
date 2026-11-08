import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useRef } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn";
import { IconButton } from "./IconButton";
import type { DialogProps } from "./Dialog";

export function DialogRuntime({
  open,
  onOpenChange,
  title,
  description,
  children,
  onCloseAutoFocus,
  onOpenAutoFocus,
  contentClassName,
  portalContainer,
  closeLabel = "Close dialog",
  actions,
}: DialogProps) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal container={portalContainer}>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <DialogPrimitive.Content
          aria-modal="true"
          // Radix links a Description automatically; without one it needs an explicit undefined to stay silent.
          {...(description ? {} : { "aria-describedby": undefined })}
          onOpenAutoFocus={(event) => {
            returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            onOpenAutoFocus?.(event);
          }}
          onCloseAutoFocus={
            onCloseAutoFocus ??
            ((event) => {
              event.preventDefault();
              if (returnFocus.current?.isConnected) returnFocus.current.focus();
            })
          }
          className={cn(
            // SH-07: a 1rem gutter and a short top offset on phones; centred by auto margins between the insets.
            "cockpit-dialog fixed inset-x-4 top-4 z-50 mx-auto max-w-xl rounded-lg border border-line bg-overlay p-4 shadow-overlay sm:top-24",
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
