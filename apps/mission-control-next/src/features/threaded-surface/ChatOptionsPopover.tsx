import type { ReactNode } from "react";
import { useState } from "react";
import { Popover } from "radix-ui";

export function ChatOptionsPopover({ active, children }: { active: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const container = typeof document === "undefined" ? undefined : document.querySelector<HTMLElement>(".mc-app-shell") ?? undefined;
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><button type="button" className="mc-next-composer-options-trigger" aria-label="Chat options" aria-expanded={open}>Options{active ? " · active" : ""}</button></Popover.Trigger>
    <Popover.Portal container={container}><Popover.Content className="mc-next-composer-options-popover" side="top" align="start" sideOffset={10} collisionPadding={12} aria-label="Chat options">
      <div className="mc-next-composer-options-heading"><strong>Chat options</strong><Popover.Close asChild><button type="button" className="mc-next-panel-button" aria-label="Close Chat options">Close</button></Popover.Close></div>
      {children}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
