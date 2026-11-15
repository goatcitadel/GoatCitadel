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
              ? "fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-line bg-overlay"
              : "cockpit-sheet cockpit-safe-bottom fixed inset-x-0 bottom-0 z-50 flex flex-col overflow-hidden rounded-t-lg border border-line bg-overlay"
          }
        >
          {side ? null : <Drawer.Handle className="mx-auto mt-2 shrink-0" />}
          {/* The title and close button sit outside the scroller so a long sheet never scrolls them away. */}
          <div data-sheet-header="" className="flex shrink-0 items-center justify-between gap-4 px-4 pb-3 pt-4">
            <Drawer.Title className="font-display text-md font-semibold text-fg">{title}</Drawer.Title>
            <Drawer.Close asChild>
              <IconButton ref={sdkClose} label={closeLabel} icon={<X aria-hidden="true" className="size-4" />} />
            </Drawer.Close>
          </div>
          <div
            className={
              side
                ? "min-h-0 flex-1 overflow-y-auto px-4 pb-4"
                : "cockpit-sheet-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-4"
            }
          >
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
