import type { ComponentProps, ReactNode, RefObject } from "react";
import { X } from "lucide-react";
import { Drawer } from "vaul";
import { IconButton } from "./IconButton";

export function SheetDrawerRuntime({
  open,
  onOpenChange,
  onOpenAutoFocus,
  onCloseAutoFocus,
  sdkClose,
  closeLabel,
  title,
  side,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenAutoFocus: ComponentProps<typeof Drawer.Content>["onOpenAutoFocus"];
  onCloseAutoFocus: ComponentProps<typeof Drawer.Content>["onCloseAutoFocus"];
  sdkClose: RefObject<HTMLButtonElement | null>;
  closeLabel: string;
  title: string;
  side: boolean;
  children: ReactNode;
}) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} direction={side ? "right" : "bottom"}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Drawer.Content
          // A sheet has a title and no description.
          aria-describedby={undefined}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          className={
            side
              ? "fixed inset-y-0 right-0 z-50 h-full w-full max-w-2xl overflow-hidden border-l border-line bg-overlay"
              : "cockpit-sheet cockpit-safe-bottom fixed inset-x-0 bottom-0 z-50 overflow-hidden rounded-t-lg border border-line bg-overlay"
          }
        >
          <div className={side ? "h-full overflow-y-auto p-4" : "cockpit-sheet-scroll overflow-y-auto p-4"}>
            <div className="mb-3 flex items-center justify-between gap-4">
              <Drawer.Title className="font-display text-md font-semibold text-fg">{title}</Drawer.Title>
              <Drawer.Close asChild>
                <IconButton ref={sdkClose} label={closeLabel} icon={<X aria-hidden="true" className="size-4" />} />
              </Drawer.Close>
            </div>
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
