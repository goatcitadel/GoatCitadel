import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Drawer } from "vaul";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { IconButton } from "./IconButton";

export function Sheet({ open, onOpenChange, title, children, sideOnDesktop = false }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  sideOnDesktop?: boolean;
}) {
  const isDesktop = useMediaQuery("(width >= 640px)");
  const side = sideOnDesktop && isDesktop;
  return <Drawer.Root open={open} onOpenChange={onOpenChange} direction={side ? "right" : "bottom"}>
    <Drawer.Portal>
      <Drawer.Overlay className="fixed inset-0 z-40 bg-canvas/70" />
      <Drawer.Content className={side
        ? "fixed inset-y-0 right-0 z-50 h-full w-full max-w-2xl overflow-hidden border-l border-line bg-overlay"
        : "cockpit-sheet fixed inset-x-0 bottom-0 z-50 overflow-hidden rounded-t-lg border border-line bg-overlay"}>
        <div className={side ? "h-full overflow-y-auto p-4" : "cockpit-sheet-scroll overflow-y-auto p-4"}>
          <div className="mb-3 flex items-center justify-between gap-4">
            <Drawer.Title className="font-display text-md font-semibold text-fg">{title}</Drawer.Title>
            <Drawer.Close asChild><IconButton label="Close sheet" icon={<X aria-hidden="true" className="size-4" />} /></Drawer.Close>
          </div>
          {children}
        </div>
      </Drawer.Content>
    </Drawer.Portal>
  </Drawer.Root>;
}
